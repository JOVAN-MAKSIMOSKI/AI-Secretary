"""Contact lookup helpers for identification-form orchestration.

Resolves a responsible-person NAME (from extraction) to a stored contact's id, phone,
and email — the identification-form counterpart of firm_lookup.fetch_firm_contact_by_name.

The generic name-matching machinery (transliteration, tokenization, fuzzy scoring,
best-match selection) is reused verbatim from firm_lookup so there is exactly one scorer
in the service. Only the table and returned columns differ here. The firm-name stopwords
baked into that scorer ("клиент", "фирма", …) are inert for personal names, so importing
them is harmless.

Each contact belongs to exactly one firm (contacts.firm_id). When the caller knows the
firm (an identification form always resolves the firm first), it passes firm_id so the
search is scoped to that firm's contacts — this is what verifies the responsible person
actually belongs to the named firm. firm_id is optional so a firm-less address-book
lookup still works.
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

_CONTACT_COLUMNS = "id, name, phone_number, email"

# Same floor firm_lookup applies in _select_best_fuzzy_match; kept as a named constant so
# the single-candidate ilike path below uses the identical bar rather than a magic number.
_FUZZY_MATCH_THRESHOLD = 0.64


def _normalize_contact_name(value: str) -> str:
    tokens = _normalize_name_tokens(value)
    normalized = " ".join(tokens)
    if not normalized:
        raise ValueError("Extracted contact_name is empty.")
    return normalized


def _contacts_query(owner_auth_id: str, firm_id: str | None):
    """Base contacts select scoped to the tenant, and to the firm when one is given."""
    query = supabase.table("contacts").select(_CONTACT_COLUMNS).eq("tenant_id", owner_auth_id)
    if firm_id is not None:
        query = query.eq("firm_id", firm_id)
    return query


def fetch_contact_by_name(
    owner_auth_id: str,
    contact_name: str,
    firm_id: str | None = None,
) -> dict[str, Any]:
    """Fetch id, phone_number, and email for a tenant's contact by name.

    When firm_id is given the search is scoped to that firm's contacts, so a match is
    also proof the contact belongs to the firm. Resolution order mirrors firm_lookup:
    exact name, then ilike substring, then a transliteration-aware fuzzy pass (with a
    cross-script fallback that loads all candidates when ilike returns nothing). Raises
    ValueError when no candidate clears the fuzzy threshold — the caller decides whether
    that is fatal.
    """
    normalized_name = _normalize_contact_name(contact_name)
    raw_name = " ".join(contact_name.strip().split())

    exact_response = (
        _contacts_query(owner_auth_id, firm_id)
        .eq("name", raw_name)
        .limit(1)
        .execute()
    )
    rows = exact_response.data or []

    if not rows:
        fallback_response = (
            _contacts_query(owner_auth_id, firm_id)
            .ilike("name", f"%{raw_name}%")
            .limit(25)
            .execute()
        )
        rows = fallback_response.data or []

    if not rows:
        # Anchor ilike on the longest raw token to avoid loading the whole table. Raw
        # (non-transliterated) token deliberately: it runs against the stored name column,
        # which may be Cyrillic or Latin, and the raw input shares that script more often.
        raw_tokens = contact_name.strip().split()
        raw_anchor = max(raw_tokens, key=len) if raw_tokens else contact_name.strip()

        fuzzy_response = (
            _contacts_query(owner_auth_id, firm_id)
            .ilike("name", f"%{raw_anchor}%")
            .limit(MAX_FUZZY_CANDIDATES)
            .execute()
        )
        fuzzy_rows = fuzzy_response.data or []

        # Cross-script case (Latin input vs Cyrillic DB or vice versa): ilike returns
        # nothing, so load all candidates for the transliteration-aware scorer.
        if not fuzzy_rows:
            fallback_all = (
                _contacts_query(owner_auth_id, firm_id)
                .limit(MAX_FUZZY_CANDIDATES)
                .execute()
            )
            fuzzy_rows = fallback_all.data or []

        if len(fuzzy_rows) == MAX_FUZZY_CANDIDATES:
            logger.warning(
                "Fuzzy contact lookup hit cap of %d rows for tenant '%s' (anchor=%r)",
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
            f"No contact found for tenant '{owner_auth_id}' with name '{contact_name}'."
        )

    row = rows[0]
    return {
        "contact_id": row.get("id"),
        "contact_name": row.get("name"),
        "contact_phone_number": row.get("phone_number"),
        "contact_email": row.get("email"),
    }


def fetch_contact_from_extracted(
    owner_auth_id: str,
    extracted_fields: Mapping[str, Any],
    firm_id: str | None = None,
) -> dict[str, Any]:
    """Resolve contact details using contact_name from extraction output.

    firm_id, when passed, scopes the search to that firm's contacts so the resolved
    responsible person is guaranteed to belong to the form's firm.
    """
    raw_contact_name = extracted_fields.get("contact_name")
    if not isinstance(raw_contact_name, str):
        raise ValueError("Extracted fields do not contain a valid contact_name.")

    return fetch_contact_by_name(owner_auth_id, raw_contact_name, firm_id=firm_id)
