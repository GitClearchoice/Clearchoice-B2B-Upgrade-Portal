import { parseUnleashedDate } from "../unleashed/client.ts";
import type { UCustomer, UProduct, UProductPrice, USellPriceTier } from "../unleashed/types.ts";
import { sydneyDate } from "../pricing/engine.ts";
import type { Customer, CustomerPriceRule, Product } from "../pricing/types.ts";

export type DiscountRateFormat = "fraction" | "percent";

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function mapProduct(p: UProduct): Product {
  const tiers: (number | null)[] = [];
  for (let i = 1; i <= 10; i++) {
    const t = p[`SellPriceTier${i}` as keyof UProduct] as UProduct["SellPriceTier1"];
    const v = num(t?.Value);
    // Unleashed returns 0 / blank for an unset tier; treat 0 as "not set".
    tiers.push(v && v > 0 ? v : null);
  }
  const dsp = num(p.DefaultSellPrice);
  return {
    code: p.ProductCode,
    description: p.ProductDescription ?? undefined,
    groupName: p.ProductGroup?.GroupName ?? null,
    defaultSellPrice: dsp && dsp > 0 ? dsp : null,
    tierPrices: tiers,
    taxable: p.TaxableSales !== false,
    obsolete: Boolean(p.Obsolete),
    sellable: p.IsSellable !== false,
  };
}

/**
 * Customers carry their tier as a name ("Sell Price Tier 3", or a renamed tier such as "Trade").
 * We map it to the tier number using the account's SellPriceTiers list.
 */
export function mapCustomer(
  c: UCustomer,
  tiers: USellPriceTier[],
  discountFormat: DiscountRateFormat,
): Customer {
  let tier: number | null = num(c.SellPriceTierReference?.Tier);
  if (tier == null && c.SellPriceTier) {
    const name = c.SellPriceTier.trim().toLowerCase();
    const hit = tiers.find((t) => t.Name.trim().toLowerCase() === name);
    tier = hit ? hit.Tier : null;
    if (tier == null) {
      const m = /tier\s*(\d+)/i.exec(c.SellPriceTier);
      tier = m ? Number(m[1]) : null;
    }
  }
  if (tier != null && (tier < 1 || tier > 10)) tier = null;

  const raw = num(c.DiscountRate) ?? 0;
  const discount = discountFormat === "percent" ? raw / 100 : raw;
  if (discount < 0 || discount >= 1) {
    throw new Error(
      `Customer ${c.CustomerCode} has DiscountRate ${raw}, which is out of range for format "${discountFormat}". ` +
        `Check UNLEASHED_DISCOUNT_RATE_FORMAT.`,
    );
  }
  return {
    code: c.CustomerCode,
    name: c.CustomerName ?? undefined,
    tier,
    discount,
    obsolete: Boolean(c.Obsolete),
  };
}

export function mapProductPrice(pp: UProductPrice): CustomerPriceRule | null {
  const customerCode = pp.Customer?.CustomerCode;
  const productCode = pp.Product?.ProductCode || null;
  const groupName = productCode ? null : pp.ProductGroup?.GroupName || null;
  if (!customerCode || (!productCode && !groupName)) return null; // not a customer-specific line

  const isDiscount = /discount|%/i.test(pp.PriceType ?? "");
  const value = isDiscount ? num(pp.DiscountValue) : (num(pp.CustomerPrice) ?? num(pp.DiscountValue));
  if (value == null) return null;

  const from = parseUnleashedDate(pp.ValidFrom);
  const to = parseUnleashedDate(pp.ValidTo);
  return {
    id: pp.Guid,
    customerCode,
    productCode,
    groupName,
    type: isDiscount ? "discount" : "fixed",
    value,
    unleashedCustomerPrice: num(pp.CustomerPrice),
    minQty: num(pp.MinimumQuantity) ?? 0,
    validFrom: from ? sydneyDate(from) : null,
    validTo: to ? sydneyDate(to) : null,
  };
}
