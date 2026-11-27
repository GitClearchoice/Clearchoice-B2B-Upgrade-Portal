// Closed / dormant delivery sites (see src/b2b/siteStatus.ts). Applies closures to Shopify (location
// metafield b2b.closed, read by the storefront and buyer checks) and the app DB (SiteStatus).
import prisma from "./db.server";
import { unauthenticated } from "./shopify.server";
import { COMMITTED } from "./budget.server";
import { emailer, graphqlFor } from "./orders.server";
import { UnleashedClient } from "../src/unleashed/client.ts";
import { lastOrdersFromUnleashed, planSiteChanges, DORMANT_MONTHS, type CloseSource, type PortalSite, type SiteState } from "../src/b2b/siteStatus.ts";
import { siteClosedEmail } from "../src/email/templates.ts";
import { applyCompany, loadPaymentTermsTemplates, planCompany, planGroup, type CompanyPlan } from "../src/b2b/import.ts";
import { PostcodeLookup } from "../src/b2b/address.ts";
import type { UAddress, UCustomer } from "../src/unleashed/types.ts";
import type { ShopifyGraphql } from "../src/orders/placeOrder.ts";

const COMPANY_IDS = `#graphql
  query SiteSyncCompanies($after: String) {
    companies(first: 250, after: $after) {
      nodes { id code: metafield(namespace: "unleashed", key: "customer_code") { value } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const COMPANY_SITES = `#graphql
  query SiteSyncLocations($id: ID!, $after: String) {
    company(id: $id) {
      locations(first: 250, after: $after) {
        nodes {
          id
          name
          externalId
          code: metafield(namespace: "unleashed", key: "customer_code") { value }
          closed: metafield(namespace: "b2b", key: "closed") { value }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

const SET_CLOSED = `#graphql
  mutation SiteClosed($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) { userErrors { field message } }
  }`;

type Loc = { id: string; name: string; externalId: string | null; code: { value: string } | null; closed: { value: string } | null };

export async function shopifySites(shopify: ShopifyGraphql, onlyCompany?: string): Promise<(PortalSite & { closedInShopify: boolean })[]> {
  const companies: { id: string; code: string | null }[] = [];
  if (onlyCompany) companies.push({ id: onlyCompany, code: null });
  else {
    let after: string | null = null;
    for (let i = 0; i < 20; i++) {
      const d: { companies: { nodes: { id: string; code: { value: string } | null }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } = await shopify(COMPANY_IDS, { after });
      companies.push(...d.companies.nodes.map((c) => ({ id: c.id, code: c.code?.value?.trim() || null })));
      if (!d.companies.pageInfo.hasNextPage) break;
      after = d.companies.pageInfo.endCursor;
    }
  }
  const out: (PortalSite & { closedInShopify: boolean })[] = [];
  for (const c of companies) {
    let after: string | null = null;
    for (let i = 0; i < 20; i++) {
      const d: { company: { locations: { nodes: Loc[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } | null } = await shopify(COMPANY_SITES, { id: c.id, after });
      if (!d.company) break;
      for (const l of d.company.locations.nodes) {
        out.push({
          locationId: l.id,
          companyId: c.id,
          name: l.name,
          externalId: l.externalId,
          customerCode: l.code?.value?.trim() || c.code,
          closedInShopify: l.closed?.value === "true",
        });
      }
      if (!d.company.locations.pageInfo.hasNextPage) break;
      after = d.company.locations.pageInfo.endCursor;
    }
  }
  return out;
}

/** Switches a site off (or back on) in Shopify and the app DB. */
export async function setSiteClosed(
  shopify: ShopifyGraphql,
  shop: string,
  site: { locationId: string; companyId: string; name: string },
  closed: boolean,
  info: { source: CloseSource; reason?: string | null; by?: string | null },
) {
  const r = await shopify<{ metafieldsSet: { userErrors: { message: string }[] } }>(SET_CLOSED, {
    metafields: [{ ownerId: site.locationId, namespace: "b2b", key: "closed", type: "boolean", value: closed ? "true" : "false" }],
  });
  if (r.metafieldsSet.userErrors.length) throw new Error(r.metafieldsSet.userErrors.map((e) => e.message).join("; "));
  const data = closed
    ? { closed: true, source: info.source, reason: info.reason ?? null, closedAt: new Date(), closedBy: info.by ?? null }
    : { closed: false, source: null, reason: info.reason ?? null, closedAt: null, closedBy: info.by ?? null };
  await prisma.siteStatus.upsert({
    where: { shop_locationId: { shop, locationId: site.locationId } },
    create: { shop, companyId: site.companyId, locationId: site.locationId, siteName: site.name, ...data },
    update: { siteName: site.name, ...data },
  });
}

/** A head-office admin closed a site from the portal: switch it off now and email Clearchoice staff. */
export async function closeSiteForCustomer(
  shopify: ShopifyGraphql,
  shop: string,
  p: { site: { locationId: string; companyId: string; name: string; customerCode: string | null }; companyName: string; closedBy: string; reason?: string | null },
) {
  await setSiteClosed(shopify, shop, p.site, true, { source: "customer", reason: p.reason, by: p.closedBy });
  const staff = process.env.STAFF_EMAIL;
  if (staff) {
    const e = siteClosedEmail({ companyName: p.companyName, siteName: p.site.name, customerCode: p.site.customerCode, closedBy: p.closedBy, reason: p.reason });
    try {
      await emailer().send({ to: staff, subject: e.subject, html: e.html, text: e.text, tag: "site-closed" });
    } catch (err) {
      console.error(`[sites] staff email failed: ${(err as Error).message}`);
    }
  }
}

function unleashed() {
  const apiId = process.env.UNLEASHED_API_ID;
  const apiKey = process.env.UNLEASHED_API_KEY;
  if (!apiId || !apiKey) throw new Error("UNLEASHED_API_ID / UNLEASHED_API_KEY are not set");
  return new UnleashedClient({ apiId, apiKey, baseUrl: process.env.UNLEASHED_BASE_URL, clientType: process.env.UNLEASHED_CLIENT_TYPE });
}

export interface SiteSyncResult {
  sites: number;
  /** Sites added or updated from Unleashed (names, addresses, delivery notes, new Delivery tab entries). */
  changes: string[];
  closed: string[];
  reopened: string[];
  errors: string[];
}

const TRADE_COMPANIES = `#graphql
  query SiteRefreshCompanies($after: String) {
    companies(first: 250, after: $after) {
      nodes {
        id
        name
        externalId
        code: metafield(namespace: "unleashed", key: "customer_code") { value }
        members: metafield(namespace: "unleashed", key: "group_members") { value }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;

/**
 * Brings existing trade companies' sites into line with Unleashed: fixes names, addresses and delivery
 * notes, and adds new Delivery tab sites (given to the company's head-office admin). Doesn't create
 * companies or change contacts. Same rules as the phase 2 import (src/b2b/import.ts).
 */
export async function refreshSitesFromUnleashed(
  shopify: ShopifyGraphql,
  u: { customers: UCustomer[]; delivery: { CustomerCode: string; Addresses?: UAddress[] | null }[] },
): Promise<{ changes: string[]; errors: string[] }> {
  const byCode = new Map(u.customers.map((c) => [c.CustomerCode, c]));
  const sitesByCode = new Map(u.delivery.map((d) => [d.CustomerCode, d.Addresses ?? []]));
  const lookup = new PostcodeLookup().learn(u.customers.flatMap((c) => c.Addresses ?? [])).learn(u.delivery.flatMap((d) => d.Addresses ?? []));
  const netDays = Number(process.env.DEFAULT_NET_DAYS ?? 30);
  const admin = { graphql: <T,>(q: string, v: Record<string, unknown> = {}) => shopify<T>(q, v) };
  const templates = await loadPaymentTermsTemplates(admin as never);

  const companies: { id: string; name: string; externalId: string | null; code: string | null; members: string | null }[] = [];
  let after: string | null = null;
  for (let i = 0; i < 20; i++) {
    const d: { companies: { nodes: { id: string; name: string; externalId: string | null; code: { value: string } | null; members: { value: string } | null }[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } =
      await shopify(TRADE_COMPANIES, { after });
    companies.push(...d.companies.nodes.map((c) => ({ id: c.id, name: c.name, externalId: c.externalId, code: c.code?.value?.trim() || null, members: c.members?.value ?? null })));
    if (!d.companies.pageInfo.hasNextPage) break;
    after = d.companies.pageInfo.endCursor;
  }

  const changes: string[] = [];
  const errors: string[] = [];
  for (const c of companies) {
    let plan: CompanyPlan | null = null;
    if (c.externalId?.startsWith("GROUP:")) {
      const members = (c.members ?? "").split(";").map((m) => m.trim()).filter(Boolean)
        .map((code) => byCode.get(code))
        .filter((cust): cust is UCustomer => !!cust && !cust.Obsolete)
        .map((cust) => ({ code: cust.CustomerCode, name: (cust.CustomerName ?? cust.CustomerCode).trim(), plan: planCompany(cust, sitesByCode.get(cust.CustomerCode), netDays, lookup) }));
      if (members.length) plan = planGroup(c.externalId.slice("GROUP:".length), members);
    } else if (c.code) {
      const cust = byCode.get(c.code);
      if (cust && !cust.Obsolete) plan = planCompany(cust, sitesByCode.get(c.code), netDays, lookup);
    }
    if (!plan || !plan.sites.length) continue;
    const r = await applyCompany({ admin: admin as never, dryRun: false, templates, companyMap: { [plan.code]: c.id }, updateExisting: true, sitesOnly: true }, plan);
    changes.push(...r.changes.map((x) => `${c.name}: ${x}`));
    if (r.status === "error") errors.push(`${c.name}: ${r.notes[r.notes.length - 1]}`);
  }
  return { changes, errors };
}

/**
 * Daily: switch off sites Unleashed says are obsolete/removed (and back on when reactivated), and
 * record each site's last order date (Unleashed sales orders for the last 6+ months, plus portal orders).
 */
export async function syncSites(shopify: ShopifyGraphql, shop: string, log = (m: string) => console.log(`[sites] ${m}`)): Promise<SiteSyncResult> {
  const client = unleashed();
  const [customers, delivery] = await Promise.all([client.customers({ includeObsolete: true }), client.customerDeliveryAddresses()]);
  // 1. Site details and new sites from Unleashed, then 2. closures (on the refreshed list).
  const refreshed = await refreshSitesFromUnleashed(shopify, { customers, delivery });
  const sites = await shopifySites(shopify);
  const u = {
    customers: new Map(customers.map((c) => [c.CustomerCode, c])),
    delivery: new Map(delivery.map((d) => [d.CustomerCode, d.Addresses ?? []])),
  };
  const statuses = await prisma.siteStatus.findMany({ where: { shop } });
  const state = new Map<string, SiteState>(statuses.map((s) => [s.locationId, { closed: s.closed, source: s.source as CloseSource | null }]));
  // Closed in Shopify but not in the DB (e.g. set by hand): treat as closed by staff.
  for (const s of sites) if (s.closedInShopify && !state.get(s.locationId)?.closed) state.set(s.locationId, { closed: true, source: "staff" });

  const res: SiteSyncResult = { sites: sites.length, changes: refreshed.changes, closed: [], reopened: [], errors: [...refreshed.errors] };
  for (const c of planSiteChanges(sites, state, u)) {
    try {
      await setSiteClosed(shopify, shop, c.site, c.action === "close", { source: "unleashed", reason: c.reason, by: "Unleashed sync" });
      (c.action === "close" ? res.closed : res.reopened).push(`${c.site.name} (${c.reason})`);
    } catch (e) {
      res.errors.push(`${c.site.name}: ${(e as Error).message}`);
    }
  }

  // Last order per site: Unleashed sales orders since a bit over 6 months ago, plus portal orders.
  const since = new Date();
  since.setMonth(since.getMonth() - DORMANT_MONTHS - 1);
  const orders = [];
  for await (const o of client.salesOrders({ startDate: since.toISOString().slice(0, 10) })) orders.push(o);
  const last = lastOrdersFromUnleashed(sites, orders);
  const portal = await prisma.tradeOrder.groupBy({ by: ["locationId"], where: { shop, status: { in: COMMITTED } }, _max: { createdAt: true } });
  for (const p of portal) {
    const d = p._max.createdAt;
    if (d && (!last.get(p.locationId) || d > last.get(p.locationId)!)) last.set(p.locationId, d);
  }
  for (const s of sites) {
    const lastOrderAt = last.get(s.locationId) ?? null;
    await prisma.siteStatus.upsert({
      where: { shop_locationId: { shop, locationId: s.locationId } },
      create: { shop, companyId: s.companyId, locationId: s.locationId, siteName: s.name, lastOrderAt },
      update: { siteName: s.name, ...(lastOrderAt ? { lastOrderAt } : {}) },
    });
  }
  log(`${shop}: ${sites.length} sites, ${res.changes.length} added/updated, ${res.closed.length} closed, ${res.reopened.length} reopened, ${orders.length} Unleashed orders read${res.errors.length ? `, ${res.errors.length} errors` : ""}`);
  return res;
}

// Daily in the web process (first run 15 minutes after start, then every 24 hours).
declare global {
  // eslint-disable-next-line no-var
  var siteSyncTimer: ReturnType<typeof setInterval> | undefined;
}
export function startSiteSyncLoop() {
  if (globalThis.siteSyncTimer || process.env.SITE_SYNC_DISABLED === "1") return;
  const run = async () => {
    try {
      const shops = await prisma.session.findMany({ where: { isOnline: false }, distinct: ["shop"], select: { shop: true } });
      for (const { shop } of shops) {
        const { admin } = await unauthenticated.admin(shop);
        await syncSites(graphqlFor(admin), shop);
      }
    } catch (e) {
      console.error(`[sites] daily sync failed: ${(e as Error).message}`);
    }
  };
  setTimeout(run, 15 * 60_000);
  globalThis.siteSyncTimer = setInterval(run, 24 * 60 * 60_000);
}
