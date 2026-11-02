"""Deterministic checks on generated waste-law answers — no LLM judge.

Each check targets a failure measured in the 2026-11-02 manual answer review and is
computable from the answer text plus the passages it was generated from. Pure
functions: tests/test_answer_checks.py covers them offline, evals/test_answers.py
applies them to live answers.

What these cannot see: whether a cited article actually supports the claim, or whether
an obligation was given to the right party. Those still need a human (or a judge).
"""

from __future__ import annotations

import re
from typing import Any

# "Член 8", "член 8", "Членот 8", "членовите 51", "чл. 8", "Article 8". Only the first
# number after the keyword is taken: "членовите 51, 52 и 53" counts as 51.
_CITATION = re.compile(r"(?:\bчл(?:ен|енот|енови|еновите)?\.?|\bArticle)\s*(\d+)", re.IGNORECASE)

# A passage may itself cite another article ("согласно член 32 од Законот…"), and
# repeating that reference is grounded even though the article was not retrieved.
_PASSAGE_REFERENCE = re.compile(r"\bчл(?:ен|енот|енови|еновите)?\.?\s*(\d+)", re.IGNORECASE)

# Letters that exist in Russian or Serbian Cyrillic but not in Macedonian, plus Russian
# phrases seen leaking into answers ("Обратите внимание" in 2 of 20 reviewed answers).
_FOREIGN_LETTERS = frozenset("ыэъёйщћђЫЭЪЁЙЩЋЂ")
_FOREIGN_PHRASES = ("обратите внимание", "пожалуйста", "является", "следует")

CYRILLIC_QUESTION_MIN_LETTERS = 3
CYRILLIC_ANSWER_MIN_SHARE = 0.5


def cited_articles(answer: str) -> list[str]:
    return sorted(set(_CITATION.findall(answer)), key=int)


def unsupported_citations(answer: str, chunks: list[dict[str, Any]]) -> list[str]:
    """Cited article numbers that were neither retrieved nor referenced in a passage."""
    retrieved = {str(c.get("article")) for c in chunks if c.get("article")}
    referenced: set[str] = set()
    for chunk in chunks:
        referenced.update(_PASSAGE_REFERENCE.findall(str(chunk.get("text") or "")))
    return [a for a in cited_articles(answer) if a not in retrieved and a not in referenced]


def _is_cyrillic(ch: str) -> bool:
    return "Ѐ" <= ch <= "ӿ"


def language_matches(question: str, answer: str) -> bool:
    question_is_cyrillic = sum(_is_cyrillic(ch) for ch in question) > CYRILLIC_QUESTION_MIN_LETTERS
    letters = [ch for ch in answer if ch.isalpha()]
    if not letters:
        return False
    answer_is_cyrillic = sum(_is_cyrillic(ch) for ch in letters) / len(letters) > CYRILLIC_ANSWER_MIN_SHARE
    return question_is_cyrillic == answer_is_cyrillic


def foreign_markers(answer: str) -> list[str]:
    """Russian/Serbian letters or phrases in the answer itself.

    Letters quoted from a passage would also count; the corpus is Macedonian, so in
    practice a hit means the model drifted into another language.
    """
    lowered = answer.lower()
    found = sorted({ch for ch in answer if ch in _FOREIGN_LETTERS})
    found.extend(p for p in _FOREIGN_PHRASES if p in lowered)
    return found


def check_answer(case: dict[str, Any], answer: str, chunks: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "cited": cited_articles(answer),
        "unsupported": unsupported_citations(answer, chunks),
        "language_ok": language_matches(case["question"], answer),
        "foreign": foreign_markers(answer),
    }


def summarize_checks(rows: list[tuple[dict[str, Any], dict[str, Any]]]) -> dict[str, Any]:
    """Aggregate (case, check) pairs into the rates evals/answer_baseline.json gates on."""
    in_domain = [check for case, check in rows if case["category"] != "off_topic"]
    off_topic = [check for case, check in rows if case["category"] == "off_topic"]
    total = len(rows) or 1

    return {
        "answers": len(rows),
        "unsupportedCitationRate": (
            sum(1 for c in in_domain if c["unsupported"]) / len(in_domain) if in_domain else 0.0
        ),
        "languageMatchRate": sum(1 for _, c in rows if c["language_ok"]) / total,
        "foreignMarkerRate": sum(1 for _, c in rows if c["foreign"]) / total,
        "offTopicCitingRate": (
            sum(1 for c in off_topic if c["cited"]) / len(off_topic) if off_topic else 0.0
        ),
    }
