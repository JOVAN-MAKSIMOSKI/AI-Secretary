"""Business router — POST /business/register."""

from fastapi import APIRouter, HTTPException, status

from models.business import BusinessRegisterRequest, BusinessRegisterResponse
from services.storage import supabase

router = APIRouter(prefix="/business", tags=["business"])


@router.post("/register", response_model=BusinessRegisterResponse, status_code=status.HTTP_201_CREATED)
def register_business(payload: BusinessRegisterRequest) -> BusinessRegisterResponse:
    # 1) Create the single business user in Supabase Auth (server-side admin call).
    try:
        auth_response = supabase.auth.admin.create_user(
            {
                "email": payload.email,
                "password": payload.password,
                "email_confirm": True,
            }
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to create auth user: {exc}",
        ) from exc

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
                    "phone": payload.phone,
                    "address": payload.address,
                }
            )
            .execute()
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Failed to create business: {exc}",
        ) from exc

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
        plan=created.get("plan", "free"),
        created_at=created.get("created_at"),
    )
