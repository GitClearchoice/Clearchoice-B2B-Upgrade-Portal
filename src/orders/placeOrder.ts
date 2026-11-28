// "Place order" for trade buyers (HANDOVER "Order flow"):
//   price on the server → budget check → Shopify draft order (never completed) →
//   within budget: Unleashed sales order via the API; over budget: wait for the head-office admin.
// Everything outside (Shopify, Unleashed, the DB) is passed in, so this is testable without them.
import { randomUUID } from "node:crypto";
import type { BuyerContext } from "../b2b/buyer.ts";
import type { ShopifyAddress } from "../b2b/address.ts";
import { priceLines } from "../index.ts";
import type { PriceStore } from "../sync/store.ts";
import { UnleashedError } from "../unleashed/client.ts";
import { buildSalesOrder, deliveryInstructionFor } from "../unleashed/salesOrder.ts";
import type { UTax, UWarehouse } from "../unleashed/types.ts";
import { budgetStatus, needsApproval, type BudgetRepo, type BudgetStatus } from "./budget.ts";
import type { EmailSender } from "../email/postmark.ts";
import {
  approvalRequestEmail,
  awaitingApprovalEmail,
  needsPo,
  newTradeOrderEmail,
  orderReceivedEmail,
  unleashedFailedEmail,
  type Email,
  type OrderSummary,
} from "../email/templates.ts";
import { approvalToken } from "./approvalToken.ts";

/**
 * pending: on its way to Unleashed (also after approval) · sent · failed: retrying ·
 * awaiting-approval: over budget, waiting for the head-office admin · rejected: declined by them.
 */
export type TradeOrderStatus = "pending" | "sent" | "failed" | "awaiting-approval" | "rejected";

export interface TradeOrderLine {
  variantId: string;
  sku: string;
  quantity: number;
  unitExGst: number;
  lineExGst: number;
  /** Product description from Unleashed, for emails and reports. */
  title?: string;
}

export interface TradeOrderRecord {
  /** Also the Unleashed SalesOrder Guid, generated and saved before anything is sent. */
  id: string;
  shop: string;
  /** From the order form; the same key twice (double click, retry) returns the first order. */
  requestKey: string;
  customerId: string;
  buyerName: string;
  buyerEmail: string | null;
  companyId: string;
  companyName: string;
  locationId: string;
  siteName: string;
  customerCode: string;
  poNumber: string;
  note: string | null;
  goodsExGst: number;
  lines: TradeOrderLine[];
  draftOrderId: string | null;
  draftOrderName: string | null;
  status: TradeOrderStatus;
  unleashedOrderNumber: string | null;
  payload: unknown;
  attempts: number;
  lastError: string | null;
  /** Site budget for the order's month when it was placed (null = no budget). */
  budgetExGst: number | null;
  /** Goods already ordered for the site that month, before this order. */
  committedBeforeExGst: number | null;
  approverName: string | null;
  approverEmail: string | null;
  decidedAt: Date | null;
  /** Reason given when declined (or a note when approved). */
  decisionNote: string | null;
  createdAt: Date;
}

export interface OrderRepo {
  get(id: string): Promise<TradeOrderRecord | null>;
  findByRequestKey(shop: string, requestKey: string): Promise<TradeOrderRecord | null>;
  /** Must reject a second record with the same (shop, requestKey). */
  create(rec: TradeOrderRecord): Promise<void>;
  update(id: string, patch: Partial<TradeOrderRecord>): Promise<void>;
  delete(id: string): Promise<void>;
  listForRetry(maxAttempts: number): Promise<TradeOrderRecord[]>;
}

/** Runs an Admin GraphQL query for the shop and returns `data` (throws on top-level errors). */
export type ShopifyGraphql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;

export interface UnleashedOrders {
  post<T>(path: string, body: unknown): Promise<T>;
  get<T>(path: string): Promise<T>;
  warehouses(): Promise<UWarehouse[]>;
  taxes(): Promise<UTax[]>;
}

export interface OrderSettings {
  orderStatus: string; // "Parked"
  warehouseName: string; // "Clearchoice Factory"
  taxCode: string; // "OUTPUT" = "GST on Income (10%)"
}

export interface NotifySettings {
  /** Base URL of the app (SHOPIFY_APP_URL), for the approval link. */
  appUrl: string;
  /** Signs approval links (SHOPIFY_API_SECRET). */
  tokenSecret: string;
  /** Clearchoice staff address for failed orders, and approvals when a company has no admin. */
  staffEmail?: string | null;
}

export interface OrderDeps {
  shopify: ShopifyGraphql;
  unleashed: UnleashedOrders;
  store: PriceStore;
  orders: OrderRepo;
  settings: OrderSettings;
  /** Site budgets; without it every order is sent (no budget check). */
  budgets?: BudgetRepo;
  email?: EmailSender;
  notify?: NotifySettings;
  log?: (msg: string) => void;
  now?: () => Date;
}

export interface PlaceOrderInput {
  shop: string;
  requestKey: string;
  buyer: BuyerContext;
  poNumber: string;
  note?: string;
  lines: { variantId: string; quantity: number }[];
}

export interface PlaceOrderResult {
  orderId: string;
  status: TradeOrderStatus;
  /** Set when the order went to the head-office admin for approval. */
  approverName?: string | null;
  draftOrderName: string | null;
  unleashedOrderNumber: string | null;
  goodsExGst: number;
  alreadyPlaced?: boolean;
}

/** Problems the buyer can fix (shown on the order form). */
export class OrderError extends Error {}

export const MAX_ATTEMPTS = 10;

const SITE_AND_VARIANTS = `#graphql
  query OrderSite($location: ID!, $variants: [ID!]!) {
    companyLocation(id: $location) {
      id
      name
      note
      shippingAddress { address1 address2 city zoneCode zip countryCode recipient }
    }
    nodes(ids: $variants) {
      ... on ProductVariant { id sku }
    }
  }`;

const DRAFT_CREATE = `#graphql
  mutation TradeDraft($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder { id name }
      userErrors { field message }
    }
  }`;

const TAGS_ADD = `#graphql
  mutation TagDraft($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }`;

const TAGS_REMOVE = `#graphql
  mutation UntagDraft($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) { userErrors { field message } }
  }`;

// Head-office admin: company metafield b2b.budget_admin_contact (a CompanyContact GID), else the main contact.
const APPROVER = `#graphql
  query BudgetApprover($company: ID!) {
    company(id: $company) {
      admin: metafield(namespace: "b2b", key: "budget_admin_contact") { value }
      mainContact { customer { displayName defaultEmailAddress { emailAddress } } }
    }
  }`;

const CONTACT = `#graphql
  query BudgetApproverContact($id: ID!) {
    node(id: $id) {
      ... on CompanyContact { customer { displayName defaultEmailAddress { emailAddress } } }
    }
  }`;

type ContactCustomer = { displayName: string; defaultEmailAddress: { emailAddress: string } | null } | null;

export interface Approver {
  name: string;
  email: string;
  /** True when no head-office admin was found and the request goes to Clearchoice staff. */
  isStaff?: boolean;
}

export async function findApprover(deps: OrderDeps, companyId: string): Promise<Approver | null> {
  const asApprover = (c: ContactCustomer): Approver | null =>
    c?.defaultEmailAddress?.emailAddress ? { name: c.displayName, email: c.defaultEmailAddress.emailAddress } : null;
  try {
    const r = await deps.shopify<{ company: { admin: { value: string } | null; mainContact: { customer: ContactCustomer } | null } | null }>(APPROVER, { company: companyId });
    const adminId = r.company?.admin?.value?.trim();
    if (adminId?.startsWith("gid://shopify/CompanyContact/")) {
      const c = await deps.shopify<{ node: { customer: ContactCustomer } | null }>(CONTACT, { id: adminId });
      const a = asApprover(c.node?.customer ?? null);
      if (a) return a;
    }
    const main = asApprover(r.company?.mainContact?.customer ?? null);
    if (main) return main;
  } catch (e) {
    (deps.log ?? (() => {}))(`Couldn't look up the budget admin for ${companyId}: ${(e as Error).message}`);
  }
  const staff = deps.notify?.staffEmail;
  return staff ? { name: "Clearchoice", email: staff, isStaff: true } : null;
}

interface SiteData {
  companyLocation: {
    id: string;
    name: string;
    note: string | null;
    shippingAddress: (Omit<ShopifyAddress, "address2"> & { address2: string | null }) | null;
  } | null;
  nodes: ({ id: string; sku: string | null } | null)[];
}

export function normaliseVariantId(id: string): string {
  const v = String(id).trim();
  if (v.startsWith("gid://shopify/ProductVariant/")) return v;
  if (/^\d+$/.test(v)) return `gid://shopify/ProductVariant/${v}`;
  throw new OrderError(`Bad product variant "${id}"`);
}

export async function placeTradeOrder(deps: OrderDeps, input: PlaceOrderInput): Promise<PlaceOrderResult> {
  const log = deps.log ?? (() => {});
  const existing = await deps.orders.findByRequestKey(input.shop, input.requestKey);
  if (existing) return { ...resultOf(existing), alreadyPlaced: true };

  const poNumber = input.poNumber.trim();
  if (!poNumber) throw new OrderError("Enter a PO number");
  if (poNumber.length > 100) throw new OrderError("PO number is too long (100 characters max)");
  const note = input.note?.trim().slice(0, 500) || null;
  if (!input.lines.length) throw new OrderError("Your cart is empty");
  if (input.lines.length > 250) throw new OrderError("At most 250 lines per order");

  // Merge repeated variants; quantities must be whole and positive.
  const qtyByVariant = new Map<string, number>();
  for (const l of input.lines) {
    const id = normaliseVariantId(l.variantId);
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 100_000) throw new OrderError(`Bad quantity ${l.quantity}`);
    qtyByVariant.set(id, (qtyByVariant.get(id) ?? 0) + l.quantity);
  }
  const variantIds = [...qtyByVariant.keys()];

  // Site and SKUs come from Shopify, never from the browser.
  const site = await deps.shopify<SiteData>(SITE_AND_VARIANTS, { location: input.buyer.site.id, variants: variantIds });
  const loc = site.companyLocation;
  if (!loc) throw new OrderError("Your site couldn't be found");
  const addr = loc.shippingAddress;
  if (!addr?.address1 || !addr.city) throw new OrderError(`Site "${loc.name}" has no delivery address. Please contact Clearchoice.`);
  const skuByVariant = new Map<string, string>();
  for (const n of site.nodes) if (n?.id && n.sku?.trim()) skuByVariant.set(n.id, n.sku.trim());
  const missing = variantIds.filter((v) => !skuByVariant.has(v));
  if (missing.length) throw new OrderError(`${missing.length} item(s) in your cart can't be ordered online (no product code). Please remove them or contact Clearchoice.`);

  const wanted = variantIds.map((v) => ({ variantId: v, sku: skuByVariant.get(v)!, quantity: qtyByVariant.get(v)! }));
  const customerCode = input.buyer.site.customerCode;
  const priced = await priceLines(deps.store, customerCode, wanted.map((w) => ({ sku: w.sku, quantity: w.quantity })));
  if (priced.errors.length) {
    throw new OrderError(`Can't order: ${priced.errors.map((e) => `${e.sku} (${e.error})`).join(", ")}`);
  }
  const lines: TradeOrderLine[] = priced.lines.map((p, i) => ({
    variantId: wanted[i]!.variantId,
    sku: p.productCode,
    quantity: p.quantity,
    unitExGst: p.unitExGst,
    lineExGst: p.lineExGst,
  }));
  const taxable = new Map<string, boolean>();
  for (const l of lines) {
    const product = await deps.store.getProduct(l.sku);
    taxable.set(l.sku, product?.taxable !== false);
    if (product?.description) l.title = product.description;
  }

  const { warehouse, tax } = await resolveUnleashedSettings(deps);

  // Budget check (before this order is saved, so it isn't counted twice). Orders by the head-office
  // admin themselves don't wait for their own approval.
  const createdAt = deps.now?.() ?? new Date();
  let budget: BudgetStatus | null = null;
  let approver: Approver | null = null;
  if (deps.budgets) {
    budget = await budgetStatus(deps.budgets, input.shop, loc.id, createdAt);
    if (needsApproval(budget, priced.goodsExGst)) {
      approver = await findApprover(deps, input.buyer.companyId);
      if (!approver) throw new OrderError("This order is over the site's monthly budget and needs approval, but no approver is set up. Please contact Clearchoice.");
      if (input.buyer.email && approver.email.toLowerCase() === input.buyer.email.toLowerCase()) approver = null;
    }
  }

  // Save the Guid before anything is sent: a retry can then never create a second Unleashed order.
  const rec: TradeOrderRecord = {
    id: randomUUID(),
    shop: input.shop,
    requestKey: input.requestKey,
    customerId: input.buyer.customerId,
    buyerName: input.buyer.name,
    buyerEmail: input.buyer.email,
    companyId: input.buyer.companyId,
    companyName: input.buyer.companyName,
    locationId: loc.id,
    siteName: loc.name,
    customerCode,
    poNumber,
    note,
    goodsExGst: priced.goodsExGst,
    lines,
    draftOrderId: null,
    draftOrderName: null,
    status: "pending",
    unleashedOrderNumber: null,
    payload: null,
    attempts: 0,
    lastError: null,
    budgetExGst: budget?.budget ?? null,
    committedBeforeExGst: budget ? budget.committed : null,
    approverName: approver?.name ?? null,
    approverEmail: approver?.email ?? null,
    decidedAt: null,
    decisionNote: null,
    createdAt,
  };
  try {
    await deps.orders.create(rec);
  } catch (e) {
    // Lost a race with the same request (double click): return the first one.
    const first = await deps.orders.findByRequestKey(input.shop, input.requestKey);
    if (first) return { ...resultOf(first), alreadyPlaced: true };
    throw e;
  }

  // Shopify draft order: the Shopify-side record. Never completed, so the Unleashed Shopify app can't import it.
  let draft: { id: string; name: string };
  try {
    const r = await deps.shopify<{ draftOrderCreate: { draftOrder: { id: string; name: string } | null; userErrors: { message: string }[] } }>(
      DRAFT_CREATE,
      {
        input: {
          purchasingEntity: {
            purchasingCompany: { companyId: input.buyer.companyId, companyLocationId: loc.id, companyContactId: input.buyer.contactId },
          },
          lineItems: lines.map((l) => ({
            variantId: l.variantId,
            quantity: l.quantity,
            priceOverride: { amount: l.unitExGst.toFixed(2), currencyCode: "AUD" },
          })),
          poNumber,
          note: note ?? undefined,
          tags: approver ? ["trade-order", "awaiting-approval"] : ["trade-order"],
          customAttributes: [{ key: "Unleashed order guid", value: rec.id }],
        },
      },
    );
    const errs = r.draftOrderCreate.userErrors;
    if (errs.length || !r.draftOrderCreate.draftOrder) throw new Error(errs.map((e) => e.message).join("; ") || "No draft order returned");
    draft = r.draftOrderCreate.draftOrder;
  } catch (e) {
    // Nothing has gone to Unleashed yet: drop the record so the buyer can simply try again.
    await deps.orders.delete(rec.id);
    log(`Draft order failed for ${customerCode}: ${(e as Error).message}`);
    throw new Error(`Couldn't create the Shopify draft order: ${(e as Error).message}`);
  }

  const siteNote = deliveryInstructionFor(loc.note ?? undefined, note ?? undefined);
  const payload = buildSalesOrder({
    guid: rec.id,
    customerCode,
    poNumber,
    site: { name: loc.name, address: { ...addr, address2: addr.address2 ?? undefined } },
    lines: priced.lines,
    taxable: (code) => taxable.get(code) ?? true,
    warehouse,
    taxCode: tax.TaxCode,
    taxRate: tax.TaxRate,
    status: deps.settings.orderStatus,
    comments: `Shopify ${draft.name}. Ordered by ${input.buyer.name}${input.buyer.email ? ` <${input.buyer.email}>` : ""}`.slice(0, 500),
    deliveryInstruction: siteNote,
    orderDate: rec.createdAt,
  });
  const saved: TradeOrderRecord = { ...rec, draftOrderId: draft.id, draftOrderName: draft.name, payload };

  if (approver && budget?.budget != null) {
    // Over budget: prices are locked in the saved payload; nothing goes to Unleashed until approved.
    await deps.orders.update(rec.id, { draftOrderId: draft.id, draftOrderName: draft.name, payload, status: "awaiting-approval" });
    const waiting = { ...saved, status: "awaiting-approval" as const };
    const summary = summaryOf(waiting);
    await sendEmail(deps, approver.email, approvalRequestEmail(summary, { month: budget.month, budget: budget.budget, committed: budget.committed }, approver.name, {
      review: approvalUrl(deps, rec.id),
    }), "approval-request", input.buyer.email ?? undefined);
    if (input.buyer.email) await sendEmail(deps, input.buyer.email, awaitingApprovalEmail(summary, approver.name), "awaiting-approval");
    log(`${draft.name} for ${customerCode} is over budget: sent to ${approver.email} for approval`);
    return { ...resultOf(waiting), approverName: approver.name };
  }

  await deps.orders.update(rec.id, { draftOrderId: draft.id, draftOrderName: draft.name, payload });
  const sent = await sendToUnleashed(deps, saved);
  // "sent" or "failed" (retrying): either way the order is received.
  if (input.buyer.email) await sendEmail(deps, input.buyer.email, orderReceivedEmail(summaryOf(sent)), "order-received");
  return resultOf(sent);
}

export function summaryOf(r: TradeOrderRecord): OrderSummary {
  return {
    reference: r.draftOrderName,
    unleashedOrderNumber: r.unleashedOrderNumber,
    companyName: r.companyName,
    siteName: r.siteName,
    poNumber: r.poNumber,
    buyerName: r.buyerName,
    note: r.note,
    goodsExGst: r.goodsExGst,
    lines: r.lines,
  };
}

export function approvalUrl(deps: OrderDeps, orderId: string): string {
  const n = deps.notify;
  if (!n) return "";
  return `${n.appUrl.replace(/\/$/, "")}/approvals/${orderId}?t=${approvalToken(orderId, n.tokenSecret)}`;
}

/** Emails never stop an order: failures are logged. */
export async function sendEmail(deps: OrderDeps, to: string, e: Email, tag: string, replyTo?: string) {
  if (!deps.email) return;
  try {
    await deps.email.send({ to, subject: e.subject, html: e.html, text: e.text, tag, replyTo });
  } catch (err) {
    (deps.log ?? (() => {}))(`Email "${e.subject}" to ${to} failed: ${(err as Error).message}`);
  }
}

/**
 * Sends a saved order to Unleashed (first try and retries). Before a retry it asks Unleashed
 * whether the Guid already exists, in case an earlier attempt went through but the reply was lost.
 */
export async function sendToUnleashed(deps: OrderDeps, rec: TradeOrderRecord, opts: { checkFirst?: boolean } = {}): Promise<TradeOrderRecord> {
  const log = deps.log ?? (() => {});
  const attempts = rec.attempts + 1;
  try {
    let orderNumber: string | null = null;
    if (opts.checkFirst || rec.attempts > 0) orderNumber = await findUnleashedOrder(deps, rec.id);
    if (!orderNumber) {
      const created = await deps.unleashed.post<{ OrderNumber?: string }>(`/SalesOrders/${rec.id}`, rec.payload);
      orderNumber = created.OrderNumber ?? "";
    }
    const patch = { status: "sent" as const, unleashedOrderNumber: orderNumber || null, attempts, lastError: null };
    await deps.orders.update(rec.id, patch);
    await tagDraft(deps, rec.draftOrderId, ["sent-to-unleashed", ...(orderNumber ? [`unleashed-${orderNumber}`] : [])]);
    log(`Sent ${rec.draftOrderName} to Unleashed as ${orderNumber || "(no number returned)"}`);
    // Tell Clearchoice staff about orders that are ready to process: with a real PO (not "PO REQUIRED"),
    // either within budget or approved. Sent once, when the order first reaches Unleashed.
    const staff = deps.notify?.staffEmail;
    if (staff && !needsPo(rec.poNumber)) {
      const approval = rec.approverName && rec.decidedAt ? { approverName: rec.approverName, changes: rec.decisionNote } : null;
      await sendEmail(deps, staff, newTradeOrderEmail(summaryOf({ ...rec, ...patch }), approval), "new-trade-order");
    }
    return { ...rec, ...patch };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 2000);
    const patch = { status: "failed" as const, attempts, lastError: msg };
    await deps.orders.update(rec.id, patch);
    if (rec.status !== "failed") await tagDraft(deps, rec.draftOrderId, ["unleashed-failed"]);
    log(`Unleashed rejected ${rec.draftOrderName} (attempt ${attempts}): ${msg}`);
    // Staff hear about the first failure and when retries run out.
    const final = attempts >= MAX_ATTEMPTS;
    if ((attempts === 1 || final) && deps.notify?.staffEmail) {
      await sendEmail(deps, deps.notify.staffEmail, unleashedFailedEmail(summaryOf({ ...rec, ...patch }), attempts, msg, final), "unleashed-failed");
    }
    return { ...rec, ...patch };
  }
}

/**
 * Retries orders that didn't reach Unleashed. Run every few minutes. The repo returns failed orders
 * and ones left "pending" for a while (e.g. the server restarted mid-send); each is checked in
 * Unleashed first.
 */
export async function retryFailedOrders(deps: OrderDeps): Promise<{ tried: number; sent: number }> {
  const due = await deps.orders.listForRetry(MAX_ATTEMPTS);
  let sent = 0;
  for (const rec of due) {
    if (!rec.payload) continue; // draft never created; nothing to send
    if ((await sendToUnleashed(deps, rec, { checkFirst: true })).status === "sent") sent++;
  }
  return { tried: due.length, sent };
}

async function findUnleashedOrder(deps: OrderDeps, guid: string): Promise<string | null> {
  try {
    const r = await deps.unleashed.get<{ Guid?: string; OrderNumber?: string; Items?: { Guid?: string; OrderNumber?: string }[] }>(`/SalesOrders/${guid}`);
    const o = r.Items ? r.Items[0] : r;
    return o?.Guid?.toLowerCase() === guid.toLowerCase() ? o.OrderNumber ?? "" : null;
  } catch (e) {
    if (e instanceof UnleashedError && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

export async function tagDraft(deps: OrderDeps, draftId: string | null, tags: string[], remove: string[] = []) {
  if (!draftId) return;
  try {
    if (remove.length) await deps.shopify(TAGS_REMOVE, { id: draftId, tags: remove });
    if (tags.length) await deps.shopify(TAGS_ADD, { id: draftId, tags });
  } catch (e) {
    (deps.log ?? (() => {}))(`Couldn't tag ${draftId}: ${(e as Error).message}`);
  }
}

let settingsCache: { at: number; warehouse: UWarehouse; tax: UTax } | null = null;

/** Warehouse and tax checked against Unleashed's own lists (cached for an hour). */
export async function resolveUnleashedSettings(deps: OrderDeps): Promise<{ warehouse: UWarehouse; tax: UTax }> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.at < 3_600_000) return settingsCache;
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const [warehouses, taxes] = await Promise.all([deps.unleashed.warehouses(), deps.unleashed.taxes()]);
  const warehouse = warehouses.find((w) => norm(w.WarehouseName) === norm(deps.settings.warehouseName) || norm(w.WarehouseCode) === norm(deps.settings.warehouseName));
  if (!warehouse) throw new Error(`Unleashed warehouse "${deps.settings.warehouseName}" not found`);
  const code = deps.settings.taxCode;
  const tax = taxes.find((t) => t.TaxCode === code) ?? taxes.find((t) => norm(t.TaxCode) === norm(code) || norm(t.Description) === norm(code));
  if (!tax) throw new Error(`Unleashed tax "${code}" not found`);
  settingsCache = { at: now, warehouse, tax };
  return settingsCache;
}

export function clearSettingsCache() {
  settingsCache = null;
}

function resultOf(r: TradeOrderRecord): PlaceOrderResult {
  return {
    orderId: r.id,
    status: r.status,
    draftOrderName: r.draftOrderName,
    unleashedOrderNumber: r.unleashedOrderNumber,
    goodsExGst: r.goodsExGst,
  };
}
