-- AlterTable
ALTER TABLE "TradeOrder" ADD COLUMN     "approverEmail" TEXT,
ADD COLUMN     "approverName" TEXT,
ADD COLUMN     "budgetExGst" DECIMAL(14,2),
ADD COLUMN     "committedBeforeExGst" DECIMAL(14,2),
ADD COLUMN     "companyName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decisionNote" TEXT;

-- CreateTable
CREATE TABLE "SiteBudget" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "siteName" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "amountExGst" DECIMAL(14,2) NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteBudget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteBudget_shop_companyId_idx" ON "SiteBudget"("shop", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteBudget_shop_locationId_month_key" ON "SiteBudget"("shop", "locationId", "month");
