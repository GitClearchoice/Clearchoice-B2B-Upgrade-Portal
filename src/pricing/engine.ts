import { applyDiscount, multiply, roundCents } from "./money.ts";
import {
  DEFAULT_SETTINGS,
  type Customer,
  type CustomerPriceRule,
  type PriceSource,
  type PricingSettings,
  type Product,
  type QuantityPrice,
  type ResolvedPrice,
} from "./types.ts";

export interface PriceInput {
  product: Product;
  customer: Customer;
  quantity: number;
  /** This customer's Customer Pricing lines (other customers' lines are ignored). */
  rules: CustomerPriceRule[];
  /** This product's Quantity Prices (apply to all customers). */
  quantityPrices?: QuantityPrice[];
  /** Pricing date. Defaults to now. Rules are compared on the Sydney calendar date. */
  at?: Date;
  settings?: Partial<PricingSettings>;
}

/** "YYYY-MM-DD" for the given instant in Australia/Sydney. */
export function sydneyDate(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

function ruleApplies(rule: CustomerPriceRule, customerCode: string, qty: number, today: string): boolean {
  if (rule.customerCode !== customerCode) return false;
  if (qty < rule.minQty) return false;
  if (rule.validFrom && today < rule.validFrom) return false;
  if (rule.validTo && today > rule.validTo) return false;
  return true;
}

/** Highest minimum quantity wins; ties go to the lowest price for the customer. */
function pickRule(rules: CustomerPriceRule[], priceOf: (r: CustomerPriceRule) => number) {
  return rules
    .slice()
    .sort((a, b) => b.minQty - a.minQty || priceOf(a) - priceOf(b))[0];
}

/** The customer's tier price, or null if they have no tier or the tier is blank on this product. */
export function tierPrice(product: Product, customer: Customer): number | null {
  if (customer.tier == null) return null;
  const v = product.tierPrices[customer.tier - 1];
  return v == null ? null : v;
}

/**
 * Works out a trade customer's unit price, mirroring Unleashed's order of precedence:
 *   1. Customer Pricing (product line, then product-group line; min qty and valid dates)
 *   2. Quantity Prices
 *   3. Customer's Sell Price Tier, less the customer's discount %
 *   4. Default Sell Price (less the customer's discount %, unless switched off)
 */
export function resolvePrice(input: PriceInput): ResolvedPrice {
  const { product, customer, quantity } = input;
  const settings = { ...DEFAULT_SETTINGS, ...input.settings };
  if (!(quantity > 0)) throw new RangeError(`Quantity must be positive (got ${quantity})`);

  const today = sydneyDate(input.at ?? new Date());
  const base = tierPrice(product, customer) ?? product.defaultSellPrice;

  const priceFromRule = (r: CustomerPriceRule): number => {
    if (r.unleashedCustomerPrice != null && r.unleashedCustomerPrice > 0) return r.unleashedCustomerPrice;
    if (r.type === "fixed") return r.value;
    if (base == null) return Number.POSITIVE_INFINITY; // can't price a % off nothing
    return applyDiscount(base, r.value / 100);
  };

  const finish = (unit: number, source: PriceSource, detail: string, ruleId?: string): ResolvedPrice => {
    const unitExGst = roundCents(unit);
    const unitIncGst = product.taxable ? roundCents(unitExGst * (1 + settings.gstRate)) : unitExGst;
    return {
      productCode: product.code,
      customerCode: customer.code,
      quantity,
      unitExGst,
      unitIncGst,
      lineExGst: roundCents(multiply(unitExGst, quantity)),
      source,
      detail,
      ruleId,
    };
  };

  // 1. Customer Pricing
  const live = input.rules.filter((r) => ruleApplies(r, customer.code, quantity, today));
  const productRules = live.filter((r) => r.productCode === product.code);
  const groupRules = live.filter((r) => !r.productCode && r.groupName && r.groupName === product.groupName);
  for (const [rules, source] of [
    [productRules, "customer-product"],
    [groupRules, "customer-group"],
  ] as const) {
    if (!rules.length) continue;
    const rule = pickRule(rules, priceFromRule);
    const price = priceFromRule(rule);
    if (Number.isFinite(price)) {
      const what = rule.type === "fixed" ? `fixed $${rule.value}` : `${rule.value}% off`;
      const scope = rule.productCode ? `product ${rule.productCode}` : `group "${rule.groupName}"`;
      return finish(price, source, `Customer Pricing (${scope}, ${what}, min qty ${rule.minQty})`, rule.id);
    }
  }

  // 2. Quantity Prices
  const qpPrice = (q: QuantityPrice): number => {
    if (q.unleashedPrice != null && q.unleashedPrice > 0) return q.unleashedPrice;
    if (q.type === "fixed") return q.value;
    if (product.defaultSellPrice == null) return Number.POSITIVE_INFINITY;
    return applyDiscount(product.defaultSellPrice, q.value / 100);
  };
  const breaks = (input.quantityPrices ?? []).filter(
    (q) =>
      q.productCode === product.code &&
      quantity >= q.minQty &&
      (!q.validFrom || today >= q.validFrom) &&
      (!q.validTo || today <= q.validTo),
  );
  if (breaks.length) {
    const qp = breaks.sort((a, b) => b.minQty - a.minQty || qpPrice(a) - qpPrice(b))[0];
    const price = qpPrice(qp);
    if (Number.isFinite(price)) {
      const what = qp.type === "fixed" ? `fixed $${qp.value}` : `${qp.value}% off default`;
      return finish(price, "quantity", `Quantity Price (${what}, min qty ${qp.minQty})`, qp.id);
    }
  }

  // 3. Sell Price Tier less discount
  const tp = tierPrice(product, customer);
  if (tp != null) {
    const unit = applyDiscount(tp, customer.discount);
    const disc = customer.discount ? `, less ${pct(customer.discount)} customer discount` : "";
    return finish(unit, "tier", `Sell Price Tier ${customer.tier}${disc}`);
  }

  // 4. Default Sell Price
  if (product.defaultSellPrice == null) {
    throw new PricingError(`No price for ${product.code}: no Customer Pricing, tier price or Default Sell Price`);
  }
  const discount = settings.applyDiscountToDefault ? customer.discount : 0;
  const unit = applyDiscount(product.defaultSellPrice, discount);
  const note =
    customer.tier != null ? ` (Tier ${customer.tier} is blank on this product)` : "";
  const disc = discount ? `, less ${pct(discount)} customer discount` : "";
  return finish(unit, "default", `Default Sell Price${note}${disc}`);
}

export class PricingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingError";
  }
}

function pct(fraction: number): string {
  return `${Math.round(fraction * 10000) / 100}%`;
}
