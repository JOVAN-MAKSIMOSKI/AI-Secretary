"""Pydantic models for /clients endpoints."""

import re
from datetime import datetime
from pydantic import BaseModel, Field, field_validator

# Basic email shape that also forbids CR/LF — a stored address containing newlines could
# be used for header injection when the client is later emailed (see apps/agent mcp/gmail.ts).
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _validate_email(value: str) -> str:
    cleaned = value.strip()
    if not _EMAIL_RE.match(cleaned):
        raise ValueError("Invalid email address.")
    return cleaned


class ClientCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=254)
    city: str | None = Field(default=None, max_length=120)
    tax_number: str | None = Field(default=None, max_length=60)
    phone: str | None = Field(default=None, max_length=30)
    address: str | None = Field(default=None, max_length=255)
    notes: str | None = Field(default=None, max_length=1000)

    @field_validator("email")
    @classmethod
    def _check_email(cls, value: str) -> str:
        return _validate_email(value)


class ClientUpdateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=254)
    city: str | None = Field(default=None, max_length=120)
    tax_number: str | None = Field(default=None, max_length=60)
    phone: str | None = Field(default=None, max_length=30)
    address: str | None = Field(default=None, max_length=255)
    notes: str | None = Field(default=None, max_length=1000)

    @field_validator("email")
    @classmethod
    def _check_email(cls, value: str) -> str:
        return _validate_email(value)


class ClientResponse(BaseModel):
    id: str
    tenant_id: str
    name: str
    email: str
    city: str | None = None
    tax_number: str | None = None
    phone: str | None = None
    address: str | None = None
    notes: str | None = None
    created_at: datetime | None = None
