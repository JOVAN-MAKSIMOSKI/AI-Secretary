"""Invoice text helpers powered by the existing configurable LLM stack."""

from __future__ import annotations

import os
from decimal import Decimal


def _get_configured_llm():
    """Instantiate an LLM based on existing RAG provider env settings."""
    llm_provider = os.getenv("RAG_LLM_PROVIDER", "auto").strip().lower()
    llm_timeout_seconds = float(os.getenv("RAG_LLM_TIMEOUT_SECONDS", "60"))

    openai_api_key = os.getenv("RAG_OPENAI_API_KEY", os.getenv("OPENAI_API_KEY", "")).strip()
    anthropic_api_key = os.getenv("RAG_ANTHROPIC_API_KEY", os.getenv("ANTHROPIC_API_KEY", "")).strip()
    github_models_token = os.getenv("RAG_GITHUB_MODELS_TOKEN", os.getenv("GITHUB_MODELS_TOKEN", "")).strip()

    if llm_provider == "auto":
        if github_models_token:
            llm_provider = "github"
        elif openai_api_key:
            llm_provider = "openai"
        elif anthropic_api_key:
            llm_provider = "anthropic"
        else:
            llm_provider = "ollama"

    if llm_provider == "ollama":
        from llama_index.llms.ollama import Ollama

        llm_model = os.getenv("RAG_LLM_MODEL", "qwen2.5")
        return Ollama(model=llm_model, request_timeout=llm_timeout_seconds)

    if llm_provider == "openai":
        if not openai_api_key:
            raise RuntimeError("OPENAI_API_KEY (or RAG_OPENAI_API_KEY) is required for openai provider.")

        from llama_index.llms.openai import OpenAI

        llm_model = os.getenv("RAG_LLM_MODEL", "gpt-4.1-mini")
        return OpenAI(model=llm_model, api_key=openai_api_key)

    if llm_provider == "anthropic":
        if not anthropic_api_key:
            raise RuntimeError("ANTHROPIC_API_KEY (or RAG_ANTHROPIC_API_KEY) is required for anthropic provider.")

        from llama_index.llms.anthropic import Anthropic

        llm_model = os.getenv("RAG_LLM_MODEL", "claude-3-5-sonnet-latest")
        return Anthropic(model=llm_model, api_key=anthropic_api_key)

    if llm_provider == "github":
        if not github_models_token:
            raise RuntimeError("GITHUB_MODELS_TOKEN (or RAG_GITHUB_MODELS_TOKEN) is required for github provider.")

        from llama_index.llms.openai import OpenAI

        llm_model = os.getenv("RAG_LLM_MODEL", "openai/gpt-4.1-mini")
        return OpenAI(
            model=llm_model,
            api_key=github_models_token,
            api_base="https://models.inference.ai.azure.com",
        )

    raise RuntimeError(f"Unsupported RAG_LLM_PROVIDER: {llm_provider}")


def amount_to_macedonian_text(amount: Decimal) -> str:
    """Convert a numeric amount to a Macedonian textual money phrase using LLM."""
    llm = _get_configured_llm()

    prompt = (
        "Convert the following monetary amount to Macedonian text for invoice usage.\n"
        "Rules:\n"
        "- Output ONLY the Macedonian text phrase, no quotes and no explanations.\n"
        "- Preserve the numeric value exactly.\n"
        "- Prefer a concise formal invoice style.\n"
        f"Amount: {amount}\n"
        "Macedonian text:"
    )

    result = llm.complete(prompt)
    text = getattr(result, "text", str(result))
    normalized = " ".join(str(text).strip().split())

    if not normalized:
        raise RuntimeError("LLM returned an empty Macedonian amount text.")

    return normalized[:255]
