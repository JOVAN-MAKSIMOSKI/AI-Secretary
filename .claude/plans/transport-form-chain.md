# Plan: transport-form chain (prompt → rendered document)

Scope confirmed with user: give `transport_forms` the same treatment
`identification_forms` just got — extraction hardening, party resolution, a Pydantic
gate, a renderer, storage tracking, and chain registration — so it reaches the same
"draft in chat → confirm → rendered document" end state.

**Template received 2026-07-27 and already tokenized by the user** (15 tokens). No longer
blocked; all five phases are implemented — see Status.

**Correction from the identification-form pattern:** the transport-form template is
**.docx, not .xlsx**. `transport-forms-table.md` and `waste-form-templates.md` (both
already-committed plans) assumed Excel — that assumption is wrong and the code built
from it (`xlsx_only_doc_types = {"transport_form"}` in `documents.py`, the matching
xlsx-forcing logic in `DocumentTemplateSection.tsx` / `supabase-client.ts`) needs to
flip to docx as part of this work. Net effect: transport form's renderer is a docx
run-substitution renderer, the *same kind* `identification_forms/word.py` already is —
more reuse, not less.

---

## Investigation: issues found in the existing scaffold

1. **`transport-forms-table.md` is stale against the shipped schema.** That plan
   confirmed a "snapshot, not FK" design (name/address/place/permit copied into columns
   at creation time). The actual committed `transport_forms` model
   (`apps/agent/prisma/schema.prisma:239`) does the opposite: it stores only
   `firm_id`/`disposal_place_id` FKs plus the classification and per-party kg/dates, and
   its own header comment says so explicitly ("REFERENCES parties by FK id rather than
   snapshotting"). This is actually the *right* state for this plan — it already matches
   how `identification_forms` resolves firm/contact at render time — but the plan doc
   should not be trusted as a description of the current schema. No schema change needed
   for this point; noting it so nobody re-derives snapshot columns from the stale doc.
2. **Template format was wrong in two committed places.** `xlsx_only_doc_types =
   {"transport_form"}` (`apps/python/routers/documents.py:781`) and the matching
   extension lock in `DocumentTemplateSection.tsx` force `.xlsx` for transport-form
   template uploads. Per the user, the real file is `.docx`. Both need to change (see
   Phase 1).
3. **No storage-tracking columns on `transport_forms`.** No `storagePath`, `status`,
   `title`, or `template_id` — same gap `identification_forms` had before
   `20260725010000_add_identification_form_storage`. Without these there is nowhere to
   record a generated file even once a renderer exists.
4. **Extraction chain is an unhardened scaffold.** `run_transport_form_extraction`
   (`apps/python/langchain.py:754`) asks the model for `is_hazardous` directly and
   accepts `waste_type` as free text with no code derivation — exactly the state
   `run_identification_form_extraction` was in before its Phase 2 hardening. It needs
   the same treatment: snap `waste_type` to the closed list, stop trusting the model for
   `is_hazardous`, derive `ewc_code`/`is_hazardous` deterministically in Python.
5. **No `services/transport_forms/` package.** No firm resolution reuse, no
   disposal-place lookup. `firm_lookup.py` already supports adding a new column set
   without touching the invoice path (see `_IDENTIFICATION_FIRM_COLUMNS` next to
   `_INVOICE_FIRM_COLUMNS`), so the same technique applies here.
6. **`transportForm.ts` is unwired.** No Pydantic counterpart exists (`transportForm.ts`
   is the only validation, and nothing imports it) — same pre-Phase-5 state
   `identificationForm.ts` was in.
7. **Not reachable from chat at all.** No `transport_form_extraction` in `ChainId` /
   `CHAIN_REGISTRY` (`apps/agent/src/agent/nodes/chainRegistry.ts`), no case in
   `directResolverChain.ts`, zero golden routing cases in `routing.jsonl` (identification
   form has 5). Even the scaffold extraction chain is dead code today.
8. **No render route, renderer, or web SDK call** — nothing past the scaffold exists.
9. **A field gap that the template will resolve.** `disposal_places` has a `place`
   column; `firms` only has a nullable `city`; `businesses` has neither `city` nor
   `place`, only `address`. If the real template has a "place" box for the waste-owner
   firm and/or the collector (business), there is no column to source it from yet. Left
   open until the template shows what's actually needed — see Open Questions.

None of these are blocking bugs (nothing here is live/reachable, so nothing is
currently broken in production) — they're the gap between "scaffold" and "usable
chain," itemized so the phases below have a concrete task list instead of vague scope.

---

## Existing state (reusable as-is)

- `transport_forms` table, FK-based, migrated and committed (`20260723040000`,
  `20260723050000`).
- `templatesTransportForm` table, migrated and committed (`20260724000000`).
- `disposal_places` — **full CRUD already live**: Python router
  (`routers/disposal_places.py`), Pydantic models (`models/disposal_place.py`), web UI
  (`Parties.tsx`), SDK (`supabase-client.ts`). This is the "end owner" party transport
  forms need and it needs no new work.
- `firms` (waste owner) and `businesses.permit_number` /
  `businesses.dangerous_waste_permit_number` (collector, chosen by `is_hazardous`)
  already exist and are populated via the existing firm/invoice flows.
- `waste_reference.json` already contains `ewc_hazardous_code_map` and
  `ewc_non_hazardous_code_map` — the exact reference data transport form's `ewc_code`
  derivation needs. No regeneration required; `packing_method` /
  `waste_origin` / `waste_operation_code` lists in that file are **not** used by
  transport form (confirmed in `transport-forms-table.md`: those three unions are not on
  this table).
- `_postprocess_identification_extraction` (`apps/python/langchain.py:823`) is already
  generic — it only reads `waste_type` and writes `ewc_code`/`is_hazardous` off the two
  code maps. It has no identification-form-specific logic despite its name. Reusable
  directly for transport form's extraction hardening (Phase 2), ideally renamed to
  something hazard/waste-type-neutral (e.g. `_resolve_ewc_code_from_waste_type`) since a
  second caller makes the identification-scoped name misleading.
- `render_identification_form_bytes` (`services/identification_forms/word.py`) is a
  fully generic docx run-substitution renderer (dot-path flatten, `{{token}}` regex,
  first-run-keeps-formatting). Nothing in it is identification-specific. Now that
  transport form is confirmed docx too, this is a second reuse candidate — extract into
  a neutral module (e.g. `services/docx_render.py`) so both forms call one renderer
  instead of forking a copy.
- `firm_lookup.py`'s fuzzy name-matching machinery (transliteration, tokenization,
  scoring, `_select_best_fuzzy_match`) is already factored for reuse — `contact_lookup.py`
  imports it directly rather than reimplementing. `disposal_place_lookup.py` (new, Phase
  3) does the same.

---

## Target flow

```
message → resolve chain → /documents/extract-transport-form (resolves firm_id +
disposal_place_id) → user confirms → POST /documents/transport-form (Pydantic validate
→ verify parties + pick collector permit by is_hazardous → insert row → render docx →
upload to Supabase → stream back)
```

---

## Template

`TransportFormTemplate.tokenized.docx` — the user's file (already authored with `{{...}}`
delimiters), with **one** authored edit, flagged:
- section 4 dropped the hardcoded sample-firm suffix `“Св. Климент Охридски“ – Скопје`
  that trailed `{{firm.name}}` — it would have appended to every firm's name on every
  form. Removed at run level (runs cleared, not `paragraph.text`), guarded by asserting
  the cleared tail matched that exact string.

Left as authored, by the user's decision: section 5's collector name
(`ТАНГЕНТА 2.0 ДООЕЛ СКОПЈЕ`) and street address stay hardcoded — only the permit is
tokenized. Templates are per-tenant uploads (`templatesTransportForm.tenant_id`), so this
is correct for this tenant but is **not** a portable template. Also kept as authored: the
`{{tennant.permitNumber}}` spelling — the render layer absorbs it, exactly as the invoice
route maps `firm.taxnumber` ← `firm_tax_number`.

| Template token | Source | Extracted from chat, or looked up by id? |
|---|---|---|
| `{{firm.name}}` `{{firm.address}}` | `firms.name` / `address` via `firm_id` | looked up by id (firm resolved from `firm_name` during extraction) |
| `{{wasteCollectedPlace}}` | `firms.city` — the handover town, shared by §4 and §5 | looked up by id (422 when blank) |
| `{{tennant.permitNumber}}` | `businesses.dangerous_waste_permit_number` or `permit_number`, chosen by `is_hazardous` | looked up by id — never chat-supplied, the collector is always the tenant itself |
| `{{disposalPlace.name}}` `{{disposalPlace.address}}` `{{disposalPlace.location}}` | `disposal_places.name` / `address` / **`place`** via `disposal_place_id` | looked up by id (resolved from `disposal_place_name` during extraction) |
| `{{wasteDescription}}` | `waste_type` (snapped to the closed list) | chat |
| `{{wasteCode}}` | `ewc_code` — derived from `waste_type` in Python, never chat-trusted | derived (neither) |
| `{{TotalWasteWeight}}` (§3) | `waste_owner_total_kg` | chat |
| `{{wasteCollected}}` (§4 **and** §5) | `collector_total_kg` | chat |
| `{{wasteCollectedDate}}` (§4 **and** §5) | `collector_date` | chat |
| `{{totalWasteWeightDisposed}}` (§6) | `end_owner_total_kg` | chat |
| `{{dateOfDisposal}}` (§6) | `end_owner_date` | chat |
| `{{note}}` | `note` (optional; blank collapses to `""`) | chat |
| §7 begin/end destination | derived at render from the two party **names** (`firm.name` – `disposalPlace.name`), not stored — the two existing `{{firm.name}}`/`{{disposalPlace.name}}` tokens render it | derived (neither) |

**Corrections this template forced against the pre-template plan:**
1. §7 uses party **names**, not addresses. The `transport_forms` header comment claimed
   `firm.address − disposal_place.address`; corrected.
2. Sections 4 and 5 **share** one weight token and one date token — they are the two sides
   of a single handover event. Combined with §3's separate total, that is **3 weights and
   2 dates**, not the 3-and-3 the schema carried. `waste_owner_date` was dropped
   (migration `20260727000000`): it had no box to render into and would only have been a
   required field with no destination.
3. `{{wasteCollectedPlace}}` had no column anywhere. Resolved to `firms.city` (user's
   decision) — symmetric with §6, where `{{disposalPlace.location}}` is the end owner's
   own town. `firms.city` is nullable, so the render route 422s when it is blank.

---

## Status

**All five phases done, 2026-07-27.** Verified: 1165 pytest (40 new), agent + web
type-check clean, `eval:coverage` 9/9 chains, `eval:offline` 15/15, migration applied and
confirmed against the live DB, and **all 15 tokens rendered against the real template**
with no leftover placeholders and the shared §4/§5 tokens filling both sections.

- **Phase 1 — done.** Both waste forms flipped from xlsx-only to docx-only
  (`docx_only_doc_types` in `documents.py`, `DOCX_ONLY_TEMPLATE_TYPES` in
  `DocumentTemplateSection.tsx`; the SDK union already allowed both). Migration
  `20260727000000_add_transport_form_storage` — storagePath (unique) + status + title +
  template_id, and `DROP COLUMN waste_owner_date`. Applied via `prisma db execute` +
  `migrate resolve --applied` + `generate`; live shape re-pulled and diffed.
- **Phase 2 — done.** `run_transport_form_extraction` hardened: closed waste-type list
  injected into the prompt, `is_hazardous` removed from `allowed_keys`, `waste_owner_date`
  dropped, and `ewc_code`/`is_hazardous` resolved deterministically afterwards.
  `_postprocess_identification_extraction` renamed `_resolve_ewc_code_from_waste_type` and
  moved above both chains — it was already form-neutral, and a second caller made the old
  name misleading. `POST /documents/extract-transport-form` added.
- **Phase 3 — done.** `services/transport_forms/disposal_place_lookup.py` imports the
  shared firm scorer (no edit to the invoice fuzzy path); `_TRANSPORT_FORM_FIRM_COLUMNS` +
  `fetch_firm_for_transport_form` added alongside the invoice/identification sets —
  invoice column list provably unchanged (asserted in a test).
  `services/transport_forms/extraction.py` orchestrates chain + both lookups. Unlike the
  identification form, the two lookups are independent: a disposal place is tenant-wide
  and has no owning-firm relationship, so neither scopes the other.
- **Phase 4 — done.** `transport_form_extraction` registered (`ChainId` +
  `CHAIN_REGISTRY`, empty `keywords[]`, description written to contrast explicitly against
  `identification_form_extraction` on the movement-between-two-parties signal);
  `directResolverChain.ts` case added; `transportForm.ts` demoted via header comment (and
  its stale `waste_owner_date` removed). 6 golden cases: 5 for the new chain (MK/EN
  canonical, sibling boundary, no-keyword, injection) plus `idf-mk-transport-nearmiss`
  guarding the sibling. `tf-mk-idf-boundary` and that near-miss are a deliberate pair —
  same ambiguous MK phrase «формулар за отпад», opposite expected chains, separated only
  by whether a receiving party is named.
- **Phase 5 — done.** Renderer extracted to `services/docx_render.py` as
  `render_docx_bytes` (nothing in it was identification-specific; both forms now call one
  renderer). Pydantic `TransportFormRequest` — the authoritative gate, incl. an
  `end_owner_date >= collector_date` ordering rule. `POST /documents/transport-form`:
  verifies tenant, firm, and disposal place; picks the collector permit by `is_hazardous`
  and 422s when the required one is blank; 422s on name mismatch or blank firm
  address/city; inserts at `{tenant}/transport-forms/{id}.docx`, renders, uploads, rolls
  the row back on render/upload failure, streams. `upload_transport_form_document` +
  `fetch_transport_form_template_payload` added.
  `createTransportFormDocument` + `TransportFormDocumentRequest` in the web SDK, and the
  Dashboard auto-generates end-to-end from chat (same shape as the identification form:
  extract already resolved the parties, so it renders immediately). `ResolvedDashboardChainId`
  was stale — it had never been widened past `identification_form_extraction`; both new
  chains added.
  Tests: `test_transport_form_request.py` (15), `test_transport_form_route.py` (16),
  `test_disposal_place_lookup.py` (9).

**NOT run:** `eval:routing` (live API, costs money / GitHub Models quota) — the only test
that proves the router actually separates this chain from `identification_form_extraction`
at inference time. The two are the most confusable pair in this domain and the boundary /
near-miss pair above is written specifically for it, so this is the run that matters.
User to run `pnpm --filter agent eval:routing` and, if green, decide on `baseline.json`.

**NOT done (deliberately, per "Not in this pass"):** no voice/Twilio path — transport
forms have no `origin`/`downloaded_at` columns and no `executeChain` case, so a phone call
still hits the "Дејството е непознато" default. No Documents-page listing.

---

## Phase 1 — template format fix + storage tracking

1. **Flip transport-form templates from xlsx-only to docx.**
   - `apps/python/routers/documents.py:781` — remove `transport_form` from
     `xlsx_only_doc_types` (or add a parallel `docx_only_doc_types` set covering both
     `identification_form` and `transport_form`, since both are docx-only now).
   - Mirror in `DocumentTemplateSection.tsx` and the `uploadDocumentTemplate` union in
     `supabase-client.ts` (already widened for `identification_form`; extend the same
     conditional to `transport_form`).
2. **Migration `add_transport_form_storage`** — `storagePath TEXT @unique`, `status TEXT
   NOT NULL DEFAULT 'draft'`, `title TEXT`, `template_id UUID` on `transport_forms`,
   hand-authored + `prisma db execute` + `prisma migrate resolve --applied` (established
   workflow, same as `20260725010000_add_identification_form_storage`).

## Phase 2 — extraction chain hardening

3. **Harden `run_transport_form_extraction`** (`langchain.py:754`):
   - inject the closed waste-type list (`ewc_hazardous_code_map` +
     `ewc_non_hazardous_code_map` values from `waste_reference.json`) into the prompt;
     require the model to copy an option verbatim or omit the key — same instruction
     style as the identification-form prompt.
   - remove `is_hazardous` from `allowed_keys` — it is derived, never model-supplied.
   - after extraction, call the (renamed) shared postprocess helper to resolve
     `ewc_code` + `is_hazardous` from `waste_type` deterministically, dropping both on
     no-match instead of carrying a fabricated code.
   - `firm_name` and `disposal_place_name` stay free text at this layer (resolved to ids
     in Phase 3), matching how `run_identification_form_extraction` defers `firm_name`/
     `contact_name` resolution.
4. **`POST /documents/extract-transport-form`** in `routers/documents.py`, same shape as
   `/extract-identification-form` — `ExtractionRequest` in, `ExtractionResponse` out,
   400 on `ValueError`, 502 on chain failure.

## Phase 3 — party resolution

5. **`services/transport_forms/disposal_place_lookup.py`** —
   `fetch_disposal_place_by_name`, mirroring `contact_lookup.py`: imports the shared
   fuzzy scorer from `firm_lookup.py` rather than reimplementing it, selects
   `id, name, address, place, email, phone_number`, tenant-scoped (disposal places have
   no owning-firm concept, so no additional scoping parameter like `contact_lookup`'s
   `firm_id`).
6. **Widen the firm select for transport form** — add a `_TRANSPORT_FORM_FIRM_COLUMNS`
   constant in `firm_lookup.py` next to `_IDENTIFICATION_FIRM_COLUMNS` (same technique,
   proven not to disturb the invoice path) and a `fetch_firm_for_transport_form`
   function. Exact column list depends on the template (Phase 5) — at minimum `id, name,
   address`.
7. **`services/transport_forms/extraction.py`** — orchestrates chain + both lookups,
   mirroring `identification_forms/extraction.py`: resolve firm first (best-effort, name
   left as-is on a miss), then resolve disposal place (also best-effort, independent —
   unlike contact resolution there's no firm-scoping relationship between the two
   parties). The extract route (Phase 2, item 4) calls this and passes `owner_auth_id`.

## Phase 4 — chain registration + routing

8. `ChainId` + `CHAIN_REGISTRY` entry `transport_form_extraction`
   (`chainRegistry.ts`), empty `keywords[]` per guardrails policy, description written
   to contrast against `identification_form_extraction` (a transport manifest moving
   waste between parties, vs. an identification form for a single waste batch) and
   `waste_law_query`.
9. `directResolverChain.ts` case: call `/documents/extract-transport-form` and return
   the payload, matching the `identification_form_extraction` branch.
10. **Demote `transportForm.ts` rather than wire it** — Pydantic at the render route is
    the authoritative gate (Phase 5); update its header comment to record that, same
    treatment `identificationForm.ts` got.
11. **≥4 golden routing cases** in `src/evals/golden/routing.jsonl`
    (`MIN_GOLDEN_CASES_PER_CHAIN = 4`), bilingual MK/EN, plus a near-miss case that must
    still route to `identification_form_extraction` (the two chains are the most
    confusable pair in this domain) — mirroring the near-miss-vs-`waste_law_query` case
    identification form added. Re-run the routing eval; update `baseline.json` only if
    per-chain accuracy holds.

## Phase 5 — validate, render, persist *(blocked on the template)*

12. **Pydantic `TransportFormRequest`** in `models/documents.py` — the authoritative
    gate, porting every rule in `transportForm.ts`: UUID `firm_id`/`disposal_place_id`,
    `waste_type`/`ewc_code`/`is_hazardous` cross-check against the two code maps, three
    `weightKg` fields (positive, ≤2dp) with their three ISO dates, optional `note`
    (≤2000 chars). Echo fields for the render route's mismatch guard (`firm_name` at
    minimum, possibly `disposal_place_name` — finalized once the template shows what
    identity fields actually render).
13. **Shared docx renderer** — extract `render_identification_form_bytes`'s guts into a
    neutral module (see "Existing state" above) and use it for transport form too,
    rather than forking a second copy of the run-substitution logic.
14. **Migration already covered in Phase 1** (storage columns) — no additional schema
    work here.
15. **`POST /documents/transport-form`** — the single door for both the web path and any
    future voice path. Resolve tenant; re-load firm + disposal place and verify tenant
    ownership (404 otherwise) and name match (422 otherwise, mirroring the
    identification-form guard at `documents.py:598`); resolve the business/collector row
    and pick `dangerous_waste_permit_number` or `permit_number` by `is_hazardous`,
    422 if the required one is blank (mirroring the blank-address/permit guard at
    `documents.py:608`); insert the row at
    `{tenant}/transport-forms/{id}.docx`; render; upload (`upload_transport_form_document`
    in `services/storage.py`, mirroring `upload_identification_form_document`); roll the
    row back on render/upload failure; stream back.
16. **`createTransportFormDocument`** in `supabase-client.ts`, posting straight to Python
    like `createIdentificationFormDocument` — same deliberate web→python-direct pattern
    (not the general `web → agent → python` rule), already established for document
    generation.

---

## Open questions — all resolved

- ~~The "place" field gap~~ → **`firms.city`**, with a 422 when blank. Symmetric with §6's
  `{{disposalPlace.location}}` ← `disposal_places.place`.
- ~~Exact `firm`/`business` column set~~ → firm renders **name + address + city** (no tax
  number, no firm permit — the manifest carries the *collector's* permit). Business
  renders **permit only**; its name and address are hardcoded in the template.
- ~~Echo-field scope for the mismatch guard~~ → **both** `firm_name` and
  `disposal_place_name`, each with its own 422.

## Follow-ups worth considering (not blocking)

- The hardcoded collector block in §5 makes this template tenant-specific. If a second
  tenant ever uploads a transport-form template, tokenize it as `{{tennant.name}}` /
  `{{tennant.address}}` — `businesses.name` and `businesses.address` already exist and the
  render route already resolves that row.
- `transport_forms` has no `origin`/`downloaded_at`, so it cannot join the invoice-style
  "call origin → dashboard card" pattern until a migration adds them.

## Not in this pass

Web UI for creating transport forms; Documents-page listing for transport forms — same
exclusions `identification-form-chain.md` carried, since identification form itself
still doesn't have either.
