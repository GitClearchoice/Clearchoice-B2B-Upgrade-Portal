// "Request a new site" (head-office admin). Unleashed stays the master list of sites: the request is
// emailed to Clearchoice staff to add to the customer's Delivery tab; when the site sync brings the new
// site into Shopify, the requested site code, budget and site managers are applied here.
import prisma from "./db.server";
import { emailer } from "./orders.server";
import { openSites, saveSiteBudgets } from "./customer-budgets.server";
import { setSiteCode } from "./site-codes.server";
import { contactNames, grantSiteAccess } from "./team.server";
import { siteReadyEmail, siteRequestEmail } from "../src/email/templates.ts";
import type { BuyerContext } from "../src/b2b/buyer.ts";
import type { ShopifyGraphql } from "../src/orders/placeOrder.ts";
import { matchesRequest } from "../src/b2b/siteStatus.ts";

const STATES = ["NSW", "VIC", "QLD", "SA", "WA", "TAS", "ACT", "NT"];

export interface SiteRequestInput {
  siteName?: string;
  address1?: string;
  address2?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  siteCode?: string;
  contactName?: string;
  contactPhone?: string;
  deliveryNotes?: string;
  monthlyBudget?: string | number | null;
  managerIds?: string[];
}

const clean = (v: unknown, max = 200) => String(v ?? "").trim().slice(0, max);

export async function createSiteRequest(shop: string, shopify: ShopifyGraphql, buyer: BuyerContext, f: SiteRequestInput) {
  const siteName = clean(f.siteName, 100);
  const address1 = clean(f.address1);
  const suburb = clean(f.suburb, 100);
  const state = clean(f.state, 3).toUpperCase();
  const postcode = clean(f.postcode, 4);
  if (!siteName) throw new Error("Enter the site name");
  if (!address1 || !suburb) throw new Error("Enter the street address and suburb");
  if (!STATES.includes(state)) throw new Error("Choose the state");
  if (!/^\d{4}$/.test(postcode)) throw new Error("Enter a 4-digit postcode");
  const budgetRaw = String(f.monthlyBudget ?? "").replace(/[$,\s]/g, "");
  const monthlyBudget = budgetRaw ? Number(budgetRaw) : null;
  if (monthlyBudget != null && (!Number.isFinite(monthlyBudget) || monthlyBudget < 0)) throw new Error("The monthly budget must be an amount");
  const existing = await openSites(shop, shopify, buyer.companyId);
  if (existing.some((s) => matchesRequest(s.name, siteName))) throw new Error(`You already have a site called "${siteName}"`);
  const managerIds = Array.isArray(f.managerIds) ? f.managerIds.map(String).slice(0, 100) : [];

  const req = await prisma.siteRequest.create({
    data: {
      shop,
      companyId: buyer.companyId,
      companyName: buyer.companyName,
      customerCode: buyer.site.customerCode,
      requestedBy: buyer.name,
      requestedEmail: buyer.email,
      siteName,
      address1,
      address2: clean(f.address2) || null,
      suburb,
      state,
      postcode,
      siteCode: clean(f.siteCode, 100) || null,
      contactName: clean(f.contactName, 100) || null,
      contactPhone: clean(f.contactPhone, 40) || null,
      deliveryNotes: clean(f.deliveryNotes, 500) || null,
      monthlyBudget,
      managerIds,
    },
  });

  const staff = process.env.STAFF_EMAIL;
  if (staff) {
    const e = siteRequestEmail({
      companyName: buyer.companyName,
      customerCode: buyer.site.customerCode,
      requestedBy: `${buyer.name}${buyer.email ? ` <${buyer.email}>` : ""}`,
      siteName,
      address: [address1, req.address2, `${suburb} ${state} ${postcode}`].filter((x): x is string => !!x),
      siteCode: req.siteCode,
      contactName: req.contactName,
      contactPhone: req.contactPhone,
      deliveryNotes: req.deliveryNotes,
      monthlyBudget,
      managers: await contactNames(shopify, buyer.companyId, managerIds),
    });
    await emailer()
      .send({ to: staff, subject: e.subject, html: e.html, text: e.text, tag: "site-request", replyTo: buyer.email ?? undefined })
      .catch((err) => console.error(`[site-request] staff email: ${err.message}`));
  }
  return req;
}

export async function pendingSiteRequests(shop: string, companyId: string) {
  const rows = await prisma.siteRequest.findMany({ where: { shop, companyId, status: "pending" }, orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({
    id: r.id,
    siteName: r.siteName,
    address: [r.address1, r.address2, `${r.suburb} ${r.state} ${r.postcode}`].filter(Boolean).join(", "),
    requestedBy: r.requestedBy,
    requested: r.createdAt.toISOString(),
  }));
}

export async function cancelSiteRequest(shop: string, companyId: string, id: string) {
  const r = await prisma.siteRequest.updateMany({ where: { id, shop, companyId, status: "pending" }, data: { status: "cancelled", completedAt: new Date() } });
  if (!r.count) throw new Error("That request couldn't be found (it may already be done)");
}

/** After the site sync: finish requests whose site has appeared. Returns what was done, for the log. */
export async function completeSiteRequests(shop: string, shopify: ShopifyGraphql): Promise<string[]> {
  const pending = await prisma.siteRequest.findMany({ where: { shop, status: "pending" } });
  const out: string[] = [];
  const byCompany = new Map<string, typeof pending>();
  for (const r of pending) byCompany.set(r.companyId, [...(byCompany.get(r.companyId) ?? []), r]);
  for (const [companyId, reqs] of byCompany) {
    const sites = await openSites(shop, shopify, companyId);
    for (const r of reqs) {
      const site = sites.find((s) => matchesRequest(s.name, r.siteName));
      if (!site) continue;
      const applied: string[] = [];
      try {
        if (r.siteCode) {
          await setSiteCode(shop, { companyId, locationId: site.locationId, name: site.name }, r.siteCode);
          applied.push(`Site code: ${r.siteCode}`);
        }
        if (r.monthlyBudget != null) {
          const amount = Number(r.monthlyBudget.toString());
          await saveSiteBudgets(shop, companyId, { id: site.locationId, name: site.name }, { default: amount }, `${r.requestedBy} (site request)`);
          applied.push(`Monthly budget: $${amount.toFixed(2)} ex GST`);
        }
        const ids = Array.isArray(r.managerIds) ? (r.managerIds as string[]) : [];
        const granted = await grantSiteAccess(shopify, companyId, ids, site.locationId);
        if (granted.length) applied.push(`Site managers: ${granted.join(", ")}`);
        await prisma.siteRequest.update({ where: { id: r.id }, data: { status: "done", locationId: site.locationId, completedAt: new Date() } });
        out.push(`${r.companyName}: ${site.name} set up (${applied.join("; ") || "nothing extra"})`);
        if (r.requestedEmail) {
          const e = siteReadyEmail({ name: r.requestedBy.split(" ")[0] || r.requestedBy, companyName: r.companyName, siteName: site.name, applied });
          await emailer()
            .send({ to: r.requestedEmail, subject: e.subject, html: e.html, text: e.text, tag: "site-ready" })
            .catch((err) => console.error(`[site-request] ready email: ${err.message}`));
        }
      } catch (e) {
        out.push(`${r.companyName}: ${site.name} found but not finished: ${(e as Error).message}`);
      }
    }
  }
  return out;
}
