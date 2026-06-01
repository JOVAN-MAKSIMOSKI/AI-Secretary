-- Create per-business invoice counters and backfill existing businesses.
-- This migration is idempotent where practical.

BEGIN;

CREATE TABLE IF NOT EXISTS public.invoice_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE,
  current_value integer NOT NULL DEFAULT 0 CHECK (current_value >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_counters_tenant_id_fkey
    FOREIGN KEY (tenant_id)
    REFERENCES public.businesses(owner_auth_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS invoice_counters_tenant_id_idx
  ON public.invoice_counters (tenant_id);

-- Ensure every existing business has a counter row.
INSERT INTO public.invoice_counters (tenant_id)
SELECT b.owner_auth_id
FROM public.businesses b
LEFT JOIN public.invoice_counters ic ON ic.tenant_id = b.owner_auth_id
WHERE ic.tenant_id IS NULL;

-- Keep updated_at fresh on updates.
CREATE OR REPLACE FUNCTION public.set_invoice_counters_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_invoice_counters_set_updated_at ON public.invoice_counters;
CREATE TRIGGER trg_invoice_counters_set_updated_at
BEFORE UPDATE ON public.invoice_counters
FOR EACH ROW
EXECUTE FUNCTION public.set_invoice_counters_updated_at();

-- Auto-provision a counter row when a business is created.
CREATE OR REPLACE FUNCTION public.ensure_invoice_counter_for_business()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO public.invoice_counters (tenant_id)
  VALUES (NEW.owner_auth_id)
  ON CONFLICT (tenant_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_businesses_create_invoice_counter ON public.businesses;
CREATE TRIGGER trg_businesses_create_invoice_counter
AFTER INSERT ON public.businesses
FOR EACH ROW
EXECUTE FUNCTION public.ensure_invoice_counter_for_business();

-- Privileges and RLS alignment with existing tenant-isolated tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invoice_counters TO authenticated;

ALTER TABLE public.invoice_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_counters FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "invoice_counters_select_own_tenant" ON public.invoice_counters;
DROP POLICY IF EXISTS "invoice_counters_insert_own_tenant" ON public.invoice_counters;
DROP POLICY IF EXISTS "invoice_counters_update_own_tenant" ON public.invoice_counters;
DROP POLICY IF EXISTS "invoice_counters_delete_own_tenant" ON public.invoice_counters;

CREATE POLICY "invoice_counters_select_own_tenant" ON public.invoice_counters
  FOR SELECT TO authenticated
  USING (tenant_id = auth.uid());

CREATE POLICY "invoice_counters_insert_own_tenant" ON public.invoice_counters
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = auth.uid());

CREATE POLICY "invoice_counters_update_own_tenant" ON public.invoice_counters
  FOR UPDATE TO authenticated
  USING (tenant_id = auth.uid())
  WITH CHECK (tenant_id = auth.uid());

CREATE POLICY "invoice_counters_delete_own_tenant" ON public.invoice_counters
  FOR DELETE TO authenticated
  USING (tenant_id = auth.uid());

COMMIT;
