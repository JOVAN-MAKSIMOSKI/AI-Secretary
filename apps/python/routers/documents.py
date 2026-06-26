"""Document generation router for invoices, offers, and templates."""

import json
from io import BytesIO
from typing import Any, Optional
from uuid import UUID, uuid4
from datetime import datetime
from decimal import Decimal
import logging
import re

from fastapi import APIRouter, Depends, Header, HTTPException, status, UploadFile, Form, File
from fastapi.responses import StreamingResponse
from postgrest.exceptions import APIError

from models.documents import DocumentResponse, ExtractionRequest, ExtractionResponse, InvoiceRequest
from services.file_safety import UnsafeFileError, validate_ooxml
from langchain import run_calendar_event_extraction, run_offer_extraction
from services.invoices.excel import (
    extract_invoice_fields_from_message,
    fetch_invoice_template_payload,
    fetch_offer_template_payload,
    fetch_business_values,
    render_invoice_template_bytes,
)
from services.invoices.invoice_text import amount_to_macedonian_text
from services.auth import get_current_user_id, get_current_user_id_or_service
from services.storage import (
    supabase,
    upload_invoice_document,
    upload_template_document,
)

router = APIRouter(prefix="/documents", tags=["documents"])
logger = logging.getLogger(__name__)
_UNKNOWN_COLUMN_PATTERN = re.compile(r"Could not find the '([^']+)' column", re.IGNORECASE)
# Matches the compressed-size cap enforced by validate_ooxml; used to abort an oversized
# template upload before it is fully buffered into memory.
_TEMPLATE_MAX_BYTES = 10 * 1024 * 1024


def _extract_unknown_column_name(exc: Exception) -> str | None:
    if isinstance(exc, APIError):
        payload = getattr(exc, "json", None)
        if isinstance(payload, dict):
            message = payload.get("message")
            if isinstance(message, str):
                match = _UNKNOWN_COLUMN_PATTERN.search(message)
                if match:
                    return match.group(1)

    match = _UNKNOWN_COLUMN_PATTERN.search(str(exc))
    if match:
        return match.group(1)

    return None


def _insert_invoice_with_schema_fallback(insert_data: dict[str, Any]) -> None:
    payload = dict(insert_data)

    while True:
        try:
            supabase.table("invoices").insert(payload).execute()
            return
        except Exception as exc:
            unknown_column = _extract_unknown_column_name(exc)
            if unknown_column is None or unknown_column not in payload:
                raise

            # Schema drift: the deployed DB is behind the local Prisma schema.
            # Log loudly so this is never silent.
            logger.warning(
                "Schema drift detected — dropping unknown column '%s' from invoice INSERT. "
                "Apply the pending Prisma migration to fix this.",
                unknown_column,
            )
            payload.pop(unknown_column, None)


def _update_invoice_with_schema_fallback(
    invoice_id: str,
    tenant_id: str,
    update_data: dict[str, Any],
) -> None:
    payload = dict(update_data)

    while True:
        try:
            (
                supabase.table("invoices")
                .update(payload)
                .eq("id", invoice_id)
                .eq("tenant_id", tenant_id)
                .execute()
            )
            return
        except Exception as exc:
            unknown_column = _extract_unknown_column_name(exc)
            if unknown_column is None or unknown_column not in payload:
                raise

            # Schema drift: the deployed DB is behind the local Prisma schema.
            logger.warning(
                "Schema drift detected — dropping unknown column '%s' from invoice UPDATE. "
                "Apply the pending Prisma migration to fix this.",
                unknown_column,
            )
            payload.pop(unknown_column, None)


def _increment_business_invoice_counter(owner_auth_id: str) -> None:
    """Increment the per-business invoice counter after successful invoice creation."""
    business_response = (
        supabase.table("businesses")
        .select("invoice_counter")
        .eq("owner_auth_id", owner_auth_id)
        .limit(1)
        .execute()
    )
    rows = business_response.data or []
    if not rows:
        raise ValueError(f"Business for owner '{owner_auth_id}' not found.")

    current_counter = rows[0].get("invoice_counter")
    next_counter = int(current_counter or 0) + 1

    (
        supabase.table("businesses")
        .update({"invoice_counter": next_counter})
        .eq("owner_auth_id", owner_auth_id)
        .execute()
    )


@router.post("/extract", response_model=ExtractionResponse, status_code=status.HTTP_200_OK)
def extract_from_raw_message(
    payload: ExtractionRequest,
    current_user_id: str = Depends(get_current_user_id_or_service),
) -> ExtractionResponse:
    """Run the LangChain extraction chain against the raw message text."""
    try:
        extracted = extract_invoice_fields_from_message(
            payload.message,
            owner_auth_id=current_user_id,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Extraction chain failed: {exc}",
        ) from exc

    logger.info(
        "Invoice extraction payload user_id=%s extracted=%s",
        current_user_id,
        json.dumps(extracted, ensure_ascii=True),
    )

    return ExtractionResponse(extracted=extracted)


@router.post("/extract-calendar", response_model=ExtractionResponse, status_code=status.HTTP_200_OK)
def extract_calendar_from_raw_message(
    payload: ExtractionRequest,
    current_user_id: str = Depends(get_current_user_id_or_service),
) -> ExtractionResponse:
    """Run the calendar extraction chain against the raw message text."""
    try:
        extracted = run_calendar_event_extraction(payload.message)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Calendar extraction chain failed: {exc}",
        ) from exc

    logger.info(
        "Calendar extraction payload user_id=%s extracted=%s",
        current_user_id,
        json.dumps(extracted, ensure_ascii=True),
    )

    return ExtractionResponse(extracted=extracted)


@router.post("/extract-offer", response_model=ExtractionResponse, status_code=status.HTTP_200_OK)
def extract_offer_from_raw_message(
    payload: ExtractionRequest,
    current_user_id: str = Depends(get_current_user_id_or_service),
) -> ExtractionResponse:
    """Run the offer extraction chain against the raw message text."""
    try:
        extracted = run_offer_extraction(payload.message)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Offer extraction chain failed: {exc}",
        ) from exc

    logger.info(
        "Offer extraction payload user_id=%s extracted=%s",
        current_user_id,
        json.dumps(extracted, ensure_ascii=True),
    )

    return ExtractionResponse(extracted=extracted)


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
    current_user_id: str = Depends(get_current_user_id_or_service),
    x_invoice_origin: str = Header(default="manual"),
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
    rendered_template_bytes: bytes | None = None

    if payload is not None:
        client_result = (
            supabase.table("clients")
            .select("id, name, tax_number, address, city")
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
        invoice_month = payload.invoice_date.month
        invoice_year = payload.invoice_date.year

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
        }

        existing_rows = existing_invoice.data or []
        if existing_rows:
            invoice_id = existing_rows[0]["id"]
            update_data = dict(invoice_common_data)
            # If the invoice is being re-generated via a voice call, stamp it so it
            # appears in the dashboard's "Call Invoices" card regardless of its previous origin.
            if x_invoice_origin == "call":
                update_data["origin"] = "call"
            _update_invoice_with_schema_fallback(
                invoice_id=invoice_id,
                tenant_id=resolved_owner_auth_id,
                update_data=update_data,
            )
        else:
            invoice_id = str(uuid4())
            storage_path = f"{resolved_owner_auth_id}/invoices/{invoice_id}.xlsx"
            origin = x_invoice_origin if x_invoice_origin in ("manual", "call") else "manual"
            insert_data = {
                "id": invoice_id,
                "storagePath": storage_path,
                "origin": origin,
                **invoice_common_data,
            }
            _insert_invoice_with_schema_fallback(insert_data)
            _increment_business_invoice_counter(resolved_owner_auth_id)

        business_values = fetch_business_values(resolved_owner_auth_id)
        invoice_render_values = {
            "invoice_number": payload.invoice_number,
            "invoice_type": payload.invoice_type,
            "invoice_date": payload.invoice_date.isoformat(),
            "value_date": payload.value_date.isoformat(),
            "invoice_month": invoice_month,
            "invoice_year": invoice_year,
            "consignment_note_number": payload.consignment_note_number,
            "order_number": payload.order_number,
            "client_name": payload.client_name,
            "client_tax_number": payload.client_tax_number,
            "description": payload.description,
            "units": payload.units,
            "price_per_unit": payload.price_per_unit,
            "tax_percentage": payload.tax_percentage,
            "tax_total": tax_total,
            "price_before_tax": payload.price_before_tax,
            "price_after_tax": payload.price_after_tax,
            "price_after_tax_text": generated_price_after_tax_text,
            "client": {
                "name": payload.client_name,
                "address": client_row.get("address"),
                "city": client_row.get("city"),
                "taxnumber": payload.client_tax_number,
            },
            "business": business_values.get("business", {}),
        }

    try:
        template_payload = fetch_invoice_template_payload(
            resolved_owner_auth_id,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc

    if payload is not None:
        rendered_template_bytes = render_invoice_template_bytes(
            template_payload["template_bytes"],
            invoice_render_values,
        )
        try:
            upload_invoice_document(resolved_owner_auth_id, invoice_id, rendered_template_bytes)
        except Exception:
            logger.exception("Storage upload failed for invoice %s — continuing with stream", invoice_id)

    filename = f"{template_payload['template_name']}.xlsx"
    return StreamingResponse(
        BytesIO(rendered_template_bytes or template_payload["template_bytes"]),
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

    # Generate template ID and read file.
    # Read in chunks and abort once the cap is exceeded, so an oversized upload never
    # gets fully buffered into memory before validate_ooxml runs.
    template_id = str(uuid4())
    file_bytes = bytearray()
    while True:
        chunk = file.file.read(1024 * 1024)
        if not chunk:
            break
        file_bytes.extend(chunk)
        if len(file_bytes) > _TEMPLATE_MAX_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"File too large. Maximum {_TEMPLATE_MAX_BYTES // (1024 * 1024)} MB.",
            )
    file_content = bytes(file_bytes)

    try:
        validate_ooxml(file_content)
    except UnsafeFileError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

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
