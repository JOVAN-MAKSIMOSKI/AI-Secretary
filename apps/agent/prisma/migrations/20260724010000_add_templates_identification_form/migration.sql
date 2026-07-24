-- Per-tenant stored template for the waste identification form. Same shape as
-- "templatesInvoice" (an uploaded .xlsx with {{placeholder}} tokens); referenced by
-- tenant only for now (no render step yet).
--
-- Authored manually and applied via `prisma db execute` + `prisma migrate resolve
-- --applied`, matching the established workflow here. See
-- 20260724000000_add_templates_transport_form for the same pattern.
CREATE TABLE "public"."templatesIdentificationForm" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "type" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "templatesIdentificationForm_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "templatesIdentificationForm_storagePath_key" ON "public"."templatesIdentificationForm" ("storagePath");
CREATE INDEX "templatesIdentificationForm_tenant_id_idx" ON "public"."templatesIdentificationForm" ("tenant_id");

ALTER TABLE "public"."templatesIdentificationForm"
    ADD CONSTRAINT "templatesIdentificationForm_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."businesses" ("owner_auth_id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
