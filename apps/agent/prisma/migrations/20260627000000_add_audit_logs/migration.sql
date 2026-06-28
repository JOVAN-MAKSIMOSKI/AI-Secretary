CREATE TABLE "audit_logs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "user_auth_id" UUID NOT NULL,
  "action_type" TEXT NOT NULL,
  "meta" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_logs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "businesses"("owner_auth_id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "audit_logs_tenant_id_idx"
  ON "audit_logs"("tenant_id");

CREATE INDEX "audit_logs_action_type_idx"
  ON "audit_logs"("action_type");

-- PostgREST caches the schema; without this, the new table returns PGRST205
-- ("Could not find the table in the schema cache") until the cache reloads.
NOTIFY pgrst, 'reload schema';
