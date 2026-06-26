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
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { resolveChainWithLlm } from '../agent/nodes/llmResolver.js';
import { getChainRegistry, type ChainId } from '../agent/nodes/chainRegistry.js';
import { createCalendarEvent } from '../mcp/calendar.js';
import { z } from 'zod';
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
const MAX_VOICE_TOKENS = 150;
// Twilio <Pause> minimum is 1s. Caller waits up to this long between the background job
// finishing and the result being played, so keep it tight.
const POLL_PAUSE_SECONDS = 1;
// Bound the two slowest network hops so one stalled dependency never hangs a whole turn.
const RECORDING_DOWNLOAD_TIMEOUT_MS = 10_000;
const STT_TIMEOUT_MS = 30_000;
// PostgreSQL int4 upper bound. The LLM can extract out-of-range integers (e.g. a long
// spoken number) for order_number/units; values above this overflow the DB column.
const PG_INT4_MAX = 2147483647;

const VOICE_GREETING = "Hello, I am your AI secretary. How can I help you?";
const VOICE_WAIT = "Please wait while I process your request.";
const VOICE_RETRY = "Sorry, I didn't catch that. Could you please repeat it?";
const VOICE_CANCEL = "Understood, the request has been cancelled. What else can I help you with?";
const VOICE_ERROR = "An error occurred. Please try again.";
const VOICE_SYSTEM_PROMPT =
  'You are a voice secretary assistant speaking English. Respond in 1-2 short sentences ' +
  'with no markdown, no lists, and no special characters. Your response will be spoken aloud ' +
  'over a phone call. Keep it concise and natural.';

const CHAIN_DESCRIPTIONS: Record<ChainId, string> = {
  invoice_extraction: 'prepare an invoice',
  offer_extraction: 'prepare an offer',
  calendar_event_extraction: 'schedule a meeting in the calendar',
};

const YES_PATTERNS = /^(да|yes|потврди|точно|јас|ok|okay)\b/i;
const NO_PATTERNS = /^(не|no|откажи|cancel|стоп|stop)\b/i;

const calendarExtractionSchema = z
  .object({
    event_name: z.string().min(1),
    event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    event_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    duration_minutes: z.number().int().min(1).max(480).optional().default(15),
  })
  .strict();

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
function buildConfirmationText(description: string): string {
  return `I understood that you want to ${description}. Say yes to confirm, or no to cancel.`;
}

// Executes the resolved chain after user confirmation.
// Returns a voice-friendly result message.
async function executeChain(
  chainId: ChainId,
  transcript: string,
  tenantId: string,
  _state: CallState,
): Promise<string> {
  const userAuthId = tenantId; // owner_auth_id === tenantId in this single-owner schema

  switch (chainId) {
    case 'invoice_extraction': {
      try {
        // Step 1: extract fields from transcript (resolves client_id, prices, etc.)
        const extractionResult = await callPythonExtraction('/documents/extract', transcript, tenantId);
        const extracted = (extractionResult.extracted ?? {}) as Record<string, unknown>;

        const clientId = extracted.client_id as string | undefined;
        const clientName = extracted.client_name as string | undefined;
        const clientTaxNumber = (extracted.client_tax_number as string | undefined) ?? '';

        if (!clientId || !clientName) {
          return "I couldn't identify the client. Please make sure the client name is clear.";
        }

        // Step 2: generate invoice_number from the business invoice_counter — the same
        // canonical source the web path and Python use. Using invoices.count()+1 here
        // collided with existing numbers (e.g. count 8 → "009" when 009 already existed),
        // which made Python UPDATE an old invoice instead of inserting a new one, so the
        // call invoice never reached the dashboard card.
        const counterRows = await prisma.$queryRaw<Array<{ invoice_counter: number | null }>>`
          SELECT invoice_counter FROM businesses WHERE owner_auth_id = ${tenantId}::uuid LIMIT 1
        `;
        const nextNum = Number(counterRows[0]?.invoice_counter ?? 0) + 1;
        const invoiceNumber = `${String(nextNum).padStart(3, '0')}/${new Date().getFullYear()}`;

        const today = new Date().toISOString().split('T')[0];
        const rawValueDate = (extracted.value_date as string | undefined)?.slice(0, 10) ?? '';
        const valueDate = /^\d{4}-\d{2}-\d{2}$/.test(rawValueDate) ? rawValueDate : today;
        const invoiceType = (extracted.invoice_type as string | undefined) === 'transport' ? 'transport' : 'goods';
        const orderNumber = safePositiveInt(extracted.order_number, nextNum);

        const invoicePayload = {
          client_id: clientId,
          invoice_number: invoiceNumber,
          invoice_type: invoiceType,
          invoice_date: today,
          value_date: valueDate,
          order_number: orderNumber,
          client_name: clientName,
          client_tax_number: clientTaxNumber,
          description: (extracted.description as string | undefined) ?? 'Services',
          units: safePositiveInt(extracted.units, 1),
          price_per_unit: extracted.price_per_unit ?? 0,
          price_before_tax: extracted.price_before_tax ?? 0,
          price_after_tax: extracted.price_after_tax ?? 0,
        };

        // Step 3: generate and store the invoice (response is an XLSX stream — status check only)
        const secret = process.env.INTER_SERVICE_SECRET;
        if (!secret) throw new Error('INTER_SERVICE_SECRET is not configured.');

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
          return "I couldn't generate the invoice. Please check that all details are correct.";
        }

        // Drain the XLSX response body so the connection is released cleanly
        await genResponse.arrayBuffer();

        return 'Invoice generated successfully.';
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          'Invoice generation from voice failed',
        );
        return "I couldn't generate the invoice. Please make sure the client name and details are clear.";
      }
    }

    case 'offer_extraction': {
      await callPythonExtraction('/documents/extract-offer', transcript, tenantId);
      return 'The offer has been prepared. You can view it in your panel.';
    }

    case 'calendar_event_extraction': {
      const extractionResult = await callPythonExtraction('/documents/extract-calendar', transcript, tenantId);
      const extracted = extractionResult.extracted;
      const parsed = calendarExtractionSchema.safeParse(extracted);

      if (!parsed.success) {
        return "I couldn't extract the meeting details. Please provide the date and time.";
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
        return `The meeting "${event_name}" is scheduled for ${event_date} at ${event_time}.`;
      } catch (err) {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Calendar event creation failed');
        return "I couldn't schedule the meeting. Please check that Google Calendar is connected.";
      }
    }

    default:
      return 'The action is unknown. Please try again.';
  }
}

// Generates a short conversational reply using Claude Haiku for non-command requests.
async function generateConversationalReply(state: CallState): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return "I'm sorry, I can't respond right now.";

  try {
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: MAX_VOICE_TOKENS,
      system: [{ type: 'text', text: VOICE_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: state.conversationHistory,
    });
    const block = response.content.find((b) => b.type === 'text');
    return block?.type === 'text' ? block.text : VOICE_ERROR;
  } catch (err) {
    logger.error({ err }, 'Conversational reply generation failed');
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
    const errorId = await generateAndCacheSpeech('Sorry, your number is not registered. Goodbye.').catch(() => null);
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
    // Temporary: English testing. Revert to 'mk' (or drop the field) for Macedonian.
    form.append('language', 'en');

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

      // 3. Check if there is a pending approval awaiting yes/no.
      if (state.pendingApproval) {
        if (YES_PATTERNS.test(transcript)) {
          const resultText = await executeChain(
            state.pendingApproval.chainId as ChainId,
            state.pendingApproval.originalTranscript,
            tenantId,
            state,
          );
          updateCallState(callSid, { pendingApproval: undefined });
          responseText = `Done. ${resultText} What else can I help you with?`;
        } else if (NO_PATTERNS.test(transcript)) {
          updateCallState(callSid, { pendingApproval: undefined });
          responseText = VOICE_CANCEL;
        } else {
          responseText = buildConfirmationText(state.pendingApproval.description);
        }
      } else {
        // 4. Resolve intent with LLM resolver.
        const resolveStart = Date.now();
        const decision = await resolveChainWithLlm(transcript, getChainRegistry());
        resolveMs = Date.now() - resolveStart;

        if (decision.confidence >= CONFIDENCE_THRESHOLD) {
          const description = CHAIN_DESCRIPTIONS[decision.chainId] ?? decision.chainId;
          updateCallState(callSid, {
            pendingApproval: {
              originalTranscript: transcript,
              chainId: decision.chainId,
              description,
            },
          });
          responseText = buildConfirmationText(description);
        } else {
          // Low confidence — handle as general conversation.
          responseText = await generateConversationalReply(state);
        }
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
