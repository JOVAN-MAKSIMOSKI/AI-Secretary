from faster_whisper import WhisperModel

MODEL_SIZE = "large-v3"
DEVICE = "cpu"
COMPUTE_TYPE = "int8"  # Halves RAM usage on CPU (~1.5 GB vs ~3 GB), negligible accuracy loss

# Singleton — loaded once at import time, reused for every request
model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
