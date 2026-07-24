# Transport-form & identification-form templates

**Requested:** "build the templates for both, as we did for invoice … the files are excel."
**Scope (confirmed):** template *upload/storage* only — the same stage the offer template
is at. No render/generate endpoint in this pass.

## Model to mirror

Invoice/offer templates already work like this:
- Per-tenant XLSX/DOCX (with `{{placeholder}}` tokens) stored in `templatesInvoice` /
  `templatesOffer` (columns: `id, tenant_id, name, content, storagePath @unique, sizeBytes,
  type, created_at`).
- Uploaded via one route `POST /documents/template` with a `doc_type` discriminator
  (`invoice` | `offer`) that picks the table.
- UI = `DocumentTemplateSection` in Settings, a `doc_type` dropdown.

Both new forms are **Excel only** (`.xlsx`), so the upload UI restricts extension to xlsx
when either waste form is selected.

## Changes

### 1. Prisma schema + migrations (apps/agent)
- New model `templatesTransportForm` — same columns as `templatesInvoice`, back-relation
  on `businesses`.
- New model `templatesIdentificationForm` — same.
- Two hand-authored migrations (`prisma db execute` + `migrate resolve --applied`, the
  established workflow), then `prisma generate`.
  - `20260724000000_add_templates_transport_form`
  - `20260724010000_add_templates_identification_form`

### 2. Python route (apps/python/routers/documents.py)
- `create_template`: extend `doc_type` allow-list to
  `invoice | offer | transport_form | identification_form`.
- Map the two new types to their tables.
- Enforce `.xlsx` for the two waste forms (they have no Word variant).

### 3. Web SDK (apps/web/src/connection/supabase-client.ts)
- Widen `uploadDocumentTemplate` `docType` union to the four values.

### 4. Web UI (apps/web/src/components/portal/DocumentTemplateSection.tsx)
- Add the two options to the template-type dropdown.
- When a waste form is selected, force extension to `xlsx` (disable docx), mirroring
  how invoice already only makes sense as xlsx.

## Out of scope (explicitly not built now)
- `POST /documents/transport-form` / `/identification-form` render endpoints.
- Party (firm/contact/disposal-place) resolution + cell filling + stream-back.
- Any router/agent chain to *create* the forms.
These are the natural follow-on, same as the offer render step is still pending.
