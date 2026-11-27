import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { graphqlFor, orderDeps } from "../orders.server";
import { closeSiteForCustomer } from "../sites.server";
import { BUYER_QUERY, BuyerError, buyerContext, type BuyerQueryData } from "../../src/b2b/buyer.ts";
import { findApprover } from "../../src/orders/placeOrder.ts";

// POST https://<shop>/apps/b2b/sites/close  (JSON) { location, reason? }
// The company's head-office admin closes a delivery site they no longer use: it's switched off at once
// and Clearchoice staff are emailed to obsolete it in Unleashed. (Used by the phase 5 budgets page.)
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const { admin, session } = await authenticate.public.appProxy(request);
  const customerId = new URL(request.url).searchParams.get("logged_in_customer_id");
  if (!customerId) return json({ error: "Please log in" }, 401);
  if (!admin || !session) return json({ error: "App not installed" }, 503);
  if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "Expected JSON" }, 415);
  let body: { location?: string; reason?: string };
  try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }

  const shopify = graphqlFor(admin);
  try {
    const data = await shopify<BuyerQueryData>(BUYER_QUERY, { id: `gid://shopify/Customer/${customerId}` });
    const buyer = buyerContext(data, String(body.location ?? ""));
    if (!buyer) return json({ error: "Your account isn't set up for trade ordering" }, 403);
    // Only the company's head-office admin (the budget approver) can close sites.
    const approver = await findApprover(orderDeps(shopify), buyer.companyId);
    if (!approver || approver.isStaff || !buyer.email || approver.email.toLowerCase() !== buyer.email.toLowerCase()) {
      return json({ error: "Only your head-office admin can close a site. Please ask them, or contact Clearchoice." }, 403);
    }
    await closeSiteForCustomer(shopify, session.shop, {
      site: { locationId: buyer.site.id, companyId: buyer.companyId, name: buyer.site.name, customerCode: buyer.site.customerCode },
      companyName: buyer.companyName,
      closedBy: `${buyer.name} <${buyer.email}>`,
      reason: body.reason ? String(body.reason).slice(0, 500) : null,
    });
    return json({ ok: true, site: buyer.site.name });
  } catch (e) {
    if (e instanceof BuyerError) return json({ error: e.message }, 400);
    console.error(`[sites] close failed: ${(e as Error).stack}`);
    return json({ error: "Sorry, the site couldn't be closed. Please contact Clearchoice." }, 500);
  }
};

export const loader = () => json({ error: "POST only" }, 405);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
}
