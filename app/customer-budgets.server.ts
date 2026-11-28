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
    exportUrl: appUrl && secret ? exportUrl(appUrl, secret, shop, companyId, fy.key, siteFilter) : null,
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

// ---------- CSV export (opened in a new tab, so it carries a signed, 15-minute link instead of a session token)

function sign(secret: string, parts: string[]) {
  return createHmac("sha256", secret).update(`export:${parts.join("|")}`).digest("base64url");
}

export function exportUrl(appUrl: string, secret: string, shop: string, companyId: string, fy: string, site: string | null) {
  const exp = String(Math.floor(Date.now() / 1000) + 15 * 60);
  const q = new URLSearchParams({ shop, company: companyId, fy, ...(site ? { site } : {}), exp });
  q.set("sig", sign(secret, [shop, companyId, fy, site ?? "", exp]));
  return `${appUrl}/customer/budgets/export?${q}`;
}

export function verifyExport(secret: string, q: URLSearchParams): boolean {
  const exp = Number(q.get("exp"));
  if (!exp || exp * 1000 < Date.now()) return false;
  const want = Buffer.from(sign(secret, [q.get("shop") ?? "", q.get("company") ?? "", q.get("fy") ?? "", q.get("site") ?? "", String(exp)]));
  const got = Buffer.from(q.get("sig") ?? "");
  return want.length === got.length && timingSafeEqual(want, got);
}

export async function exportCsv(shop: string, companyId: string, fyKey: string, site: string | null): Promise<{ filename: string; csv: string }> {
  const fy = parseFinancialYear(fyKey) ?? financialYearOf(sydneyMonth(new Date()));
  const from = sydneyMonthRange(fy.months[0]!).start;
  const to = sydneyMonthRange(fy.months[11]!).end;
  const orders = await prisma.tradeOrder.findMany({
    where: { shop, companyId, createdAt: { gte: from, lt: to }, ...(site ? { locationId: site } : {}) },
    orderBy: { createdAt: "asc" },
  });
  const cell = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["Date", "Site", "Unleashed order", "Shopify reference", "PO number", "Ordered by", "Goods ex GST", "Status", "Approved/declined by", "Products"];
  const lines = orders.map((o) => {
    const lines = (o.lines as { sku: string; title?: string; quantity: number }[]).map((l) => `${l.quantity} x ${l.title || l.sku} (${l.sku})`).join("; ");
    return [
      o.createdAt.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney" }),
      o.siteName,
      o.unleashedOrderNumber ?? "",
      o.draftOrderName ?? "",
      o.poNumber,
      o.buyerName,
      Number(o.goodsExGst.toString()).toFixed(2),
      STATUS_LABEL[o.status] ?? o.status,
      o.decidedAt ? o.approverName ?? "" : "",
      lines,
    ].map(cell).join(",");
  });
  const company = orders[0]?.companyName?.replace(/[^A-Za-z0-9]+/g, "-") || "orders";
  return { filename: `${company}-${fy.key}${site ? "-site" : ""}.csv`, csv: "﻿" + [header.join(","), ...lines].join("\r\n") };
}
