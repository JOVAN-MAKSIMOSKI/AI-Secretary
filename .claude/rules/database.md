# Database & Multi-Tenancy Rules

## Mandatory Constraints

- Every database table has a `tenant_id UUID NOT NULL` column — no exceptions
- Every Prisma query must include `where: { tenantId }` — no exceptions
- Supabase Row Level Security (RLS) enforces isolation at the DB level as a second line of defense
- Application code is the first line of defense — never rely on RLS alone
- Never write raw SQL — use Prisma in TypeScript
- `tenant_id` always comes from the **JWT token** in `apps/agent` middleware — never from the request body
- Always validate `tenant_id` on every request

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
  metadata     Json?    @db.JsonB
  createdAt    DateTime @default(now()) @db.Timestamptz(6)
  updatedAt    DateTime @updatedAt @db.Timestamptz(6)
  documents    Document[]
  interactions Interaction[]

  @@index([tenantId])
  @@index([email])
}

model Document {
  id         String    @id @default(uuid())
  tenantId   String    @db.Uuid
  clientId   String
  type       String    // "invoice" | "offer" | "letter"
  filePath   String
  fileUrl    String
  status     String    @default("draft") // "draft" | "sent" | "approved"
  metadata   Json?     @db.JsonB
  createdAt  DateTime  @default(now()) @db.Timestamptz(6)
  sentAt     DateTime? @db.Timestamptz(6)
  approvedAt DateTime? @db.Timestamptz(6)
  client     Client    @relation(fields: [clientId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@index([clientId])
}

model Interaction {
  id          String   @id @default(uuid())
  tenantId    String   @db.Uuid
  clientId    String
  rawText     String
  summary     String
  metadata    Json?    @db.JsonB
  embeddingId String?
  createdAt   DateTime @default(now()) @db.Timestamptz(6)
  client      Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@index([clientId])
}

model AuditLog {
  id         String   @id @default(uuid())
  tenantId   String   @db.Uuid
  actionType String   // "file_created" | "email_drafted" | "email_sent" | "event_created"
  clientId   String?
  fileUrl    String?
  status     String   // "pending_approval" | "approved" | "rejected"
  approvedBy String?
  metadata   Json?    @db.JsonB
  createdAt  DateTime @default(now()) @db.Timestamptz(6)

  @@index([tenantId])
  @@index([actionType])
}
```

---

## Querying Rules

### Correct Pattern
```typescript
// Always filter by tenantId
const clients = await prisma.client.findMany({
  where: { tenantId: currentTenantId },
});

// For findUnique, verify ownership after fetch
const document = await prisma.document.findUnique({ where: { id: docId } });
if (document?.tenantId !== currentTenantId) throw new UnauthorizedError("Access denied");
```

### Forbidden Pattern
```typescript
// WRONG: No tenant filter
const clients = await prisma.client.findMany();

// WRONG: tenant_id from request body
const tenantId = req.body.tenantId;
```

---

## Repository Layer Pattern

Enforces `tenantId` at the TypeScript type level — impossible to call without it:

```typescript
export class DocumentRepository {
  constructor(private prisma: PrismaClient) {}

  async findByClientId(tenantId: string, clientId: string) {
    return this.prisma.document.findMany({ where: { tenantId, clientId } });
  }

  async create(tenantId: string, data: Omit<DocumentCreateInput, 'tenantId'>) {
    return this.prisma.document.create({ data: { ...data, tenantId } });
  }

  async findById(tenantId: string, id: string) {
    const document = await this.prisma.document.findUnique({ where: { id } });
    if (document?.tenantId !== tenantId) throw new UnauthorizedError('Access denied');
    return document;
  }
}
```

---

## Supabase Storage Paths

All paths are namespaced by tenant:

- **Templates:** `/{tenant_id}/templates/{template_name}`
- **Generated outputs:** `/{tenant_id}/outputs/{document_type}/{filename}`
- **General format:** `/{tenant_id}/{document_type}/{yyyy-mm}/{filename}`

---

## RAG Tenant Isolation

- Index route: `POST /api/rag/index`
- Query route: `POST /api/rag/query`
- Client history: `GET /api/rag/client/{tenant_id}/{client_id}`
- **Critical:** Always include `MetadataFilter(key="tenant_id", value=current_tenant_id)` on all RAG queries
- Never expose interactions across tenant boundaries

---

## Key Constraints

- `tenant_id` is mandatory on all inserts — no defaults
- `onDelete: Cascade` on all client relations to prevent orphaned records
- All datetime columns use `@db.Timestamptz(6)` for timezone safety
- All queryable JSON uses `@db.JsonB` for indexing
- Every table has `@@index([tenantId])` for query performance

---

## Column Rename & Deprecation Pattern

```prisma
// Step 1: Add new column, keep old one with _deprecated suffix
model Document {
  filePath_deprecated String?
  filePath            String
}
```

---

## Prisma Migration Workflow

```bash
# Development
prisma migrate dev --name description_here

# Production
prisma migrate deploy

# Review without applying
prisma migrate status
```

- Never use `prisma db push` in production — it skips migration history
- Always review generated SQL before merging to main
- Never delete migration files

---

## RLS SQL (Reference)

```sql
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY select_own_clients ON clients
  FOR SELECT USING (tenant_id = auth.jwt() ->> 'tenant_id');

CREATE POLICY select_own_documents ON documents
  FOR SELECT USING (tenant_id = auth.jwt() ->> 'tenant_id');

CREATE POLICY insert_own_documents ON documents
  FOR INSERT WITH CHECK (tenant_id = auth.jwt() ->> 'tenant_id');
```

---

## Naming: tenant_id vs owner_auth_id

- `owner_auth_id` — Supabase Auth user ID used to resolve the business owner identity
- `tenant_id` — business-scoped key used for filtering, storage paths, and document ownership
- When both appear in the same flow, resolve `owner_auth_id` first, then derive or validate `tenant_id`

**Critical:** In the actual Prisma schema, `businesses.owner_auth_id` is the primary join key. The `clients`, `invoices`, `offers`, `tasks`, `templatesInvoice`, `templatesOffer`, and `gmail_oauth_connections` tables all have `tenant_id` which maps to `businesses.owner_auth_id` — not `businesses.id`. Always use `owner_auth_id` as the FK target when relating to `businesses`.

---

## Actual Prisma Schema (source of truth)

The real schema has 7 tables — not the generic 4-table example above. Use these when writing Prisma queries:

| Table | Key fields |
|---|---|
| `businesses` | `id`, `owner_auth_id` (unique, used as tenant FK), `name`, `email`, `tax_number`, `transaction_account`, `depositor`, `plan` |
| `clients` | `id`, `tenant_id` → `businesses.owner_auth_id`, `name`, `email`, `city`, `tax_number`, `address`, `phone`, `notes` |
| `invoices` | `id`, `tenant_id`, `client_id`, `invoice_number`, `invoice_type` (enum: goods/transport), `invoice_date`, `value_date`, `units`, `price_per_unit`, `tax_percentage`, `tax_total`, `price_before_tax`, `price_after_tax`, `price_after_tax_text`, `title`, `status`, `storagePath` (unique), `template_id` |
| `offers` | `id`, `tenant_id`, `client_id`, `title`, `status`, `file_url`, `storagePath` (unique), `sizeBytes`, `template_id`, `amount`, `due_date` |
| `templatesInvoice` | `id`, `tenant_id`, `name`, `content`, `storagePath` (unique), `sizeBytes`, `type` |
| `templatesOffer` | `id`, `tenant_id`, `name`, `content`, `storagePath` (unique), `sizeBytes`, `type` |
| `gmail_oauth_connections` | `id`, `tenant_id`, `user_auth_id`, `google_email`, `scopes[]`, `access_token_enc`, `refresh_token_enc`, `expiry_date` — unique on `(tenant_id, user_auth_id)` |
| `tasks` | `id`, `tenant_id`, `title`, `notes`, `due_at`, `status` (pending/completed) — indexed on `(tenant_id, status)` and `(tenant_id, due_at)` |

**Enum:** `InvoiceType { goods, transport }` — use this on `invoices.invoice_type`, never a raw string.

`storagePath` is `@unique` on both `invoices` and `offers` — never attempt to insert a duplicate path.

---

## Resolving tenant_id in server.ts

The agent server uses a helper `getTenantForUser(userAuthId)` to resolve `tenant_id` from `owner_auth_id`. Always call this at the start of any authenticated route handler — never derive tenant from request body.

```typescript
// Pattern used throughout server.ts
const tenantId = await getTenantForUser(userAuthId); // owner_auth_id → tenant_id
```
