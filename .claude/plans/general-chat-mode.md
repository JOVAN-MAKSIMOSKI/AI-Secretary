# General Chat Mode — dashboard + Twilio

Approved 2026-07-29.

## Goal

A `general_chat` chain that answers everything the task-specific chains do not:
greetings, small talk, general knowledge, and open-ended questions that need
internet research. Reachable from both the dashboard chat and a phone call,
through one shared implementation.

## Why one implementation

`callHandler.ts` already had `generateConversationalReply()`, but only as a
confidence < 0.7 fallback — it was never a routed intent, and the web path had
no equivalent at all. That is the same shape of duplication `chainHandlers.ts`
was created to remove for the read-only query chains. `generalChatChain.ts`
follows that precedent: one tenant-agnostic function, per-channel presentation.

## Model roles (they are separate, and only one of them is new)

| Role | Configured by | Model |
|---|---|---|
| Router — picks the chain | `ROUTER_LLM_PROVIDER=github` | gpt-4o (GitHub Models) |
| Eval router | `evalEnv.ts` forces openai + `EVALAPIKEY` | gpt-4o-mini |
| Waste-law RAG answers (Python) | `RAG_LLM_MODEL` | gpt-4o |
| **General chat replies (new)** | `GENERAL_CHAT_API_KEY` | **gpt-5-nano** |

The router only emits a chain id, never prose, so it stays on gpt-4o.

`CLAUDE.md` pins the agent's LLM to Claude Haiku, but `ANTHROPIC_API_KEY` was
absent from `apps/agent/.env` and only an OpenAI credential exists — which is
also why the pre-existing voice fallback had been returning its canned error on
every call. The chain therefore runs OpenAI, recorded as a scoped exception in
`.claude/rules/agent-service.md`, `guardrails.md`, and `CLAUDE.md`.

`gpt-5-nano` was chosen on measurement, not preference: it is the cheapest model
($0.05/$0.40 per 1M) that actually supports the hosted `web_search` tool —
`gpt-4.1-nano` rejects it outright, verified by probe — and being a gpt-5
reasoning model it bills searches at $10/1k rather than $25/1k. Search calls,
not tokens, dominate the cost of this feature: one search runs $0.01–0.025
against roughly $0.0003 for a whole chat turn.

`GENERAL_CHAT_API_KEY` is deliberately not `OPENAI_API_KEY`, which would flip
the resolver's auto mode onto paid routing.

## Changes

1. **`chainRegistry.ts`** — `general_chat` added to `ChainId` and the registry.
   The description is written defensively: it states what the chain is *for* and
   then names every sibling chain it must not steal from.

2. **`generalChatChain.ts`** (new) — `runGeneralChat({ message, history, channel })`
   against the OpenAI Responses API, with the hosted `web_search` tool at
   `tool_choice: auto` and `max_tool_calls: 2`. Per-channel system prompts
   (`web`: markdown allowed; `voice`: 1–2 spoken sentences — the old
   `VOICE_SYSTEM_PROMPT` moved here). Two behaviours came from probe failures
   and are deliberate: voice output goes through `sanitizeForSpeech()` because
   the model appends `([domain](url))` citations after a search regardless of
   what the prompt says, and `max_output_tokens` stays generous on voice because
   on a reasoning model that ceiling covers reasoning tokens too — a voice-sized
   cap returns empty text.

3. **`directResolverChain.ts`** — `general_chat` case returning `{ success, answer }`.

4. **`callHandler.ts`** — `general_chat` case in `executeChain`; the low-confidence
   fallback rewired to the same function so the channels cannot drift.

5. **`server.ts`** — history validation extracted from `parseWasteLawChatRequest`
   into a shared helper; `/agent/resolve-and-run` now accepts `history`.

6. **Web** — `general_chat` added to `ResolvedDashboardChainId`, rendered by a new
   branch in `formatNonInvoiceChainResponse`, history sent from `useDashboardChat`.

## Evals — "only when needed"

The existing gates are aggregate and deliberately tolerant of one flaky miss.
A catch-all chain needs a gate on one *direction* of error, so:

- 6 positive `general_chat` cases — canonical Macedonian, canonical English,
  a boundary against `calendar_query`, a no-keyword case, and a prompt-injection
  case, per the `chain-eval-authoring` four-case shape.
- **Anti-poaching cases**: 6 deliberately chatty/vague phrasings of real requests
  that a greedy catch-all would steal, with `expect` set to the real chain and a
  `note` explaining the trap — one each for `task_query`, `calendar_query`,
  `firm_lookup`, `waste_law_query`, `invoice_extraction`, `offer_extraction`.
- **`generalChatFalsePositives`** — a new hard counter in `routing.eval.ts`:
  any case whose `expect` is not `general_chat` but which routed *to*
  `general_chat`. Thresholded by `maxGeneralChatFalsePositives` in
  `baseline.json`, **measured at 0 and committed at 0**. Fails the build
  independently of the accuracy floors.

**Measured 2026-07-29:** 58/58 = 1.000 overall, every chain 1.000, 0 false
positives, across two consecutive runs. `overallAccuracy` raised 0.93 → 0.95.

## Decisions taken

- **Web research on voice calls: on.** Adds seconds to a live call; accepted for
  now, to be optimised later.
- **Pre-existing dashboard rendering gap left alone.** `task_query`,
  `calendar_query`, `firm_lookup`, and `waste_law_query` still fall through to
  the generic JSON dump in `formatNonInvoiceChainResponse`. Out of scope.
