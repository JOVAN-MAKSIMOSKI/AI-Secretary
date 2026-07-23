-- Waste-law advisor tenant profile (entity type, sector, waste types, volume…)
-- Authored manually: `migrate dev` proposed a destructive reset due to FK drift
-- introduced outside Prisma (Supabase dashboard). Applied via `prisma db execute`
-- + `prisma migrate resolve --applied`.
ALTER TABLE "public"."businesses" ADD COLUMN "tenantprofilecontext" JSONB;
