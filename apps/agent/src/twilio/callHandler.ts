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

const VOICE_GREETING = "Здраво, јас сум вашиот AI секретар. Со што можам да ви помогнам?";
const VOICE_WAIT = "Ве молам почекајте додека го обработувам вашето барање.";
const VOICE_RETRY = "Извинете, не ве разбрав. Можете ли да го повторите?";
const VOICE_CANCEL = "Разбрав, барањето е откажано. Со што уште можам да ви помогнам?";
const VOICE_ERROR = "Настана грешка. Ве молам обидете се повторно.";
const VOICE_SYSTEM_PROMPT =
  'You are a voice secretary assistant speaking Macedonian. Respond in 1-2 short sentences ' +
  'with no markdown, no lists, and no special characters. Your response will be spoken aloud ' +
  'over a phone call. Keep it concise and natural.';

const CHAIN_DESCRIPTIONS: Record<ChainId, string> = {
  invoice_extraction: 'подготви фактура',
  offer_extraction: 'подготви понуда',
  calendar_event_extraction: 'закажи состанок во календарот',
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

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function twiml(content: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${content}</Response>`;
}

function buildRecordVerb(): string {
  const keySid = process.env.TWILIO_RECORDING_KEY_SID;
  const encryptionAttr = keySid ? ` recordingEncryptionKeySid="${keySid}"` : '';
  return `<Record action="/calls/recording" method="POST" timeout="5" maxLength="30" playBeep="false" trim="trim-silence"${encryptionAttr}/>`;
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
  return `Разбрав дека сакате да ${description}. Кажете да за потврда, или не за откажување.`;
}

// Executes the resolved chain after user confirmation.
// Returns a voice-friendly Macedonian result message.
async function executeChain(
  chainId: ChainId,
  transcript: string,
  tenantId: string,
  _state: CallState,
): Promise<string> {
  const userAuthId = tenantId; // owner_auth_id === tenantId in this single-owner schema

  switch (chainId) {
    case 'invoice_extraction': {
      await callPythonExtraction('/documents/extract', transcript, tenantId);
      return 'Фактурата е подготвена. Можете да ја видите во вашиот панел.';
    }

    case 'offer_extraction': {
      await callPythonExtraction('/documents/extract-offer', transcript, tenantId);
      return 'Понудата е подготвена. Можете да ја видите во вашиот панел.';
    }

    case 'calendar_event_extraction': {
      const extractionResult = await callPythonExtraction('/documents/extract-calendar', transcript, tenantId);
      const extracted = extractionResult.extracted;
      const parsed = calendarExtractionSchema.safeParse(extracted);

      if (!parsed.success) {
        return 'Не можев да извлечам детали за состанокот. Ве молам наведете го датумот и времето.';
      }

      const { event_name, event_date, event_time, duration_minutes } = parsed.data;
      const startTime = `${event_date}T${event_time}:00`;
      const endMs = new Date(startTime).getTime() + duration_minutes * 60_000;
      const endTime = new Date(endMs).toISOString().replace(/\.\d{3}Z$/, '');

      try {
        await createCalendarEvent(tenantId, userAuthId, {
          title: event_name,
          startTime,
          endTime,
          durationMinutes: duration_minutes,
        });
        return `Состанокот "${event_name}" е закажан за ${event_date} во ${event_time}.`;
      } catch (err) {
        logger.error({ err }, 'Calendar event creation failed');
        return 'Не можев да го закажам состанокот. Проверете дали Google Calendar е поврзан.';
      }
    }

    default:
      return 'Акцијата е непозната. Ве молам обидете се повторно.';
  }
}

// Generates a short conversational reply using Claude Haiku for non-command requests.
async function generateConversationalReply(state: CallState): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return 'Се извинувам, не можам да одговорам во моментов.';

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
    res.type('text/xml').send(twiml(`<Say language="mk-MK">Извинете, не можеме да ве идентификуваме. Довидување.</Say>`));
    return;
  }

  const tenantId = await lookupTenantByPhone(callerPhone).catch(() => null);
  if (!tenantId) {
    logger.warn({ callSid, callerPhone }, 'Twilio call from unregistered number');
    const errorId = await generateAndCacheSpeech('Извинете, вашиот број не е регистриран. Довидување.').catch(() => null);
    const play = errorId ? buildPlayVerb(errorId) : `<Say language="mk-MK">Извинете, вашиот број не е регистриран. Довидување.</Say>`;
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
      .send(twiml(`<Say language="mk-MK">${xmlEscape(VOICE_GREETING)}</Say>` + buildRecordVerb()));
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
          `<Say language="mk-MK">${xmlEscape(VOICE_WAIT)}</Say>` +
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

  try {
    // 1. Download Twilio recording (WAV) using BasicAuth.
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const audioResponse = await fetch(recordingUrl, {
      headers: accountSid && authToken
        ? { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` }
        : {},
    });

    if (!audioResponse.ok) {
      throw new Error(`Failed to download recording: ${audioResponse.status}`);
    }

    const rawBuffer = Buffer.from(await audioResponse.arrayBuffer());
    const audioBuffer = encryptionDetails
      ? decryptTwilioRecording(rawBuffer, encryptionDetails)
      : rawBuffer;

    // 2. Transcribe via Python STT.
    const secret = process.env.INTER_SERVICE_SECRET;
    if (!secret) throw new Error('INTER_SERVICE_SECRET is not configured.');

    const form = new FormData();
    form.append('audio', new Blob([new Uint8Array(audioBuffer)]), 'recording.wav');

    const sttResponse = await fetch(`${PY_SERVICE_URL}/stt/transcribe`, {
      method: 'POST',
      headers: { 'X-Service-Secret': secret },
      body: form,
    });

    if (!sttResponse.ok) {
      throw new Error(`STT transcription failed: ${sttResponse.status}`);
    }

    const sttResult = (await sttResponse.json()) as { text?: string };
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
          responseText = `Готово. ${resultText} Со што уште можам да ви помогнам?`;
        } else if (NO_PATTERNS.test(transcript)) {
          updateCallState(callSid, { pendingApproval: undefined });
          responseText = VOICE_CANCEL;
        } else {
          responseText = buildConfirmationText(state.pendingApproval.description);
        }
      } else {
        // 4. Resolve intent with LLM resolver.
        const decision = await resolveChainWithLlm(transcript, getChainRegistry());

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
    responseText = VOICE_ERROR;
  }

  // 5. Generate TTS and mark job done.
  try {
    const audioId = await generateAndCacheSpeech(responseText);
    processingJobs.set(jobId, { done: true, audioId });
  } catch (err) {
    logger.error({ err }, 'TTS response generation failed');
    processingJobs.set(jobId, { done: true, error: responseText });
  }
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
    res.type('text/xml').send(twiml(`<Pause length="2"/><Redirect method="GET">${selfUrl}</Redirect>`));
    return;
  }

  processingJobs.delete(jobId);

  if (job.error && !job.audioId) {
    res
      .type('text/xml')
      .send(twiml(`<Say language="mk-MK">${xmlEscape(job.error)}</Say>` + buildRecordVerb()));
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
  res.setHeader('Content-Type', 'audio/mpeg');
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
