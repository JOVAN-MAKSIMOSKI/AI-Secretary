import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is required to initialize PrismaClient');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

export { prisma };

// Helper to run queries with the Tenant ID set in the DB session
export async function tenantContext<T>(
  tenantId: string,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await (tx as unknown as PrismaClient).$executeRawUnsafe(
      'SET LOCAL app.tenant_id = $1',
      tenantId,
    );
    return operation(tx);
  });
}

