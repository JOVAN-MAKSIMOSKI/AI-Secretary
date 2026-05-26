"""Pydantic models for /business endpoints."""

from datetime import datetime

from pydantic import BaseModel, Field


class BusinessRegisterRequest(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=8, max_length=128)
    phone: str | None = Field(default=None, max_length=30)
    address: str | None = Field(default=None, max_length=255)


class BusinessRegisterResponse(BaseModel):
    business_id: str
    user_id: str
    name: str
    email: str
    plan: str
    created_at: datetime | None = None


class BusinessProfileCreateRequest(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: str = Field(min_length=5, max_length=254)
    phone: str | None = Field(default=None, max_length=30)
    address: str | None = Field(default=None, max_length=255)
    logo_url: str | None = Field(default=None, max_length=1000)


class BusinessProfileResponse(BaseModel):
    business_id: str
    owner_auth_id: str
    name: str
    email: str
    phone: str | None = None
    address: str | None = None
    logo_url: str | None = None
    plan: str
    created_at: datetime | None = None
