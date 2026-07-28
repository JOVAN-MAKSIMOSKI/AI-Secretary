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

from models.documents import (
    DocumentResponse,
    ExtractionRequest,
    ExtractionResponse,
    IdentificationFormRequest,
    InvoiceRequest,
    TransportFormRequest,
)
from services.file_safety import UnsafeFileError, validate_ooxml
from langchain import run_calendar_event_extraction, run_offer_extraction
from services.identification_forms.extraction import (
    extract_identification_form_fields_from_message,
)
from services.docx_render import render_docx_bytes
from services.transport_forms.extraction import (
    extract_transport_form_fields_from_message,
)
from services.invoices.excel import (
    extract_invoice_fields_from_message,
    fetch_identification_form_template_payload,
    fetch_invoice_template_payload,
    fetch_transport_form_template_payload,
    fetch_offer_template_payload,
    fetch_business_values,
    render_invoice_template_bytes,
)
from services.invoices.invoice_text import amount_to_macedonian_text
from services.auth import get_current_user_id, get_current_user_id_or_service
from services.storage import (
    supabase,
    upload_identification_form_document,
    upload_invoice_document,
    upload_template_document,
    upload_transport_form_document,
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


@router.post(
    "/extract-identification-form",
    response_model=ExtractionResponse,
    status_code=status.HTTP_200_OK,
)
def extract_identification_form_from_raw_message(
    payload: ExtractionRequest,
    current_user_id: str = Depends(get_current_user_id_or_service),
) -> ExtractionResponse:
    """Run the identification-form extraction chain against the raw message text.

    Yields the free-text/numeric fields, a snapped waste_type with derived ewc_code +
    is_hazardous, and resolved firm_id/contact_id (with firm address/permit and contact
    phone/email) when the names match stored records — mirroring how invoice extraction
    resolves firm_id. Unresolved names are returned as-is for the caller to reconcile.
    """
    try:
        extracted = extract_identification_form_fields_from_message(
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
            detail=f"Identification-form extraction chain failed: {exc}",
        ) from exc

    logger.info(
        "Identification-form extraction payload user_id=%s extracted=%s",
        current_user_id,
        json.dumps(extracted, ensure_ascii=True),
    )

    return ExtractionResponse(extracted=extracted)


@router.post(
    "/extract-transport-form",
    response_model=ExtractionResponse,
    status_code=status.HTTP_200_OK,
)
def extract_transport_form_from_raw_message(
    payload: ExtractionRequest,
    current_user_id: str = Depends(get_current_user_id_or_service),
) -> ExtractionResponse:
    """Run the transport-form extraction chain against the raw message text.

    Yields the weights/dates, a snapped waste_type with derived ewc_code + is_hazardous,
    and resolved firm_id/disposal_place_id (with firm address/city and disposal-place
    address/town) when the names match stored records. Unresolved names are returned
    as-is for the caller to reconcile.
    """
    try:
        extracted = extract_transport_form_fields_from_message(
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
            detail=f"Transport-form extraction chain failed: {exc}",
        ) from exc

    logger.info(
        "Transport-form extraction payload user_id=%s extracted=%s",
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
    # Tracks whether this request inserted a brand-new invoice row (vs. updating an
    # existing one). Only a row we created here may be rolled back on upload failure.
    inserted_new_invoice = False

    if payload is not None:
        firm_result = (
            supabase.table("firms")
            .select("id, name, tax_number, address, city")
            .eq("id", payload.firm_id)
            .eq("tenant_id", resolved_owner_auth_id)
            .limit(1)
            .execute()
        )
        if not firm_result.data:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Firm not found for this tenant.",
            )

        firm_row = firm_result.data[0]
        stored_name = str(firm_row.get("name") or "").strip()
        stored_tax_number = str(firm_row.get("tax_number") or "").strip()

        if stored_name != payload.firm_name.strip():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="firm_name does not match the selected firm.",
            )

        if stored_tax_number != payload.firm_tax_number.strip():
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="firm_tax_number does not match the selected firm.",
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
            .eq("firm_id", payload.firm_id)
            .eq("invoice_number", payload.invoice_number)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )

        invoice_common_data = {
            "tenant_id": resolved_owner_auth_id,
            "firm_id": payload.firm_id,
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
            inserted_new_invoice = True

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
            "firm_name": payload.firm_name,
            "firm_tax_number": payload.firm_tax_number,
            "description": payload.description,
            "units": payload.units,
            "price_per_unit": payload.price_per_unit,
            "tax_percentage": payload.tax_percentage,
            "tax_total": tax_total,
            "price_before_tax": payload.price_before_tax,
            "price_after_tax": payload.price_after_tax,
            "price_after_tax_text": generated_price_after_tax_text,
            "firm": {
                "name": payload.firm_name,
                "address": firm_row.get("address"),
                "city": firm_row.get("city"),
                "taxnumber": payload.firm_tax_number,
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
        except Exception as exc:
            # Twilio voice invoices are only persisted in the cloud — there is no browser
            # download to fall back on, so a failed upload must surface loudly instead of
            # silently leaving the DB row pointing at a missing file. Manual (web) invoices
            # still stream the file back, so a best-effort upload is acceptable there.
            if x_invoice_origin == "call":
                logger.exception("Storage upload failed for voice invoice %s", invoice_id)
                # Delete the row we just inserted so it cannot linger as a "ghost" invoice
                # pointing at a file that was never stored. We deliberately do NOT decrement
                # the business invoice counter — leaving a gap in numbering is harmless, while
                # rolling it back could collide with a concurrent invoice's number.
                if inserted_new_invoice:
                    try:
                        (
                            supabase.table("invoices")
                            .delete()
                            .eq("id", invoice_id)
                            .eq("tenant_id", resolved_owner_auth_id)
                            .execute()
                        )
                    except Exception:
                        logger.exception(
                            "Failed to roll back ghost invoice row %s after upload failure",
                            invoice_id,
                        )
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"Invoice {invoice_id} was generated but could not be saved to storage.",
                ) from exc
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


_DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


@router.post("/identification-form", status_code=status.HTTP_200_OK)
def create_identification_form(
    payload: IdentificationFormRequest,
    current_user_id: str = Depends(get_current_user_id_or_service),
    x_document_origin: str = Header(default="manual"),
) -> StreamingResponse:
    """Validate a confirmed identification-form payload, render the docx, persist the row,
    upload to storage, and stream the file back.

    This is the single door for both the web path (browser posts the confirmed draft here)
    and the voice path (Twilio, via X-Document-Origin: call). Pydantic
    (IdentificationFormRequest) is the authoritative gate; here we additionally re-verify
    the parties against the DB and reject a form whose required legal boxes (firm address /
    permit) would render blank. origin='call' rows surface in the dashboard's pending-call
    card because a call has no browser to receive the streamed file.
    """
    owner_auth_id = str(UUID(current_user_id))
    origin = x_document_origin if x_document_origin in ("manual", "call") else "manual"

    # Verify tenant exists by canonical tenant identity (owner_auth_id).
    business = (
        supabase.table("businesses")
        .select("owner_auth_id")
        .eq("owner_auth_id", owner_auth_id)
        .limit(1)
        .execute()
    )
    if not business.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tenant '{owner_auth_id}' not found.",
        )

    # Re-load the firm and verify tenant ownership + name match + non-blank legal boxes.
    firm_result = (
        supabase.table("firms")
        .select("id, name, address, permit_number")
        .eq("id", payload.firm_id)
        .eq("tenant_id", owner_auth_id)
        .limit(1)
        .execute()
    )
    if not firm_result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Firm not found for this tenant.",
        )
    firm_row = firm_result.data[0]

    if str(firm_row.get("name") or "").strip() != payload.firm_name.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="firm_name does not match the selected firm.",
        )

    firm_address = str(firm_row.get("address") or "").strip()
    firm_permit = str(firm_row.get("permit_number") or "").strip()
    # These are required boxes on the legal form. A firm missing either would render a
    # blank field, so reject rather than produce an incomplete document.
    if not firm_address:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The selected firm has no address; add one before generating the form.",
        )
    if not firm_permit:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The selected firm has no permit number; add one before generating the form.",
        )

    # Re-load the contact and verify it belongs to this tenant AND to the form's firm.
    contact_result = (
        supabase.table("contacts")
        .select("id, name, phone_number, email, firm_id")
        .eq("id", payload.contact_id)
        .eq("tenant_id", owner_auth_id)
        .limit(1)
        .execute()
    )
    if not contact_result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Contact not found for this tenant.",
        )
    contact_row = contact_result.data[0]
    if str(contact_row.get("firm_id") or "") != payload.firm_id:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The selected contact does not belong to the selected firm.",
        )

    # Fetch the tenant's template before writing anything so a missing template fails fast.
    try:
        template_payload = fetch_identification_form_template_payload(owner_auth_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc

    form_id = str(uuid4())
    storage_path = f"{owner_auth_id}/identification-forms/{form_id}.docx"
    title = f"Identification form {payload.date.isoformat()} — {payload.firm_name}"

    insert_data = {
        "id": form_id,
        "tenant_id": owner_auth_id,
        "firm_id": payload.firm_id,
        "contact_id": payload.contact_id,
        "waste_location": payload.waste_location,
        "is_hazardous": payload.is_hazardous,
        "waste_type": payload.waste_type,
        "ewc_code": payload.ewc_code,
        "packing_method": payload.packing_method,
        "total_weight_kg": str(payload.total_weight_kg),
        "waste_origin": payload.waste_origin,
        "waste_operation_code": payload.waste_operation_code,
        "place": payload.place,
        "date": payload.date.isoformat(),
        "storagePath": storage_path,
        "status": "draft",
        "title": title,
        "template_id": payload.template_id,
        "origin": origin,
    }

    try:
        supabase.table("identification_forms").insert(insert_data).execute()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to save identification form: {exc}",
        ) from exc

    # Values keyed to the template's placeholder tokens. Dot-path keys (firm.name, etc.)
    # match the {{firm.name}} style tokens in IdentificationFormTemplate.tokenized.docx.
    render_values = {
        "place": payload.place,
        "date": payload.date.isoformat(),
        "firm": {
            "name": payload.firm_name,
            "permit": firm_permit,
            "address": firm_address,
        },
        "wasteLocation": payload.waste_location,
        "contact": {
            "name": contact_row.get("name"),
            "phoneNumber": contact_row.get("phone_number"),
            "email": contact_row.get("email"),
        },
        "wasteDescription": payload.waste_type,
        "wasteCode": payload.ewc_code,
        "wasteMethodofPacking": payload.packing_method,
        "TotalWasteWeight": str(payload.total_weight_kg),
        "wasteOrigin": payload.waste_origin,
        "wasteOperationsCode": payload.waste_operation_code,
    }

    try:
        rendered_bytes = render_docx_bytes(
            template_payload["template_bytes"],
            render_values,
        )
    except Exception as exc:
        # Roll back the row we just inserted so it does not linger pointing at a file that
        # was never produced.
        _delete_identification_form_row(form_id, owner_auth_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to render identification form: {exc}",
        ) from exc

    try:
        upload_identification_form_document(owner_auth_id, form_id, rendered_bytes)
    except Exception as exc:
        _delete_identification_form_row(form_id, owner_auth_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Identification form {form_id} was generated but could not be saved to storage.",
        ) from exc

    logger.info(
        "Identification form generated tenant=%s form_id=%s firm_id=%s",
        owner_auth_id,
        form_id,
        payload.firm_id,
    )

    filename = f"{template_payload['template_name']}.docx"
    return StreamingResponse(
        BytesIO(rendered_bytes),
        media_type=_DOCX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _delete_identification_form_row(form_id: str, tenant_id: str) -> None:
    """Best-effort rollback of an identification-form row after a later step fails."""
    try:
        (
            supabase.table("identification_forms")
            .delete()
            .eq("id", form_id)
            .eq("tenant_id", tenant_id)
            .execute()
        )
    except Exception:
        logger.exception(
            "Failed to roll back identification-form row %s after a downstream failure",
            form_id,
        )


@router.post("/transport-form", status_code=status.HTTP_200_OK)
def create_transport_form(
    payload: TransportFormRequest,
    current_user_id: str = Depends(get_current_user_id_or_service),
    x_document_origin: str = Header(default="manual"),
) -> StreamingResponse:
    """Validate a confirmed transport-form payload, render the docx, persist the row,
    upload to storage, and stream the file back.

    The single door for both the web path (browser posts the confirmed draft here) and the
    voice path (Twilio, via X-Document-Origin: call). Pydantic (TransportFormRequest) is
    the authoritative gate; here we additionally re-verify both parties against the DB and
    reject a form whose required legal boxes would render blank. The collector is always
    the tenant itself — never chat-supplied — so its permit number is read from businesses
    and picked by is_hazardous. origin='call' rows surface in the dashboard's pending-call
    card because a call has no browser to receive the streamed file.
    """
    owner_auth_id = str(UUID(current_user_id))
    origin = x_document_origin if x_document_origin in ("manual", "call") else "manual"

    # Verify tenant exists and read the collector's permit numbers in one go: the
    # collector on this manifest is always the tenant.
    business = (
        supabase.table("businesses")
        .select("owner_auth_id, permit_number, dangerous_waste_permit_number")
        .eq("owner_auth_id", owner_auth_id)
        .limit(1)
        .execute()
    )
    if not business.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tenant '{owner_auth_id}' not found.",
        )
    business_row = business.data[0]

    # Hazardous waste must be carried under the dangerous-waste permit; ordinary waste
    # under the standard one. Rejecting a blank permit beats rendering an empty legal box.
    if payload.is_hazardous:
        collector_permit = str(business_row.get("dangerous_waste_permit_number") or "").strip()
        missing_permit_detail = (
            "This waste is hazardous but your business has no dangerous-waste permit "
            "number; add one in Settings before generating the form."
        )
    else:
        collector_permit = str(business_row.get("permit_number") or "").strip()
        missing_permit_detail = (
            "Your business has no waste permit number; add one in Settings before "
            "generating the form."
        )
    if not collector_permit:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=missing_permit_detail,
        )

    # Re-load the firm (waste owner) and verify tenant ownership + name match + non-blank
    # legal boxes. city renders as the handover town ("Во …") shared by sections 4 and 5.
    firm_result = (
        supabase.table("firms")
        .select("id, name, address, city")
        .eq("id", payload.firm_id)
        .eq("tenant_id", owner_auth_id)
        .limit(1)
        .execute()
    )
    if not firm_result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Firm not found for this tenant.",
        )
    firm_row = firm_result.data[0]

    if str(firm_row.get("name") or "").strip() != payload.firm_name.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="firm_name does not match the selected firm.",
        )

    firm_address = str(firm_row.get("address") or "").strip()
    firm_city = str(firm_row.get("city") or "").strip()
    if not firm_address:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The selected firm has no address; add one before generating the form.",
        )
    if not firm_city:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The selected firm has no city; add one before generating the form.",
        )

    # Re-load the disposal place (end owner) and verify tenant ownership + name match.
    # Its address/place are NOT NULL in the schema, so they need no blank guard.
    disposal_result = (
        supabase.table("disposal_places")
        .select("id, name, address, place")
        .eq("id", payload.disposal_place_id)
        .eq("tenant_id", owner_auth_id)
        .limit(1)
        .execute()
    )
    if not disposal_result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Disposal place not found for this tenant.",
        )
    disposal_row = disposal_result.data[0]

    if str(disposal_row.get("name") or "").strip() != payload.disposal_place_name.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="disposal_place_name does not match the selected disposal place.",
        )

    # Fetch the tenant's template before writing anything so a missing template fails fast.
    try:
        template_payload = fetch_transport_form_template_payload(owner_auth_id)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc

    form_id = str(uuid4())
    storage_path = f"{owner_auth_id}/transport-forms/{form_id}.docx"
    title = (
        f"Transport form {payload.collector_date.isoformat()} — "
        f"{payload.firm_name} → {payload.disposal_place_name}"
    )

    insert_data = {
        "id": form_id,
        "tenant_id": owner_auth_id,
        "firm_id": payload.firm_id,
        "disposal_place_id": payload.disposal_place_id,
        "waste_type": payload.waste_type,
        "is_hazardous": payload.is_hazardous,
        "ewc_code": payload.ewc_code,
        "waste_owner_total_kg": str(payload.waste_owner_total_kg),
        "collector_total_kg": str(payload.collector_total_kg),
        "collector_date": payload.collector_date.isoformat(),
        "end_owner_total_kg": str(payload.end_owner_total_kg),
        "end_owner_date": payload.end_owner_date.isoformat(),
        "note": payload.note,
        "storagePath": storage_path,
        "status": "draft",
        "title": title,
        "template_id": payload.template_id,
        "origin": origin,
    }

    try:
        supabase.table("transport_forms").insert(insert_data).execute()
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to save transport form: {exc}",
        ) from exc

    # Values keyed to the template's placeholder tokens (TransportFormTemplate.tokenized
    # .docx). Sections 4 and 5 share wasteCollected/wasteCollectedDate — they are the two
    # sides of one handover — and section 7's begin/end destination is derived here from
    # the two party names rather than being stored. 'tennant' keeps the template's own
    # spelling; the mapping layer absorbs it exactly as the invoice route does.
    render_values = {
        "wasteDescription": payload.waste_type,
        "wasteCode": payload.ewc_code,
        "TotalWasteWeight": str(payload.waste_owner_total_kg),
        "firm": {
            "name": payload.firm_name,
            "address": firm_address,
        },
        "wasteCollected": str(payload.collector_total_kg),
        "wasteCollectedDate": payload.collector_date.isoformat(),
        "wasteCollectedPlace": firm_city,
        "tennant": {
            "permitNumber": collector_permit,
        },
        "disposalPlace": {
            "name": payload.disposal_place_name,
            "address": disposal_row.get("address"),
            "location": disposal_row.get("place"),
        },
        "totalWasteWeightDisposed": str(payload.end_owner_total_kg),
        "dateOfDisposal": payload.end_owner_date.isoformat(),
        "note": payload.note or "",
    }

    try:
        rendered_bytes = render_docx_bytes(
            template_payload["template_bytes"],
            render_values,
        )
    except Exception as exc:
        # Roll back the row we just inserted so it does not linger pointing at a file that
        # was never produced.
        _delete_transport_form_row(form_id, owner_auth_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to render transport form: {exc}",
        ) from exc

    try:
        upload_transport_form_document(owner_auth_id, form_id, rendered_bytes)
    except Exception as exc:
        _delete_transport_form_row(form_id, owner_auth_id)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Transport form {form_id} was generated but could not be saved to storage.",
        ) from exc

    logger.info(
        "Transport form generated tenant=%s form_id=%s firm_id=%s disposal_place_id=%s",
        owner_auth_id,
        form_id,
        payload.firm_id,
        payload.disposal_place_id,
    )

    filename = f"{template_payload['template_name']}.docx"
    return StreamingResponse(
        BytesIO(rendered_bytes),
        media_type=_DOCX_MEDIA_TYPE,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def _delete_transport_form_row(form_id: str, tenant_id: str) -> None:
    """Best-effort rollback of a transport-form row after a later step fails."""
    try:
        (
            supabase.table("transport_forms")
            .delete()
            .eq("id", form_id)
            .eq("tenant_id", tenant_id)
            .execute()
        )
    except Exception:
        logger.exception(
            "Failed to roll back transport-form row %s after a downstream failure",
            form_id,
        )


@router.post("/template", response_model=DocumentResponse, status_code=status.HTTP_201_CREATED)
def create_template(
    name: str = Form(...),
    doc_type: str = Form(...),
    extension: str = Form(...),
    file: UploadFile = File(...),
    current_user_id: str = Depends(get_current_user_id),
) -> DocumentResponse:
    """Upload and save a document template (invoice, offer, or a waste form)."""
    tenant_id_str = str(UUID(current_user_id))

    # Each doc_type maps to its own per-tenant template table. Both waste forms are
    # authored in Word and rendered by the shared run-level docx renderer, so they are
    # docx-only; the invoice template is the openpyxl path and stays xlsx-only. The offer
    # template accepts either.
    template_table_by_doc_type = {
        "invoice": "templatesInvoice",
        "offer": "templatesOffer",
        "transport_form": "templatesTransportForm",
        "identification_form": "templatesIdentificationForm",
    }
    docx_only_doc_types = {"transport_form", "identification_form"}

    # Validate doc_type and extension
    if doc_type not in template_table_by_doc_type:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="doc_type must be one of "
            + ", ".join(f"'{key}'" for key in template_table_by_doc_type)
            + ".",
        )

    normalized_extension = extension.lower().lstrip(".")
    if normalized_extension not in ["xlsx", "docx"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="extension must be 'xlsx' or 'docx'.",
        )

    if doc_type in docx_only_doc_types and normalized_extension != "docx":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"doc_type '{doc_type}' only supports the 'docx' extension.",
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
    table_name = template_table_by_doc_type[doc_type]

    storage_path = (
        f"{owner_auth_id}/templates/{template_id}.{normalized_extension}"
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
