-- Harden public-schema privileges and enforce tenant isolation via RLS.
-- This migration is intentionally idempotent where practical.

BEGIN;

-- 1) Revoke broad privileges granted earlier to anon/authenticated.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL ROUTINES IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON ROUTINES FROM anon, authenticated;

-- Keep schema usage for PostgREST role resolution.
GRANT USAGE ON SCHEMA public TO anon, authenticated;

-- Runtime tables are only accessed by authenticated users, gated by RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.businesses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.clients TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invoices TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.offers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."templatesOffer" TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."templatesInvoice" TO authenticated;

-- Existing code uses default nextval() for UUIDs only, but keeping sequence usage explicit is safe.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO authenticated;

-- 2) Ensure all tenant-scoped tables have RLS enabled and enforced.
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."templatesOffer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."templatesInvoice" ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.businesses FORCE ROW LEVEL SECURITY;
ALTER TABLE public.clients FORCE ROW LEVEL SECURITY;
ALTER TABLE public.invoices FORCE ROW LEVEL SECURITY;
ALTER TABLE public.offers FORCE ROW LEVEL SECURITY;
ALTER TABLE public."templatesOffer" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."templatesInvoice" FORCE ROW LEVEL SECURITY;

-- 3) Replace existing policies with strict auth.uid()-based policies.

-- businesses
DROP POLICY IF EXISTS "businesses_select_own" ON public.businesses;
DROP POLICY IF EXISTS "businesses_insert_own" ON public.businesses;
DROP POLICY IF EXISTS "businesses_update_own" ON public.businesses;
DROP POLICY IF EXISTS "businesses_delete_own" ON public.businesses;

CREATE POLICY "businesses_select_own" ON public.businesses
  FOR SELECT TO authenticated
  USING (owner_auth_id = auth.uid());

CREATE POLICY "businesses_insert_own" ON public.businesses
  FOR INSERT TO authenticated
  WITH CHECK (owner_auth_id = auth.uid());

CREATE POLICY "businesses_update_own" ON public.businesses
  FOR UPDATE TO authenticated
  USING (owner_auth_id = auth.uid())
  WITH CHECK (owner_auth_id = auth.uid());

CREATE POLICY "businesses_delete_own" ON public.businesses
  FOR DELETE TO authenticated
  USING (owner_auth_id = auth.uid());

-- clients
DROP POLICY IF EXISTS "clients_select_own_tenant" ON public.clients;
DROP POLICY IF EXISTS "clients_insert_own_tenant" ON public.clients;
DROP POLICY IF EXISTS "clients_update_own_tenant" ON public.clients;
DROP POLICY IF EXISTS "clients_delete_own_tenant" ON public.clients;

CREATE POLICY "clients_select_own_tenant" ON public.clients
  FOR SELECT TO authenticated
  USING (tenant_id = auth.uid());

CREATE POLICY "clients_insert_own_tenant" ON public.clients
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = auth.uid());

CREATE POLICY "clients_update_own_tenant" ON public.clients
  FOR UPDATE TO authenticated
  USING (tenant_id = auth.uid())
  WITH CHECK (tenant_id = auth.uid());

CREATE POLICY "clients_delete_own_tenant" ON public.clients
  FOR DELETE TO authenticated
  USING (tenant_id = auth.uid());

-- templatesOffer
DROP POLICY IF EXISTS "templatesOffer_select_own_tenant" ON public."templatesOffer";
DROP POLICY IF EXISTS "templatesOffer_insert_own_tenant" ON public."templatesOffer";
DROP POLICY IF EXISTS "templatesOffer_update_own_tenant" ON public."templatesOffer";
DROP POLICY IF EXISTS "templatesOffer_delete_own_tenant" ON public."templatesOffer";

CREATE POLICY "templatesOffer_select_own_tenant" ON public."templatesOffer"
  FOR SELECT TO authenticated
  USING (tenant_id = auth.uid());

CREATE POLICY "templatesOffer_insert_own_tenant" ON public."templatesOffer"
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = auth.uid());

CREATE POLICY "templatesOffer_update_own_tenant" ON public."templatesOffer"
  FOR UPDATE TO authenticated
  USING (tenant_id = auth.uid())
  WITH CHECK (tenant_id = auth.uid());

CREATE POLICY "templatesOffer_delete_own_tenant" ON public."templatesOffer"
  FOR DELETE TO authenticated
  USING (tenant_id = auth.uid());

-- templatesInvoice
DROP POLICY IF EXISTS "templatesInvoice_select_own_tenant" ON public."templatesInvoice";
DROP POLICY IF EXISTS "templatesInvoice_insert_own_tenant" ON public."templatesInvoice";
DROP POLICY IF EXISTS "templatesInvoice_update_own_tenant" ON public."templatesInvoice";
DROP POLICY IF EXISTS "templatesInvoice_delete_own_tenant" ON public."templatesInvoice";

CREATE POLICY "templatesInvoice_select_own_tenant" ON public."templatesInvoice"
  FOR SELECT TO authenticated
  USING (tenant_id = auth.uid());

CREATE POLICY "templatesInvoice_insert_own_tenant" ON public."templatesInvoice"
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = auth.uid());

CREATE POLICY "templatesInvoice_update_own_tenant" ON public."templatesInvoice"
  FOR UPDATE TO authenticated
  USING (tenant_id = auth.uid())
  WITH CHECK (tenant_id = auth.uid());

CREATE POLICY "templatesInvoice_delete_own_tenant" ON public."templatesInvoice"
  FOR DELETE TO authenticated
  USING (tenant_id = auth.uid());

-- invoices
DROP POLICY IF EXISTS "invoices_select_own_tenant" ON public.invoices;
DROP POLICY IF EXISTS "invoices_insert_own_tenant" ON public.invoices;
DROP POLICY IF EXISTS "invoices_update_own_tenant" ON public.invoices;
DROP POLICY IF EXISTS "invoices_delete_own_tenant" ON public.invoices;

CREATE POLICY "invoices_select_own_tenant" ON public.invoices
  FOR SELECT TO authenticated
  USING (tenant_id = auth.uid());

CREATE POLICY "invoices_insert_own_tenant" ON public.invoices
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.clients c
      WHERE c.id = client_id
        AND c.tenant_id = auth.uid()
    )
    AND (
      template_id IS NULL OR EXISTS (
        SELECT 1
        FROM public."templatesInvoice" t
        WHERE t.id = template_id
          AND t.tenant_id = auth.uid()
      )
    )
  );

CREATE POLICY "invoices_update_own_tenant" ON public.invoices
  FOR UPDATE TO authenticated
  USING (tenant_id = auth.uid())
  WITH CHECK (
    tenant_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.clients c
      WHERE c.id = client_id
        AND c.tenant_id = auth.uid()
    )
    AND (
      template_id IS NULL OR EXISTS (
        SELECT 1
        FROM public."templatesInvoice" t
        WHERE t.id = template_id
          AND t.tenant_id = auth.uid()
      )
    )
  );

CREATE POLICY "invoices_delete_own_tenant" ON public.invoices
  FOR DELETE TO authenticated
  USING (tenant_id = auth.uid());

-- offers
DROP POLICY IF EXISTS "offers_select_own_tenant" ON public.offers;
DROP POLICY IF EXISTS "offers_insert_own_tenant" ON public.offers;
DROP POLICY IF EXISTS "offers_update_own_tenant" ON public.offers;
DROP POLICY IF EXISTS "offers_delete_own_tenant" ON public.offers;

CREATE POLICY "offers_select_own_tenant" ON public.offers
  FOR SELECT TO authenticated
  USING (tenant_id = auth.uid());

CREATE POLICY "offers_insert_own_tenant" ON public.offers
  FOR INSERT TO authenticated
  WITH CHECK (
    tenant_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.clients c
      WHERE c.id = client_id
        AND c.tenant_id = auth.uid()
    )
    AND (
      template_id IS NULL OR EXISTS (
        SELECT 1
        FROM public."templatesOffer" t
        WHERE t.id = template_id
          AND t.tenant_id = auth.uid()
      )
    )
  );

CREATE POLICY "offers_update_own_tenant" ON public.offers
  FOR UPDATE TO authenticated
  USING (tenant_id = auth.uid())
  WITH CHECK (
    tenant_id = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.clients c
      WHERE c.id = client_id
        AND c.tenant_id = auth.uid()
    )
    AND (
      template_id IS NULL OR EXISTS (
        SELECT 1
        FROM public."templatesOffer" t
        WHERE t.id = template_id
          AND t.tenant_id = auth.uid()
      )
    )
  );

CREATE POLICY "offers_delete_own_tenant" ON public.offers
  FOR DELETE TO authenticated
  USING (tenant_id = auth.uid());

COMMIT;
