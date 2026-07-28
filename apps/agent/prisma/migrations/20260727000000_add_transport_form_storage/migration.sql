-- Generated-document tracking on transport_forms, mirroring
-- 20260725010000_add_identification_form_storage: storagePath (unique), status, title,
-- template_id. All nullable except status (defaults 'draft'), so this is safe over
-- existing rows without a backfill.
--
-- Also drops waste_owner_date. The real TransportFormTemplate has only two date boxes —
-- the shared "Дата на предавање" in sections 4/5 (collector_date) and section 6's
-- (end_owner_date). Sections 4 and 5 reuse one {{wasteCollectedDate}} token because they
-- record the two sides of a single handover event, so a separate waste_owner_date could
-- never render anywhere and would only be a required field with no destination.
-- waste_owner_total_kg is kept: it renders in section 3 ("Количина на отпад").
--
-- Authored manually and applied via `prisma db execute` + `prisma migrate resolve
-- --applied`, matching the established workflow here. See 20260723030000_add_contacts.
--
-- Guarded with IF NOT EXISTS / IF EXISTS so it is safe to re-run.

ALTER TABLE "public"."transport_forms" ADD COLUMN IF NOT EXISTS "storagePath" TEXT;
ALTER TABLE "public"."transport_forms" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE "public"."transport_forms" ADD COLUMN IF NOT EXISTS "title" TEXT;
ALTER TABLE "public"."transport_forms" ADD COLUMN IF NOT EXISTS "template_id" UUID;

-- Unique on storagePath: a regenerated form (same id → same path) upserts its file, and
-- two different forms can never claim the same storage path.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transport_forms_storagePath_key'
  ) THEN
    ALTER TABLE "public"."transport_forms"
        ADD CONSTRAINT "transport_forms_storagePath_key" UNIQUE ("storagePath");
  END IF;
END $$;

ALTER TABLE "public"."transport_forms" DROP COLUMN IF EXISTS "waste_owner_date";
