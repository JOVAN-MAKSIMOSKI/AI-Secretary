import { getChainRegistry, type ChainId } from './nodes/chainRegistry.js';
import { resolveChainWithLlm } from './nodes/llmResolver.js';
import { runWasteLawChain } from './wasteLawChain.js';
import { handleTaskQuery, handleCalendarQuery, handleFirmLookup } from './chainHandlers.js';
import { runGeneralChat, type GeneralChatMessage } from './generalChatChain.js';
import {
  addMinutesToLocalDateTime,
  buildLocalDateTime,
  calendarExtractionSchema,
} from './calendarTime.js';

import { createCalendarEvent } from '../mcp/calendar.js';

// PY_SERVICE_URL is the canonical var (zod-validated in lib/env.ts); the legacy
// PYTHON_SERVICE_URL name is kept as a fallback so older env files keep working.
const PYTHON_SERVICE_URL =
  process.env.PY_SERVICE_URL || process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';

type DirectResolverResult = {
  chainId: ChainId;
  confidence: number;
  reason: string;
  missingInfo: string[];
  handlerResult: Record<string, unknown>;
};


async function callPythonExtraction(
  endpointPath: string,
  accessToken: string,
  message: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${PYTHON_SERVICE_URL}${endpointPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ message }),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const detail = typeof payload.detail === 'string' ? payload.detail : 'Extraction request failed.';
    throw new Error(detail);
  }

  return payload;
}

export async function runDirectResolverChain(input: {
  tenantId: string;
  userAuthId: string;
  accessToken: string;
  message: string;
  // Only general_chat consumes history today; the extraction chains are
  // single-shot by design and ignore it.
  history?: GeneralChatMessage[];
}): Promise<DirectResolverResult> {
  const decision = await resolveChainWithLlm(input.message, getChainRegistry());

  let handlerResult: Record<string, unknown>;
  switch (decision.chainId) {
    case 'invoice_extraction':
      handlerResult = await callPythonExtraction('/documents/extract', input.accessToken, input.message);
      break;
    case 'offer_extraction':
      handlerResult = await callPythonExtraction('/documents/extract-offer', input.accessToken, input.message);
      break;
    case 'identification_form_extraction':
      handlerResult = await callPythonExtraction(
        '/documents/extract-identification-form',
        input.accessToken,
        input.message,
      );
      break;
    case 'transport_form_extraction':
      handlerResult = await callPythonExtraction(
        '/documents/extract-transport-form',
        input.accessToken,
        input.message,
      );
      break;
    case 'calendar_event_extraction':
      {
        const extractionPayload = await callPythonExtraction('/documents/extract-calendar', input.accessToken, input.message);
        const extracted = extractionPayload.extracted;
        const parsed = calendarExtractionSchema.safeParse(extracted);

        if (!parsed.success) {
          handlerResult = {
            success: false,
            message:
              'Failed to book meeting. Calendar extraction payload is invalid. Expected event_name, event_date (YYYY-MM-DD), event_time (HH:MM).',
          };
          break;
        }

        // duration_minutes is always present: the schema applies .default(15).
        const durationMinutes = parsed.data.duration_minutes;
        const startTimeLocal = buildLocalDateTime(parsed.data.event_date, parsed.data.event_time);
        let endTimeLocal: string;
        try {
          endTimeLocal = addMinutesToLocalDateTime(startTimeLocal, durationMinutes);
        } catch {
          handlerResult = {
            success: false,
            message: 'Failed to book meeting. Parsed event date/time is invalid.',
          };
          break;
        }

        try {
          const event = await createCalendarEvent(input.tenantId, input.userAuthId, {
            title: parsed.data.event_name,
            startTime: startTimeLocal,
            endTime: endTimeLocal,
            durationMinutes,
          });

          handlerResult = {
            success: true,
            message: 'Meeting booked successfully.',
            eventId: event.eventId,
          };
        } catch (error) {
          handlerResult = {
            success: false,
            message:
              error instanceof Error
                ? `Failed to book meeting. ${error.message}`
                : 'Failed to book meeting due to an unknown error.',
          };
        }
      }
      break;
    case 'waste_law_query':
      {
        // History is intentionally empty on this path — the dashboard chat is
        // stateless. The law questions page uses the dedicated
        // POST /agent/waste-law/chat route, which passes its own history.
        const wasteLawResult = await runWasteLawChain({
          tenantId: input.tenantId,
          userAuthId: input.userAuthId,
          accessToken: input.accessToken,
          message: input.message,
          history: [],
        });
        handlerResult = { success: true, answer: wasteLawResult.answer };
      }
      break;
    case 'task_query':
      handlerResult = { ...(await handleTaskQuery(input.tenantId, input.message)) };
      break;
    case 'calendar_query':
      handlerResult = { ...(await handleCalendarQuery(input.tenantId, input.userAuthId, input.message)) };
      break;
    case 'firm_lookup':
      handlerResult = { ...(await handleFirmLookup(input.tenantId, input.message)) };
      break;
    case 'general_chat':
      {
        const chat = await runGeneralChat({
          message: input.message,
          history: input.history,
          channel: 'web',
        });
        handlerResult = { success: true, answer: chat.answer, searched: chat.searched };
      }
      break;
    default:
      throw new Error(`No direct handler available for chain '${decision.chainId}'.`);
  }

  return {
    chainId: decision.chainId,
    confidence: decision.confidence,
    reason: decision.reason,
    missingInfo: decision.missingInfo,
    handlerResult,
  };
}
