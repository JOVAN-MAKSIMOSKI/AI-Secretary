"""Waste-law answer eval — deterministic checks on real generated answers, no LLM judge.

Generates answers for a fixed sample of the retrieval golden set through the service's
own code path (DirectQdrantQueryEngine.answer: same prompt, same retrieval) and gates
the rates from evals/answer_checks.py against evals/answer_baseline.json:

  - unsupportedCitationRate — answers citing an article that was neither retrieved nor
    referenced inside a passage (the review's most common failure)
  - languageMatchRate       — answer language matches the question's
  - foreignMarkerRate       — Russian/Serbian letters or phrases in the answer
  - offTopicCitingRate      — off-topic answers that cite any article

Sample: every SAMPLE_STRIDE-th in-domain dev case plus all off-topic cases — the same
rule as the 2026-11-02 manual review, so numbers stay comparable. Holdout cases are
never generated here.

Costs real LLM calls (~24 short completions on EVAL_RAG_LLM_MODEL). Self-skips without a
reachable Qdrant collection or without EVALAPIKEY. Run explicitly:

    uv run pytest evals/test_answers.py -q -s
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from evals.answer_checks import check_answer, summarize_checks
from evals.eval_env import configure_extraction_eval_env
from evals.retrieval_scoring import OFF_TOPIC_CATEGORY, load_golden_cases

EVALS_DIR = Path(__file__).resolve().parent
GOLDEN_FILE = EVALS_DIR / "golden" / "retrieval.jsonl"
BASELINE_FILE = EVALS_DIR / "answer_baseline.json"
DEFAULT_COLLECTION = "waste_management_law_mk_v2"
SAMPLE_STRIDE = 3
ANSWER_TOP_K = 10  # production value: WASTE_LAW_TOP_K in apps/agent/src/agent/wasteLawChain.ts

# Pinned like the routing eval pins its model: eval_env clears RAG_LLM_MODEL so a stray
# local override cannot change what is measured. Follows the production default
# (RAG_LLM_DEFAULT_MODEL); the manual review and the first baseline were measured on
# gpt-4o-mini, which shuts down 2027-01-14.
EVAL_RAG_LLM_MODEL = "gpt-6-luna"

_SKIP_REASON = configure_extraction_eval_env()


def load_baseline() -> dict[str, Any]:
    baseline = json.loads(BASELINE_FILE.read_text(encoding="utf-8"))
    for key in ("maxUnsupportedCitationRate", "minLanguageMatchRate", "maxForeignMarkerRate", "maxOffTopicCitingRate"):
        if not isinstance(baseline.get(key), (int, float)):
            raise ValueError(f"{BASELINE_FILE.name} must define numeric {key}")
    return baseline


def sample_cases() -> list[dict[str, Any]]:
    cases = load_golden_cases(GOLDEN_FILE)
    dev = [c for c in cases if c["category"] != OFF_TOPIC_CATEGORY and c["split"] == "dev"]
    return dev[::SAMPLE_STRIDE] + [c for c in cases if c["category"] == OFF_TOPIC_CATEGORY]


@pytest.fixture(scope="session")
def answer_engine():
    if _SKIP_REASON:
        pytest.skip(_SKIP_REASON)

    from evals.test_retrieval import build_qdrant_client

    client = build_qdrant_client()
    if client is None:
        pytest.skip("Qdrant collection unreachable — answer eval skipped, offline guards still enforced.")

    os.environ["RAG_LLM_MODEL"] = EVAL_RAG_LLM_MODEL

    from services.ragagent import DirectQdrantQueryEngine, _configure_llama_index_settings

    _configure_llama_index_settings()
    yield DirectQdrantQueryEngine(client, os.getenv("QDRANT_COLLECTION") or DEFAULT_COLLECTION, ANSWER_TOP_K)
    client.close()


def test_answers_meet_baseline(answer_engine) -> None:
    baseline = load_baseline()
    rows = []
    report = []
    for case in sample_cases():
        answer, chunks = answer_engine.answer(case["question"])
        check = check_answer(case, answer, chunks)
        rows.append((case, check))
        flags = []
        if check["unsupported"]:
            flags.append(f"unsupported {check['unsupported']}")
        if not check["language_ok"]:
            flags.append("language")
        if check["foreign"]:
            flags.append(f"foreign {check['foreign']}")
        if case["category"] == OFF_TOPIC_CATEGORY and check["cited"]:
            flags.append(f"off-topic cites {check['cited']}")
        report.append(f"{'FLAG' if flags else 'ok  '} {case['id']}: {'; '.join(flags)}")

    summary = summarize_checks(rows)
    lines = [
        f"answers={summary['answers']}",
        f"unsupportedCitationRate = {summary['unsupportedCitationRate']:.3f} (max {baseline['maxUnsupportedCitationRate']})",
        f"languageMatchRate       = {summary['languageMatchRate']:.3f} (min {baseline['minLanguageMatchRate']})",
        f"foreignMarkerRate       = {summary['foreignMarkerRate']:.3f} (max {baseline['maxForeignMarkerRate']})",
        f"offTopicCitingRate      = {summary['offTopicCitingRate']:.3f} (max {baseline['maxOffTopicCitingRate']})",
        "",
        *report,
    ]
    full_report = "\n".join(lines)

    failures = []
    if summary["unsupportedCitationRate"] > baseline["maxUnsupportedCitationRate"]:
        failures.append("unsupportedCitationRate above max")
    if summary["languageMatchRate"] < baseline["minLanguageMatchRate"]:
        failures.append("languageMatchRate below min")
    if summary["foreignMarkerRate"] > baseline["maxForeignMarkerRate"]:
        failures.append("foreignMarkerRate above max")
    if summary["offTopicCitingRate"] > baseline["maxOffTopicCitingRate"]:
        failures.append("offTopicCitingRate above max")

    assert not failures, "\n".join([*failures, "", full_report])
    print("\n" + full_report)
