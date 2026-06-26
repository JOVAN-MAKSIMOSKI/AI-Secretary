DROP TABLE IF EXISTS "public"."twilio_phone_registrations";

CREATE INDEX IF NOT EXISTS "businesses_phone_idx" ON "public"."businesses"("phone");
