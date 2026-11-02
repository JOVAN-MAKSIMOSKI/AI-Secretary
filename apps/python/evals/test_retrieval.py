"""Waste-law retrieval eval — does the right law, and the right article, come back.

Deliberately kept out of `tests/` so `pytest -q` (the fast Gate A half) stays fast.
Run explicitly:

    uv run pytest evals/test_retrieval.py -q -s

Self-skips unless the Qdrant collection is reachable, so CI degrades to a skip rather
than a failure. It cannot run in CI today: `qdrant_data/` is gitignored and the
multilingual-e5-large weights are ~2GB. Set REQUIRE_RETRIEVAL_EVAL=1 to turn the skip
into a failure — for any environment that is supposed to have the collection, so a
missing one cannot pass as green.

Golden schema and scoring live in evals/retrieval_scoring.py (pure, unit-tested by
tests/test_retrieval_golden.py). Four aggregate floors from evals/baseline.json, plus a
per-category floor so a weak category cannot hide behind a strong average:
  - docRecallAtK     — an acceptable source is anywhere in the top k
  - articleRecallAtK — an acceptable source's expected article is in the top k
  - docMrr / articleMrr — mean reciprocal rank (1 at rank 1, 0.5 at rank 2, 0 on a
    miss): catches a case sliding from rank 1 to rank 9, which recall cannot see
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from dotenv import load_dotenv

from evals.retrieval_scoring import (
    format_case_line,
    is_off_topic,
    load_golden_cases,
    off_topic_report,
    score_case,
    summarize,
)

load_dotenv()

EVALS_DIR = Path(__file__).resolve().parent
GOLDEN_FILE = EVALS_DIR / "golden" / "retrieval.jsonl"
BASELINE_FILE = EVALS_DIR / "baseline.json"
DEFAULT_COLLECTION = "waste_management_law_mk_v2"
REQUIRE_FLAG = "REQUIRE_RETRIEVAL_EVAL"
BASELINE_NUMERIC_KEYS = (
    "topK",
    "docRecallAtK",
    "articleRecallAtK",
    "docMrr",
    "articleMrr",
    "minCategoryDocRecall",
)


def load_baseline() -> dict[str, Any]:
    baseline = json.loads(BASELINE_FILE.read_text(encoding="utf-8"))
    for key in BASELINE_NUMERIC_KEYS:
        if not isinstance(baseline.get(key), (int, float)):
            raise ValueError(f"{BASELINE_FILE.name} must define numeric {key}")
    return baseline


def build_qdrant_client() -> Any:
    """Returns a client only if the target collection actually exists, else None.

    Checked before the embedding model is touched — loading ~2GB of weights just to
    discover there is nothing to query would make the skip path cost 40 seconds.
    """
    try:
        from qdrant_client import QdrantClient
    except ModuleNotFoundError:
        return None

    collection = os.getenv("QDRANT_COLLECTION") or DEFAULT_COLLECTION
    qdrant_url = os.getenv("QDRANT_URL", "").strip()

    try:
        if qdrant_url:
            client = QdrantClient(url=qdrant_url, api_key=os.getenv("QDRANT_API_KEY") or None)
        else:
            from services.ragagent import _DEFAULT_LOCAL_QDRANT_PATH

            local_path = Path(os.getenv("QDRANT_LOCAL_PATH") or str(_DEFAULT_LOCAL_QDRANT_PATH)).resolve()
            if not local_path.exists():
                return None
            client = QdrantClient(path=str(local_path))

        if not client.collection_exists(collection):
            client.close()
            return None
        return client
    except Exception:
        return None


@pytest.fixture(scope="session")
def retrieval_engine():
    client = build_qdrant_client()
    if client is None:
        message = "Qdrant collection unreachable — retrieval eval skipped, offline guards still enforced."
        if os.getenv(REQUIRE_FLAG, "").strip() == "1":
            pytest.fail(f"{message} {REQUIRE_FLAG}=1 requires it.")
        pytest.skip(message)

    from llama_index.core import Settings

    from services.ragagent import DirectQdrantQueryEngine, build_embed_model

    # The service's own builder, not a local HuggingFaceEmbedding: a hand-built copy
    # here once dropped e5's "query: " prefix, so the eval scored a retrieval config
    # production never ran.
    Settings.embed_model = build_embed_model()

    baseline = load_baseline()
    engine = DirectQdrantQueryEngine(
        client,
        os.getenv("QDRANT_COLLECTION") or DEFAULT_COLLECTION,
        int(baseline["topK"]),
    )

    yield engine
    client.close()


def _format_summary(summary: dict[str, Any], baseline: dict[str, Any]) -> list[str]:
    k = baseline["topK"]
    lines = [
        f"cases={summary['cases']} (article-level {summary['articleCases']}), top_k={k}",
        f"doc recall@{k}     = {summary['docRecall']:.3f} (floor {baseline['docRecallAtK']})",
        f"article recall@{k} = {summary['articleRecall']:.3f} (floor {baseline['articleRecallAtK']})",
        f"doc MRR           = {summary['docMrr']:.3f} (floor {baseline['docMrr']})",
        f"article MRR       = {summary['articleMrr']:.3f} (floor {baseline['articleMrr']})",
    ]
    for category, stats in summary["perCategory"].items():
        lines.append(
            f"  {category:16} n={stats['cases']:<3} doc recall {stats['docRecall']:.3f}  doc MRR {stats['docMrr']:.3f}"
        )
    for split, stats in summary["perSplit"].items():
        lines.append(
            f"  split {split:10} n={stats['cases']:<3} doc recall {stats['docRecall']:.3f}  doc MRR {stats['docMrr']:.3f}"
        )
    return lines


def test_retrieval_meets_baseline(retrieval_engine) -> None:
    baseline = load_baseline()
    cases = load_golden_cases(GOLDEN_FILE)

    results = [score_case(case, retrieval_engine._retrieve_context(case["question"])) for case in cases]
    summary = summarize(results)

    report = [
        *_format_summary(summary, baseline),
        "",
        *(
            format_case_line(result, case)
            for result, case in zip(results, cases)
            if not is_off_topic(case)
        ),
        "",
        *off_topic_report(results),
    ]
    full_report = "\n".join(report)

    failures = []
    for metric, floor_key in (
        ("docRecall", "docRecallAtK"),
        ("articleRecall", "articleRecallAtK"),
        ("docMrr", "docMrr"),
        ("articleMrr", "articleMrr"),
    ):
        if summary[metric] < baseline[floor_key]:
            failures.append(f"{metric} {summary[metric]:.3f} < floor {baseline[floor_key]}")
    for category, stats in summary["perCategory"].items():
        if stats["docRecall"] < baseline["minCategoryDocRecall"]:
            failures.append(
                f"category {category} doc recall {stats['docRecall']:.3f} < floor {baseline['minCategoryDocRecall']}"
            )

    assert not failures, "\n".join([*failures, "", full_report])
    print("\n" + full_report)
