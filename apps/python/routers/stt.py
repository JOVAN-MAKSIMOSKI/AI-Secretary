import os
import tempfile

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from models.stt import TranscribeResponse
from stt.whisper import model

router = APIRouter(prefix="/stt", tags=["stt"])


@router.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(
    tenant_id: str = Form(...),
    audio: UploadFile = File(...),
):
    if not tenant_id or not isinstance(tenant_id, str):
        raise HTTPException(status_code=400, detail="Invalid tenant_id")

    suffix = os.path.splitext(audio.filename or ".webm")[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await audio.read())
        tmp_path = tmp.name

    try:
        segments, info = model.transcribe(
            tmp_path,
            language="mk",   # Force Macedonian — never auto-detect
            beam_size=5,
            vad_filter=True, # Strip silence before transcribing
        )
        text = " ".join(segment.text for segment in segments)
        return TranscribeResponse(
            text=text.strip(),
            language=info.language,
            duration=info.duration,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}") from exc
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
