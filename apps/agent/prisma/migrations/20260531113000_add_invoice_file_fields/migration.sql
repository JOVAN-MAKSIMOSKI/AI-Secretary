-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('goods', 'transport');

-- AlterTable
ALTER TABLE "clients"
ADD COLUMN "tax_number" TEXT;

-- AlterTable
ALTER TABLE "invoices"
ADD COLUMN "invoice_number" TEXT,
ADD COLUMN "invoice_type" "InvoiceType",
ADD COLUMN "invoice_date" DATE,
ADD COLUMN "value_date" DATE,
ADD COLUMN "consignment_note_number" INTEGER,
ADD COLUMN "order_number" INTEGER,
ADD COLUMN "description" TEXT,
ADD COLUMN "units" INTEGER,
ADD COLUMN "price_per_unit" DECIMAL(12,2),
ADD COLUMN "tax_percentage" DECIMAL(5,2),
ADD COLUMN "price_before_tax" DECIMAL(12,2),
ADD COLUMN "price_after_tax" DECIMAL(12,2);

-- AddConstraint
ALTER TABLE "invoices"
ADD CONSTRAINT "invoices_invoice_number_format_check"
CHECK ("invoice_number" IS NULL OR "invoice_number" ~ '^[0-9]+/[0-9]+$') NOT VALID;

-- AddConstraint
ALTER TABLE "invoices"
ADD CONSTRAINT "invoices_consignment_or_order_check"
CHECK ("consignment_note_number" IS NOT NULL OR "order_number" IS NOT NULL) NOT VALID;

-- AddConstraint
ALTER TABLE "invoices"
ADD CONSTRAINT "invoices_tax_percentage_check"
CHECK ("tax_percentage" IS NULL OR ("tax_percentage" >= 0 AND "tax_percentage" <= 100));

-- AddConstraint
ALTER TABLE "invoices"
ADD CONSTRAINT "invoices_units_non_negative_check"
CHECK ("units" IS NULL OR "units" >= 0);

-- AddConstraint
ALTER TABLE "invoices"
ADD CONSTRAINT "invoices_prices_non_negative_check"
CHECK (
  ("price_per_unit" IS NULL OR "price_per_unit" >= 0)
  AND ("price_before_tax" IS NULL OR "price_before_tax" >= 0)
  AND ("price_after_tax" IS NULL OR "price_after_tax" >= 0)
);