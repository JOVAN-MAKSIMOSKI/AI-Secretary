# Plan: identification_forms table (+ firms.permit_number)

Document table, treated like invoices/transport_forms: FK ids for parties, stored
columns for data on no other table, Zod request schema in apps/agent.

## Part A — add permit_number to firms (confirmed: firms own a permit)
- Prisma: firms.permit_number String? (nullable TEXT — existing rows, no backfill)
- Migration: ALTER TABLE firms ADD COLUMN permit_number TEXT
- Python: models/firm.py (Create/Update/Response), routers/firms.py (insert/update/select/response)
- Web SDK: FirmCreate/Update/Response types + create/update payloads
- Web UI: Firm create + edit forms on Parties.tsx get a Permit number field (optional)

## Part B — identification_forms table
Parties by FK (resolved at render, like invoices):
- firm_id → firms (waste owner; name/address/permit read via firm)
- contact_id → contacts (responsible person; name/phone/email read via contact)
- tenant_id → businesses (owner scope)

Stored columns (data on no other table):
- is_hazardous BOOLEAN NOT NULL (waste class + drives ewc_code validation)
- waste_type TEXT NOT NULL (EwcHazardous | EwcNonHazardous description)
- ewc_code TEXT NOT NULL (haz or non-haz code map)
- packing_method TEXT NOT NULL (PackingMethodMK)
- total_weight_kg NUMERIC(12,2) NOT NULL
- waste_origin TEXT NOT NULL (WasteOriginMK)
- waste_operation_code TEXT NOT NULL (WasteOperationsCode)
- place TEXT NOT NULL
- date DATE NOT NULL
- waste_location TEXT NOT NULL (wasteOwner.wastelocation — not on any table)
- id, tenant_id, created_at

All reference strings = plain TEXT, validated against wasteChapters.ts unions in the app.
Indexes: tenant_id, firm_id, contact_id.

## Zod request schema (apps/agent/src/agent/identificationForm.ts)
Mirrors transportForm.ts. firm_id/contact_id UUIDs; is_hazardous drives ewc_code map
check; packing_method/waste_origin/waste_operation_code validated via z.enum against the
readonly arrays; total_weight_kg positive ≤2dp; date YYYY-MM-DD; waste_location/place non-empty.

## Migrations (hand-authored, established workflow)
- 20260723060000_add_firm_permit_number
- 20260723070000_add_identification_forms

## NOT in this task
Router/UI to CREATE identification forms, and the resolve-from-sources/render layer.
Table + firm permit wiring + Zod only.
