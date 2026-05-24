// Typed agent state interface — shared across all LangGraph nodes

export interface AgentState {
  tenantId: string;
  clientId: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  currentAction: 'idle' | 'planning' | 'resolving' | 'executing' | 'auditing';
  approvalGate: {
    pending: boolean;
    action: string;
    details: Record<string, unknown>;
    approvedAt?: string;
  };
  ragContext: string;
  errors: string[];
}
