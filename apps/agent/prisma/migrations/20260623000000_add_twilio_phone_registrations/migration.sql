CREATE TABLE "public"."twilio_phone_registrations" (
    "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id"    UUID         NOT NULL,
    "phone_number" TEXT         NOT NULL,
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "twilio_phone_registrations_pkey"
        PRIMARY KEY ("id"),
    CONSTRAINT "twilio_phone_registrations_phone_number_key"
        UNIQUE ("phone_number"),
    CONSTRAINT "twilio_phone_registrations_tenant_id_fkey"
        FOREIGN KEY ("tenant_id")
        REFERENCES "public"."businesses"("owner_auth_id")
        ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "twilio_phone_registrations_tenant_id_idx"
    ON "public"."twilio_phone_registrations"("tenant_id");
