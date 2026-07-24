-- Waste-management permit numbers on businesses, entered from the Settings UI.
-- Stored as TEXT (not integer) so leading zeros and separators in official permit
-- numbers survive. Both nullable — existing businesses fill them in later.
--
-- Authored manually and applied via `prisma db execute` + `prisma migrate resolve
-- --applied`, matching the established workflow here (`migrate dev` proposes a
-- destructive reset due to FK drift introduced outside Prisma via the Supabase
-- dashboard). See 20260705000000_add_tenantprofilecontext for the same pattern.
ALTER TABLE "public"."businesses" ADD COLUMN "dangerous_waste_permit_number" TEXT;
ALTER TABLE "public"."businesses" ADD COLUMN "permit_number" TEXT;
