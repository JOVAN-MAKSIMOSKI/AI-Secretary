-- Couple contacts to firms: a contact (the responsible person on an identification
-- form) belongs to exactly one firm. Adds contacts.firm_id NOT NULL with an FK to
-- firms(id), cascade on delete.
--
-- firm_id is NOT NULL, so existing firm-less contacts cannot be kept — they have no
-- firm to point at. Per the decision recorded in
-- .claude/plans/identification-form-chain.md (Phase 3 follow-up), existing contacts are
-- disposable test data and are deleted first. If you need to preserve contacts, backfill
-- firm_id before running this instead.
--
-- Authored manually and applied via `prisma db execute` + `prisma migrate resolve
-- --applied`, matching the established workflow here (`migrate dev` proposes a
-- destructive reset due to FK drift introduced outside Prisma via the Supabase
-- dashboard). See 20260723030000_add_contacts for the same pattern.
--
-- Guarded so it is safe to re-run: the column add is IF NOT EXISTS and the FK/backfill
-- steps are idempotent.

-- Clear firm-less contacts so the NOT NULL column can be added. Deliberate data loss,
-- confirmed disposable.
DELETE FROM "public"."contacts";

-- Add firm_id. No transient default: the table is now empty, so NOT NULL succeeds
-- directly and no default has to be dropped afterwards.
ALTER TABLE "public"."contacts" ADD COLUMN IF NOT EXISTS "firm_id" UUID NOT NULL;

CREATE INDEX IF NOT EXISTS "contacts_firm_id_idx" ON "public"."contacts" ("firm_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_firm_id_fkey') THEN
    ALTER TABLE "public"."contacts"
        ADD CONSTRAINT "contacts_firm_id_fkey"
        FOREIGN KEY ("firm_id") REFERENCES "public"."firms" ("id")
        ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
