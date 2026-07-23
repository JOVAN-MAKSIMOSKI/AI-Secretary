// Deterministic half of the chain-eval-authoring skill: reports which chains are
// under-covered and prints the sibling descriptions needed to author boundary cases.
// Everything here is computed from the registry and the golden file — no judgment,
// no model call. The skill handles only the part that genuinely needs judgment.
import { getChainRegistry } from '../agent/nodes/chainRegistry.js';
import { countCasesByChain, loadGoldenCases, MIN_GOLDEN_CASES_PER_CHAIN } from './goldenSet.js';

const cases = loadGoldenCases();
const counts = countCasesByChain(cases);
const registry = getChainRegistry();

const lines: string[] = [];
lines.push(`Golden set: ${cases.length} cases across ${registry.length} chains`);
lines.push(`Minimum per chain: ${MIN_GOLDEN_CASES_PER_CHAIN}`);
lines.push('');

const gaps = registry.filter((chain) => (counts.get(chain.id) ?? 0) < MIN_GOLDEN_CASES_PER_CHAIN);

for (const chain of registry) {
  const count = counts.get(chain.id) ?? 0;
  const status = count < MIN_GOLDEN_CASES_PER_CHAIN ? `NEEDS ${MIN_GOLDEN_CASES_PER_CHAIN - count} MORE` : 'ok';
  lines.push(`${chain.id.padEnd(30)} ${String(count).padStart(2)}/${MIN_GOLDEN_CASES_PER_CHAIN}  ${status}`);
}

if (gaps.length > 0) {
  lines.push('');
  lines.push('Sibling descriptions — author each gap chain a boundary case that could');
  lines.push('plausibly be confused with one of these, then confirm it routes correctly:');
  for (const chain of registry) {
    lines.push(`  ${chain.id}: ${chain.description}`);
  }
  lines.push('');
  lines.push('Existing case ids (do not reuse):');
  lines.push(`  ${cases.map((goldenCase) => goldenCase.id).join(', ')}`);
}

process.stdout.write(`${lines.join('\n')}\n`);

if (gaps.length > 0) {
  process.exitCode = 1;
}
