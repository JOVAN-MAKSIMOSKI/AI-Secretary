-- AlterTable
ALTER TABLE "clients"
ADD COLUMN "city" TEXT;

-- AlterTable
ALTER TABLE "businesses"
ADD COLUMN "tax_number" TEXT,
ADD COLUMN "transaction_account" TEXT,
ADD COLUMN "depositor" TEXT;

-- AlterTable
ALTER TABLE "invoices"
ADD COLUMN "price_after_tax_text" TEXT;
