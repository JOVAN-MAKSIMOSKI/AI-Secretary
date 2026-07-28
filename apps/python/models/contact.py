"""Pydantic models for /contacts endpoints."""

import re
from datetime import datetime
from pydantic import BaseModel, Field, field_validator

# Same email shape as firms — forbids CR/LF to block header injection if the
# address is ever used in an email later (see apps/agent mcp/gmail.ts).
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _validate_email(value: str) -> str:
    cleaned = value.strip()
    if not _EMAIL_RE.match(cleaned):
        raise ValueError("Invalid email address.")
    return cleaned


class ContactCreateRequest(BaseModel):
    # firm_id and the four detail fields are all required (NOT NULL columns). A contact
    # belongs to exactly one firm; the router verifies the firm belongs to the tenant.
    firm_id: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=254)
    phone_number: str = Field(min_length=1, max_length=30)
    address: str = Field(min_length=1, max_length=255)

    @field_validator("email")
    @classmethod
    def _check_email(cls, value: str) -> str:
        return _validate_email(value)


class ContactUpdateRequest(BaseModel):
    # firm_id is editable — a contact can be reassigned to another firm.
    firm_id: str = Field(min_length=1)
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=254)
    phone_number: str = Field(min_length=1, max_length=30)
    address: str = Field(min_length=1, max_length=255)

    @field_validator("email")
    @classmethod
    def _check_email(cls, value: str) -> str:
        return _validate_email(value)


class ContactResponse(BaseModel):
    id: str
    tenant_id: str
    firm_id: str
    name: str
    email: str
    phone_number: str
    address: str
    created_at: datetime | None = None
