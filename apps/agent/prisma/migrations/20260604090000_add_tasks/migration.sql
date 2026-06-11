CREATE TABLE "tasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "notes" TEXT,
  "due_at" TIMESTAMPTZ(6),
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tasks_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "businesses"("owner_auth_id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "tasks_tenant_id_status_idx"
  ON "tasks"("tenant_id", "status");

CREATE INDEX "tasks_tenant_id_due_at_idx"
  ON "tasks"("tenant_id", "due_at");
