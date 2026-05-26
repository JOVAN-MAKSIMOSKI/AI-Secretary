"""Document generation router for invoices, offers, and templates."""

from io import BytesIO
from typing import Optional
from uuid import UUID, uuid4
from datetime import datetime

from fastapi import APIRouter, HTTPException, status, UploadFile, Form, File
from fastapi.responses import StreamingResponse

from models.documents import DocumentResponse
from services.excel import fetch_invoice_template_payload, fetch_offer_template_payload
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
    owner_auth_id: UUID = Form(...),
) -> StreamingResponse:
    """Fetch the stored invoice template bytes and stream them back."""
    owner_auth_id_str = str(owner_auth_id)

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
    owner_auth_id: UUID = Form(...),
) -> StreamingResponse:
    """Fetch the stored offer template bytes and stream them back."""
    owner_auth_id_str = str(owner_auth_id)

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
    tenant_id: UUID = Form(...),
    name: str = Form(...),
    doc_type: str = Form(...),
    extension: str = Form(...),
    file: UploadFile = File(...),
) -> DocumentResponse:
    """Upload and save a document template (invoice or offer)."""
    tenant_id_str = str(tenant_id)

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
