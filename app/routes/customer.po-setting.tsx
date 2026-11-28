import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate, unauthenticated } from "../shopify.server";
import { graphqlFor, orderDeps } from "../orders.server";
import { setPoNotRequired } from "../po-setting.server";
import { BUYER_QUERY, BuyerError, buyerContext, type BuyerQueryData } from "../../src/b2b/buyer.ts";
import { findApprover } from "../../src/orders/placeOrder.ts";

// Backend for the customer account extension "Purchase orders" (Profile → company → Payment details).
// GET:  { trade, companyName, notRequired, isAdmin }
// POST: { notRequired: boolean }  (head-office admin only) — same setting as the cart tick box.
// Authenticated with the customer account session token (sub = the customer, dest = the shop).

async function context(request: Request) {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);
  const dest = String(sessionToken.dest ?? "");
  const shop = dest.startsWith("http") ? new URL(dest).hostname : dest;
  const customerId = String(sessionToken.sub ?? "");
  const { admin } = await unauthenticated.admin(shop);
  const shopify = graphqlFor(admin);
  const data = await shopify<BuyerQueryData & { customer: { companyContactProfiles: { company: { noPo?: { value: string } | null } }[] } | null }>(BUYER_QUERY, {
    id: customerId.startsWith("gid://") ? customerId : `gid://shopify/Customer/${customerId}`,
  });
  return { cors, shopify, data };
}

async function isAdminOf(shopify: ReturnType<typeof graphqlFor>, companyId: string, email: string | null) {
  const approver = await findApprover(orderDeps(shopify), companyId);
  return !!approver && !approver.isStaff && !!email && approver.email.toLowerCase() === email.toLowerCase();
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors, shopify, data } = await context(request);
  try {
    const buyer = buyerContext(data);
    if (!buyer) return cors(json({ trade: false }));
    return cors(json({ trade: true, companyName: buyer.companyName, notRequired: buyer.poNotRequired, isAdmin: await isAdminOf(shopify, buyer.companyId, buyer.email) }));
  } catch (e) {
    if (e instanceof BuyerError) return cors(json({ trade: false }));
    throw e;
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, shopify, data } = await context(request);
  let body: { notRequired?: boolean };
  try { body = await request.json(); } catch { return cors(json({ error: "Bad request" }, 400)); }
  try {
    const buyer = buyerContext(data);
    if (!buyer) return cors(json({ error: "Your account isn't set up for trade ordering" }, 403));
    if (!(await isAdminOf(shopify, buyer.companyId, buyer.email))) {
      return cors(json({ error: "Only your head-office admin can change this setting." }, 403));
    }
    const notRequired = body.notRequired === true;
    await setPoNotRequired(shopify, buyer.companyId, notRequired, `${buyer.name}${buyer.email ? ` <${buyer.email}>` : ""} (account profile)`);
    return cors(json({ ok: true, notRequired }));
  } catch (e) {
    if (e instanceof BuyerError) return cors(json({ error: e.message }, 400));
    console.error(`[po-setting] ${(e as Error).stack}`);
    return cors(json({ error: "Sorry, the setting couldn't be saved." }, 500));
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
}
