import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { unauthenticated } from "../shopify.server";
import { graphqlFor, orderDeps, orderRepo } from "../orders.server";
import { verifyApprovalToken } from "../../src/orders/approvalToken.ts";
import { decideOrder } from "../../src/orders/approval.ts";
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
    },
  };
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  const form = await request.formData();
  const token = String(form.get("t") ?? "");
  const decision = form.get("decision") === "approve" ? "approve" : form.get("decision") === "reject" ? "reject" : null;
  if (!decision) return { error: "Choose approve or decline." };
  const r = await load(params.id ?? "", token);
  if ("error" in r) return { error: r.error };
  const { admin } = await unauthenticated.admin(r.order.shop);
  const result = await decideOrder(orderDeps(graphqlFor(admin)), r.order.id, decision, String(form.get("reason") ?? ""));
  if (!result.changed) return { done: `This order was already ${describe(result.order.status)}.` };
  return { done: decision === "approve" ? "Approved. The order has been sent to Clearchoice and the buyer has been emailed." : "Declined. The buyer has been emailed." };
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

        {/* Two columns so it fits a phone: product with "qty × unit price" underneath, and the line total. */}
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

        {result && "error" in result && <p style={{ color: RED, fontWeight: 700 }}>{result.error}</p>}
        {result && "done" in result && <p style={{ fontSize: 16, fontWeight: 700 }}>{result.done}</p>}

        {waiting ? (
          <Form method="post">
            <input type="hidden" name="t" value={data.token} />
            <label style={{ display: "block", margin: "16px 0 8px", fontSize: 15 }}>
              Note to the buyer (optional, shown if you decline)
              <textarea name="reason" rows={3} maxLength={500} style={{ display: "block", width: "100%", marginTop: 6, padding: 8, font: "inherit", boxSizing: "border-box" }} />
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 12 }}>
              <button type="submit" name="decision" value="approve" disabled={busy} style={btn(RED)}>Approve order</button>
              <button type="submit" name="decision" value="reject" disabled={busy} style={btn("#555")}>Decline</button>
            </div>
          </Form>
        ) : (
          !(result && "done" in result) && <p style={{ fontSize: 16 }}>This order has been <b>{describe(o.status)}</b>{o.decisionNote ? ` (${o.decisionNote})` : ""}.</p>
        )}
      </div>
    </div>
  );
}
