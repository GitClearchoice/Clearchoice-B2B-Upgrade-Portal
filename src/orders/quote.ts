// Quotes from the trade cart (admin and site managers): priced on the server like an order, as a PDF
// (laid out to be read by ApprovalMax Capture and similar tools) or a CSV of the lines. Valid 30 days.
import { randomBytes } from "node:crypto";
import { priceLines } from "../index.ts";
import type { PriceStore } from "../sync/store.ts";
import type { BuyerContext } from "../b2b/buyer.ts";
import { OrderError, normaliseVariantId, type ShopifyGraphql } from "./placeOrder.ts";
import { csvCell } from "../b2b/budgetCsv.ts";

export const SUPPLIER = {
  name: "Clearchoice Products Pty Ltd",
  abn: "64 086 032 135",
  address: ["1 Hilton Avenue", "Sydenham NSW 2044", "Australia"],
  phone: "02 9557 0111",
  email: "service@clearchoiceproducts.com",
};
export const QUOTE_VALID_DAYS = 30;
const GST_RATE = 0.1;

export interface QuoteLine {
  sku: string;
  description: string;
  quantity: number;
  unitExGst: number;
  lineExGst: number;
  gst: number;
}

export interface Quote {
  number: string;
  date: Date;
  validUntil: Date;
  companyName: string;
  customerCode: string;
  siteName: string;
  deliveryAddress: string[];
  preparedFor: string;
  lines: QuoteLine[];
  subtotalExGst: number;
  gst: number;
  totalIncGst: number;
}

const QUOTE_SITE = `#graphql
  query QuoteSite($location: ID!, $variants: [ID!]!) {
    companyLocation(id: $location) {
      name
      shippingAddress { recipient address1 address2 city zoneCode zip countryCode }
    }
    nodes(ids: $variants) { ... on ProductVariant { id sku product { title } } }
  }`;

const cents = (n: number) => Math.round(n * 100) / 100;

export async function buildQuote(
  deps: { shopify: ShopifyGraphql; store: PriceStore; now?: () => Date },
  buyer: BuyerContext,
  lines: { variantId: string; quantity: number }[],
): Promise<Quote> {
  if (!lines.length) throw new OrderError("Your cart is empty");
  if (lines.length > 250) throw new OrderError("At most 250 lines per quote");
  const qty = new Map<string, number>();
  for (const l of lines) {
    const id = normaliseVariantId(l.variantId);
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 100_000) throw new OrderError(`Bad quantity ${l.quantity}`);
    qty.set(id, (qty.get(id) ?? 0) + l.quantity);
  }
  const ids = [...qty.keys()];
  const d = await deps.shopify<{
    companyLocation: { name: string; shippingAddress: { recipient: string | null; address1: string | null; address2: string | null; city: string | null; zoneCode: string | null; zip: string | null; countryCode: string | null } | null } | null;
    nodes: ({ id: string; sku: string | null; product: { title: string } | null } | null)[];
  }>(QUOTE_SITE, { location: buyer.site.id, variants: ids });
  const variants = new Map(d.nodes.filter((n): n is NonNullable<typeof n> => !!n?.sku).map((n) => [n.id, n]));
  const missing = ids.filter((v) => !variants.has(v));
  if (missing.length) throw new OrderError(`${missing.length} item(s) in your cart have no product code and can't be quoted.`);

  const wanted = ids.map((v) => ({ variantId: v, sku: variants.get(v)!.sku!.trim(), quantity: qty.get(v)! }));
  const priced = await priceLines(deps.store, buyer.site.customerCode, wanted.map((w) => ({ sku: w.sku, quantity: w.quantity })));
  if (priced.errors.length) throw new OrderError(`Can't quote: ${priced.errors.map((e) => `${e.sku} (${e.error})`).join(", ")}`);

  const out: QuoteLine[] = [];
  for (const [i, p] of priced.lines.entries()) {
    const product = await deps.store.getProduct(p.productCode);
    const taxable = product?.taxable !== false;
    out.push({
      sku: p.productCode,
      description: product?.description || variants.get(wanted[i]!.variantId)?.product?.title || p.productCode,
      quantity: p.quantity,
      unitExGst: p.unitExGst,
      lineExGst: p.lineExGst,
      gst: taxable ? cents(p.lineExGst * GST_RATE) : 0,
    });
  }
  const subtotal = cents(out.reduce((t, l) => t + l.lineExGst, 0));
  const gst = cents(out.reduce((t, l) => t + l.gst, 0));
  const date = deps.now?.() ?? new Date();
  const a = d.companyLocation?.shippingAddress;
  return {
    number: `Q${date.toISOString().slice(2, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex").toUpperCase()}`,
    date,
    validUntil: new Date(date.getTime() + QUOTE_VALID_DAYS * 86_400_000),
    companyName: buyer.companyName,
    customerCode: buyer.site.customerCode,
    siteName: d.companyLocation?.name ?? buyer.site.name,
    deliveryAddress: a
      ? [a.address1, a.address2, [a.city, a.zoneCode, a.zip].filter(Boolean).join(" "), a.countryCode === "AU" ? "Australia" : a.countryCode].filter((x): x is string => !!x && !!x.trim())
      : [],
    preparedFor: `${buyer.name}${buyer.email ? ` <${buyer.email}>` : ""}`,
    lines: out,
    subtotalExGst: subtotal,
    gst,
    totalIncGst: cents(subtotal + gst),
  };
}

const auDate = (d: Date) => d.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", day: "2-digit", month: "2-digit", year: "numeric" });

/** CSV of the quote lines, for approval / purchasing systems that import spreadsheets. */
export function quoteCsv(q: Quote): string {
  const header = [
    "Quote number", "Quote date", "Valid until", "Supplier", "Supplier ABN", "Customer", "Site",
    "Item code", "Description", "Quantity", "Unit price ex GST", "Tax rate", "Line amount ex GST", "GST", "Line amount inc GST",
  ];
  const rows = q.lines.map((l) =>
    [
      q.number, auDate(q.date), auDate(q.validUntil), SUPPLIER.name, SUPPLIER.abn, q.companyName, q.siteName,
      l.sku, l.description, l.quantity, l.unitExGst.toFixed(2), l.gst ? "GST 10%" : "GST free", l.lineExGst.toFixed(2), l.gst.toFixed(2), (l.lineExGst + l.gst).toFixed(2),
    ].map(csvCell).join(","),
  );
  return "﻿" + [header.map(csvCell).join(","), ...rows].join("\r\n");
}

export { auDate };
