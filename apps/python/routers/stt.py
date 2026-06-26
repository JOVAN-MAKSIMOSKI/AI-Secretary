"""STT router — POST /stt/transcribe (agent-service only, protected by service secret)."""

import logging
import os
import tempfile

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from slowapi import Limiter
from slowapi.util import get_remote_address

from models.stt import TranscribeResponse
from services.auth import verify_service_secret
from stt.whisper import model

limiter = Limiter(key_func=get_remote_address)
router = APIRouter(prefix="/stt", tags=["stt"])
logger = logging.getLogger(__name__)

_SAFE_AUDIO_SUFFIXES = {".webm", ".ogg", ".mp4", ".wav", ".flac", ".aac", ".mp3"}
_AUDIO_MAX_BYTES = 25 * 1024 * 1024  # 25 MB


@router.post("/transcribe", response_model=TranscribeResponse)
@limiter.limit("10/minute")
async def transcribe(
    request: Request,
    audio: UploadFile = File(...),
    language: str = Form("mk"),
    _service: None = Depends(verify_service_secret),
) -> TranscribeResponse:
    """Transcribe audio using faster-whisper.

    Internal endpoint — only callable from the agent service via X-Service-Secret.
    """
    # Read in chunks and abort once the cap is exceeded, so an oversized upload never
    # gets fully buffered into memory before rejection.
    content = bytearray()
    while chunk := await audio.read(1024 * 1024):
        content.extend(chunk)
        if len(content) > _AUDIO_MAX_BYTES:
            raise HTTPException(status_code=413, detail="Audio file too large. Maximum 25 MB.")

    raw_suffix = os.path.splitext(audio.filename or "")[1].lower()
    suffix = raw_suffix if raw_suffix in _SAFE_AUDIO_SUFFIXES else ".webm"

    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        segments, info = model.transcribe(
            tmp_path,
            language=language,  # Caller-supplied; defaults to Macedonian
            beam_size=5,
            vad_filter=True,    # Strip silence before transcribing
        )
        text = " ".join(segment.text for segment in segments)
        return TranscribeResponse(
            text=text.strip(),
            language=info.language,
            duration=info.duration,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Transcription failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Transcription failed.") from exc
    finally:
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)
