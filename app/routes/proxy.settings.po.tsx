import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { graphqlFor, orderDeps } from "../orders.server";
import { findApprover } from "../../src/orders/placeOrder.ts";
import { setPoNotRequired } from "../po-setting.server";
import { BUYER_QUERY, BuyerError, buyerContext, type BuyerQueryData } from "../../src/b2b/buyer.ts";

// POST https://<shop>/apps/b2b/settings/po  (JSON) { notRequired: boolean }
// The cart's "We don't use purchase orders" tick box (head-office admin only): saved on the company, so
// it stays for every order (and every buyer of that company) until it's unticked.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const { admin } = await authenticate.public.appProxy(request);
  const customerId = new URL(request.url).searchParams.get("logged_in_customer_id");
  if (!customerId) return json({ error: "Please log in" }, 401);
  if (!admin) return json({ error: "App not installed" }, 503);
  if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "Expected JSON" }, 415);
  let body: { notRequired?: boolean };
  try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }
  const shopify = graphqlFor(admin);
  try {
    const data = await shopify<BuyerQueryData>(BUYER_QUERY, { id: `gid://shopify/Customer/${customerId}` });
    const buyer = buyerContext(data);
    if (!buyer) return json({ error: "Your account isn't set up for trade ordering" }, 403);
    // Only the company's head-office admin (the budget approver) can change it.
    const approver = await findApprover(orderDeps(shopify), buyer.companyId);
    if (!approver || approver.isStaff || !buyer.email || approver.email.toLowerCase() !== buyer.email.toLowerCase()) {
      return json({ error: "Only your head-office admin can change this setting." }, 403);
    }
    await setPoNotRequired(shopify, buyer.companyId, body.notRequired === true, `${buyer.name}${buyer.email ? ` <${buyer.email}>` : ""} (cart)`);
    return json({ ok: true, notRequired: body.notRequired === true });
  } catch (e) {
    if (e instanceof BuyerError) return json({ error: e.message }, 400);
    console.error(`[po-setting] ${(e as Error).stack}`);
    return json({ error: "Sorry, the setting couldn't be saved." }, 500);
  }
};

export const loader = () => json({ error: "POST only" }, 405);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
}
