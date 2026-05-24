"""Document generation router for invoices, offers, and templates."""

from fastapi import APIRouter, HTTPException, status, UploadFile, Form, File
from typing import Optional
from uuid import uuid4, UUID
from datetime import datetime

from models.documents import DocumentResponse
from services.excel import create_basic_workbook_bytes
from services.word import create_basic_document_bytes
from services.storage import (
    supabase,
    upload_invoice_document,
    upload_offer_document,
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


@router.post("/invoice", response_model=DocumentResponse, status_code=status.HTTP_201_CREATED)
def create_invoice(
    tenant_id: UUID = Form(...),
    client_id: UUID = Form(...),
    title: str = Form(...),
    amount: Optional[float] = Form(None),
    due_date: Optional[str] = Form(None),
) -> DocumentResponse:
    """Upload and save an invoice document."""
    tenant_id_str = str(tenant_id)
    client_id_str = str(client_id)
    parsed_due_date = _parse_optional_due_date(due_date)

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

    # Verify client exists under this tenant
    client = (
        supabase.table("clients")
        .select("id")
        .eq("id", client_id_str)
        .eq("tenant_id", owner_auth_id)
        .limit(1)
        .execute()
    )
    if not client.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Client '{client_id_str}' not found under tenant '{tenant_id_str}'.",
        )

    # Generate document ID and build invoice workbook content
    document_id = str(uuid4())
    file_content = create_basic_workbook_bytes(sheet_name="Invoice")

    storage_path = f"{owner_auth_id}/invoices/{document_id}.xlsx"
    inserted = False
    data = []

    try:
        # Insert into database first so storage objects are not orphaned if DB write fails.
        response = (
            supabase.table("invoices")
            .insert(
                {
                    "id": document_id,
                    "tenant_id": owner_auth_id,
                    "client_id": client_id_str,
                    "title": title,
                    "status": "draft",
                    "amount": amount,
                    "due_date": parsed_due_date.isoformat() if parsed_due_date else None,
                    "storagePath": storage_path,
                }
            )
            .execute()
        )

        data = response.data or []
        if not data:
            raise ValueError("Invoice insert returned no data.")

        inserted = True
        upload_invoice_document(owner_auth_id, document_id, file_content)
    except Exception as exc:
        # Compensate by deleting inserted row if storage upload fails.
        if inserted:
            try:
                supabase.table("invoices").delete().eq("id", document_id).execute()
            except Exception:
                pass

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to create invoice: {exc}",
        ) from exc

    created = data[0]
    return DocumentResponse(
        id=created["id"],
        tenant_id=created["tenant_id"],
        title=created["title"],
        status=created["status"],
        file_url=created.get("file_url"),
        storage_path=created["storagePath"],
        created_at=created["created_at"],
    )


@router.post("/offer", response_model=DocumentResponse, status_code=status.HTTP_201_CREATED)
def create_offer(
    tenant_id: UUID = Form(...),
    client_id: UUID = Form(...),
    title: str = Form(...),
    amount: Optional[float] = Form(None),
    due_date: Optional[str] = Form(None),
) -> DocumentResponse:
    """Upload and save an offer document."""
    tenant_id_str = str(tenant_id)
    client_id_str = str(client_id)
    parsed_due_date = _parse_optional_due_date(due_date)

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

    # Verify client exists under this tenant
    client = (
        supabase.table("clients")
        .select("id")
        .eq("id", client_id_str)
        .eq("tenant_id", owner_auth_id)
        .limit(1)
        .execute()
    )
    if not client.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Client '{client_id_str}' not found under tenant '{tenant_id_str}'.",
        )

    # Generate document ID and build offer document content
    document_id = str(uuid4())
    file_content = create_basic_document_bytes(doc_title=title)

    storage_path = f"{owner_auth_id}/offers/{document_id}.docx"
    inserted = False
    data = []

    try:
        # Insert into database first so storage objects are not orphaned if DB write fails.
        response = (
            supabase.table("offers")
            .insert(
                {
                    "id": document_id,
                    "tenant_id": owner_auth_id,
                    "client_id": client_id_str,
                    "title": title,
                    "status": "draft",
                    "amount": amount,
                    "due_date": parsed_due_date.isoformat() if parsed_due_date else None,
                    "storagePath": storage_path,
                }
            )
            .execute()
        )

        data = response.data or []
        if not data:
            raise ValueError("Offer insert returned no data.")

        inserted = True
        upload_offer_document(owner_auth_id, document_id, file_content)
    except Exception as exc:
        # Compensate by deleting inserted row if storage upload fails.
        if inserted:
            try:
                supabase.table("offers").delete().eq("id", document_id).execute()
            except Exception:
                pass

        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to create offer: {exc}",
        ) from exc

    created = data[0]
    return DocumentResponse(
        id=created["id"],
        tenant_id=created["tenant_id"],
        title=created["title"],
        status=created["status"],
        file_url=created.get("file_url"),
        storage_path=created["storagePath"],
        created_at=created["created_at"],
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
