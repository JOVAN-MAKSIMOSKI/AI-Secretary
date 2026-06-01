-- Move invoice counter ownership to businesses table (as requested).
-- Keeps existing invoice_counters table for safety/backward compatibility.

BEGIN;

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS invoice_counter integer NOT NULL DEFAULT 0
  CHECK (invoice_counter >= 0);

-- Backfill from invoice_counters when present.
DO $$
BEGIN
  IF to_regclass('public.invoice_counters') IS NOT NULL THEN
    UPDATE public.businesses b
    SET invoice_counter = ic.current_value
    FROM public.invoice_counters ic
    WHERE ic.tenant_id = b.owner_auth_id;
  END IF;
END
$$;

-- Old trigger is no longer needed once businesses carries the counter.
DROP TRIGGER IF EXISTS trg_businesses_create_invoice_counter ON public.businesses;
DROP FUNCTION IF EXISTS public.ensure_invoice_counter_for_business();

COMMIT;
