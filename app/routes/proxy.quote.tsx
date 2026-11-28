import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { graphqlFor } from "../orders.server";
import { priceStore } from "../pricing.server";
import { quotePdf } from "../quote-pdf.server";
import { BUYER_QUERY, BuyerError, buyerContext, type BuyerQueryData } from "../../src/b2b/buyer.ts";
import { OrderError } from "../../src/orders/placeOrder.ts";
import { PricingError } from "../../src/pricing/engine.ts";
import { buildQuote, quoteCsv } from "../../src/orders/quote.ts";

// POST https://<shop>/apps/b2b/quote  (JSON) { location, format: "pdf" | "csv", lines: [{ variantId, quantity }] }
// The cart's "Download quote": priced on the server for the buyer's site, valid 30 days.
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const { admin } = await authenticate.public.appProxy(request);
  const customerId = new URL(request.url).searchParams.get("logged_in_customer_id");
  if (!customerId) return json({ error: "Please log in" }, 401);
  if (!admin) return json({ error: "App not installed" }, 503);
  if (!request.headers.get("content-type")?.includes("application/json")) return json({ error: "Expected JSON" }, 415);
  let body: { location?: string; format?: string; lines?: { variantId: string; quantity: number }[] };
  try { body = await request.json(); } catch { return json({ error: "Bad request" }, 400); }

  const shopify = graphqlFor(admin);
  try {
    const data = await shopify<BuyerQueryData>(BUYER_QUERY, { id: `gid://shopify/Customer/${customerId}` });
    const buyer = buyerContext(data, body.location ?? null);
    if (!buyer) return json({ error: "Your account isn't set up for trade ordering" }, 403);
    const quote = await buildQuote(
      { shopify, store: priceStore },
      buyer,
      Array.isArray(body.lines) ? body.lines.map((l) => ({ variantId: String(l.variantId), quantity: Number(l.quantity) })) : [],
    );
    if (body.format === "csv") {
      return new Response(quoteCsv(quote), {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="Clearchoice-quote-${quote.number}.csv"`, "Cache-Control": "private, no-store" },
      });
    }
    const pdf = await quotePdf(quote);
    return new Response(new Uint8Array(pdf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="Clearchoice-quote-${quote.number}.pdf"`, "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    if (e instanceof OrderError || e instanceof BuyerError || e instanceof PricingError) return json({ error: e.message }, 400);
    console.error(`[quote] ${(e as Error).stack}`);
    return json({ error: "Sorry, the quote couldn't be made. Please try again." }, 500);
  }
};

export const loader = () => json({ error: "POST only" }, 405);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
}
