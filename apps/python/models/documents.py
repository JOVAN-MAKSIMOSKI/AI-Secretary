"""Pydantic models for /documents endpoints."""

from pydantic import BaseModel
from typing import Optional
from datetime import datetime
from uuid import UUID


class InvoiceRequest(BaseModel):
    tenant_id: str
    client_id: str
    title: str
    amount: Optional[float] = None
    due_date: Optional[datetime] = None
    template_id: Optional[str] = None


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
