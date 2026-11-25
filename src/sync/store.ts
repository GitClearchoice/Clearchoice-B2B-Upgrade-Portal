import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Customer, CustomerPriceRule, Product, QuantityPrice } from "../pricing/types.ts";

export interface SyncState {
  lastFullSyncAt: string | null;
  lastChangeSyncAt: string | null;
  counts: { products: number; customers: number; rules: number; quantityPrices: number };
}

/**
 * Where synced Unleashed data lives. The standalone scripts use FileStore; the Shopify app
 * (phase 2+) will implement this interface on Postgres (see prisma/schema.prisma).
 */
export interface SyncData {
  products: Product[];
  customers: Customer[];
  rules: CustomerPriceRule[];
  quantityPrices: QuantityPrice[];
}

export interface PriceStore {
  replaceAll(data: SyncData): Promise<void>;
  upsertProducts(products: Product[]): Promise<void>;
  upsertCustomers(customers: Customer[]): Promise<void>;
  upsertRules(rules: CustomerPriceRule[]): Promise<void>;
  upsertQuantityPrices(prices: QuantityPrice[]): Promise<void>;
  getQuantityPrices(productCode: string): Promise<QuantityPrice[]>;
  getProduct(code: string): Promise<Product | undefined>;
  getCustomer(code: string): Promise<Customer | undefined>;
  getRulesForCustomer(code: string): Promise<CustomerPriceRule[]>;
  getState(): Promise<SyncState>;
  setState(patch: Partial<SyncState>): Promise<void>;
}

interface Snapshot {
  products: Record<string, Product>;
  customers: Record<string, Customer>;
  rules: Record<string, CustomerPriceRule>;
  quantityPrices: Record<string, QuantityPrice>;
  state: SyncState;
}

const emptyState = (): SyncState => ({
  lastFullSyncAt: null,
  lastChangeSyncAt: null,
  counts: { products: 0, customers: 0, rules: 0, quantityPrices: 0 },
});

export class MemoryStore implements PriceStore {
  protected snap: Snapshot = { products: {}, customers: {}, rules: {}, quantityPrices: {}, state: emptyState() };

  async replaceAll(data: SyncData) {
    this.snap.products = Object.fromEntries(data.products.map((p) => [p.code, p]));
    this.snap.customers = Object.fromEntries(data.customers.map((c) => [c.code, c]));
    this.snap.rules = Object.fromEntries(data.rules.map((r) => [r.id, r]));
    this.snap.quantityPrices = Object.fromEntries(data.quantityPrices.map((q) => [q.id, q]));
    await this.persist();
  }
  async upsertProducts(products: Product[]) {
    for (const p of products) this.snap.products[p.code] = p;
    await this.persist();
  }
  async upsertCustomers(customers: Customer[]) {
    for (const c of customers) this.snap.customers[c.code] = c;
    await this.persist();
  }
  async upsertRules(rules: CustomerPriceRule[]) {
    for (const r of rules) this.snap.rules[r.id] = r;
    await this.persist();
  }
  async upsertQuantityPrices(prices: QuantityPrice[]) {
    for (const q of prices) this.snap.quantityPrices[q.id] = q;
    await this.persist();
  }
  async getQuantityPrices(productCode: string) {
    return Object.values(this.snap.quantityPrices).filter((q) => q.productCode === productCode);
  }
  async getProduct(code: string) {
    return this.snap.products[code];
  }
  async getCustomer(code: string) {
    return this.snap.customers[code];
  }
  async getRulesForCustomer(code: string) {
    return Object.values(this.snap.rules).filter((r) => r.customerCode === code);
  }
  async getState() {
    return {
      ...this.snap.state,
      counts: {
        products: Object.keys(this.snap.products).length,
        customers: Object.keys(this.snap.customers).length,
        rules: Object.keys(this.snap.rules).length,
        quantityPrices: Object.keys(this.snap.quantityPrices).length,
      },
    };
  }
  async setState(patch: Partial<SyncState>) {
    this.snap.state = { ...this.snap.state, ...patch };
    await this.persist();
  }
  protected async persist(): Promise<void> {}
}

/** JSON-file store for the standalone sync script and sandbox testing. */
export class FileStore extends MemoryStore {
  private path: string;
  constructor(path: string) {
    super();
    this.path = path;
  }
  static async open(path: string): Promise<FileStore> {
    const store = new FileStore(path);
    try {
      const loaded = JSON.parse(await readFile(path, "utf8"));
      store.snap = { ...store.snap, ...loaded, quantityPrices: loaded.quantityPrices ?? {} };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return store;
  }
  protected override async persist() {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.snap));
    await rename(tmp, this.path);
  }
}
