-- CreateTable
CREATE TABLE "SiteRequest" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "customerCode" TEXT,
    "requestedBy" TEXT NOT NULL,
    "requestedEmail" TEXT,
    "siteName" TEXT NOT NULL,
    "address1" TEXT NOT NULL,
    "address2" TEXT,
    "suburb" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postcode" TEXT NOT NULL,
    "siteCode" TEXT,
    "contactName" TEXT,
    "contactPhone" TEXT,
    "deliveryNotes" TEXT,
    "monthlyBudget" DECIMAL(14,2),
    "managerIds" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "locationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "SiteRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteRequest_shop_companyId_status_idx" ON "SiteRequest"("shop", "companyId", "status");
