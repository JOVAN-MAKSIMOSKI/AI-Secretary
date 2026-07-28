-- Call-origin tracking on transport_forms, same mechanism as invoices.origin /
-- identification_forms.origin. A form generated over a Twilio voice call has no browser
-- to receive the download, so origin='call' + downloaded_at IS NULL is what the
-- dashboard's pending-call-forms card queries. Both nullable/defaulted, safe over
-- existing rows.
--
-- Authored manually and applied via `prisma db execute` + `prisma migrate resolve
-- --applied`, matching the established workflow here. See
-- 20260726000000_add_identification_form_call_origin.
--
-- Guarded with IF NOT EXISTS so it is safe to re-run.

ALTER TABLE "public"."transport_forms" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "public"."transport_forms" ADD COLUMN IF NOT EXISTS "downloaded_at" TIMESTAMPTZ(6);
