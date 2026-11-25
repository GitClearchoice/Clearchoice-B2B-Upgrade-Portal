import type { UnleashedClient } from "../unleashed/client.ts";
import { sydneyDate } from "../pricing/engine.ts";
import type { CustomerPriceRule, QuantityPrice } from "../pricing/types.ts";
import { type DiscountRateFormat, mapCustomer, mapProduct, mapProductPrice, mapQuantityPrice } from "./mappers.ts";
import type { PriceStore } from "./store.ts";

export interface SyncOptions {
  discountFormat: DiscountRateFormat;
  log?: (msg: string) => void;
  now?: () => Date;
}

export interface SyncResult {
  mode: "full" | "changes";
  products: number;
  customers: number;
  rules: number;
  quantityPrices: number;
  skippedRules: number;
  warnings: string[];
  startedAt: string;
  finishedAt: string;
}

/**
 * Nightly full sync: re-reads tiers, products, customers and all Customer Pricing lines, then
 * replaces the store in one go (so lines deleted in Unleashed disappear). Run it once a night.
 */
export async function fullSync(client: UnleashedClient, store: PriceStore, opts: SyncOptions): Promise<SyncResult> {
  const log = opts.log ?? (() => {});
  const startedAt = (opts.now?.() ?? new Date()).toISOString();
  const warnings: string[] = [];

  log("Fetching sell price tiers…");
  const tiers = await client.sellPriceTiers();
  log("Fetching products…");
  const products = (await client.products({ includeObsolete: true })).map(mapProduct);
  log(`  ${products.length} products`);
  log("Fetching customers…");
  const rawCustomers = await client.customers({ includeObsolete: true });
  const customers = [];
  for (const c of rawCustomers) {
    try {
      customers.push(mapCustomer(c, tiers, opts.discountFormat));
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  log(`  ${customers.length} customers`);
  log("Fetching customer pricing and quantity prices…");
  const { rules, quantityPrices, skipped } = mapRules(await client.productPrices());
  log(`  ${rules.length} customer price lines, ${quantityPrices.length} quantity prices (${skipped} skipped)`);

  warnings.push(...checkReferences(rules, new Set(products.map((p) => p.code)), new Set(customers.map((c) => c.code))));

  await store.replaceAll({ products, customers, rules, quantityPrices });
  const finishedAt = (opts.now?.() ?? new Date()).toISOString();
  await store.setState({ lastFullSyncAt: finishedAt, lastChangeSyncAt: finishedAt });
  return { mode: "full", products: products.length, customers: customers.length, rules: rules.length, quantityPrices: quantityPrices.length, skippedRules: skipped, warnings, startedAt, finishedAt };
}

/**
 * Daytime top-up: only records modified since the last run (Unleashed `modifiedSince`, a date).
 * Deletions are picked up by the next full sync.
 */
export async function changesSync(client: UnleashedClient, store: PriceStore, opts: SyncOptions): Promise<SyncResult> {
  const state = await store.getState();
  const since = state.lastChangeSyncAt ?? state.lastFullSyncAt;
  if (!since) return fullSync(client, store, opts);

  const log = opts.log ?? (() => {});
  const startedAt = (opts.now?.() ?? new Date()).toISOString();
  const modifiedSince = sydneyDate(new Date(since)); // day granularity; re-reads part of a day, harmless
  const warnings: string[] = [];

  log(`Fetching changes since ${modifiedSince}…`);
  const tiers = await client.sellPriceTiers();
  const products = (await client.products({ modifiedSince, includeObsolete: true })).map(mapProduct);
  const customers = [];
  for (const c of await client.customers({ modifiedSince, includeObsolete: true })) {
    try {
      customers.push(mapCustomer(c, tiers, opts.discountFormat));
    } catch (e) {
      warnings.push((e as Error).message);
    }
  }
  const { rules, quantityPrices, skipped } = mapRules(await client.productPrices({ modifiedSince }));

  await store.upsertProducts(products);
  await store.upsertCustomers(customers);
  await store.upsertRules(rules);
  await store.upsertQuantityPrices(quantityPrices);
  const finishedAt = (opts.now?.() ?? new Date()).toISOString();
  await store.setState({ lastChangeSyncAt: finishedAt });
  log(`  ${products.length} products, ${customers.length} customers, ${rules.length} price lines updated`);
  return { mode: "changes", products: products.length, customers: customers.length, rules: rules.length, quantityPrices: quantityPrices.length, skippedRules: skipped, warnings, startedAt, finishedAt };
}

function mapRules(raw: Parameters<typeof mapProductPrice>[0][]): {
  rules: CustomerPriceRule[];
  quantityPrices: QuantityPrice[];
  skipped: number;
} {
  const rules: CustomerPriceRule[] = [];
  const quantityPrices: QuantityPrice[] = [];
  let skipped = 0;
  for (const pp of raw) {
    const r = mapProductPrice(pp);
    if (r) { rules.push(r); continue; }
    const q = mapQuantityPrice(pp);
    if (q) { quantityPrices.push(q); continue; }
    skipped++;
  }
  return { rules, quantityPrices, skipped };
}

function checkReferences(rules: CustomerPriceRule[], productCodes: Set<string>, customerCodes: Set<string>): string[] {
  const w = new Set<string>();
  for (const r of rules) {
    if (!customerCodes.has(r.customerCode)) w.add(`Price line ${r.id} refers to unknown customer ${r.customerCode}`);
    if (r.productCode && !productCodes.has(r.productCode)) w.add(`Price line ${r.id} refers to unknown product ${r.productCode}`);
  }
  return [...w].slice(0, 50);
}
