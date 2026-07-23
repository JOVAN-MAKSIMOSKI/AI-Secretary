"""Waste-law retrieval eval — does the right law come back for a real question.

Deliberately kept out of `tests/` so `pytest -q` (the fast Gate A half) stays at ~2s.
Run explicitly:

    uv run pytest evals/ -q

Self-skips unless the Qdrant collection is reachable, so CI degrades to a skip rather
than a failure. It cannot run in CI today: `qdrant_data/` is gitignored and the
multilingual-e5-large weights are ~2GB. It becomes CI-runnable the day a hosted Qdrant
(QDRANT_URL) plus a cached model exist.

Scored as recall@k in aggregate against evals/baseline.json — a single ranking wobble
should not fail a build, two should.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from dotenv import load_dotenv

load_dotenv()

EVALS_DIR = Path(__file__).resolve().parent
GOLDEN_FILE = EVALS_DIR / "golden" / "retrieval.jsonl"
BASELINE_FILE = EVALS_DIR / "baseline.json"
COMMENT_PREFIX = "//"
DEFAULT_COLLECTION = "waste_management_law_mk_v2"
DEFAULT_EMBED_MODEL = "intfloat/multilingual-e5-large"


def load_golden_cases() -> list[dict[str, str]]:
    cases: list[dict[str, str]] = []
    seen: set[str] = set()

    for line_number, raw in enumerate(GOLDEN_FILE.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith(COMMENT_PREFIX):
            continue

        where = f"{GOLDEN_FILE.name}:{line_number}"
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{where}: not valid JSON") from exc

        for key in ("id", "question", "expect_law"):
            if not isinstance(parsed.get(key), str) or not parsed[key].strip():
                raise ValueError(f'{where}: "{key}" must be a non-empty string')

        if parsed["id"] in seen:
            raise ValueError(f'{where}: duplicate case id "{parsed["id"]}"')
        seen.add(parsed["id"])
        cases.append(parsed)

    if not cases:
        raise ValueError(f"{GOLDEN_FILE.name} contains no cases")
    return cases


def load_baseline() -> dict[str, Any]:
    baseline = json.loads(BASELINE_FILE.read_text(encoding="utf-8"))
    for key in ("recallAtK", "topK"):
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
        pytest.skip("Qdrant collection unreachable — retrieval eval skipped, offline guards still enforced.")

    from llama_index.core import Settings
    from llama_index.embeddings.huggingface import HuggingFaceEmbedding

    # `or` rather than a getenv default: CI sets these from repository variables, which
    # arrive as empty strings when unset and would otherwise override the default.
    Settings.embed_model = HuggingFaceEmbedding(model_name=os.getenv("RAG_EMBED_MODEL") or DEFAULT_EMBED_MODEL)

    from services.ragagent import DirectQdrantQueryEngine

    baseline = load_baseline()
    engine = DirectQdrantQueryEngine(
        client,
        os.getenv("QDRANT_COLLECTION") or DEFAULT_COLLECTION,
        int(baseline["topK"]),
    )

    yield engine
    client.close()


def test_retrieval_recall_meets_baseline(retrieval_engine) -> None:
    baseline = load_baseline()
    cases = load_golden_cases()

    hits = 0
    report: list[str] = []

    for case in cases:
        chunks = retrieval_engine._retrieve_context(case["question"])
        laws = [str(chunk.get("law") or "") for chunk in chunks]
        rank = next(
            (i + 1 for i, law in enumerate(laws) if case["expect_law"].lower() in law.lower()),
            None,
        )

        if rank is None:
            report.append(f"MISS {case['id']}: expected {case['expect_law']!r}, got {laws[:3]}")
        else:
            hits += 1
            # Rank is reported even on a hit: a case sliding from 1 to 6 is a real
            # quality regression that recall@k alone cannot see.
            report.append(f"hit@{rank} {case['id']}")

    recall = hits / len(cases)
    summary = f"recall@{baseline['topK']} = {hits}/{len(cases)} = {recall:.3f} (floor {baseline['recallAtK']})"

    assert recall >= baseline["recallAtK"], "\n".join([summary, *report])
    print("\n" + "\n".join([summary, *report]))
