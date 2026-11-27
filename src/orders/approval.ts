// Head-office admin's decision on an over-budget order (from the emailed approval link).
import { approvedEmail, rejectedEmail } from "../email/templates.ts";
import { sendEmail, sendToUnleashed, summaryOf, tagDraft, type OrderDeps, type TradeOrderRecord } from "./placeOrder.ts";

export type Decision = "approve" | "reject";

export interface DecisionResult {
  order: TradeOrderRecord;
  /** False when the order had already been decided (e.g. the link was clicked twice). */
  changed: boolean;
}

export async function decideOrder(deps: OrderDeps, orderId: string, decision: Decision, reason?: string | null): Promise<DecisionResult> {
  const rec = await deps.orders.get(orderId);
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

  // Approve: send the order exactly as priced when it was placed (the saved payload).
  const patch = { status: "pending" as const, decidedAt, decisionNote: note };
  await deps.orders.update(rec.id, patch);
  await tagDraft(deps, rec.draftOrderId, ["approved"], ["awaiting-approval"]);
  const sent = await sendToUnleashed(deps, { ...rec, ...patch });
  if (rec.buyerEmail) await sendEmail(deps, rec.buyerEmail, approvedEmail(summaryOf(sent), who), "order-approved");
  (deps.log ?? (() => {}))(`${rec.draftOrderName} approved by ${rec.approverEmail}`);
  return { order: sent, changed: true };
}
