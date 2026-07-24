-- Add a permit number to firms. Text (not numeric) to preserve leading zeros /
-- separators. Nullable — existing firms fill it in later, no backfill. Read onto
-- identification forms via firm_id.
--
-- Authored manually and applied via `prisma db execute` + `prisma migrate resolve
-- --applied`, matching the established workflow here (`migrate dev` proposes a
-- destructive reset due to FK drift introduced outside Prisma via the Supabase
-- dashboard). See 20260705000000_add_tenantprofilecontext for the same pattern.
ALTER TABLE "public"."firms" ADD COLUMN "permit_number" TEXT;
