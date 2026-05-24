BEGIN;

-- Backfill tenant_id from businesses.id -> businesses.owner_auth_id.
-- This is safe to re-run because rows already migrated will not match businesses.id.
UPDATE clients c
SET tenant_id = b.owner_auth_id
FROM businesses b
WHERE c.tenant_id = b.id;

UPDATE invoices i
SET tenant_id = b.owner_auth_id
FROM businesses b
WHERE i.tenant_id = b.id;

UPDATE offers o
SET tenant_id = b.owner_auth_id
FROM businesses b
WHERE o.tenant_id = b.id;

UPDATE "templatesOffer" t
SET tenant_id = b.owner_auth_id
FROM businesses b
WHERE t.tenant_id = b.id;

UPDATE "templatesInvoice" t
SET tenant_id = b.owner_auth_id
FROM businesses b
WHERE t.tenant_id = b.id;

-- Rewire tenant foreign keys to businesses.owner_auth_id.
ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_tenant_id_fkey;
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_tenant_id_fkey;
ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_tenant_id_fkey;
ALTER TABLE "templatesOffer" DROP CONSTRAINT IF EXISTS "templatesOffer_tenant_id_fkey";
ALTER TABLE "templatesInvoice" DROP CONSTRAINT IF EXISTS "templatesInvoice_tenant_id_fkey";

ALTER TABLE clients
  ADD CONSTRAINT clients_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES businesses(owner_auth_id)
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES businesses(owner_auth_id)
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE offers
  ADD CONSTRAINT offers_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES businesses(owner_auth_id)
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "templatesOffer"
  ADD CONSTRAINT "templatesOffer_tenant_id_fkey"
  FOREIGN KEY (tenant_id) REFERENCES businesses(owner_auth_id)
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "templatesInvoice"
  ADD CONSTRAINT "templatesInvoice_tenant_id_fkey"
  FOREIGN KEY (tenant_id) REFERENCES businesses(owner_auth_id)
  ON DELETE CASCADE ON UPDATE NO ACTION;

COMMIT;
