import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { unauthenticated } from "../shopify.server";
import { graphqlFor, orderDeps, orderRepo } from "../orders.server";
import { verifyApprovalToken } from "../../src/orders/approvalToken.ts";
import { decideOrder, reviseOrder, type Revision } from "../../src/orders/approval.ts";
import { OrderError } from "../../src/orders/placeOrder.ts";
import { needsPo } from "../../src/email/templates.ts";
import { monthLabel, sydneyMonth } from "../../src/orders/budget.ts";

// The head-office admin's approve/decline page, opened from the approval email.
// Public (no Shopify login): access is the signed token in the link.

export const meta: MetaFunction = () => [{ title: "Order approval · Clearchoice" }, { name: "robots", content: "noindex" }];

async function load(id: string, token: string) {
  const secret = process.env.SHOPIFY_API_SECRET ?? "";
  const check = verifyApprovalToken(id, token, secret);
  if (check !== "ok") return { error: check === "expired" ? "This approval link has expired. Please contact Clearchoice." : "This approval link isn't valid." } as const;
  const order = await orderRepo.get(id);
  if (!order) return { error: "This order can't be found." } as const;
  return { order } as const;
}

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const r = await load(params.id ?? "", token);
  if ("error" in r) return { error: r.error };
  const o = r.order;
  return {
    token,
    order: {
      reference: o.draftOrderName,
      companyName: o.companyName,
      siteName: o.siteName,
      buyerName: o.buyerName,
      poNumber: o.poNumber,
      note: o.note,
      goodsExGst: o.goodsExGst,
      lines: o.lines,
      status: o.status,
      budget: o.budgetExGst,
      committedBefore: o.committedBeforeExGst,
      month: monthLabel(sydneyMonth(new Date(o.createdAt))),
      placed: new Date(o.createdAt).toLocaleString("en-AU", { timeZone: "Australia/Sydney", dateStyle: "medium", timeStyle: "short" }),
      decisionNote: o.decisionNote,
      unleashedOrderNumber: o.unleashedOrderNumber,
      needsPo: needsPo(o.poNumber),
    },
  };
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  const form = await request.formData();
  const token = String(form.get("t") ?? "");
  const intent = String(form.get("decision") ?? "");
  if (!["approve", "reject", "update"].includes(intent)) return { error: "Choose approve, update or decline." };
  const r = await load(params.id ?? "", token);
  if ("error" in r) return { error: r.error };

  // The approver's changes: PO number and a quantity per line (0 removes it).
  const rev: Revision = { poNumber: String(form.get("poNumber") ?? ""), quantities: {} };
  r.order.lines.forEach((_, i) => {
    const raw = form.get(`qty${i}`);
    if (raw !== null && String(raw).trim() !== "") rev.quantities![i] = Number(String(raw).trim());
  });

  const { admin } = await unauthenticated.admin(r.order.shop);
  const deps = orderDeps(graphqlFor(admin));
  try {
    if (intent === "update") {
      if (r.order.status !== "awaiting-approval") return { done: `This order was already ${describe(r.order.status)}.` };
      const { changes } = await reviseOrder(deps, r.order, rev);
      return { updated: changes.length ? `Order updated: ${changes.join("; ")}. Approve it when you're ready.` : "Nothing changed." };
    }
    const result = await decideOrder(deps, r.order.id, intent as "approve" | "reject", String(form.get("reason") ?? ""), intent === "approve" ? rev : undefined);
    if (!result.changed) return { done: `This order was already ${describe(result.order.status)}.` };
    if (intent === "reject") return { done: "Declined. The buyer has been emailed." };
    return {
      done: `Approved${result.changes?.length ? " with your changes" : ""}. The order has been sent to Clearchoice and the buyer has been emailed.`,
    };
  } catch (e) {
    if (e instanceof OrderError) return { error: e.message };
    throw e;
  }
};

function describe(status: string) {
  if (status === "rejected") return "declined";
  if (status === "awaiting-approval") return "waiting for approval";
  return "approved";
}

const money = (n: number) => "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const RED = "#e40046";
const box: React.CSSProperties = { maxWidth: 720, margin: "12px auto", padding: "20px 16px", background: "#fff", borderRadius: 8, fontFamily: "Arial, Helvetica, sans-serif", color: "#222", boxShadow: "0 2px 12px rgba(0,0,0,.08)" };
const cell: React.CSSProperties = { padding: "6px 8px", borderBottom: "1px solid #eee" };
const num: React.CSSProperties = { ...cell, textAlign: "right", whiteSpace: "nowrap" };
const btn = (bg: string): React.CSSProperties => ({ background: bg, color: "#fff", border: 0, borderRadius: 6, padding: "12px 24px", fontSize: 16, fontWeight: 700, cursor: "pointer" });

export default function Approval() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === "submitting";

  if ("error" in data) {
    return <div style={{ background: "#f5f5f5", minHeight: "100vh", padding: 1 }}><div style={box}><h1 style={{ color: RED, fontSize: 22 }}>Order approval</h1><p>{data.error}</p></div></div>;
  }
  const o = data.order;
  const after = (o.committedBefore ?? 0) + o.goodsExGst;
  const waiting = o.status === "awaiting-approval" && !(result && "done" in result);

  return (
    <div style={{ background: "#f5f5f5", minHeight: "100vh", padding: 1 }}>
      <div style={box}>
        <h1 style={{ color: RED, fontSize: 22, marginTop: 0 }}>Order approval</h1>
        <table style={{ fontSize: 15, marginBottom: 12 }}>
          <tbody>
            {[["Company", o.companyName], ["Site", o.siteName], ["Ordered by", o.buyerName], ["Placed", o.placed], ["PO number", o.poNumber], ["Reference", o.reference], ["Delivery note", o.note]]
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <tr key={k}><td style={{ color: "#777", paddingRight: 16, whiteSpace: "nowrap", verticalAlign: "top" }}>{k}</td><td>{v}</td></tr>
              ))}
          </tbody>
        </table>

        {o.budget != null && (
          <div style={{ background: "#fff4f6", borderLeft: `4px solid ${RED}`, padding: "10px 12px", fontSize: 15, margin: "12px 0" }}>
            {o.month} budget for this site: <b>{money(o.budget)}</b><br />
            Already ordered this month (when placed): {money(o.committedBefore ?? 0)}<br />
            This order: {money(o.goodsExGst)}<br />
            <b>{after > o.budget ? `Over budget by ${money(after - o.budget)}` : "Within budget"}</b>
          </div>
        )}

        {result && "error" in result && <p style={{ color: RED, fontWeight: 700 }}>{result.error}</p>}
        {result && "updated" in result && <p style={{ background: "#fff8e1", borderLeft: "4px solid #f0b400", padding: "10px 12px", fontSize: 15 }}>{result.updated}</p>}
        {result && "done" in result && <p style={{ fontSize: 16, fontWeight: 700 }}>{result.done}</p>}

        {waiting ? (
          // Re-mounted whenever the order changes, so the boxes always match the current lines.
          <Form method="post" key={o.lines.map((l) => `${l.variantId}:${l.quantity}`).join(",") + "|" + o.poNumber}>
            <input type="hidden" name="t" value={data.token} />

            <label style={{ display: "block", margin: "16px 0 8px", fontSize: 15, fontWeight: 600 }}>
              Purchase order number
              {o.needsPo && <span style={{ display: "block", fontWeight: 400, fontSize: 14, color: "#8a5a00", marginTop: 4 }}>The buyer doesn't have a PO number yet ({o.poNumber}). Enter it here if you have it.</span>}
              <input
                name="poNumber"
                defaultValue={o.needsPo ? "" : o.poNumber}
                placeholder={o.needsPo ? "Enter the PO number" : ""}
                maxLength={100}
                style={{ display: "block", width: "100%", marginTop: 6, padding: 10, font: "inherit", boxSizing: "border-box", border: "1px solid #999", borderRadius: 6 }}
              />
            </label>

            {/* Two columns so it fits a phone: product with quantity box and unit price, and the line total. */}
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, margin: "12px 0" }}>
              <thead><tr><th style={{ ...cell, textAlign: "left" }}>Product</th><th style={num}>Total ex GST</th></tr></thead>
              <tbody>
                {o.lines.map((l, i) => (
                  <tr key={i}>
                    <td style={cell}>
                      <b>{l.title || l.sku}</b><br /><small style={{ color: "#777" }}>{l.sku}</small>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                        <label style={{ fontSize: 13 }}>
                          Qty{" "}
                          <input name={`qty${i}`} type="number" inputMode="numeric" min={0} max={100000} defaultValue={l.quantity}
                            style={{ width: 72, padding: "6px 8px", font: "inherit", border: "1px solid #999", borderRadius: 6 }} />
                        </label>
                        <span style={{ fontSize: 13 }}>× {money(l.unitExGst)} ex GST</span>
                      </div>
                    </td>
                    <td style={{ ...num, verticalAlign: "top" }}>{money(l.lineExGst)}</td>
                  </tr>
                ))}
                <tr><td style={{ ...num, fontWeight: 700 }}>Goods total ex GST</td><td style={{ ...num, fontWeight: 700 }}>{money(o.goodsExGst)}</td></tr>
              </tbody>
            </table>
            <p style={{ fontSize: 13, color: "#555", marginTop: 0 }}>
              To change the order, edit the quantities (0 removes an item) and tap <b>Update totals</b> to see the new prices,
              or just tap <b>Approve order</b> to approve it with your changes. Quantity prices are worked out again.
            </p>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 12 }}>
              <button type="submit" name="decision" value="approve" disabled={busy} style={btn(RED)}>Approve order</button>
              <button type="submit" name="decision" value="update" disabled={busy} style={btn("#1f5fa8")}>Update totals</button>
            </div>

            <label style={{ display: "block", margin: "20px 0 8px", fontSize: 15 }}>
              Note to the buyer (optional, shown if you decline)
              <textarea name="reason" rows={3} maxLength={500} style={{ display: "block", width: "100%", marginTop: 6, padding: 8, font: "inherit", boxSizing: "border-box" }} />
            </label>
            <button type="submit" name="decision" value="reject" disabled={busy} style={btn("#555")}>Decline</button>
          </Form>
        ) : (
          <>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, margin: "12px 0" }}>
              <thead><tr><th style={{ ...cell, textAlign: "left" }}>Product</th><th style={num}>Total ex GST</th></tr></thead>
              <tbody>
                {o.lines.map((l, i) => (
                  <tr key={i}>
                    <td style={cell}><b>{l.title || l.sku}</b><br /><small style={{ color: "#777" }}>{l.sku}</small><br /><span style={{ fontSize: 13 }}>{l.quantity} × {money(l.unitExGst)} ex GST</span></td>
                    <td style={{ ...num, verticalAlign: "top" }}>{money(l.lineExGst)}</td>
                  </tr>
                ))}
                <tr><td style={{ ...num, fontWeight: 700 }}>Goods total ex GST</td><td style={{ ...num, fontWeight: 700 }}>{money(o.goodsExGst)}</td></tr>
              </tbody>
            </table>
            {!(result && "done" in result) && <p style={{ fontSize: 16 }}>This order has been <b>{describe(o.status)}</b>{o.decisionNote ? ` (${o.decisionNote})` : ""}.</p>}
          </>
        )}
      </div>
    </div>
  );
}
