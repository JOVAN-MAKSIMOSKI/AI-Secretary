# Plan: transport_forms table (waste transport manifest)

Table name: `transport_forms` (snake_case, plural — repo convention). Model `transport_forms`.

## Decisions (confirmed with user)
- **Snapshot, not FK**: name/address/place/permit copied into columns at creation time.
  It's a legal manifest — must record what was true at transport time, not auto-update.
- **One waste type per form** (no line-item child table).
- **Collector permit auto-picked** by is_hazardous: hazardous → businesses.dangerous_waste_permit_number,
  else businesses.permit_number. Snapshotted into collector_permit_number (done in app at creation).
- **Three separate kg columns** and **three separate dates** (per party), all **NOT NULL**.
- packing_method / waste_origin / waste_operation_code unions are NOT on this table.
- All constrained fields are plain TEXT, validated against the TS unions in apps/agent
  (matches tasks.status pattern; only InvoiceType is a real enum in this repo).
- `note` is the only nullable business field.

## Columns
- id UUID PK, tenant_id UUID FK→businesses.owner_auth_id (cascade), created_at timestamptz
- waste_type TEXT NOT NULL         (EwcHazardousWasteMK | non-hazardous list value)
- is_hazardous BOOLEAN NOT NULL    (which list; also drives permit selection)
- ewc_code TEXT NOT NULL           (from hazardous or non-hazardous code map)
- waste_owner_name/address/place TEXT NOT NULL, waste_owner_total_kg NUMERIC NOT NULL, waste_owner_date DATE NOT NULL   (from firm)
- collector_name/address/place TEXT NOT NULL, collector_permit_number TEXT NOT NULL, collector_total_kg NUMERIC NOT NULL, collector_date DATE NOT NULL   (from tenant/business)
- end_owner_name/address/place TEXT NOT NULL, end_owner_total_kg NUMERIC NOT NULL, end_owner_date DATE NOT NULL   (from disposal_place)
- begin_end_location TEXT NOT NULL  (client.address - disposalPlace.address)
- note TEXT NULL

## kg type
NUMERIC(12,2) — weights in kg, two decimals, generous precision. Not float (rounding).

## Migration
Hand-authored, applied via `prisma db execute` + `prisma migrate resolve --applied`
(established workflow; migrate dev proposes destructive reset due to dashboard FK drift).

## NOT in this task (later)
- Non-hazardous code map (user sending later) — schema doesn't need it; codes stored as text.
- The chain/router/UI that POPULATES a form from firm+tenant+disposal_place + the LLM
  waste→code resolution. Table only for now.
