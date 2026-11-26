-- CreateTable
CREATE TABLE "TradeOrder" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "buyerName" TEXT NOT NULL,
    "buyerEmail" TEXT,
    "companyId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "siteName" TEXT NOT NULL,
    "customerCode" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "note" TEXT,
    "goodsExGst" DECIMAL(14,2) NOT NULL,
    "lines" JSONB NOT NULL,
    "draftOrderId" TEXT,
    "draftOrderName" TEXT,
    "status" TEXT NOT NULL,
    "unleashedOrderNumber" TEXT,
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TradeOrder_locationId_createdAt_idx" ON "TradeOrder"("locationId", "createdAt");

-- CreateIndex
CREATE INDEX "TradeOrder_companyId_createdAt_idx" ON "TradeOrder"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "TradeOrder_status_idx" ON "TradeOrder"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TradeOrder_shop_requestKey_key" ON "TradeOrder"("shop", "requestKey");

