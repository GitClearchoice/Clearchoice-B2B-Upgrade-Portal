import type { PrismaClient } from "@prisma/client";
import type { Customer, CustomerPriceRule, Product, QuantityPrice } from "../pricing/types.ts";
import type { PriceStore, SyncData, SyncState } from "./store.ts";

// Postgres implementation of PriceStore (tables in prisma/schema.prisma). Used by the Shopify app
// and by `npm run sync` when DATABASE_URL is set (the Render cron job).

type Dec = { toString(): string } | number | string | null | undefined;
const n = (d: Dec): number | null => (d == null ? null : Number(d.toString()));
const CHUNK = 1000;

function chunks<T>(xs: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK));
  return out;
}

const productRow = (p: Product) => ({
  code: p.code,
  description: p.description ?? null,
  groupName: p.groupName,
  defaultSellPrice: p.defaultSellPrice,
  tierPrices: p.tierPrices.map((t) => t ?? 0), // 0 = blank tier
  taxable: p.taxable,
  obsolete: p.obsolete,
  sellable: p.sellable,
});
const customerRow = (c: Customer) => ({
  code: c.code,
  name: c.name ?? null,
  tier: c.tier,
  discount: c.discount,
  obsolete: c.obsolete,
});
const ruleRow = (r: CustomerPriceRule) => ({ ...r });
const qtyRow = (q: QuantityPrice) => ({ ...q });

export class PrismaStore implements PriceStore {
  private db: PrismaClient;
  constructor(db: PrismaClient) {
    this.db = db;
  }

  async replaceAll(data: SyncData) {
    await this.db.$transaction(
      async (tx) => {
        await tx.customerPriceRule.deleteMany();
        await tx.productQuantityPrice.deleteMany();
        await tx.unleashedCustomer.deleteMany();
        await tx.unleashedProduct.deleteMany();
        for (const c of chunks(data.products)) await tx.unleashedProduct.createMany({ data: c.map(productRow) });
        for (const c of chunks(data.customers)) await tx.unleashedCustomer.createMany({ data: c.map(customerRow) });
        for (const c of chunks(data.rules)) await tx.customerPriceRule.createMany({ data: c.map(ruleRow) });
        for (const c of chunks(data.quantityPrices)) await tx.productQuantityPrice.createMany({ data: c.map(qtyRow) });
      },
      { timeout: 300_000, maxWait: 30_000 },
    );
  }

  async upsertProducts(products: Product[]) {
    for (const c of chunks(products)) {
      await this.db.$transaction(
        c.map(productRow).map((row) => this.db.unleashedProduct.upsert({ where: { code: row.code }, create: row, update: row })),
      );
    }
  }
  async upsertCustomers(customers: Customer[]) {
    for (const c of chunks(customers)) {
      await this.db.$transaction(
        c.map(customerRow).map((row) => this.db.unleashedCustomer.upsert({ where: { code: row.code }, create: row, update: row })),
      );
    }
  }
  async upsertRules(rules: CustomerPriceRule[]) {
    for (const c of chunks(rules)) {
      await this.db.$transaction(
        c.map(ruleRow).map((row) => this.db.customerPriceRule.upsert({ where: { id: row.id }, create: row, update: row })),
      );
    }
  }
  async upsertQuantityPrices(prices: QuantityPrice[]) {
    for (const c of chunks(prices)) {
      await this.db.$transaction(
        c.map(qtyRow).map((row) => this.db.productQuantityPrice.upsert({ where: { id: row.id }, create: row, update: row })),
      );
    }
  }

  async getProduct(code: string): Promise<Product | undefined> {
    const p = await this.db.unleashedProduct.findUnique({ where: { code } });
    if (!p) return undefined;
    return {
      code: p.code,
      description: p.description ?? undefined,
      groupName: p.groupName,
      defaultSellPrice: n(p.defaultSellPrice),
      tierPrices: Array.from({ length: 10 }, (_, i) => {
        const v = n(p.tierPrices[i]);
        return v && v > 0 ? v : null;
      }),
      taxable: p.taxable,
      obsolete: p.obsolete,
      sellable: p.sellable,
    };
  }

  async getCustomer(code: string): Promise<Customer | undefined> {
    const c = await this.db.unleashedCustomer.findUnique({ where: { code } });
    if (!c) return undefined;
    return { code: c.code, name: c.name ?? undefined, tier: c.tier, discount: n(c.discount) ?? 0, obsolete: c.obsolete };
  }

  async getRulesForCustomer(code: string): Promise<CustomerPriceRule[]> {
    const rows = await this.db.customerPriceRule.findMany({ where: { customerCode: code } });
    return rows.map((r) => ({
      id: r.id,
      customerCode: r.customerCode,
      productCode: r.productCode,
      groupName: r.groupName,
      type: r.type as CustomerPriceRule["type"],
      value: n(r.value) ?? 0,
      unleashedCustomerPrice: n(r.unleashedCustomerPrice),
      minQty: n(r.minQty) ?? 0,
      validFrom: r.validFrom,
      validTo: r.validTo,
    }));
  }

  async getQuantityPrices(productCode: string): Promise<QuantityPrice[]> {
    const rows = await this.db.productQuantityPrice.findMany({ where: { productCode } });
    return rows.map((q) => ({
      id: q.id,
      productCode: q.productCode,
      type: q.type as QuantityPrice["type"],
      value: n(q.value) ?? 0,
      unleashedPrice: n(q.unleashedPrice),
      minQty: n(q.minQty) ?? 0,
      validFrom: q.validFrom,
      validTo: q.validTo,
    }));
  }

  async getState(): Promise<SyncState> {
    const [s, products, customers, rules, quantityPrices] = await Promise.all([
      this.db.syncState.findUnique({ where: { id: 1 } }),
      this.db.unleashedProduct.count(),
      this.db.unleashedCustomer.count(),
      this.db.customerPriceRule.count(),
      this.db.productQuantityPrice.count(),
    ]);
    return {
      lastFullSyncAt: s?.lastFullSyncAt?.toISOString() ?? null,
      lastChangeSyncAt: s?.lastChangeSyncAt?.toISOString() ?? null,
      counts: { products, customers, rules, quantityPrices },
    };
  }

  async setState(patch: Partial<SyncState> & { lastError?: string | null }) {
    const data: { lastFullSyncAt?: Date | null; lastChangeSyncAt?: Date | null; lastError?: string | null } = {};
    if (patch.lastFullSyncAt !== undefined) data.lastFullSyncAt = patch.lastFullSyncAt ? new Date(patch.lastFullSyncAt) : null;
    if (patch.lastChangeSyncAt !== undefined) data.lastChangeSyncAt = patch.lastChangeSyncAt ? new Date(patch.lastChangeSyncAt) : null;
    if (patch.lastError !== undefined) data.lastError = patch.lastError;
    await this.db.syncState.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  }
}
