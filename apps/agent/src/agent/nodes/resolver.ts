import type { AgentState } from '../state.js';
import { getChainRegistry } from './chainRegistry.js';
import { resolveChainWithLlm } from './llmResolver.js';

export async function resolver(state: AgentState): Promise<Partial<AgentState>> {
  const latestUserMessage = [...state.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  const chains = getChainRegistry();

  if (!latestUserMessage.trim()) {
    return {
      currentAction: 'resolving',
      errors: [...state.errors, 'Resolver could not find a user message to route.'],
    };
  }

  try {
    const decision = await resolveChainWithLlm(latestUserMessage, chains);

    return {
      currentAction: 'resolving',
      resolvedChainId: decision.chainId,
      resolverConfidence: decision.confidence,
      resolverReason: decision.reason,
      resolverMissingInfo: decision.missingInfo,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown resolver error.';
    return {
      currentAction: 'resolving',
      errors: [...state.errors, `Resolver failed: ${message}`],
    };
  }
}
