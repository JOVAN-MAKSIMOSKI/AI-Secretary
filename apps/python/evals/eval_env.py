"""Evaluation-only environment setup for the extraction eval.

Mirrors apps/agent/src/evals/evalEnv.ts: EVALAPIKEY is mapped onto OPENAI_API_KEY
inside this process only, the provider is pinned to openai, and free-tier tokens are
cleared so a misconfigured run can never silently spend the GitHub Models daily quota.
The eval key never becomes the running service's credential.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import dotenv_values, load_dotenv

# The key lives in apps/agent/.env locally (single place, per Jovan's setup); CI passes
# it as a plain env var. Checked in that order.
_AGENT_ENV_FILE = Path(__file__).resolve().parents[2] / "agent" / ".env"

_NON_EVAL_CREDENTIAL_VARS = (
    "GITHUB_MODELS_TOKEN",
    "RAG_GITHUB_MODELS_TOKEN",
    "RAG_OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "RAG_ANTHROPIC_API_KEY",
    "RAG_LLM_MODEL",
)

# services/storage.py (imported transitively by the invoice extraction module) raises at
# import time without these. The extraction path under eval never touches Supabase —
# extract_invoice_fields_from_message(message, owner_auth_id=None) skips all client
# enrichment — so guard values only have to satisfy the import, never a request.
#
# The service-role key must be JWT-shaped (three dot-separated segments): supabase-py's
# create_client() regex-validates the key at construction and rejects a bare string with
# "Invalid API key". A local .env with a real key masks this via setdefault(), so the
# bad shape only surfaces in CI where no .env exists — the dummy JWT keeps both paths
# working without ever authenticating (no network call happens at construction).
_SUPABASE_IMPORT_GUARDS = {
    "SUPABASE_URL": "https://eval-import-guard.supabase.co",
    "SUPABASE_SERVICE_ROLE_KEY": "eval-import-guard.eval-import-guard.eval-import-guard",
}


def configure_extraction_eval_env() -> str | None:
    """Prepare env for the extraction eval. Returns a skip reason, or None when ready."""
    load_dotenv()  # apps/python/.env, if present

    eval_key = (os.environ.get("EVALAPIKEY") or "").strip()
    if not eval_key and _AGENT_ENV_FILE.exists():
        eval_key = (dotenv_values(_AGENT_ENV_FILE).get("EVALAPIKEY") or "").strip()

    if not eval_key:
        return "No EVALAPIKEY in env or apps/agent/.env — extraction eval skipped, offline guards still enforced."

    for var in _NON_EVAL_CREDENTIAL_VARS:
        os.environ.pop(var, None)

    os.environ["OPENAI_API_KEY"] = eval_key
    os.environ["RAG_LLM_PROVIDER"] = "openai"

    for var, guard in _SUPABASE_IMPORT_GUARDS.items():
        os.environ.setdefault(var, guard)

    return None
