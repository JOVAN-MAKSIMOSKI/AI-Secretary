// executor node — calls document generation or comms tools
// Always sets approvalGate.pending = true before any send/save action
import type { AgentState } from '../state.js';

export async function executor(state: AgentState): Promise<Partial<AgentState>> {
  // TODO: implement
  return {};
}
