"""LangChain utilities for future workflow chains."""

from __future__ import annotations

import ast
import json
import os
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

from langchain_core.output_parsers import StrOutputParser
from langchain_core.prompts import PromptTemplate
from langchain_openai import ChatOpenAI


# Waste reference data (EWC code maps + the closed MK lists) is generated from
# apps/agent/src/agent/wasteChapters.ts into resources/waste_reference.json — see
# apps/agent/scripts/generateWasteReference.ts. It is the single source of truth for
# both the extraction prompt (which offers the model exact values to snap onto) and the
# Pydantic request model (which rejects anything outside them). Loaded once at import.
_WASTE_REFERENCE_PATH = Path(__file__).resolve().parent / "resources" / "waste_reference.json"


def _load_waste_reference() -> dict[str, Any]:
    with _WASTE_REFERENCE_PATH.open(encoding="utf-8") as reference_file:
        return json.load(reference_file)


_WASTE_REFERENCE = _load_waste_reference()
_EWC_HAZARDOUS_CODE_MAP: dict[str, str] = _WASTE_REFERENCE["ewc_hazardous_code_map"]
_EWC_NON_HAZARDOUS_CODE_MAP: dict[str, str] = _WASTE_REFERENCE["ewc_non_hazardous_code_map"]
_PACKING_METHODS: list[str] = list(_WASTE_REFERENCE["packing_methods"])
_WASTE_ORIGINS: list[str] = list(_WASTE_REFERENCE["waste_origins"])
_WASTE_OPERATIONS_CODES: list[str] = list(_WASTE_REFERENCE["waste_operations_codes"])


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
    # Waste-form weights (kg): coerce like the other decimals so number words and
    # string inputs normalize to floats instead of passing through as raw text.
    "waste_owner_total_kg",
    "collector_total_kg",
    "end_owner_total_kg",
    "total_weight_kg",
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
_CYRILLIC_PATTERN = re.compile(r"[\u0400-\u04FF]")

# Calendar titles are capped to this many words so a long phrase \u2014 or a verbose model
# reply \u2014 never becomes the meeting name. Keeps titles readable in the calendar UI.
MAX_EVENT_NAME_WORDS = 4

# Macedonian tokens stripped when extracting event_name from the raw message.
_MK_BOOKING_VERBS = re.compile(
    r"\b(?:\u0437\u0430\u043A\u0430\u0436\u0438|\u043D\u0430\u043F\u0440\u0430\u0432\u0438|\u0440\u0435\u0437\u0435\u0440\u0432\u0438\u0440\u0430\u0458|\u043F\u043E\u0441\u0442\u0430\u0432\u0438|\u0434\u043E\u0434\u0430\u0458|\u0441\u043E\u0437\u0434\u0430\u0434\u0438|\u0437\u0430\u043F\u0438\u0448\u0438|\u0437\u0430\u043A\u0430\u0436\u0435\u0442\u0435|\u043D\u0430\u043F\u0440\u0430\u0432\u0435\u0442\u0435)\b",
    re.IGNORECASE,
)
_MK_TEMPORAL_ADVERBS = re.compile(
    r"\b(?:\u0443\u0442\u0440\u0435|\u0434\u0435\u043D\u0435\u0441\u043A\u0430|\u0434\u0435\u043D\u0435\u0441|\u043F\u0440\u0435\u043A\u0443\u0432\u0447\u0435\u0440\u0430|\u0437\u0430\u0432\u0442\u0440\u0430)\b",
    re.IGNORECASE,
)
_MK_DAY_NAMES = re.compile(
    r"\b(?:(?:\u0432\u043E|\u043D\u0430)\s+)?(?:\u043F\u043E\u043D\u0435\u0434\u0435\u043B\u043D\u0438\u043A|\u0432\u0442\u043E\u0440\u043D\u0438\u043A|\u0441\u0440\u0435\u0434\u0430|\u0447\u0435\u0442\u0432\u0440\u0442\u043E\u043A|\u043F\u0435\u0442\u043E\u043A|\u0441\u0430\u0431\u043E\u0442\u0430|\u043D\u0435\u0434\u0435\u043B\u0430)\b",
    re.IGNORECASE,
)
_MK_MONTH_NAMES = re.compile(
    r"\b(?:\u0458\u0430\u043D\u0443\u0430\u0440\u0438|\u0444\u0435\u0432\u0440\u0443\u0430\u0440\u0438|\u043C\u0430\u0440\u0442|\u0430\u043F\u0440\u0438\u043B|\u043C\u0430\u0458|\u0458\u0443\u043D\u0438|\u0458\u0443\u043B\u0438|\u0430\u0432\u0433\u0443\u0441\u0442|\u0441\u0435\u043F\u0442\u0435\u043C\u0432\u0440\u0438|\u043E\u043A\u0442\u043E\u043C\u0432\u0440\u0438|\u043D\u043E\u0435\u043C\u0432\u0440\u0438|\u0434\u0435\u043A\u0435\u043C\u0432\u0440\u0438)\b",
    re.IGNORECASE,
)
_MK_NEXT_MODIFIERS = re.compile(
    r"\b(?:\u0441\u043B\u0435\u0434\u043D\u0438\u043E\u0442|\u0441\u043B\u0435\u0434\u043D\u0430\u0442\u0430|\u0441\u043B\u0435\u0434\u043D\u0430|\u0441\u043B\u0435\u0434\u0435\u043D|\u043D\u0430\u0440\u0435\u0434\u043D\u0438\u043E\u0442|\u043D\u0430\u0440\u0435\u0434\u043D\u0430\u0442\u0430)\b",
    re.IGNORECASE,
)
# "\u0432\u043E 10 \u0447\u0430\u0441\u043E\u0442", "\u0432\u043E 14:30", "\u0432\u043E 9 \u0447\u0430\u0441\u043E\u0442"
_MK_TIME_CONTEXT = re.compile(
    r"\b\u0432\u043E\s+\d{1,2}(?::\d{2})?\s*(?:\u0447\u0430\u0441\u043E\u0442|\u0447\u0430\u0441\u043E\u0432\u0438)?\b",
    re.IGNORECASE,
)
# "\u043F\u043E\u043F\u043B\u0430\u0434\u043D\u0435", "\u0432\u043E \u043F\u043E\u043F\u043B\u0430\u0434\u043D\u0435", "\u043D\u0430\u0443\u0442\u0440\u043E", "\u043D\u0430\u0432\u0435\u0447\u0435\u0440", "\u043D\u043E\u045C\u0435", etc.
_MK_TIME_OF_DAY = re.compile(
    r"\b(?:\u0432\u043E\s+)?(?:\u043F\u043E\u043F\u043B\u0430\u0434\u043D\u0435|\u043F\u043E\u043F\u043B\u0430\u0434\u043D\u0435\u0442\u043E|\u043D\u0430\u0443\u0442\u0440\u043E|\u0443\u0442\u0440\u043E\u0442\u043E|\u0443\u0442\u0440\u0438\u043D\u0442\u0430|\u043D\u0430\u0432\u0435\u0447\u0435\u0440|\u0432\u0435\u0447\u0435\u0440\u0442\u0430|\u043D\u043E\u045C\u0435|\u043D\u043E\u045C\u0442\u0430)\b",
    re.IGNORECASE,
)
# "\u043D\u0430 15-\u0442\u0438", "\u043D\u0430 20-\u0442\u0430", "\u043D\u0430 20"
_MK_DATE_ORDINAL = re.compile(
    r"\b\u043D\u0430\s+\d{1,2}(?:-(?:\u0442\u0438|\u0442\u0430|\u0442\u043E|\u0440\u0438|\u043C\u0438|\u0432\u0438|\u0433\u0438|\u043D\u0438))?\b",
    re.IGNORECASE,
)


def _contains_prompt_injection(text: str) -> bool:
    if not text:
        return False
    return any(pattern.search(text) for pattern in _PROMPT_INJECTION_PATTERNS)


def _contains_cyrillic(text: str) -> bool:
    """Check if text contains Cyrillic characters (including Macedonian, Russian, Serbian, etc.)."""
    if not text:
        return False
    return bool(_CYRILLIC_PATTERN.search(text))


def _extract_cyrillic_event_name_fallback(message: str) -> str | None:
    """Extract the Macedonian event name from the raw message by stripping noise tokens.

    Removes booking command verbs, date expressions, time expressions, and temporal
    words — then returns the remaining Cyrillic tokens as the event name.
    Date and time extraction is handled separately in _postprocess_calendar_extraction
    so stripping them here does not affect those fields.
    """
    cleaned = _MK_TIME_CONTEXT.sub(" ", message)
    cleaned = _MK_TIME_OF_DAY.sub(" ", cleaned)
    cleaned = _MK_DATE_ORDINAL.sub(" ", cleaned)
    cleaned = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", " ", cleaned)
    cleaned = re.sub(r"\b\d{1,2}:\d{2}\b", " ", cleaned)
    cleaned = re.sub(r"\b\d+\b", " ", cleaned)
    cleaned = _MK_BOOKING_VERBS.sub(" ", cleaned)
    cleaned = _MK_TEMPORAL_ADVERBS.sub(" ", cleaned)
    cleaned = _MK_DAY_NAMES.sub(" ", cleaned)
    cleaned = _MK_MONTH_NAMES.sub(" ", cleaned)
    cleaned = _MK_NEXT_MODIFIERS.sub(" ", cleaned)
    cyrillic_tokens = re.findall(r"[Ѐ-ӿ]+", cleaned)
    if not cyrillic_tokens:
        return None
    return " ".join(cyrillic_tokens).strip() or None


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


# Extraction is a deterministic, structured task: the same message must always yield
# the same fields. A non-zero temperature made the model randomly omit fields like
# units / price_per_unit between identical requests. Keep it at 0 for reproducibility.
_EXTRACTION_TEMPERATURE = 0.0


def get_extraction_llm() -> ChatOpenAI:
    """Initialize the extraction LLM from the shared RAG_LLM_* provider settings."""
    llm_provider = os.getenv("RAG_LLM_PROVIDER", "auto").strip().lower()
    openai_api_key = os.getenv("RAG_OPENAI_API_KEY", os.getenv("OPENAI_API_KEY", "")).strip()

    if llm_provider == "auto":
        if openai_api_key:
            llm_provider = "openai"
        else:
            raise RuntimeError(
                "No LLM provider configured for extraction: set OPENAI_API_KEY, "
                "or set RAG_LLM_PROVIDER explicitly."
            )

    if llm_provider == "openai":
        if not openai_api_key:
            raise RuntimeError("OPENAI_API_KEY (or RAG_OPENAI_API_KEY) is required for RAG_LLM_PROVIDER=openai")

        return ChatOpenAI(
            model=os.getenv("RAG_LLM_MODEL", "gpt-4.1-mini"),
            api_key=openai_api_key,
            temperature=_EXTRACTION_TEMPERATURE,
        )

    # "github" was removed when GitHub Models was retired (HTTP 410
    # github_models_retirement_brownout). It now lands here and fails loudly at startup
    # rather than 410-ing on every extraction request.
    raise RuntimeError(f"Unsupported RAG_LLM_PROVIDER for extraction: {llm_provider}")


def create_simple_chain(prompt_template: str):
    """Create a simple LLM chain with a prompt template."""
    llm = get_extraction_llm()
    prompt = PromptTemplate.from_template(prompt_template)
    # StrOutputParser keeps the chain returning plain text: callers parse the JSON body
    # themselves, and a chat model would otherwise hand back an AIMessage.
    return prompt | llm | StrOutputParser()


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

    # Macedonian relative dates resolved by Python so the model doesn't have to convert them.
    if re.search(r"\bутре\b", lowered):
        return (today + timedelta(days=1)).isoformat()

    if re.search(r"\b(?:денеска|денес)\b", lowered):
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
        # Macedonian weekday names
        "понеделник": 0,
        "вторник": 1,
        "среда": 2,
        "четврток": 3,
        "петок": 4,
        "сабота": 5,
        "недела": 6,
    }

    for alias, target_weekday in weekday_aliases.items():
        if not re.search(rf"\b{alias}\b", lowered):
            continue

        delta = (target_weekday - today.weekday()) % 7
        if re.search(rf"\bnext\s+{alias}\b", lowered):
            delta = delta + 7 if delta > 0 else 7
        elif re.search(rf"\bthis\s+{alias}\b", lowered):
            delta = delta
        elif re.search(rf"\b(?:следниот|следната|следна|следен)\s+{alias}\b", lowered):
            delta = delta + 7 if delta > 0 else 7
        else:
            # Plain day name means the next upcoming occurrence.
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

    # Prefer the LLM-built title (it can normalize speech-to-text errors the regex strip
    # cannot). Only fall back to the Python strip heuristic when the model returned no
    # event_name at all, so a Cyrillic message still yields something usable.
    if not event_name and _contains_cyrillic(message):
        recovered = _extract_cyrillic_event_name_fallback(message)
        if recovered:
            event_name = recovered

    # Safety net: cap the title so a verbose model reply never becomes the meeting name.
    if event_name:
        event_name = " ".join(event_name.split()[:MAX_EVENT_NAME_WORDS])

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
        "firm_name\n"
        "description\n"
        "units\n"
        "price_per_unit\n"
        "tax_percentage\n\n"
        "Rules:\n"
        "- Do not output fields that are not in the expected key list.\n"
        "- If message contains consignment note number, put it in consignment_note_number (not order_number).\n"
        "- If a value is missing or uncertain, omit that key.\n"
        "- Do not include markdown fences or extra text.\n"
        # Spoken amounts arrive as number words (Whisper transcribes Macedonian speech
        # that way); without explicit examples the model omits units/price_per_unit
        # entirely instead of converting them.
        "- units, price_per_unit, tax_percentage, and all numbers must be numeric JSON values, never words.\n"
        "- Convert number words in any language to digits, including Macedonian: "
        "'пет' is 5, 'десет' is 10, 'сто' is 100, 'илјада' is 1000, "
        "'две илјади и петстотини' is 2500.\n"
        "- Example: 'пет парчиња по илјада денари' means units 5 and price_per_unit 1000.\n\n"
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
    has_cyrillic = _contains_cyrillic(message)
    language_hint = (
        "CRITICAL: The user is writing in Macedonian (Cyrillic script). "
        "For event_name: produce a SHORT title in Macedonian Cyrillic (do NOT translate to English), "
        "at most 4 words, in the form '<activity> со <name>' — e.g. 'состанок со Стефан'. "
        "Correct obvious speech-to-text errors and drop filler words, booking verbs, dates, and times. "
        "For event_date and event_time: still convert them to the required formats (YYYY-MM-DD and HH:MM) as normal.\n"
        if has_cyrillic
        # Without an equally explicit instruction here, event_name has drifted into a
        # third language (observed: Russian for an English message) instead of staying
        # in the message's own language — the generic "keep the user's language" rule
        # in the shared instructions below was not forceful enough on its own.
        else (
            "CRITICAL: The user is writing in English (Latin script). "
            "For event_name: produce a SHORT title in English, at most 4 words, in the "
            "form '<activity> with <name>' — e.g. 'meeting with Stefan'. "
            "Do NOT translate any word to another language.\n"
        )
    )

    prompt_template = (
        "You are an extraction assistant for calendar event scheduling. "
        "Extract only user-provided event fields from the user message and return JSON only.\n\n"
        "{language_hint}"
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
        "- event_name: a concise title of at most 4 words — an activity plus the participant (e.g. 'состанок со Стефан'). Exclude the booking verb, the date, and the time. Keep the user's language and script without translating.\n"
        "- event_date: always output in YYYY-MM-DD format, converting any date expression the user wrote.\n"
        "- event_time: always output in HH:MM 24-hour format, converting any time expression the user wrote.\n\n"
        "User message:\n{message}"
    )

    chain = create_simple_chain(prompt_template)
    result = chain.invoke({"message": message, "current_date": current_date, "language_hint": language_hint})

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


def _numbered_options(values: Iterable[str]) -> str:
    """Render a closed list as a numbered block for the extraction prompt."""
    return "\n".join(f"{index}. {value}" for index, value in enumerate(values, start=1))


def _resolve_ewc_code_from_waste_type(extracted: dict[str, Any]) -> dict[str, Any]:
    """Resolve ewc_code + is_hazardous deterministically from waste_type.

    Shared by both waste-form chains (identification and transport) — it reads only
    waste_type and writes only the two derived code fields, so nothing in it is specific
    to either form.

    The LLM only picks a waste_type description off the injected closed lists; the code
    and hazard class are then looked up in Python, not trusted from the model. This
    guarantees the invariant both request schemas enforce — an asterisked (hazardous)
    code is never paired with is_hazardous=false, and vice versa — because both fields
    come from the same map entry. When waste_type matches no known description the code
    fields are left absent, so validation fails loudly downstream rather than the form
    silently carrying a wrong code.
    """
    normalized = dict(extracted)

    waste_type = normalized.get("waste_type")
    if isinstance(waste_type, str):
        description = " ".join(waste_type.split())

        hazardous_by_desc = {value: code for code, value in _EWC_HAZARDOUS_CODE_MAP.items()}
        non_hazardous_by_desc = {value: code for code, value in _EWC_NON_HAZARDOUS_CODE_MAP.items()}

        if description in hazardous_by_desc:
            normalized["waste_type"] = description
            normalized["ewc_code"] = hazardous_by_desc[description]
            normalized["is_hazardous"] = True
        elif description in non_hazardous_by_desc:
            normalized["waste_type"] = description
            normalized["ewc_code"] = non_hazardous_by_desc[description]
            normalized["is_hazardous"] = False
        else:
            # No map match: drop any model-guessed code/hazard so the incomplete payload
            # surfaces as missing fields instead of a fabricated code.
            normalized.pop("ewc_code", None)
            normalized.pop("is_hazardous", None)

    return normalized


def run_transport_form_extraction(message: str) -> dict[str, Any]:
    """Extract waste transport-form (transport manifest) fields from free text.

    Boundary vs. the earlier scaffold: waste_type is now snapped onto an exact value from
    waste_reference.json inside the prompt, and ewc_code + is_hazardous are resolved
    deterministically in Python afterwards instead of being asked of the model. Only
    firm_name / disposal_place_name -> UUID resolution is still left to the per-form setup
    layer, mirroring how invoice extraction yields firm_name and defers firm_id downstream.

    Three weights and two dates, matching the template's boxes: waste_owner_total_kg is
    section 3's declared quantity, collector_total_kg + collector_date are the section 4/5
    handover pair (one event recorded by both sides, so one date), and end_owner_* is
    section 6's receipt at the disposal place.
    """
    if _contains_prompt_injection(message):
        raise ValueError(
            "Transport-form extraction request rejected due to suspected prompt-injection content. "
            "Provide only transport-form details without meta-instructions."
        )

    # ewc_code / is_hazardous are intentionally NOT accepted from the model — they are
    # derived from waste_type in _resolve_ewc_code_from_waste_type.
    allowed_keys = {
        "firm_name",
        "disposal_place_name",
        "waste_type",
        "waste_owner_total_kg",
        "collector_total_kg",
        "collector_date",
        "end_owner_total_kg",
        "end_owner_date",
        "note",
    }

    prompt_template = (
        "You are an extraction assistant for a waste transport manifest (transport form). "
        "Extract only user-provided fields from the user message and return JSON only.\n\n"
        "Expected keys:\n"
        "firm_name (the waste owner / firm handing over the waste)\n"
        "disposal_place_name (the end owner / disposal facility receiving the waste — a "
        "landfill, депонија, or other named facility)\n"
        "waste_type (the kind of waste — see closed list below)\n"
        "waste_owner_total_kg (total quantity of waste declared by the waste owner)\n"
        "collector_total_kg (weight handed over to and received by the collector)\n"
        "collector_date (YYYY-MM-DD, the date of that handover)\n"
        "end_owner_total_kg (weight received at the end owner / disposal facility)\n"
        "end_owner_date (YYYY-MM-DD, the date of that receipt)\n"
        "note (optional free-text remark)\n\n"
        "Closed list — for waste_type you MUST copy one option EXACTLY as written "
        "(same words, same Macedonian spelling). If none clearly fits, omit the key.\n\n"
        "waste_type options:\n{waste_type_options}\n\n"
        "Rules:\n"
        "- Do not output keys outside the expected list.\n"
        "- If a key is missing or uncertain, omit it.\n"
        "- Do not include markdown fences or extra text.\n"
        "- For waste_type, output the option string verbatim — never a paraphrase, "
        "translation, or the list number.\n"
        # This rule is load-bearing, not decorative. ewc_code is derived from waste_type
        # downstream, and the derivation can only blank an unmatched waste_type when the
        # model OMITS it — a paraphrase onto a real list entry looks like a clean match and
        # ships a fabricated EWC code on a legal document. Loosening the wording here
        # measurably reintroduced that (glass waste -> 'Отпад од пластика' -> 02 01 04).
        "- If the waste described is NOT on the list, omit waste_type entirely. Never "
        "substitute the nearest, most similar, or most likely option — a missing waste "
        "type is corrected later, a wrong one becomes a false legal record.\n"
        # The chain used to find the destination only from the Macedonian 'на/до депонија X'
        # shape and returned nothing for English phrasings like 'at the X landfill', which
        # cost the whole receiving party. Both surfaces are now spelled out explicitly.
        # Scoped to disposal_place_name only: broader 'interpret generously' phrasing here
        # bled into waste_type and caused exactly the fabrication the rule above forbids.
        "- disposal_place_name is the RECEIVING party, and is written in either language: "
        "'на депонија X', 'примени во X', 'at the X landfill', 'received at X'. Output only "
        "the facility's own name, dropping the generic word around it — from 'at the Drisla "
        "landfill' output 'Drisla'. This applies to disposal_place_name alone; it relaxes "
        "nothing about waste_type.\n"
        "- All weights must be numeric JSON values in kilograms, never words.\n"
        "- Convert number words in any language to digits, including Macedonian: "
        "'пет' is 5, 'сто' is 100, 'илјада' is 1000.\n"
        "- All dates must be in YYYY-MM-DD format.\n\n"
        "User message:\n{message}"
    )

    chain = create_simple_chain(prompt_template)
    result = chain.invoke(
        {
            "message": message,
            "waste_type_options": _numbered_options(
                list(_EWC_HAZARDOUS_CODE_MAP.values()) + list(_EWC_NON_HAZARDOUS_CODE_MAP.values())
            ),
        }
    )

    raw = result if isinstance(result, str) else str(result)
    extracted = _normalize_extraction_output(raw, allowed_keys=allowed_keys)
    return _resolve_ewc_code_from_waste_type(extracted)


def run_identification_form_extraction(message: str) -> dict[str, Any]:
    """Extract waste identification-form fields from free text.

    Boundary vs. the earlier scaffold: the three closed-list fields (packing_method,
    waste_origin, waste_operation_code) and waste_type are now snapped onto exact
    Macedonian values from waste_reference.json inside the prompt, and ewc_code +
    is_hazardous are resolved deterministically in Python afterwards. Only firm_name /
    contact_name -> UUID resolution is still left to the per-form setup layer, mirroring
    how invoice extraction yields firm_name and defers firm_id downstream.
    """
    if _contains_prompt_injection(message):
        raise ValueError(
            "Identification-form extraction request rejected due to suspected prompt-injection content. "
            "Provide only identification-form details without meta-instructions."
        )

    # ewc_code / is_hazardous are intentionally NOT accepted from the model — they are
    # derived from waste_type in _resolve_ewc_code_from_waste_type.
    allowed_keys = {
        "firm_name",
        "contact_name",
        "waste_location",
        "waste_type",
        "packing_method",
        "total_weight_kg",
        "waste_origin",
        "waste_operation_code",
        "place",
        "date",
    }

    prompt_template = (
        "You are an extraction assistant for a waste identification form. "
        "Extract only user-provided fields from the user message and return JSON only.\n\n"
        "Expected keys:\n"
        "firm_name (the waste owner / firm)\n"
        "contact_name (the responsible person)\n"
        "waste_location (where the waste is physically located)\n"
        "waste_type (the kind of waste — see closed list below)\n"
        "packing_method (how the waste is packaged — see closed list below)\n"
        "total_weight_kg (total weight in kilograms)\n"
        "waste_origin (where within the business the waste originates — see closed list below)\n"
        "waste_operation_code (planned recovery/disposal operation — see closed list below)\n"
        "place (place where the form is signed)\n"
        "date (YYYY-MM-DD)\n\n"
        "Closed lists — for these four fields you MUST copy one option EXACTLY as written "
        "(same words, same Macedonian spelling). If none clearly fits, omit the key.\n\n"
        "waste_type options:\n{waste_type_options}\n\n"
        "packing_method options:\n{packing_method_options}\n\n"
        "waste_origin options:\n{waste_origin_options}\n\n"
        "waste_operation_code options:\n{waste_operation_code_options}\n\n"
        "Rules:\n"
        "- Do not output keys outside the expected list.\n"
        "- If a key is missing or uncertain, omit it.\n"
        "- Do not include markdown fences or extra text.\n"
        "- For waste_type, packing_method, waste_origin, and waste_operation_code, output "
        "the option string verbatim — never a paraphrase, translation, or the list number.\n"
        "- total_weight_kg must be a numeric JSON value in kilograms, never words.\n"
        "- Convert number words in any language to digits, including Macedonian: "
        "'пет' is 5, 'сто' is 100, 'илјада' is 1000.\n"
        "- date must be in YYYY-MM-DD format.\n\n"
        "User message:\n{message}"
    )

    chain = create_simple_chain(prompt_template)
    result = chain.invoke(
        {
            "message": message,
            "waste_type_options": _numbered_options(
                list(_EWC_HAZARDOUS_CODE_MAP.values()) + list(_EWC_NON_HAZARDOUS_CODE_MAP.values())
            ),
            "packing_method_options": _numbered_options(_PACKING_METHODS),
            "waste_origin_options": _numbered_options(_WASTE_ORIGINS),
            "waste_operation_code_options": _numbered_options(_WASTE_OPERATIONS_CODES),
        }
    )

    raw = result if isinstance(result, str) else str(result)
    extracted = _normalize_extraction_output(raw, allowed_keys=allowed_keys)
    return _resolve_ewc_code_from_waste_type(extracted)
