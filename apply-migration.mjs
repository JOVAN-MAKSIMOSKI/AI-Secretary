import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL || process.env.DIRECT_URL;

if (!connectionString) {
  console.error('Missing DATABASE_URL or DIRECT_URL in environment.');
  process.exit(1);
}

const sql = postgres(connectionString);

const sqlStatements = [
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

async function run() {
  try {
    console.log('Connecting to database and applying RLS policies...\n');
    
    for (let i = 0; i < sqlStatements.length; i++) {
      const stmt = sqlStatements[i];
      console.log(`[${i + 1}/${sqlStatements.length}] Executing...`);
      await sql.unsafe(stmt);
      console.log('✓ Done');
    }
    
    console.log('\n✅ All migrations applied successfully!');
    await sql.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

run();
