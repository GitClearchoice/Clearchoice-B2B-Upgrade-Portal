import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { budgetRepo } from "../budget.server";
import { BUYER_QUERY, BuyerError, buyerContext, type BuyerQueryData } from "../../src/b2b/buyer.ts";
import { budgetStatus, monthLabel } from "../../src/orders/budget.ts";

// GET https://<shop>/apps/b2b/budget?location=<site id>
// The buyer's site budget for this month (Sydney): { budget, committed, awaitingApproval, remaining }.
// budget = null means the site has no budget (no limit).
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.public.appProxy(request);
  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");
  if (!customerId) return json({ error: "Not logged in" }, 401);
  if (!admin || !session) return json({ error: "App not installed" }, 503);
  try {
    const res = await admin.graphql(BUYER_QUERY, { variables: { id: `gid://shopify/Customer/${customerId}` } });
    const { data } = (await res.json()) as { data: BuyerQueryData };
    const buyer = buyerContext(data, url.searchParams.get("location"));
    if (!buyer) return json({ trade: false });
    const s = await budgetStatus(budgetRepo, session.shop, buyer.site.id, new Date());
    return json({ trade: true, site: buyer.site.name, monthLabel: monthLabel(s.month), ...s });
  } catch (e) {
    if (e instanceof BuyerError) return json({ error: e.message }, 400);
    throw e;
  }
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}
