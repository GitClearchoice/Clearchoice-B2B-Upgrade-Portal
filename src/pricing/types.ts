// Normalised pricing data, independent of the Unleashed wire format.
// All prices are ex GST unless named otherwise.

export interface Product {
  code: string; // Unleashed ProductCode = Shopify variant SKU
  description?: string;
  groupName: string | null;
  defaultSellPrice: number | null;
  /** Index 0 = Sell Price Tier 1 … index 9 = Tier 10. null = blank in Unleashed. */
  tierPrices: (number | null)[];
  taxable: boolean;
  obsolete: boolean;
  sellable: boolean;
}

export interface Customer {
  code: string; // Unleashed CustomerCode = Shopify company.externalId
  name?: string;
  /** 1–10, or null when no Sell Price Tier is allocated. */
  tier: number | null;
  /** Customer discount as a fraction (0.1 = 10%). */
  discount: number;
  obsolete: boolean;
}

/** One Unleashed Customer Pricing line (ProductPrices). */
export interface CustomerPriceRule {
  id: string;
  customerCode: string;
  /** Exactly one of productCode / groupName is set. */
  productCode: string | null;
  groupName: string | null;
  type: "fixed" | "discount";
  /** Fixed price (type "fixed") or percent off, e.g. 15 for 15% (type "discount"). */
  value: number;
  /** The price Unleashed itself calculated, when it returns one. Preferred when present. */
  unleashedCustomerPrice: number | null;
  minQty: number;
  /** Inclusive Sydney dates, "YYYY-MM-DD", or null for open-ended. */
  validFrom: string | null;
  validTo: string | null;
}

/** Product-level quantity price break (Unleashed Quantity Prices). Optional in phase 1. */
export interface QuantityPrice {
  productCode: string;
  minQty: number;
  price: number;
}

export type PriceSource =
  | "customer-product"
  | "customer-group"
  | "quantity"
  | "tier"
  | "default";

export interface ResolvedPrice {
  productCode: string;
  customerCode: string;
  quantity: number;
  /** Unit price ex GST, rounded to cents. */
  unitExGst: number;
  /** Unit price inc GST (unit ex GST + 10% if taxable), rounded to cents. */
  unitIncGst: number;
  lineExGst: number;
  source: PriceSource;
  /** Human-readable explanation, for the admin page and debugging. */
  detail: string;
  ruleId?: string;
}

export interface PricingSettings {
  gstRate: number; // 0.10
  /** Whether the customer discount % also applies when the Default Sell Price is used. */
  applyDiscountToDefault: boolean;
}

export const DEFAULT_SETTINGS: PricingSettings = {
  gstRate: 0.1,
  applyDiscountToDefault: true,
};
