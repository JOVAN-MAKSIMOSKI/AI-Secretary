# RAG Generation Hardening (no re-chunk, no re-embed)

Status: **implemented** (2026-11-02), not committed.

Result (same 20 dev cases + off-topic, manual rubric from the first review):
old prompt 10/20 PASS (first review said 9; `pak-fee` was mis-scored — its key claim is
grounded by Член 42 т.16), new prompt 18/20 and 17/20 on two versions/runs — the
difference is within run-to-run noise. Deterministic rates: unsupported citations
0.25 -> 0.00-0.05, language match 0.955 -> 1.0, Russian leaks 0.09 -> 0, off-topic
answers citing law 0.5 -> 0.

Still failing after the change (prompt-level fixes did not hold reliably):
- exceptions and alternatives dropped (`pak-plastic-bags` omits the paid biodegradable
  bag; `weee-citizen-fine` omits the 250 € near-water fine);
- `str-burning-ban` sometimes says no obligation applies although Член 53 is retrieved;
- one invented citation in 3 runs (`str-tyre-recycling`, "Член 5 од Правилник…");
- lex posterior not applied: `str-vehicle-certificate` answers from the 2009 rulebook,
  ignoring Член 34 of the newer law;
- answers became terser; the old verbose form carried more correct detail along with
  its errors. Driven by the manual answer review recorded in
`rag-subsection-chunking.md` (9/20 PASS, core answer right in 17/20; failures mostly in
padding: invented citations, obligations moved to the wrong party, unqualified article
numbers, English answered in Macedonian, Russian leaks, off-topic answered).

## Changes — `apps/python/services/ragagent.py`

1. **System + user messages.** Rules go in a system message, data (profile, history,
   passages, question) in the user message. `build_prompt` becomes `build_messages`;
   `query` uses `Settings.llm.chat`, streaming uses `stream_chat`. Static rules first
   also keep the OpenAI prompt-cache prefix stable.
2. **Prompt rules** (rewrite of `LEGAL_ADVISOR_PROMPT`):
   - Cite every claim as "Член N од <source as named in the passage header>", only
     articles present in passage headers or quoted in passage text.
   - Numbered steps only for actions a passage requires; no generic advice.
   - An obligation applies only to the party the passage names.
   - Lex specialis: special-stream laws prevail on their topic, the general law fills
     gaps; rulebooks detail the laws. Conflicts: say so, prefer the more recent date.
   - Answer in the question's language (English question gets an English answer);
     no Russian or Serbian words.
   - Off-topic: one-sentence refusal, no citations.
   - Lawyer note only for penalties, permits or significant financial exposure.
   - Removes the "deep knowledge of Law 216/2021" line, which invited answers from
     outside the passages.
3. **`valid_from` in passage headers** when the payload has it (already stored; no
   re-ingest).
4. **`RAG_LLM_TEMPERATURE = 0.1`** pinned explicitly — the same value LlamaIndex applied
   implicitly, so no behaviour change, only visibility. `top_p` stays at the default.
5. **Anthropic branch removed** from `_configure_llama_index_settings`: it breached
   "never call Claude from apps/python". `RAG_LLM_PROVIDER=anthropic` now raises.
   The `anthropic` / `llama-index-llms-anthropic` packages stay in `pyproject.toml`
   for now — removing them is a lockfile change, proposed separately.

## Answer eval (deterministic, no LLM judge)

- `evals/answer_checks.py` (pure) + `tests/test_answer_checks.py` (Gate A).
- `evals/test_answers.py` (paid, self-skips without Qdrant or `EVALAPIKEY`): generates
  answers for a fixed sample (every 3rd dev case + off-topic) and gates on
  `evals/answer_baseline.json`: share of answers citing an article that is neither
  retrieved nor quoted in a passage, language match, foreign-script leaks, citations
  in off-topic answers.

## Other

- `scripts/ingest.py` docstring: GitHub Models and `QDRANT_LOCAL_PATH` references are
  stale.

## Not in scope (needs re-chunk/re-ingest or a decision)

Relevance cutoff (measured: score cannot separate off-topic), small-to-big, scope/stream
tags, top_k change, model change, hosted Qdrant for CI.
