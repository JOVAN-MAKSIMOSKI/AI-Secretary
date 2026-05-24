// Interaction type shared across agent and web

export interface Interaction {
  id: string;
  tenantId: string;
  clientId: string;
  rawText: string;
  summary: string;
  createdAt: string;
}
