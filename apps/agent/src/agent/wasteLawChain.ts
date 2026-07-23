// Waste-law advisor chain (waste-law RAG plan, Phase 5).
// Reads the tenant's waste profile from businesses.tenantprofilecontext, formats
// it into a plain-text context string, and calls the Python /rag/chat endpoint.
// Python never sees raw auth data beyond the user's own bearer token — the
// tenant is resolved here, from the JWT, per the required architecture pattern.

import { prisma } from '../lib/prisma.js';
import { writeAuditLog } from '../repository/auditLogs.js';
import type { TenantWasteProfile } from '@secretary/shared-types';

// PY_SERVICE_URL is the canonical var (zod-validated in lib/env.ts); the legacy
// PYTHON_SERVICE_URL name is kept as a fallback so older env files keep working.
const PYTHON_SERVICE_URL =
  process.env.PY_SERVICE_URL || process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
const WASTE_LAW_TOP_K = 10;

export interface WasteLawChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Human-readable labels for the structured profile values, so the LLM prompt
// reads naturally instead of echoing enum tokens like "5t_plus".
const ENTITY_LABELS: Record<string, string> = {
  individual: 'individual',
  small_business: 'small business',
  large_company: 'large company',
  municipality: 'municipality',
};

const WASTE_TYPE_LABELS: Record<string, string> = {
  hazardous_waste: 'hazardous waste',
  oils_tires: 'oil and tire waste',
  textile_paper: 'textile and paper',
  glass: 'glass',
  plastic: 'plastic',
  other: 'other',
};

const VOLUME_LABELS: Record<string, string> = {
  under_200kg: 'under 200 kg per year',
  '200kg_5t': 'between 200 kg and 5 tons per year',
  '5t_plus': 'over 5 tons per year',
};

export function buildTenantContext(profile: TenantWasteProfile): string {
  const parts: string[] = [];

  if (profile.entity_type) {
    parts.push(`Entity type: ${ENTITY_LABELS[profile.entity_type] ?? profile.entity_type}.`);
  }
  if (profile.business_sector) {
    parts.push(`Business sector: ${profile.business_sector}.`);
  }
  if (profile.waste_types?.length) {
    const wasteLabels = profile.waste_types.map(w => WASTE_TYPE_LABELS[w] ?? w);
    parts.push(`Waste types generated: ${wasteLabels.join(', ')}.`);
  }
  if (profile.annual_volume) {
    parts.push(`Annual waste volume: ${VOLUME_LABELS[profile.annual_volume] ?? profile.annual_volume}.`);
  }
  if (profile.location) {
    parts.push(`Location: ${profile.location}.`);
  }
  parts.push(`Holds waste-related permits: ${profile.has_permits ? 'yes' : 'no'}.`);
  if (profile.has_permits && profile.permit_types?.length) {
    parts.push(`Permit types held: ${profile.permit_types.join(', ')}.`);
  }

  return parts.join(' ');
}

interface WasteLawChainInput {
  tenantId: string;
  userAuthId: string;
  // Web path passes the caller's Supabase JWT. The Twilio voice path has no user
  // token and instead authenticates service-to-service — leave this undefined there.
  accessToken?: string;
  message: string;
  history: WasteLawChatMessage[];
  // Voice mode: request a short spoken answer instead of the full legal format.
  concise?: boolean;
}

// Chooses the auth headers for the Python call: a user Bearer JWT when the web path
// supplies one, otherwise service-to-service auth (X-Service-Secret + X-Tenant-Id),
// the same mechanism the Twilio extraction/STT calls already use.
function buildAuthHeaders(input: WasteLawChainInput): Record<string, string> {
  if (input.accessToken) {
    return { Authorization: `Bearer ${input.accessToken}` };
  }
  const secret = process.env.INTER_SERVICE_SECRET;
  if (!secret) {
    throw new Error('INTER_SERVICE_SECRET is not configured for service-to-service waste-law call.');
  }
  return { 'X-Service-Secret': secret, 'X-Tenant-Id': input.tenantId };
}

// Shared by the buffered and streaming variants: resolve the tenant's waste
// profile and POST the chat payload to the given Python endpoint.
async function fetchWasteLawEndpoint(input: WasteLawChainInput, path: string): Promise<globalThis.Response> {
  const business = await prisma.businesses.findUnique({
    where: { owner_auth_id: input.tenantId },
    select: { tenantprofilecontext: true },
  });

  const tenantContext = business?.tenantprofilecontext
    ? buildTenantContext(business.tenantprofilecontext as unknown as TenantWasteProfile)
    : '';

  return fetch(`${PYTHON_SERVICE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(input),
    },
    body: JSON.stringify({
      question: input.message,
      history: input.history,
      tenant_context: tenantContext,
      top_k: WASTE_LAW_TOP_K,
      concise: input.concise ?? false,
    }),
  });
}

export async function runWasteLawChain(input: WasteLawChainInput): Promise<{ answer: string }> {
  const response = await fetchWasteLawEndpoint(input, '/rag/chat');

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const detail = typeof payload.detail === 'string' ? payload.detail : 'Waste-law chat request failed.';
    throw new Error(detail);
  }

  const answer = typeof payload.answer === 'string' ? payload.answer : '';
  if (!answer) {
    throw new Error('Waste-law chat returned an empty answer.');
  }

  await writeAuditLog({
    tenantId: input.tenantId,
    userAuthId: input.userAuthId,
    action: 'law.query',
    meta: { questionLength: input.message.length, historyLength: input.history.length },
  });

  return { answer };
}

export async function runWasteLawChainStream(
  input: WasteLawChainInput,
): Promise<{ stream: ReadableStream<Uint8Array> }> {
  const response = await fetchWasteLawEndpoint(input, '/rag/chat/stream');

  if (!response.ok || !response.body) {
    // Pre-stream failures arrive as ordinary JSON error bodies from FastAPI.
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const detail = typeof payload.detail === 'string' ? payload.detail : 'Waste-law chat request failed.';
    throw new Error(detail);
  }

  // Audit the question once the upstream accepts it — mid-stream failures are
  // reported inside the SSE stream and don't produce a second audit entry.
  await writeAuditLog({
    tenantId: input.tenantId,
    userAuthId: input.userAuthId,
    action: 'law.query',
    meta: { questionLength: input.message.length, historyLength: input.history.length, streamed: true },
  });

  return { stream: response.body };
}
