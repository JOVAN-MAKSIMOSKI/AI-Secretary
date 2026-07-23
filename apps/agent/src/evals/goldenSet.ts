import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getChainRegistry, type ChainId } from '../agent/nodes/chainRegistry.js';

const GOLDEN_FILE = 'golden/routing.jsonl';
const COMMENT_PREFIX = '//';

// A chain with fewer cases than this is effectively unevaluated — the offline eval
// fails the build rather than letting a new chain ship without routing coverage.
export const MIN_GOLDEN_CASES_PER_CHAIN = 4;

export interface GoldenCase {
  id: string;
  message: string;
  expect: ChainId;
  minConfidence: number;
  note?: string;
  // Provenance. Cases drafted by a model are marked "generated" so their real-world
  // catch rate can be compared against cases derived from production failures — a
  // model-authored case can only ever test agreement with the chain description.
  source?: 'human' | 'generated' | 'production';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${where}: "${key}" must be a non-empty string.`);
  }
  return value;
}

export function loadGoldenCases(): GoldenCase[] {
  const filePath = join(dirname(fileURLToPath(import.meta.url)), GOLDEN_FILE);
  const validChainIds = new Set<string>(getChainRegistry().map((chain) => chain.id));
  const seenIds = new Set<string>();
  const cases: GoldenCase[] = [];

  readFileSync(filePath, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith(COMMENT_PREFIX)) {
        return;
      }

      const where = `${GOLDEN_FILE}:${index + 1}`;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new Error(`${where}: not valid JSON.`);
      }

      if (!isRecord(parsed)) {
        throw new Error(`${where}: each line must be a JSON object.`);
      }

      const id = requireString(parsed, 'id', where);
      if (seenIds.has(id)) {
        throw new Error(`${where}: duplicate case id "${id}".`);
      }
      seenIds.add(id);

      const expect = requireString(parsed, 'expect', where);
      if (!validChainIds.has(expect)) {
        throw new Error(
          `${where}: "expect" is "${expect}", which is not a registered ChainId. ` +
            `Known ids: ${[...validChainIds].join(', ')}.`,
        );
      }

      const minConfidence = parsed.minConfidence;
      if (typeof minConfidence !== 'number' || minConfidence < 0 || minConfidence > 1) {
        throw new Error(`${where}: "minConfidence" must be a number in [0,1].`);
      }

      const note = parsed.note;
      if (note !== undefined && typeof note !== 'string') {
        throw new Error(`${where}: "note" must be a string when present.`);
      }

      const source = parsed.source;
      if (source !== undefined && source !== 'human' && source !== 'generated' && source !== 'production') {
        throw new Error(`${where}: "source" must be one of human | generated | production when present.`);
      }

      cases.push({
        id,
        message: requireString(parsed, 'message', where),
        expect: expect as ChainId,
        minConfidence,
        ...(note === undefined ? {} : { note }),
        ...(source === undefined ? {} : { source }),
      });
    });

  return cases;
}

export function countCasesByChain(cases: GoldenCase[]): Map<ChainId, number> {
  const counts = new Map<ChainId, number>();
  for (const chain of getChainRegistry()) {
    counts.set(chain.id, 0);
  }
  for (const goldenCase of cases) {
    counts.set(goldenCase.expect, (counts.get(goldenCase.expect) ?? 0) + 1);
  }
  return counts;
}
