// executor node — calls document generation or comms tools
// Always sets approvalGate.pending = true before any send/save action
import type { AgentState } from '../state.js';

type ExecutorPlan = {
  action: string;
  details: Record<string, unknown>;
};

function buildExecutorPlan(state: AgentState): ExecutorPlan | null {
  const latestUserMessage = [...state.messages].reverse().find((message) => message.role === 'user')?.content ?? '';

  switch (state.resolvedChainId) {
    case 'invoice_extraction':
      return {
        action: 'generate_invoice_document',
        details: {
          chainId: state.resolvedChainId,
          sourceMessage: latestUserMessage,
        },
      };
    case 'offer_extraction':
      return {
        action: 'generate_offer_document',
        details: {
          chainId: state.resolvedChainId,
          sourceMessage: latestUserMessage,
        },
      };
    case 'calendar_event_extraction':
      return {
        action: 'create_calendar_event',
        details: {
          chainId: state.resolvedChainId,
          sourceMessage: latestUserMessage,
        },
      };
    default:
      return null;
  }
}

export async function executor(state: AgentState): Promise<Partial<AgentState>> {
  if (!state.resolvedChainId) {
    return {
      currentAction: 'executing',
      errors: [...state.errors, 'Executor cannot run without resolvedChainId.'],
    };
  }

  if ((state.resolverMissingInfo?.length ?? 0) > 0) {
    return {
      currentAction: 'executing',
      errors: [
        ...state.errors,
        `Executor blocked; missing info: ${state.resolverMissingInfo?.join(', ')}`,
      ],
      approvalGate: {
        ...state.approvalGate,
        pending: false,
        action: 'collect_missing_info',
        details: {
          chainId: state.resolvedChainId,
          missingInfo: state.resolverMissingInfo,
        },
      },
    };
  }

  const plan = buildExecutorPlan(state);
  if (!plan) {
    return {
      currentAction: 'executing',
      errors: [...state.errors, `No executor plan for chain: ${state.resolvedChainId}`],
    };
  }

  return {
    currentAction: 'executing',
    approvalGate: {
      ...state.approvalGate,
      pending: true,
      action: plan.action,
      details: {
        ...plan.details,
        resolverConfidence: state.resolverConfidence,
        resolverReason: state.resolverReason,
      },
    },
  };
}
