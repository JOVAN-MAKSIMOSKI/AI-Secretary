// Typed agent state interface — shared across all LangGraph nodes

import type { ChainId } from './nodes/chainRegistry.js';

export interface AgentState {
  tenantId: string;
  firmId: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  currentAction: 'idle' | 'planning' | 'resolving' | 'executing' | 'auditing';
  // ChainId from the registry so new chains (e.g. waste_law_query) can't drift
  // from this union
  resolvedChainId?: ChainId;
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
