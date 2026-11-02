# Move apps/python LLM calls to gpt-6-luna

Status: **implemented 2026-11-03** for RAG answers + extraction, not committed. The
Blocker below was resolved by upgrading, not by options 1-3: `llama-index-llms-openai`
0.8.3 (2026-10-12) lists `gpt-6-luna`. The earlier "latest is 0.7.10" was wrong — the
`llama-index` bundle package (even 0.14.25) caps it at `<0.8`, so the resolver stopped
there. The bundle was removed; every subpackage the code imports (core,
embeddings-huggingface/openai, llms-openai) and `nltk` were already pinned directly.

Implementation notes:
- `ragagent.py`: `RAG_LLM_DEFAULT_MODEL = "gpt-6-luna"`, `RAG_LLM_REASONING_EFFORT =
  "none"`. llama-index forces `temperature=1.0` for every model in its `O1_MODELS`
  list (gpt-6-luna included); `additional_kwargs={"temperature": 0.1}` restores the
  pinned value. Verified in the outgoing kwargs.
- `langchain.py`: same default; `reasoning_effort="none"` sent only for `gpt-6*` so an
  env revert to a non-reasoning model does not 400.
- `.env`, `.env.example`, `EVAL_RAG_LLM_MODEL` → `gpt-6-luna`.

Measured 2026-11-03:
- Answer eval, 2 runs: unsupported citations 0.000, language 1.000, foreign 0,
  off-topic citing 0 — same as gpt-4o-mini. Manual 20-case review not redone yet.
- Extraction eval fails on **both** models today, for the same cases:
  - gpt-6-luna run 1: offer 4/5, transport_form 43/47; run 2: offer 3/5,
    transport_form 47/47; invoice, calendar, identification_form 1.000.
  - gpt-4.1-mini (old default), same day: offer 3/5, transport_form 44/47,
    identification_form 49/50.
  - Shared misses: `ext-off-*.amount` → None (offer amount, both languages),
    `ext-tf-en-full` waste_type/ewc_code/is_hazardous → None. Pre-existing defects or
    flakiness, not a gpt-6-luna regression. Floors untouched; fixing is its own task.

## Why

OpenAI deprecations page (read 2026-11-03): `gpt-4o-mini`, `gpt-4.1-mini` and `gpt-4o`
shut down **January 14, 2027**; listed replacement `gpt-6-luna`. Pricing per 1M tokens:
`gpt-6-luna` $0.10 in / $0.01 cached / $0.50 out vs `gpt-4o-mini` $0.15 / $0.075 / $0.60 —
cheaper on every line.

Also on the same page, outside apps/python:
- `gpt-5-nano` (agent `general_chat`) shuts down **December 11, 2026**.
- `gpt-4o` (agent routing, `llmResolver.ts`) shuts down January 14, 2027.

## Measured (probes 2026-11-03, `EVALAPIKEY`)

- `gpt-6-luna` is a reasoning model, default effort `medium`.
- `temperature=0.1` is rejected with HTTP 400 ("Only the default (1) value is
  supported") **unless `reasoning_effort="none"`**. With `none` it is accepted, and no
  reasoning tokens are billed. So the pinned `RAG_LLM_TEMPERATURE = 0.1` and
  `_EXTRACTION_TEMPERATURE` both require `reasoning_effort="none"`.
- `langchain-openai` 1.3.3 (extraction, `langchain.py`): works with
  `reasoning_effort="none"` + low temperature.
- `llama-index-llms-openai` 0.7.9 (RAG answers, `services/ragagent.py`): fails at the
  first call, `ValueError: Unknown model 'gpt-6-luna'` (model-name table lookup). The
  newest release, 0.7.10, knows `gpt-5.6-luna` but **not** `gpt-6-luna`. It also forwards
  `reasoning_effort` only for models in its own `O1_MODELS` list.

## Blocker — how the RAG answer path reaches gpt-6-luna

`RAG_LLM_MODEL` is shared by RAG answers and extraction, so neither can switch until the
RAG path works.

Options:
1. **Call the `openai` SDK directly for RAG answers** (`answer()` and
   `stream_chat_law_documents`), keeping llama-index only for embeddings. `openai` is
   already a direct dependency. Removes the dependency on llama-index's model tables
   for every future model change. Recommended.
2. Subclass llama-index `OpenAI` to supply the context window ourselves. Depends on
   library internals; breaks on upgrades.
3. Wait for a llama-index release that lists `gpt-6-luna`. No date; the Jan 14 deadline
   still applies.

## Plan once unblocked

- `reasoning_effort="none"` + existing temperatures, for both call sites. Pass
  `reasoning_effort` only when the configured model accepts it, so a revert to a
  non-reasoning model via env does not 400.
- `.env` / `.env.example` / code defaults: `gpt-6-luna` (code default in `ragagent.py`
  and `langchain.py` is still `gpt-4.1-mini` — align both).
- Evals: `EVAL_RAG_LLM_MODEL` in `evals/test_answers.py` and the extraction eval pin
  follow the production model. Re-run the answer eval, extraction eval and the manual
  20-case review against the gpt-4o-mini numbers in `rag-generation-hardening.md`.
  Floors are only raised or lowered as their own reviewable diff.
- `scripts/ingest.py` (`METADATA_LLM_MODEL`) and `scripts/enrich_metadata.py` also pin
  `gpt-4o-mini`: switch them before the re-ingest that comes after Jan 14, 2027 at the
  latest; validate on the pilot collection.

## Rejected

- ONNX Runtime for query embedding (not needed — see `rag-subsection-chunking.md`).
- `gpt-5.6-luna` for RAG: supported by llama-index 0.7.10, but twice the price of
  `gpt-6-luna`.
