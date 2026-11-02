"""Offline guards for the waste-law retrieval eval (Gate A).

The paid eval in evals/test_retrieval.py only runs where a Qdrant collection exists, so
in CI it skips. These checks run on every push instead: the golden file must parse and
keep its coverage, and the scoring maths must be right — a broken golden file or a
scoring bug would otherwise surface only the next time someone runs the eval by hand.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from evals.retrieval_scoring import (
    OFF_TOPIC_CATEGORY,
    is_article_case,
    load_golden_cases,
    parse_golden_lines,
    score_case,
    summarize,
)

GOLDEN_FILE = Path(__file__).resolve().parent.parent / "evals" / "golden" / "retrieval.jsonl"

# Coverage the set must keep. Lowering any of these shrinks what the eval can see and
# should be its own reviewable change, like lowering a baseline floor.
MIN_CASES_PER_CATEGORY = 5
MIN_IN_DOMAIN_CASES = 60
MIN_ARTICLE_CASE_SHARE = 0.75
MIN_HOLDOUT_SHARE = 0.12
MIN_ENGLISH_CASES = 5
MIN_OFF_TOPIC_CASES = 3

ARTICLE_CASE = (
    '{"id": "a", "question": "q", "category": "general_law", "split": "dev", '
    '"expect": [{"source": "-m9RJ", "law": "L", "articles": ["52"]}, '
    '{"source": "-aroR", "law": "R", "articles": ["3"]}]}'
)
DOC_ONLY_CASE = (
    '{"id": "d", "question": "q", "category": "rulebook", "split": "holdout", '
    '"expect": [{"source": "-m9RJ", "law": "L", "articles": ["52"]}, {"source": "-aroR", "law": "R"}]}'
)
OFF_TOPIC_CASE = '{"id": "o", "question": "q", "category": "off_topic", "split": "dev", "expect": "none"}'


def _chunk(source_file: str, article: str | None, score: float = 0.8) -> dict:
    return {"text": "t", "law": "x", "article": article, "source_file": source_file, "score": score}


def _case(line: str) -> dict:
    return parse_golden_lines([line], "inline")[0]


# --- the real golden file ---------------------------------------------------------


@pytest.fixture(scope="module")
def golden_cases() -> list[dict]:
    return load_golden_cases(GOLDEN_FILE)


def test_golden_file_parses(golden_cases: list[dict]) -> None:
    assert golden_cases


def test_golden_file_keeps_its_coverage(golden_cases: list[dict]) -> None:
    in_domain = [c for c in golden_cases if c["category"] != OFF_TOPIC_CATEGORY]
    assert len(in_domain) >= MIN_IN_DOMAIN_CASES

    categories = {c["category"] for c in in_domain}
    for category in categories:
        count = sum(1 for c in in_domain if c["category"] == category)
        assert count >= MIN_CASES_PER_CATEGORY, f"{category} has only {count} cases"

    article_share = sum(1 for c in in_domain if is_article_case(c)) / len(in_domain)
    assert article_share >= MIN_ARTICLE_CASE_SHARE

    holdout_share = sum(1 for c in in_domain if c["split"] == "holdout") / len(in_domain)
    assert holdout_share >= MIN_HOLDOUT_SHARE

    assert sum(1 for c in in_domain if "en" in c.get("tags", [])) >= MIN_ENGLISH_CASES
    assert sum(1 for c in golden_cases if c["category"] == OFF_TOPIC_CATEGORY) >= MIN_OFF_TOPIC_CASES


def test_every_category_has_holdout_cases(golden_cases: list[dict]) -> None:
    # A category with no held-out case can be tuned to its dev cases with nothing left
    # to catch the overfit.
    in_domain = [c for c in golden_cases if c["category"] != OFF_TOPIC_CATEGORY]
    for category in {c["category"] for c in in_domain}:
        assert any(c["category"] == category and c["split"] == "holdout" for c in in_domain), category


def test_question_text_is_unique(golden_cases: list[dict]) -> None:
    questions = [c["question"].strip().lower() for c in golden_cases]
    assert len(questions) == len(set(questions))


# --- validation -----------------------------------------------------------------


@pytest.mark.parametrize(
    "line, message",
    [
        ('{"id": "x", "question": "q", "category": "nope", "split": "dev", "expect": "none"}', "unknown category"),
        ('{"id": "x", "question": "q", "category": "rulebook", "split": "train", "expect": []}', "unknown split"),
        ('{"id": "x", "question": "q", "category": "rulebook", "split": "dev", "expect": "none"}', "only valid for off_topic"),
        ('{"id": "x", "question": "q", "category": "off_topic", "split": "dev", "expect": []}', "off_topic cases must"),
        ('{"id": "x", "question": "q", "category": "rulebook", "split": "dev", "expect": []}', "non-empty list"),
        ('{"id": "x", "question": "q", "category": "rulebook", "split": "dev", "expect": [{"source": "s"}]}', '"law"'),
        (
            '{"id": "x", "question": "q", "category": "rulebook", "split": "dev", '
            '"expect": [{"source": "s", "law": "l", "articles": ["Член 5"]}]}',
            "numeric strings",
        ),
        (
            '{"id": "x", "question": "q", "category": "rulebook", "split": "dev", "tags": ["typo"], '
            '"expect": [{"source": "s", "law": "l"}]}',
            "unknown tags",
        ),
        ("not json", "not valid JSON"),
    ],
)
def test_invalid_cases_are_rejected(line: str, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        parse_golden_lines([line], "inline")


def test_duplicate_ids_are_rejected() -> None:
    with pytest.raises(ValueError, match="duplicate case id"):
        parse_golden_lines([OFF_TOPIC_CASE, OFF_TOPIC_CASE], "inline")


def test_comments_and_blank_lines_are_skipped() -> None:
    assert len(parse_golden_lines(["// comment", "", OFF_TOPIC_CASE], "inline")) == 1


# --- scoring ----------------------------------------------------------------------


def test_article_case_requires_articles_on_every_source() -> None:
    assert is_article_case(_case(ARTICLE_CASE))
    assert not is_article_case(_case(DOC_ONLY_CASE))
    assert not is_article_case(_case(OFF_TOPIC_CASE))


def test_doc_and_article_ranks_are_scored_separately() -> None:
    chunks = [
        _chunk("other.pdf", "52"),            # right article number, wrong source
        _chunk("law-file-m9RJ (1).pdf", "7"),  # right source, wrong article
        _chunk("law-file-m9RJ (1).pdf", "52"),
    ]
    result = score_case(_case(ARTICLE_CASE), chunks)
    assert result.doc_rank == 2
    assert result.article_rank == 3


def test_any_acceptable_source_counts() -> None:
    result = score_case(_case(ARTICLE_CASE), [_chunk("x.pdf", "1"), _chunk("rb-file-aroR.pdf", "3")])
    assert result.doc_rank == 2
    assert result.article_rank == 2


def test_source_match_is_case_insensitive() -> None:
    result = score_case(_case(ARTICLE_CASE), [_chunk("LAW-FILE-M9RJ.PDF", "52")])
    assert result.doc_rank == 1


def test_misses_score_none() -> None:
    result = score_case(_case(ARTICLE_CASE), [_chunk("x.pdf", "52")])
    assert result.doc_rank is None
    assert result.article_rank is None


def test_missing_article_payload_never_matches() -> None:
    result = score_case(_case(ARTICLE_CASE), [_chunk("law-file-m9RJ.pdf", None)])
    assert result.doc_rank == 1
    assert result.article_rank is None


def test_summary_metrics() -> None:
    article = _case(ARTICLE_CASE)
    doc_only = _case(DOC_ONLY_CASE)
    off_topic = _case(OFF_TOPIC_CASE)
    results = [
        score_case(article, [_chunk("x.pdf", "1"), _chunk("law-file-m9RJ.pdf", "52")]),  # doc@2, art@2
        score_case(doc_only, [_chunk("x.pdf", "1")]),                           # doc miss
        score_case(off_topic, [_chunk("x.pdf", "1", score=0.9)]),
    ]
    summary = summarize(results)

    assert summary["cases"] == 2  # off-topic excluded
    assert summary["articleCases"] == 1
    assert summary["docRecall"] == pytest.approx(0.5)
    assert summary["docMrr"] == pytest.approx(0.25)  # (1/2 + 0) / 2
    assert summary["articleRecall"] == pytest.approx(1.0)
    assert summary["articleMrr"] == pytest.approx(0.5)
    assert summary["perCategory"]["general_law"]["docRecall"] == pytest.approx(1.0)
    assert summary["perCategory"]["rulebook"]["docRecall"] == pytest.approx(0.0)
    assert summary["perSplit"]["holdout"]["cases"] == 1
    assert OFF_TOPIC_CATEGORY not in summary["perCategory"]


def test_off_topic_case_records_top_score() -> None:
    result = score_case(_case(OFF_TOPIC_CASE), [_chunk("x.pdf", "1", score=0.81)])
    assert result.top_score == pytest.approx(0.81)
    assert result.doc_rank is None
