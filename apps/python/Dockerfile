# syntax=docker/dockerfile:1.7
# Build context = apps/python: docker build -f apps/python/Dockerfile apps/python
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS builder
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=0
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project
COPY . .

FROM python:3.12-slim-bookworm AS runtime
# libsndfile1: soundfile; libgomp1: ctranslate2/onnxruntime OpenMP.
# NO tesseract-ocr / NO ffmpeg: pytesseract+PyMuPDF are ingest-only (scripts/ingest.py
# runs on the dev machine); faster-whisper decodes via PyAV (bundles ffmpeg libs).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libsndfile1 libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 appuser \
    && mkdir -p /data/hf-cache && chown -R appuser:appuser /data
WORKDIR /app
COPY --from=builder --chown=appuser:appuser /app /app
# LLAMA_INDEX_CACHE_DIR: LlamaIndex's HuggingFaceEmbedding ignores HF_HOME and
# defaults to ~/.cache/llama_index — without this the e5-large download lands on
# the ephemeral container filesystem and repeats on every redeploy.
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 \
    HF_HOME=/data/hf-cache \
    LLAMA_INDEX_CACHE_DIR=/data/hf-cache/llama_index
USER appuser
EXPOSE 8000
# Generous start-period: first boot downloads e5-large (~2.2GB) + whisper large-v3 (~3GB)
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=5 \
  CMD python -c "import urllib.request,sys; r=urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4); sys.exit(0 if r.status==200 else 1)"
# --proxy-headers/--forwarded-allow-ips: python is only reachable through Caddy
# on the internal network; this recovers real client IPs for slowapi rate limits.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
