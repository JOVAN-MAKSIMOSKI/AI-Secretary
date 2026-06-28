"""TTS router — POST /tts/speak (agent-service only, protected by service secret)."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from slowapi import Limiter
from slowapi.util import get_remote_address

from models.tts import SpeakRequest
from services.auth import verify_service_secret
from services.audio.pipeline import synthesize_ulaw

limiter = Limiter(key_func=get_remote_address)
router = APIRouter(prefix="/tts", tags=["tts"])
logger = logging.getLogger(__name__)


@router.post("/speak")
@limiter.limit("30/minute")
async def speak(
    request: Request,
    payload: SpeakRequest,
    _service: None = Depends(verify_service_secret),
) -> Response:
    """Synthesize text to speech using the azure_rvc pipeline.

    Returns raw µ-law audio at 8 kHz (audio/basic) — Twilio <Play> native format.
    Internal endpoint — callable only from the agent service via X-Service-Secret.
    """
    try:
        ulaw_bytes = synthesize_ulaw(payload.text, voice=payload.voice)
    except RuntimeError as exc:
        logger.error("TTS synthesis configuration error: %s", exc)
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.error("TTS synthesis failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="TTS synthesis failed.") from exc

    return Response(content=ulaw_bytes, media_type="audio/basic")
