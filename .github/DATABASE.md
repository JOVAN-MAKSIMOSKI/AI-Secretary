# Database & Multi-Tenancy

## Multi-Tenancy Rules (Mandatory)

- Every database table has a `tenant_id UUID NOT NULL` column
- Every Prisma query must include `where: { tenantId }` — never omit this filter
- Supabase Row Level Security (RLS) policies enforce isolation at the DB level
- Never write raw SQL — use Prisma in TypeScript
- Always validate `tenant_id` on every request — no exceptions

---

## Prisma Schema

Three core tables — all require `tenantId`:

```prisma
model Client {
  id           String   @id @default(uuid())
  tenantId     String   @db.Uuid
  name         String
  email        String
  company      String?
  vatNumber    String?
  tone         String   @default("formal") // "formal" | "informal"
  notes        String?
  metadata     Json?    @db.JsonB // Queryable JSON metadata
  createdAt    DateTime @default(now()) @db.Timestamptz(6)
  updatedAt    DateTime @updatedAt @db.Timestamptz(6)
  documents    Document[]
  interactions Interaction[]
  
  @@index([tenantId]) // Required for multi-tenant queries
  @@index([email]) // For lookups by email
}

model Document {
  id           String   @id @default(uuid())
  tenantId     String   @db.Uuid
  clientId     String
  type         String   // "invoice" | "offer" | "letter"
  filePath     String   // Supabase Storage path
  fileUrl      String   // Supabase Storage public URL
  status       String   @default("draft") // "draft" | "sent" | "approved"
  metadata     Json?    @db.JsonB // Document metadata (amounts, line items, etc.)
  createdAt    DateTime @default(now()) @db.Timestamptz(6)
  sentAt       DateTime? @db.Timestamptz(6)
  approvedAt   DateTime? @db.Timestamptz(6)
  client       Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  
  @@index([tenantId]) // Required for tenant queries
  @@index([clientId]   @db.Uuid
  clientId    String
  rawText     String   // original voice/text command
  summary     String   // LLM-generated summary
  metadata    Json?    @db.JsonB // Context tags, sentiment, etc.
  embeddingId String?  // LlamaIndex vector ID
  createdAt   DateTime @default(now()) @db.Timestamptz(6)
  client      Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  
  @@index([tenantId]) // Required for tenant queries
  @@index([clientId]) // For client history
  clientId    String
  rawText     String   // original voice/text command
  summary     String   // LLM-generated summary
  embeddingId String?  // LlamaIndex vector ID
  createdAt   DateTime @default(now())
  client      Client   @relation(fields: [clientId], references: [id])
}   @db.Uuid
  actionType  String   // "file_created" | "email_drafted" | "email_sent" | "event_created"
  clientId    String?
  fileUrl     String?
  status      String   // "pending_approval" | "approved" | "rejected"
  approvedBy  String?
  metadata    Json?    @db.JsonB // Additional context (IP, user agent, etc.)
  createdAt   DateTime @default(now()) @db.Timestamptz(6)
  
  @@index([tenantId]) // Required for tenant audit trails
  @@index([actionType]) // For filtering by action type
  fileUrl     String?
  status      String   // "pending_approval" | "approved" | "rejected"
  approvedBy  String?
  createdAt   DateTime @default(now())
}
```

---

## Supabase Storage Paths

All paths are namespaced by tenant:

- **Templates:** `/{tenant_id}/templates/{template_name}`
- **Generated outputs:** `/{tenant_id}/outputs/{document_type}/{filename}`
- **General format:** `/{tenant_id}/{document_type}/{yyyy-mm}/{filename}`

---

## RAG & LlamaIndex

- Index route: `POST /api/rag/index` — Add interaction to LlamaIndex
- Query route: `POST /api/rag/query` — Retrieve relevant past interactions
- Client history route: `GET /api/rag/client/{tenant_id}/{client_id}` — All history for one client
- **Critical:** Always include `MetadataFilter(key="tenant_id", value=current_tenant_id)` on RAG queries
- Never expose interactions across tenant boundaries

---

## Querying Rules

### Correct Pattern
```typescript
// Always filter by tenantId
const clients = await prisma.client.findMany({
  where: { tenantId: currentTenantId },
});

const document = await prisma.document.findUnique({
  where: { id: docId },
});
// Then verify document.tenantId === currentTenantId before returning
```

### Forbidden Pattern
```typescript
// WRONG: No tenant filter
const clients = await prisma.client.findMany();

// WRONG: Hardcoded tenant
const clients = await prisma.client.findMany({
  where: { tenantId: "hardcoded-id" },
});
```

---

## Key Constraints

- `tenant_id` is mandatory on all inserts — no defaults
- Cascade deletes when tenant is deleted (use `onDelete: Cascade` in Prisma)
- Foreign key constraints prevent orphaned records
- RLS policies are the second line of defense (first is application logic)
- All datetime columns use `@db.Timestamptz(6)` for timezone safety
- All queryable JSON use `@db.JsonB` for indexing and filtering
- Every table has `@@index([tenantId])` for query performance

---

## Column Rename & Deprecation Pattern

When renaming a column, use the `_deprecated` suffix convention:

```prisma
// Step 1: Add new column, keep old one
model Document {
  filePath_deprecated  String?
  filePath            String   // New name
}
```

```sql
-- Step 2: SQL migration
ALTER TABLE documents ADD COLUMN file_path VARCHAR(255);
UPDATE documents SET file_path = file_path_deprecated;
ALTER TABLE documents DROP COLUMN file_path_deprecated;
```

```prisma
// Step 3: Remove deprecated column from schema
model Document {
  filePath  String
}
```

---

## Prisma Migration Workflow

### Development Migrations

Use `prisma migrate dev` for rapid iteration:

```bash
# Create migration and apply to dev database
prisma migrate dev --name add_metadata_to_documents
```

This:
1. Creates a timestamped SQL migration in `prisma/migrations/`
2. Applies it to the development database
3. Regenerates Prisma client

### Deployment Migrations

Use `prisma migrate deploy` for production:

```bash
# Apply all pending migrations to production
prisma migrate deploy
```

**Important:**
- Always review generated SQL before merging to main
- Never use `prisma db push` in production (it skips migration history)
- Keep migrations small and focused
- Test migrations on a staging database first

### Migration Best Practices

```bash
# Review migrations without applying
prisma migrate status

# Reset dev database (destructive!)
prisma migrate reset

# Generate migration without applying (review first)
prisma migrate create --name description_here
```

### Example Migration File

```sql
-- prisma/migrations/20260501_add_metadata_indexes/migration.sql

-- Add metadata column
ALTER TABLE "Client" ADD COLUMN "metadata" jsonb;
ALTER TABLE "Document" ADD COLUMN "metadata" jsonb;
ALTER TABLE "Interaction" ADD COLUMN "metadata" jsonb;
ALTER TABLE "AuditLog" ADD COLUMN "metadata" jsonb;

-- Add indexes for tenant isolation
CREATE INDEX "Client_tenantId_idx" ON "Client"("tenantId");
CREATE INDEX "Document_tenantId_idx" ON "Document"("tenantId");
CREATE INDEX "Document_status_idx" ON "Document"("status");
CREATE INDEX "Interaction_tenantId_idx" ON "Interaction"("tenantId");
CREATE INDEX "AuditLog_tenantId_idx" ON "AuditLog"("tenantId");
```

---

## Row Level Security (RLS) SQL

Supabase RLS policies enforce multi-tenancy at the database level:

```sql
-- Enable RLS on all tables
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only read their own tenant's clients
CREATE POLICY select_own_clients ON clients
  FOR SELECT
  USING (tenant_id = auth.jwt() ->> 'tenant_id');

-- Policy: Users can only read their own tenant's documents
CREATE POLICY select_own_documents ON documents
  FOR SELECT
  USING (tenant_id = auth.jwt() ->> 'tenant_id');

-- Policy: Users can only insert into their own tenant
CREATE POLICY insert_own_documents ON documents
  FOR INSERT
  WITH CHECK (tenant_id = auth.jwt() ->> 'tenant_id');

-- Policy: Users can only update their own tenant's documents
CREATE POLICY update_own_documents ON documents
  FOR UPDATE
  USING (tenant_id = auth.jwt() ->> 'tenant_id');

-- Policy: Users can only delete their own tenant's documents
CREATE POLICY delete_own_documents ON documents
  FOR DELETE
  USING (tenant_id = auth.jwt() ->> 'tenant_id');
```

**Important:** RLS is the second line of defense. Application code must always filter by `tenant_id` as the first line of defense. Never rely on RLS alone.
