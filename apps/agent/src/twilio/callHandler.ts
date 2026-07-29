// Twilio voice webhook orchestrator.
// Flow: call arrives on the shared number → caller's From number is looked up in
//       twilio_phone_registrations → tenant resolved → greeting + <Record> → recording
//       arrives → "please wait" + background job → Twilio polls /processing/:jobId
//       → job done → play result + new <Record> → loop
//
// All subsequent webhooks (recording, processing, status) resolve tenantId from the
// in-memory callStateMap using CallSid — no tenantId appears in any URL.
// The caller is the only one who can end the call; <Hangup> is never used.

import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { resolveChainWithLlm } from '../agent/nodes/llmResolver.js';
import { getChainRegistry, type ChainId } from '../agent/nodes/chainRegistry.js';
import { createCalendarEvent } from '../mcp/calendar.js';
import { GmailReconnectRequiredError } from '../lib/gmailOAuth.js';
import { calendarExtractionSchema } from '../agent/calendarTime.js';
import { handleTaskQuery, handleCalendarQuery, handleFirmLookup } from '../agent/chainHandlers.js';
import { speakTaskQuery, speakCalendarQuery, speakFirmLookup } from './voicePhrasing.js';
import { runWasteLawChain } from '../agent/wasteLawChain.js';
import { runGeneralChat } from '../agent/generalChatChain.js';
import {
  getOrCreateCallState,
  getCallState,
  updateCallState,
  deleteCallState,
  processingJobs,
  audioCache,
  newId,
  type CallState,
} from './callState.js';
import { generateSpeech } from './tts.js';
import { decryptTwilioRecording, type TwilioEncryptionDetails } from './encryption.js';

// --- Constants ---

const PY_SERVICE_URL = process.env.PY_SERVICE_URL || 'http://127.0.0.1:8000';
const CONFIDENCE_THRESHOLD = 0.7;
// Twilio <Pause> minimum is 1s. Caller waits up to this long between the background job
// finishing and the result being played, so keep it tight.
const POLL_PAUSE_SECONDS = 1;
// Bound the two slowest network hops so one stalled dependency never hangs a whole turn.
const RECORDING_DOWNLOAD_TIMEOUT_MS = 10_000;
const STT_TIMEOUT_MS = 30_000;
// PostgreSQL int4 upper bound. The LLM can extract out-of-range integers (e.g. a long
// spoken number) for order_number/units; values above this overflow the DB column.
const PG_INT4_MAX = 2147483647;

const VOICE_GREETING = "Здраво, јас сум вашата виртуелна секретарка. Како можам да ви помогнам?";
const VOICE_WAIT = "Ве молам почекајте, го обработувам вашето барање.";
const VOICE_RETRY = "Извинете, не ве разбрав. Можете ли да повторите?";
// const VOICE_CANCEL = "Во ред, барањето е откажано. Со што друго можам да ви помогнам?";
const VOICE_ERROR = "Настана грешка. Ве молам обидете се повторно.";
// Fixed confirmation for a successful booking, with its own follow-up prompt baked in.
// Returned verbatim — the generic follow-up is not appended (see processRecording).
const VOICE_BOOKING_SUCCESS = "Успешно извршена наредба. Како можам понатаму да ви помогнам?";
// The spoken-Macedonian system prompt that used to live here now sits in
// agent/generalChatChain.ts, so the phone and dashboard share one definition.

// const CHAIN_DESCRIPTIONS: Record<ChainId, string> = {
//   invoice_extraction: 'prepare an invoice',
//   offer_extraction: 'prepare an offer',
//   calendar_event_extraction: 'schedule a meeting in the calendar',
// };

// const YES_PATTERNS = /^(да|yes|потврди|точно|јас|ok|okay)\b/i;
// const NO_PATTERNS = /^(не|no|откажи|cancel|стоп|stop)\b/i;

// --- Helpers ---

// Coerces an LLM-extracted value to a positive integer within the PG int4 range,
// falling back when it is missing, non-integer, or out of range.
function safePositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= PG_INT4_MAX
    ? value
    : fallback;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function twiml(content: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${content}</Response>`;
}

function buildRecordVerb(): string {
  const keySid = process.env.TWILIO_RECORDING_KEY_SID;
  const encryptionAttr = keySid ? ` recordingEncryptionKeySid="${keySid}"` : '';
  return `<Record action="/calls/recording" method="POST" timeout="2" maxLength="30" playBeep="false" trim="trim-silence"${encryptionAttr}/>`;
}

function buildPlayVerb(audioId: string): string {
  const publicUrl = process.env.AGENT_PUBLIC_URL || '';
  return `<Play>${xmlEscape(`${publicUrl}/calls/audio/${audioId}`)}</Play>`;
}

async function generateAndCacheSpeech(text: string): Promise<string> {
  const audioId = newId();
  const buffer = await generateSpeech(text);
  audioCache.set(audioId, buffer);
  return audioId;
}

// Returns the owner_auth_id (tenant_id) for the business whose phone matches the caller.
async function lookupTenantByPhone(phoneNumber: string): Promise<string | null> {
  const business = await prisma.businesses.findFirst({
    where: { phone: phoneNumber },
    select: { owner_auth_id: true },
  });
  return business?.owner_auth_id ?? null;
}

// Resolves tenant for WebRTC (browser) callers. Identity 'dev' uses TWILIO_DEV_TENANT_ID
// or falls back to the first business in the DB. Any other identity is treated as an
// owner_auth_id directly (production path).
async function resolveWebRtcTenant(identity: string): Promise<string | null> {
  if (identity === 'dev') {
    const devTenantId = process.env.TWILIO_DEV_TENANT_ID;
    if (devTenantId) return devTenantId;
    const business = await prisma.businesses.findFirst({ select: { owner_auth_id: true } });
    return business?.owner_auth_id ?? null;
  }
  const business = await prisma.businesses.findFirst({
    where: { owner_auth_id: identity },
    select: { owner_auth_id: true },
  });
  return business?.owner_auth_id ?? null;
}

// Calls Python extraction endpoints using INTER_SERVICE_SECRET (service-to-service auth).
// The tenantId is passed via X-Tenant-Id so Python can use it as owner_auth_id.
async function callPythonExtraction(
  endpointPath: string,
  message: string,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const secret = process.env.INTER_SERVICE_SECRET;
  if (!secret) throw new Error('INTER_SERVICE_SECRET is not configured.');

  const response = await fetch(`${PY_SERVICE_URL}${endpointPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Secret': secret,
      'X-Tenant-Id': tenantId,
    },
    body: JSON.stringify({ message }),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = typeof payload.detail === 'string' ? payload.detail : 'Extraction failed.';
    throw new Error(detail);
  }
  return payload;
}

// Builds a confirmation prompt from the pending chain description.
// function buildConfirmationText(description: string): string {
//   return `I understood that you want to ${description}. Say yes to confirm, or no to cancel.`;
// }

// Executes the resolved chain after user confirmation.
// Returns a voice-friendly result message.
async function executeChain(
  chainId: ChainId,
  transcript: string,
  tenantId: string,
  state: CallState,
): Promise<string> {
  const userAuthId = tenantId; // owner_auth_id === tenantId in this single-owner schema

  switch (chainId) {
    case 'invoice_extraction': {
      try {
        // Step 1: use the eagerly-started extraction from turn 1 if available,
        // otherwise fall back to extracting now (e.g. if called without prior approval state).
        const extractionStart = Date.now();
        const extracted: Record<string, unknown> = state.pendingApproval?.extractionPromise
          ? await state.pendingApproval.extractionPromise
          : ((await callPythonExtraction('/documents/extract', transcript, tenantId)).extracted ?? {}) as Record<string, unknown>;
        const extractionMs = Date.now() - extractionStart;

        const firmId = extracted.firm_id as string | undefined;
        const firmName = extracted.firm_name as string | undefined;
        const firmTaxNumber = (extracted.firm_tax_number as string | undefined) ?? '';

        if (!firmId || !firmName) {
          return "Не можев да го идентификувам клиентот. Ве молам осигурете се дека името на клиентот е јасно.";
        }

        // Step 2: generate invoice_number from the business invoice_counter — the same
        // canonical source the web path and Python use. Using invoices.count()+1 here
        // collided with existing numbers (e.g. count 8 → "009" when 009 already existed),
        // which made Python UPDATE an old invoice instead of inserting a new one, so the
        // call invoice never reached the dashboard card.
        const counterStart = Date.now();
        const counterRows = await prisma.$queryRaw<Array<{ invoice_counter: number | null }>>`
          SELECT invoice_counter FROM businesses WHERE owner_auth_id = ${tenantId}::uuid LIMIT 1
        `;
        const counterMs = Date.now() - counterStart;
        const nextNum = Number(counterRows[0]?.invoice_counter ?? 0) + 1;
        const invoiceNumber = `${String(nextNum).padStart(3, '0')}/${new Date().getFullYear()}`;

        const today = new Date().toISOString().split('T')[0];
        const rawValueDate = (extracted.value_date as string | undefined)?.slice(0, 10) ?? '';
        const valueDate = /^\d{4}-\d{2}-\d{2}$/.test(rawValueDate) ? rawValueDate : today;
        const invoiceType = (extracted.invoice_type as string | undefined) === 'transport' ? 'transport' : 'goods';
        const orderNumber = safePositiveInt(extracted.order_number, nextNum);

        const invoicePayload = {
          firm_id: firmId,
          invoice_number: invoiceNumber,
          invoice_type: invoiceType,
          invoice_date: today,
          value_date: valueDate,
          order_number: orderNumber,
          firm_name: firmName,
          firm_tax_number: firmTaxNumber,
          description: (extracted.description as string | undefined) ?? 'Services',
          units: safePositiveInt(extracted.units, 1),
          price_per_unit: extracted.price_per_unit ?? 0,
          price_before_tax: extracted.price_before_tax ?? 0,
          price_after_tax: extracted.price_after_tax ?? 0,
        };

        // Step 3: generate and store the invoice (response is an XLSX stream — status check only)
        const secret = process.env.INTER_SERVICE_SECRET;
        if (!secret) throw new Error('INTER_SERVICE_SECRET is not configured.');

        const invoiceGenStart = Date.now();
        const genResponse = await fetch(`${PY_SERVICE_URL}/documents/invoice`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Secret': secret,
            'X-Tenant-Id': tenantId,
            'X-Invoice-Origin': 'call',
          },
          body: JSON.stringify(invoicePayload),
        });

        if (!genResponse.ok) {
          const errText = await genResponse.text().catch(() => '');
          logger.error({ status: genResponse.status, body: errText }, 'Invoice generation endpoint failed');
          return "Не можев да ја генерирам фактурата. Ве молам проверете дали сите детали се точни.";
        }

        // Drain the XLSX response body so the connection is released cleanly
        await genResponse.arrayBuffer();
        const invoiceGenMs = Date.now() - invoiceGenStart;

        logger.info(
          { extractionMs, counterMs, invoiceGenMs },
          'executeChain invoice timing',
        );

        return 'Фактурата е успешно генерирана.';
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Invoice generation from voice failed',
        );
        return "Не можев да ја генерирам фактурата. Ве молам осигурете се дека името на клиентот и деталите се јасни.";
      }
    }

    case 'offer_extraction': {
      await callPythonExtraction('/documents/extract-offer', transcript, tenantId);
      return 'Понудата е подготвена. Можете да ја видите во вашиот панел.';
    }

    case 'identification_form_extraction': {
      try {
        // Step 1: extract + resolve. The Python endpoint returns the waste fields plus
        // derived ewc_code/is_hazardous and the resolved firm_id/contact_id (contact
        // scoped to the firm), the same way invoice extraction resolves firm_id.
        const extracted = ((await callPythonExtraction(
          '/documents/extract-identification-form',
          transcript,
          tenantId,
        )).extracted ?? {}) as Record<string, unknown>;

        const asString = (value: unknown): string | undefined =>
          typeof value === 'string' && value.trim().length > 0 ? value : undefined;

        const firmId = asString(extracted.firm_id);
        const firmName = asString(extracted.firm_name);
        const contactId = asString(extracted.contact_id);
        if (!firmId || !firmName) {
          return 'Не можев да ја идентификувам фирмата. Ве молам осигурете се дека името на фирмата е јасно.';
        }
        if (!contactId) {
          return 'Не можев да го идентификувам одговорното лице за таа фирма. Ве молам осигурете се дека името е јасно.';
        }

        // Step 2: build the render payload. is_hazardous is a real boolean here; the
        // remaining fields are the snapped closed-list values from extraction.
        const identificationPayload = {
          firm_id: firmId,
          contact_id: contactId,
          firm_name: firmName,
          waste_location: asString(extracted.waste_location),
          is_hazardous: typeof extracted.is_hazardous === 'boolean' ? extracted.is_hazardous : undefined,
          waste_type: asString(extracted.waste_type),
          ewc_code: asString(extracted.ewc_code),
          packing_method: asString(extracted.packing_method),
          total_weight_kg: extracted.total_weight_kg,
          waste_origin: asString(extracted.waste_origin),
          waste_operation_code: asString(extracted.waste_operation_code),
          place: asString(extracted.place),
          date: asString(extracted.date),
        };

        // Any missing required field means extraction did not capture enough; the
        // render route's Pydantic gate would 422, so fail early with a spoken hint.
        const missing = Object.entries(identificationPayload)
          .filter(([, v]) => v === undefined || v === null || v === '')
          .map(([k]) => k);
        if (missing.length > 0) {
          return 'Не можев да ги извлечам сите потребни детали за формуларот. Ве молам наведете го описот на отпадот, количината и локацијата.';
        }

        // Step 3: generate + store with origin='call'. Like the invoice voice path, the
        // streamed docx is discarded here — the form is retrieved later from the
        // dashboard's pending-call card (origin='call', downloaded_at IS NULL).
        const secret = process.env.INTER_SERVICE_SECRET;
        if (!secret) throw new Error('INTER_SERVICE_SECRET is not configured.');

        const genResponse = await fetch(`${PY_SERVICE_URL}/documents/identification-form`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Secret': secret,
            'X-Tenant-Id': tenantId,
            'X-Document-Origin': 'call',
          },
          body: JSON.stringify(identificationPayload),
        });

        if (!genResponse.ok) {
          const errText = await genResponse.text().catch(() => '');
          logger.error(
            { status: genResponse.status, body: errText },
            'Identification-form generation endpoint failed',
          );
          return 'Не можев да го генерирам формуларот. Ве молам проверете дали сите детали се точни.';
        }

        // Drain the docx body so the connection is released cleanly.
        await genResponse.arrayBuffer();

        return 'Идентификациониот формулар е успешно генериран. Можете да го преземете од вашиот панел.';
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Identification-form generation from voice failed',
        );
        return 'Не можев да го генерирам формуларот. Ве молам осигурете се дека деталите се јасни.';
      }
    }

    case 'transport_form_extraction': {
      try {
        // Step 1: extract + resolve, same shape as the identification form above. Python
        // returns the waste fields plus derived ewc_code/is_hazardous and both resolved
        // party ids — here the two lookups are independent, since a disposal place is
        // tenant-wide and has no owning-firm relationship.
        const extracted = ((await callPythonExtraction(
          '/documents/extract-transport-form',
          transcript,
          tenantId,
        )).extracted ?? {}) as Record<string, unknown>;

        const asString = (value: unknown): string | undefined =>
          typeof value === 'string' && value.trim().length > 0 ? value : undefined;

        const firmId = asString(extracted.firm_id);
        const firmName = asString(extracted.firm_name);
        const disposalPlaceId = asString(extracted.disposal_place_id);
        const disposalPlaceName = asString(extracted.disposal_place_name);
        if (!firmId || !firmName) {
          return 'Не можев да ја идентификувам фирмата која го предава отпадот. Ве молам осигурете се дека името на фирмата е јасно.';
        }
        if (!disposalPlaceId || !disposalPlaceName) {
          return 'Не можев да ја идентификувам депонијата која го прима отпадот. Ве молам кажете го името на депонијата.';
        }

        // Step 2: build the render payload. note is optional, so it is added after the
        // required-field check rather than being counted as missing when absent.
        const transportPayload = {
          firm_id: firmId,
          disposal_place_id: disposalPlaceId,
          firm_name: firmName,
          disposal_place_name: disposalPlaceName,
          waste_type: asString(extracted.waste_type),
          // Both derived in Python from waste_type. They come back absent when the waste
          // matched no code map, which must fail here rather than ship a fabricated EWC
          // code on a legal document.
          is_hazardous: typeof extracted.is_hazardous === 'boolean' ? extracted.is_hazardous : undefined,
          ewc_code: asString(extracted.ewc_code),
          waste_owner_total_kg: extracted.waste_owner_total_kg,
          collector_total_kg: extracted.collector_total_kg,
          collector_date: asString(extracted.collector_date),
          end_owner_total_kg: extracted.end_owner_total_kg,
          end_owner_date: asString(extracted.end_owner_date),
        };

        const missing = Object.entries(transportPayload)
          .filter(([, v]) => v === undefined || v === null || v === '')
          .map(([k]) => k);
        if (missing.length > 0) {
          return 'Не можев да ги извлечам сите потребни детали за транспортниот формулар. Ве молам наведете го видот на отпадот, количините и датумите на предавање и прием.';
        }

        // Step 3: generate + store with origin='call'. Like the identification-form voice
        // path, the streamed docx is discarded here — the form is retrieved later from the
        // dashboard's pending-call card (origin='call', downloaded_at IS NULL).
        const secret = process.env.INTER_SERVICE_SECRET;
        if (!secret) throw new Error('INTER_SERVICE_SECRET is not configured.');

        const note = asString(extracted.note);
        const genResponse = await fetch(`${PY_SERVICE_URL}/documents/transport-form`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Service-Secret': secret,
            'X-Tenant-Id': tenantId,
            'X-Document-Origin': 'call',
          },
          body: JSON.stringify(note ? { ...transportPayload, note } : transportPayload),
        });

        if (!genResponse.ok) {
          const errText = await genResponse.text().catch(() => '');
          logger.error(
            { status: genResponse.status, body: errText },
            'Transport-form generation endpoint failed',
          );
          return 'Не можев да го генерирам транспортниот формулар. Ве молам проверете дали сите детали се точни.';
        }

        // Drain the docx body so the connection is released cleanly.
        await genResponse.arrayBuffer();

        return 'Транспортниот формулар е успешно генериран. Можете да го преземете од вашиот панел.';
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Transport-form generation from voice failed',
        );
        return 'Не можев да го генерирам транспортниот формулар. Ве молам осигурете се дека деталите се јасни.';
      }
    }

    // Read-only query chains — data fetch is shared with the web path via chainHandlers;
    // only the spoken Macedonian phrasing is voice-specific (voicePhrasing).
    case 'task_query': {
      const result = await handleTaskQuery(tenantId, transcript);
      return speakTaskQuery(result);
    }

    case 'calendar_query': {
      const result = await handleCalendarQuery(tenantId, userAuthId, transcript);
      return speakCalendarQuery(result);
    }

    case 'firm_lookup': {
      const result = await handleFirmLookup(tenantId, transcript);
      return speakFirmLookup(result);
    }

    // Waste-law advisor over the phone. No user JWT on this path, so the chain
    // authenticates service-to-service; concise:true asks Python for a short
    // spoken answer instead of the full numbered-list legal format.
    case 'waste_law_query': {
      try {
        const { answer } = await runWasteLawChain({
          tenantId,
          userAuthId,
          message: transcript,
          history: [],
          concise: true,
        });
        return answer;
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Waste-law voice query failed',
        );
        return 'Не можев да го најдам одговорот во законот во моментов. Ве молам обидете се повторно.';
      }
    }

    // Catch-all conversation, including questions that need a web lookup. Same
    // shared chain the low-confidence fallback uses, so a caller gets an
    // identical answer whether the router was confident or not.
    case 'general_chat':
      return generateConversationalReply(state, transcript);

    case 'calendar_event_extraction': {
      const extractionResult = await callPythonExtraction('/documents/extract-calendar', transcript, tenantId);
      const extracted = extractionResult.extracted;
      const parsed = calendarExtractionSchema.safeParse(extracted);

      if (!parsed.success) {
        return "Не можев да ги извлечам деталите за состанокот. Ве молам наведете датум и време.";
      }

      const { event_name, event_date, event_time, duration_minutes } = parsed.data;
      const startTime = `${event_date}T${event_time}:00`;

      try {
        // Pass only startTime + duration; createCalendarEvent derives endTime in the
        // same timezone basis. Pre-computing endTime here caused an off-by-offset bug
        // where end landed before start and Google rejected the insert.
        await createCalendarEvent(tenantId, userAuthId, {
          title: event_name,
          startTime,
          durationMinutes: duration_minutes,
        });
        return VOICE_BOOKING_SUCCESS;
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Calendar event creation failed');
        // Only claim a connection/authorization problem when that is genuinely the cause
        // (missing connection or a revoked/expired token). Every other failure gets a
        // neutral retry message instead of falsely blaming the Google Calendar connection.
        if (err instanceof GmailReconnectRequiredError) {
          return "Не можев да го закажам состанокот бидејќи пристапот до Google Calendar е истечен или не е поврзан. Ве молам повторно поврзете го Google Calendar.";
        }
        return "Не можев да го закажам состанокот. Ве молам обидете се повторно.";
      }
    }

    default:
      return 'Дејството е непознато. Ве молам обидете се повторно.';
  }
}

// Short spoken reply for anything that is not a command. Delegates to the shared
// general-chat chain so the phone and the dashboard answer with the same model,
// prompt, and web-search behaviour — this used to be a voice-only Anthropic call
// that had no web counterpart and was already drifting.
// Reached two ways: routed here as `general_chat`, or as the low-confidence
// fallback in processRecording.
async function generateConversationalReply(state: CallState, transcript: string): Promise<string> {
  try {
    // processRecording appends this turn's user message to conversationHistory
    // before routing, so the last entry is `transcript` itself. runGeneralChat
    // appends `message` on its own — passing the untrimmed array would show the
    // model the same question twice.
    const priorHistory = state.conversationHistory.slice(0, -1);
    const { answer } = await runGeneralChat({
      message: transcript,
      history: priorHistory,
      channel: 'voice',
    });
    return answer;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Conversational reply generation failed',
    );
    return VOICE_ERROR;
  }
}

// --- Route Handlers ---

export async function handleVoiceEntry(req: Request, res: Response): Promise<void> {
  const callerPhone = typeof req.body?.From === 'string' ? req.body.From.trim() : '';
  const callSid = typeof req.body?.CallSid === 'string' ? req.body.CallSid : newId();

  if (!callerPhone) {
    logger.warn({ callSid }, 'Twilio call arrived with no From number');
    res.type('text/xml').send(twiml(`<Say language="en-US">Sorry, we could not identify you. Goodbye.</Say>`));
    return;
  }

  const isWebRtc = callerPhone.startsWith('client:');
  const tenantId = isWebRtc
    ? await resolveWebRtcTenant(callerPhone.slice('client:'.length)).catch(() => null)
    : await lookupTenantByPhone(callerPhone).catch(() => null);

  if (!tenantId) {
    logger.warn({ callSid, callerPhone }, isWebRtc ? 'WebRTC call with unknown identity' : 'Twilio call from unregistered number');
    const errorId = await generateAndCacheSpeech('Жал ми е, вашиот број не е регистриран. Довидување.').catch(() => null);
    const play = errorId ? buildPlayVerb(errorId) : `<Say language="en-US">Sorry, your number is not registered. Goodbye.</Say>`;
    res.type('text/xml').send(twiml(play));
    return;
  }

  getOrCreateCallState(callSid, tenantId);

  try {
    const greetId = await generateAndCacheSpeech(VOICE_GREETING);
    res.type('text/xml').send(twiml(buildPlayVerb(greetId) + buildRecordVerb()));
  } catch (err) {
    logger.error({ err }, 'TTS greeting generation failed');
    res
      .type('text/xml')
      .send(twiml(`<Say language="en-US">${xmlEscape(VOICE_GREETING)}</Say>` + buildRecordVerb()));
  }
}

export async function handleRecording(req: Request, res: Response): Promise<void> {
  const callSid = typeof req.body?.CallSid === 'string' ? req.body.CallSid : '';
  const recordingUrl = typeof req.body?.RecordingUrl === 'string' ? req.body.RecordingUrl : '';

  const state = callSid ? getCallState(callSid) : undefined;
  if (!callSid || !recordingUrl || !state) {
    res.type('text/xml').send(twiml(buildRecordVerb()));
    return;
  }

  const { tenantId } = state;

  // Present when Twilio recording encryption is enabled on the account.
  let encryptionDetails: TwilioEncryptionDetails | null = null;
  if (typeof req.body?.EncryptionDetails === 'string') {
    try {
      encryptionDetails = JSON.parse(req.body.EncryptionDetails) as TwilioEncryptionDetails;
    } catch {
      logger.warn({ tenantId, callSid }, 'EncryptionDetails present but could not be parsed — proceeding unencrypted');
    }
  }

  const jobId = newId();
  processingJobs.set(jobId, { done: false });

  // Generate wait audio and respond immediately so Twilio doesn't time out.
  try {
    const waitId = await generateAndCacheSpeech(VOICE_WAIT);
    const publicUrl = process.env.AGENT_PUBLIC_URL || '';
    const pollUrl = xmlEscape(`${publicUrl}/calls/processing/${jobId}?CallSid=${encodeURIComponent(callSid)}`);
    res.type('text/xml').send(twiml(buildPlayVerb(waitId) + `<Redirect method="GET">${pollUrl}</Redirect>`));
  } catch {
    const publicUrl = process.env.AGENT_PUBLIC_URL || '';
    const pollUrl = xmlEscape(`${publicUrl}/calls/processing/${jobId}?CallSid=${encodeURIComponent(callSid)}`);
    res
      .type('text/xml')
      .send(
        twiml(
          `<Say language="en-US">${xmlEscape(VOICE_WAIT)}</Say>` +
            `<Redirect method="GET">${pollUrl}</Redirect>`,
        ),
      );
  }

  // Background processing — fire-and-forget.
  processRecording(tenantId, callSid, recordingUrl, jobId, encryptionDetails).catch((err: unknown) => {
    logger.error({ err }, 'Background recording processing failed');
    processingJobs.set(jobId, { done: true, error: String(err) });
  });
}

async function processRecording(
  tenantId: string,
  callSid: string,
  recordingUrl: string,
  jobId: string,
  encryptionDetails: TwilioEncryptionDetails | null,
): Promise<void> {
  const state = getOrCreateCallState(callSid, tenantId);
  let responseText: string;

  // Per-stage timings so the latency breakdown is measured, not guessed.
  const turnStart = Date.now();
  let downloadMs = 0;
  let sttMs = 0;
  let resolveMs = 0;
  let ttsMs = 0;

  try {
    // 1. Download Twilio recording (WAV) using BasicAuth.
    const downloadStart = Date.now();
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const audioResponse = await fetch(recordingUrl, {
      headers: accountSid && authToken
        ? { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` }
        : {},
      signal: AbortSignal.timeout(RECORDING_DOWNLOAD_TIMEOUT_MS),
    });

    if (!audioResponse.ok) {
      throw new Error(`Failed to download recording: ${audioResponse.status}`);
    }

    const rawBuffer = Buffer.from(await audioResponse.arrayBuffer());
    const audioBuffer = encryptionDetails
      ? decryptTwilioRecording(rawBuffer, encryptionDetails)
      : rawBuffer;
    downloadMs = Date.now() - downloadStart;

    // 2. Transcribe via Python STT.
    const secret = process.env.INTER_SERVICE_SECRET;
    if (!secret) throw new Error('INTER_SERVICE_SECRET is not configured.');

    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array(audioBuffer)]), 'recording.wav');
    // Macedonian STT — matches the Macedonian voice + prompts.
    form.append('language', 'mk');

    const sttStart = Date.now();
    const sttResponse = await fetch(`${PY_SERVICE_URL}/stt/transcribe`, {
      method: 'POST',
      headers: { 'X-Service-Secret': secret },
      body: form,
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    });

    if (!sttResponse.ok) {
      throw new Error(`STT transcription failed: ${sttResponse.status}`);
    }

    const sttResult = (await sttResponse.json()) as { text?: string };
    sttMs = Date.now() - sttStart;
    const transcript = (sttResult.text || '').trim();

    if (!transcript) {
      responseText = VOICE_RETRY;
    } else {
      // Append user turn to conversation history.
      state.conversationHistory.push({ role: 'user', content: transcript });

      // 3. Resolve intent with LLM resolver and execute directly (no confirmation step).
      const resolveStart = Date.now();
      const decision = await resolveChainWithLlm(transcript, getChainRegistry());
      resolveMs = Date.now() - resolveStart;

      if (decision.confidence >= CONFIDENCE_THRESHOLD) {
        const resultText = await executeChain(decision.chainId, transcript, tenantId, state);
        // A successful booking gets the terse confirmation alone; every other result —
        // including chain error messages — keeps the conversational follow-up prompt.
        responseText =
          resultText === VOICE_BOOKING_SUCCESS
            ? resultText
            : `${resultText} Со што друго можам да ви помогнам?`;
      } else {
        // Low confidence — handle as general conversation.
        responseText = await generateConversationalReply(state, transcript);
      }

      // Append assistant turn.
      state.conversationHistory.push({ role: 'assistant', content: responseText });
      updateCallState(callSid, { conversationHistory: state.conversationHistory });
    }
  } catch (err) {
    logger.error({ err }, 'processRecording error');
    // A stalled download/STT aborts via AbortSignal.timeout — ask the caller to repeat
    // rather than surfacing a hard error for what is usually a transient slowdown.
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    responseText = isTimeout ? VOICE_RETRY : VOICE_ERROR;
  }

  // 5. Generate TTS and mark job done.
  try {
    const ttsStart = Date.now();
    const audioId = await generateAndCacheSpeech(responseText);
    ttsMs = Date.now() - ttsStart;
    processingJobs.set(jobId, { done: true, audioId });
  } catch (err) {
    logger.error({ err }, 'TTS response generation failed');
    processingJobs.set(jobId, { done: true, error: responseText });
  }

  // One line per turn with the full latency breakdown so the slowest stage is visible.
  logger.info(
    { callSid, downloadMs, sttMs, resolveMs, ttsMs, totalMs: Date.now() - turnStart },
    'voice turn timing',
  );
}

export function handleProcessingPoll(jobId: string, req: Request, res: Response): void {
  const job = processingJobs.get(jobId);

  if (!job) {
    res.type('text/xml').send(twiml(buildRecordVerb()));
    return;
  }

  if (!job.done) {
    const publicUrl = process.env.AGENT_PUBLIC_URL || '';
    const callSid = typeof req.query.CallSid === 'string' ? req.query.CallSid : '';
    const selfUrl = xmlEscape(
      `${publicUrl}/calls/processing/${jobId}?CallSid=${encodeURIComponent(callSid)}`,
    );
    res.type('text/xml').send(twiml(`<Pause length="${POLL_PAUSE_SECONDS}"/><Redirect method="GET">${selfUrl}</Redirect>`));
    return;
  }

  processingJobs.delete(jobId);

  if (job.error && !job.audioId) {
    res
      .type('text/xml')
      .send(twiml(`<Say language="en-US">${xmlEscape(job.error)}</Say>` + buildRecordVerb()));
    return;
  }

  if (job.audioId) {
    res.type('text/xml').send(twiml(buildPlayVerb(job.audioId) + buildRecordVerb()));
    return;
  }

  res.type('text/xml').send(twiml(buildRecordVerb()));
}

export function serveAudio(audioId: string, res: Response): void {
  const buffer = audioCache.get(audioId);
  if (!buffer) {
    res.status(404).send('Audio not found.');
    return;
  }
  audioCache.delete(audioId);
  // ElevenLabs returns raw 8kHz mu-law (ulaw_8000); Twilio <Play> expects audio/ulaw for it.
  res.setHeader('Content-Type', 'audio/ulaw');
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
}

export function handleCallStatus(req: Request, _res: Response): void {
  const callSid = typeof req.body?.CallSid === 'string' ? req.body.CallSid : '';
  const callStatus = typeof req.body?.CallStatus === 'string' ? req.body.CallStatus : '';
  if (callSid && callStatus === 'completed') {
    const tenantId = getCallState(callSid)?.tenantId;
    deleteCallState(callSid);
    logger.info({ tenantId, callSid }, 'Call ended — state cleaned up');
  }
}
