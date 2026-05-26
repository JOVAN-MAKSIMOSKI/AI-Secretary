"""Template fetch helpers for invoice and offer documents."""

from __future__ import annotations

from io import BytesIO
from typing import Any, Optional
from uuid import UUID

from openpyxl import load_workbook

from services.storage import supabase


def _require_tenant_owner_auth_id(tenant_id: str) -> str:
    business = (
        supabase.table("businesses")
        .select("owner_auth_id")
        .eq("owner_auth_id", tenant_id)
        .limit(1)
        .execute()
    )

    if not business.data:
        raise ValueError(f"Tenant '{tenant_id}' not found.")

    return business.data[0]["owner_auth_id"]


def _fetch_template_payload(
    tenant_id: str,
    template_table: str,
    fallback_name: str,
) -> dict[str, Any]:
    owner_auth_id = _require_tenant_owner_auth_id(tenant_id)

    query = (
        supabase.table(template_table)
        .select("id, tenant_id, name, storagePath, created_at")
        .eq("tenant_id", owner_auth_id)
        .order("created_at", desc=True)
        .limit(1)
    )

    response = query.execute()
    rows = response.data or []

    if not rows:
        raise ValueError(f"No template found in '{template_table}' for tenant '{tenant_id}'.")

    row = rows[0]
    template_bytes = supabase.storage.from_("documents").download(row["storagePath"])

    if not isinstance(template_bytes, (bytes, bytearray)):
        template_bytes = bytes(template_bytes)

    return {
        "template_id": row["id"],
        "template_name": row.get("name") or fallback_name,
        "template_source": row.get("storagePath"),
        "template_bytes": bytes(template_bytes),
    }


def fetch_invoice_template_payload(tenant_id: str) -> dict[str, Any]:
    """Fetch the stored invoice template bytes and metadata for a tenant."""
    return _fetch_template_payload(
        tenant_id=tenant_id,
        template_table="templatesInvoice",
        fallback_name="invoice-template",
    )


def fetch_offer_template_payload(tenant_id: str) -> dict[str, Any]:
    """Fetch the stored offer template bytes and metadata for a tenant."""
    return _fetch_template_payload(
        tenant_id=tenant_id,
        template_table="templatesOffer",
        fallback_name="offer-template",
    )


def load_invoice_template_workbook(tenant_id: str):
    """Load the stored invoice template into an openpyxl workbook."""
    payload = fetch_invoice_template_payload(tenant_id)
    return load_workbook(BytesIO(payload["template_bytes"]))
