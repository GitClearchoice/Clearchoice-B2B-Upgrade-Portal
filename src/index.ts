import { PricingError, resolvePrice } from "./pricing/engine.ts";
import type { PricingSettings, QuantityPrice, ResolvedPrice } from "./pricing/types.ts";
import type { PriceStore } from "./sync/store.ts";

export * from "./unleashed/client.ts";
export * from "./unleashed/signature.ts";
export * from "./pricing/engine.ts";
export * from "./pricing/types.ts";
export * from "./sync/store.ts";
export * from "./sync/sync.ts";
export * from "./sync/mappers.ts";

export interface CartLine {
  sku: string;
  quantity: number;
}

/**
 * Prices a set of lines for one customer from synced data. This is what the app proxy's
 * price endpoint and the place-order flow will call; prices are always worked out here,
 * on the server, never taken from the browser.
 */
export async function priceLines(
  store: PriceStore,
  customerCode: string,
  lines: CartLine[],
  opts: { at?: Date; quantityPrices?: QuantityPrice[]; settings?: Partial<PricingSettings> } = {},
): Promise<{ lines: ResolvedPrice[]; goodsExGst: number; errors: { sku: string; error: string }[] }> {
  const customer = await store.getCustomer(customerCode);
  if (!customer) throw new PricingError(`Unknown customer ${customerCode}`);
  if (customer.obsolete) throw new PricingError(`Customer ${customerCode} is obsolete in Unleashed`);
  const rules = await store.getRulesForCustomer(customerCode);

  const out: ResolvedPrice[] = [];
  const errors: { sku: string; error: string }[] = [];
  for (const line of lines) {
    const product = await store.getProduct(line.sku);
    if (!product || product.obsolete || !product.sellable) {
      errors.push({ sku: line.sku, error: product ? "Product is obsolete or not sellable" : "Unknown product" });
      continue;
    }
    try {
      out.push(resolvePrice({ product, customer, quantity: line.quantity, rules, ...opts }));
    } catch (e) {
      errors.push({ sku: line.sku, error: (e as Error).message });
    }
  }
  const goodsCents = out.reduce((sum, l) => sum + Math.round(l.lineExGst * 100), 0);
  return { lines: out, goodsExGst: goodsCents / 100, errors };
}
