"""Disposal-place lookup helpers for transport-form orchestration.

Resolves an end-owner / disposal-facility NAME (from extraction) to a stored
disposal_places row — the transport-form counterpart of
identification_forms.contact_lookup.fetch_contact_by_name.

The generic name-matching machinery (transliteration, tokenization, fuzzy scoring,
best-match selection) is reused verbatim from firm_lookup so there is exactly one scorer
in the service. Only the table and returned columns differ here. Unlike contacts, a
disposal place has no owning-firm relationship — it is a tenant-wide facility that any
firm's waste can be sent to — so the search takes no scoping parameter beyond tenant_id.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from services.invoices.firm_lookup import (
    MAX_FUZZY_CANDIDATES,
    _normalize_name_tokens,
    _select_best_fuzzy_match,
)
from services.storage import supabase

logger = logging.getLogger(__name__)

# `place` is the facility's town — it renders as section 6's "Во …" box. All five are
# NOT NULL in the schema, so unlike the firm's address/city they need no blank guard.
_DISPOSAL_PLACE_COLUMNS = "id, name, address, place, email, phone_number"


def _normalize_disposal_place_name(value: str) -> str:
    tokens = _normalize_name_tokens(value)
    normalized = " ".join(tokens)
    if not normalized:
        raise ValueError("Extracted disposal_place_name is empty.")
    return normalized


def _disposal_places_query(owner_auth_id: str):
    """Base disposal_places select scoped to the tenant."""
    return (
        supabase.table("disposal_places")
        .select(_DISPOSAL_PLACE_COLUMNS)
        .eq("tenant_id", owner_auth_id)
    )


def fetch_disposal_place_by_name(owner_auth_id: str, disposal_place_name: str) -> dict[str, Any]:
    """Fetch id, address, place, email, and phone for a tenant's disposal place by name.

    Resolution order mirrors firm_lookup: exact name, then ilike substring, then a
    transliteration-aware fuzzy pass (with a cross-script fallback that loads all
    candidates when ilike returns nothing). Raises ValueError when no candidate clears
    the fuzzy threshold — the caller decides whether that is fatal.
    """
    normalized_name = _normalize_disposal_place_name(disposal_place_name)
    raw_name = " ".join(disposal_place_name.strip().split())

    exact_response = _disposal_places_query(owner_auth_id).eq("name", raw_name).limit(1).execute()
    rows = exact_response.data or []

    if not rows:
        fallback_response = (
            _disposal_places_query(owner_auth_id)
            .ilike("name", f"%{raw_name}%")
            .limit(25)
            .execute()
        )
        rows = fallback_response.data or []

    if not rows:
        # Anchor ilike on the longest raw token to avoid loading the whole table. Raw
        # (non-transliterated) token deliberately: it runs against the stored name column,
        # which may be Cyrillic or Latin, and the raw input shares that script more often.
        raw_tokens = disposal_place_name.strip().split()
        raw_anchor = max(raw_tokens, key=len) if raw_tokens else disposal_place_name.strip()

        fuzzy_response = (
            _disposal_places_query(owner_auth_id)
            .ilike("name", f"%{raw_anchor}%")
            .limit(MAX_FUZZY_CANDIDATES)
            .execute()
        )
        fuzzy_rows = fuzzy_response.data or []

        # Cross-script case (Latin input vs Cyrillic DB or vice versa): ilike returns
        # nothing, so load all candidates for the transliteration-aware scorer.
        if not fuzzy_rows:
            fallback_all = _disposal_places_query(owner_auth_id).limit(MAX_FUZZY_CANDIDATES).execute()
            fuzzy_rows = fallback_all.data or []

        if len(fuzzy_rows) == MAX_FUZZY_CANDIDATES:
            logger.warning(
                "Fuzzy disposal-place lookup hit cap of %d rows for tenant '%s' (anchor=%r)",
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
            f"No disposal place found for tenant '{owner_auth_id}' "
            f"with name '{disposal_place_name}'."
        )

    row = rows[0]
    return {
        "disposal_place_id": row.get("id"),
        "disposal_place_name": row.get("name"),
        "disposal_place_address": row.get("address"),
        "disposal_place_location": row.get("place"),
        "disposal_place_email": row.get("email"),
        "disposal_place_phone_number": row.get("phone_number"),
    }


def fetch_disposal_place_from_extracted(
    owner_auth_id: str,
    extracted_fields: Mapping[str, Any],
) -> dict[str, Any]:
    """Resolve disposal-place details using disposal_place_name from extraction output."""
    raw_name = extracted_fields.get("disposal_place_name")
    if not isinstance(raw_name, str):
        raise ValueError("Extracted fields do not contain a valid disposal_place_name.")

    return fetch_disposal_place_by_name(owner_auth_id, raw_name)
