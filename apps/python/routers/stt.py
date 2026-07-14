"""STT router — POST /stt/transcribe (agent-service only, protected by service secret)."""

import logging
import os
import re
import tempfile
import time

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

# Lower beam width = faster decode. Default 5 favours accuracy (best for Macedonian);
# set STT_BEAM_SIZE=1 (greedy) during English testing for a large speedup.
try:
    _BEAM_SIZE = max(1, int(os.getenv("STT_BEAM_SIZE", "5")))
except ValueError:
    _BEAM_SIZE = 5

# Whisper often groups long spoken digit sequences with hyphens (e.g. an order number
# dictated as "032832832" comes back as "032-832-832"). Downstream number parsing treats
# an internal hyphen as invalid, so a single number gets dropped. Merge hyphen-joined
# digit groups back into one contiguous number — but leave ISO dates (YYYY-MM-DD) intact,
# since collapsing those would corrupt any date the invoice flow depends on.
_HYPHENATED_DIGIT_GROUPS = re.compile(r"\d+(?:-\d+)+")
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _merge_hyphenated_digit_groups(text: str) -> str:
    def _replace(match: re.Match[str]) -> str:
        token = match.group(0)
        if _ISO_DATE.match(token):
            return token
        return token.replace("-", "")

    return _HYPHENATED_DIGIT_GROUPS.sub(_replace, text)


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

        transcribe_start = time.monotonic()
        segments, info = model.transcribe(
            tmp_path,
            language=language,  # Caller-supplied; defaults to Macedonian
            beam_size=_BEAM_SIZE,
            vad_filter=True,                 # Strip silence before transcribing
            condition_on_previous_text=False,  # Faster; avoids hallucination loops on short clips
        )
        text = " ".join(segment.text for segment in segments)
        # Collapse hyphen-separated digit groups so numbers stay contiguous (see helper above).
        text = _merge_hyphenated_digit_groups(text)
        # segments is a lazy generator — decode wall time is only known after it is drained.
        transcribe_ms = int((time.monotonic() - transcribe_start) * 1000)
        logger.info(
            "STT transcribe done lang=%s audio_s=%.2f wall_ms=%d rtf=%.2f beam=%d",
            info.language,
            info.duration,
            transcribe_ms,
            (transcribe_ms / 1000) / info.duration if info.duration else 0,
            _BEAM_SIZE,
        )
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
