-- Add origin tag and download-state to invoices.
-- origin: 'manual' (default) | 'call' — distinguishes voice-created invoices.
-- downloaded_at: NULL until the user downloads the ZIP from the dashboard card.
ALTER TABLE "public"."invoices"
  ADD COLUMN IF NOT EXISTS "origin" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS "downloaded_at" TIMESTAMPTZ(6);
