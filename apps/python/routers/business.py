"""Business router — registration plus authenticated business profile routes."""

from fastapi import APIRouter, Depends, HTTPException, Request, status
from slowapi import Limiter
from slowapi.util import get_remote_address

from models.business import (
    BusinessProfileCreateRequest,
    BusinessProfileResponse,
    BusinessProfileUpdateRequest,
    BusinessRegisterRequest,
    BusinessRegisterResponse,
)
from services.auth import get_current_user_id
from services.errors import safe_http_error
from services.storage import supabase

limiter = Limiter(key_func=get_remote_address)
router = APIRouter(prefix="/business", tags=["business"])


def _get_business_by_owner_auth_id(owner_auth_id: str):
    response = (
        supabase.table("businesses")
        # NOTE: no `plan` here — the live businesses table has no such column
        # (schema drift vs prisma/schema.prisma); selecting it 42703s the query.
        # Responses default plan to "free" via .get().
        .select("id, owner_auth_id, name, email, tax_number, transaction_account, depositor, phone, address, logo_url, tenantprofilecontext, created_at")
        .eq("owner_auth_id", owner_auth_id)
        .limit(1)
        .execute()
    )

    rows = response.data or []
    if not rows:
        return None

    return rows[0]


@router.post("/register", response_model=BusinessRegisterResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit("3/hour")
def register_business(request: Request, payload: BusinessRegisterRequest) -> BusinessRegisterResponse:
    # 1) Create the single business user in Supabase Auth (server-side admin call).
    # This endpoint is public; abuse is mitigated by the rate limit above. email_confirm is
    # kept True to preserve the register->auto-login signup flow (SignUp.tsx). Moving to real
    # email verification requires changing that flow and configuring Supabase SMTP.
    try:
        auth_response = supabase.auth.admin.create_user(
            {
                "email": payload.email,
                "password": payload.password,
                "email_confirm": True,
            }
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to create auth user.") from exc

    user = getattr(auth_response, "user", None)
    owner_auth_id = getattr(user, "id", None)

    if not owner_auth_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Auth user was not created.",
        )

    # 2) Insert business row linked to that single auth user.
    try:
        insert_response = (
            supabase.table("businesses")
            .insert(
                {
                    "owner_auth_id": owner_auth_id,
                    "name": payload.name,
                    "email": payload.email,
                    "tax_number": payload.tax_number,
                    "transaction_account": payload.transaction_account,
                    "depositor": payload.depositor,
                    "phone": payload.phone,
                    "address": payload.address,
                }
            )
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to create business.") from exc

    data = insert_response.data or []
    if not data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Business insert returned no data.",
        )

    created = data[0]
    return BusinessRegisterResponse(
        business_id=created["id"],
        user_id=created["owner_auth_id"],
        name=created["name"],
        email=created["email"],
        tax_number=created.get("tax_number"),
        transaction_account=created.get("transaction_account"),
        depositor=created.get("depositor"),
        plan=created.get("plan", "free"),
        created_at=created.get("created_at"),
    )


@router.get("/me", response_model=BusinessProfileResponse, status_code=status.HTTP_200_OK)
def get_business_profile(current_user_id: str = Depends(get_current_user_id)) -> BusinessProfileResponse:
    try:
        business = _get_business_by_owner_auth_id(current_user_id)
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to fetch business profile.") from exc

    if not business:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Business profile not found for authenticated user.",
        )

    return BusinessProfileResponse(
        business_id=business["id"],
        owner_auth_id=business["owner_auth_id"],
        name=business["name"],
        email=business["email"],
        tax_number=business.get("tax_number"),
        transaction_account=business.get("transaction_account"),
        depositor=business.get("depositor"),
        phone=business.get("phone"),
        address=business.get("address"),
        logo_url=business.get("logo_url"),
        plan=business.get("plan", "free"),
        tenantprofilecontext=business.get("tenantprofilecontext"),
        created_at=business.get("created_at"),
    )


@router.patch("/profile", response_model=BusinessProfileResponse, status_code=status.HTTP_200_OK)
def update_business_profile(
    payload: BusinessProfileUpdateRequest,
    current_user_id: str = Depends(get_current_user_id),
) -> BusinessProfileResponse:
    """Partial update — added for the waste-law advisor so the settings page can
    store the tenant waste profile (tenantprofilecontext JSONB) alongside the
    existing business fields."""
    existing = _get_business_by_owner_auth_id(current_user_id)
    if not existing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Business profile not found for authenticated user.",
        )

    # Only fields the client actually sent are written (PATCH semantics)
    updates = payload.model_dump(exclude_unset=True)
    if "tenantprofilecontext" in updates and payload.tenantprofilecontext is not None:
        updates["tenantprofilecontext"] = payload.tenantprofilecontext.model_dump()

    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields provided to update.",
        )

    try:
        response = (
            supabase.table("businesses")
            .update(updates)
            .eq("owner_auth_id", current_user_id)
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to update business profile.") from exc

    data = response.data or []
    if not data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Business profile update returned no data.",
        )

    updated = data[0]
    return BusinessProfileResponse(
        business_id=updated["id"],
        owner_auth_id=updated["owner_auth_id"],
        name=updated["name"],
        email=updated["email"],
        tax_number=updated.get("tax_number"),
        transaction_account=updated.get("transaction_account"),
        depositor=updated.get("depositor"),
        phone=updated.get("phone"),
        address=updated.get("address"),
        logo_url=updated.get("logo_url"),
        plan=updated.get("plan", "free"),
        tenantprofilecontext=updated.get("tenantprofilecontext"),
        created_at=updated.get("created_at"),
    )


@router.post("/profile", response_model=BusinessProfileResponse, status_code=status.HTTP_201_CREATED)
def create_business_profile(
    payload: BusinessProfileCreateRequest,
    current_user_id: str = Depends(get_current_user_id),
) -> BusinessProfileResponse:
    existing = _get_business_by_owner_auth_id(current_user_id)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Business profile already exists for authenticated user.",
        )

    try:
        response = (
            supabase.table("businesses")
            .insert(
                {
                    "owner_auth_id": current_user_id,
                    "name": payload.name,
                    "email": payload.email,
                    "tax_number": payload.tax_number,
                    "transaction_account": payload.transaction_account,
                    "depositor": payload.depositor,
                    "phone": payload.phone,
                    "address": payload.address,
                    "logo_url": payload.logo_url,
                }
            )
            .execute()
        )
    except Exception as exc:
        raise safe_http_error(exc, status.HTTP_400_BAD_REQUEST, "Failed to create business profile.") from exc

    data = response.data or []
    if not data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Business profile insert returned no data.",
        )

    created = data[0]
    return BusinessProfileResponse(
        business_id=created["id"],
        owner_auth_id=created["owner_auth_id"],
        name=created["name"],
        email=created["email"],
        tax_number=created.get("tax_number"),
        transaction_account=created.get("transaction_account"),
        depositor=created.get("depositor"),
        phone=created.get("phone"),
        address=created.get("address"),
        logo_url=created.get("logo_url"),
        plan=created.get("plan", "free"),
        created_at=created.get("created_at"),
    )
