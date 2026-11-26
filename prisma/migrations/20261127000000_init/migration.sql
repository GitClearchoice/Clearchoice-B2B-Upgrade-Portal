-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnleashedProduct" (
    "code" TEXT NOT NULL,
    "description" TEXT,
    "groupName" TEXT,
    "defaultSellPrice" DECIMAL(14,4),
    "tierPrices" DECIMAL(14,4)[],
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "obsolete" BOOLEAN NOT NULL DEFAULT false,
    "sellable" BOOLEAN NOT NULL DEFAULT true,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnleashedProduct_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "UnleashedCustomer" (
    "code" TEXT NOT NULL,
    "name" TEXT,
    "tier" INTEGER,
    "discount" DECIMAL(7,6) NOT NULL DEFAULT 0,
    "obsolete" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnleashedCustomer_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "CustomerPriceRule" (
    "id" TEXT NOT NULL,
    "customerCode" TEXT NOT NULL,
    "productCode" TEXT,
    "groupName" TEXT,
    "type" TEXT NOT NULL,
    "value" DECIMAL(14,4) NOT NULL,
    "unleashedCustomerPrice" DECIMAL(14,4),
    "minQty" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "validFrom" TEXT,
    "validTo" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerPriceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductQuantityPrice" (
    "id" TEXT NOT NULL,
    "productCode" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" DECIMAL(14,4) NOT NULL,
    "unleashedPrice" DECIMAL(14,4),
    "minQty" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "validFrom" TEXT,
    "validTo" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductQuantityPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "lastFullSyncAt" TIMESTAMP(3),
    "lastChangeSyncAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UnleashedProduct_groupName_idx" ON "UnleashedProduct"("groupName");

-- CreateIndex
CREATE INDEX "CustomerPriceRule_customerCode_idx" ON "CustomerPriceRule"("customerCode");

-- CreateIndex
CREATE INDEX "ProductQuantityPrice_productCode_idx" ON "ProductQuantityPrice"("productCode");

