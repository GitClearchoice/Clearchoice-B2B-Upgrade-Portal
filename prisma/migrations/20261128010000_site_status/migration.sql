-- CreateTable
CREATE TABLE "SiteStatus" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "siteName" TEXT NOT NULL,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "reason" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "lastOrderAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteStatus_shop_companyId_idx" ON "SiteStatus"("shop", "companyId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteStatus_shop_locationId_key" ON "SiteStatus"("shop", "locationId");
