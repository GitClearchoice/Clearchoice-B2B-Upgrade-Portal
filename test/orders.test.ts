import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/sync/store.ts";
import { UnleashedError } from "../src/unleashed/client.ts";
import type { BuyerContext } from "../src/b2b/buyer.ts";
import {
  clearSettingsCache,
  OrderError,
  placeTradeOrder,
  retryFailedOrders,
  type OrderDeps,
  type OrderRepo,
  type TradeOrderRecord,
} from "../src/orders/placeOrder.ts";

class MemRepo implements OrderRepo {
  rows = new Map<string, TradeOrderRecord>();
  async get(id: string) {
    return this.rows.get(id) ?? null;
  }
  async findByRequestKey(shop: string, key: string) {
    return [...this.rows.values()].find((r) => r.shop === shop && r.requestKey === key) ?? null;
  }
  async create(rec: TradeOrderRecord) {
    if (await this.findByRequestKey(rec.shop, rec.requestKey)) throw new Error("unique");
    this.rows.set(rec.id, { ...rec });
  }
  async update(id: string, patch: Partial<TradeOrderRecord>) {
    this.rows.set(id, { ...this.rows.get(id)!, ...patch });
  }
  async delete(id: string) {
    this.rows.delete(id);
  }
  async listForRetry(max: number) {
    return [...this.rows.values()].filter((r) => (r.status === "failed" || r.status === "pending") && r.attempts < max);
  }
}

const buyer: BuyerContext = {
  customerId: "gid://shopify/Customer/1",
  name: "Pat Buyer",
  email: "pat@example.com",
  contactId: "gid://shopify/CompanyContact/5",
  companyId: "gid://shopify/Company/9",
  companyName: "Assetlink",
  sites: [{ id: "gid://shopify/CompanyLocation/7", name: "Westpoint Blacktown", customerCode: "ASSETLINK" }],
  site: { id: "gid://shopify/CompanyLocation/7", name: "Westpoint Blacktown", customerCode: "ASSETLINK" },
};

let store: MemoryStore;
let repo: MemRepo;
let calls: { shopify: { query: string; vars: any }[]; posts: { path: string; body: any }[]; gets: string[] };
let unleashedFails: number;
let existingInUnleashed: Set<string>;

function deps(): OrderDeps {
  return {
    store,
    orders: repo,
    settings: { orderStatus: "Parked", warehouseName: "Clearchoice Factory", taxCode: "OUTPUT" },
    shopify: async <T,>(query: string, vars?: any) => {
      calls.shopify.push({ query, vars });
      if (query.includes("OrderSite")) {
        return {
          companyLocation: {
            id: vars.location,
            name: "Westpoint Blacktown",
            note: "Dock 3 | Call Sam 0400 000 000",
            shippingAddress: { address1: "17 Patrick St", address2: null, city: "Blacktown", zoneCode: "NSW", zip: "2148", countryCode: "AU", recipient: null },
          },
          nodes: vars.variants.map((id: string) => (id.endsWith("/404") ? null : { id, sku: id.endsWith("/1") ? "SKU-A" : "SKU-B" })),
        } as T;
      }
      if (query.includes("TradeDraft")) return { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/55", name: "#D55" }, userErrors: [] } } as T;
      return { tagsAdd: { userErrors: [] } } as T;
    },
    unleashed: {
      warehouses: async () => [{ Guid: "w1", WarehouseCode: "W1", WarehouseName: "Clearchoice Factory" }],
      taxes: async () => [{ TaxCode: "OUTPUT", TaxRate: 0.1, Description: "GST on Income (10%)" }],
      post: async <T,>(path: string, body: any) => {
        calls.posts.push({ path, body });
        if (unleashedFails > 0) {
          unleashedFails--;
          throw new UnleashedError("Unleashed POST failed: 503", 503, "");
        }
        existingInUnleashed.add(body.Guid);
        return { OrderNumber: "SO-00000123" } as T;
      },
      get: async <T,>(path: string) => {
        calls.gets.push(path);
        const guid = path.split("/").pop()!;
        if (!existingInUnleashed.has(guid)) throw new UnleashedError("not found", 404, "");
        return { Guid: guid, OrderNumber: "SO-00000123" } as T;
      },
    },
  };
}

beforeEach(async () => {
  clearSettingsCache();
  store = new MemoryStore();
  await store.replaceAll({
    products: [
      { code: "SKU-A", groupName: null, defaultSellPrice: 10, tierPrices: [8, null, null, null, null, null, null, null, null, null], taxable: true, obsolete: false, sellable: true },
      { code: "SKU-B", groupName: null, defaultSellPrice: 5, tierPrices: Array(10).fill(null), taxable: false, obsolete: false, sellable: true },
    ],
    customers: [{ code: "ASSETLINK", tier: 1, discount: 0, obsolete: false }],
    rules: [],
    quantityPrices: [],
  });
  repo = new MemRepo();
  calls = { shopify: [], posts: [], gets: [] };
  unleashedFails = 0;
  existingInUnleashed = new Set();
});

const input = (over: Partial<Parameters<typeof placeTradeOrder>[1]> = {}) => ({
  shop: "dev.myshopify.com",
  requestKey: "req-1",
  buyer,
  poNumber: "PO-77",
  note: "Leave at dock",
  lines: [
    { variantId: "1", quantity: 2 },
    { variantId: "gid://shopify/ProductVariant/2", quantity: 3 },
    { variantId: "1", quantity: 1 },
  ],
  ...over,
});

test("places a draft order and sends it to Unleashed with server prices", async () => {
  const r = await placeTradeOrder(deps(), input());
  assert.equal(r.status, "sent");
  assert.equal(r.unleashedOrderNumber, "SO-00000123");
  assert.equal(r.draftOrderName, "#D55");
  assert.equal(r.goodsExGst, 3 * 8 + 3 * 5);

  const draft = calls.shopify.find((c) => c.query.includes("TradeDraft"))!.vars.input;
  assert.deepEqual(draft.purchasingEntity.purchasingCompany, {
    companyId: buyer.companyId,
    companyLocationId: buyer.site.id,
    companyContactId: buyer.contactId,
  });
  assert.deepEqual(
    draft.lineItems.map((l: any) => [l.variantId, l.quantity, l.priceOverride.amount]),
    [["gid://shopify/ProductVariant/1", 3, "8.00"], ["gid://shopify/ProductVariant/2", 3, "5.00"]],
  );
  assert.equal(draft.poNumber, "PO-77");
  assert.deepEqual(draft.tags, ["trade-order"]);

  assert.equal(calls.posts.length, 1);
  const so = calls.posts[0]!.body;
  assert.equal(calls.posts[0]!.path, `/SalesOrders/${so.Guid}`);
  assert.equal(so.Guid, r.orderId);
  assert.equal(so.Customer.CustomerCode, "ASSETLINK");
  assert.equal(so.CustomerRef, "PO-77");
  assert.equal(so.DeliveryName, "Westpoint Blacktown");
  assert.equal(so.DeliverySuburb, "Blacktown");
  assert.equal(so.DeliveryInstruction, "Leave at dock | Dock 3 | Call Sam 0400 000 000");
  assert.equal(so.SubTotal, 39);
  assert.equal(so.TaxTotal, 2.4); // SKU-B is GST-free
  assert.equal(so.OrderStatus, "Parked");
  assert.match(so.Comments, /#D55.*Pat Buyer <pat@example.com>/);

  const tags = calls.shopify.filter((c) => c.query.includes("TagDraft")).flatMap((c) => c.vars.tags);
  assert.deepEqual(tags, ["sent-to-unleashed", "unleashed-SO-00000123"]);
});

test("same request key twice returns the first order without sending again", async () => {
  const a = await placeTradeOrder(deps(), input());
  const b = await placeTradeOrder(deps(), input());
  assert.equal(b.orderId, a.orderId);
  assert.equal(b.alreadyPlaced, true);
  assert.equal(calls.posts.length, 1);
});

test("Unleashed down: buyer still gets the order; retry checks Unleashed then sends once", async () => {
  unleashedFails = 1;
  const r = await placeTradeOrder(deps(), input());
  assert.equal(r.status, "failed");
  const rec = repo.rows.get(r.orderId)!;
  assert.equal(rec.attempts, 1);
  assert.match(rec.lastError!, /503/);
  assert.ok(calls.shopify.some((c) => c.query.includes("TagDraft") && c.vars.tags.includes("unleashed-failed")));

  const out = await retryFailedOrders(deps());
  assert.deepEqual(out, { tried: 1, sent: 1 });
  assert.equal(calls.gets.length, 1); // looked first
  assert.equal(calls.posts.length, 2);
  assert.equal(repo.rows.get(r.orderId)!.status, "sent");
  assert.equal(calls.posts[0]!.body.Guid, calls.posts[1]!.body.Guid); // same Guid
});

test("retry finds an order that actually reached Unleashed and doesn't post it again", async () => {
  unleashedFails = 1;
  const r = await placeTradeOrder(deps(), input());
  existingInUnleashed.add(r.orderId); // the first POST went through; only the reply was lost
  await retryFailedOrders(deps());
  assert.equal(calls.posts.length, 1);
  assert.equal(repo.rows.get(r.orderId)!.status, "sent");
});

test("buyer errors: PO required, unknown product code, empty cart", async () => {
  await assert.rejects(placeTradeOrder(deps(), input({ poNumber: "  " })), OrderError);
  await assert.rejects(placeTradeOrder(deps(), input({ lines: [] })), OrderError);
  await assert.rejects(placeTradeOrder(deps(), input({ lines: [{ variantId: "404", quantity: 1 }] })), /no product code/);
  await assert.rejects(placeTradeOrder(deps(), input({ lines: [{ variantId: "1", quantity: 0 }] })), OrderError);
  assert.equal(repo.rows.size, 0);
  assert.equal(calls.posts.length, 0);
});

test("draft order failure leaves nothing behind so the buyer can retry", async () => {
  const d = deps();
  const orig = d.shopify;
  d.shopify = (async (q: string, v?: any) => {
    if (q.includes("TradeDraft")) return { draftOrderCreate: { draftOrder: null, userErrors: [{ message: "Variant not available" }] } };
    return orig(q, v);
  }) as typeof d.shopify;
  await assert.rejects(placeTradeOrder(d, input()), /Variant not available/);
  assert.equal(repo.rows.size, 0);
  assert.equal(calls.posts.length, 0);
});
