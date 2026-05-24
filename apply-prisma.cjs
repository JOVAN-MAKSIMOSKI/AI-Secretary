const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function applyMigrations() {
  try {
    console.log('Applying RLS migrations via Prisma...\n');

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
      console.log(`[${i + 1}/${statements.length}] Executing...`);
      await prisma.$executeRawUnsafe(statements[i]);
      console.log('✓ Done');
    }

    console.log('\n✅ All migrations applied successfully!');
    await prisma.$disconnect();
  } catch (error) {
    console.error('❌ Error:', error.message);
    await prisma.$disconnect();
    process.exit(1);
  }
}

applyMigrations();
