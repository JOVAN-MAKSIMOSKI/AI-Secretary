/*
  Warnings:

  - A unique constraint covering the columns `[storagePath]` on the table `businesses` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[storagePath]` on the table `invoices` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[storagePath]` on the table `templates` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `storagePath` to the `businesses` table without a default value. This is not possible if the table is not empty.
  - Added the required column `storagePath` to the `invoices` table without a default value. This is not possible if the table is not empty.
  - Added the required column `storagePath` to the `templates` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "sizeBytes" BIGINT,
ADD COLUMN     "storagePath" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "sizeBytes" BIGINT,
ADD COLUMN     "storagePath" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "templates" ADD COLUMN     "sizeBytes" BIGINT,
ADD COLUMN     "storagePath" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "businesses_storagePath_key" ON "businesses"("storagePath");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_storagePath_key" ON "invoices"("storagePath");

-- CreateIndex
CREATE UNIQUE INDEX "templates_storagePath_key" ON "templates"("storagePath");
