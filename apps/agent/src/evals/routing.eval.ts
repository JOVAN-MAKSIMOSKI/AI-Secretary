// Gate B — live routing eval. Calls whatever provider ROUTER_LLM_PROVIDER selects,
// so it exercises the same path production uses rather than a stand-in.
// Scored in aggregate against a committed baseline: LLM routing is not deterministic,
// and a gate that fails on a single flaky run gets ignored within a week.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getChainRegistry, type ChainId } from '../agent/nodes/chainRegistry.js';
import { resolveChainWithLlm } from '../agent/nodes/llmResolver.js';
import { configureEvalEnv, evalRouterModel } from './evalEnv.js';
import { loadGoldenCases, type GoldenCase } from './goldenSet.js';

const BASELINE_FILE = 'baseline.json';

interface Baseline {
  overallAccuracy: number;
  perChainAccuracy: number;
}

interface CaseOutcome {
  goldenCase: GoldenCase;
  passed: boolean;
  detail: string;
}

function loadBaseline(): Baseline {
  const filePath = join(dirname(fileURLToPath(import.meta.url)), BASELINE_FILE);
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Baseline).overallAccuracy !== 'number' ||
    typeof (parsed as Baseline).perChainAccuracy !== 'number'
  ) {
    throw new Error(`${BASELINE_FILE} must define numeric overallAccuracy and perChainAccuracy.`);
  }
  return parsed as Baseline;
}

async function runCase(goldenCase: GoldenCase): Promise<CaseOutcome> {
  try {
    const decision = await resolveChainWithLlm(goldenCase.message, getChainRegistry());

    if (decision.chainId !== goldenCase.expect) {
      return {
        goldenCase,
        passed: false,
        // Confidence is reported on a wrong route too: a high number here means the
        // router was confidently wrong, which the minConfidence floor cannot catch.
        detail: `routed to ${decision.chainId} at confidence ${decision.confidence.toFixed(2)} (expected ${goldenCase.expect}) — ${decision.reason}`,
      };
    }

    if (decision.confidence < goldenCase.minConfidence) {
      return {
        goldenCase,
        passed: false,
        detail: `correct chain but confidence ${decision.confidence.toFixed(2)} < floor ${goldenCase.minConfidence}`,
      };
    }

    return { goldenCase, passed: true, detail: `ok (confidence ${decision.confidence.toFixed(2)})` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { goldenCase, passed: false, detail: `resolver threw: ${message}` };
  }
}

const evalEnv = configureEvalEnv();

test('routing accuracy meets the committed baseline', { skip: evalEnv.reason }, async (t) => {
  const baseline = loadBaseline();
  const cases = loadGoldenCases();
  const outcomes: CaseOutcome[] = [];

  t.diagnostic(`provider openai, model ${evalRouterModel()}, ${cases.length} cases`);

  // Sequential on purpose: the GitHub Models free tier has daily request caps, and a
  // burst of parallel calls turns a quota error into what looks like a quality failure.
  for (const goldenCase of cases) {
    outcomes.push(await runCase(goldenCase));
  }

  for (const outcome of outcomes) {
    if (!outcome.passed) {
      t.diagnostic(`FAIL ${outcome.goldenCase.id}: ${outcome.detail}`);
      if (outcome.goldenCase.note) {
        t.diagnostic(`      why this case exists: ${outcome.goldenCase.note}`);
      }
    }
  }

  const passed = outcomes.filter((outcome) => outcome.passed).length;
  const overallAccuracy = passed / outcomes.length;
  t.diagnostic(`overall ${passed}/${outcomes.length} = ${overallAccuracy.toFixed(3)} (floor ${baseline.overallAccuracy})`);

  const perChain = new Map<ChainId, { passed: number; total: number }>();
  for (const outcome of outcomes) {
    const bucket = perChain.get(outcome.goldenCase.expect) ?? { passed: 0, total: 0 };
    bucket.total += 1;
    if (outcome.passed) {
      bucket.passed += 1;
    }
    perChain.set(outcome.goldenCase.expect, bucket);
  }

  // Per-chain floor catches one chain being wholly broken while the overall average
  // stays healthy because the other chains carry it.
  const brokenChains: string[] = [];
  for (const [chainId, bucket] of perChain) {
    const accuracy = bucket.passed / bucket.total;
    t.diagnostic(`  ${chainId}: ${bucket.passed}/${bucket.total} = ${accuracy.toFixed(3)}`);
    if (accuracy < baseline.perChainAccuracy) {
      brokenChains.push(`${chainId} (${accuracy.toFixed(3)})`);
    }
  }

  assert.deepEqual(
    brokenChains,
    [],
    `Chains below the per-chain floor of ${baseline.perChainAccuracy}: ${brokenChains.join(', ')}`,
  );

  assert.ok(
    overallAccuracy >= baseline.overallAccuracy,
    `Overall routing accuracy ${overallAccuracy.toFixed(3)} is below the baseline ${baseline.overallAccuracy}.`,
  );
});
