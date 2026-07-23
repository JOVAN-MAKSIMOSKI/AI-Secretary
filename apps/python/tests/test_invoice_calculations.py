"""Layer 2 — deterministic invoice arithmetic.

Pure Decimal maths, no service, no network, no key. This is the layer where wrongness is
silent: a mis-routed message is visible to the user, a wrong total on a generated PDF is
not.

Note the formula being pinned here is a *deduction*, not a VAT addition —
`price_after_tax = price_before_tax - price_before_tax * tax / 100`, per the
"formula requested by product flow" note in calculations.py. These tests exist partly so
nobody later "corrects" it into an addition without that being a deliberate decision.
"""

from decimal import Decimal

import pytest

from services.invoices.calculations import apply_invoice_price_calculations


def test_computes_totals_from_units_and_unit_price() -> None:
    result = apply_invoice_price_calculations(
        {"price_per_unit": 1500, "units": 10, "tax_percentage": 5}
    )

    assert result["price_before_tax"] == 15000.00
    assert result["price_after_tax"] == 14250.00  # 15000 - 5%
    assert result["tax_percentage"] == 5.00


def test_goods_invoice_defaults_to_eighteen_percent() -> None:
    result = apply_invoice_price_calculations(
        {"price_per_unit": 1000, "units": 1, "invoice_type": "goods"}
    )

    assert result["tax_percentage"] == 18.00
    assert result["price_after_tax"] == 820.00


def test_transport_invoice_defaults_to_five_percent() -> None:
    result = apply_invoice_price_calculations(
        {"price_per_unit": 1000, "units": 1, "invoice_type": "transport"}
    )

    assert result["tax_percentage"] == 5.00
    assert result["price_after_tax"] == 950.00


def test_explicit_tax_percentage_overrides_the_type_default() -> None:
    result = apply_invoice_price_calculations(
        {"price_per_unit": 1000, "units": 1, "invoice_type": "goods", "tax_percentage": 5}
    )

    assert result["tax_percentage"] == 5.00
    assert result["price_after_tax"] == 950.00


@pytest.mark.parametrize(
    "missing",
    [
        {"units": 10, "tax_percentage": 5},                      # no price_per_unit
        {"price_per_unit": 1500, "tax_percentage": 5},           # no units
        {"price_per_unit": 1500, "units": 10},                   # no tax and no invoice_type
    ],
)
def test_returns_input_untouched_when_a_required_field_is_missing(missing: dict) -> None:
    result = apply_invoice_price_calculations(missing)

    assert "price_before_tax" not in result
    assert "price_after_tax" not in result


def test_unknown_invoice_type_does_not_invent_a_tax_rate() -> None:
    result = apply_invoice_price_calculations(
        {"price_per_unit": 1000, "units": 1, "invoice_type": "something_else"}
    )

    assert "price_after_tax" not in result


def test_accepts_numeric_strings_from_extraction() -> None:
    # The extraction chain returns JSON, so numbers can arrive as strings.
    result = apply_invoice_price_calculations(
        {"price_per_unit": "1500.00", "units": "10", "tax_percentage": "5"}
    )

    assert result["price_before_tax"] == 15000.00


def test_non_numeric_input_is_treated_as_missing_not_as_zero() -> None:
    result = apply_invoice_price_calculations(
        {"price_per_unit": "not a number", "units": 10, "tax_percentage": 5}
    )

    assert "price_before_tax" not in result


def test_rounds_half_up_to_two_places() -> None:
    # 333.335 * 1 rounds up to 333.34 under ROUND_HALF_UP (banker's rounding would give .33).
    result = apply_invoice_price_calculations(
        {"price_per_unit": Decimal("333.335"), "units": 1, "tax_percentage": 0}
    )

    assert result["price_before_tax"] == 333.34


def test_zero_tax_leaves_the_total_unchanged() -> None:
    result = apply_invoice_price_calculations(
        {"price_per_unit": 100, "units": 3, "tax_percentage": 0}
    )

    assert result["price_before_tax"] == 300.00
    assert result["price_after_tax"] == 300.00


def test_does_not_mutate_the_caller_mapping() -> None:
    original = {"price_per_unit": 1000, "units": 2, "tax_percentage": 5}
    apply_invoice_price_calculations(original)

    assert "price_before_tax" not in original
