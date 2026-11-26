import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { graphqlFor, orderDeps } from "../orders.server";
import { BUYER_QUERY, BuyerError, buyerContext, type BuyerQueryData } from "../../src/b2b/buyer.ts";
import { OrderError, placeTradeOrder } from "../../src/orders/placeOrder.ts";
import { PricingError } from "../../src/pricing/engine.ts";

// POST https://<shop>/apps/b2b/orders  (JSON)
// { requestKey, location, poNumber, note, lines: [{ variantId, quantity }] }
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const { admin, session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");
  if (!customerId) return json({ error: "Please log in to place an order" }, 401);
  if (!admin || !session) return json({ error: "App not installed" }, 503);
  // JSON only: a cross-site form can't send it, so a buyer can't be tricked into ordering.
  if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "Expected JSON" }, 415);

  let body: { requestKey?: string; location?: string; poNumber?: string; note?: string; lines?: { variantId: string; quantity: number }[] };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request" }, 400);
  }
  const requestKey = String(body.requestKey ?? "").trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(requestKey)) return json({ error: "Bad request key" }, 400);

  const shopify = graphqlFor(admin);
  try {
    const data = await shopify<BuyerQueryData>(BUYER_QUERY, { id: `gid://shopify/Customer/${customerId}` });
    const buyer = buyerContext(data, body.location ?? null);
    if (!buyer) return json({ error: "Your account isn't set up for trade ordering" }, 403);

    const result = await placeTradeOrder(orderDeps(shopify), {
      shop: session.shop,
      requestKey,
      buyer,
      poNumber: String(body.poNumber ?? ""),
      note: body.note ? String(body.note) : undefined,
      lines: Array.isArray(body.lines) ? body.lines.map((l) => ({ variantId: String(l.variantId), quantity: Number(l.quantity) })) : [],
    });
    // "sent" or "failed" (queued for retry): either way the buyer's order is received.
    return json({
      ok: true,
      orderId: result.orderId,
      reference: result.draftOrderName,
      unleashedOrderNumber: result.unleashedOrderNumber,
      goodsExGst: result.goodsExGst,
      site: buyer.site.name,
    });
  } catch (e) {
    if (e instanceof OrderError || e instanceof BuyerError || e instanceof PricingError) return json({ error: e.message }, 400);
    console.error(`[orders] place order failed: ${(e as Error).stack}`);
    return json({ error: "Sorry, your order couldn't be placed. Please try again or contact Clearchoice." }, 500);
  }
};

export const loader = () => json({ error: "POST only" }, 405);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}
