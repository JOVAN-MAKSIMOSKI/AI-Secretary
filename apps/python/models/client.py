"""Pydantic models for /clients endpoints."""

from datetime import datetime
from pydantic import BaseModel, Field


class ClientCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=254)
    city: str | None = Field(default=None, max_length=120)
    tax_number: str | None = Field(default=None, max_length=60)
    phone: str | None = Field(default=None, max_length=30)
    address: str | None = Field(default=None, max_length=255)
    notes: str | None = Field(default=None, max_length=1000)


class ClientUpdateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: str = Field(min_length=3, max_length=254)
    city: str | None = Field(default=None, max_length=120)
    tax_number: str | None = Field(default=None, max_length=60)
    phone: str | None = Field(default=None, max_length=30)
    address: str | None = Field(default=None, max_length=255)
    notes: str | None = Field(default=None, max_length=1000)


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
