"""Layer 2 — IdentificationFormRequest validation gate.

Pure Pydantic, no network. This is the authoritative gate for the render route, so its
rules are pinned here: closed-list membership, weight bounds, and the invariant that a
hazardous form carries a hazardous (asterisked) EWC code and vice versa.
"""

import pytest

from models.documents import (
    IdentificationFormRequest,
    _HAZARDOUS_EWC_CODES,
    _NON_HAZARDOUS_EWC_CODES,
    _PACKING_METHODS,
    _WASTE_ORIGINS,
    _WASTE_OPERATIONS_CODES,
)


def _valid_payload(**overrides):
    payload = {
        "firm_id": "firm-1",
        "contact_id": "contact-1",
        "firm_name": "ACME DOO",
        "waste_location": "Skopje warehouse",
        "is_hazardous": True,
        "waste_type": "Опасни агрохемиски отпадоци",
        "ewc_code": next(iter(_HAZARDOUS_EWC_CODES)),
        "packing_method": next(iter(_PACKING_METHODS)),
        "total_weight_kg": "1500.00",
        "waste_origin": next(iter(_WASTE_ORIGINS)),
        "waste_operation_code": next(iter(_WASTE_OPERATIONS_CODES)),
        "place": "Skopje",
        "date": "2026-07-25",
    }
    payload.update(overrides)
    return payload


def test_valid_hazardous_form() -> None:
    request = IdentificationFormRequest(**_valid_payload())
    assert request.is_hazardous is True
    assert request.ewc_code in _HAZARDOUS_EWC_CODES


def test_valid_non_hazardous_form() -> None:
    request = IdentificationFormRequest(
        **_valid_payload(is_hazardous=False, ewc_code=next(iter(_NON_HAZARDOUS_EWC_CODES)))
    )
    assert request.is_hazardous is False
    assert request.ewc_code in _NON_HAZARDOUS_EWC_CODES


def test_hazardous_code_on_non_hazardous_form_rejected() -> None:
    with pytest.raises(ValueError):
        IdentificationFormRequest(**_valid_payload(is_hazardous=False))  # keeps hazardous code


def test_non_hazardous_code_on_hazardous_form_rejected() -> None:
    with pytest.raises(ValueError):
        IdentificationFormRequest(
            **_valid_payload(ewc_code=next(iter(_NON_HAZARDOUS_EWC_CODES)))  # is_hazardous stays True
        )


def test_packing_method_off_list_rejected() -> None:
    with pytest.raises(ValueError):
        IdentificationFormRequest(**_valid_payload(packing_method="plastic bags"))


def test_waste_origin_off_list_rejected() -> None:
    with pytest.raises(ValueError):
        IdentificationFormRequest(**_valid_payload(waste_origin="somewhere"))


def test_waste_operation_code_off_list_rejected() -> None:
    with pytest.raises(ValueError):
        IdentificationFormRequest(**_valid_payload(waste_operation_code="R99"))


def test_zero_weight_rejected() -> None:
    with pytest.raises(ValueError):
        IdentificationFormRequest(**_valid_payload(total_weight_kg="0"))


def test_three_decimal_weight_rejected() -> None:
    with pytest.raises(ValueError):
        IdentificationFormRequest(**_valid_payload(total_weight_kg="1.234"))


def test_blank_waste_location_rejected() -> None:
    with pytest.raises(ValueError):
        IdentificationFormRequest(**_valid_payload(waste_location="   "))


def test_bad_date_rejected() -> None:
    with pytest.raises(ValueError):
        IdentificationFormRequest(**_valid_payload(date="25-07-2026"))
