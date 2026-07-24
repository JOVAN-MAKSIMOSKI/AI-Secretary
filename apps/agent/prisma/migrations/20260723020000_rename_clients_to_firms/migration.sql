-- Rename the clients domain table to firms, and the FK columns that reference it.
-- Rename-only: no data is moved or dropped, so this is fully reversible.
--
-- Authored manually and applied via `prisma db execute` + `prisma migrate resolve
-- --applied`, matching the established workflow here (`migrate dev` proposes a
-- destructive reset due to FK drift introduced outside Prisma via the Supabase
-- dashboard). See 20260705000000_add_tenantprofilecontext for the same pattern.

-- 1) Table rename (indexes, PK, and FK constraints follow the table automatically).
ALTER TABLE "public"."clients" RENAME TO "firms";

-- 2) FK columns on invoices/offers that reference the (now) firms table.
ALTER TABLE "public"."invoices" RENAME COLUMN "client_id" TO "firm_id";
ALTER TABLE "public"."offers" RENAME COLUMN "client_id" TO "firm_id";

-- 3) Tidy up auto-carried identifier names so they read as "firm", not "client".
--    Postgres keeps the old names after a table/column rename; these are cosmetic
--    but keep the schema self-consistent. Guarded so a missing name never aborts.
DO $$
BEGIN
  -- Primary key
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_pkey') THEN
    ALTER TABLE "public"."firms" RENAME CONSTRAINT "clients_pkey" TO "firms_pkey";
  END IF;

  -- clients tenant index
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'clients_tenant_id_idx') THEN
    ALTER INDEX "public"."clients_tenant_id_idx" RENAME TO "firms_tenant_id_idx";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'clients_email_idx') THEN
    ALTER INDEX "public"."clients_email_idx" RENAME TO "firms_email_idx";
  END IF;

  -- invoices.client_id index → firm_id
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'invoices_client_id_idx') THEN
    ALTER INDEX "public"."invoices_client_id_idx" RENAME TO "invoices_firm_id_idx";
  END IF;
  -- offers.client_id index → firm_id
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'offers_client_id_idx') THEN
    ALTER INDEX "public"."offers_client_id_idx" RENAME TO "offers_firm_id_idx";
  END IF;

  -- FK constraint names on invoices/offers
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_client_id_fkey') THEN
    ALTER TABLE "public"."invoices" RENAME CONSTRAINT "invoices_client_id_fkey" TO "invoices_firm_id_fkey";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offers_client_id_fkey') THEN
    ALTER TABLE "public"."offers" RENAME CONSTRAINT "offers_client_id_fkey" TO "offers_firm_id_fkey";
  END IF;

  -- clients→businesses FK constraint
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clients_tenant_id_fkey') THEN
    ALTER TABLE "public"."firms" RENAME CONSTRAINT "clients_tenant_id_fkey" TO "firms_tenant_id_fkey";
  END IF;
END $$;
