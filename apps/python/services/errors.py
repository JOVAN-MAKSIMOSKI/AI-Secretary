"""Safe error helpers — log full exception details server-side, return only generic messages to callers."""

import logging

from fastapi import HTTPException

logger = logging.getLogger(__name__)


def safe_http_error(exc: Exception, status_code: int, user_message: str) -> HTTPException:
    """Log exc with full traceback server-side and return an HTTPException with only user_message."""
    logger.error("Internal error (status=%d): %s", status_code, exc, exc_info=True)
    return HTTPException(status_code=status_code, detail=user_message)
