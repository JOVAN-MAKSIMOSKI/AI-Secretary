# Retrieval Eval Hardening

Status: **implemented** (2026-11-02), not committed. Measured result and corpus defects:
`rag-subsection-chunking.md` → Pending review topics → Evaluation. Requested by the user before the re-chunk: the
9-case, law-level eval scored 9/9 and could not show any regression or improvement.
No LLM-as-judge (explicitly excluded). No re-chunk, re-embed or re-ingest.

## Changes

1. **Golden schema v2** (`evals/golden/retrieval.jsonl`)
   - `expect`: list of acceptable sources `{source, law, articles?}`. `source` is a
     substring of the `source_file` payload: stable across re-chunks, unlike the
     LLM-generated `law` label, which is also wrong on some files (two rulebooks carry
     the label "Закон за управување со отпадот 216/21").
   - `expect: "none"` marks an off-topic case.
   - `category` (general_law, special_streams, packaging, weee, rulebook, off_topic),
     `split` (dev / holdout), `tags` (legacy, en, colloquial, short_article,
     long_article, multi_source).
   - The 9 original cases are kept with the same meaning, converted to the new schema.
2. **Pure scoring module** (`evals/retrieval_scoring.py`): loader/validator, per-case
   document rank and article rank, aggregate document recall@k, article recall@k,
   document MRR, article MRR, per-category and per-split breakdown, off-topic score
   report.
3. **Gate A coverage** (`tests/test_retrieval_golden.py`): validates the golden file and
   the scoring maths on every push, without Qdrant.
4. **Eval** (`evals/test_retrieval.py`): uses the module; floors for all four metrics
   plus a per-category minimum; `REQUIRE_RETRIEVAL_EVAL=1` turns the skip into a fail.
5. **Service** (`services/ragagent.py`): `_retrieve_context` also returns `source_file`
   and `score`. Neither reaches the prompt (the passage header reads only law and
   article). The score is needed for the off-topic report and the later relevance-cutoff
   decision.
6. **Baseline** re-measured on the current corpus; floors set from measured numbers.
7. Rule doc `.claude/rules/python-service.md` updated to the new schema.

## Out of scope

- Off-topic cases are reported, not gated: retrieval has no relevance cutoff, so every
  question returns 10 passages. The gate arrives with the cutoff (optimisation topic).
- Corpus defects found while authoring are recorded for the re-ingest, not fixed here.
