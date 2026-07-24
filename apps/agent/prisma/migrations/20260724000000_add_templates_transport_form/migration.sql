-- Per-tenant stored template for the waste transport form. Same shape as
-- "templatesInvoice" (an uploaded .xlsx with {{placeholder}} tokens); referenced by
-- tenant only for now (no render step yet).
--
-- Authored manually and applied via `prisma db execute` + `prisma migrate resolve
-- --applied`, matching the established workflow here (`migrate dev` proposes a
-- destructive reset due to FK drift introduced outside Prisma via the Supabase
-- dashboard). See 20260723070000_add_identification_forms for the same pattern.
CREATE TABLE "public"."templatesTransportForm" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "type" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "templatesTransportForm_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "templatesTransportForm_storagePath_key" ON "public"."templatesTransportForm" ("storagePath");
CREATE INDEX "templatesTransportForm_tenant_id_idx" ON "public"."templatesTransportForm" ("tenant_id");

ALTER TABLE "public"."templatesTransportForm"
    ADD CONSTRAINT "templatesTransportForm_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."businesses" ("owner_auth_id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
