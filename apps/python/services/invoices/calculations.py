"""Deterministic invoice calculation helpers."""

from __future__ import annotations

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Mapping


TWO_PLACES = Decimal("0.01")


def _to_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None

    if isinstance(value, Decimal):
        return value

    if isinstance(value, (int, float, str)):
        try:
            return Decimal(str(value))
        except InvalidOperation:
            return None

    return None


def _resolve_tax_percentage(extracted: Mapping[str, Any]) -> Decimal | None:
    explicit_tax = _to_decimal(extracted.get("tax_percentage"))
    if explicit_tax is not None:
        return explicit_tax

    invoice_type = extracted.get("invoice_type")
    if invoice_type == "goods":
        return Decimal("18")
    if invoice_type == "transport":
        return Decimal("5")

    return None


def apply_invoice_price_calculations(extracted: Mapping[str, Any]) -> dict[str, Any]:
    """Compute price totals when enough extracted numeric fields are present.

    Formula requested by product flow:
    - price_before_tax = price_per_unit * units
    - price_after_tax = price_before_tax - price_before_tax * tax_percentage / 100
    """
    result = dict(extracted)

    price_per_unit = _to_decimal(result.get("price_per_unit"))
    units = _to_decimal(result.get("units"))
    tax_percentage = _resolve_tax_percentage(result)

    if price_per_unit is None or units is None or tax_percentage is None:
        return result

    price_before_tax = (price_per_unit * units).quantize(TWO_PLACES, rounding=ROUND_HALF_UP)
    price_after_tax = (
        price_before_tax - (price_before_tax * tax_percentage / Decimal("100"))
    ).quantize(TWO_PLACES, rounding=ROUND_HALF_UP)

    result["tax_percentage"] = float(tax_percentage.quantize(TWO_PLACES, rounding=ROUND_HALF_UP))
    result["price_before_tax"] = float(price_before_tax)
    result["price_after_tax"] = float(price_after_tax)

    return result
