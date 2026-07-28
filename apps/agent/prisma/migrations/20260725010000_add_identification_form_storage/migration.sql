-- Generated-document tracking on identification_forms, so a rendered form can be
-- recorded and listed the way invoices are: storagePath (unique), status, title,
-- template_id. All nullable except status (defaults 'draft'), so this is safe over
-- existing rows without a backfill.
--
-- Authored manually and applied via `prisma db execute` + `prisma migrate resolve
-- --applied`, matching the established workflow here. See 20260723030000_add_contacts.
--
-- Guarded with IF NOT EXISTS so it is safe to re-run.

ALTER TABLE "public"."identification_forms" ADD COLUMN IF NOT EXISTS "storagePath" TEXT;
ALTER TABLE "public"."identification_forms" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE "public"."identification_forms" ADD COLUMN IF NOT EXISTS "title" TEXT;
ALTER TABLE "public"."identification_forms" ADD COLUMN IF NOT EXISTS "template_id" UUID;

-- Unique on storagePath: a regenerated form (same id → same path) upserts its file, and
-- two different forms can never claim the same storage path.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'identification_forms_storagePath_key'
  ) THEN
    ALTER TABLE "public"."identification_forms"
        ADD CONSTRAINT "identification_forms_storagePath_key" UNIQUE ("storagePath");
  END IF;
END $$;
