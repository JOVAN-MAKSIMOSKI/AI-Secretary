"""Firms router secured by authenticated owner identity."""

import uuid as _uuid_mod
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status

from models.firm import FirmCreateRequest, FirmResponse, FirmUpdateRequest
from services.auth import get_current_user_id
from services.errors import safe_http_error
from services.storage import supabase

router = APIRouter(prefix="/firms", tags=["firms"])


def _normalize_firm_name(name: str) -> str:
    return " ".join(name.strip().split()).casefold()


def _require_uuid(value: str, label: str) -> None:
    try:
        _uuid_mod.UUID(value)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{label} must be a valid UUID.",
        )


def require_tenant_owner_auth_id(tenant_identifier: str) -> str:
    # Canonical tenant identity is the authenticated user id (owner_auth_id).
    business = (
        supabase.table("businesses")
        .select("id, owner_auth_id")
        .eq("owner_auth_id", tenant_identifier)
        .limit(1)
        .execute()
    )

    if not business.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Business '{tenant_identifier}' not found.",
        )

    return business.data[0]["owner_auth_id"]


@router.post("", response_model=FirmResponse, status_code=status.HTTP_201_CREATED)
def create_firm(
    payload: FirmCreateRequest,
    current_user_id: str = Depends(get_current_user_id),
) -> FirmResponse:
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)
    normalized_name = _normalize_firm_name(payload.name)

    # Prevent duplicate firm names under the same tenant.
    existing_firms = (
        supabase.table("firms")
        .select("id, name")
        .eq("tenant_id", owner_auth_id)
        .execute()
    )
    existing_rows = existing_firms.data or []
    has_duplicate_name = any(
        _normalize_firm_name(str(row.get("name", ""))) == normalized_name
        for row in existing_rows
    )

    if has_duplicate_name:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Firm name '{payload.name.strip()}' already exists for this tenant.",
        )

    try:
        response = (
            supabase.table("firms")
            .insert(
                {
                    "tenant_id": owner_auth_id,
                    "name": payload.name.strip(),
                    "email": payload.email,
                    "city": payload.city.strip() if payload.city else None,
                    "tax_number": payload.tax_number.strip() if payload.tax_number else None,
                    "phone": payload.phone,
                    "address": payload.address,
                    "notes": payload.notes,
                    "permit_number": payload.permit_number.strip() if payload.permit_number else None,
                }
            )
            .execute()
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to create firm.") from exc

    data = response.data or []
    if not data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Firm insert returned no data.",
        )

    created = data[0]
    return FirmResponse(
        id=created["id"],
        tenant_id=created["tenant_id"],
        name=created["name"],
        email=created["email"],
        city=created.get("city"),
        tax_number=created.get("tax_number"),
        phone=created.get("phone"),
        address=created.get("address"),
        notes=created.get("notes"),
        permit_number=created.get("permit_number"),
        created_at=created.get("created_at"),
    )


@router.get("", response_model=List[FirmResponse], status_code=status.HTTP_200_OK)
def get_firms_by_tenant(current_user_id: str = Depends(get_current_user_id)) -> List[FirmResponse]:
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)

    try:
        response = (
            supabase.table("firms")
            .select("*")
            .eq("tenant_id", owner_auth_id)
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to query firms.") from exc

    return [
        FirmResponse(
            id=row["id"],
            tenant_id=row["tenant_id"],
            name=row["name"],
            email=row["email"],
            city=row.get("city"),
            tax_number=row.get("tax_number"),
            phone=row.get("phone"),
            address=row.get("address"),
            notes=row.get("notes"),
            permit_number=row.get("permit_number"),
            created_at=row.get("created_at"),
        )
        for row in (response.data or [])
    ]


@router.put("/{firm_id}", response_model=FirmResponse, status_code=status.HTTP_200_OK)
def update_firm_by_id(
    firm_id: str,
    payload: FirmUpdateRequest,
    current_user_id: str = Depends(get_current_user_id),
) -> FirmResponse:
    _require_uuid(firm_id, "firm_id")
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)

    try:
        response = (
            supabase.table("firms")
            .update(
                {
                    "name": payload.name,
                    "email": payload.email,
                    "city": payload.city.strip() if payload.city else None,
                    "tax_number": payload.tax_number.strip() if payload.tax_number else None,
                    "phone": payload.phone,
                    "address": payload.address,
                    "notes": payload.notes,
                    "permit_number": payload.permit_number.strip() if payload.permit_number else None,
                }
            )
            .eq("id", firm_id)
            .eq("tenant_id", owner_auth_id)
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to update firm.") from exc

    updated_rows = response.data or []
    if not updated_rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Firm not found for this tenant.",
        )

    updated = updated_rows[0]
    return FirmResponse(
        id=updated["id"],
        tenant_id=updated["tenant_id"],
        name=updated["name"],
        email=updated["email"],
        city=updated.get("city"),
        tax_number=updated.get("tax_number"),
        phone=updated.get("phone"),
        address=updated.get("address"),
        notes=updated.get("notes"),
        permit_number=updated.get("permit_number"),
        created_at=updated.get("created_at"),
    )


@router.delete("/{firm_id}", status_code=status.HTTP_200_OK)
def delete_firm_by_id(
    firm_id: str,
    current_user_id: str = Depends(get_current_user_id),
) -> dict:
    _require_uuid(firm_id, "firm_id")
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)

    try:
        response = (
            supabase.table("firms")
            .delete()
            .eq("id", firm_id)
            .eq("tenant_id", owner_auth_id)
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to delete firm.") from exc

    deleted_rows = response.data or []
    if not deleted_rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Firm not found for this tenant.",
        )

    return {"id": firm_id, "status": "deleted"}
