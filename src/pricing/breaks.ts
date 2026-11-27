import { resolvePrice, type PriceInput } from "./engine.ts";

export interface PriceBreak {
  minQty: number;
  unitExGst: number;
}

/**
 * The quantity breaks this customer actually gets on a product: "buy N or more, pay $X each".
 * Candidate quantities are the minimum quantities of the customer's Customer Pricing lines for
 * the product (or its group) and the product's Quantity Prices; each is priced with the normal
 * engine (so precedence, valid dates and tiers all apply), and only quantities where the unit
 * price drops below the price for smaller quantities are kept. Empty if the price never drops.
 */
export function priceBreaks(input: Omit<PriceInput, "quantity">): PriceBreak[] {
  const { product, customer } = input;
  const qtys = new Set<number>();
  for (const r of input.rules) {
    if (r.customerCode !== customer.code) continue;
    if (r.productCode ? r.productCode !== product.code : r.groupName !== product.groupName) continue;
    if (r.minQty > 1) qtys.add(r.minQty);
  }
  for (const q of input.quantityPrices ?? []) {
    if (q.productCode === product.code && q.minQty > 1) qtys.add(q.minQty);
  }
  if (!qtys.size) return [];

  const price = (quantity: number) => resolvePrice({ ...input, quantity }).unitExGst;
  let last = price(1);
  const out: PriceBreak[] = [];
  for (const minQty of [...qtys].sort((a, b) => a - b)) {
    const unit = price(minQty);
    if (unit < last) {
      out.push({ minQty, unitExGst: unit });
      last = unit;
    }
  }
  return out;
}
