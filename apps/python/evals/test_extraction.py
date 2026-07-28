"""Layer 1 — extraction field accuracy for every /documents/extract* chain.

Calls the same functions the routes call — no FastAPI, no Whisper, no Supabase. Every
runner passes owner_auth_id=None, which skips the party-resolution step in the invoice
and both waste-form chains, so what is measured here is purely the LLM extraction layer.
Costs real LLM calls, so it lives in evals/, not tests/.

    uv run pytest evals/test_extraction.py -q

Scored per expected field, aggregated per chain against evals/extraction_baseline.json —
extraction is an LLM call at temperature 0, mostly stable but not guaranteed, and a gate
that fails on one wobble gets ignored. Per-field failures are printed either way, so a
tolerated miss is visible, not silent.

The waste-form floors are currently below 1.0 on purpose: they absorb three reproducible
extraction defects the golden cases were written to expose. See extraction_baseline.json
for what each floor is covering — the cases encode correct behaviour, not current
behaviour, so the misses stay printed until the chains are fixed.
"""

from __future__ import annotations

import json
import math
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import pytest

from evals.eval_env import configure_extraction_eval_env

EVALS_DIR = Path(__file__).resolve().parent
GOLDEN_FILE = EVALS_DIR / "golden" / "extraction.jsonl"
BASELINE_FILE = EVALS_DIR / "extraction_baseline.json"
COMMENT_PREFIX = "//"
VALID_CHAINS = ("invoice", "calendar", "offer", "identification_form", "transport_form")
NUMERIC_TOLERANCE = 1e-6

_SKIP_REASON = configure_extraction_eval_env()


def load_golden_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    seen: set[str] = set()

    for line_number, raw in enumerate(GOLDEN_FILE.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith(COMMENT_PREFIX):
            continue

        where = f"{GOLDEN_FILE.name}:{line_number}"
        parsed = json.loads(line)

        if parsed.get("chain") not in VALID_CHAINS:
            raise ValueError(f"{where}: chain must be one of {VALID_CHAINS}")
        if not isinstance(parsed.get("expect"), dict) or not parsed["expect"]:
            raise ValueError(f'{where}: "expect" must be a non-empty object')
        if parsed["id"] in seen:
            raise ValueError(f'{where}: duplicate case id "{parsed["id"]}"')
        seen.add(parsed["id"])
        cases.append(parsed)

    if not cases:
        raise ValueError(f"{GOLDEN_FILE.name} contains no cases")
    return cases


def field_matches(expected: Any, actual: Any) -> bool:
    if expected == "@absent":
        return actual is None
    if expected == "@tomorrow":
        return actual == (date.today() + timedelta(days=1)).isoformat()
    if isinstance(expected, str) and expected.startswith("contains:"):
        needle = expected[len("contains:"):].lower()
        return actual is not None and needle in str(actual).lower()
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        return math.isclose(float(expected), float(actual), abs_tol=NUMERIC_TOLERANCE)
    return expected == actual


def print_report(report: list[str]) -> None:
    """Print the per-field report without dying on a narrow console encoding.

    Every closed-list expected value is Macedonian, so any MISS line carries Cyrillic.
    A Windows console defaults to cp1252, which cannot represent it, and a bare print()
    raises UnicodeEncodeError — turning a miss the floor was meant to tolerate into a
    crashed eval that reports nothing at all. Degrade the unrepresentable characters
    instead; on a UTF-8 console (CI) nothing is lost.
    """
    text = "\n" + "\n".join(report)
    try:
        print(text)
    except UnicodeEncodeError:
        encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
        print(text.encode(encoding, errors="replace").decode(encoding, errors="replace"))


@pytest.fixture(scope="session")
def extraction_runners() -> dict[str, Any]:
    if _SKIP_REASON:
        pytest.skip(_SKIP_REASON)

    # Imported here, after configure_extraction_eval_env has set the Supabase import
    # guards — services/storage.py raises at module import without them.
    from langchain import run_calendar_event_extraction, run_offer_extraction
    from services.identification_forms.extraction import (
        extract_identification_form_fields_from_message,
    )
    from services.invoices.excel import extract_invoice_fields_from_message
    from services.transport_forms.extraction import (
        extract_transport_form_fields_from_message,
    )

    return {
        "invoice": lambda message: extract_invoice_fields_from_message(message, owner_auth_id=None),
        "calendar": run_calendar_event_extraction,
        "offer": run_offer_extraction,
        # owner_auth_id=None skips firm/contact/disposal-place resolution, so these
        # measure the chain + the deterministic ewc_code derivation, nothing DB-bound.
        "identification_form": lambda message: extract_identification_form_fields_from_message(
            message, owner_auth_id=None
        ),
        "transport_form": lambda message: extract_transport_form_fields_from_message(
            message, owner_auth_id=None
        ),
    }


def test_extraction_field_accuracy_meets_baseline(extraction_runners) -> None:
    baseline = json.loads(BASELINE_FILE.read_text(encoding="utf-8"))
    cases = load_golden_cases()

    per_chain: dict[str, dict[str, int]] = {chain: {"matched": 0, "total": 0} for chain in VALID_CHAINS}
    report: list[str] = []

    for case in cases:
        try:
            result = extraction_runners[case["chain"]](case["message"])
        except Exception as exc:  # a thrown chain fails every field it was expected to produce
            per_chain[case["chain"]]["total"] += len(case["expect"])
            report.append(f"ERROR {case['id']}: chain raised {type(exc).__name__}: {exc}")
            continue

        for field, expected in case["expect"].items():
            per_chain[case["chain"]]["total"] += 1
            actual = result.get(field)
            if field_matches(expected, actual):
                per_chain[case["chain"]]["matched"] += 1
            else:
                report.append(f"MISS {case['id']}.{field}: expected {expected!r}, got {actual!r}")

    failures: list[str] = []
    for chain, counts in per_chain.items():
        if counts["total"] == 0:
            continue
        accuracy = counts["matched"] / counts["total"]
        floor = baseline["perChainFieldAccuracy"][chain]
        report.append(f"{chain}: {counts['matched']}/{counts['total']} = {accuracy:.3f} (floor {floor})")
        if accuracy < floor:
            failures.append(f"{chain} field accuracy {accuracy:.3f} is below its floor {floor}")

    print_report(report)
    assert not failures, "\n".join([*failures, *report])
