# Plan: identification-form chain (prompt → rendered document)

Scope confirmed with user: **identification form only**. Transport form reuses this
skeleton afterwards; it has no template yet.

Existing state: `identification_forms` table, `identificationForm.ts` Zod schema,
`templatesIdentificationForm` table, and a scaffold `run_identification_form_extraction`
all exist (commit f573a32). Nothing routes to them, nothing renders.

Target flow, mirroring the invoice pipeline:
```
message → resolve chain → /documents/extract-identification-form (resolves firm_id +
contact_id) → user confirms → POST /documents/identification-form (Pydantic validate →
insert row → render docx → upload to Supabase → stream back)
```

## Template

`IdentificationFormTemplate.tokenized.docx` — the user's file with `{{...}}` delimiters
added at run level (fonts/tabs preserved). Two authored edits, both flagged to the user:
- stray `.` run before `date` dropped (would have rendered `Дата .2026-07-24`)
- section 4 label `wasteOperationsCode : wasteOperationsCode` → `Шифра на операција : {{wasteOperationsCode}}`

Token names are kept as the user authored them; the render layer maps them to columns,
exactly as the invoice route already does (`firm.taxnumber` ← `firm_tax_number`).

| Template token | Source |
|---|---|
| `{{firm.name}}` `{{firm.permit}}` `{{firm.address}}` | `firms.name` / `permit_number` / `address` via `firm_id` |
| `{{contact.name}}` `{{contact.phoneNumber}}` `{{contact.email}}` | `contacts.name` / `phone_number` / `email` via `contact_id` |
| `{{wasteLocation}}` | `identification_forms.waste_location` |
| `{{wasteDescription}}` | `waste_type` |
| `{{wasteCode}}` | `ewc_code` |
| `{{wasteMethodofPacking}}` | `packing_method` |
| `{{TotalWasteWeight}}` | `total_weight_kg` |
| `{{wasteOrigin}}` | `waste_origin` |
| `{{wasteOperationsCode}}` | `waste_operation_code` |
| `{{place}}` `{{date}}` | `place` / `date` |

Left blank by design (no column, confirm with user): IPPC permit number (1.2),
H-шифра (3.3), signature line. Hardcoded in template: `Вид на транспорт: патен` (3.7).

## Status

- **Phase 1 — done.** docx allowed for the identification form (python + web),
  `waste_reference.json` generated with a CI drift check. Verified: type-check, pytest,
  offline eval, byte-identical regeneration.
- **Phase 2 — done.** Extraction chain hardened; `POST /documents/extract-identification-form`
  added; `_postprocess_identification_extraction` derives `ewc_code`/`is_hazardous` from
  `waste_type` deterministically. Guard tests in `tests/test_identification_extraction.py`
  (7). Verified: prompt injects all 4 closed lists, model-supplied code is overridden,
  unknown waste_type drops fabricated code.
- **Phase 3 — done.** `services/identification_forms/contact_lookup.py` reuses the firm
  scorer (import, no edit to the invoice fuzzy path); `firm_lookup` refactored so the
  shared resolver takes a column list — invoice path shape/columns provably unchanged —
  plus `fetch_firm_for_identification_form` returning address + permit_number.
  `services/identification_forms/extraction.py` orchestrates chain + both lookups; the
  extract route now resolves parties by passing `owner_auth_id`. Guard tests in
  `tests/test_contact_lookup.py` (6). Verified: invoice shape unchanged, cross-script
  contact fuzzy match, no-match → ValueError.
- **Phase 3.5 — done.** Resolved the open question "should contacts belong to a firm?":
  YES, one contact ↔ one firm. `contacts.firm_id` NOT NULL + FK to `firms(id)` (cascade),
  migration `20260725000000_add_contact_firm_id` (deleted the 1 disposable test contact,
  applied + resolved + generated, live-verified). Python model/router carry `firm_id` and
  validate the firm belongs to the tenant (404 otherwise). Contact lookup now takes an
  optional `firm_id` and the orchestrator resolves the firm first, then scopes the contact
  search to it — so a resolved responsible person is provably a contact of the form's firm.
  Web: SDK types + a firm dropdown (required) on the create/edit contact forms + firm name
  on each contact card. Tests: 8 in `tests/test_contact_lookup.py` (added 2 firm-scoping
  proofs). Verified: full pytest 1100, web type-check clean against project config,
  Pydantic firm_id required, live DB shape.
- **Phase 5 — done.** Pydantic `IdentificationFormRequest` (authoritative gate, reads
  `waste_reference.json`); migration `20260725010000_add_identification_form_storage`
  (storagePath unique + status + title + template_id — applied, resolved, generated,
  live-verified); `services/identification_forms/word.py` run-level docx renderer;
  `POST /documents/identification-form` (tenant + firm + contact verify, 422 on name
  mismatch / blank address / blank permit / contact-not-of-firm, insert → render →
  upload with row rollback, stream); `createIdentificationFormDocument` in the web SDK.
  Tests: `test_identification_form_request.py` (11), `test_identification_form_render.py`
  (6), `test_identification_form_route.py` (6). Verified against the REAL template
  (all 15 tokens filled, no leftover braces, section 4 label kept, formatting
  preserved), and the route through TestClient (happy path + every 422/404 guard).
- **Phase 6 (voice) — done.** Twilio call support with the invoice-style "call origin →
  dashboard card" pattern. Migration `20260726000000_add_identification_form_call_origin`
  (origin + downloaded_at, applied + live-verified). Render route stamps origin from
  `X-Document-Origin` header. Twilio `executeChain` gained an `identification_form_extraction`
  case (extract → resolve → render with origin=call → speak MK confirmation; previously
  hit the "Дејството е непознато" default). Agent routes `/identification-forms/
  pending-call-downloads|call-downloads/zip|call-downloads/confirm` mirror the invoice
  trio; `getDocumentBuffer` extended to 'identification-form'. Dashboard "Call Forms" card
  (Card 5) + 3 SDK functions. Tests: 3 origin-stamping cases added to
  test_identification_form_route.py (9 total). Verified: origin stamping via TestClient
  (call/manual/bogus), full pytest 1125, all type-checks clean, migration live.
  **NOT verified live:** the running uvicorn served pre-edit code (reload didn't pick up
  the header) so the live curl showed origin=manual — the CURRENT code is correct (proven
  in-process); needs a Python service restart. The Twilio case itself is only reachable on
  a real phone call — untested end-to-end on voice.
- **Phase 4 — done.** `identification_form_extraction` registered in `chainRegistry.ts`
  (ChainId + CHAIN_REGISTRY, description written to contrast firm_lookup/invoice/offer);
  `directResolverChain.ts` case calls `/documents/extract-identification-form`;
  `Dashboard.tsx` shows the extracted fields under its own branch. 5 golden cases added
  (MK/EN canonical, firm_lookup boundary from the user's real production mis-route,
  no-keyword, injection). Verified: eval:coverage 8/8 chains, eval:offline 15/15,
  agent type-check clean, all 40 golden cases parse with unique ids.
  **NOT run:** eval:routing (live API, costs money / GitHub Models quota) — the only test
  that proves the router distinguishes this chain from firm_lookup at inference time. User
  to run `pnpm --filter agent eval:routing` and, if green, decide on baseline.json. The
  0.93 overallAccuracy floor's comment still cites 16 cases; it is now 40 — the floor
  still holds mathematically but its comment is stale until the next measured run.

## Phase 1 — template format + shared reference data

1. **Allow docx for identification-form templates.** `routers/documents.py:516,534`
   currently forces xlsx for both waste forms. Drop `identification_form` from
   `xlsx_only_doc_types`; mirror in `DocumentTemplateSection.tsx` and the
   `uploadDocumentTemplate` union in `supabase-client.ts`. Transport form stays xlsx-only
   until its template arrives.
2. **Generate `apps/python/resources/waste_reference.json`** from `wasteChapters.ts`
   (both EWC code maps, `PACKING_METHODS_MK`, `WASTE_ORIGINS_MK`, `WASTE_OPERATIONS_CODES`)
   via `npm run gen:waste-reference`, plus a CI check that regenerating produces no diff.
   Keeps `wasteChapters.ts` the single source of truth — no hand-mirrored copy to drift.

## Phase 2 — extraction chain

3. **Harden `run_identification_form_extraction`** (`langchain.py:796`). Current prompt
   asks for `packing_method` / `waste_origin` as free text and never asks for a code, so
   its output cannot pass `identificationForm.ts`. Changes:
   - inject the closed MK lists from the JSON; instruct the model to snap to an exact
     list value or omit the key
   - add `ewc_code` + `is_hazardous`, resolved from the waste description against the
     injected code maps (asterisked code ⇒ hazardous)
   - keep `waste_type` as the canonical map description; carry the user's own wording
     through only if no code matches, so the form never shows a code that contradicts
     its description
   - `place` and `date` stay required (both NOT NULL, both on the template)
4. **`POST /documents/extract-identification-form`** in `routers/documents.py`, same
   shape as `/extract-offer` (`:195`) — `ExtractionRequest` in, `ExtractionResponse` out,
   400 on ValueError, 502 on chain failure.

## Phase 3 — party resolution

5. **`services/identification_forms/contact_lookup.py`** — `fetch_contact_by_name`,
   mirroring `firm_lookup.py` (exact → ilike → transliteration-aware fuzzy, 0.64 floor).
   Contacts are tenant-scoped with no `firm_id` FK, so this is a tenant-wide search;
   raised with the user as an open question.
6. **Widen the firm select** to include `address` and `permit_number`. Both are nullable
   — reject with 422 when either is missing rather than rendering a blank legal box,
   matching how the invoice route 422s on firm mismatch (`documents.py:288`).

## Phase 4 — chain registration + routing

The agent's job on this chain ends at "here is the draft". It does **not** call the
render route on the web path — that mirrors `invoice_extraction`, where the browser
posts the confirmed payload to Python directly (`supabase-client.ts:998`) and the agent
is absent from the second call.

7. `ChainId` + `CHAIN_REGISTRY` entry `identification_form_extraction`
   (`chainRegistry.ts`), empty `keywords[]` per guardrails, description written to
   contrast against `invoice_extraction` and `waste_law_query`.
8. `directResolverChain.ts` case: call `/documents/extract-identification-form` and
   return the payload, exactly like the `invoice_extraction` branch (`:62`). No party
   resolution or validation in the agent — Phase 3 does the former inside the extract
   call, Phase 5 does the latter at the render route.
9. **Demote `identificationForm.ts` rather than wire it.** Pydantic at the render route
   is the authoritative gate (see Phase 5); a second copy of the rules in Zod would drift.
   Update its header comment to say so and to record its one remaining purpose: a cheap
   pre-flight on the future voice path, so a call can ask "во што е спакуван отпадот?"
   instead of failing the request. Not imported by anything in this pass.
10. **≥4 golden routing cases** in `src/evals/golden/routing.jsonl`
    (`MIN_GOLDEN_CASES_PER_CHAIN = 4`, else the offline gate fails the build), bilingual
    MK/EN, plus a near-miss case that must still route to `waste_law_query`. Re-run the
    routing eval and update `baseline.json` only if per-chain accuracy holds.

## Phase 5 — validate, render, persist

11. **Pydantic `IdentificationFormRequest`** in `models/documents.py` — the single
    authoritative gate, mirroring `InvoiceRequest`. Carries over every rule currently
    expressed in `identificationForm.ts`: UUID `firm_id`/`contact_id`, `total_weight_kg`
    positive at ≤2dp, ISO `date`, `packing_method`/`waste_origin`/`waste_operation_code`
    against the closed lists, and `ewc_code` belonging to the map that matches
    `is_hazardous`. Reads those lists from `waste_reference.json` (Phase 1) so the rules
    have one source, not a hand-copy.
12. **`services/identification_forms/word.py`** — `render_identification_form_bytes`.
    python-docx, run-level `{{token}}` replacement over body paragraphs and table cells,
    dot-path flattening like `_flatten_values`. Never `paragraph.text =`. This is new:
    the only existing renderer is openpyxl, and the offer docx route streams unrendered.
13. **Migration `add_identification_form_storage`** — `storagePath TEXT @unique`,
    `status TEXT`, `title TEXT`, `template_id UUID` on `identification_forms`. Without
    these the form cannot record its generated file or appear in Documents, so "treated
    exactly as invoices" is not achievable as the table stands. Hand-authored SQL +
    `prisma migrate resolve --applied` (established workflow), then `prisma generate`.
14. **`POST /documents/identification-form`** — the one door both callers walk through.
    Resolve tenant, re-load firm + contact and verify they belong to the tenant (the
    invoice route's 422-on-mismatch guard, `documents.py:288`), insert the row at
    `{tenant}/identification-forms/{id}.docx`, render, upload, stream back. Roll the row
    back on upload failure when there is no download to fall back on, same as the
    invoice route's voice path (`documents.py:429`).
15. **`createIdentificationFormDocument`** in `supabase-client.ts`, posting straight to
    Python like `createInvoiceDocument`. Note this is a deliberate repeat of the existing
    deviation from `CLAUDE.md`'s "web → agent → python" rule, not an accident: document
    generation already goes browser → Python today.

## Open questions for the user

- IPPC number, H-шифра, signature line: stay blank, or do they need columns?
- Should `contacts` gain a `firm_id` FK so a responsible person belongs to a firm?
- Is `Вид на транспорт: патен` always road, or should it become a field?

## Not in this pass

Web UI for creating identification forms; Documents-page listing; transport-form chain.
