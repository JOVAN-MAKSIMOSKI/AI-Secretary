# RAG — Subsection Chunking + General/Special Law Separation

Status: **proposed, awaiting approval** (2026-10-17). Nothing implemented yet.

## Problem

1. Articles over `LONG_ARTICLE_CHAR_THRESHOLD` (1200 chars) are sub-split by
   `SentenceSplitter` purely on size. It ignores the "(1)", "(2)" став structure, so a
   cut can land mid-став and a став can straddle two parts.
2. Retrieval treats each sub-chunk as an independent hit. The LLM receives a fragment
   labelled only "Член N" — no part number, no siblings — and two parts of the same
   article each consume one of the 10 top_k slots.
3. The corpus mixes the general Law on Waste Management with special-stream laws (e.g.
   waste oils, tires/rubber). Nothing in the payload or the prompt distinguishes them,
   so the LLM cannot apply lex specialis (special law prevails on its topic, general law
   fills the gaps).

## Part A — Subsection (став) chunking

Ingest (`apps/python/scripts/ingest.py`):

- Article ≤ 1200 chars: unchanged, one chunk.
- Article > 1200 chars: split at став markers — a line starting with `(N)`.
  Verify the exact marker format against the real corpus first (dump a few long
  articles); some gazettes may use `1.` or `а)` for points inside a став.
- Greedy packing: merge consecutive ставови into one chunk until the next would push it
  over the threshold. Avoids tiny one-sentence chunks that embed poorly.
- A single став still over the threshold (long lists of точки) falls back to
  `SentenceSplitter` inside that став only.
- **Size floor** (`MIN_CHUNK_CHARS`, starting value ~200, tuned by the retrieval eval).
  Tiny chunks such as "(4) Министерот го пропишува образецот." carry too little meaning
  to embed well and can win searches by accident.
  - Inside a split article: a chunk below the floor (typically a short trailing став)
    merges into its neighbour — backward first, forward if backward would exceed the
    e5 512-token hard limit.
  - Whole short articles: do **not** merge across articles — one chunk spanning two
    Члена breaks citation integrity. Rely on the contextual header (law + article
    title) to give them enough meaning instead. Revisit only if the eval shows short
    articles ranking badly.
- No markers found: fall back to today's `SentenceSplitter` behaviour.
- Contextual header: prefix each sub-chunk's embedded text with
  `Член N — <article title line>` so a став like "(3) Во случајот од ставот 1…"
  still embeds with its article's subject.
- New payload fields: `paragraphs: [2, 3]` (ставови covered) and
  `article_full_text` (only on split articles — enables Part B without extra queries).

Point ids keep the existing key shape (`source_file|article|part|text_hash`). Part
numbering changes, so ids change for split articles; `_prune_superseded` already
removes the stale parts of re-ingested files. `POINT_ID_NAMESPACE` is untouched.

## Part B — Retrieval: small-to-big

`apps/python/services/ragagent.py` `_retrieve_context`:

- Search on sub-chunks (precise match), then group hits by `(source_file, article)`.
- One entry per article in the prompt: if any part of a split article was hit, send
  `article_full_text` once instead of the fragment(s). Frees the duplicate top_k slots.
- Cap per-article context length (named constant) so one huge article cannot crowd
  out the rest.
- Passage header gains `став N` when only part of an article is sent, and `valid_from`.

## Part C — General vs special law separation

Recommended approach: **deterministic payload tags + prompt-level precedence**, one
collection, no hard filter.

- Ingest tags every chunk per source file (CLI flag / filename map, not the LLM):
  `scope: "general" | "special"`, `stream: "oils" | "tires" | ... | null`.
- Create a Qdrant payload index on `scope` and `stream`.
- Passage headers show `[Посебен закон: <stream>]` / `[Општ закон]`.
- `LEGAL_ADVISOR_PROMPT` gains a lex specialis rule: on its own topic the special law
  prevails; the general law applies where the special law is silent.
- Optional, after measuring: when the tenant profile has `oils_tires`, run a second
  filtered search on `stream` and merge (quota), so the special law is never crowded
  out. Soft boost only — never a hard filter (see waste-law-rag-advisor.md note on why
  hard profile filters were removed).

Rejected alternatives:
- **Separate collections** — cross-law questions (a tire question that needs general
  permit/penalty rules) would need two searches and a merge anyway; doubles ops.
- **Vector clustering (k-means etc.)** — the label (which law) is already known.
  Clustering groups by topic, not by law: a penalty article in the tire law lands next
  to penalty articles in the general law, which is the opposite of the goal.

## Verification

0. **Pilot on a small subset first — gate before any full re-ingest.** Requested by
   the user: prove that variable chunk sizes cause no confusion or mismatch before
   touching the real corpus.
   - Pick 1–2 laws that contain both long multi-став articles and very short
     articles/ставови (exercises packing, the floor, and the fallback splitter).
   - Start dev Qdrant first (`docker compose -f docker-compose.dev.yml up -d`).
   - Ingest them into a **separate pilot collection** (e.g.
     `waste_management_law_mk_v2_pilot`), never the live collection.
   - Check, per chunk: `article` and `paragraphs` match the text it holds; no став is
     cut mid-way; no chunk spans two Члена; nothing is below the floor or above the
     ceiling except documented fallbacks.
   - Check reassembly: concatenating an article's parts in order reproduces the
     original article text exactly (small-to-big depends on this).
   - Run a handful of questions against the pilot with old vs new chunking on the same
     files and compare which articles come back, and with what scores — confirm short
     and long chunks don't distort ranking.
   - Only proceed to step 1 once the pilot is clean.
1. Start dev Qdrant (`docker compose -f docker-compose.dev.yml up -d`); snapshot.
2. Baseline: `uv run pytest evals/ -q` (retrieval floor in `evals/baseline.json`).
3. Re-ingest, re-run the eval; floor must hold.
4. Add golden cases in `evals/golden/retrieval.jsonl` for the oils/tires law, authored
   against measured output.
5. `uv run pytest -q` — add pure-function tests for the став splitter (marker
   detection, greedy packing, fallback).

## Pending review topics (walk through with the user before closing this plan)

Requested by the user on 2026-10-17. Not yet discussed — both must be covered before
implementation is considered complete.

1. **Optimisation** — latency and cost of the RAG path: query-embedding cost of
   e5-large on CPU (Hetzner, no GPU), model warmup and RAM, top_k size vs prompt
   tokens, relevance score cutoff, prompt caching eligibility (static prefix is below
   OpenAI's 1024-token minimum), LLM model choice for answers.
2. **Evaluation** — added 2026-10-18. Current retrieval eval is too coarse to judge
   this plan: 9 cases, law-level only (`expect_law`), no oils/tires cases, no answer/
   generation eval. Discuss: article-level expectations (`expect_article`), new cases
   for the special laws and short/long articles (reuse as the pilot question set), a
   baseline on current chunking before any change, and an LLM-as-judge answer eval
   (citation correctness, faithfulness) via the `agent-evals` skill.
   - **Fixed 2026-11-02** (code only, nothing re-measured):
     - Retrieval eval built its own e5 model without the `query: ` prefix (LlamaIndex
       auto-prefixes only BGE/Instructor). Both service and eval now use
       `services.ragagent.build_embed_model()`.
     - `evals/baseline.json` `topK` 6 -> 10 to match production; old measurement
       flagged invalid in `_comment_pending_remeasure`.
     - CI Gate C runs `pytest evals/ -q -rs` so a skipped retrieval eval prints its
       reason instead of a silent "s".
   - First "before" score (old 9-case eval, 2026-11-02): recall@10 9/9, MRR 0.861.
     Superseded the same day — the user judged it not meaningful (titles parroted in
     the questions, law level only), so the eval was hardened first:
     `.claude/plans/retrieval-eval-hardening.md`.
   - **"Before" score, eval v2, measured 2026-11-02** (current chunking, 4585 points,
     71 in-domain cases, 62 article-level, top_k 10): doc recall 1.000, **article recall
     0.919**, doc MRR 0.864, **article MRR 0.695**. Floors in `evals/baseline.json`. The
     re-chunk is judged on article recall and article MRR; doc recall is saturated.
   - **Corpus defects found while authoring** — fix at re-ingest, re-measure after:
     - National waste plan ingested twice (`-p5ew`, `-yZFe`, 635 chunks each): the
       duplicates take two top-k slots for the same passage (seen in
       `gen-landfill-classes`).
     - Wrong `law` labels: `-rrxD` (2023 permit-requirements rulebook) and `-4Bsu`
       (exam rulebook) are labelled "Закон за управување со отпадот 216/21"; six files
       carry their filename as the label (`-jPA4`, `-tOl9`, `-2pyR`, `-UZLe`, `-M7Oe`,
       `-pXJE`). Wrong labels reach the prompt's passage headers, so the LLM cites the
       wrong law.
     - `-rrxD` Член 13 is one 50k-char "article" (87 parts) holding annexes and an
       Albanian-language copy; Albanian chunks rank for English questions.
       **Decision (2026-11-03): drop the Albanian-language text at re-chunk** — it is a
       parallel copy of the Macedonian text, adds nothing the corpus does not already
       hold, and only competes for top-k slots. Detect it at extraction (Latin-script
       share of the part), log what was dropped per file, and check no other source
       carries a bilingual copy before relying on the filter.
     - `-4Bsu` is OCR-garbled ("гоучен испит", "сктоѓавриска"): `rb-exam-fee` and
       `rb-exam-sessions` miss their article because of it.
     - Heading-only chunks ("VIII. ДОЗВОЛИ ЗА ВРШЕЊЕ НА ДЕЈНОСТ…") rank 1–2 for
       `en-landfill-liquid`: a section heading is glued to the previous article as its
       own part. The size floor (Part A) should absorb these.
     - Tiny articles never rank: `rb-beside-bins` expects a 95-char article (NrsO Член
       13). The contextual header (Part A) is the planned fix.
     - Strategy and plan documents (`-ClFB`, `-p5ew`, `-yZFe`) have no `Член` structure
       (one "article", 560–635 parts) and crowd out actual law articles.
     - `mac209532` has no Член 60 in the collection (parse miss).
   - **Retrieval score cannot gate off-topic questions**: off-topic top scores
     0.743–0.836 vs 0.776 for the weakest correct rank-1 hit. A plain cutoff on e5
     cosine would cut real answers. Input to the optimisation discussion.
   - **Still open** (blocked on re-chunk/re-embed or on discussion):
     - Re-measure the retrieval baseline on the new corpus.
     - Retrieval eval still never runs in CI: needs hosted Qdrant (`QDRANT_URL`
       secret) + a cached e5 model. Infra decision, not a code fix.
     - ~~Grow the golden set and add `expect_article`~~ — done 2026-11-02 (eval v2).
       LLM-as-judge for answers: excluded by the user for now.
     - **Golden-set policy** (agreed 2026-11-02): keep the core set fixed, only append.
       Edit or delete a case only when it is wrong or the law itself changed (amended or
       repealed), as its own reviewable commit. Turn every real bad answer into a new
       case. Keep a ~20% held-out set that is never looked at while tuning chunking or
       prompts, only run to confirm a change.
     - **No law-type separation today** (verified 2026-11-02): retrieval ignores the
       tenant profile and has no Qdrant filter; the profile reaches only the LLM prompt
       (`<<<PROFILE>>>`). No payload field distinguishes the general law from the
       oils/tires law, and `_retrieve_context` drops the `waste_types` payload. A tire
       company's general question can fill all 10 slots with general-law articles. Fixed
       by Part C; add a golden category of tire-profile questions that must return the
       tire law in the top 10.
     - **Plan the context window properly at re-chunk** (agreed 2026-11-03). Today the
       chunker caps every part at ≤1415 chars (median 628), so `top_k=10` is itself the
       context budget (~10×1.4k chars max) and a separate per-passage cap or total
       budget would add nothing — that proposal was dropped. Once the re-chunk sends
       whole articles or contextual headers to the prompt (small-to-big, Part A), part
       size stops bounding the prompt: decide top_k, per-passage cap and a total
       character/token budget together, as one design, and measure them with both evals.
       Also align `/rag/query`'s default `top_k=5` (`routers/rag.py`) with whatever the
       agent sends (`WASTE_LAW_TOP_K = 10`) — the evals only measure the latter.
     - **ONNX Runtime for query embedding: rejected** (2026-11-03). One short question
       per request on CPU; not worth a second inference path.
3. ~~**Generation**~~ — **reviewed with the user 2026-10-18** (how it works end to end,
   down to LLM internals). The weak spots below remain as implementation backlog items,
   not a pending discussion: the weak spots found in `services/ragagent.py`: no relevance
   cutoff (all 10 passages always sent), rules sent inside one user string instead of a
   system message, prompt names only Law 216/2021 (no lex specialis), sub-chunk
   fragments/duplicates in context, no `valid_from` in passage headers, and the dormant
   Anthropic branch that breaches the "never call Claude from apps/python" rule.
   **Manual answer review, 2026-11-02** (Claude, fixed rubric written before generation,
   20 dev cases sampled every 3rd + 2 off-topic, gpt-4o-mini, top_k 10): 9/20 in-domain
   PASS, but the core answer was correct in 17/20. Failures are mostly in the padding:
   7 answers cite a Член that was never retrieved, almost always inside the
   "Конкретни чекори" section the prompt demands; obligations for permit holders are
   applied to waste generators; article numbers from different laws are cited without
   the law; English question answered in Macedonian (1/1); Russian "Обратите внимание"
   leaks (2/20); one off-topic question answered with misused law instead of a refusal.
   Prompt changes, system message, valid_from headers, pinned temperature, Anthropic
   branch removal and a deterministic answer eval: **done 2026-11-02**, see
   `rag-generation-hardening.md` (old 10/20 -> new 17-18/20 PASS). Still open from this
   backlog: relevance cutoff (blocked: score cannot separate off-topic), lex specialis
   via scope/stream tags (needs re-ingest).
   Sampling params: `OpenAI(...)` in `_configure_llama_index_settings` sets neither
   `temperature` nor `top_p`, so it runs on LlamaIndex's implicit `temperature=0.1` and
   OpenAI's default `top_p=1.0`. Decide whether to pin temperature explicitly as a named
   constant (tune temperature or top_p, not both).

## Open questions

- Exact став marker format in the ingested PDFs.
- Which source files are the oils/tires law and the general law (filenames).
