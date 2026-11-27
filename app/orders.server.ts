import type { Prisma, TradeOrder } from "@prisma/client";
import prisma from "./db.server";
import { unauthenticated } from "./shopify.server";
import { priceStore } from "./pricing.server";
import { UnleashedClient } from "../src/unleashed/client.ts";
import { LogSender, PostmarkSender, type EmailSender } from "../src/email/postmark.ts";
import { budgetRepo } from "./budget.server";
import {
  MAX_ATTEMPTS,
  retryFailedOrders,
  type OrderDeps,
  type OrderRepo,
  type ShopifyGraphql,
  type TradeOrderLine,
  type TradeOrderRecord,
  type TradeOrderStatus,
} from "../src/orders/placeOrder.ts";

const dec = (d: Prisma.Decimal | null) => (d == null ? null : Number(d.toString()));

const toRecord = (r: TradeOrder): TradeOrderRecord => ({
  ...r,
  goodsExGst: Number(r.goodsExGst.toString()),
  budgetExGst: dec(r.budgetExGst),
  committedBeforeExGst: dec(r.committedBeforeExGst),
  lines: r.lines as unknown as TradeOrderLine[],
  status: r.status as TradeOrderStatus,
});

const toData = (patch: Partial<TradeOrderRecord>) => {
  const { lines, payload, ...rest } = patch;
  return {
    ...rest,
    ...(lines !== undefined ? { lines: lines as unknown as Prisma.InputJsonValue } : {}),
    ...(payload !== undefined ? { payload: (payload ?? undefined) as Prisma.InputJsonValue | undefined } : {}),
  };
};

export const orderRepo: OrderRepo = {
  async get(id) {
    const r = await prisma.tradeOrder.findUnique({ where: { id } });
    return r ? toRecord(r) : null;
  },
  async findByRequestKey(shop, requestKey) {
    const r = await prisma.tradeOrder.findUnique({ where: { shop_requestKey: { shop, requestKey } } });
    return r ? toRecord(r) : null;
  },
  async create(rec) {
    await prisma.tradeOrder.create({ data: toData(rec) as Prisma.TradeOrderCreateInput });
  },
  async update(id, patch) {
    await prisma.tradeOrder.update({ where: { id }, data: toData(patch) });
  },
  async delete(id) {
    await prisma.tradeOrder.delete({ where: { id } });
  },
  async listForRetry(maxAttempts) {
    const stale = new Date(Date.now() - 5 * 60_000);
    const rows = await prisma.tradeOrder.findMany({
      where: {
        attempts: { lt: maxAttempts },
        OR: [{ status: "failed" }, { status: "pending", updatedAt: { lt: stale } }],
      },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    return rows.map(toRecord);
  },
};

let unleashed: UnleashedClient | null = null;
function unleashedClient() {
  if (!unleashed) {
    const apiId = process.env.UNLEASHED_API_ID;
    const apiKey = process.env.UNLEASHED_API_KEY;
    if (!apiId || !apiKey) throw new Error("UNLEASHED_API_ID / UNLEASHED_API_KEY are not set");
    unleashed = new UnleashedClient({ apiId, apiKey, baseUrl: process.env.UNLEASHED_BASE_URL, clientType: process.env.UNLEASHED_CLIENT_TYPE });
  }
  return unleashed;
}

/** Wraps the app's Admin GraphQL client: returns `data`, throws on GraphQL errors. */
export function graphqlFor(admin: { graphql: (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response> }): ShopifyGraphql {
  return async <T,>(query: string, variables?: Record<string, unknown>) => {
    const res = await admin.graphql(query, { variables });
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
    return body.data as T;
  };
}

let emailSender: EmailSender | null = null;
export function emailer(): EmailSender {
  if (!emailSender) {
    const token = process.env.POSTMARK_SERVER_TOKEN;
    emailSender = token
      ? new PostmarkSender({ serverToken: token, from: process.env.EMAIL_FROM ?? "Clearchoice Products <service@clearchoiceproducts.com>" })
      : new LogSender((m) => console.log(`[email] ${m}`));
  }
  return emailSender;
}

export function orderDeps(shopify: ShopifyGraphql): OrderDeps {
  const c = unleashedClient();
  return {
    shopify,
    budgets: budgetRepo,
    email: emailer(),
    notify: {
      appUrl: process.env.SHOPIFY_APP_URL ?? "",
      tokenSecret: process.env.SHOPIFY_API_SECRET ?? "",
      staffEmail: process.env.STAFF_EMAIL || null,
    },
    unleashed: { post: (p, b) => c.post(p, b), get: (p) => c.get(p), warehouses: () => c.warehouses(), taxes: () => c.taxes() },
    store: priceStore,
    orders: orderRepo,
    settings: {
      orderStatus: process.env.UNLEASHED_ORDER_STATUS ?? "Parked",
      warehouseName: process.env.UNLEASHED_WAREHOUSE ?? "Clearchoice Factory",
      taxCode: process.env.UNLEASHED_TAX_CODE ?? "OUTPUT",
    },
    log: (m) => console.log(`[orders] ${m}`),
  };
}

// Background retry for orders that didn't reach Unleashed: every 5 minutes, in the web process.
declare global {
  // eslint-disable-next-line no-var
  var tradeOrderRetryTimer: ReturnType<typeof setInterval> | undefined;
}
export function startOrderRetryLoop() {
  if (globalThis.tradeOrderRetryTimer || process.env.ORDER_RETRY_DISABLED === "1") return;
  globalThis.tradeOrderRetryTimer = setInterval(async () => {
    try {
      const shops = await prisma.tradeOrder.findMany({
        where: { status: { in: ["failed", "pending"] }, attempts: { lt: MAX_ATTEMPTS } },
        distinct: ["shop"],
        select: { shop: true },
      });
      for (const { shop } of shops) {
        const { admin } = await unauthenticated.admin(shop);
        const r = await retryFailedOrders(orderDeps(graphqlFor(admin)));
        if (r.tried) console.log(`[orders] retry ${shop}: ${r.sent}/${r.tried} sent`);
      }
    } catch (e) {
      console.error(`[orders] retry loop: ${(e as Error).message}`);
    }
  }, 5 * 60_000);
}
