"""Pydantic models for /business endpoints."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class WasteProfileContext(BaseModel):
    """Waste-law advisor profile stored in businesses.tenantprofilecontext (JSONB).

    Structured selections only (no free text except location/permit names) so the
    values can be formatted straight into the RAG prompt without parsing.
    """

    entity_type: Literal["individual", "small_business", "large_company", "municipality"] | None = None
    business_sector: Literal["construction", "healthcare", "automotive", "retail", "food", "other"] | None = None
    waste_types: list[
        Literal["hazardous", "construction", "packaging", "electronic", "municipal", "paper_textile", "other"]
    ] = Field(default_factory=list, max_length=7)
    annual_volume: Literal["under_200kg", "200kg_5t", "5t_plus"] | None = None
    location: str | None = Field(default=None, max_length=120)
    has_permits: bool = False
    permit_types: list[str] = Field(default_factory=list, max_length=20)


class BusinessRegisterRequest(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=8, max_length=128)
    tax_number: str | None = Field(default=None, max_length=60)
    transaction_account: str | None = Field(default=None, max_length=64)
    depositor: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=30)
    address: str | None = Field(default=None, max_length=255)


class BusinessRegisterResponse(BaseModel):
    business_id: str
    user_id: str
    name: str
    email: str
    tax_number: str | None = None
    transaction_account: str | None = None
    depositor: str | None = None
    plan: str
    created_at: datetime | None = None


class BusinessProfileCreateRequest(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: str = Field(min_length=5, max_length=254)
    tax_number: str | None = Field(default=None, max_length=60)
    transaction_account: str | None = Field(default=None, max_length=64)
    depositor: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=30)
    address: str | None = Field(default=None, max_length=255)
    logo_url: str | None = Field(default=None, max_length=1000)


class BusinessProfileUpdateRequest(BaseModel):
    """PATCH payload — every field optional; only provided fields are updated."""

    name: str | None = Field(default=None, min_length=2, max_length=120)
    tax_number: str | None = Field(default=None, max_length=60)
    transaction_account: str | None = Field(default=None, max_length=64)
    depositor: str | None = Field(default=None, max_length=120)
    phone: str | None = Field(default=None, max_length=30)
    address: str | None = Field(default=None, max_length=255)
    logo_url: str | None = Field(default=None, max_length=1000)
    tenantprofilecontext: WasteProfileContext | None = None


class BusinessProfileResponse(BaseModel):
    business_id: str
    owner_auth_id: str
    name: str
    email: str
    tax_number: str | None = None
    transaction_account: str | None = None
    depositor: str | None = None
    phone: str | None = None
    address: str | None = None
    logo_url: str | None = None
    plan: str
    tenantprofilecontext: dict | None = None
    created_at: datetime | None = None
