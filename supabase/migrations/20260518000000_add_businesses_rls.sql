-- Enable RLS on businesses table
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "businesses_select_own" ON businesses;
DROP POLICY IF EXISTS "businesses_insert_own" ON businesses;
DROP POLICY IF EXISTS "businesses_update_own" ON businesses;

-- Allow users to select their own business
CREATE POLICY "businesses_select_own" ON businesses
  FOR SELECT
  TO authenticated
  USING (owner_auth_id = auth.uid());

-- Allow users to insert their own business
CREATE POLICY "businesses_insert_own" ON businesses
  FOR INSERT
  TO authenticated
  WITH CHECK (owner_auth_id = auth.uid());

-- Allow users to update their own business
CREATE POLICY "businesses_update_own" ON businesses
  FOR UPDATE
  TO authenticated
  USING (owner_auth_id = auth.uid())
  WITH CHECK (owner_auth_id = auth.uid());
