"""Layer 1 — TransportFormRequest, the authoritative validation gate.

Pure Pydantic: no DB, no network, no template. Guards the rules that must hold before
any transport form reaches the render route — the hazard/code cross-check, the weight
and date constraints, and the note normalisation.
"""

import pytest
from pydantic import ValidationError

from models.documents import (
    _HAZARDOUS_EWC_CODES,
    _NON_HAZARDOUS_EWC_CODES,
    TransportFormRequest,
)

_HAZ_CODE = next(iter(_HAZARDOUS_EWC_CODES))
_NON_HAZ_CODE = next(iter(_NON_HAZARDOUS_EWC_CODES))


def _payload(**overrides):
    payload = {
        "firm_id": "firm-1",
        "disposal_place_id": "dp-1",
        "firm_name": "ACME DOO",
        "disposal_place_name": "Drisla",
        "waste_type": "Отпадно масло",
        "is_hazardous": True,
        "ewc_code": _HAZ_CODE,
        "waste_owner_total_kg": "800.00",
        "collector_total_kg": "800.00",
        "collector_date": "2026-03-12",
        "end_owner_total_kg": "800.00",
        "end_owner_date": "2026-03-13",
    }
    payload.update(overrides)
    return payload


def test_valid_payload_parses() -> None:
    model = TransportFormRequest(**_payload())
    assert model.firm_id == "firm-1"
    assert model.disposal_place_id == "dp-1"
    assert model.note is None


def test_hazardous_code_required_when_hazardous() -> None:
    # A hazardous form carrying a non-hazardous code is the exact mismatch the
    # deterministic upstream derivation makes impossible — this rejects a tampered body.
    with pytest.raises(ValidationError) as exc:
        TransportFormRequest(**_payload(ewc_code=_NON_HAZ_CODE))
    assert "is_hazardous" in str(exc.value)


def test_non_hazardous_code_required_when_not_hazardous() -> None:
    with pytest.raises(ValidationError):
        TransportFormRequest(**_payload(is_hazardous=False, ewc_code=_HAZ_CODE))

    model = TransportFormRequest(**_payload(is_hazardous=False, ewc_code=_NON_HAZ_CODE))
    assert model.is_hazardous is False


def test_unknown_ewc_code_rejected() -> None:
    with pytest.raises(ValidationError):
        TransportFormRequest(**_payload(ewc_code="99 99 99"))


@pytest.mark.parametrize("weight", ["0", "-5", "0.00"])
def test_non_positive_weight_rejected(weight: str) -> None:
    with pytest.raises(ValidationError):
        TransportFormRequest(**_payload(collector_total_kg=weight))


def test_more_than_two_decimal_places_rejected() -> None:
    with pytest.raises(ValidationError):
        TransportFormRequest(**_payload(end_owner_total_kg="12.345"))


def test_end_owner_date_before_collector_date_rejected() -> None:
    # Waste cannot arrive at the disposal place before it was collected.
    with pytest.raises(ValidationError) as exc:
        TransportFormRequest(
            **_payload(collector_date="2026-03-12", end_owner_date="2026-03-11")
        )
    assert "end_owner_date" in str(exc.value)


def test_same_day_handover_and_receipt_allowed() -> None:
    model = TransportFormRequest(
        **_payload(collector_date="2026-03-12", end_owner_date="2026-03-12")
    )
    assert model.collector_date == model.end_owner_date


def test_blank_note_collapses_to_none() -> None:
    # A whitespace-only note must not render an empty "Забелешка:" value.
    assert TransportFormRequest(**_payload(note="   ")).note is None
    assert TransportFormRequest(**_payload(note=None)).note is None


def test_note_whitespace_is_collapsed() -> None:
    model = TransportFormRequest(**_payload(note="  two   spaces  "))
    assert model.note == "two spaces"


def test_free_text_whitespace_is_collapsed() -> None:
    model = TransportFormRequest(**_payload(firm_name="  ACME   DOO  "))
    assert model.firm_name == "ACME DOO"


def test_empty_firm_name_rejected() -> None:
    with pytest.raises(ValidationError):
        TransportFormRequest(**_payload(firm_name="   "))


def test_waste_owner_date_is_not_a_field() -> None:
    # Dropped in 20260727000000: the template has no box for it. Pydantic ignores unknown
    # keys by default, so assert on the model's fields rather than on a rejected payload.
    assert "waste_owner_date" not in TransportFormRequest.model_fields
