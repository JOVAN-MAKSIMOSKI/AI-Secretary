import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function applyMigrations() {
  try {
    console.log('Applying RLS migrations via Supabase API...\n');

    // Test connection first
    const { data: tableInfo } = await supabase
      .from('businesses')
      .select('count')
      .limit(1);
    
    console.log('✓ Connected to Supabase\n');

    // Now run the SQL via the admin API
    const statements = [
      `ALTER TABLE businesses ENABLE ROW LEVEL SECURITY`,
      `DROP POLICY IF EXISTS "businesses_select_own" ON businesses`,
      `DROP POLICY IF EXISTS "businesses_insert_own" ON businesses`,
      `DROP POLICY IF EXISTS "businesses_update_own" ON businesses`,
      `CREATE POLICY "businesses_select_own" ON businesses
       FOR SELECT
       TO authenticated
       USING (owner_auth_id = auth.uid())`,
      `CREATE POLICY "businesses_insert_own" ON businesses
       FOR INSERT
       TO authenticated
       WITH CHECK (owner_auth_id = auth.uid())`,
      `CREATE POLICY "businesses_update_own" ON businesses
       FOR UPDATE
       TO authenticated
       USING (owner_auth_id = auth.uid())
       WITH CHECK (owner_auth_id = auth.uid())`
    ];

    for (let i = 0; i < statements.length; i++) {
      console.log(`[${i + 1}/${statements.length}] Executing SQL...`);
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/sql_write`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${serviceRoleKey}`,
          'apikey': 'sb_anon_dGVzdGluZw=='
        },
        body: JSON.stringify({ query: statements[i] })
      });
      
      if (!response.ok) {
        console.log(`Response: ${response.status} ${response.statusText}`);
      } else {
        console.log('✓ Done');
      }
    }

    console.log('\n✅ Migration complete!');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

applyMigrations();
