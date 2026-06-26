import logging
import os

from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)

# All STT model parameters are env-configurable so the model can be swapped without a
# code change. Defaults preserve the previous behaviour (large-v3 / cpu / int8), which is
# the most accurate choice for Macedonian. During English testing, set
# STT_MODEL_SIZE=small (or distil-large-v3) for a large speedup.
MODEL_SIZE = os.getenv("STT_MODEL_SIZE", "large-v3")
DEVICE = os.getenv("STT_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("STT_COMPUTE_TYPE", "int8")  # int8 halves RAM on CPU, negligible accuracy loss

# Optional CPU thread count — left to faster-whisper's default (0) when unset.
try:
    _CPU_THREADS = int(os.getenv("STT_CPU_THREADS", "0"))
except ValueError:
    _CPU_THREADS = 0

# Singleton — loaded once at import time, reused for every request.
model = WhisperModel(
    MODEL_SIZE,
    device=DEVICE,
    compute_type=COMPUTE_TYPE,
    cpu_threads=_CPU_THREADS,
)


def _warmup() -> None:
    """Run one tiny inference so the first real caller does not pay the model's lazy
    initialization cost (kernels, memory pools) on the critical path."""
    try:
        import numpy as np

        silence = np.zeros(8000, dtype=np.float32)  # 0.5s of silence at 16kHz
        segments, _ = model.transcribe(silence, beam_size=1)
        # The generator is lazy — drain it so the warmup actually executes.
        for _ in segments:
            pass
        logger.info("STT model warmup complete (model=%s device=%s)", MODEL_SIZE, DEVICE)
    except Exception as exc:  # warmup is best-effort; never block startup
        logger.warning("STT model warmup skipped: %s", exc)


_warmup()
