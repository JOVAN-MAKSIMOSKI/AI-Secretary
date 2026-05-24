// Client type shared across agent and web

export interface Client {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  company?: string;
  vatNumber?: string;
  tone: string;
  notes?: string;
}
