import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/sync/store.ts";
import type { BuyerContext } from "../src/b2b/buyer.ts";
import { budgetStatus, needsApproval, sydneyMonth, sydneyMonthRange, type BudgetRepo } from "../src/orders/budget.ts";
import { approvalToken, verifyApprovalToken } from "../src/orders/approvalToken.ts";
import { decideOrder } from "../src/orders/approval.ts";
import { UnleashedError } from "../src/unleashed/client.ts";
import type { EmailMessage } from "../src/email/postmark.ts";
import {
  clearSettingsCache,
  OrderError,
  placeTradeOrder,
  type OrderDeps,
  type OrderRepo,
  type TradeOrderRecord,
} from "../src/orders/placeOrder.ts";

// ---------- month maths

test("Sydney months: DST-aware boundaries, month of an instant", () => {
  assert.deepEqual(
    Object.values(sydneyMonthRange("2026-11")).map((d) => d.toISOString()),
    ["2026-10-31T13:00:00.000Z", "2026-11-30T13:00:00.000Z"],
  );
  assert.deepEqual(
    Object.values(sydneyMonthRange("2026-04")).map((d) => d.toISOString()),
    ["2026-03-31T13:00:00.000Z", "2026-04-30T14:00:00.000Z"], // DST ends 5 Apr
  );
  assert.equal(sydneyMonth(new Date("2026-11-30T13:30:00Z")), "2026-12"); // 12:30am 1 Dec in Sydney
});

test("needsApproval: only when committed + order goes over; no budget = no limit", () => {
  const s = { month: "2026-11", budget: 1000, committed: 900, awaitingApproval: 500, remaining: 100 };
  assert.equal(needsApproval(s, 100), false); // exactly on budget is fine
  assert.equal(needsApproval(s, 100.01), true);
  assert.equal(needsApproval({ ...s, budget: null, remaining: null }, 1e6), false);
});

// ---------- approval links

test("approval tokens: valid, tampered, other order, expired", () => {
  const t = approvalToken("order-1", "secret", 30, Date.UTC(2026, 10, 27));
  assert.equal(verifyApprovalToken("order-1", t, "secret", Date.UTC(2026, 10, 28)), "ok");
  assert.equal(verifyApprovalToken("order-2", t, "secret", Date.UTC(2026, 10, 28)), "invalid");
  assert.equal(verifyApprovalToken("order-1", t, "other", Date.UTC(2026, 10, 28)), "invalid");
  assert.equal(verifyApprovalToken("order-1", t.replace(/.$/, (c) => (c === "A" ? "B" : "A")), "secret", Date.UTC(2026, 10, 28)), "invalid");
  assert.equal(verifyApprovalToken("order-1", t, "secret", Date.UTC(2027, 0, 1)), "expired");
  assert.equal(verifyApprovalToken("order-1", "", "secret"), "invalid");
});

// ---------- order flow with budgets

class MemRepo implements OrderRepo {
  rows = new Map<string, TradeOrderRecord>();
  async get(id: string) { return this.rows.get(id) ?? null; }
  async findByRequestKey(shop: string, key: string) {
    return [...this.rows.values()].find((r) => r.shop === shop && r.requestKey === key) ?? null;
  }
  async create(rec: TradeOrderRecord) {
    if (await this.findByRequestKey(rec.shop, rec.requestKey)) throw new Error("unique");
    this.rows.set(rec.id, { ...rec });
  }
  async update(id: string, patch: Partial<TradeOrderRecord>) { this.rows.set(id, { ...this.rows.get(id)!, ...patch }); }
  async delete(id: string) { this.rows.delete(id); }
  async listForRetry(max: number) {
    return [...this.rows.values()].filter((r) => (r.status === "failed" || r.status === "pending") && r.attempts < max);
  }
}

/** Budgets in memory; spend is worked out from the order repo, like the Postgres version. */
class MemBudgets implements BudgetRepo {
  budgets = new Map<string, number>(); // `${locationId}|${month or "default"}`
  orders: MemRepo;
  constructor(orders: MemRepo) { this.orders = orders; }
  async budgetFor(_shop: string, loc: string, month: string) {
    return this.budgets.get(`${loc}|${month}`) ?? this.budgets.get(`${loc}|default`) ?? null;
  }
  async spendFor(_shop: string, loc: string, month: string) {
    let committed = 0, awaitingApproval = 0;
    for (const r of this.orders.rows.values()) {
      if (r.locationId !== loc || sydneyMonth(r.createdAt) !== month) continue;
      if (r.status === "awaiting-approval") awaitingApproval += r.goodsExGst;
      else if (r.status !== "rejected") committed += r.goodsExGst;
    }
    return { committed, awaitingApproval };
  }
}

const SITE = "gid://shopify/CompanyLocation/7";
const buyer: BuyerContext = {
  customerId: "gid://shopify/Customer/1",
  name: "Pat Buyer",
  email: "pat@example.com",
  contactId: "gid://shopify/CompanyContact/5",
  companyId: "gid://shopify/Company/9",
  companyName: "Assetlink",
  sites: [{ id: SITE, name: "Westpoint Blacktown", customerCode: "ASSETLINK" }],
  site: { id: SITE, name: "Westpoint Blacktown", customerCode: "ASSETLINK" },
};

let store: MemoryStore;
let repo: MemRepo;
let budgets: MemBudgets;
let emails: EmailMessage[];
let posts: any[];
let tags: { add: string[]; remove: string[] };
let adminMetafield: string | null;
let staffEmail: string | null;
let unleashedFails: number;
const now = new Date("2026-11-27T01:00:00Z");

function deps(): OrderDeps {
  return {
    store,
    orders: repo,
    budgets,
    email: { send: async (m) => { emails.push(m); } },
    notify: { appUrl: "https://app.example/", tokenSecret: "s3cret", staffEmail },
    now: () => now,
    settings: { orderStatus: "Parked", warehouseName: "Clearchoice Factory", taxCode: "OUTPUT" },
    shopify: async <T,>(query: string, vars?: any) => {
      if (query.includes("OrderSite")) {
        return {
          companyLocation: { id: vars.location, name: "Westpoint Blacktown", note: null, shippingAddress: { address1: "17 Patrick St", address2: null, city: "Blacktown", zoneCode: "NSW", zip: "2148", countryCode: "AU", recipient: null } },
          nodes: vars.variants.map((id: string) => ({ id, sku: "SKU-A" })),
        } as T;
      }
      if (query.includes("TradeDraft")) return { draftOrderCreate: { draftOrder: { id: "gid://shopify/DraftOrder/55", name: "#D55" }, userErrors: [] } } as T;
      if (query.includes("BudgetApproverContact")) {
        return { node: vars.id === "gid://shopify/CompanyContact/1" ? { customer: { displayName: "Hannah Head", defaultEmailAddress: { emailAddress: "hannah@assetlink.example" } } } : null } as T;
      }
      if (query.includes("BudgetApprover")) {
        return { company: { admin: adminMetafield ? { value: adminMetafield } : null, mainContact: null } } as T;
      }
      if (query.includes("UntagDraft")) { tags.remove.push(...vars.tags); return {} as T; }
      if (query.includes("TagDraft")) { tags.add.push(...vars.tags); return {} as T; }
      throw new Error(`unexpected query ${query.slice(0, 60)}`);
    },
    unleashed: {
      warehouses: async () => [{ Guid: "w1", WarehouseCode: "W1", WarehouseName: "Clearchoice Factory" }],
      taxes: async () => [{ TaxCode: "OUTPUT", TaxRate: 0.1, Description: "GST on Income (10%)" }],
      post: async <T,>(_path: string, body: any) => {
        if (unleashedFails-- > 0) throw new UnleashedError("Unleashed POST failed: 503", 503, "");
        posts.push(body);
        return { OrderNumber: "SO-1" } as T;
      },
      get: async <T,>() => { throw new UnleashedError("not found", 404, ""); },
    },
  };
}

beforeEach(async () => {
  clearSettingsCache();
  store = new MemoryStore();
  await store.replaceAll({
    products: [{ code: "SKU-A", description: "Nitrile gloves", groupName: null, defaultSellPrice: 10, tierPrices: [8, null, null, null, null, null, null, null, null, null], taxable: true, obsolete: false, sellable: true }],
    customers: [{ code: "ASSETLINK", tier: 1, discount: 0, obsolete: false }],
    rules: [],
    quantityPrices: [],
  });
  repo = new MemRepo();
  budgets = new MemBudgets(repo);
  emails = [];
  posts = [];
  tags = { add: [], remove: [] };
  adminMetafield = "gid://shopify/CompanyContact/1";
  staffEmail = "orders@clearchoice.example";
  unleashedFails = 0;
});

let key = 0;
const order = (qty: number, over: Partial<Parameters<typeof placeTradeOrder>[1]> = {}) =>
  placeTradeOrder(deps(), { shop: "dev", requestKey: `req-${++key}`, buyer, poNumber: "PO-1", lines: [{ variantId: "1", quantity: qty }], ...over });

test("within budget: sent to Unleashed, buyer gets 'order received'", async () => {
  budgets.budgets.set(`${SITE}|default`, 100);
  const r = await order(10); // $80
  assert.equal(r.status, "sent");
  assert.equal(posts.length, 1);
  const rec = repo.rows.get(r.orderId)!;
  assert.equal(rec.budgetExGst, 100);
  assert.equal(rec.committedBeforeExGst, 0);
  assert.equal(rec.lines[0]!.title, "Nitrile gloves");
  assert.deepEqual(emails.map((e) => [e.to, e.tag]), [["pat@example.com", "order-received"]]);
  assert.match(emails[0]!.subject, /Order received: PO PO-1 for Westpoint Blacktown/);
});

test("over budget: held for the head-office admin; nothing sent; emails to admin and buyer", async () => {
  budgets.budgets.set(`${SITE}|default`, 100);
  await order(10); // $80 committed
  emails = [];
  const r = await order(5); // $40 → $120 > $100
  assert.equal(r.status, "awaiting-approval");
  assert.equal(r.approverName, "Hannah Head");
  assert.equal(posts.length, 1); // only the first order
  const rec = repo.rows.get(r.orderId)!;
  assert.equal(rec.committedBeforeExGst, 80);
  assert.equal(rec.approverEmail, "hannah@assetlink.example");
  assert.ok(rec.payload, "prices locked in the saved payload");

  const [toAdmin, toBuyer] = emails;
  assert.equal(toAdmin!.to, "hannah@assetlink.example");
  assert.equal(toAdmin!.replyTo, "pat@example.com");
  assert.match(toAdmin!.text, /Over budget by \$20\.00/);
  const link = /https:\/\/app\.example\/approvals\/([\w-]+)\?t=(\S+)/.exec(toAdmin!.text)!;
  assert.equal(link[1], r.orderId);
  assert.equal(verifyApprovalToken(r.orderId, link[2]!, "s3cret"), "ok");
  assert.equal(toBuyer!.to, "pat@example.com");
  assert.match(toBuyer!.subject, /Waiting for approval/);
});

test("a month's own budget overrides the default; awaiting orders don't use up budget", async () => {
  budgets.budgets.set(`${SITE}|default`, 1000);
  budgets.budgets.set(`${SITE}|2026-11`, 50);
  const a = await order(10); // $80 > $50
  assert.equal(a.status, "awaiting-approval");
  const s = await budgetStatus(budgets, "dev", SITE, now);
  assert.deepEqual(s, { month: "2026-11", budget: 50, committed: 0, awaitingApproval: 80, remaining: 50 });
});

test("approve: sends the saved order once, retags the draft, emails the buyer; second click does nothing", async () => {
  budgets.budgets.set(`${SITE}|default`, 10);
  const r = await order(5);
  emails = [];
  const d = await decideOrder(deps(), r.orderId, "approve");
  assert.equal(d.changed, true);
  assert.equal(d.order.status, "sent");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].Guid, r.orderId);
  assert.ok(tags.remove.includes("awaiting-approval"));
  assert.ok(tags.add.includes("approved") && tags.add.includes("sent-to-unleashed"));
  assert.deepEqual(emails.map((e) => e.tag), ["order-approved"]);
  assert.ok(repo.rows.get(r.orderId)!.decidedAt);

  const again = await decideOrder(deps(), r.orderId, "reject");
  assert.equal(again.changed, false);
  assert.equal(posts.length, 1);
});

test("decline: nothing sent, reason emailed to the buyer, doesn't count against the budget", async () => {
  budgets.budgets.set(`${SITE}|default`, 10);
  const r = await order(5);
  emails = [];
  const d = await decideOrder(deps(), r.orderId, "reject", "Over our limit this month");
  assert.equal(d.order.status, "rejected");
  assert.equal(posts.length, 0);
  assert.ok(tags.add.includes("rejected"));
  assert.match(emails[0]!.text, /Reason: Over our limit this month/);
  assert.equal((await budgetStatus(budgets, "dev", SITE, now)).committed, 0);
});

test("no budget: no check, sent straight away", async () => {
  const r = await order(1000);
  assert.equal(r.status, "sent");
});

test("the head-office admin's own over-budget order isn't held for their own approval", async () => {
  budgets.budgets.set(`${SITE}|default`, 10);
  const r = await order(5, { buyer: { ...buyer, email: "Hannah@Assetlink.example" } });
  assert.equal(r.status, "sent");
});

test("no head-office admin: approval goes to Clearchoice staff; with no staff address the order is refused", async () => {
  budgets.budgets.set(`${SITE}|default`, 10);
  adminMetafield = null;
  const r = await order(5);
  assert.equal(r.status, "awaiting-approval");
  assert.equal(emails[0]!.to, "orders@clearchoice.example");
  staffEmail = null;
  await assert.rejects(order(5), OrderError);
});

test("Unleashed failure: staff are emailed on the first failure, buyer still gets 'order received'", async () => {
  unleashedFails = 1;
  const r = await order(1);
  assert.equal(r.status, "failed");
  assert.deepEqual(emails.map((e) => [e.to, e.tag]), [["orders@clearchoice.example", "unleashed-failed"], ["pat@example.com", "order-received"]]);
  assert.match(emails[0]!.subject, /Trade order retrying/);
});

test("an email failure never stops the order", async () => {
  const d = deps();
  d.email = { send: async () => { throw new Error("Postmark down"); } };
  const r = await placeTradeOrder(d, { shop: "dev", requestKey: "req-x", buyer, poNumber: "PO-1", lines: [{ variantId: "1", quantity: 1 }] });
  assert.equal(r.status, "sent");
});

test("months and quarters", async () => {
  const { addMonths, quarterOf, parseQuarter, shortMonthLabel } = await import("../src/orders/budget.ts");
  assert.equal(addMonths("2026-11", 3), "2027-02");
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(shortMonthLabel("2026-12"), "Dec 2026");
  assert.deepEqual(quarterOf("2026-11"), { key: "2026-Q4", label: "Q4: Oct–Dec 2026", months: ["2026-10", "2026-11", "2026-12"] });
  assert.equal(parseQuarter("2027-Q1")!.months[0], "2027-01");
  assert.equal(parseQuarter("2027-Q5"), null);
});
