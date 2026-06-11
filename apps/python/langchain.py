"""LangChain utilities for future workflow chains."""

from __future__ import annotations

import ast
import json
import os
import re
from datetime import datetime, timedelta
from typing import Any, Iterable

from langchain_community.llms import Ollama
from langchain_core.prompts import PromptTemplate


_INTEGER_EXTRACTION_KEYS = {
    "units",
    "order_number",
    "consignment_note_number",
    "invoice_month",
    "invoice_year",
    "duration_minutes",
}

_DECIMAL_EXTRACTION_KEYS = {
    "price_per_unit",
    "tax_percentage",
    "price_before_tax",
    "price_after_tax",
    "amount",
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

_DATE_ISO_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_24H_PATTERN = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


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

        # Fallback for plain text key:value lines (common with smaller local models).
        parsed_lines = _parse_key_value_lines(current)
        if parsed_lines:
            return parsed_lines

    raise ValueError("Extraction chain did not return a parseable JSON object.")


def _parse_key_value_lines(raw_payload: str) -> dict[str, Any]:
    parsed: dict[str, Any] = {}
    for raw_line in raw_payload.splitlines():
        line = raw_line.strip().lstrip("-*").strip()
        if not line or ":" not in line:
            continue

        key_part, value_part = line.split(":", 1)
        key = re.sub(r"\s+", "_", key_part.strip().strip('"\''))
        value_text = value_part.strip().rstrip(",").strip()

        if not key or not value_text:
            continue

        # Remove wrapping quotes when present.
        if (value_text.startswith('"') and value_text.endswith('"')) or (
            value_text.startswith("'") and value_text.endswith("'")
        ):
            value_text = value_text[1:-1].strip()

        lowered = value_text.lower()
        if lowered in {"null", "none"}:
            parsed[key] = None
            continue
        if lowered == "true":
            parsed[key] = True
            continue
        if lowered == "false":
            parsed[key] = False
            continue

        number_like = _parse_number_like(value_text)
        if number_like is not None:
            if float(number_like).is_integer():
                parsed[key] = int(number_like)
            else:
                parsed[key] = float(number_like)
            continue

        parsed[key] = value_text

    return parsed


def _resolve_relative_event_date(message: str) -> str | None:
    lowered = message.lower()
    today = datetime.now().date()

    # Respect explicit user-provided calendar dates.
    if re.search(r"\b\d{4}-\d{2}-\d{2}\b", lowered):
        return None
    if re.search(r"\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b", lowered):
        return None

    if "day after tomorrow" in lowered:
        return (today + timedelta(days=2)).isoformat()

    if "tomorrow" in lowered:
        return (today + timedelta(days=1)).isoformat()

    if "today" in lowered:
        return today.isoformat()

    weekday_aliases: dict[str, int] = {
        "monday": 0,
        "mon": 0,
        "tuesday": 1,
        "tue": 1,
        "tues": 1,
        "wednesday": 2,
        "wed": 2,
        "thursday": 3,
        "thu": 3,
        "thur": 3,
        "thurs": 3,
        "friday": 4,
        "fri": 4,
        "saturday": 5,
        "sat": 5,
        "sunday": 6,
        "sun": 6,
    }

    for alias, target_weekday in weekday_aliases.items():
        if not re.search(rf"\b{alias}\b", lowered):
            continue

        delta = (target_weekday - today.weekday()) % 7
        if re.search(rf"\bnext\s+{alias}\b", lowered):
            delta = delta + 7 if delta > 0 else 7
        elif re.search(rf"\bthis\s+{alias}\b", lowered):
            delta = delta
        else:
            # Plain "monday/friday" means the next upcoming occurrence.
            if delta == 0:
                delta = 7

        return (today + timedelta(days=delta)).isoformat()

    return None


def _postprocess_calendar_extraction(message: str, extracted: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(extracted)
    relative_date = _resolve_relative_event_date(message)
    if relative_date is not None:
        normalized["event_date"] = relative_date

    event_name = str(normalized.get("event_name") or "").strip()
    event_date = str(normalized.get("event_date") or "").strip()
    event_time = _normalize_event_time(normalized.get("event_time"))
    duration_raw = normalized.get("duration_minutes")

    if not event_name:
        raise ValueError("Missing event_name in calendar extraction output.")
    if not _DATE_ISO_PATTERN.match(event_date):
        raise ValueError("event_date must be in YYYY-MM-DD format.")
    if not event_time:
        raise ValueError("event_time must be in HH:MM 24-hour format.")

    duration_minutes: int | None = None
    if isinstance(duration_raw, int) and duration_raw >= 1:
        duration_minutes = duration_raw

    # Return strict payload keys and include duration when available.
    response: dict[str, Any] = {
        "event_name": event_name,
        "event_date": event_date,
        "event_time": event_time,
    }

    if duration_minutes is not None:
        response["duration_minutes"] = duration_minutes

    return response


def _normalize_event_time(value: Any) -> str | None:
    if value is None:
        return None

    text = str(value).strip().lower()
    if not text:
        return None

    if _TIME_24H_PATTERN.match(text):
        return text

    # Allow H:MM and normalize to HH:MM.
    h_mm_match = re.match(r"^(\d{1,2}):(\d{2})$", text)
    if h_mm_match:
        hour = int(h_mm_match.group(1))
        minute = int(h_mm_match.group(2))
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return f"{hour:02d}:{minute:02d}"

    # Allow forms like 8pm, 8:30pm, 8 am.
    ampm_match = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$", text)
    if ampm_match:
        hour = int(ampm_match.group(1))
        minute = int(ampm_match.group(2) or "0")
        suffix = ampm_match.group(3)

        if not (1 <= hour <= 12 and 0 <= minute <= 59):
            return None

        if suffix == "am":
            hour = 0 if hour == 12 else hour
        else:
            hour = 12 if hour == 12 else hour + 12

        return f"{hour:02d}:{minute:02d}"

    return None


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


def run_calendar_event_extraction(message: str) -> dict[str, Any]:
    """Extract calendar event fields from free text.

    Returns a strict JSON-like dict with keys:
    - event_name: string
    - event_date: YYYY-MM-DD
    - event_time: HH:MM (24h)
    - duration_minutes: optional integer
    """
    if _contains_prompt_injection(message):
        raise ValueError(
            "Calendar extraction request rejected due to suspected prompt-injection content. "
            "Provide only event details without meta-instructions."
        )

    allowed_keys = {
        "event_name",
        "event_date",
        "event_time",
        "duration_minutes",
    }

    current_date = datetime.now().date().isoformat()

    prompt_template = (
        "You are an extraction assistant for calendar event scheduling. "
        "Extract only user-provided event fields from the user message and return JSON only.\n\n"
        "Reference date: {current_date}. Use this date when interpreting relative expressions like today/tomorrow.\n\n"
        "Expected keys:\n"
        "event_name\n"
        "event_date (YYYY-MM-DD)\n"
        "event_time (HH:MM, 24-hour format)\n"
        "duration_minutes (optional integer in minutes)\n"
        "\n"
        "Rules:\n"
        "- Do not output keys outside the expected list.\n"
        "- If a key is missing or uncertain, omit it.\n"
        "- Do not include markdown fences or extra text.\n"
        "- Keep event_name concise and literal from user intent.\n"
        "- Normalize date and time formats exactly as requested above.\n\n"
        "User message:\n{message}"
    )

    chain = create_simple_chain(prompt_template)
    result = chain.invoke({"message": message, "current_date": current_date})

    if isinstance(result, str):
        extracted = _normalize_extraction_output(result, allowed_keys=allowed_keys)
        return _postprocess_calendar_extraction(message, extracted)

    extracted = _normalize_extraction_output(str(result), allowed_keys=allowed_keys)
    return _postprocess_calendar_extraction(message, extracted)


def run_offer_extraction(message: str) -> dict[str, Any]:
    """Extract offer draft fields from free text."""
    if _contains_prompt_injection(message):
        raise ValueError(
            "Offer extraction request rejected due to suspected prompt-injection content. "
            "Provide only offer details without meta-instructions."
        )

    allowed_keys = {
        "title",
        "description",
        "amount",
        "due_date",
    }

    prompt_template = (
        "You are an extraction assistant for sales offers. "
        "Extract only user-provided offer fields and return JSON only.\n\n"
        "Expected keys:\n"
        "title\n"
        "description\n"
        "amount\n"
        "due_date (YYYY-MM-DD)\n\n"
        "Rules:\n"
        "- Do not output keys outside the expected list.\n"
        "- If a key is missing or uncertain, omit it.\n"
        "- Do not include markdown fences or extra text.\n"
        "- Keep title concise and business-oriented.\n\n"
        "User message:\n{message}"
    )

    chain = create_simple_chain(prompt_template)
    result = chain.invoke({"message": message})

    if isinstance(result, str):
        return _normalize_extraction_output(result, allowed_keys=allowed_keys)

    return _normalize_extraction_output(str(result), allowed_keys=allowed_keys)
