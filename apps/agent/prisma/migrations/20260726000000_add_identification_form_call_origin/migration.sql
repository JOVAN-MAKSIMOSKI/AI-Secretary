-- Call-origin tracking on identification_forms, same mechanism as invoices.origin /
-- invoices.downloaded_at. A form generated over a Twilio voice call has no browser to
-- receive the download, so origin='call' + downloaded_at IS NULL is what the dashboard's
-- pending-call-forms card queries. Both nullable/defaulted, safe over existing rows.
--
-- Authored manually and applied via `prisma db execute` + `prisma migrate resolve
-- --applied`, matching the established workflow here. See 20260723030000_add_contacts.
--
-- Guarded with IF NOT EXISTS so it is safe to re-run.

ALTER TABLE "public"."identification_forms" ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "public"."identification_forms" ADD COLUMN IF NOT EXISTS "downloaded_at" TIMESTAMPTZ(6);
