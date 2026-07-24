-- Contacts: standalone individuals a business is in contact with (address book).
-- Not tied to firms and not part of the invoice/offer flow. Tenant-scoped like
-- firms/disposal_places (FK to businesses.owner_auth_id, cascade delete).
-- phone_number is TEXT so leading zeros / '+' / separators survive.
--
-- Authored manually and applied via `prisma db execute` + `prisma migrate resolve
-- --applied`, matching the established workflow here (`migrate dev` proposes a
-- destructive reset due to FK drift introduced outside Prisma via the Supabase
-- dashboard). See 20260705000000_add_tenantprofilecontext for the same pattern.
--
-- IF NOT EXISTS on the table + guarded column adds so this is safe to re-run over
-- the partial (name-only) version that was applied before the extra fields landed.
CREATE TABLE IF NOT EXISTS "public"."contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- Contact detail columns. NOT NULL with a transient '' default so the ADD succeeds
-- even if rows already exist, then the default is dropped (matching the schema,
-- which has no column default).
ALTER TABLE "public"."contacts" ADD COLUMN IF NOT EXISTS "email" TEXT NOT NULL DEFAULT '';
ALTER TABLE "public"."contacts" ADD COLUMN IF NOT EXISTS "phone_number" TEXT NOT NULL DEFAULT '';
ALTER TABLE "public"."contacts" ADD COLUMN IF NOT EXISTS "address" TEXT NOT NULL DEFAULT '';
ALTER TABLE "public"."contacts" ALTER COLUMN "email" DROP DEFAULT;
ALTER TABLE "public"."contacts" ALTER COLUMN "phone_number" DROP DEFAULT;
ALTER TABLE "public"."contacts" ALTER COLUMN "address" DROP DEFAULT;

CREATE INDEX IF NOT EXISTS "contacts_tenant_id_idx" ON "public"."contacts" ("tenant_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_tenant_id_fkey') THEN
    ALTER TABLE "public"."contacts"
        ADD CONSTRAINT "contacts_tenant_id_fkey"
        FOREIGN KEY ("tenant_id") REFERENCES "public"."businesses" ("owner_auth_id")
        ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
