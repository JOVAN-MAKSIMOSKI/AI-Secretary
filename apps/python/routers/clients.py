"""Clients router secured by authenticated owner identity."""

import uuid as _uuid_mod
from typing import List

from fastapi import APIRouter, Depends, HTTPException, status

from models.client import ClientCreateRequest, ClientResponse, ClientUpdateRequest
from services.auth import get_current_user_id
from services.errors import safe_http_error
from services.storage import supabase

router = APIRouter(prefix="/clients", tags=["clients"])


def _normalize_client_name(name: str) -> str:
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


@router.post("", response_model=ClientResponse, status_code=status.HTTP_201_CREATED)
def create_client(
    payload: ClientCreateRequest,
    current_user_id: str = Depends(get_current_user_id),
) -> ClientResponse:
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)
    normalized_name = _normalize_client_name(payload.name)

    # Prevent duplicate client names under the same tenant.
    existing_clients = (
        supabase.table("clients")
        .select("id, name")
        .eq("tenant_id", owner_auth_id)
        .execute()
    )
    existing_rows = existing_clients.data or []
    has_duplicate_name = any(
        _normalize_client_name(str(row.get("name", ""))) == normalized_name
        for row in existing_rows
    )

    if has_duplicate_name:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Client name '{payload.name.strip()}' already exists for this tenant.",
        )

    try:
        response = (
            supabase.table("clients")
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
                }
            )
            .execute()
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to create client.") from exc

    data = response.data or []
    if not data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Client insert returned no data.",
        )

    created = data[0]
    return ClientResponse(
        id=created["id"],
        tenant_id=created["tenant_id"],
        name=created["name"],
        email=created["email"],
        city=created.get("city"),
        tax_number=created.get("tax_number"),
        phone=created.get("phone"),
        address=created.get("address"),
        notes=created.get("notes"),
        created_at=created.get("created_at"),
    )


@router.get("", response_model=List[ClientResponse], status_code=status.HTTP_200_OK)
def get_clients_by_tenant(current_user_id: str = Depends(get_current_user_id)) -> List[ClientResponse]:
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)

    try:
        response = (
            supabase.table("clients")
            .select("*")
            .eq("tenant_id", owner_auth_id)
            .order("created_at", desc=True)
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to query clients.") from exc

    return [
        ClientResponse(
            id=row["id"],
            tenant_id=row["tenant_id"],
            name=row["name"],
            email=row["email"],
            city=row.get("city"),
            tax_number=row.get("tax_number"),
            phone=row.get("phone"),
            address=row.get("address"),
            notes=row.get("notes"),
            created_at=row.get("created_at"),
        )
        for row in (response.data or [])
    ]


@router.put("/{client_id}", response_model=ClientResponse, status_code=status.HTTP_200_OK)
def update_client_by_id(
    client_id: str,
    payload: ClientUpdateRequest,
    current_user_id: str = Depends(get_current_user_id),
) -> ClientResponse:
    _require_uuid(client_id, "client_id")
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)

    try:
        response = (
            supabase.table("clients")
            .update(
                {
                    "name": payload.name,
                    "email": payload.email,
                    "city": payload.city.strip() if payload.city else None,
                    "tax_number": payload.tax_number.strip() if payload.tax_number else None,
                    "phone": payload.phone,
                    "address": payload.address,
                    "notes": payload.notes,
                }
            )
            .eq("id", client_id)
            .eq("tenant_id", owner_auth_id)
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to update client.") from exc

    updated_rows = response.data or []
    if not updated_rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Client not found for this tenant.",
        )

    updated = updated_rows[0]
    return ClientResponse(
        id=updated["id"],
        tenant_id=updated["tenant_id"],
        name=updated["name"],
        email=updated["email"],
        city=updated.get("city"),
        tax_number=updated.get("tax_number"),
        phone=updated.get("phone"),
        address=updated.get("address"),
        notes=updated.get("notes"),
        created_at=updated.get("created_at"),
    )


@router.delete("/{client_id}", status_code=status.HTTP_200_OK)
def delete_client_by_id(
    client_id: str,
    current_user_id: str = Depends(get_current_user_id),
) -> dict:
    _require_uuid(client_id, "client_id")
    owner_auth_id = require_tenant_owner_auth_id(current_user_id)

    try:
        response = (
            supabase.table("clients")
            .delete()
            .eq("id", client_id)
            .eq("tenant_id", owner_auth_id)
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to delete client.") from exc

    deleted_rows = response.data or []
    if not deleted_rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Client not found for this tenant.",
        )

    return {"id": client_id, "status": "deleted"}
