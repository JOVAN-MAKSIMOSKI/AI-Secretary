# Storage File Expiry — Delete generated files after 1 week

## Goal
Automatically delete generated invoice/offer files from Supabase Storage (and their
DB rows) once they are older than 7 days. Runs inside `apps/agent` on a daily schedule.

## Decisions (confirmed with user 2026-07-24)
- **Scope:** ALL generated files (invoices + offers), any `status`, older than 7 days.
  - ⚠️ User was warned this deletes approved financial documents and is likely a
    compliance risk. Proceeding at user's explicit request.
- **DB rows:** Delete the `invoices` / `offers` row too (not just the stored file).
- **Scheduler:** `node-cron` inside the existing `apps/agent` process (no new container).

## Facts established from the codebase
- Storage bucket is `"documents"` (`apps/python/services/storage.py:63`, `excel.py:283`).
- `storagePath` is stored **bucket-relative** — exactly what `.remove([paths])` needs.
- Both models have `storagePath String @unique`, `created_at`, `tenant_id`:
  - `invoices` (schema.prisma:36) — `storagePath` non-null.
  - `offers` (schema.prisma:73) — `storagePath` non-null.
- Service-role Supabase client: `src/lib/supabase.ts` (`export const supabase`).
- Prisma client: `src/lib/prisma.ts` (`import { prisma } from '../lib/prisma.js'`).
- Server entry: `src/server.ts`, `app.listen` at line 946.
- `node-cron` is NOT yet a dependency — must be added.

## Implementation steps

### 1. Add dependency
- `npm i node-cron` + `npm i -D @types/node-cron` in `apps/agent`.

### 2. New file: `src/jobs/storageCleanup.ts`
- Named constants (no magic numbers, per conventions):
  - `FILE_RETENTION_DAYS = 7`
  - `STORAGE_BUCKET = 'documents'`
  - `REMOVE_BATCH_SIZE = 100` (Supabase remove batch cap safety)
- `runStorageCleanup()`:
  1. `cutoff = new Date(Date.now() - FILE_RETENTION_DAYS * MS_PER_DAY)`.
  2. Query `prisma.invoices.findMany({ where: { created_at: { lt: cutoff } }, select: { id, storagePath } })` and same for `offers`.
     - No `tenantId` filter: this is a **global system maintenance sweep**, not a
       tenant-scoped request — it runs across all tenants by design. Document this
       exception in a comment (the repo rule assumes user-facing queries).
  3. For each table: batch `storagePath`s, call
     `supabase.storage.from(STORAGE_BUCKET).remove(batch)`.
     - If Supabase returns an error for a batch → log it and **skip deleting those DB
       rows** so the sweep retries next run (avoids orphaning storage). Do not throw;
       continue other batches.
     - On success → `prisma.invoices.deleteMany({ where: { id: { in: ids } } })`.
  4. Structured logging of counts removed per table + duration.
  5. Wrap whole thing in try/catch → log, never crash the process.
- Export `startStorageCleanupSchedule()` that registers the cron job
  (`cron.schedule('0 3 * * *', ...)`, daily 03:00), gated by an env flag
  `STORAGE_CLEANUP_ENABLED` (default off in dev, on in prod) so it can be disabled.

### 3. Wire into `src/server.ts`
- Import `startStorageCleanupSchedule`.
- Call it inside/after the `app.listen` callback, logging that the schedule started.

### 4. Env documentation
- Add `STORAGE_CLEANUP_ENABLED` to the env docs / `.env.example` if present.
- Optional: `STORAGE_RETENTION_DAYS` override (defaults to 7) — nice-to-have, only if
  trivial; otherwise keep the constant.

## Out of scope
- No changes to `apps/python` or `apps/web`.
- No deletion of templates (`templatesInvoice` / `templatesOffer`) — only invoices/offers.
- No audit-log entry per deletion (can add later if desired).

## Safety notes
- Storage removal happens BEFORE DB deletion; DB rows only deleted on successful remove.
- Idempotent: re-running is safe; already-removed paths just return no-op.
- `onDelete: Cascade` on relations means deleting invoice/offer rows won't orphan FKs.
