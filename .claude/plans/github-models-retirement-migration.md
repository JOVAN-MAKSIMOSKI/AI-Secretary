# GitHub Models Retirement — Migration to OpenAI

**Date:** 2026-08-08
**Status:** Applied
**Trigger:** `POST /agent/resolve-and-run` returning 400 `Failed to resolve and execute chain.`
on every dashboard prompt.

---

## Root cause

GitHub Models was retired. Both endpoints are dead:

| Endpoint | Response |
|---|---|
| `https://models.inference.ai.azure.com/chat/completions` | 404 (host retired) |
| `https://models.github.ai/inference/chat/completions` | 410 `github_models_retirement_brownout` |

`apps/agent/.env` had `ROUTER_LLM_PROVIDER=github`. With
`ROUTER_ALLOW_KEYWORD_FALLBACK=false` (correct policy), `resolveChainWithLlm` threw,
`/agent/resolve-and-run` caught it, and `toSafeError` flattened the real error into the
generic 400 string. Every chain was down, not just the one being tested.

The failure was invisible from the browser by design — the real error was only in the
agent's server-side log.

---

## Changes applied

### Live config (gitignored)
- `apps/agent/.env` — `ROUTER_LLM_PROVIDER=openai`, added `OPENAI_API_KEY`, pinned
  `ROUTER_LLM_MODEL=gpt-4o`, `RAG_LLM_PROVIDER=openai`, removed `GITHUB_MODELS_TOKEN`
- `apps/python/.env` — removed dead `GITHUB_MODELS_TOKEN` (already on `openai`)

`OPENAI_API_KEY` carries the same key value as `GENERAL_CHAT_API_KEY`. The vars stay
separate so routing and chat spend remain independently attributable and revocable.

`ROUTER_LLM_MODEL=gpt-4o` is pinned deliberately: the retired `github` branch defaulted
to `gpt-4o`, the `openai` branch defaults to `gpt-4o-mini`. Pinning keeps routing on the
model it was actually running on rather than silently changing it during a fix.

### Code — provider removed, not aliased
- `apps/agent/src/agent/nodes/llmResolver.ts` — `github` removed from `RouterProvider`,
  `resolveWithGithubModels` and its helpers deleted, auto mode is now OpenAI → Anthropic.
  `ROUTER_LLM_PROVIDER=github` **throws** in `getRouterProvider()`, which sits outside
  the resolver's `try` so keyword fallback cannot swallow it.
- `apps/python/services/ragagent.py` — `github` LLM **and embed** branches removed; auto
  mode now prefers OpenAI. (The embed branch shared the `github_models_token` variable,
  so removing only the LLM branch would have been a `NameError`.)
- `apps/python/langchain.py` — same removal for the extraction LLM.
- `apps/python/scripts/ingest.py` — metadata pass moved from GitHub Models to OpenAI
  (`OPENAI_API_KEY`); `gpt-4o-mini` unchanged.

**Why removed rather than aliased to OpenAI:** a silent alias would re-point routing at a
different vendor's billing with no signal. A loud failure at boot is the cheaper mistake.

### Auto-mode preference was the real landmine
Both Python entry points ranked `github` **above** `openai` in `auto` mode. Any
environment without an explicit `RAG_LLM_PROVIDER` would have selected a retired
provider. Now OpenAI first.

### Docs
- `.claude/rules/guardrails.md` — "github is the acceptable free-tier alternative"
  replaced with a never-set rule; added the `EVALAPIKEY`/`OPENAI_API_KEY` fallback warning
- `.claude/rules/agent-service.md` — resolver table, auto-mode priority, new retirement
  section, rewritten `GENERAL_CHAT_API_KEY` rationale
- `CLAUDE.md` — Knowledge Architecture row for `agent-service.md`
- `apps/agent/.env.example`, `apps/python/.env.example`, `.claude/plans/dockerdeploymentplan.md`

---

## Verification

| Check | Result |
|---|---|
| `tsc --noEmit` (agent) | clean |
| `npm run eval:offline` (agent) | 17/17 pass |
| `uv run pytest -q` (python) | 1168 pass |
| Router probe, live | `invoice_extraction` 0.9 / `transport_form_extraction` 0.95 |
| `POST /documents/extract` end-to-end | 200, all fields extracted |

---

## Open items

1. **`CLAUDE.md` says "one documented exception" to the Claude-only rule.** There are
   effectively two non-Claude call sites: `generalChatChain.ts` *and* the router. This
   predates the migration (the router ran GitHub Models `gpt-4o`, never Claude), but the
   wording is now clearly wrong. Needs a decision on framing.
2. ~~Routing eval now runs on `gpt-4o`.~~ **Resolved.** `evalEnv.ts` now pins its own
   model via `EVAL_ROUTER_LLM_MODEL` (default `gpt-4o-mini`) and no longer inherits
   `ROUTER_LLM_MODEL` from `.env`. Production routes on `gpt-4o`; the eval stays cheap.
   Verified: `provider=openai, model=gpt-4o-mini, using EVALAPIKEY=true`.
3. ~~`/agent/resolve-and-run` flattens every failure into a 400.~~ **Resolved.** Added
   `src/lib/errors.ts` → `UpstreamUnavailableError`, thrown by `llmResolver` (all
   resolver failures) and `callPythonExtraction` (transport failure or Python 5xx).
   `server.ts` maps it and `GeneralChatUnavailableError` to 503 via `sendChainError`,
   applied to `/agent/resolve-and-run` and both waste-law chat routes. Python 4xx stays
   400 — that one *is* about the input. Contract documented in `agent-service.md` →
   "Error Status Contract". Verified: stale `github` provider → 503, missing credential
   → 503, plain `Error` → 400.
