-- Waste transport manifest. Party details are SNAPSHOTTED as plain columns at
-- creation time (not FK references) so the form is a permanent legal record of what
-- was true at transport time. Tenant-scoped (FK to businesses.owner_auth_id, cascade).
-- kg columns are NUMERIC(12,2); constrained strings validated in the app.
--
-- Authored manually and applied via `prisma db execute` + `prisma migrate resolve
-- --applied`, matching the established workflow here (`migrate dev` proposes a
-- destructive reset due to FK drift introduced outside Prisma via the Supabase
-- dashboard). See 20260705000000_add_tenantprofilecontext for the same pattern.
CREATE TABLE "public"."transport_forms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,

    "waste_type" TEXT NOT NULL,
    "is_hazardous" BOOLEAN NOT NULL,
    "ewc_code" TEXT NOT NULL,

    "waste_owner_name" TEXT NOT NULL,
    "waste_owner_address" TEXT NOT NULL,
    "waste_owner_place" TEXT NOT NULL,
    "waste_owner_total_kg" NUMERIC(12,2) NOT NULL,
    "waste_owner_date" DATE NOT NULL,

    "collector_name" TEXT NOT NULL,
    "collector_address" TEXT NOT NULL,
    "collector_place" TEXT NOT NULL,
    "collector_permit_number" TEXT NOT NULL,
    "collector_total_kg" NUMERIC(12,2) NOT NULL,
    "collector_date" DATE NOT NULL,

    "end_owner_name" TEXT NOT NULL,
    "end_owner_address" TEXT NOT NULL,
    "end_owner_place" TEXT NOT NULL,
    "end_owner_total_kg" NUMERIC(12,2) NOT NULL,
    "end_owner_date" DATE NOT NULL,

    "begin_end_location" TEXT NOT NULL,
    "note" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "transport_forms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "transport_forms_tenant_id_idx" ON "public"."transport_forms" ("tenant_id");

ALTER TABLE "public"."transport_forms"
    ADD CONSTRAINT "transport_forms_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."businesses" ("owner_auth_id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
