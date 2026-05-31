"""Pydantic models for /documents endpoints."""

from datetime import date, datetime
from decimal import Decimal
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


class InvoiceRequest(BaseModel):
    client_id: str
    invoice_number: str = Field(pattern=r"^\d+/\d+$")
    invoice_type: Literal["goods", "transport"]
    invoice_date: date
    value_date: date
    consignment_note_number: Optional[int] = Field(default=None, ge=0)
    order_number: Optional[int] = Field(default=None, ge=0)
    client_name: str = Field(min_length=1, max_length=120)
    client_tax_number: str = Field(min_length=1, max_length=60)
    description: str = Field(min_length=1, max_length=2000)
    units: int = Field(ge=0)
    price_per_unit: Decimal = Field(ge=0, decimal_places=2, max_digits=12)
    tax_percentage: Decimal = Field(ge=0, le=100, decimal_places=2, max_digits=5)
    price_before_tax: Decimal = Field(ge=0, decimal_places=2, max_digits=12)
    price_after_tax: Decimal = Field(ge=0, decimal_places=2, max_digits=12)
    price_after_tax_text: Optional[str] = Field(default=None, max_length=255)
    template_id: Optional[str] = None

    @field_validator(
        "invoice_number",
        "client_name",
        "client_tax_number",
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


class OfferRequest(BaseModel):
    tenant_id: str
    client_id: str
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
