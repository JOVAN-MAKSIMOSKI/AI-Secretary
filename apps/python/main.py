"""FastAPI entry point — document generation, RAG, STT, and business auth service.

Run: uvicorn main:app --reload --host 0.0.0.0 --port 8000
Docs: http://localhost:8000/docs
"""

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

# Fail the boot with one clear error if required env vars are missing, instead of
# booting healthy and only failing per-request (e.g. STT returning 503/403).
# Runs before the router imports below, which load the Whisper model at import time.
_REQUIRED_ENV_VARS = ("INTER_SERVICE_SECRET", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY")
_missing_env_vars = [name for name in _REQUIRED_ENV_VARS if not os.getenv(name)]
if _missing_env_vars:
    raise RuntimeError(
        "Missing required environment variables: "
        + ", ".join(_missing_env_vars)
        + ". Set them in apps/python/.env (INTER_SERVICE_SECRET must match apps/agent/.env)."
    )

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from routers.business import router as business_router
from routers.clients import router as clients_router
from routers.documents import router as documents_router
from routers.rag import router as rag_router
from routers.stt import router as stt_router
from routers.tts import router as tts_router

limiter = Limiter(key_func=get_remote_address)

app = FastAPI(title="Secretary Python Service", version="0.1.0")

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

cors_origins_env = os.getenv("CORS_ALLOW_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
cors_allow_origins = [origin.strip() for origin in cors_origins_env.split(",") if origin.strip()]

app.add_middleware(
	CORSMiddleware,
	allow_origins=cors_allow_origins,
	allow_credentials=False,
	allow_methods=["*"],
	allow_headers=["*"],
)

app.include_router(business_router)
app.include_router(clients_router)
app.include_router(documents_router)
app.include_router(rag_router)
app.include_router(stt_router)
app.include_router(tts_router)
