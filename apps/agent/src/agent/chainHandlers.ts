// Channel-agnostic read handlers for the query chains. Each function is tenant-scoped and
// side-effect-free, so both the web path (directResolverChain) and the voice path
// (callHandler.executeChain) call the same code instead of duplicating data access — the
// duplication that let waste_law_query drift between channels. Presentation (JSON for web,
// spoken Macedonian for voice) stays in each channel; only the data fetch lives here.

import { prisma } from '../lib/prisma.js';
import { listCalendarEvents, type CalendarEventRecord } from '../mcp/calendar.js';
import { GmailReconnectRequiredError } from '../lib/gmailOAuth.js';
import { parseRelativeDateRange } from './dateRangeParser.js';

// Cap on how many rows a single spoken/JSON answer will carry — a voice reply cannot read
// out an unbounded list, and it bounds the query cost on the web path too.
const MAX_QUERY_RESULTS = 10;

export interface ChainHandlerResult {
  success: boolean;
  data: Record<string, unknown>;
  // Machine-readable status for the failure branches ('reconnect_required', 'not_found')
  // so each channel phrases its own message rather than parsing prose.
  message?: string;
}

// Recognises a date qualifier without committing to a specific range — used to decide
// whether a task query should be windowed by due date or just return everything pending.
function mentionsDateQualifier(message: string): boolean {
  return parseRelativeDateRange(message).matched;
}

export async function handleTaskQuery(tenantId: string, message: string): Promise<ChainHandlerResult> {
  const wantsCompleted = /\b(completed|done|finished|завршен|завршени|готов)\b/i.test(message);
  const status = wantsCompleted ? 'completed' : 'pending';

  const where: { tenant_id: string; status: string; due_at?: { gte: Date; lt: Date } } = {
    tenant_id: tenantId,
    status,
  };

  // Only window by due date when the caller actually named a time frame; a bare
  // "what tasks do I have left" should list everything still pending.
  if (mentionsDateQualifier(message)) {
    const { timeMin, timeMax } = parseRelativeDateRange(message);
    where.due_at = { gte: new Date(timeMin), lt: new Date(timeMax) };
  }

  const tasks = await prisma.tasks.findMany({
    where,
    orderBy: [{ due_at: { sort: 'asc', nulls: 'last' } }, { created_at: 'desc' }],
    take: MAX_QUERY_RESULTS,
    select: { id: true, title: true, notes: true, due_at: true, status: true },
  });

  return { success: true, data: { tasks, count: tasks.length, status } };
}

export async function handleCalendarQuery(
  tenantId: string,
  userAuthId: string,
  message: string,
): Promise<ChainHandlerResult> {
  const { timeMin, timeMax } = parseRelativeDateRange(message);

  try {
    const events: CalendarEventRecord[] = await listCalendarEvents(tenantId, userAuthId, {
      timeMin,
      timeMax,
      maxResults: MAX_QUERY_RESULTS,
    });
    return { success: true, data: { events, count: events.length, timeMin, timeMax } };
  } catch (error) {
    // listCalendarEvents wraps the reconnect case in a generic Error message, so match on
    // both the typed error and the wrapped-message form to stay robust to that wrapping.
    const isReconnect =
      error instanceof GmailReconnectRequiredError ||
      (error instanceof Error && /reconnect google/i.test(error.message));
    if (isReconnect) {
      return { success: false, data: {}, message: 'reconnect_required' };
    }
    throw error;
  }
}

// Normalises a name for matching: collapse whitespace, drop case/accents. Mirrors the
// intent of _normalize_client_name in apps/python/routers/clients.py, reimplemented in TS
// so a simple name lookup needs no Python round-trip.
function normalizeName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritical marks
    .toLowerCase();
}

export async function handleClientLookup(tenantId: string, message: string): Promise<ChainHandlerResult> {
  const clients = await prisma.clients.findMany({
    where: { tenant_id: tenantId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      address: true,
      city: true,
      tax_number: true,
      notes: true,
    },
  });

  const normalizedMessage = normalizeName(message);

  // Prefer the longest stored name that appears in the message — "Marko Petrov" wins over
  // a client merely named "Marko" when both are substrings of what the caller said.
  let best: (typeof clients)[number] | null = null;
  let bestLength = 0;
  for (const client of clients) {
    const normalizedName = normalizeName(client.name);
    if (normalizedName && normalizedMessage.includes(normalizedName) && normalizedName.length > bestLength) {
      best = client;
      bestLength = normalizedName.length;
    }
  }

  if (!best) {
    return { success: false, data: {}, message: 'not_found' };
  }

  return { success: true, data: { client: best } };
}
