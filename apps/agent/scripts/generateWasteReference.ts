// Codegen — emits apps/python/resources/waste_reference.json from wasteChapters.ts.
// Run with: pnpm --filter agent gen:waste-reference
//
// wasteChapters.ts stays the single source of truth for the waste reference data. The
// Python side needs the same closed sets in two places — the extraction prompt, which
// must offer the model exact list values to snap onto, and the Pydantic request model,
// which rejects anything outside them. Hand-copying the lists into Python would let the
// two drift apart silently, and a drifted code map means a legally wrong form. CI
// regenerates this file and fails on any diff.

import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

import {
  EWC_HAZARDOUS_CODE_MAP_MK,
  EWC_NON_HAZARDOUS_CODE_MAP_MK,
  PACKING_METHODS_MK,
  WASTE_ORIGINS_MK,
  WASTE_OPERATIONS_CODES,
} from '../src/agent/wasteChapters.js';

const OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../python/resources/waste_reference.json'
);

const reference = {
  _source:
    'Generated from apps/agent/src/agent/wasteChapters.ts by `pnpm --filter agent gen:waste-reference`. Do not edit by hand.',
  ewc_hazardous_code_map: EWC_HAZARDOUS_CODE_MAP_MK,
  ewc_non_hazardous_code_map: EWC_NON_HAZARDOUS_CODE_MAP_MK,
  packing_methods: PACKING_METHODS_MK,
  waste_origins: WASTE_ORIGINS_MK,
  waste_operations_codes: WASTE_OPERATIONS_CODES,
};

mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
// Trailing newline keeps the CI `git diff --exit-code` check stable across editors.
writeFileSync(OUTPUT_PATH, `${JSON.stringify(reference, null, 2)}\n`, 'utf8');

console.log(`Wrote ${OUTPUT_PATH}`);
