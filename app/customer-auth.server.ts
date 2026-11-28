// Shared by the customer account extensions' backend routes (/customer/...): checks the customer
// account session token, loads the buyer, and says whether they're the company's head-office admin.
import { authenticate, unauthenticated } from "./shopify.server";
import { graphqlFor, orderDeps } from "./orders.server";
import { BUYER_QUERY, BuyerError, buyerContext, type BuyerContext, type BuyerQueryData } from "../src/b2b/buyer.ts";
import { findApprover, type ShopifyGraphql } from "../src/orders/placeOrder.ts";

export interface CustomerContext {
  cors: (r: Response) => Response;
  shop: string;
  shopify: ShopifyGraphql;
  buyer: BuyerContext | null;
  isAdmin: boolean;
}

export async function customerContext(request: Request): Promise<CustomerContext> {
  const { sessionToken, cors } = await authenticate.public.customerAccount(request);
  const dest = String(sessionToken.dest ?? "");
  const shop = dest.startsWith("http") ? new URL(dest).hostname : dest;
  const sub = String(sessionToken.sub ?? "");
  const { admin } = await unauthenticated.admin(shop);
  const shopify = graphqlFor(admin);
  const data = await shopify<BuyerQueryData>(BUYER_QUERY, { id: sub.startsWith("gid://") ? sub : `gid://shopify/Customer/${sub}` });
  let buyer: BuyerContext | null = null;
  try {
    buyer = buyerContext(data);
  } catch (e) {
    if (!(e instanceof BuyerError)) throw e;
  }
  let isAdmin = false;
  if (buyer) {
    const approver = await findApprover(orderDeps(shopify), buyer.companyId);
    isAdmin = !!approver && !approver.isStaff && !!buyer.email && approver.email.toLowerCase() === buyer.email.toLowerCase();
  }
  return { cors: cors as (r: Response) => Response, shop, shopify, buyer, isAdmin };
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" } });
}
