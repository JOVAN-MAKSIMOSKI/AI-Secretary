// Gate A — deterministic, offline, free. Runs on every push and every PR.
// Nothing here touches the network, so it never flakes and never costs a request.
// Its job is to make "added a chain, forgot the eval" a build failure.
import test from 'node:test';
import assert from 'node:assert/strict';

import { getChainRegistry } from '../agent/nodes/chainRegistry.js';
import { resolveChainWithLlm } from '../agent/nodes/llmResolver.js';
import { countCasesByChain, loadGoldenCases, MIN_GOLDEN_CASES_PER_CHAIN } from './goldenSet.js';

// Cleared so no ambient credential lets the resolver reach a provider mid-test. The
// retired GitHub Models vars stay listed: an old .env may still carry them, and
// deleting an absent var is a no-op.
const PROVIDER_CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'ROUTER_GITHUB_MODELS_TOKEN',
  'RAG_GITHUB_MODELS_TOKEN',
  'GITHUB_MODELS_TOKEN',
] as const;

function withRouterEnv(overrides: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const snapshot = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    snapshot.set(key, process.env[key]);
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return run().finally(() => {
    for (const [key, value] of snapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test('golden set parses and every case maps to a registered chain', () => {
  const cases = loadGoldenCases();
  assert.ok(cases.length > 0, 'Golden set is empty.');
});

test('every registered chain has enough golden coverage', () => {
  const counts = countCasesByChain(loadGoldenCases());
  const underCovered = [...counts.entries()]
    .filter(([, count]) => count < MIN_GOLDEN_CASES_PER_CHAIN)
    .map(([chainId, count]) => `${chainId} (${count}/${MIN_GOLDEN_CASES_PER_CHAIN})`);

  assert.deepEqual(
    underCovered,
    [],
    `Chains without enough golden cases: ${underCovered.join(', ')}. ` +
      'Add cases to src/evals/golden/routing.jsonl before merging a new chain.',
  );
});

test('every chain has a non-empty description', () => {
  // LLM routing reads descriptions only (keywords are dead weight under the
  // keyword-fallback-disabled policy), so an empty description is an unroutable chain.
  const undescribed = getChainRegistry()
    .filter((chain) => chain.description.trim() === '')
    .map((chain) => chain.id);

  assert.deepEqual(undescribed, [], `Chains missing a description: ${undescribed.join(', ')}`);
});

test('chain ids are unique', () => {
  const ids = getChainRegistry().map((chain) => chain.id);
  assert.equal(new Set(ids).size, ids.length, 'Duplicate chain id in CHAIN_REGISTRY.');
});

test('resolver throws instead of falling back to keywords when no provider is configured', () => {
  // guardrails.md: a resolver failure must surface as a hard error, never degrade to
  // a silent keyword guess. This locks that policy in without a network call.
  const overrides: Record<string, string | undefined> = {
    ROUTER_LLM_PROVIDER: 'auto',
    ROUTER_ALLOW_KEYWORD_FALLBACK: 'false',
  };
  for (const key of PROVIDER_CREDENTIAL_VARS) {
    overrides[key] = undefined;
  }

  return withRouterEnv(overrides, async () => {
    await assert.rejects(
      resolveChainWithLlm('Направи фактура за ACME', getChainRegistry()),
      /LLM resolver failed/,
      'Resolver must throw when no provider is configured and keyword fallback is disabled.',
    );
  });
});
