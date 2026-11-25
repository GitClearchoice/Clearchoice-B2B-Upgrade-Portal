import { parseUnleashedDate, type UnleashedClient } from "../unleashed/client.ts";
import type { UAddress, UCustomer } from "../unleashed/types.ts";
import { sydneyDate } from "../pricing/engine.ts";

export interface Candidate {
  code: string;
  name: string;
  orders: number;
  lastOrder: string; // YYYY-MM-DD
  tier: string;
  discountPct: number;
  customerPricingLines: number;
  deliverySites: number;
  contactName: string;
  contactEmail: string;
  paymentTerm: string;
  flags: string[];
  include: boolean;
}

/** Unleashed codes that are just a long number are usually Shopify web customers. */
export function looksLikeWebCustomer(code: string): boolean {
  return /^\d{8,}$/.test(code.trim());
}

export function activeDeliveryAddresses(list: UAddress[] | null | undefined): UAddress[] {
  return (list ?? []).filter((a) => !a.Obsolete && (a.StreetAddress || a.AddressName));
}

/**
 * Customers with a (non-deleted) sales order in the last `months` months, with what we know
 * about each, so you can decide who's trade. Web-looking customers start as Include = N.
 */
export async function buildCandidates(
  client: UnleashedClient,
  opts: { months?: number; now?: Date; log?: (m: string) => void } = {},
): Promise<Candidate[]> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const start = new Date(now);
  start.setMonth(start.getMonth() - (opts.months ?? 12));
  const startDate = sydneyDate(start);

  log(`Reading sales orders since ${startDate} (this can take a few minutes)…`);
  const orders = new Map<string, { count: number; last: string }>();
  let n = 0;
  for await (const o of client.salesOrders({ startDate })) {
    n++;
    const code = o.Customer?.CustomerCode;
    if (!code) continue;
    const d = parseUnleashedDate(o.OrderDate);
    const day = d ? sydneyDate(d) : "";
    const cur = orders.get(code) ?? { count: 0, last: "" };
    cur.count++;
    if (day > cur.last) cur.last = day;
    orders.set(code, cur);
    if (n % 1000 === 0) log(`  ${n} orders…`);
  }
  log(`  ${n} orders from ${orders.size} customers`);

  log("Reading customers, delivery addresses and customer pricing…");
  const [customers, delivery, prices] = await Promise.all([
    client.customers({ includeObsolete: true }),
    client.customerDeliveryAddresses(),
    client.productPrices(),
  ]);
  const byCode = new Map<string, UCustomer>(customers.map((c) => [c.CustomerCode, c]));
  const sitesByCode = new Map(delivery.map((d) => [d.CustomerCode, activeDeliveryAddresses(d.Addresses)]));
  const pricingCount = new Map<string, number>();
  for (const p of prices) {
    const c = p.Customer?.CustomerCode;
    if (c) pricingCount.set(c, (pricingCount.get(c) ?? 0) + 1);
  }

  const out: Candidate[] = [];
  for (const [code, o] of orders) {
    const c = byCode.get(code);
    const flags: string[] = [];
    if (!c) flags.push("customer not found");
    if (c?.Obsolete) flags.push("obsolete in Unleashed");
    if (looksLikeWebCustomer(code)) flags.push("looks like a web customer");
    const sites = sitesByCode.get(code)?.length ?? 0;
    if (!sites) flags.push("no delivery sites");
    const email = (c?.Email ?? "").trim();
    if (!email) flags.push("no primary contact email");
    const pricing = pricingCount.get(code) ?? 0;
    const tier = (c?.SellPriceTier ?? "").trim();
    const discount = c?.DiscountRate ?? 0;
    if (!tier && !discount && !pricing) flags.push("no trade pricing");

    out.push({
      code,
      name: (c?.CustomerName ?? "").trim(),
      orders: o.count,
      lastOrder: o.last,
      tier,
      discountPct: Math.round(discount * 10000) / 100,
      customerPricingLines: pricing,
      deliverySites: sites,
      contactName: [c?.ContactFirstName, c?.ContactLastName].map((s) => (s ?? "").trim()).filter(Boolean).join(" "),
      contactEmail: email,
      paymentTerm: (c?.PaymentTerm ?? "").trim(),
      flags,
      include: !!c && !c.Obsolete && !looksLikeWebCustomer(code),
    });
  }
  // Trade-looking customers first, then by order count.
  return out.sort((a, b) => Number(b.include) - Number(a.include) || b.orders - a.orders);
}

export const CANDIDATE_HEADER = [
  "Include", "Customer Code", "Customer Name", "Orders (12 months)", "Last Order", "Sell Price Tier",
  "Discount %", "Customer Pricing Lines", "Delivery Sites", "Primary Contact", "Primary Contact Email",
  "Payment Term", "Flags",
];

export function candidateRow(c: Candidate): (string | number)[] {
  return [
    c.include ? "Y" : "N", c.code, c.name, c.orders, c.lastOrder, c.tier, c.discountPct,
    c.customerPricingLines, c.deliverySites, c.contactName, c.contactEmail, c.paymentTerm, c.flags.join("; "),
  ];
}
