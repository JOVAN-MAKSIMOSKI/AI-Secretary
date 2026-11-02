"""Offline guards for the deterministic answer checks (evals/answer_checks.py).

The answer eval needs Qdrant and a paid LLM, so it skips in CI; the checks it applies
are pure and are verified here on every push.
"""

from __future__ import annotations

import pytest

from evals.answer_checks import (
    check_answer,
    cited_articles,
    foreign_markers,
    language_matches,
    summarize_checks,
    unsupported_citations,
)

CHUNKS = [
    {"text": "Член 16 Лицата … согласно член 32 од Законот за управување со отпадот …", "article": "16"},
    {"text": "Член 8 Забрани Се забранува горење на отпадни гуми …", "article": "8"},
    {"text": "(1) продолжение без број на член", "article": None},
]


def test_cited_articles_reads_every_form() -> None:
    answer = "Член 8, според членот 16, членовите 51, 52 и чл. 9; see Article 12."
    assert cited_articles(answer) == ["8", "9", "12", "16", "51"]


def test_cited_articles_ignores_numbers_without_keyword() -> None:
    assert cited_articles("Глоба од 200 евра, 100 литри, став (3).") == []


def test_unsupported_citation_detected() -> None:
    # The review's most common failure: "Член 48 став (5)" when Член 48 was never retrieved.
    assert unsupported_citations("согласно Член 48 став (5)", CHUNKS) == ["48"]


def test_retrieved_article_is_supported() -> None:
    assert unsupported_citations("Според Член 8 од Законот …", CHUNKS) == []


def test_article_referenced_inside_a_passage_is_supported() -> None:
    # Член 32 was not retrieved, but the Член 16 passage itself cites it.
    assert unsupported_citations("дозвола согласно Член 32", CHUNKS) == []


@pytest.mark.parametrize(
    "question, answer, expected",
    [
        ("Дали смеам да ги изгорам гумите?", "Не, според Член 8 тоа е забрането.", True),
        ("Can shops give free plastic bags?", "No. Article 10 bans plastic carrier bags.", True),
        ("Can shops give free plastic bags?", "Според Член 10, пластичните кеси се забранети.", False),
        ("Дали смеам да ги изгорам гумите?", "No, Article 8 forbids it.", False),
        ("Дали смеам?", "", False),
    ],
)
def test_language_matches(question: str, answer: str, expected: bool) -> None:
    assert language_matches(question, answer) is expected


def test_foreign_markers() -> None:
    assert foreign_markers("Обратите внимание на роковите.") == ["обратите внимание"]
    assert foreign_markers("Ово је српски: ћ") == ["ћ"]
    assert foreign_markers("Обрнете внимание на роковите — ќ, ѓ, ѕ, џ се македонски.") == []


def test_summary_rates() -> None:
    in_domain = {"question": "Дали смеам?", "category": "general_law"}
    off_topic = {"question": "Како се прави леб?", "category": "off_topic"}
    rows = [
        (in_domain, check_answer(in_domain, "Член 48 вели дека …", CHUNKS)),       # unsupported
        (in_domain, check_answer(in_domain, "Член 8 забранува …", CHUNKS)),         # clean
        (off_topic, check_answer(off_topic, "Одговарам само на прашања за отпад.", CHUNKS)),
    ]
    summary = summarize_checks(rows)
    assert summary["answers"] == 3
    assert summary["unsupportedCitationRate"] == pytest.approx(0.5)
    assert summary["languageMatchRate"] == pytest.approx(1.0)
    assert summary["foreignMarkerRate"] == pytest.approx(0.0)
    assert summary["offTopicCitingRate"] == pytest.approx(0.0)
