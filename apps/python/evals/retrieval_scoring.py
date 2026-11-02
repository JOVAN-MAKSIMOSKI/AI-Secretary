"""Golden-set loading and scoring for the waste-law retrieval eval.

Pure functions only — no Qdrant, no embedding model — so tests/test_retrieval_golden.py
can validate the golden file and the scoring maths on every push, while the paid eval
(evals/test_retrieval.py) reuses exactly the same logic against the live collection.

A case's `expect` lists every acceptable source. `source` is a case-insensitive
substring of the `source_file` payload field, not of the `law` label: the label is
LLM-generated at ingest, can change on a re-ingest, and is wrong on some files today.
`law` inside an entry is for humans reading the report only.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

COMMENT_PREFIX = "//"
OFF_TOPIC_EXPECT = "none"
OFF_TOPIC_CATEGORY = "off_topic"

KNOWN_CATEGORIES = frozenset(
    {"general_law", "special_streams", "packaging", "weee", "rulebook", OFF_TOPIC_CATEGORY}
)
KNOWN_SPLITS = frozenset({"dev", "holdout"})
KNOWN_TAGS = frozenset(
    {"legacy", "en", "colloquial", "short_article", "long_article", "multi_source"}
)


@dataclass(frozen=True)
class CaseResult:
    case_id: str
    category: str
    split: str
    doc_rank: int | None
    article_rank: int | None
    is_article_case: bool
    top_score: float | None
    top_sources: list[str]


def _validate_expect(expect: Any, where: str, category: str) -> None:
    if category == OFF_TOPIC_CATEGORY:
        if expect != OFF_TOPIC_EXPECT:
            raise ValueError(f'{where}: off_topic cases must have "expect": "{OFF_TOPIC_EXPECT}"')
        return
    if expect == OFF_TOPIC_EXPECT:
        raise ValueError(f'{where}: "expect": "{OFF_TOPIC_EXPECT}" is only valid for off_topic cases')
    if not isinstance(expect, list) or not expect:
        raise ValueError(f'{where}: "expect" must be a non-empty list of sources')

    for entry in expect:
        if not isinstance(entry, dict):
            raise ValueError(f'{where}: every "expect" entry must be an object')
        for key in ("source", "law"):
            if not isinstance(entry.get(key), str) or not entry[key].strip():
                raise ValueError(f'{where}: expect entry "{key}" must be a non-empty string')
        if "articles" in entry:
            articles = entry["articles"]
            if (
                not isinstance(articles, list)
                or not articles
                or not all(isinstance(a, str) and a.strip().isdigit() for a in articles)
            ):
                raise ValueError(f'{where}: "articles" must be a non-empty list of numeric strings')


def parse_golden_lines(lines: list[str], source_name: str) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    seen: set[str] = set()

    for line_number, raw in enumerate(lines, start=1):
        line = raw.strip()
        if not line or line.startswith(COMMENT_PREFIX):
            continue

        where = f"{source_name}:{line_number}"
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{where}: not valid JSON") from exc

        for key in ("id", "question", "category", "split"):
            if not isinstance(parsed.get(key), str) or not parsed[key].strip():
                raise ValueError(f'{where}: "{key}" must be a non-empty string')
        if parsed["category"] not in KNOWN_CATEGORIES:
            raise ValueError(f'{where}: unknown category "{parsed["category"]}"')
        if parsed["split"] not in KNOWN_SPLITS:
            raise ValueError(f'{where}: unknown split "{parsed["split"]}"')

        tags = parsed.get("tags", [])
        if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
            raise ValueError(f'{where}: "tags" must be a list of strings')
        unknown_tags = set(tags) - KNOWN_TAGS
        if unknown_tags:
            raise ValueError(f"{where}: unknown tags {sorted(unknown_tags)}")

        _validate_expect(parsed.get("expect"), where, parsed["category"])

        if parsed["id"] in seen:
            raise ValueError(f'{where}: duplicate case id "{parsed["id"]}"')
        seen.add(parsed["id"])
        cases.append(parsed)

    if not cases:
        raise ValueError(f"{source_name} contains no cases")
    return cases


def load_golden_cases(path: Path) -> list[dict[str, Any]]:
    return parse_golden_lines(path.read_text(encoding="utf-8").splitlines(), path.name)


def is_off_topic(case: dict[str, Any]) -> bool:
    return case["category"] == OFF_TOPIC_CATEGORY


def is_article_case(case: dict[str, Any]) -> bool:
    # Article-level only when every acceptable source names its articles: a source
    # without articles could be the right answer yet never produce an article hit,
    # which would score a correct retrieval as a miss.
    return not is_off_topic(case) and all("articles" in entry for entry in case["expect"])


def _matches_source(chunk: dict[str, Any], entry: dict[str, Any]) -> bool:
    return entry["source"].lower() in str(chunk.get("source_file") or "").lower()


def _matches_article(chunk: dict[str, Any], entry: dict[str, Any]) -> bool:
    return _matches_source(chunk, entry) and str(chunk.get("article") or "") in entry.get("articles", [])


def _first_rank(chunks: list[dict[str, Any]], case: dict[str, Any], matcher) -> int | None:
    for rank, chunk in enumerate(chunks, start=1):
        if any(matcher(chunk, entry) for entry in case["expect"]):
            return rank
    return None


def score_case(case: dict[str, Any], chunks: list[dict[str, Any]]) -> CaseResult:
    top_score = chunks[0].get("score") if chunks else None
    top_sources = [str(chunk.get("source_file") or "") for chunk in chunks[:3]]

    if is_off_topic(case):
        return CaseResult(case["id"], case["category"], case["split"], None, None, False, top_score, top_sources)

    article_case = is_article_case(case)
    return CaseResult(
        case_id=case["id"],
        category=case["category"],
        split=case["split"],
        doc_rank=_first_rank(chunks, case, _matches_source),
        article_rank=_first_rank(chunks, case, _matches_article) if article_case else None,
        is_article_case=article_case,
        top_score=top_score,
        top_sources=top_sources,
    )


def _recall_and_mrr(ranks: list[int | None]) -> tuple[float, float]:
    if not ranks:
        return 0.0, 0.0
    recall = sum(1 for r in ranks if r is not None) / len(ranks)
    mrr = sum(1 / r for r in ranks if r is not None) / len(ranks)
    return recall, mrr


def summarize(results: list[CaseResult]) -> dict[str, Any]:
    in_domain = [r for r in results if r.category != OFF_TOPIC_CATEGORY]
    article_results = [r for r in in_domain if r.is_article_case]

    doc_recall, doc_mrr = _recall_and_mrr([r.doc_rank for r in in_domain])
    article_recall, article_mrr = _recall_and_mrr([r.article_rank for r in article_results])

    per_category: dict[str, dict[str, float]] = {}
    for category in sorted({r.category for r in in_domain}):
        group = [r for r in in_domain if r.category == category]
        recall, mrr = _recall_and_mrr([r.doc_rank for r in group])
        per_category[category] = {"cases": len(group), "docRecall": recall, "docMrr": mrr}

    per_split: dict[str, dict[str, float]] = {}
    for split in sorted({r.split for r in in_domain}):
        group = [r for r in in_domain if r.split == split]
        recall, mrr = _recall_and_mrr([r.doc_rank for r in group])
        per_split[split] = {"cases": len(group), "docRecall": recall, "docMrr": mrr}

    return {
        "cases": len(in_domain),
        "articleCases": len(article_results),
        "docRecall": doc_recall,
        "docMrr": doc_mrr,
        "articleRecall": article_recall,
        "articleMrr": article_mrr,
        "perCategory": per_category,
        "perSplit": per_split,
    }


def off_topic_report(results: list[CaseResult]) -> list[str]:
    """Top-1 similarity of off-topic questions next to the weakest in-domain hit.

    Informational only. Retrieval has no relevance cutoff, so an off-topic question
    still returns k passages; these numbers show whether a cutoff could separate the
    two at all before one is introduced.
    """
    off_topic = [r for r in results if r.category == OFF_TOPIC_CATEGORY]
    if not off_topic:
        return []

    hit_scores = [
        r.top_score for r in results
        if r.category != OFF_TOPIC_CATEGORY and r.doc_rank == 1 and r.top_score is not None
    ]
    lines = [f"off-topic {r.case_id}: top score {r.top_score}" for r in off_topic]
    if hit_scores:
        lines.append(f"lowest top score among rank-1 in-domain hits: {min(hit_scores)}")
    return lines


def format_case_line(result: CaseResult, case: dict[str, Any]) -> str:
    """One report line for an in-domain case; off-topic cases go to off_topic_report."""
    doc = f"doc@{result.doc_rank}" if result.doc_rank else "DOC-MISS"
    if not result.is_article_case:
        art = "art=n/a"
    else:
        art = f"art@{result.article_rank}" if result.article_rank else "ART-MISS"

    line = f"{doc:9} {art:9} [{result.split}] {result.case_id}"
    if result.doc_rank is None:
        expected = ", ".join(entry["law"] for entry in case["expect"])
        line += f"\n          expected: {expected}\n          got: {result.top_sources}"
    return line
