import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { customerContext, handleCustomer, json } from "../customer-auth.server";
import { budgetsView, importBudgetsCsv, openSites, saveSiteBudgets } from "../customer-budgets.server";
import { closeSiteForCustomer } from "../sites.server";
import { setSiteCode } from "../site-codes.server";
import { cancelSiteRequest, createSiteRequest, pendingSiteRequests, type SiteRequestInput } from "../site-requests.server";

// Backend for the customer account page "Site budgets" (extension extensions/site-budgets).
// Head-office admin only. GET ?quarter=FY2027-Q2&fy=FY2027&site=<location id>
// POST { action: "save", site, values: { default|YYYY-MM: number|null } } | { action: "close", site, reason }

export const loader = ({ request }: LoaderFunctionArgs) => handleCustomer(request, "budgets", () => budgetsLoader(request));
export const action = ({ request }: ActionFunctionArgs) => handleCustomer(request, "budgets", () => budgetsAction(request));

async function budgetsLoader(request: Request) {
  const c = await customerContext(request);
  if (!c.buyer) return c.cors(json({ trade: false }));
  if (!c.isAdmin) return c.cors(json({ trade: true, isAdmin: false, company: c.buyer.companyName }));
  const url = new URL(request.url);
  const view = await budgetsView(c.shop, c.shopify, c.buyer.companyId, {
    quarter: url.searchParams.get("quarter"),
    fy: url.searchParams.get("fy"),
    site: url.searchParams.get("site"),
  });
  const siteRequests = await pendingSiteRequests(c.shop, c.buyer.companyId);
  return c.cors(json({ trade: true, isAdmin: true, company: c.buyer.companyName, ...view, siteRequests }));
}

async function budgetsAction(request: Request) {
  const c = await customerContext(request);
  if (!c.buyer || !c.isAdmin) return c.cors(json({ error: "Only your head-office admin can change site budgets." }, 403));
  let body: { action?: string; site?: string; values?: Record<string, number | null>; reason?: string; csv?: string; siteCode?: string | null; request?: SiteRequestInput; requestId?: string };
  try { body = await request.json(); } catch { return c.cors(json({ error: "Bad request" }, 400)); }
  if (body.action === "request-site" || body.action === "cancel-request") {
    try {
      if (body.action === "request-site") {
        const r = await createSiteRequest(c.shop, c.shopify, c.buyer, body.request ?? {});
        return c.cors(json({ ok: true, message: `Thanks. We've asked Clearchoice to add "${r.siteName}". You'll get an email when it's ready to order for.` }));
      }
      await cancelSiteRequest(c.shop, c.buyer.companyId, String(body.requestId ?? ""));
      return c.cors(json({ ok: true, message: "Request cancelled." }));
    } catch (e) {
      return c.cors(json({ error: (e as Error).message }, 400));
    }
  }
  if (body.action === "import") {
    const by = `${c.buyer.name}${c.buyer.email ? ` <${c.buyer.email}>` : ""} (customer account, CSV import)`;
    try {
      const r = await importBudgetsCsv(c.shop, c.shopify, c.buyer.companyId, String(body.csv ?? "").slice(0, 2_000_000), by);
      return c.cors(json({ ok: true, ...r }));
    } catch (e) {
      return c.cors(json({ error: (e as Error).message }, 400));
    }
  }
  const sites = await openSites(c.shop, c.shopify, c.buyer.companyId);
  const site = sites.find((s) => s.locationId === body.site);
  if (!site) return c.cors(json({ error: "That site couldn't be found (it may have been closed)." }, 404));
  const by = `${c.buyer.name}${c.buyer.email ? ` <${c.buyer.email}>` : ""} (customer account)`;
  try {
    if (body.action === "save") {
      const values: Record<string, number | null> = {};
      for (const [k, v] of Object.entries(body.values ?? {})) values[k] = v === null || v === undefined || (v as unknown) === "" ? null : Number(v);
      await saveSiteBudgets(c.shop, c.buyer.companyId, { id: site.locationId, name: site.name }, values, by);
      if (body.siteCode !== undefined) await setSiteCode(c.shop, { companyId: c.buyer.companyId, locationId: site.locationId, name: site.name }, body.siteCode);
      return c.cors(json({ ok: true }));
    }
    if (body.action === "close") {
      await closeSiteForCustomer(c.shopify, c.shop, {
        site: { locationId: site.locationId, companyId: c.buyer.companyId, name: site.name, customerCode: site.customerCode },
        companyName: c.buyer.companyName,
        closedBy: by,
        reason: body.reason ? String(body.reason).slice(0, 500) : null,
      });
      return c.cors(json({ ok: true }));
    }
    return c.cors(json({ error: "Unknown action" }, 400));
  } catch (e) {
    return c.cors(json({ error: (e as Error).message }, 400));
  }
}
