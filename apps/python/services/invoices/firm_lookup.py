"""Firm lookup helpers for invoice orchestration."""

from __future__ import annotations

import logging
import os
import re
from difflib import SequenceMatcher
from typing import Any, Mapping

from services.storage import supabase

logger = logging.getLogger(__name__)

MAX_FUZZY_CANDIDATES = int(os.getenv("CLIENT_FUZZY_LIMIT", "200"))


# Macedonian Cyrillic -> Latin transliteration for resilient matching.
_MK_CYR_TO_LAT = {
    "а": "a",
    "б": "b",
    "в": "v",
    "г": "g",
    "д": "d",
    "ѓ": "gj",
    "е": "e",
    "ж": "zh",
    "з": "z",
    "ѕ": "dz",
    "и": "i",
    "ј": "j",
    "к": "k",
    "л": "l",
    "љ": "lj",
    "м": "m",
    "н": "n",
    "њ": "nj",
    "о": "o",
    "п": "p",
    "р": "r",
    "с": "s",
    "т": "t",
    "ќ": "kj",
    "у": "u",
    "ф": "f",
    "х": "h",
    "ц": "c",
    "ч": "ch",
    "џ": "dj",
    "ш": "sh",
}

_LEGAL_ENTITY_TOKENS = {
    "doo",
    "dooel",
    "ad",
    "dptu",
    "tr",
    "tp",
    "доо",
    "дооел",
    "ад",
    "дпту",
    "тр",
    "тп",
}

_NAME_STOPWORDS = {
    "client",
    "klient",
    "klientot",
    "kupuvac",
    "buyer",
    "company",
    "kompanija",
    "firma",
    "pretprijatie",
    "drustvo",
    "za",
    "so",
    "od",
    "vo",
    "na",
    "klient",
    "клиент",
    "клиентот",
    "компанија",
    "фирма",
    "претпријатие",
    "друштво",
}


def _mk_to_latin(value: str) -> str:
    return "".join(_MK_CYR_TO_LAT.get(ch, ch) for ch in value)


def _normalize_name_tokens(value: str) -> list[str]:
    normalized = value.strip().lower()
    normalized = _mk_to_latin(normalized)
    normalized = re.sub(r"[^a-z0-9 ]+", " ", normalized)
    normalized = " ".join(normalized.split())

    if not normalized:
        return []

    tokens = []
    for token in normalized.split(" "):
        if not token:
            continue
        if token in _LEGAL_ENTITY_TOKENS:
            continue
        if token in _NAME_STOPWORDS:
            continue
        tokens.append(token)

    return tokens


def _normalize_firm_name(value: str) -> str:
    tokens = _normalize_name_tokens(value)
    normalized = " ".join(tokens)
    if not normalized:
        raise ValueError("Extracted firm_name is empty.")
    return normalized


def _normalized_or_empty(value: str) -> str:
    return " ".join(_normalize_name_tokens(value))


def _token_similarity(source_tokens: set[str], other_tokens: set[str]) -> float:
    """Average best per-token match ratio of each source token against the closest
    other token. Unlike exact set intersection, this rewards near-miss tokens — a
    misheard 'joven' still scores ~0.8 against 'jovan' — which is exactly what STT
    errors produce. Diluting names (a surname the caller didn't say) no longer drops
    the whole-string score below threshold."""
    if not source_tokens or not other_tokens:
        return 0.0

    total = 0.0
    for source in source_tokens:
        total += max(SequenceMatcher(None, source, other).ratio() for other in other_tokens)
    return total / len(source_tokens)


def _score_candidate(normalized_target: str, normalized_candidate: str) -> float:
    if not normalized_target or not normalized_candidate:
        return 0.0

    if normalized_target == normalized_candidate:
        return 1.0

    if normalized_candidate in normalized_target or normalized_target in normalized_candidate:
        return 0.97

    target_tokens = set(normalized_target.split())
    candidate_tokens = set(normalized_candidate.split())
    if not target_tokens or not candidate_tokens:
        return 0.0

    intersection = target_tokens & candidate_tokens
    coverage = len(intersection) / len(candidate_tokens)
    recall = len(intersection) / len(target_tokens)
    union = target_tokens | candidate_tokens
    jaccard = len(intersection) / len(union) if union else 0.0
    sequence = SequenceMatcher(None, normalized_target, normalized_candidate).ratio()

    # Per-token fuzzy matching, recall-weighted: the spoken input is often a subset of
    # the stored name (first name only vs "Jovan Maksimoski"), so covering every *spoken*
    # token well matters more than covering every stored token. fuzzy_recall is used
    # unweighted so the per-token bar equals the global threshold — a single-edit mishear
    # like "Jove"→"Jovan" (~0.67) still clears it instead of being penalised under.
    fuzzy_recall = _token_similarity(target_tokens, candidate_tokens)
    fuzzy_coverage = _token_similarity(candidate_tokens, target_tokens)
    fuzzy_token_score = max(fuzzy_recall, ((fuzzy_recall + fuzzy_coverage) / 2) * 0.94)

    return max(
        sequence,
        coverage * 0.96,
        ((coverage + recall) / 2) * 0.94,
        jaccard * 0.92,
        fuzzy_token_score,
    )


def _select_best_fuzzy_match(rows: list[dict[str, Any]], normalized_target: str) -> dict[str, Any] | None:
    best_row: dict[str, Any] | None = None
    best_score = 0.0

    for row in rows:
        candidate_name = str(row.get("name") or "").strip()
        if not candidate_name:
            continue

        normalized_candidate = _normalized_or_empty(candidate_name)
        if not normalized_candidate:
            continue

        if normalized_candidate == normalized_target:
            return row

        score = _score_candidate(normalized_target, normalized_candidate)

        if score > best_score:
            best_score = score
            best_row = row

    if best_score >= 0.64:
        return best_row

    return None


# Column set the invoice flow needs. Kept as the default so that path is unchanged.
_INVOICE_FIRM_COLUMNS = "id, name, tax_number, email"
# The identification form additionally reads the firm's address and waste permit onto
# the rendered document, so it requests a wider set.
_IDENTIFICATION_FIRM_COLUMNS = "id, name, tax_number, email, address, permit_number"
# The transport form renders the firm as the waste owner: name + address in section 4,
# and city as the handover town ("Во …") shared by sections 4/5. It carries the
# collector's own permit (from businesses), not the firm's, so permit_number is absent.
_TRANSPORT_FORM_FIRM_COLUMNS = "id, name, tax_number, email, address, city"


def _find_firm_row_by_name(owner_auth_id: str, firm_name: str, columns: str) -> dict[str, Any]:
    """Resolve a single firm row by name: exact → ilike → transliteration-aware fuzzy.

    `columns` is the SELECT list, so callers fetch only what they consume. Raises
    ValueError when nothing clears the fuzzy threshold.
    """
    normalized_name = _normalize_firm_name(firm_name)
    raw_name = " ".join(firm_name.strip().split())

    exact_response = (
        supabase.table("firms")
        .select(columns)
        .eq("tenant_id", owner_auth_id)
        .eq("name", raw_name)
        .limit(1)
        .execute()
    )
    rows = exact_response.data or []

    if not rows:
        fallback_response = (
            supabase.table("firms")
            .select(columns)
            .eq("tenant_id", owner_auth_id)
            .ilike("name", f"%{raw_name}%")
            .limit(25)
            .execute()
        )
        rows = fallback_response.data or []

    if not rows:
        # Use the longest raw token as the DB-level anchor for ilike so we avoid
        # loading the full client table. The raw (non-transliterated) token is used
        # deliberately: ilike runs against the stored name column, which may be
        # Cyrillic or Latin — the raw input is more likely to share the same script.
        raw_tokens = firm_name.strip().split()
        raw_anchor = max(raw_tokens, key=len) if raw_tokens else firm_name.strip()

        fuzzy_response = (
            supabase.table("firms")
            .select(columns)
            .eq("tenant_id", owner_auth_id)
            .ilike("name", f"%{raw_anchor}%")
            .limit(MAX_FUZZY_CANDIDATES)
            .execute()
        )
        fuzzy_rows = fuzzy_response.data or []

        # Cross-script case: Latin input vs Cyrillic DB (or vice versa) will return
        # nothing from ilike. Fall back to loading all candidates so the
        # transliteration-aware scorer can still find a match.
        if not fuzzy_rows:
            fallback_all = (
                supabase.table("firms")
                .select(columns)
                .eq("tenant_id", owner_auth_id)
                .limit(MAX_FUZZY_CANDIDATES)
                .execute()
            )
            fuzzy_rows = fallback_all.data or []

        if len(fuzzy_rows) == MAX_FUZZY_CANDIDATES:
            logger.warning(
                "Fuzzy firm lookup hit cap of %d rows for tenant '%s' (anchor=%r)",
                MAX_FUZZY_CANDIDATES,
                owner_auth_id,
                raw_anchor,
            )

        if len(fuzzy_rows) == 1:
            rows = [fuzzy_rows[0]]
        else:
            best_match = _select_best_fuzzy_match(fuzzy_rows, normalized_name)
            rows = [best_match] if best_match else []

    if not rows:
        raise ValueError(
            f"No firm found for tenant '{owner_auth_id}' with name '{firm_name}'."
        )

    return rows[0]


def fetch_firm_contact_by_name(owner_auth_id: str, firm_name: str) -> dict[str, Any]:
    """Fetch firm id, tax number, and email for a tenant by firm name."""
    row = _find_firm_row_by_name(owner_auth_id, firm_name, _INVOICE_FIRM_COLUMNS)
    return {
        "firm_id": row.get("id"),
        "firm_name": row.get("name"),
        "firm_tax_number": row.get("tax_number"),
        "firm_email": row.get("email"),
    }


def fetch_firm_for_identification_form(owner_auth_id: str, firm_name: str) -> dict[str, Any]:
    """Fetch the firm fields an identification form renders: id, name, tax number,
    address, and waste permit number. Address and permit_number are nullable in the
    schema; they are returned as-is here and the render route rejects a form whose
    required legal boxes would be blank."""
    row = _find_firm_row_by_name(owner_auth_id, firm_name, _IDENTIFICATION_FIRM_COLUMNS)
    return {
        "firm_id": row.get("id"),
        "firm_name": row.get("name"),
        "firm_tax_number": row.get("tax_number"),
        "firm_address": row.get("address"),
        "firm_permit_number": row.get("permit_number"),
    }


def fetch_firm_for_transport_form(owner_auth_id: str, firm_name: str) -> dict[str, Any]:
    """Fetch the firm fields a transport form renders: id, name, tax number, address,
    and city. Address and city are nullable in the schema; they are returned as-is here
    and the render route rejects a form whose required legal boxes would be blank —
    city is the handover town in sections 4/5, so a blank one leaves "Во ___" empty."""
    row = _find_firm_row_by_name(owner_auth_id, firm_name, _TRANSPORT_FORM_FIRM_COLUMNS)
    return {
        "firm_id": row.get("id"),
        "firm_name": row.get("name"),
        "firm_tax_number": row.get("tax_number"),
        "firm_address": row.get("address"),
        "firm_city": row.get("city"),
    }


def fetch_firm_contact_from_extracted(
    owner_auth_id: str,
    extracted_fields: Mapping[str, Any],
) -> dict[str, Any]:
    """Resolve firm details using firm_name from LangChain extraction output."""
    raw_firm_name = extracted_fields.get("firm_name")
    if not isinstance(raw_firm_name, str):
        raise ValueError("Extracted fields do not contain a valid firm_name.")

    return fetch_firm_contact_by_name(owner_auth_id, raw_firm_name)
