/*
  Warnings:

  - You are about to drop the column `sizeBytes` on the `businesses` table. All the data in the column will be lost.
  - You are about to drop the column `storagePath` on the `businesses` table. All the data in the column will be lost.
  - You are about to drop the `templates` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_template_id_fkey";

-- DropForeignKey
ALTER TABLE "templates" DROP CONSTRAINT "templates_tenant_id_fkey";

-- DropIndex
DROP INDEX "businesses_storagePath_key";

-- AlterTable
ALTER TABLE "businesses" DROP COLUMN "sizeBytes",
DROP COLUMN "storagePath";

-- DropTable
DROP TABLE "templates";

-- CreateTable
CREATE TABLE "offers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "file_url" TEXT,
    "template_id" UUID,
    "amount" DECIMAL(10,2),
    "due_date" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "storagePath" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templatesOffer" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "type" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "templatesOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templatesInvoice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "type" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "templatesInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offers_storagePath_key" ON "offers"("storagePath");

-- CreateIndex
CREATE INDEX "offers_client_id_idx" ON "offers"("client_id");

-- CreateIndex
CREATE INDEX "offers_tenant_id_idx" ON "offers"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "templatesOffer_storagePath_key" ON "templatesOffer"("storagePath");

-- CreateIndex
CREATE INDEX "templatesOffer_tenant_id_idx" ON "templatesOffer"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "templatesInvoice_storagePath_key" ON "templatesInvoice"("storagePath");

-- CreateIndex
CREATE INDEX "templatesInvoice_tenant_id_idx" ON "templatesInvoice"("tenant_id");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templatesInvoice"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templatesOffer"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "templatesOffer" ADD CONSTRAINT "templatesOffer_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "templatesInvoice" ADD CONSTRAINT "templatesInvoice_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
