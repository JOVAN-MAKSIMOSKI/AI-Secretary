"""Layer 2 — deterministic identification-form post-processing.

Pure lookups against the generated waste_reference.json, no LLM, no network, no key. The
guarded invariant: ewc_code and is_hazardous are DERIVED from waste_type, never trusted
from the model, so an asterisked (hazardous) code can never pair with is_hazardous=False.
A wrong code on a legal waste form is silent to the user — these tests exist so the
derivation cannot be quietly broken, e.g. by later accepting the code from the model.
"""

import langchain as lc


def _first_hazardous() -> tuple[str, str]:
    code, description = next(iter(lc._EWC_HAZARDOUS_CODE_MAP.items()))
    return code, description


def _first_non_hazardous() -> tuple[str, str]:
    code, description = next(iter(lc._EWC_NON_HAZARDOUS_CODE_MAP.items()))
    return code, description


def test_hazardous_description_resolves_to_asterisked_code() -> None:
    code, description = _first_hazardous()
    result = lc._resolve_ewc_code_from_waste_type({"waste_type": description})
    assert result["ewc_code"] == code
    assert result["is_hazardous"] is True
    assert code.endswith("*")


def test_non_hazardous_description_resolves_without_asterisk() -> None:
    code, description = _first_non_hazardous()
    result = lc._resolve_ewc_code_from_waste_type({"waste_type": description})
    assert result["ewc_code"] == code
    assert result["is_hazardous"] is False
    assert not code.endswith("*")


def test_every_map_entry_resolves_consistently() -> None:
    for code, description in lc._EWC_HAZARDOUS_CODE_MAP.items():
        result = lc._resolve_ewc_code_from_waste_type({"waste_type": description})
        assert result["ewc_code"] == code
        assert result["is_hazardous"] is True
    for code, description in lc._EWC_NON_HAZARDOUS_CODE_MAP.items():
        result = lc._resolve_ewc_code_from_waste_type({"waste_type": description})
        assert result["ewc_code"] == code
        assert result["is_hazardous"] is False


def test_whitespace_variation_still_matches() -> None:
    code, description = _first_hazardous()
    result = lc._resolve_ewc_code_from_waste_type({"waste_type": f"  {description}  "})
    assert result["ewc_code"] == code


def test_model_supplied_code_is_overridden_by_derivation() -> None:
    _, description = _first_hazardous()
    result = lc._resolve_ewc_code_from_waste_type(
        {"waste_type": description, "ewc_code": "WRONG", "is_hazardous": False}
    )
    assert result["ewc_code"] == _first_hazardous()[0]
    assert result["is_hazardous"] is True


def test_unknown_waste_type_drops_fabricated_code() -> None:
    result = lc._resolve_ewc_code_from_waste_type(
        {"waste_type": "some description that is not on any list", "ewc_code": "FAKE", "is_hazardous": True}
    )
    assert "ewc_code" not in result
    assert "is_hazardous" not in result
    assert result["waste_type"] == "some description that is not on any list"


def test_absent_waste_type_is_untouched() -> None:
    result = lc._resolve_ewc_code_from_waste_type({"place": "Skopje", "total_weight_kg": 10.0})
    assert result == {"place": "Skopje", "total_weight_kg": 10.0}
