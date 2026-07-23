"""Authentication helpers for FastAPI routes backed by Supabase Auth."""

import logging
import os
import secrets

from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from services.storage import supabase

logger = logging.getLogger(__name__)

bearer_scheme = HTTPBearer(auto_error=True)


def get_current_user_id(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> str:
    token = credentials.credentials
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token.",
        )

    try:
        auth_response = supabase.auth.get_user(token)
    except Exception as exc:
        logger.warning("Token validation failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired access token.",
        ) from exc

    user = getattr(auth_response, "user", None)
    user_id = getattr(user, "id", None)

    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired access token.",
        )

    return str(user_id)


def get_current_user_id_or_service(
    x_service_secret: str = Header(default=""),
    x_tenant_id: str = Header(default=""),
    credentials: HTTPAuthorizationCredentials | None = Depends(HTTPBearer(auto_error=False)),
) -> str:
    """Dual-auth dependency: accepts either a Supabase Bearer JWT (web clients) or
    X-Service-Secret + X-Tenant-Id headers (internal service-to-service calls, e.g. Twilio).
    Returns the resolved user/owner_auth_id in both cases."""
    expected = os.environ.get("INTER_SERVICE_SECRET", "")
    if x_service_secret and expected and secrets.compare_digest(x_service_secret, expected):
        if not x_tenant_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="X-Tenant-Id required for service calls.")
        return x_tenant_id

    # Fall back to Bearer JWT validation.
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token.")
    token = credentials.credentials
    try:
        auth_response = supabase.auth.get_user(token)
    except Exception as exc:
        logger.warning("Token validation failed: %s", exc)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired access token.") from exc

    user = getattr(auth_response, "user", None)
    user_id = getattr(user, "id", None)
    if not user_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired access token.")
    return str(user_id)


def verify_service_secret(x_service_secret: str = Header(default="")) -> None:
    """Dependency for endpoints called only by the agent service (not the browser).

    Validates the X-Service-Secret header against the INTER_SERVICE_SECRET env var
    using a constant-time comparison to prevent timing attacks.
    """
    expected = os.environ.get("INTER_SERVICE_SECRET", "")
    if not expected:
        logger.error("INTER_SERVICE_SECRET is not configured — rejecting inter-service request")
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Service not configured.")
    if not secrets.compare_digest(x_service_secret, expected):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden.")