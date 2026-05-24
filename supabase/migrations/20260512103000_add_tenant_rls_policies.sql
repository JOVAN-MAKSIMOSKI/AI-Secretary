-- Enable RLS before defining policies
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS documents ENABLE ROW LEVEL SECURITY;

-- Ensure migration is safe if policies already exist
DROP POLICY IF EXISTS "clients_select_own_tenant" ON clients;
DROP POLICY IF EXISTS "clients_insert_own_tenant" ON clients;
DROP POLICY IF EXISTS "clients_update_own_tenant" ON clients;

DO $$
BEGIN
  IF to_regclass('public.documents') IS NOT NULL THEN
    DROP POLICY IF EXISTS "documents_select_own_tenant" ON documents;
    DROP POLICY IF EXISTS "documents_insert_own_tenant" ON documents;
    DROP POLICY IF EXISTS "documents_update_own_tenant" ON documents;
  END IF;
END $$;

-- Tenants can only see their own clients
CREATE POLICY "clients_select_own_tenant" ON clients
  FOR SELECT
  TO authenticated
  USING (tenant_id = auth.uid());

-- Tenants can only create clients under their own tenant
CREATE POLICY "clients_insert_own_tenant" ON clients
  FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = auth.uid());

-- Tenants can only update their own clients
CREATE POLICY "clients_update_own_tenant" ON clients
  FOR UPDATE
  TO authenticated
  USING (tenant_id = auth.uid())
  WITH CHECK (tenant_id = auth.uid());

DO $$
BEGIN
  IF to_regclass('public.documents') IS NOT NULL THEN
    -- Tenants see only their own documents
    CREATE POLICY "documents_select_own_tenant" ON documents
      FOR SELECT
      TO authenticated
      USING (tenant_id = auth.uid());

    -- Tenants can only create documents under their own tenant
    CREATE POLICY "documents_insert_own_tenant" ON documents
      FOR INSERT
      TO authenticated
      WITH CHECK (tenant_id = auth.uid());

    -- Tenants can update status (draft -> approved -> sent) on their own documents
    CREATE POLICY "documents_update_own_tenant" ON documents
      FOR UPDATE
      TO authenticated
      USING (tenant_id = auth.uid())
      WITH CHECK (tenant_id = auth.uid());
  END IF;
END $$;