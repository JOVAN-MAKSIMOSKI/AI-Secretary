"""Transport-form extraction orchestration.

Single point that runs the LLM extraction chain and then enriches it with resolved
party ids — the transport-form analogue of
services.identification_forms.extraction.extract_identification_form_fields_from_message.
Mirrors that function's contract: party lookups are best-effort, so a lookup miss leaves
the field names in the payload for the caller/UI to resolve, rather than failing the
whole extraction.
"""

from __future__ import annotations

from typing import Any

from langchain import run_transport_form_extraction
from services.invoices.firm_lookup import fetch_firm_for_transport_form
from services.transport_forms.disposal_place_lookup import fetch_disposal_place_from_extracted


def extract_transport_form_fields_from_message(
    message: str,
    owner_auth_id: str | None = None,
) -> dict[str, Any]:
    """Extract transport-form fields and resolve firm + disposal place by name.

    The chain yields firm_name / disposal_place_name (plus the waste fields and derived
    ewc_code/is_hazardous). When owner_auth_id is provided, resolve each name to its
    stored record and merge in the ids + rendered detail (firm address/city, disposal
    place address/town).

    Unlike the identification form — where the contact lookup is deliberately scoped by
    the resolved firm_id because a contact belongs to exactly one firm — the two parties
    here are independent: a disposal place is a tenant-wide facility that any firm's
    waste can be sent to. So each lookup runs on its own and a failure in one does not
    affect the other. A name that resolves to no record is left as-is: extraction stays
    usable and the mismatch surfaces later at the render route, matching the invoice flow.
    """
    extracted = run_transport_form_extraction(message)

    if owner_auth_id:
        if isinstance(extracted.get("firm_name"), str):
            try:
                extracted.update(
                    fetch_firm_for_transport_form(owner_auth_id, extracted["firm_name"])
                )
            except ValueError:
                # Keep the response usable when the firm cannot be resolved.
                pass

        if isinstance(extracted.get("disposal_place_name"), str):
            try:
                extracted.update(
                    fetch_disposal_place_from_extracted(owner_auth_id, extracted)
                )
            except ValueError:
                # Keep the response usable when the disposal place cannot be resolved.
                pass

    return extracted
