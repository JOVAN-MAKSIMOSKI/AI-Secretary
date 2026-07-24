-- Disposal places: waste disposal sites a business works with. Tenant-scoped like
-- clients (FK to businesses.owner_auth_id, cascade delete). phone_number is TEXT so
-- leading zeros, '+' country codes, and separators survive.
--
-- Authored manually and applied via `prisma db execute` + `prisma migrate resolve
-- --applied`, matching the established workflow here (`migrate dev` proposes a
-- destructive reset due to FK drift introduced outside Prisma via the Supabase
-- dashboard). See 20260705000000_add_tenantprofilecontext for the same pattern.
CREATE TABLE "public"."disposal_places" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "place" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "disposal_places_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "disposal_places_tenant_id_idx" ON "public"."disposal_places" ("tenant_id");

ALTER TABLE "public"."disposal_places"
    ADD CONSTRAINT "disposal_places_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."businesses" ("owner_auth_id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
