"""Pydantic models for /disposal-places endpoints."""

import re
from datetime import datetime
from pydantic import BaseModel, Field, field_validator

# Same email shape as clients — forbids CR/LF to block header injection if the
# address is ever used in an email later (see apps/agent mcp/gmail.ts).
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _validate_email(value: str) -> str:
    cleaned = value.strip()
    if not _EMAIL_RE.match(cleaned):
        raise ValueError("Invalid email address.")
    return cleaned


class DisposalPlaceCreateRequest(BaseModel):
    # All five fields are required (NOT NULL columns on disposal_places).
    name: str = Field(min_length=1, max_length=120)
    address: str = Field(min_length=1, max_length=255)
    place: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=254)
    phone_number: str = Field(min_length=1, max_length=30)

    @field_validator("email")
    @classmethod
    def _check_email(cls, value: str) -> str:
        return _validate_email(value)


class DisposalPlaceUpdateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    address: str = Field(min_length=1, max_length=255)
    place: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=254)
    phone_number: str = Field(min_length=1, max_length=30)

    @field_validator("email")
    @classmethod
    def _check_email(cls, value: str) -> str:
        return _validate_email(value)


class DisposalPlaceResponse(BaseModel):
    id: str
    tenant_id: str
    name: str
    address: str
    place: str
    email: str
    phone_number: str
    created_at: datetime | None = None
