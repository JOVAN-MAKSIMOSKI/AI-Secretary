"""LangChain utilities for future workflow chains."""

from __future__ import annotations

import ast
import json
import os
import re
from typing import Any, Iterable

from langchain_community.llms import Ollama
from langchain_core.prompts import PromptTemplate


_INTEGER_EXTRACTION_KEYS = {
    "units",
    "order_number",
    "consignment_note_number",
    "invoice_month",
    "invoice_year",
}

_DECIMAL_EXTRACTION_KEYS = {
    "price_per_unit",
    "tax_percentage",
    "price_before_tax",
    "price_after_tax",
}

_EMPTY_LIKE_STRINGS = {
    "n/a",
    "na",
    "none",
    "null",
    "not provided",
    "not available",
    "unknown",
    "undefined",
    "missing",
    "-",
    "",
}

_PROMPT_INJECTION_PATTERNS = [
    re.compile(r"ignore\s+(all\s+)?(previous|prior|above)\s+instructions?", re.IGNORECASE),
    re.compile(r"disregard\s+(the\s+)?(system|developer|safety)\s+instructions?", re.IGNORECASE),
    re.compile(r"reveal\s+(the\s+)?(system|developer)\s+prompt", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+(an?|the)", re.IGNORECASE),
    re.compile(r"act\s+as\s+(an?|the)", re.IGNORECASE),
    re.compile(r"jailbreak|do\s+anything\s+now|dan\b", re.IGNORECASE),
    re.compile(r"<(system|assistant|developer)>|```(system|assistant|developer)", re.IGNORECASE),
]


def _contains_prompt_injection(text: str) -> bool:
    if not text:
        return False
    return any(pattern.search(text) for pattern in _PROMPT_INJECTION_PATTERNS)


def _parse_number_like(value: Any) -> float | None:
    if isinstance(value, bool):
        return None

    if isinstance(value, (int, float)):
        number = float(value)
        return number if number == number else None

    if not isinstance(value, str):
        return None

    token = re.sub(r"\s+", "", value.strip())
    if not re.match(r"^[+-]?\d[\d.,]*$", token):
        return None

    comma_count = token.count(",")
    dot_count = token.count(".")
    normalized = token

    if comma_count > 0 and dot_count > 0:
        if token.rfind(",") > token.rfind("."):
            normalized = token.replace(".", "").replace(",", ".")
        else:
            normalized = token.replace(",", "")
    elif comma_count > 0:
        last_comma_index = token.rfind(",")
        decimal_digits = len(token) - last_comma_index - 1
        if comma_count == 1 and decimal_digits <= 2:
            normalized = token.replace(",", ".")
        else:
            normalized = token.replace(",", "")
    elif dot_count > 0:
        last_dot_index = token.rfind(".")
        decimal_digits = len(token) - last_dot_index - 1
        if dot_count == 1 and decimal_digits <= 2:
            normalized = token
        else:
            normalized = token.replace(".", "")

    try:
        parsed = float(normalized)
    except ValueError:
        return None

    return parsed if parsed == parsed else None


def _coerce_extracted_value(key: str, value: Any) -> Any:
    if isinstance(value, str):
        normalized_text = " ".join(value.strip().split()).lower()
        if normalized_text in _EMPTY_LIKE_STRINGS:
            return None

    if key in _INTEGER_EXTRACTION_KEYS:
        parsed = _parse_number_like(value)
        if parsed is None or not parsed.is_integer():
            return None
        return int(parsed)

    if key in _DECIMAL_EXTRACTION_KEYS:
        parsed = _parse_number_like(value)
        if parsed is None:
            return None
        return parsed

    return value


def get_ollama_llm():
    """Initialize and return an Ollama LLM."""
    ollama_base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
    model = os.getenv("OLLAMA_MODEL", "mistral")

    return Ollama(
        base_url=ollama_base_url,
        model=model,
        temperature=0.7,
    )


def create_simple_chain(prompt_template: str):
    """Create a simple LLM chain with a prompt template."""
    llm = get_ollama_llm()
    prompt = PromptTemplate.from_template(prompt_template)
    return prompt | llm


def _normalize_extraction_output(
    raw_result: str,
    allowed_keys: Iterable[str],
) -> dict[str, Any]:
    """Normalize chain output and keep only user-message extraction fields."""
    cleaned = raw_result.strip()

    # Handle accidental markdown-wrapped JSON responses from the model.
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`").strip()
        if cleaned.lower().startswith("json"):
            cleaned = cleaned[4:].strip()

    parsed = _parse_llm_json_dict(cleaned)

    if not isinstance(parsed, dict):
        raise ValueError("Extraction chain did not return a JSON object.")

    allowed_key_set = set(allowed_keys)
    filtered: dict[str, Any] = {}
    for key, value in parsed.items():
        if key not in allowed_key_set:
            continue
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue

        coerced = _coerce_extracted_value(key, value)
        if coerced is None:
            continue

        filtered[key] = coerced

    return filtered


def _parse_llm_json_dict(raw_payload: str) -> dict[str, Any]:
    """Parse model output as JSON with safe fallbacks for near-JSON replies."""
    candidates: list[str] = []
    trimmed = raw_payload.strip()
    if trimmed:
        candidates.append(trimmed)

    first_brace = trimmed.find("{")
    last_brace = trimmed.rfind("}")
    if first_brace != -1 and last_brace != -1 and last_brace > first_brace:
        candidates.append(trimmed[first_brace : last_brace + 1])

    for candidate in candidates:
        current = candidate.strip()
        if not current:
            continue

        # Strict JSON first.
        try:
            parsed = json.loads(current)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

        # Common LLM issue: trailing commas in objects/arrays.
        relaxed = re.sub(r",\s*([}\]])", r"\1", current)
        if relaxed != current:
            try:
                parsed = json.loads(relaxed)
                if isinstance(parsed, dict):
                    return parsed
            except json.JSONDecodeError:
                pass

        # Fallback for Python-style dicts with single quotes.
        try:
            parsed_literal = ast.literal_eval(current)
            if isinstance(parsed_literal, dict):
                return {str(key): value for key, value in parsed_literal.items()}
        except (ValueError, SyntaxError):
            pass

    raise ValueError("Extraction chain did not return a parseable JSON object.")


def run_invoice_extraction(
    message: str,
    allowed_keys: Iterable[str],
) -> dict[str, Any]:
    """Extract user-provided invoice fields from free text and return structured data."""
    if _contains_prompt_injection(message):
        raise ValueError(
            "Extraction request rejected due to suspected prompt-injection content. "
            "Provide only invoice details without meta-instructions."
        )

    prompt_template = (
        "You are an extraction assistant for invoice drafting. "
        "Extract only user-provided invoice fields from the user message and return JSON only.\n\n"
        "Expected keys:\n"
        "invoice_type (goods|transport|null)\n"
        "value_date\n"
        "consignment_note_number\n"
        "order_number\n"
        "client_name\n"
        "description\n"
        "units\n"
        "price_per_unit\n"
        "tax_percentage\n\n"
        "Rules:\n"
        "- Do not output fields that are not in the expected key list.\n"
        "- If message contains consignment note number, put it in consignment_note_number (not order_number).\n"
        "- If a value is missing or uncertain, omit that key.\n"
        "- Do not include markdown fences or extra text.\n\n"
        "User message:\n{message}"
    )

    chain = create_simple_chain(prompt_template)
    result = chain.invoke({"message": message})

    if isinstance(result, str):
        return _normalize_extraction_output(result, allowed_keys=allowed_keys)

    return _normalize_extraction_output(str(result), allowed_keys=allowed_keys)
