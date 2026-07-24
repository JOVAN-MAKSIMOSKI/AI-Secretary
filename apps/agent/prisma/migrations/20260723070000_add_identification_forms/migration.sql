-- Waste identification form. Like invoices/transport_forms: references parties by FK
-- id (firm_id = waste owner, contact_id = responsible person; tenant scope). Only data
-- on no other table is stored: waste_location + the wasteInfo fields. Reference strings
-- validated in the app against the wasteChapters.ts unions. total_weight_kg NUMERIC(12,2).
--
-- Authored manually and applied via `prisma db execute` + `prisma migrate resolve
-- --applied`, matching the established workflow here (`migrate dev` proposes a
-- destructive reset due to FK drift introduced outside Prisma via the Supabase
-- dashboard). See 20260705000000_add_tenantprofilecontext for the same pattern.
CREATE TABLE "public"."identification_forms" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "firm_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,

    "waste_location" TEXT NOT NULL,

    "is_hazardous" BOOLEAN NOT NULL,
    "waste_type" TEXT NOT NULL,
    "ewc_code" TEXT NOT NULL,
    "packing_method" TEXT NOT NULL,
    "total_weight_kg" NUMERIC(12,2) NOT NULL,
    "waste_origin" TEXT NOT NULL,
    "waste_operation_code" TEXT NOT NULL,
    "place" TEXT NOT NULL,
    "date" DATE NOT NULL,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "identification_forms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "identification_forms_tenant_id_idx" ON "public"."identification_forms" ("tenant_id");
CREATE INDEX "identification_forms_firm_id_idx" ON "public"."identification_forms" ("firm_id");
CREATE INDEX "identification_forms_contact_id_idx" ON "public"."identification_forms" ("contact_id");

ALTER TABLE "public"."identification_forms"
    ADD CONSTRAINT "identification_forms_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."businesses" ("owner_auth_id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "public"."identification_forms"
    ADD CONSTRAINT "identification_forms_firm_id_fkey"
    FOREIGN KEY ("firm_id") REFERENCES "public"."firms" ("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "public"."identification_forms"
    ADD CONSTRAINT "identification_forms_contact_id_fkey"
    FOREIGN KEY ("contact_id") REFERENCES "public"."contacts" ("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
