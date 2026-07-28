"""Identification-form extraction orchestration.

Single point that runs the LLM extraction chain and then enriches it with resolved
party ids — the identification-form analogue of
services.invoices.excel.extract_invoice_fields_from_message. Mirrors that function's
contract: party lookups are best-effort, so a lookup miss leaves the field names in the
payload for the caller/UI to resolve, rather than failing the whole extraction.
"""

from __future__ import annotations

from typing import Any

from langchain import run_identification_form_extraction
from services.identification_forms.contact_lookup import fetch_contact_from_extracted
from services.invoices.firm_lookup import fetch_firm_for_identification_form


def extract_identification_form_fields_from_message(
    message: str,
    owner_auth_id: str | None = None,
) -> dict[str, Any]:
    """Extract identification-form fields and resolve firm + contact by name.

    The chain yields firm_name / contact_name (plus the waste fields and derived
    ewc_code/is_hazardous). When owner_auth_id is provided, resolve each name to its
    stored record and merge in the ids + rendered detail (firm address/permit, contact
    phone/email). The firm is resolved first so its id can scope the contact lookup —
    a contact belongs to exactly one firm, so this both finds the responsible person and
    proves they belong to the form's firm. A name that resolves to no record is left
    as-is: extraction stays usable and the mismatch surfaces later at the render route,
    matching the invoice flow.
    """
    extracted = run_identification_form_extraction(message)

    if owner_auth_id:
        resolved_firm_id: str | None = None
        if isinstance(extracted.get("firm_name"), str):
            try:
                firm_details = fetch_firm_for_identification_form(
                    owner_auth_id, extracted["firm_name"]
                )
                extracted.update(firm_details)
                resolved_firm_id = firm_details.get("firm_id")
            except ValueError:
                # Keep the response usable when the firm cannot be resolved.
                pass

        if isinstance(extracted.get("contact_name"), str):
            try:
                # Scope to the resolved firm when we have one: the responsible person
                # must be a contact of this firm. If the firm didn't resolve, fall back
                # to a tenant-wide contact search rather than blocking extraction.
                extracted.update(
                    fetch_contact_from_extracted(
                        owner_auth_id, extracted, firm_id=resolved_firm_id
                    )
                )
            except ValueError:
                # Keep the response usable when the contact cannot be resolved.
                pass

    return extracted
