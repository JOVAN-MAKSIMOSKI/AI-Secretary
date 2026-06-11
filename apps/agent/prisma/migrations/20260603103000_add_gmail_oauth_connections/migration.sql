CREATE TABLE "gmail_oauth_connections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "user_auth_id" UUID NOT NULL,
  "google_email" TEXT,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "access_token_enc" TEXT,
  "refresh_token_enc" TEXT NOT NULL,
  "expiry_date" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  CONSTRAINT "gmail_oauth_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gmail_oauth_connections_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "businesses"("owner_auth_id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "gmail_oauth_connections_tenant_id_user_auth_id_key"
  ON "gmail_oauth_connections"("tenant_id", "user_auth_id");

CREATE INDEX "gmail_oauth_connections_user_auth_id_idx"
  ON "gmail_oauth_connections"("user_auth_id");

CREATE INDEX "gmail_oauth_connections_tenant_id_idx"
  ON "gmail_oauth_connections"("tenant_id");
