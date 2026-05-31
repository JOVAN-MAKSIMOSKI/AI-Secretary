"""Document generation router for invoices, offers, and templates."""

from io import BytesIO
from typing import Optional
from uuid import UUID, uuid4
from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, Form, File
from fastapi.responses import StreamingResponse

from models.documents import DocumentResponse, InvoiceRequest
from services.excel import fetch_invoice_template_payload, fetch_offer_template_payload
from services.invoice_text import amount_to_macedonian_text
from services.auth import get_current_user_id
from services.storage import (
    supabase,
    upload_template_document,
)

router = APIRouter(prefix="/documents", tags=["documents"])


def _parse_optional_due_date(raw_due_date: Optional[str]) -> Optional[datetime]:
    if raw_due_date is None:
        return None

    value = raw_due_date.strip()
    if not value:
        return None

    try:
        # Accept common ISO format and UTC suffix used by clients.
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="due_date must be a valid ISO datetime, e.g. 2026-05-08T00:00:00Z",
        ) from exc


@router.post("/invoice", status_code=status.HTTP_200_OK)
def create_invoice(
    payload: Optional[InvoiceRequest] = None,
    current_user_id: str = Depends(get_current_user_id),
) -> StreamingResponse:
    """Fetch the stored invoice template bytes and stream them back."""
    owner_auth_id_str = str(UUID(current_user_id))

    # Verify tenant exists by canonical tenant identity (owner_auth_id).
    business = (
        supabase.table("businesses")
        .select("id, owner_auth_id")
        .eq("owner_auth_id", owner_auth_id_str)
        .limit(1)
        .execute()
    )
    if not business.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tenant '{owner_auth_id_str}' not found.",
        )
    resolved_owner_auth_id = business.data[0]["owner_auth_id"]

    if payload is not None:
        client_result = (
            supabase.table("clients")
            .select("id, name, tax_number")
            .eq("id", payload.client_id)
            .eq("tenant_id", resolved_owner_auth_id)
            .limit(1)
            .execute()
        )
        if not client_result.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Client not found for this tenant.",
            )

        client_row = client_result.data[0]
        stored_name = str(client_row.get("name") or "").strip()
        stored_tax_number = str(client_row.get("tax_number") or "").strip()

        if stored_name != payload.client_name.strip():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="client_name does not match the selected client.",
            )

        if stored_tax_number != payload.client_tax_number.strip():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="client_tax_number does not match the selected client.",
            )

        try:
            generated_price_after_tax_text = amount_to_macedonian_text(payload.price_after_tax)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Failed to generate Macedonian amount text: {exc}",
            ) from exc

        tax_total = Decimal(payload.price_after_tax) - Decimal(payload.price_before_tax)

        existing_invoice = (
            supabase.table("invoices")
            .select("id")
            .eq("tenant_id", resolved_owner_auth_id)
            .eq("client_id", payload.client_id)
            .eq("invoice_number", payload.invoice_number)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )

        invoice_common_data = {
            "tenant_id": resolved_owner_auth_id,
            "client_id": payload.client_id,
            "invoice_number": payload.invoice_number,
            "invoice_type": payload.invoice_type,
            "invoice_date": payload.invoice_date.isoformat(),
            "value_date": payload.value_date.isoformat(),
            "consignment_note_number": payload.consignment_note_number,
            "order_number": payload.order_number,
            "description": payload.description,
            "units": payload.units,
            "price_per_unit": str(payload.price_per_unit),
            "tax_percentage": str(payload.tax_percentage),
            "tax_total": str(tax_total),
            "price_before_tax": str(payload.price_before_tax),
            "price_after_tax": str(payload.price_after_tax),
            "price_after_tax_text": generated_price_after_tax_text,
            "title": f"Invoice {payload.invoice_number}",
            "status": "draft",
            "template_id": payload.template_id,
            "amount": str(payload.price_after_tax),
            "due_date": payload.value_date.isoformat(),
        }

        existing_rows = existing_invoice.data or []
        if existing_rows:
            invoice_id = existing_rows[0]["id"]
            (
                supabase.table("invoices")
                .update(invoice_common_data)
                .eq("id", invoice_id)
                .eq("tenant_id", resolved_owner_auth_id)
                .execute()
            )
        else:
            invoice_id = str(uuid4())
            storage_path = f"{resolved_owner_auth_id}/invoices/{invoice_id}.xlsx"
            insert_data = {
                "id": invoice_id,
                "storagePath": storage_path,
                **invoice_common_data,
            }
            supabase.table("invoices").insert(insert_data).execute()

    try:
        template_payload = fetch_invoice_template_payload(
            resolved_owner_auth_id,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc

    filename = f"{template_payload['template_name']}.xlsx"
    return StreamingResponse(
        BytesIO(template_payload["template_bytes"]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/offer", status_code=status.HTTP_200_OK)
def create_offer(
    current_user_id: str = Depends(get_current_user_id),
) -> StreamingResponse:
    """Fetch the stored offer template bytes and stream them back."""
    owner_auth_id_str = str(UUID(current_user_id))

    # Verify tenant exists by canonical tenant identity (owner_auth_id).
    business = (
        supabase.table("businesses")
        .select("id, owner_auth_id")
        .eq("owner_auth_id", owner_auth_id_str)
        .limit(1)
        .execute()
    )
    if not business.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tenant '{owner_auth_id_str}' not found.",
        )
    resolved_owner_auth_id = business.data[0]["owner_auth_id"]

    try:
        template_payload = fetch_offer_template_payload(
            resolved_owner_auth_id,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc

    filename = f"{template_payload['template_name']}.docx"
    return StreamingResponse(
        BytesIO(template_payload["template_bytes"]),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/template", response_model=DocumentResponse, status_code=status.HTTP_201_CREATED)
def create_template(
    name: str = Form(...),
    doc_type: str = Form(...),
    extension: str = Form(...),
    file: UploadFile = File(...),
    current_user_id: str = Depends(get_current_user_id),
) -> DocumentResponse:
    """Upload and save a document template (invoice or offer)."""
    tenant_id_str = str(UUID(current_user_id))

    # Validate doc_type and extension
    if doc_type not in ["invoice", "offer"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="doc_type must be 'invoice' or 'offer'.",
        )

    if extension.lower().lstrip(".") not in ["xlsx", "docx"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="extension must be 'xlsx' or 'docx'.",
        )

    # Verify tenant exists by canonical tenant identity (owner_auth_id).
    business = (
        supabase.table("businesses")
        .select("id, owner_auth_id")
        .eq("owner_auth_id", tenant_id_str)
        .limit(1)
        .execute()
    )
    if not business.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tenant '{tenant_id_str}' not found.",
        )
    owner_auth_id = business.data[0]["owner_auth_id"]

    # Generate template ID and read file
    template_id = str(uuid4())
    file_content = file.file.read()

    # Determine table name based on doc_type
    table_name = "templatesInvoice" if doc_type == "invoice" else "templatesOffer"

    storage_path = (
        f"{owner_auth_id}/templates/{template_id}.{extension.lower().lstrip('.')}"
    )
    inserted = False
    data = []

    try:
        # Insert into database first so storage objects are not orphaned if DB write fails.
        response = (
            supabase.table(table_name)
            .insert(
                {
                    "id": template_id,
                    "tenant_id": owner_auth_id,
                    "name": name,
                    "content": "",  # Content would be populated by document generation service
                    "type": "system",
                    "storagePath": storage_path,
                }
            )
            .execute()
        )

        data = response.data or []
        if not data:
            raise ValueError("Template insert returned no data.")

        inserted = True
        upload_template_document(owner_auth_id, template_id, extension, file_content)
    except Exception as exc:
        # Compensate by deleting inserted row if storage upload fails.
        if inserted:
            try:
                supabase.table(table_name).delete().eq("id", template_id).execute()
            except Exception:
                pass

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to create template: {exc}",
        ) from exc

    created = data[0]
    return DocumentResponse(
        id=created["id"],
        tenant_id=created["tenant_id"],
        title=created.get("name", ""),
        status="template",
        file_url=None,
        storage_path=created["storagePath"],
        created_at=created["created_at"],
    )
