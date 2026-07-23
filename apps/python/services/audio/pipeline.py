"""Audio synthesis pipeline: text → Azure TTS → RVC voice conversion → 8 kHz µ-law.

synthesize_ulaw(text) is the single entry point used by routers/tts.py.
Per-stage wall-clock timings are logged for latency tuning.
"""

from __future__ import annotations

import audioop
import io
import logging
import os
import time

import numpy as np
import soundfile as sf

from tts import azure_tts
from tts import rvc as rvc_module

logger = logging.getLogger(__name__)

TARGET_SAMPLE_RATE_HZ = 8000
PCM_SAMPLE_WIDTH_BYTES = 2  # 16-bit signed PCM


def _wav_to_8k_pcm(wav_bytes: bytes) -> bytes:
    """Resample WAV bytes (any sample rate) to 8 kHz 16-bit mono raw PCM."""
    audio, sr = sf.read(io.BytesIO(wav_bytes), dtype="int16", always_2d=False)

    if sr == TARGET_SAMPLE_RATE_HZ:
        return audio.tobytes()

    import librosa

    audio_f32 = audio.astype(np.float32) / 32768.0
    if audio_f32.ndim > 1:
        audio_f32 = audio_f32.mean(axis=1)  # stereo → mono

    resampled = librosa.resample(audio_f32, orig_sr=sr, target_sr=TARGET_SAMPLE_RATE_HZ)
    pcm = (resampled * 32768.0).clip(-32768, 32767).astype(np.int16)
    return pcm.tobytes()


def synthesize_ulaw(text: str, voice: str | None = None) -> bytes:
    """Full pipeline: text → Azure 24 kHz WAV → RVC conversion → 8 kHz µ-law bytes."""
    t0 = time.monotonic()

    azure_start = time.monotonic()
    wav_bytes = azure_tts.synthesize(text, voice=voice)
    azure_ms = int((time.monotonic() - azure_start) * 1000)

    rvc_start = time.monotonic()
    # Skip RVC if no model is configured — useful for testing Azure TTS alone.
    if os.getenv("RVC_MODEL_PATH"):
        converted_wav = rvc_module.convert(wav_bytes)
    else:
        converted_wav = wav_bytes
    rvc_ms = int((time.monotonic() - rvc_start) * 1000)

    transcode_start = time.monotonic()
    pcm_bytes = _wav_to_8k_pcm(converted_wav)
    ulaw_bytes = audioop.lin2ulaw(pcm_bytes, PCM_SAMPLE_WIDTH_BYTES)
    transcode_ms = int((time.monotonic() - transcode_start) * 1000)

    total_ms = int((time.monotonic() - t0) * 1000)
    logger.info(
        "TTS pipeline azure_ms=%d rvc_ms=%d transcode_ms=%d total_ms=%d chars=%d",
        azure_ms,
        rvc_ms,
        transcode_ms,
        total_ms,
        len(text),
    )
    return ulaw_bytes
