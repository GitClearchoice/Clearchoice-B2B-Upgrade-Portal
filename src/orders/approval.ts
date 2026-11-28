// Head-office admin's decision on an over-budget order (from the emailed approval link). Before
// approving they can change quantities, remove items and add the PO number.
import { approvedEmail, rejectedEmail, needsPo } from "../email/templates.ts";
import { priceLines } from "../index.ts";
import { reviseSalesOrder } from "../unleashed/salesOrder.ts";
import {
  OrderError,
  sendEmail,
  sendToUnleashed,
  summaryOf,
  tagDraft,
  type OrderDeps,
  type TradeOrderLine,
  type TradeOrderRecord,
} from "./placeOrder.ts";

export type Decision = "approve" | "reject";

export interface DecisionResult {
  order: TradeOrderRecord;
  /** False when the order had already been decided (e.g. the link was clicked twice). */
  changed: boolean;
  /** What the approver changed (quantities, removed items, PO), in words. */
  changes?: string[];
}

export interface Revision {
  /** New quantity per line, by line index; 0 removes the line. Missing = unchanged. */
  quantities?: Record<number, number>;
  /** PO number entered by the approver (blank = keep). */
  poNumber?: string | null;
}

const DRAFT_UPDATE = `#graphql
  mutation ReviseDraft($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) { userErrors { field message } }
  }`;

const money = (n: number) => "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Applies the approver's changes to an order that's waiting for approval: re-prices the new quantities
 * (quantity breaks apply), rewrites the saved Unleashed order and the Shopify draft. Nothing is sent.
 */
export async function reviseOrder(deps: OrderDeps, rec: TradeOrderRecord, rev: Revision): Promise<{ order: TradeOrderRecord; changes: string[] }> {
  if (rec.status !== "awaiting-approval") throw new OrderError("This order has already been decided");
  const changes: string[] = [];

  // PO
  const newPo = rev.poNumber?.trim().slice(0, 100) || "";
  const poNumber = newPo && newPo !== rec.poNumber ? newPo : rec.poNumber;
  if (poNumber !== rec.poNumber) changes.push(needsPo(rec.poNumber) ? `PO number added: ${poNumber}` : `PO number changed from ${rec.poNumber} to ${poNumber}`);

  // Quantities
  const wanted = rec.lines.map((l, i) => {
    const q = rev.quantities?.[i];
    if (q === undefined || q === l.quantity) return { line: l, quantity: l.quantity };
    if (!Number.isInteger(q) || q < 0 || q > 100_000) throw new OrderError(`Bad quantity for ${l.title || l.sku}`);
    changes.push(q === 0 ? `Removed ${l.title || l.sku}` : `${l.title || l.sku}: quantity ${l.quantity} → ${q}`);
    return { line: l, quantity: q };
  });
  const kept = wanted.filter((w) => w.quantity > 0);
  if (!kept.length) throw new OrderError("To remove every item, decline the order instead.");
  if (!changes.length) return { order: rec, changes };

  let lines: TradeOrderLine[] = rec.lines;
  let goodsExGst = rec.goodsExGst;
  let payload = rec.payload as Parameters<typeof reviseSalesOrder>[0];
  const qtyChanged = wanted.some((w) => w.quantity !== w.line.quantity);
  if (qtyChanged) {
    const priced = await priceLines(deps.store, rec.customerCode, kept.map((w) => ({ sku: w.line.sku, quantity: w.quantity })));
    if (priced.errors.length) throw new OrderError(`Can't price: ${priced.errors.map((e) => `${e.sku} (${e.error})`).join(", ")}`);
    lines = priced.lines.map((p, i) => ({ ...kept[i]!.line, quantity: p.quantity, unitExGst: p.unitExGst, lineExGst: p.lineExGst }));
    goodsExGst = priced.goodsExGst;
    const taxable = new Map<string, boolean>();
    for (const l of lines) taxable.set(l.sku, (await deps.store.getProduct(l.sku))?.taxable !== false);
    payload = reviseSalesOrder(payload, priced.lines, (c) => taxable.get(c) ?? true, poNumber);
    changes.push(`New goods total ${money(goodsExGst)} ex GST (was ${money(rec.goodsExGst)})`);
  } else {
    payload = { ...payload, CustomerRef: poNumber };
  }

  const patch = { lines, goodsExGst, payload, poNumber };
  await deps.orders.update(rec.id, patch);

  // Keep the Shopify draft in step (the Shopify-side record). Unleashed gets the saved payload.
  if (rec.draftOrderId) {
    try {
      const r = await deps.shopify<{ draftOrderUpdate: { userErrors: { message: string }[] } }>(DRAFT_UPDATE, {
        id: rec.draftOrderId,
        input: {
          poNumber,
          ...(qtyChanged
            ? { lineItems: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, priceOverride: { amount: l.unitExGst.toFixed(2), currencyCode: "AUD" } })) }
            : {}),
        },
      });
      if (r.draftOrderUpdate.userErrors.length) throw new Error(r.draftOrderUpdate.userErrors.map((e) => e.message).join("; "));
    } catch (e) {
      (deps.log ?? (() => {}))(`Couldn't update draft ${rec.draftOrderName}: ${(e as Error).message}`);
    }
  }
  return { order: { ...rec, ...patch }, changes };
}

export async function decideOrder(deps: OrderDeps, orderId: string, decision: Decision, reason?: string | null, rev?: Revision): Promise<DecisionResult> {
  let rec = await deps.orders.get(orderId);
  if (!rec) throw new Error("Order not found");
  if (rec.status !== "awaiting-approval") return { order: rec, changed: false };
  const decidedAt = deps.now?.() ?? new Date();
  const who = rec.approverName ?? "Your head-office admin";
  const note = reason?.trim().slice(0, 500) || null;

  if (decision === "reject") {
    const patch = { status: "rejected" as const, decidedAt, decisionNote: note };
    await deps.orders.update(rec.id, patch);
    await tagDraft(deps, rec.draftOrderId, ["rejected"], ["awaiting-approval"]);
    const done = { ...rec, ...patch };
    if (rec.buyerEmail) await sendEmail(deps, rec.buyerEmail, rejectedEmail(summaryOf(done), who, note), "order-rejected");
    (deps.log ?? (() => {}))(`${rec.draftOrderName} declined by ${rec.approverEmail}`);
    return { order: done, changed: true };
  }

  // Approve: apply any changes, then send the order (the saved, possibly revised, payload).
  let changes: string[] = [];
  if (rev) ({ order: rec, changes } = await reviseOrder(deps, rec, rev));
  const decisionNote = [note, changes.length ? `Changed by approver: ${changes.join("; ")}` : null].filter(Boolean).join(" | ") || null;
  const patch = { status: "pending" as const, decidedAt, decisionNote };
  await deps.orders.update(rec.id, patch);
  await tagDraft(deps, rec.draftOrderId, ["approved", ...(changes.length ? ["changed-by-approver"] : [])], ["awaiting-approval"]);
  const sent = await sendToUnleashed(deps, { ...rec, ...patch });
  if (rec.buyerEmail) await sendEmail(deps, rec.buyerEmail, approvedEmail(summaryOf(sent), who, changes), "order-approved");
  (deps.log ?? (() => {}))(`${rec.draftOrderName} approved by ${rec.approverEmail}${changes.length ? " with changes" : ""}`);
  return { order: sent, changed: true, changes };
}
