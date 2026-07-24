# Plan: Rename `clients` table → `firms` (full, incl. FK columns)

Scope confirmed by user: **full** — DB table + Prisma model + all code + templates;
**and** FK columns `invoices.client_id` / `offers.client_id` → `firm_id`.

## CRITICAL: two senses of "client" — do NOT rename the library sense

Blind find/replace is forbidden. These are the ORM/SDK/OAuth sense and MUST stay:
- `generator client` + `PrismaClient` + `prisma.` instance (schema.prisma line 1, lib/prisma.ts)
- Supabase `client` (`createClient`, `supabase` instance, lib/supabase.ts, services/storage.py)
- MCP `client`, `StreamableHTTPClientTransport`
- Gmail OAuth: `buildGmailAuthClient`, `GmailAuthClient`, OAuth2 `client` (lib/gmailOAuth.ts — 18 hits, almost all OAuth-sense)
- Twilio `client` (twilio/*.ts)
- "clients" in prose comments meaning end-users (rephrase only if trivially about the table)

Only the **domain customer entity** (`clients` table + `client_id` FKs + the CRUD/UI/type
names built on it) is renamed to `firm`/`firms`/`firm_id`.

## Layer inventory (domain-client only)

### 1. Database (live Supabase) — hand-authored migration
- `ALTER TABLE "public"."clients" RENAME TO "firms";`
- `ALTER TABLE "public"."invoices" RENAME COLUMN "client_id" TO "firm_id";`
- `ALTER TABLE "public"."offers" RENAME COLUMN "client_id" TO "firm_id";`
- Rename indexes/constraints for tidiness (optional but preferred):
  `clients_pkey`→`firms_pkey`, FK constraint names, `..._client_id_idx`→`..._firm_id_idx`.
- Apply via `prisma db execute` + `prisma migrate resolve --applied` (established workflow).

### 2. Prisma schema (apps/agent/prisma/schema.prisma)
- `model clients` → `model firms`
- relation accessors `clients clients[]` on businesses → `firms firms[]`
- on invoices/offers: `client_id` → `firm_id`, relation field `clients clients @relation(...)` → `firms firms @relation(fields:[firm_id]...)`, `@@index([client_id])` → `@@index([firm_id])`
- `prisma generate` after.

### 3. Agent (apps/agent/src)
- `prisma.clients.*` → `prisma.firms.*` (chainHandlers.ts, calendar.ts)
- `row.clients?.email` → `row.firms?.email` (gmail.ts) + PostgREST join `clients (email)` → `firms (email)`
- `handleClientLookup` chain → `handleFirmLookup`; chain id `client_lookup` → `firm_lookup` in chainRegistry.ts + directResolverChain + state type + golden evals (routing.jsonl)
- repository/clients.ts (empty stub) → rename file to firms.ts

### 4. Python (apps/python)
- `routers/clients.py` → `routers/firms.py`; `supabase.table("clients")`→`("firms")`; prefix `/clients`→`/firms`; helpers imported by disposal_places.py (`require_tenant_owner_auth_id`, `_require_uuid`) — update import path
- `models/client.py` → `models/firm.py`; `Client*` classes → `Firm*`
- `main.py` router import + include
- `services/invoices/client_lookup.py` → table string + `client_id` key; consider file rename → firm_lookup.py
- `routers/documents.py`: `supabase.table("clients")`→`("firms")`, `.eq("client_id"...)`→`("firm_id"...)`, insert key `"client_id"`→`"firm_id"`
- `models/documents.py`: `client_id` field → `firm_id`
- `services/invoices/excel.py`: named-range `client_id`→`firm_id`; template placeholder aliases `client.name`→`firm.name` etc. (USER updates template tokens to match)

### 5. Web (apps/web/src)
- supabase-client.ts: `ClientCreateRequest/UpdateRequest/Response`→`Firm*`, `createClientProfile`→`createFirmProfile`, `getClientsByTenant`→`getFirmsByTenant`, `deleteClientById`→`deleteFirmById`, `updateClientById`→`updateFirmById`, `/clients`→`/firms`, cache vars
- Parties.tsx: all `client`-domain state/handlers/labels → firm (UI text "Client"→"Firm")
- Documents.tsx: `getClientsByTenant`, `client_id`, invoiceClient* → firm
- Dashboard.tsx: any client refs
- shared-types: client.ts → firm.ts, `Client` interface → `Firm`

### 6. API contract fields (DECISION NEEDED)
`client_name`, `client_tax_number`, `client_email` on the extraction payload — rename to
`firm_*` or keep? These are in the LangChain extraction contract. Pending user answer.

## Execution order (each step verified before next)
1. Plan file (this) ✅
2. DB migration authored + applied + verified live
3. Prisma schema + generate + validate
4. Agent code + tsc
5. Python code + import check
6. Web code + tsc
7. Full-repo grep sweep for stray domain-`client` refs
8. Report; user updates templates

## Rollback note
DB rename is reversible (`ALTER TABLE firms RENAME TO clients`). No data loss — rename only.

## STATUS: COMPLETE (2026-07-23)
All layers done and verified:
- DB: migration 20260723020000 applied + live-verified (firms present, invoices/offers.firm_id present, old clients gone). Recorded via migrate resolve.
- Prisma: model firms, firm_id FKs, validate + generate clean.
- Agent: prisma.firms, firm_lookup chain, firm_id/firm_name/firm_tax_number payload, gmail PostgREST join firms(email). tsc clean.
- Python: routers/firms.py (/firms), models/firm.py, firm_lookup.py, documents.py, excel.py aliases (Firm.*), langchain.py extraction key firm_name, models/documents.py firm_id/firm_name/firm_tax_number. 1085 pytest pass.
- Web: FirmCreate/Update/Response, getFirmsByTenant etc, /firms, InvoiceDocumentRequest firm_*, Parties/Documents/Dashboard. tsc clean.
- shared-types: Firm interface, invoice/offer firm_id.
- Evals: routing.jsonl firm_lookup, extraction.jsonl firm_name.

## Deliberately NOT renamed (library/NL senses)
PrismaClient, Supabase createClient, MCP client, OAuth clientId (GOOGLE_CLIENT_ID),
Qdrant client, TestClient. Macedonian spoken word "Клиент" in voice output (NL term).
gmail.ts listSentDocuments return field `client_email` (internal shape, not a contract).
Internal local var names (clientId params, ClientRow, activeMenuClientId, invoiceClient*)
left as-is: self-consistent, cosmetic, renaming them is churn with no functional gain.

## USER ACTION REQUIRED
Update the Excel/Word invoice template tokens: {{Client.name}}→{{Firm.name}},
{{Client.address}}→{{Firm.address}}, {{Client.city}}→{{Firm.city}},
{{Client.taxnumber}}→{{Firm.taxnumber}}. The excel.py alias map now emits Firm.* tokens.
