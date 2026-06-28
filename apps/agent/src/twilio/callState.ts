import crypto from 'crypto';

export interface PendingApproval {
  originalTranscript: string;
  chainId: string;
  description: string;
  // Eagerly-started extraction result to avoid re-running the LLM chain on confirmation.
  extractionPromise?: Promise<Record<string, unknown>>;
}

export interface ProcessingJob {
  done: boolean;
  audioId?: string;
  error?: string;
}

export interface CallState {
  callSid: string;
  tenantId: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  pendingApproval?: PendingApproval;
  startedAt: Date;
}

const CALL_STATE_TTL_MS = 60 * 60 * 1_000;

const callStateMap = new Map<string, CallState>();
export const processingJobs = new Map<string, ProcessingJob>();
export const audioCache = new Map<string, Buffer>();

function pruneExpired(): void {
  const cutoff = Date.now() - CALL_STATE_TTL_MS;
  for (const [sid, state] of callStateMap) {
    if (state.startedAt.getTime() < cutoff) callStateMap.delete(sid);
  }
}

export function getOrCreateCallState(callSid: string, tenantId: string): CallState {
  pruneExpired();
  const existing = callStateMap.get(callSid);
  if (existing) return existing;
  const state: CallState = { callSid, tenantId, conversationHistory: [], startedAt: new Date() };
  callStateMap.set(callSid, state);
  return state;
}

export function updateCallState(callSid: string, updates: Partial<Omit<CallState, 'callSid' | 'startedAt'>>): void {
  const state = callStateMap.get(callSid);
  if (state) callStateMap.set(callSid, { ...state, ...updates });
}

export function getCallState(callSid: string): CallState | undefined {
  return callStateMap.get(callSid);
}

export function deleteCallState(callSid: string): void {
  callStateMap.delete(callSid);
}

export function newId(): string {
  return crypto.randomUUID();
}
