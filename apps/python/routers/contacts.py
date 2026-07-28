"""Contacts router secured by authenticated owner identity.

Mirrors routers/disposal_places.py — tenant-scoped CRUD over the contacts table.
Reuses the tenant-resolution and UUID guards defined in firms rather than duplicating.
"""

from typing import List

from fastapi import APIRouter, Depends, HTTPException, status

from models.contact import (
    ContactCreateRequest,
    ContactResponse,
    ContactUpdateRequest,
)
from routers.firms import _require_uuid, require_tenant_owner_auth_id
from services.auth import get_current_user_id
from services.errors import safe_http_error
from services.storage import supabase

router = APIRouter(prefix="/contacts", tags=["contacts"])


def _to_response(row: dict) -> ContactResponse:
    return ContactResponse(
        id=row["id"],
        tenant_id=row["tenant_id"],
        firm_id=row["firm_id"],
        name=row["name"],
        email=row["email"],
        phone_number=row["phone_number"],
        address=row["address"],
        created_at=row.get("created_at"),
    )


def _require_firm_of_tenant(firm_id: str, owner_auth_id: str) -> None:
    """Reject a contact whose firm_id is not a real firm owned by this tenant.

    A contact belongs to exactly one firm, and a caller must not attach one to a firm
    from another tenant (or a non-existent id). The DB FK would reject a bad id anyway,
    but this returns a clear 400/404 instead of a raw constraint error, and it enforces
    the tenant boundary the FK alone does not.
    """
    _require_uuid(firm_id, "firm_id")
    try:
        response = (
            supabase.table("firms")
            .select("id")
            .eq("id", firm_id)
            .eq("tenant_id", owner_auth_id)
            .limit(1)
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to verify firm.") from exc

    if not (response.data or []):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Firm not found for this tenant.",
        )


@router.post("", response_model=ContactResponse, status_code=status.HTTP_201_CREATED)
def create_contact(
    payload: ContactCreateRequest,
    current_user_id: str = Depends(get_current_user_id),
) -> ContactResponse:
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)
    _require_firm_of_tenant(payload.firm_id, owner_auth_id)

    try:
        response = (
            supabase.table("contacts")
            .insert(
                {
                    "tenant_id": owner_auth_id,
                    "firm_id": payload.firm_id,
                    "name": payload.name.strip(),
                    "email": payload.email,
                    "phone_number": payload.phone_number.strip(),
                    "address": payload.address.strip(),
                }
            )
            .execute()
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to create contact.") from exc

    data = response.data or []
    if not data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Contact insert returned no data.",
        )

    return _to_response(data[0])


@router.get("", response_model=List[ContactResponse], status_code=status.HTTP_200_OK)
def get_contacts_by_tenant(
    current_user_id: str = Depends(get_current_user_id),
) -> List[ContactResponse]:
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)

    try:
        response = (
            supabase.table("contacts")
            .select("*")
            .eq("tenant_id", owner_auth_id)
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to query contacts.") from exc

    return [_to_response(row) for row in (response.data or [])]


@router.put("/{contact_id}", response_model=ContactResponse, status_code=status.HTTP_200_OK)
def update_contact_by_id(
    contact_id: str,
    payload: ContactUpdateRequest,
    current_user_id: str = Depends(get_current_user_id),
) -> ContactResponse:
    _require_uuid(contact_id, "contact_id")
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)
    _require_firm_of_tenant(payload.firm_id, owner_auth_id)

    try:
        response = (
            supabase.table("contacts")
            .update(
                {
                    "firm_id": payload.firm_id,
                    "name": payload.name.strip(),
                    "email": payload.email,
                    "phone_number": payload.phone_number.strip(),
                    "address": payload.address.strip(),
                }
            )
            .eq("id", contact_id)
            .eq("tenant_id", owner_auth_id)
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to update contact.") from exc

    updated_rows = response.data or []
    if not updated_rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Contact not found for this tenant.",
        )

    return _to_response(updated_rows[0])


@router.delete("/{contact_id}", status_code=status.HTTP_200_OK)
def delete_contact_by_id(
    contact_id: str,
    current_user_id: str = Depends(get_current_user_id),
) -> dict:
    _require_uuid(contact_id, "contact_id")
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)

    try:
        response = (
            supabase.table("contacts")
            .delete()
            .eq("id", contact_id)
            .eq("tenant_id", owner_auth_id)
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to delete contact.") from exc

    deleted_rows = response.data or []
    if not deleted_rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Contact not found for this tenant.",
        )

    return {"id": contact_id, "status": "deleted"}
