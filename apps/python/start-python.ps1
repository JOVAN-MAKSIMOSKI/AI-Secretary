# Start the Python FastAPI service (documents, RAG, STT).
#
# IMPORTANT: no --reload. The embedded Qdrant is single-process; a reload worker
# wipes the collection registry and forces a re-ingest from resources/.
#
# Boot is slow: ~27s Whisper load + ~10s RAG warmup. The port won't answer for ~40s.

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

uv run uvicorn main:app --host 0.0.0.0 --port 8000
