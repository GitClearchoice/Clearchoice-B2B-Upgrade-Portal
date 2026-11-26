import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { priceLines, priceStore } from "../pricing.server";
import { BUYER_QUERY, BuyerError, buyerContext, parseLinesParam, type BuyerQueryData } from "../../src/b2b/buyer.ts";
import { PricingError } from "../../src/pricing/engine.ts";

// GET https://<shop>/apps/b2b/prices?lines=SKU:QTY,SKU:QTY&location=<site id>
// Shopify signs app proxy requests and adds logged_in_customer_id; prices are always worked out here.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");
  if (!customerId) return json({ trade: false, error: "Not logged in" }, 401);
  if (!admin) return json({ error: "App not installed" }, 503);

  try {
    const lines = parseLinesParam(url.searchParams.get("lines"));
    const res = await admin.graphql(BUYER_QUERY, { variables: { id: `gid://shopify/Customer/${customerId}` } });
    const { data } = (await res.json()) as { data: BuyerQueryData };
    const buyer = buyerContext(data, url.searchParams.get("location"));
    if (!buyer) return json({ trade: false });

    const priced = await priceLines(priceStore, buyer.site.customerCode, lines);
    return json({
      trade: true,
      company: buyer.companyName,
      site: { id: buyer.site.id, name: buyer.site.name },
      sites: buyer.sites.map((s) => ({ id: s.id, name: s.name })),
      lines: priced.lines.map((l) => ({
        sku: l.productCode,
        quantity: l.quantity,
        unitExGst: l.unitExGst,
        unitIncGst: l.unitIncGst,
        lineExGst: l.lineExGst,
      })),
      goodsExGst: priced.goodsExGst,
      errors: priced.errors,
    });
  } catch (e) {
    if (e instanceof BuyerError || e instanceof PricingError) return json({ error: e.message }, 400);
    throw e;
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}
