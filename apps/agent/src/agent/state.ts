// Typed agent state interface — shared across all LangGraph nodes

export interface AgentState {
  tenantId: string;
  clientId: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  currentAction: 'idle' | 'planning' | 'resolving' | 'executing' | 'auditing';
  resolvedChainId?: 'invoice_extraction' | 'offer_extraction' | 'calendar_event_extraction';
  resolverConfidence?: number;
  resolverReason?: string;
  resolverMissingInfo?: string[];
  approvalGate: {
    pending: boolean;
    action: string;
    details: Record<string, unknown>;
    approvedAt?: string;
  };
  ragContext: string;
  errors: string[];
}
