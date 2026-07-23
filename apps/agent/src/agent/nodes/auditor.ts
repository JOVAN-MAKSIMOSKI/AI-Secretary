// auditor node — writes AuditLog entry to Supabase after action completes
import type { AgentState } from '../state.js';

export async function auditor(_state: AgentState): Promise<Partial<AgentState>> {
  // TODO: implement
  return {};
}
