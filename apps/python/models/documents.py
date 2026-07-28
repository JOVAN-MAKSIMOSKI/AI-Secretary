"""Pydantic models for /documents endpoints."""

import json
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


# PostgreSQL int4 upper bound — integer columns reject anything larger.
PG_INT4_MAX = 2147483647


# Waste reference data generated from wasteChapters.ts (see langchain.py for the same
# load). Loaded once so the identification-form request model validates its closed-list
# fields against the single source of truth rather than a hand-copied enum.
_WASTE_REFERENCE_PATH = Path(__file__).resolve().parent.parent / "resources" / "waste_reference.json"


def _load_waste_reference() -> dict[str, Any]:
    with _WASTE_REFERENCE_PATH.open(encoding="utf-8") as reference_file:
        return json.load(reference_file)


_WASTE_REFERENCE = _load_waste_reference()
_HAZARDOUS_EWC_CODES = frozenset(_WASTE_REFERENCE["ewc_hazardous_code_map"].keys())
_NON_HAZARDOUS_EWC_CODES = frozenset(_WASTE_REFERENCE["ewc_non_hazardous_code_map"].keys())
_PACKING_METHODS = frozenset(_WASTE_REFERENCE["packing_methods"])
_WASTE_ORIGINS = frozenset(_WASTE_REFERENCE["waste_origins"])
_WASTE_OPERATIONS_CODES = frozenset(_WASTE_REFERENCE["waste_operations_codes"])


class InvoiceRequest(BaseModel):
    firm_id: str
    invoice_number: str = Field(pattern=r"^\d{3,}/\d+$")
    invoice_type: Literal["goods", "transport"]
    invoice_date: date
    value_date: date
    consignment_note_number: Optional[int] = Field(default=None, ge=0, le=PG_INT4_MAX)
    order_number: Optional[int] = Field(default=None, ge=0, le=PG_INT4_MAX)
    firm_name: str = Field(min_length=1, max_length=120)
    firm_tax_number: str = Field(min_length=1, max_length=60)
    description: str = Field(min_length=1, max_length=2000)
    units: int = Field(ge=0, le=PG_INT4_MAX)
    price_per_unit: Decimal = Field(ge=0, decimal_places=2, max_digits=12)
    tax_percentage: Decimal = Field(ge=0, le=100, decimal_places=2, max_digits=5)
    price_before_tax: Decimal = Field(ge=0, decimal_places=2, max_digits=12)
    price_after_tax: Decimal = Field(ge=0, decimal_places=2, max_digits=12)
    price_after_tax_text: Optional[str] = Field(default=None, max_length=255)
    template_id: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def set_tax_percentage_from_invoice_type(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data

        tax_by_type = {
            "goods": Decimal("18"),
            "transport": Decimal("5"),
        }
        invoice_type = data.get("invoice_type")
        expected_tax = tax_by_type.get(invoice_type)
        if expected_tax is None:
            return data

        payload = dict(data)
        provided_tax = payload.get("tax_percentage")

        if provided_tax in (None, ""):
            payload["tax_percentage"] = expected_tax
            return payload

        if Decimal(str(provided_tax)) != expected_tax:
            raise ValueError(
                f"tax_percentage must be {expected_tax} for invoice_type '{invoice_type}'."
            )

        return payload

    @field_validator(
        "invoice_number",
        "firm_name",
        "firm_tax_number",
        "description",
        mode="before",
    )
    @classmethod
    def normalize_text_fields(cls, value: str) -> str:
        if not isinstance(value, str):
            raise ValueError("must be a string")

        normalized = " ".join(value.strip().split())
        if not normalized:
            raise ValueError("must not be empty")

        return normalized

    @model_validator(mode="after")
    def validate_consignment_or_order(self) -> "InvoiceRequest":
        if self.consignment_note_number is None and self.order_number is None:
            raise ValueError(
                "Either consignment_note_number or order_number must be provided."
            )

        return self


class IdentificationFormRequest(BaseModel):
    """Authoritative validation gate for a waste identification form.

    Ports every rule from apps/agent/src/agent/identificationForm.ts (which is now a
    voice-path pre-flight only, not the gate). Parties arrive resolved: firm_id and
    contact_id are ids, and firm_name/firm_tax_number are echoed so the render route can
    reject a mismatch against the stored firm — the same guard the invoice route applies.
    The closed-list fields validate against waste_reference.json, and ewc_code must
    belong to the code map matching is_hazardous.
    """

    # Parties by reference (resolved before this point)
    firm_id: str = Field(min_length=1)
    contact_id: str = Field(min_length=1)
    # Echoed firm identity, verified against the stored firm at the render route.
    firm_name: str = Field(min_length=1, max_length=120)

    # Waste owner detail not on any table
    waste_location: str = Field(min_length=1, max_length=255)

    # Waste classification
    is_hazardous: bool
    waste_type: str = Field(min_length=1, max_length=500)
    ewc_code: str = Field(min_length=1, max_length=20)
    packing_method: str = Field(min_length=1)
    total_weight_kg: Decimal = Field(gt=0, decimal_places=2, max_digits=12)
    waste_origin: str = Field(min_length=1)
    waste_operation_code: str = Field(min_length=1)

    place: str = Field(min_length=1, max_length=120)
    date: date

    template_id: Optional[str] = None

    @field_validator("firm_name", "waste_location", "waste_type", "place", mode="before")
    @classmethod
    def _normalize_free_text(cls, value: Any) -> str:
        if not isinstance(value, str):
            raise ValueError("must be a string")
        normalized = " ".join(value.strip().split())
        if not normalized:
            raise ValueError("must not be empty")
        return normalized

    @field_validator("packing_method")
    @classmethod
    def _check_packing_method(cls, value: str) -> str:
        if value not in _PACKING_METHODS:
            raise ValueError("packing_method is not one of the allowed values")
        return value

    @field_validator("waste_origin")
    @classmethod
    def _check_waste_origin(cls, value: str) -> str:
        if value not in _WASTE_ORIGINS:
            raise ValueError("waste_origin is not one of the allowed values")
        return value

    @field_validator("waste_operation_code")
    @classmethod
    def _check_waste_operation_code(cls, value: str) -> str:
        if value not in _WASTE_OPERATIONS_CODES:
            raise ValueError("waste_operation_code is not one of the allowed values")
        return value

    @model_validator(mode="after")
    def _check_ewc_code_matches_hazard(self) -> "IdentificationFormRequest":
        # A hazardous form must carry a hazardous (asterisked) code and vice versa —
        # both come from the same map entry upstream, this rejects a tampered payload.
        allowed = _HAZARDOUS_EWC_CODES if self.is_hazardous else _NON_HAZARDOUS_EWC_CODES
        if self.ewc_code not in allowed:
            raise ValueError(
                "ewc_code must belong to the code map matching is_hazardous."
            )
        return self


class TransportFormRequest(BaseModel):
    """Authoritative validation gate for a waste transport manifest.

    Ports every rule from apps/agent/src/agent/transportForm.ts (which is now a
    voice-path pre-flight only, not the gate). Parties arrive resolved: firm_id (waste
    owner) and disposal_place_id (end owner) are ids, and both names are echoed so the
    render route can reject a mismatch against the stored records — the same guard the
    invoice and identification-form routes apply. The collector is always the tenant
    itself, so it is never sent here; its permit is read from businesses at render.

    Three weights and two dates, matching the template's boxes: waste_owner_total_kg is
    section 3's declared quantity, collector_total_kg + collector_date are the section
    4/5 handover pair (one event recorded by both sides, so one date), and end_owner_*
    is section 6's receipt at the disposal place.
    """

    # Parties by reference (resolved before this point)
    firm_id: str = Field(min_length=1)
    disposal_place_id: str = Field(min_length=1)
    # Echoed party identity, verified against the stored records at the render route.
    firm_name: str = Field(min_length=1, max_length=120)
    disposal_place_name: str = Field(min_length=1, max_length=120)

    # Waste classification
    waste_type: str = Field(min_length=1, max_length=500)
    is_hazardous: bool
    ewc_code: str = Field(min_length=1, max_length=20)

    # Per-party weights and dates
    waste_owner_total_kg: Decimal = Field(gt=0, decimal_places=2, max_digits=12)
    collector_total_kg: Decimal = Field(gt=0, decimal_places=2, max_digits=12)
    collector_date: date
    end_owner_total_kg: Decimal = Field(gt=0, decimal_places=2, max_digits=12)
    end_owner_date: date

    note: Optional[str] = Field(default=None, max_length=2000)

    template_id: Optional[str] = None

    @field_validator(
        "firm_name", "disposal_place_name", "waste_type", mode="before"
    )
    @classmethod
    def _normalize_free_text(cls, value: Any) -> str:
        if not isinstance(value, str):
            raise ValueError("must be a string")
        normalized = " ".join(value.strip().split())
        if not normalized:
            raise ValueError("must not be empty")
        return normalized

    @field_validator("note", mode="before")
    @classmethod
    def _normalize_note(cls, value: Any) -> Optional[str]:
        # Optional: a blank/whitespace-only note collapses to None rather than
        # rendering an empty "Забелешка:" value.
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("must be a string")
        normalized = " ".join(value.strip().split())
        return normalized or None

    @model_validator(mode="after")
    def _check_ewc_code_matches_hazard(self) -> "TransportFormRequest":
        # A hazardous form must carry a hazardous (asterisked) code and vice versa —
        # both come from the same map entry upstream, this rejects a tampered payload.
        allowed = _HAZARDOUS_EWC_CODES if self.is_hazardous else _NON_HAZARDOUS_EWC_CODES
        if self.ewc_code not in allowed:
            raise ValueError(
                "ewc_code must belong to the code map matching is_hazardous."
            )
        return self

    @model_validator(mode="after")
    def _check_dates_in_order(self) -> "TransportFormRequest":
        # Waste cannot arrive at the disposal place before the collector picked it up.
        if self.end_owner_date < self.collector_date:
            raise ValueError(
                "end_owner_date cannot be earlier than collector_date."
            )
        return self


class ExtractionRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)

    @field_validator("message", mode="before")
    @classmethod
    def normalize_message(cls, value: str) -> str:
        if not isinstance(value, str):
            raise ValueError("must be a string")

        if not value.strip():
            raise ValueError("must not be empty")

        return value


class ExtractionResponse(BaseModel):
    extracted: dict[str, Any]


class OfferRequest(BaseModel):
    tenant_id: str
    firm_id: str
    title: str
    amount: Optional[float] = None
    due_date: Optional[datetime] = None


class TemplateRequest(BaseModel):
    tenant_id: str
    name: str
    doc_type: str  # "invoice" or "offer"
    extension: str  # "xlsx" or "docx"


class DocumentResponse(BaseModel):
    id: str
    tenant_id: str
    title: str
    status: str
    file_url: Optional[str] = None
    storage_path: str
    created_at: datetime
