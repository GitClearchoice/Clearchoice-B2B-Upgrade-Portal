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

/** Adds the cross-site headers the customer account extensions need (also to error replies). */
export function withCors(request: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  if (request.headers.get("Origin")) {
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Runs a customer-account backend handler so that every reply, including a rejected session token or
 * a server error, reaches the extension readably (with CORS headers) and errors are logged.
 */
export async function handleCustomer(request: Request, what: string, fn: () => Promise<Response>): Promise<Response> {
  if (request.method === "OPTIONS") return withCors(request, new Response(null, { status: 204 }));
  try {
    return withCors(request, await fn());
  } catch (e) {
    if (e instanceof Response) {
      console.error(`[${what}] ${request.method} rejected: ${e.status} ${e.statusText}`);
      const msg = e.status === 401 ? "Your session has expired. Please reload the page." : `Request failed (${e.status}).`;
      return withCors(request, json({ error: msg }, e.status));
    }
    console.error(`[${what}] ${request.method} failed: ${(e as Error).stack}`);
    return withCors(request, json({ error: `Sorry, something went wrong: ${(e as Error).message}` }, 500));
  }
}
