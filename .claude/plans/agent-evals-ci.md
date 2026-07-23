# Agent Evals in CI

**Goal:** adding a new chain must never silently break routing. A failing eval blocks
the build, which blocks the deploy.

**Status as of 2026-07-23: Gates A, B, and C are implemented, verified, and blocking.**
Gate C has two halves: retrieval recall (green locally, self-skips in CI until a hosted
Qdrant exists) and extraction field accuracy (runs in CI via `EVALAPIKEY`). The only
remaining tiers — LLM judge and human calibration — are deliberately blocked on
production traffic existing.

Skill references: `.claude/skills/agent-evals/` for the three-tier model,
`.claude/skills/chain-eval-authoring/` for writing golden cases.

---

## What runs today

Both gates live as steps in the existing `check` job in `.github/workflows/deploy.yml`.
`build` declares `needs: check` and `deploy` declares `needs: build`, so a failing eval
blocks the deploy with no extra gating logic. Triggers are `push` to `main`/`test` and
`pull_request` against them; `build` is restricted to push events so a PR gets the gate
without pushing an image.

Step order is deliberate — every free deterministic check runs before the one paid step,
so a broken build never buys API calls to discover it:

```
type-check → Gate A (agent) → uv sync → compileall → Gate A (python) → Gate B (paid)
```

### Gate A — offline, deterministic, free

**Agent** — `pnpm --filter agent eval:offline`, 11 checks, ~0.4s, no network.

`src/evals/offline.eval.ts`:
1. Golden set parses; every `expect` is a registered `ChainId`
2. Every chain has ≥ `MIN_GOLDEN_CASES_PER_CHAIN` (4) golden cases — the core guarantee
3. Every chain has a non-empty description (routing reads descriptions only)
4. Chain ids are unique
5. The resolver throws rather than falling back to keywords when no provider is
   configured — locks in the `guardrails.md` policy with no network call

`src/evals/handlerLogic.eval.ts`:
6–11. Calendar payload validation and local-time arithmetic across every rollover
boundary (hour, day, month, year, non-leap and leap February), plus malformed-input
rejection and the `buildLocalDateTime` → `addMinutesToLocalDateTime` contract.

**Python** — `uv run pytest -q`, 23 tests, ~1.6s, no Qdrant, no model load, no network.

`tests/test_rag_injection_guards.py` covers `_detect_prompt_injection_markers`,
`_assert_safe_question`, `_sanitize_retrieved_passage`, including regression guards for
operator-status questions that must not be treated as prompt injection.

### Gate B — live routing accuracy, paid

`pnpm --filter agent eval:routing`, 16 golden cases, ~25s, ~$0.001 per run.

Calls the real `resolveChainWithLlm()`. Scored in aggregate against
`src/evals/baseline.json` — LLM routing is not deterministic and a gate that fails on a
single flaky run gets ignored within a week. Two floors:

- `overallAccuracy: 0.93` — one miss tolerated (15/16 = 0.9375), two fails (14/16 = 0.875)
- `perChainAccuracy: 0.75` — catches one chain being wholly broken while the average holds

Self-skips when `EVALAPIKEY` is absent, so forks and secretless runs degrade to Gate A.

**Last measured run — 2026-07-22, openai/gpt-4o-mini: 16/16 = 1.000, every chain 4/4.**

---

## Files

```
apps/agent/src/evals/goldenSet.ts            loader + validation, source provenance
apps/agent/src/evals/golden/routing.jsonl    16 bilingual cases, 4 per chain
apps/agent/src/evals/offline.eval.ts         Gate A — registry + golden set
apps/agent/src/evals/handlerLogic.eval.ts    Gate A — calendar logic and date math
apps/agent/src/evals/routing.eval.ts         Gate B — live routing
apps/agent/src/evals/baseline.json           committed floors
apps/agent/src/evals/evalEnv.ts              EVALAPIKEY → OPENAI_API_KEY, eval process only
apps/agent/src/evals/coverage.ts             coverage report for chain-eval-authoring
apps/agent/src/agent/calendarTime.ts         pure calendar logic, extracted to be testable
apps/python/tests/test_rag_injection_guards.py
```

npm scripts in `apps/agent`: `eval:coverage`, `eval:offline`, `eval:routing`.

## Provider

An `openai` provider was added to `llmResolver.ts`. GitHub Models and OpenAI both speak
`/chat/completions`, so they share one `resolveWithOpenAiCompatible()` differing only by
base URL, token, and model — this removed duplication that already existed rather than
adding a third copy. Auto-mode priority: OpenAI → GitHub Models → Anthropic.

Credential boundary: `EVALAPIKEY` is evaluation-only. `src/evals/evalEnv.ts` maps it onto
`OPENAI_API_KEY` inside the eval process, pins the provider to `openai`, and clears the
GitHub/Anthropic tokens so a misconfigured run cannot silently spend the free tier. The
eval key never becomes the running service's routing credential.

---

## Defects this work surfaced

**Fixed:**

1. **`act as a` rejected legitimate legal questions.** `_PROMPT_INJECTION_PATTERNS`
   matched bare `act\s+as\s+(an?|the)`, so "Can my company act as a waste collector under
   the law?" was refused as prompt injection — core vocabulary for a waste-law advisor.
   Narrowed to fire only when imperative or addressed to the assistant.
2. **`CALENDAR_DEFAULT_DURATION_MINUTES` was dead.** The zod schema applies `.default(15)`,
   so the `??` fallback was unreachable and the env var had no effect. Both removed.
3. **Calendar schema was duplicated** in `callHandler.ts`; it now imports the shared one.
4. **Pure logic was untestable.** Importing `directResolverChain.ts` pulls in
   `mcp/calendar.js` → `lib/prisma.ts`, which throws `DATABASE_URL is required` at import.
   Extracted to `src/agent/calendarTime.ts`, which imports nothing but zod.
5. **`llmResolver.test.ts` deleted.** It forced `ROUTER_LLM_PROVIDER = 'keyword'`,
   exercising the matcher `guardrails.md` forbids, and would have passed green with LLM
   routing completely broken. Superseded by the golden set; Gate A check 5 covers the one
   useful thing it asserted, correctly.

**Open — product decision, not a code fix:**

6. **Uncalibrated confidence gates real voice behaviour.** `callHandler.ts:36` sets
   `CONFIDENCE_THRESHOLD = 0.7`; the call handler executes the resolved chain directly when
   the router's self-reported confidence clears it, with no confirmation. That number is
   invented by the model — measured **0.90 on a route that was flatly wrong**. CLAUDE.md
   requires a human approval gate before saving a file. Jovan chose the approval-gate
   option and then deferred implementation; the plan file was deleted and is to be
   recreated when picked up.

---

## Gate C — retrieval, implemented 2026-07-22

`apps/python/evals/` — `uv run pytest evals/ -q`, 9 golden cases, ~15s locally.

Given a Macedonian legal question, asserts the expected law appears in the retriever's
top-6, reusing production's `DirectQdrantQueryEngine._retrieve_context` rather than
reimplementing retrieval. Scored as recall@k against `evals/baseline.json`
(`recallAtK: 0.85`, `topK: 6`), so one ranking wobble does not fail a build and two do.
Rank is reported even on a hit — a case sliding from 1 to 6 is a real regression that
recall alone cannot see.

**Measured 2026-07-22: 9/9 = 1.000, eight of nine at rank 1.**

Kept in `evals/` rather than `tests/` so the fast Gate A half stays at ~1.5s.

**Cannot run in CI yet.** `qdrant_data/` is gitignored (47MB, 3950 chunks, 46 laws) and
the multilingual-e5-large weights are ~2GB. The workflow step is wired and self-skips in
~2s without loading the model, so enabling it later means setting `QDRANT_URL`, not
editing the workflow. It will also need a cached or hosted embedding model before it is
practical per-push.

Golden cases were authored against measured output. Questions whose correct source is
genuinely ambiguous were excluded — "what are the penalties for missing the annual
report" is answered by penalty articles in at least three laws, so any single
expectation would test nothing but which law happened to rank first.

### Environment bug found and fixed

Local Qdrant could not open at all: `import pywintypes` failed. uv installs the pywin32
wheel but does not run its postinstall, so `.venv/Lib/site-packages/pywin32.pth` was
missing and `win32`, `win32\lib`, `Pythonwin` were never added to `sys.path`. Created
that file. **A `uv sync --reinstall` may drop it again** — documented in
`.claude/rules/python-service.md`.

## Voice-realistic routing cases — added 2026-07-22

Four cases covering the Twilio surface, which feeds raw STT output into the same
resolver: filler openers, no punctuation, polite phone framing, numbers spelled out,
relative dates. Golden set is now 20 cases, 5 per chain.

**All four pass — 20/20 = 1.000.** Routing on the voice surface was previously
unmeasured; it is now measured and green.

## Invoice layers 2 and 3 — implemented 2026-07-22

The invoice pipeline splits into three layers with very different cost and risk.

**Layer 2 — deterministic arithmetic** (`tests/test_invoice_calculations.py`, 13 tests,
free). Pins `price_before_tax = price_per_unit × units`, the tax-type defaults
(`goods` → 18%, `transport` → 5%), explicit-tax override, `ROUND_HALF_UP` to two places,
the missing-field early return, string inputs from JSON extraction, and non-mutation of
the caller's mapping.

Deliberately pins the **deduction** formula
(`price_after_tax = price_before_tax − price_before_tax × tax / 100`) so nobody later
"corrects" it into a VAT addition without that being a deliberate decision.

**Layer 3 — Macedonian amount-in-words: LLM removed.** `amount_to_macedonian_text` was
an LLM call (`_get_configured_llm` → `llm.complete(prompt)`) whose only validation was
"is the string non-empty". A model was writing the monetary amount in words onto a legal
invoice with nothing checking the words matched the digits.

Replaced with `services/invoices/macedonian_numbers.py` — deterministic, offline, free.
`tests/test_macedonian_numbers.py` has 1046 tests: exhaustive round-trip over 0–1000 plus
boundary values, explicit expected forms, and structural properties.

Side effects of the removal: no more GitHub-Models-free-tier dependency on invoice
generation (a quota exhaustion previously failed invoice creation outright, with no
fallback), and it closes a path where `RAG_LLM_PROVIDER=anthropic` would have called
Claude from the Python service, contrary to `guardrails.md`.

> **Verification caveat:** `words_to_int` proves the words encode the value
> unambiguously; it does **not** prove the phrasing is idiomatic. The round-trip tests
> passed on two genuinely wrong outputs ("дваесет една и илјада", "две и илјади")
> because the parser ignores `и` — the explicit-form tests caught those. **The
> vocabulary tables and `и` placement still need a native speaker's review.**

## Gate C — extraction field accuracy (layer 1), implemented 2026-07-23

`apps/python/evals/test_extraction.py` — `uv run pytest evals/test_extraction.py -q`,
9 golden cases / 36 field assertions across all three chains, ~19s, real LLM calls.

The "needs the service running (~40s boot)" assumption turned out to be false: the
chains are plain importable functions (`extract_invoice_fields_from_message`,
`run_calendar_event_extraction`, `run_offer_extraction`), so the eval calls exactly what
the routes call with no FastAPI, no Whisper, and no Supabase — invoice extraction runs
with `owner_auth_id=None` (skips client enrichment) and `evals/eval_env.py` sets
import-guard values for `services/storage.py`, which raises at import without them.

Credential boundary mirrors the agent side: `EVALAPIKEY` → `OPENAI_API_KEY` inside the
eval process only, provider pinned to openai, free-tier tokens cleared. The key is read
from env (CI) or `apps/agent/.env` (local), so it lives in one place.

Golden markers: `@tomorrow` (runtime-resolved relative date), `@absent` (the chain must
not invent a value — the omission guard for messages with no amounts), `contains:x`
(names). Scored per field, aggregated per chain against `evals/extraction_baseline.json`
(invoice 0.90, calendar 0.75, offer 0.75); tolerated misses still print, so nothing is
silently absorbed.

**First measured 2026-07-23: invoice 21/21 = 1.000, calendar 9/10 = 0.900 (one
defect, below), offer 5/5 = 1.000. After the fix, identical across two runs:
invoice 21/21, calendar 10/10, offer 5/5 — all 1.000.**

Runs in CI inside the existing Gate C step (`pytest evals/`), which now passes
`EVALAPIKEY`; retrieval and extraction each self-skip independently.

### Defect surfaced and fixed — calendar event_name wrong language

The calendar chain translated an English event name into **Russian**: "Schedule a
meeting with the accountant…" → `event_name: "встреча с бухгалтером"`. Reproducible at
temperature 0. Root cause: `run_calendar_event_extraction`'s `language_hint` gives the
model an explicit, forceful instruction naming the exact target language and script only
on the Cyrillic branch (`has_cyrillic`); the non-Cyrillic branch was an empty string,
leaving only a generic "keep the user's language" line buried in the shared rules — not
forceful enough on its own. Fixed by adding an equivalent explicit English-branch
instruction in `apps/python/langchain.py`. Verified: calendar went from 9/10 to 10/10 on
two consecutive runs. `ext-cal-en-absolute` is now a regression guard rather than a
tolerated miss, and the calendar floor was raised 0.75 → 0.90 in the same commit as the
fix, per the "raising a floor is a deliberate, reviewable act" rule.

## Not started
- **Tier 2 — sampled LLM judge.** Needs production traffic and a trace store. The only
  chain that would justify it is `waste_law_query`, whose prose answers cannot be
  string-matched. Retrieval recall now covers whether the right *source* is found; a
  judge would cover whether the *answer* is faithful to it. Nightly or main-only.
- **Tier 3 — human calibration.** Needs judge scores to disagree with.
