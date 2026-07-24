-- Rebuild transport_forms to reference parties by FK id (like invoices) instead of
-- snapshotting their details. The previous version (20260723040000) stored party
-- name/address/permit as columns; this drops those and replaces them with firm_id
-- (waste owner) + disposal_place_id (end owner). Collector is the tenant (tenant_id);
-- its permit is read from businesses at render. begin_end_location is now derived at
-- render, not stored. The table is brand-new and empty, so the DROP loses no data.
--
-- Authored manually and applied via `prisma db execute` + `prisma migrate resolve
-- --applied`, matching the established workflow here (`migrate dev` proposes a
-- destructive reset due to FK drift introduced outside Prisma via the Supabase
-- dashboard). See 20260705000000_add_tenantprofilecontext for the same pattern.
DROP TABLE IF EXISTS "public"."transport_forms";

CREATE TABLE "public"."transport_forms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "firm_id" UUID NOT NULL,
    "disposal_place_id" UUID NOT NULL,

    "waste_type" TEXT NOT NULL,
    "is_hazardous" BOOLEAN NOT NULL,
    "ewc_code" TEXT NOT NULL,

    "waste_owner_total_kg" NUMERIC(12,2) NOT NULL,
    "waste_owner_date" DATE NOT NULL,
    "collector_total_kg" NUMERIC(12,2) NOT NULL,
    "collector_date" DATE NOT NULL,
    "end_owner_total_kg" NUMERIC(12,2) NOT NULL,
    "end_owner_date" DATE NOT NULL,

    "note" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "transport_forms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "transport_forms_tenant_id_idx" ON "public"."transport_forms" ("tenant_id");
CREATE INDEX "transport_forms_firm_id_idx" ON "public"."transport_forms" ("firm_id");
CREATE INDEX "transport_forms_disposal_place_id_idx" ON "public"."transport_forms" ("disposal_place_id");

ALTER TABLE "public"."transport_forms"
    ADD CONSTRAINT "transport_forms_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."businesses" ("owner_auth_id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "public"."transport_forms"
    ADD CONSTRAINT "transport_forms_firm_id_fkey"
    FOREIGN KEY ("firm_id") REFERENCES "public"."firms" ("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "public"."transport_forms"
    ADD CONSTRAINT "transport_forms_disposal_place_id_fkey"
    FOREIGN KEY ("disposal_place_id") REFERENCES "public"."disposal_places" ("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
