// Waste-law advisor chain (waste-law RAG plan, Phase 5).
// Reads the tenant's waste profile from businesses.tenantprofilecontext, formats
// it into a plain-text context string, and calls the Python /rag/chat endpoint.
// Python never sees raw auth data beyond the user's own bearer token — the
// tenant is resolved here, from the JWT, per the required architecture pattern.

import { prisma } from '../lib/prisma.js';
import { writeAuditLog } from '../repository/auditLogs.js';
import type { TenantWasteProfile } from '@secretary/shared-types';

const PYTHON_SERVICE_URL = process.env.PYTHON_SERVICE_URL || 'http://127.0.0.1:8000';
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
    parts.push(`Waste types generated: ${profile.waste_types.join(', ')}.`);
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

export async function runWasteLawChain(input: {
  tenantId: string;
  userAuthId: string;
  accessToken: string;
  message: string;
  history: WasteLawChatMessage[];
}): Promise<{ answer: string }> {
  const business = await prisma.businesses.findUnique({
    where: { owner_auth_id: input.tenantId },
    select: { tenantprofilecontext: true },
  });

  const tenantContext = business?.tenantprofilecontext
    ? buildTenantContext(business.tenantprofilecontext as unknown as TenantWasteProfile)
    : '';

  const response = await fetch(`${PYTHON_SERVICE_URL}/rag/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${input.accessToken}`,
    },
    body: JSON.stringify({
      question: input.message,
      history: input.history,
      tenant_context: tenantContext,
      top_k: WASTE_LAW_TOP_K,
    }),
  });

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
