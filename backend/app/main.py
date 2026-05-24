import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from supabase import Client, create_client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")

app = FastAPI(title="AI-Secretary API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_supabase_client() -> Client:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set")
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/supabase/ping")
def supabase_ping() -> dict:
    try:
        client = get_supabase_client()
        result = client.auth.admin.list_users(page=1, per_page=1)
        users = getattr(result, "users", []) or []
        return {
            "connected": True,
            "sample_users_count": len(users),
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Supabase connection failed: {exc}") from exc
