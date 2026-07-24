"""Disposal places router secured by authenticated owner identity.

Mirrors routers/firms.py — tenant-scoped CRUD over the disposal_places table.
Reuses the tenant-resolution and UUID guards defined there rather than duplicating.
"""

from typing import List

from fastapi import APIRouter, Depends, HTTPException, status

from models.disposal_place import (
    DisposalPlaceCreateRequest,
    DisposalPlaceResponse,
    DisposalPlaceUpdateRequest,
)
from routers.firms import _require_uuid, require_tenant_owner_auth_id
from services.auth import get_current_user_id
from services.errors import safe_http_error
from services.storage import supabase

router = APIRouter(prefix="/disposal-places", tags=["disposal-places"])


def _to_response(row: dict) -> DisposalPlaceResponse:
    return DisposalPlaceResponse(
        id=row["id"],
        tenant_id=row["tenant_id"],
        name=row["name"],
        address=row["address"],
        place=row["place"],
        email=row["email"],
        phone_number=row["phone_number"],
        created_at=row.get("created_at"),
    )


@router.post("", response_model=DisposalPlaceResponse, status_code=status.HTTP_201_CREATED)
def create_disposal_place(
    payload: DisposalPlaceCreateRequest,
    current_user_id: str = Depends(get_current_user_id),
) -> DisposalPlaceResponse:
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)

    try:
        response = (
            supabase.table("disposal_places")
            .insert(
                {
                    "tenant_id": owner_auth_id,
                    "name": payload.name.strip(),
                    "address": payload.address.strip(),
                    "place": payload.place.strip(),
                    "email": payload.email,
                    "phone_number": payload.phone_number.strip(),
                }
            )
            .execute()
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to create disposal place.") from exc

    data = response.data or []
    if not data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Disposal place insert returned no data.",
        )

    return _to_response(data[0])


@router.get("", response_model=List[DisposalPlaceResponse], status_code=status.HTTP_200_OK)
def get_disposal_places_by_tenant(
    current_user_id: str = Depends(get_current_user_id),
) -> List[DisposalPlaceResponse]:
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)

    try:
        response = (
            supabase.table("disposal_places")
            .select("*")
            .eq("tenant_id", owner_auth_id)
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to query disposal places.") from exc

    return [_to_response(row) for row in (response.data or [])]


@router.put("/{disposal_place_id}", response_model=DisposalPlaceResponse, status_code=status.HTTP_200_OK)
def update_disposal_place_by_id(
    disposal_place_id: str,
    payload: DisposalPlaceUpdateRequest,
    current_user_id: str = Depends(get_current_user_id),
) -> DisposalPlaceResponse:
    _require_uuid(disposal_place_id, "disposal_place_id")
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)

    try:
        response = (
            supabase.table("disposal_places")
            .update(
                {
                    "name": payload.name.strip(),
                    "address": payload.address.strip(),
                    "place": payload.place.strip(),
                    "email": payload.email,
                    "phone_number": payload.phone_number.strip(),
                }
            )
            .eq("id", disposal_place_id)
            .eq("tenant_id", owner_auth_id)
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to update disposal place.") from exc

    updated_rows = response.data or []
    if not updated_rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Disposal place not found for this tenant.",
        )

    return _to_response(updated_rows[0])


@router.delete("/{disposal_place_id}", status_code=status.HTTP_200_OK)
def delete_disposal_place_by_id(
    disposal_place_id: str,
    current_user_id: str = Depends(get_current_user_id),
) -> dict:
    _require_uuid(disposal_place_id, "disposal_place_id")
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)

    try:
        response = (
            supabase.table("disposal_places")
            .delete()
            .eq("id", disposal_place_id)
            .eq("tenant_id", owner_auth_id)
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to delete disposal place.") from exc

    deleted_rows = response.data or []
    if not deleted_rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Disposal place not found for this tenant.",
        )

    return {"id": disposal_place_id, "status": "deleted"}
