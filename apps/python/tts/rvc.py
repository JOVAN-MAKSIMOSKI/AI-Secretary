"""RVC v2 voice-conversion singleton.

Loads the .pth weights + .index (faiss) files once when the azure_rvc provider is
active and exposes convert(wav_bytes) -> wav_bytes. Mirrors stt/whisper.py:
load once at module import (if configured), run _warmup(), reuse for every request.

Config env vars:
  RVC_MODEL_PATH   path to .pth weights file  (required when VOICE_TTS_PROVIDER=azure_rvc)
  RVC_INDEX_PATH   path to .index faiss file  (optional but improves voice similarity)
  RVC_DEVICE       cuda | cpu                 (default: cpu)
  RVC_INDEX_RATE   0.0–1.0                    (default: 0.75)
  RVC_F0_METHOD    rmvpe|crepe|harvest|dio    (default: rmvpe)
  RVC_F0_UP_KEY    semitone shift integer     (default: 0)
"""

from __future__ import annotations

import io
import logging
import os
import tempfile

logger = logging.getLogger(__name__)

RVC_MODEL_PATH = os.getenv("RVC_MODEL_PATH", "")
RVC_INDEX_PATH = os.getenv("RVC_INDEX_PATH", "")
RVC_DEVICE = os.getenv("RVC_DEVICE", "cpu")
RVC_INDEX_RATE = float(os.getenv("RVC_INDEX_RATE", "0.75"))
RVC_F0_METHOD = os.getenv("RVC_F0_METHOD", "rmvpe")
RVC_F0_UP_KEY = int(os.getenv("RVC_F0_UP_KEY", "0"))

_rvc = None


def _load() -> None:
    global _rvc
    if not RVC_MODEL_PATH:
        raise RuntimeError(
            "RVC_MODEL_PATH is not set. Point it to your trained .pth weights file."
        )

    try:
        from rvc_python.infer import RVCInference
    except ImportError as exc:
        raise RuntimeError(
            "rvc-python is not installed. Run: pip install rvc-python"
        ) from exc

    logger.info(
        "Loading RVC model path=%s index=%s device=%s",
        RVC_MODEL_PATH,
        RVC_INDEX_PATH or "(none)",
        RVC_DEVICE,
    )
    _rvc = RVCInference(device=RVC_DEVICE)
    _rvc.load_model(RVC_MODEL_PATH, RVC_INDEX_PATH or None)
    logger.info("RVC model loaded.")


def _warmup() -> None:
    """Run one silent inference so the first real caller does not pay init cost."""
    try:
        import numpy as np
        import soundfile as sf

        silence = np.zeros(int(24000 * 0.5), dtype=np.float32)
        buf = io.BytesIO()
        sf.write(buf, silence, 24000, format="WAV", subtype="PCM_16")
        convert(buf.getvalue())
        logger.info("RVC warmup complete (device=%s).", RVC_DEVICE)
    except Exception as exc:
        logger.warning("RVC warmup skipped: %s", exc)


def convert(wav_bytes: bytes) -> bytes:
    """Re-skin the voice in wav_bytes to the trained target voice.

    Input:  WAV bytes (typically 24 kHz 16-bit mono from Azure TTS).
    Output: WAV bytes with the target voice identity applied.
    """
    if _rvc is None:
        _load()

    # rvc-python infer_audio works most reliably with file paths.
    # Use temp files to avoid any in-memory API variation across package versions.
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_in:
        tmp_in.write(wav_bytes)
        tmp_in_path = tmp_in.name

    tmp_out_path = tmp_in_path.replace(".wav", "_rvc.wav")

    try:
        result = _rvc.infer_audio(
            audio_input=tmp_in_path,
            f0_up_key=RVC_F0_UP_KEY,
            f0_method=RVC_F0_METHOD,
            index_rate=RVC_INDEX_RATE,
            output_path=tmp_out_path,
        )

        # rvc-python versions differ: some write to output_path and return None,
        # others return a numpy array (optionally with sample rate as a tuple).
        if result is None or isinstance(result, str):
            with open(tmp_out_path, "rb") as f:
                return f.read()

        import numpy as np
        import soundfile as sf

        audio = result[0] if isinstance(result, tuple) else result
        sr = int(result[1]) if isinstance(result, tuple) and len(result) > 1 else 24000
        out_buf = io.BytesIO()
        sf.write(out_buf, audio, sr, format="WAV", subtype="PCM_16")
        return out_buf.getvalue()

    finally:
        for path in (tmp_in_path, tmp_out_path):
            if os.path.exists(path):
                os.remove(path)


# Load eagerly when provider is active and model path is configured.
# Mirrors stt/whisper.py: pay startup cost once, not on the first request.
if os.getenv("VOICE_TTS_PROVIDER") == "azure_rvc" and RVC_MODEL_PATH:
    _load()
    _warmup()
