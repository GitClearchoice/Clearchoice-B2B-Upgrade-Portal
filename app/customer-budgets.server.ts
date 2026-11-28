// Phase 5: the head-office admin's "Site budgets" page in the customer account (extension
// extensions/site-budgets). Same data as the staff Site budgets page: SiteBudget rows, trade orders,
// closed sites.
import { createHmac, timingSafeEqual } from "node:crypto";
import prisma from "./db.server";
import { COMMITTED } from "./budget.server";
import { shopifySites } from "./sites.server";
import { approvalToken } from "../src/orders/approvalToken.ts";
import {
  addMonths,
  financialYearOf,
  monthLabel,
  parseFinancialYear,
  parseQuarter,
  quarterOf,
  shortMonthLabel,
  sydneyMonth,
  sydneyMonthRange,
} from "../src/orders/budget.ts";
import type { ShopifyGraphql } from "../src/orders/placeOrder.ts";
import { readBudgetCsv, writeBudgetCsv } from "../src/b2b/budgetCsv.ts";

const STATUS_LABEL: Record<string, string> = {
  sent: "Sent to Clearchoice",
  pending: "Sending",
  failed: "Sending (retrying)",
  "awaiting-approval": "Waiting for approval",
  rejected: "Declined",
};

const round = (n: number) => Math.round(n * 100) / 100;

export async function openSites(shop: string, shopify: ShopifyGraphql, companyId: string) {
  const [sites, statuses] = await Promise.all([
    shopifySites(shopify, companyId),
    prisma.siteStatus.findMany({ where: { shop, companyId, closed: true }, select: { locationId: true } }),
  ]);
  const closed = new Set(statuses.map((s) => s.locationId));
  return sites.filter((s) => !s.closedInShopify && !closed.has(s.locationId)).sort((a, b) => a.name.localeCompare(b.name));
}

export interface ViewParams {
  quarter?: string | null;
  fy?: string | null;
  site?: string | null; // year summary + order history filter
  /** Year report export: also work out each site's totals for the year. */
  perSite?: boolean;
}

export async function budgetsView(shop: string, shopify: ShopifyGraphql, companyId: string, p: ViewParams) {
  const now = new Date();
  const thisMonth = sydneyMonth(now);
  const quarter = parseQuarter(p.quarter) ?? quarterOf(thisMonth);
  const fy = parseFinancialYear(p.fy) ?? financialYearOf(thisMonth);
  const sites = await openSites(shop, shopify, companyId);
  const siteIds = new Set(sites.map((s) => s.locationId));
  const siteFilter = p.site && siteIds.has(p.site) ? p.site : null;

  const months = [...new Set(["default", thisMonth, ...quarter.months, ...fy.months])];
  const rows = await prisma.siteBudget.findMany({ where: { shop, companyId, month: { in: months } } });
  const val = (loc: string, m: string) => {
    const r = rows.find((x) => x.locationId === loc && x.month === m);
    return r ? Number(r.amountExGst.toString()) : null;
  };
  const effective = (loc: string, m: string) => val(loc, m) ?? val(loc, "default");

  // Orders from the earliest month we need to the latest.
  const all = [thisMonth, ...quarter.months, ...fy.months].sort();
  const from = sydneyMonthRange(all[0]!).start;
  const to = sydneyMonthRange(all[all.length - 1]!).end;
  const orders = await prisma.tradeOrder.findMany({
    where: { shop, companyId, createdAt: { gte: from, lt: to } },
    select: { id: true, locationId: true, siteName: true, createdAt: true, goodsExGst: true, status: true, poNumber: true, draftOrderName: true, unleashedOrderNumber: true, buyerName: true, approverName: true, decidedAt: true },
    orderBy: { createdAt: "desc" },
  });
  const spend = new Map<string, { committed: number; awaiting: number }>(); // `${loc}|${month}`
  for (const o of orders) {
    const k = `${o.locationId}|${sydneyMonth(o.createdAt)}`;
    const cur = spend.get(k) ?? { committed: 0, awaiting: 0 };
    const v = Number(o.goodsExGst.toString());
    if (COMMITTED.includes(o.status)) cur.committed += v;
    else if (o.status === "awaiting-approval") cur.awaiting += v;
    spend.set(k, cur);
  }
  const spent = (loc: string, m: string) => spend.get(`${loc}|${m}`) ?? { committed: 0, awaiting: 0 };

  // Approvals waiting for this admin.
  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  const appUrl = (process.env.SHOPIFY_APP_URL ?? "").replace(/\/$/, "");
  const waiting = await prisma.tradeOrder.findMany({
    where: { shop, companyId, status: "awaiting-approval" },
    orderBy: { createdAt: "asc" },
    select: { id: true, siteName: true, buyerName: true, poNumber: true, goodsExGst: true, createdAt: true, draftOrderName: true },
  });

  return {
    thisMonth: { key: thisMonth, label: monthLabel(thisMonth) },
    quarter: {
      key: quarter.key,
      label: quarter.label,
      months: quarter.months.map((m) => ({ key: m, label: shortMonthLabel(m) })),
      prev: quarterOf(addMonths(quarter.months[0], -3)).key,
      next: quarterOf(addMonths(quarter.months[0], 3)).key,
    },
    sites: sites.map((s) => {
      const b = effective(s.locationId, thisMonth);
      const sp = spent(s.locationId, thisMonth);
      return {
        id: s.locationId,
        name: s.name,
        default: val(s.locationId, "default"),
        months: quarter.months.map((m) => val(s.locationId, m)),
        effective: quarter.months.map((m) => effective(s.locationId, m)),
        now: { budget: b, ordered: round(sp.committed), awaiting: round(sp.awaiting) },
      };
    }),
    approvals: waiting.map((o) => ({
      id: o.id,
      reference: o.draftOrderName,
      site: o.siteName,
      buyer: o.buyerName,
      po: o.poNumber,
      goodsExGst: Number(o.goodsExGst.toString()),
      placed: o.createdAt.toISOString(),
      reviewUrl: secret && appUrl ? `${appUrl}/approvals/${o.id}?t=${approvalToken(o.id, secret)}` : null,
    })),
    year: (() => {
      const list = siteFilter ? sites.filter((s) => s.locationId === siteFilter) : sites;
      const monthsOut = fy.months.map((m) => {
        let budget = 0;
        let unbudgeted = 0;
        let ordered = 0;
        for (const s of list) {
          const b = effective(s.locationId, m);
          if (b == null) unbudgeted++;
          else budget += b;
          ordered += spent(s.locationId, m).committed;
        }
        return { key: m, label: shortMonthLabel(m), budget: round(budget), ordered: round(ordered), unbudgeted };
      });
      return {
        key: fy.key,
        label: fy.label,
        prev: `FY${Number(fy.key.slice(2)) - 1}`,
        next: `FY${Number(fy.key.slice(2)) + 1}`,
        site: siteFilter,
        months: monthsOut,
        totals: { budget: round(monthsOut.reduce((t, m) => t + m.budget, 0)), ordered: round(monthsOut.reduce((t, m) => t + m.ordered, 0)) },
        perSite: p.perSite
          ? list.map((st) => {
              let budget = 0;
              let unbudgeted = 0;
              let ordered = 0;
              for (const m of fy.months) {
                const b = effective(st.locationId, m);
                if (b == null) unbudgeted++;
                else budget += b;
                ordered += spent(st.locationId, m).committed;
              }
              return { name: st.name, budget: round(budget), ordered: round(ordered), monthsWithoutBudget: unbudgeted };
            })
          : undefined,
      };
    })(),
    orders: orders
      .filter((o) => fy.months.includes(sydneyMonth(o.createdAt)) && (!siteFilter || o.locationId === siteFilter))
      .slice(0, 200)
      .map((o) => ({
        id: o.id,
        placed: o.createdAt.toISOString(),
        site: o.siteName,
        so: o.unleashedOrderNumber,
        reference: o.draftOrderName,
        po: o.poNumber,
        buyer: o.buyerName,
        goodsExGst: Number(o.goodsExGst.toString()),
        status: STATUS_LABEL[o.status] ?? o.status,
      })),
    exportUrl: appUrl && secret ? exportUrl(appUrl, secret, { kind: "orders", shop, company: companyId, fy: fy.key, site: siteFilter ?? "" }) : null,
    budgetsExportUrl: appUrl && secret ? exportUrl(appUrl, secret, { kind: "budgets", shop, company: companyId, quarter: quarter.key }) : null,
    yearExportUrl: appUrl && secret ? exportUrl(appUrl, secret, { kind: "year", shop, company: companyId, fy: fy.key, site: siteFilter ?? "" }) : null,
  };
}

/** Saves one site's budgets: "Every month" plus the given months (blank = remove). */
export async function saveSiteBudgets(
  shop: string,
  companyId: string,
  site: { id: string; name: string },
  values: Record<string, number | null>,
  by: string,
) {
  const ops = Object.entries(values).map(([month, v]) => {
    if (month !== "default" && !/^\d{4}-\d{2}$/.test(month)) throw new Error(`Bad month ${month}`);
    if (v != null && (!Number.isFinite(v) || v < 0 || v >= 100_000_000)) throw new Error("Budgets must be a positive amount");
    return v == null
      ? prisma.siteBudget.deleteMany({ where: { shop, locationId: site.id, month } })
      : prisma.siteBudget.upsert({
          where: { shop_locationId_month: { shop, locationId: site.id, month } },
          create: { shop, companyId, locationId: site.id, siteName: site.name, month, amountExGst: round(v), updatedBy: by },
          update: { amountExGst: round(v), siteName: site.name, updatedBy: by },
        });
  });
  await prisma.$transaction(ops);
}

// ---------- CSV downloads (opened in a new tab, so they carry a signed, 15-minute link instead of a session token)

const EXPORT_KEYS = ["kind", "shop", "company", "fy", "site", "quarter", "exp"] as const;

function sign(secret: string, q: URLSearchParams) {
  return createHmac("sha256", secret).update(`export:${EXPORT_KEYS.map((k) => q.get(k) ?? "").join("|")}`).digest("base64url");
}

export function exportUrl(appUrl: string, secret: string, p: Record<string, string>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) q.set(k, v);
  q.set("exp", String(Math.floor(Date.now() / 1000) + 15 * 60));
  q.set("sig", sign(secret, q));
  return `${appUrl}/customer/budgets/export?${q}`;
}

export function verifyExport(secret: string, q: URLSearchParams): boolean {
  const exp = Number(q.get("exp"));
  if (!secret || !exp || exp * 1000 < Date.now()) return false;
  const want = Buffer.from(sign(secret, q));
  const got = Buffer.from(q.get("sig") ?? "");
  return want.length === got.length && timingSafeEqual(want, got);
}

/** The company's open sites with their budgets for a quarter, as the budgets CSV. */
export async function exportBudgetsCsv(shop: string, shopify: ShopifyGraphql, companyId: string, quarterKey: string | null) {
  const quarter = parseQuarter(quarterKey) ?? quarterOf(sydneyMonth(new Date()));
  const sites = await openSites(shop, shopify, companyId);
  const rows = await prisma.siteBudget.findMany({ where: { shop, companyId, month: { in: ["default", ...quarter.months] } } });
  const val = (loc: string, m: string) => {
    const r = rows.find((x) => x.locationId === loc && x.month === m);
    return r ? Number(r.amountExGst.toString()) : null;
  };
  const csv = writeBudgetCsv(
    quarter.months.map((m) => ({ key: m, label: shortMonthLabel(m) })),
    sites.map((s) => ({ id: s.locationId, name: s.name, default: val(s.locationId, "default"), months: quarter.months.map((m) => val(s.locationId, m)) })),
  );
  return { filename: `site-budgets-${quarter.key}.csv`, csv };
}

/** Imports a budgets CSV for the company's open sites (matched by Site ID, then name). */
export async function importBudgetsCsv(shop: string, shopify: ShopifyGraphql, companyId: string, text: string, by: string) {
  const rows = readBudgetCsv(text); // throws on bad amounts / missing columns: nothing saved
  const sites = await openSites(shop, shopify, companyId);
  const byId = new Map(sites.map((x) => [x.locationId, x]));
  const byName = new Map(sites.map((x) => [x.name.trim().toLowerCase(), x]));
  let updated = 0;
  const unknown: string[] = [];
  for (const r of rows) {
    const site = (r.siteId && byId.get(r.siteId)) || (r.site ? byName.get(r.site.toLowerCase()) : undefined);
    if (!site) { unknown.push(r.site || r.siteId || "(no name)"); continue; }
    await saveSiteBudgets(shop, companyId, { id: site.locationId, name: site.name }, r.values, by);
    updated++;
  }
  return { updated, unknown };
}

/**
 * Order history report: one row per product line (better for pivot tables), with the order's details
 * repeated on each row, the product code and description in their own columns, and the Shopify
 * product type.
 */
export async function exportCsv(shop: string, shopify: ShopifyGraphql, companyId: string, fyKey: string, site: string | null): Promise<{ filename: string; csv: string }> {
  const fy = parseFinancialYear(fyKey) ?? financialYearOf(sydneyMonth(new Date()));
  const from = sydneyMonthRange(fy.months[0]!).start;
  const to = sydneyMonthRange(fy.months[11]!).end;
  const orders = await prisma.tradeOrder.findMany({
    where: { shop, companyId, createdAt: { gte: from, lt: to }, ...(site ? { locationId: site } : {}) },
    orderBy: { createdAt: "asc" },
  });
  type Line = { variantId?: string; sku: string; title?: string; quantity: number; unitExGst: number; lineExGst: number };

  // Product type (and title, as a fallback description) from Shopify, by variant.
  const variantIds = [...new Set(orders.flatMap((o) => (o.lines as Line[]).map((l) => l.variantId).filter((v): v is string => !!v)))];
  const products = new Map<string, { type: string; title: string }>();
  for (let i = 0; i < variantIds.length; i += 100) {
    try {
      const d = await shopify<{ nodes: ({ id: string; product: { title: string; productType: string } } | null)[] }>(
        `#graphql
        query ReportProducts($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id product { title productType } } } }`,
        { ids: variantIds.slice(i, i + 100) },
      );
      for (const n of d.nodes) if (n?.id && n.product) products.set(n.id, { type: n.product.productType ?? "", title: n.product.title ?? "" });
    } catch (e) {
      console.error(`[report] product types: ${(e as Error).message}`);
    }
  }

  const cell = (v: unknown) => {
    const t = String(v ?? "");
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const header = [
    "Date", "Site", "Unleashed order", "Shopify reference", "PO number", "Ordered by", "Status", "Approved/declined by",
    "Product code", "Product description", "Product type", "Quantity", "Unit price ex GST", "Line total ex GST", "Order total ex GST",
  ];
  const rows: string[] = [];
  for (const o of orders) {
    const order = [
      o.createdAt.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" }),
      o.siteName,
      o.unleashedOrderNumber ?? "",
      o.draftOrderName ?? "",
      o.poNumber,
      o.buyerName,
      STATUS_LABEL[o.status] ?? o.status,
      o.decidedAt ? o.approverName ?? "" : "",
    ];
    for (const l of o.lines as Line[]) {
      const p = l.variantId ? products.get(l.variantId) : undefined;
      rows.push(
        [...order, l.sku, l.title || p?.title || "", p?.type ?? "", l.quantity, Number(l.unitExGst).toFixed(2), Number(l.lineExGst).toFixed(2), Number(o.goodsExGst.toString()).toFixed(2)]
          .map(cell)
          .join(","),
      );
    }
  }
  const company = orders[0]?.companyName?.replace(/[^A-Za-z0-9]+/g, "-") || "orders";
  return { filename: `${company}-${fy.key}${site ? "-site" : ""}-order-lines.csv`, csv: "\uFEFF" + [header.map(cell).join(","), ...rows].join("\r\n") };
}

/** Year summary report: month-by-month budget vs ordered, then each site's totals for the year. */
export async function exportYearCsv(shop: string, shopify: ShopifyGraphql, companyId: string, fyKey: string | null, site: string | null) {
  const v = await budgetsView(shop, shopify, companyId, { fy: fyKey, site, perSite: true });
  const y = v.year;
  const cell = (x: unknown) => {
    const t = String(x ?? "");
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const row = (...xs: unknown[]) => xs.map(cell).join(",");
  const amt = (n: number) => n.toFixed(2);
  const siteName = site ? v.sites.find((s) => s.id === site)?.name ?? "" : "All sites";
  const lines = [
    row(`Year summary ${y.label}`, siteName),
    row("Goods ex GST. Budget counts sites that have one; ordered counts orders sent to Clearchoice (incl. approved)."),
    "",
    row("Month", "Budget", "Ordered", "Remaining", "Over by", "Sites without a budget"),
    ...y.months.map((m) => {
      const diff = m.budget - m.ordered;
      return row(m.label, amt(m.budget), amt(m.ordered), m.budget && diff >= 0 ? amt(diff) : "", m.budget && diff < 0 ? amt(-diff) : "", m.unbudgeted);
    }),
    row("Total", amt(y.totals.budget), amt(y.totals.ordered), y.totals.budget >= y.totals.ordered ? amt(y.totals.budget - y.totals.ordered) : "", y.totals.budget < y.totals.ordered ? amt(y.totals.ordered - y.totals.budget) : ""),
    "",
    row("Site", "Budget for the year", "Ordered", "Remaining", "Over by", "Months without a budget"),
    ...(y.perSite ?? []).map((st) => {
      const diff = st.budget - st.ordered;
      return row(st.name, amt(st.budget), amt(st.ordered), st.budget && diff >= 0 ? amt(diff) : "", st.budget && diff < 0 ? amt(-diff) : "", st.monthsWithoutBudget);
    }),
  ];
  return { filename: `year-summary-${y.key}${site ? "-site" : ""}.csv`, csv: "\uFEFF" + lines.join("\r\n") };
}
