import Anthropic from '@anthropic-ai/sdk';

import type { ChainDefinition, ChainId } from './chainRegistry.js';

export interface ResolverDecision {
  chainId: ChainId;
  confidence: number;
  reason: string;
  missingInfo: string[];
}

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

let client: Anthropic | null = null;

function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return null;
  }

  if (!client) {
    client = new Anthropic({ apiKey });
  }

  return client;
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  const candidate = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function isValidChainId(value: unknown, chains: ChainDefinition[]): value is ChainId {
  return typeof value === 'string' && chains.some((chain) => chain.id === value);
}

function keywordFallback(message: string, chains: ChainDefinition[]): ResolverDecision {
  const lowered = message.toLowerCase();
  let bestScore = -1;
  let selected = chains[0];

  for (const chain of chains) {
    const score = chain.keywords.reduce((acc, keyword) => {
      return acc + (lowered.includes(keyword.toLowerCase()) ? 1 : 0);
    }, 0);

    if (score > bestScore) {
      bestScore = score;
      selected = chain;
    }
  }

  return {
    chainId: selected.id,
    confidence: bestScore > 0 ? 0.55 : 0.35,
    reason: 'Selected by keyword fallback because LLM result was unavailable.',
    missingInfo: [],
  };
}

export async function resolveChainWithLlm(
  userMessage: string,
  chains: ChainDefinition[],
): Promise<ResolverDecision> {
  if (chains.length === 0) {
    throw new Error('Chain registry is empty. Register at least one chain.');
  }

  const anthropic = getAnthropicClient();
  if (!anthropic) {
    return keywordFallback(userMessage, chains);
  }

  const chainCatalog = chains
    .map((chain) => {
      return `${chain.id}: ${chain.description}`;
    })
    .join('\n');

  const systemPrompt = [
    'You are a routing resolver for a multi-chain AI secretary.',
    'Select exactly one chain id from the provided catalog.',
    'Return only JSON with keys: chainId, confidence, reason, missingInfo.',
    'confidence must be in [0,1]. missingInfo must be an array of short strings.',
  ].join(' ');

  const userPrompt = [
    'Available chains:',
    chainCatalog,
    '',
    'User message:',
    userMessage,
  ].join('\n');

  const response = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 300,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  const parsed = extractJsonObject(text);
  if (!parsed || !isValidChainId(parsed.chainId, chains)) {
    return keywordFallback(userMessage, chains);
  }

  const missingInfo = Array.isArray(parsed.missingInfo)
    ? parsed.missingInfo.filter((item): item is string => typeof item === 'string')
    : [];

  return {
    chainId: parsed.chainId,
    confidence: normalizeConfidence(parsed.confidence),
    reason: typeof parsed.reason === 'string' ? parsed.reason : 'Resolved via LLM selection.',
    missingInfo,
  };
}
