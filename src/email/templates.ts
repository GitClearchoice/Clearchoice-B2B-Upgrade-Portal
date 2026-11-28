// Order emails. Plain, table-free HTML that reads well in Outlook and on phones, plus a text version.
import { monthLabel } from "../orders/budget.ts";

export interface OrderSummary {
  reference: string | null; // Shopify draft name, e.g. "#D12"
  unleashedOrderNumber?: string | null;
  companyName: string;
  siteName: string;
  poNumber: string;
  buyerName: string;
  note?: string | null;
  goodsExGst: number;
  lines: { sku: string; title?: string; quantity: number; unitExGst: number; lineExGst: number }[];
}

export interface BudgetLine {
  month: string; // YYYY-MM
  budget: number;
  committed: number;
}

const BRAND = "#e40046";
const money = (n: number) => "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(title: string, body: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><meta charset="utf-8"></head><body style="margin:0;padding:12px;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#222">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;padding:20px 16px">
<h1 style="font-size:20px;margin:0 0 16px;color:${BRAND}">${esc(title)}</h1>
${body}
<p style="font-size:12px;color:#777;margin-top:24px">Clearchoice Products · Trade portal</p>
</div></body></html>`;
}

// Two columns (product with "qty × unit price" underneath, and the line total), so it fits a phone
// screen in every mail app without media queries.
function linesHtml(o: OrderSummary): string {
  const cell = "padding:8px 6px;border-bottom:1px solid #eee;vertical-align:top";
  const rows = o.lines
    .map(
      (l) => `<tr><td style="${cell}"><b>${esc(l.title || l.sku)}</b><br><span style="color:#777;font-size:12px">${esc(l.sku)}</span><br><span style="font-size:13px">${l.quantity} × ${money(l.unitExGst)} ex GST</span></td>
<td style="${cell};text-align:right;white-space:nowrap">${money(l.lineExGst)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin:12px 0">
<tr><th style="text-align:left;padding:6px;border-bottom:2px solid #ddd">Product</th><th style="text-align:right;padding:6px;border-bottom:2px solid #ddd;white-space:nowrap">Total ex GST</th></tr>
${rows}
<tr><td style="padding:8px 6px;text-align:right;font-weight:bold">Goods total ex GST</td><td style="padding:8px 6px;text-align:right;font-weight:bold;white-space:nowrap">${money(o.goodsExGst)}</td></tr>
</table>`;
}

function detailsHtml(o: OrderSummary): string {
  const row = (k: string, v: unknown) => (v ? `<tr><td style="padding:3px 12px 3px 0;color:#777;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:3px 0">${esc(v)}</td></tr>` : "");
  return `<table style="font-size:14px;margin:8px 0">${row("Company", o.companyName)}${row("Site", o.siteName)}${row("PO number", o.poNumber)}${row("Ordered by", o.buyerName)}${row("Reference", o.reference)}${row("Unleashed order", o.unleashedOrderNumber)}${row("Delivery note", o.note)}</table>`;
}

function linesText(o: OrderSummary): string {
  return (
    o.lines.map((l) => `  ${l.quantity} x ${l.title || l.sku} (${l.sku}) @ ${money(l.unitExGst)} = ${money(l.lineExGst)}`).join("\n") +
    `\n  Goods total ex GST: ${money(o.goodsExGst)}`
  );
}

function detailsText(o: OrderSummary): string {
  return [
    `Company: ${o.companyName}`,
    `Site: ${o.siteName}`,
    `PO number: ${o.poNumber}`,
    `Ordered by: ${o.buyerName}`,
    o.reference ? `Reference: ${o.reference}` : "",
    o.unleashedOrderNumber ? `Unleashed order: ${o.unleashedOrderNumber}` : "",
    o.note ? `Delivery note: ${o.note}` : "",
  ].filter(Boolean).join("\n");
}

function budgetHtml(b: BudgetLine, orderExGst: number): string {
  const after = b.committed + orderExGst;
  return `<p style="font-size:14px;background:#fff4f6;border-left:4px solid ${BRAND};padding:10px 12px">
${esc(monthLabel(b.month))} budget for this site: <b>${money(b.budget)}</b><br>
Already ordered this month: ${money(b.committed)}<br>
This order: ${money(orderExGst)}<br>
<b>Over budget by ${money(after - b.budget)}</b></p>`;
}

function budgetText(b: BudgetLine, orderExGst: number): string {
  const after = b.committed + orderExGst;
  return `${monthLabel(b.month)} budget for this site: ${money(b.budget)}\nAlready ordered this month: ${money(b.committed)}\nThis order: ${money(orderExGst)}\nOver budget by ${money(after - b.budget)}`;
}

export interface Email { subject: string; html: string; text: string }

export function orderReceivedEmail(o: OrderSummary): Email {
  const subject = `Order received: PO ${o.poNumber} for ${o.siteName}`;
  const intro = `Thanks ${o.buyerName}, we've received your order and it's on its way to our team.`;
  return {
    subject,
    html: layout("Order received", `<p>${esc(intro)}</p>${detailsHtml(o)}${linesHtml(o)}<p style="font-size:13px;color:#555">Prices are ex GST. Your order is charged to your account and invoiced on your usual terms.</p>`),
    text: `${intro}\n\n${detailsText(o)}\n\n${linesText(o)}\n\nPrices are ex GST. Your order is charged to your account and invoiced on your usual terms.`,
  };
}

export function awaitingApprovalEmail(o: OrderSummary, approverName: string): Email {
  const subject = `Waiting for approval: PO ${o.poNumber} for ${o.siteName}`;
  const intro = `Your order would take ${o.siteName} over its monthly budget, so it has been sent to ${approverName} for approval. We'll email you as soon as it's approved or declined.`;
  return {
    subject,
    html: layout("Order waiting for approval", `<p>${esc(intro)}</p>${detailsHtml(o)}${linesHtml(o)}`),
    text: `${intro}\n\n${detailsText(o)}\n\n${linesText(o)}`,
  };
}

export function approvalRequestEmail(o: OrderSummary, b: BudgetLine, approverName: string, links: { review: string }): Email {
  const subject = `Approval needed: ${o.siteName} order over budget (PO ${o.poNumber})`;
  const intro = `Hi ${approverName}, ${o.buyerName} has placed an order for ${o.siteName} that would take the site over its monthly budget. Please review it: you can change quantities or remove items, then approve or decline.`;
  const poNote = needsPo(o.poNumber) ? `The buyer doesn't have a PO number yet. Please provide the PO number on the review page before approving.` : "";
  const button = `<p style="margin:20px 0"><a href="${esc(links.review)}" style="display:inline-block;background:${BRAND};color:#fff;font-weight:bold;font-size:16px;text-decoration:none;padding:12px 24px;border-radius:6px">Review order</a></p>`;
  return {
    subject,
    html: layout("Order needs your approval", `<p>${esc(intro)}</p>${poNote ? `<p style="background:#fff8e1;border-left:4px solid #f0b400;padding:10px 12px;font-size:14px"><b>No PO yet.</b> ${esc(poNote.replace(/^The buyer doesn't have a PO number yet\. /, "The buyer doesn't have a PO number. "))}</p>` : ""}${budgetHtml(b, o.goodsExGst)}${button}${detailsHtml(o)}${linesHtml(o)}<p style="font-size:12px;color:#777">If the button doesn't work, copy this link into your browser:<br><span style="word-break:break-all">${esc(links.review)}</span></p>`),
    text: `${intro}${poNote ? `\n\n${poNote}` : ""}\n\n${budgetText(b, o.goodsExGst)}\n\nReview and approve or decline: ${links.review}\n\n${detailsText(o)}\n\n${linesText(o)}`,
  };
}

export function approvedEmail(o: OrderSummary, approverName: string, changes: string[] = []): Email {
  const subject = `Approved${changes.length ? " with changes" : ""}: PO ${o.poNumber} for ${o.siteName}`;
  const intro = changes.length
    ? `${approverName} approved your order with some changes (below). It's on its way to our team.`
    : `Good news: ${approverName} approved your order. It's on its way to our team.`;
  const changeHtml = changes.length ? `<p style="background:#fff8e1;border-left:4px solid #f0b400;padding:10px 12px;font-size:14px"><b>Changes:</b><br>${changes.map(esc).join("<br>")}</p>` : "";
  return {
    subject,
    html: layout(changes.length ? "Order approved with changes" : "Order approved", `<p>${esc(intro)}</p>${changeHtml}${detailsHtml(o)}${linesHtml(o)}`),
    text: `${intro}\n${changes.length ? `\nChanges:\n${changes.map((c) => `- ${c}`).join("\n")}\n` : ""}\n${detailsText(o)}\n\n${linesText(o)}`,
  };
}

/** True when the buyer had no PO ("PO REQUIRED - <name>"; earlier orders used "PO TO FOLLOW - <name>"). */
export const needsPo = (po: string) => /^PO (REQUIRED|TO FOLLOW)\b/i.test(po.trim());

export function rejectedEmail(o: OrderSummary, approverName: string, reason: string | null): Email {
  const subject = `Declined: PO ${o.poNumber} for ${o.siteName}`;
  const intro = `${approverName} declined your order, so it hasn't been sent to Clearchoice.`;
  const why = reason ? `Reason: ${reason}` : "";
  return {
    subject,
    html: layout("Order declined", `<p>${esc(intro)}</p>${why ? `<p><b>${esc(why)}</b></p>` : ""}${detailsHtml(o)}${linesHtml(o)}<p style="font-size:13px;color:#555">You can place a new order from the trade portal if needed.</p>`),
    text: `${intro}\n${why ? `\n${why}\n` : ""}\n${detailsText(o)}\n\n${linesText(o)}\n\nYou can place a new order from the trade portal if needed.`,
  };
}

export function unleashedFailedEmail(o: OrderSummary, attempts: number, error: string, finalAttempt: boolean): Email {
  const subject = `${finalAttempt ? "ACTION NEEDED: trade order not sent" : "Trade order retrying"}: ${o.reference ?? ""} ${o.companyName} PO ${o.poNumber}`;
  const intro = finalAttempt
    ? `This trade order couldn't be sent to Unleashed after ${attempts} attempts and won't be retried. Please enter it in Unleashed by hand (or fix the problem and contact the developer).`
    : `This trade order couldn't be sent to Unleashed (attempt ${attempts}). It will be retried automatically every 5 minutes. The buyer has been told the order was received.`;
  return {
    subject,
    html: layout(finalAttempt ? "Trade order not sent to Unleashed" : "Trade order retrying", `<p>${esc(intro)}</p><p style="font-family:monospace;font-size:12px;background:#f5f5f5;padding:8px">${esc(error)}</p>${detailsHtml(o)}${linesHtml(o)}`),
    text: `${intro}\n\nError: ${error}\n\n${detailsText(o)}\n\n${linesText(o)}`,
  };
}

export function siteClosedEmail(p: { companyName: string; siteName: string; customerCode: string | null; closedBy: string; reason?: string | null }): Email {
  const subject = `Site closed by customer: ${p.companyName} – ${p.siteName}`;
  const intro = `${p.closedBy} has closed the delivery site "${p.siteName}" for ${p.companyName} in the trade portal. It's no longer available for ordering. Please mark the delivery address obsolete in Unleashed${p.customerCode ? ` (customer ${p.customerCode})` : ""}.`;
  return {
    subject,
    html: layout("Delivery site closed", `<p>${esc(intro)}</p>${p.reason ? `<p>Their note: <b>${esc(p.reason)}</b></p>` : ""}<p style="font-size:13px;color:#555">If this was a mistake, reopen the site from the app's Site budgets page (Show closed sites).</p>`),
    text: `${intro}\n${p.reason ? `\nTheir note: ${p.reason}\n` : ""}\nIf this was a mistake, reopen the site from the app's Site budgets page (Show closed sites).`,
  };
}

/** To Clearchoice staff when a trade order with a PO reaches Unleashed (directly, or once approved). */
export function newTradeOrderEmail(o: OrderSummary, approval: { approverName: string; changes: string | null } | null): Email {
  const so = o.unleashedOrderNumber ? `${o.unleashedOrderNumber}: ` : "";
  const subject = `New trade order ${so}${o.companyName} – ${o.siteName} – PO ${o.poNumber}`;
  const intro = `A trade order has arrived in Unleashed${o.unleashedOrderNumber ? ` as ${o.unleashedOrderNumber}` : ""} (Parked).`;
  const approvedLine = approval ? `Over budget: approved by ${approval.approverName}.${approval.changes ? ` ${approval.changes}` : ""}` : "";
  return {
    subject,
    html: layout("New trade order", `<p>${esc(intro)}</p>${approvedLine ? `<p style="background:#fff8e1;border-left:4px solid #f0b400;padding:10px 12px;font-size:14px">${esc(approvedLine)}</p>` : ""}${detailsHtml(o)}${linesHtml(o)}`),
    text: `${intro}${approvedLine ? `\n\n${approvedLine}` : ""}\n\n${detailsText(o)}\n\n${linesText(o)}`,
  };
}

export interface PoRequiredRow {
  placed: Date;
  unleashedOrderNumber: string | null;
  reference: string | null;
  companyName: string;
  siteName: string;
  buyerName: string;
  buyerEmail: string | null;
  poNumber: string;
  goodsExGst: number;
}

/** Daily list for Clearchoice staff: trade orders in Unleashed still waiting for a PO number. */
export function poRequiredSummaryEmail(rows: PoRequiredRow[], now: Date): Email {
  const days = (d: Date) => Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86_400_000));
  const date = (d: Date) => d.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", day: "numeric", month: "short" });
  const subject = `${rows.length} trade order${rows.length === 1 ? "" : "s"} waiting for a PO number`;
  const intro = `These trade orders went to Unleashed as "PO REQUIRED" and still have no PO number. Please request the PO from the buyer and enter it as the Customer Reference in Unleashed; they drop off this list once it's there.`;
  const cell = "padding:8px 6px;border-bottom:1px solid #eee;vertical-align:top";
  const html = layout("Orders waiting for a PO number", `<p>${esc(intro)}</p>
<table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;margin:12px 0">
${rows.map((r) => `<tr><td style="${cell}"><b>${esc(r.unleashedOrderNumber ?? r.reference ?? "")}</b> · ${esc(r.companyName)}<br>${esc(r.siteName)}<br><span style="font-size:13px">${esc(r.buyerName)}${r.buyerEmail ? ` &lt;${esc(r.buyerEmail)}&gt;` : ""}</span><br><span style="font-size:12px;color:#777">Placed ${esc(date(r.placed))} · ${days(r.placed)} day${days(r.placed) === 1 ? "" : "s"} waiting</span></td><td style="${cell};text-align:right;white-space:nowrap">${money(r.goodsExGst)}</td></tr>`).join("")}
</table>`);
  const text = `${intro}\n\n${rows.map((r) => `${r.unleashedOrderNumber ?? r.reference ?? ""} | ${r.companyName} – ${r.siteName} | ${r.buyerName}${r.buyerEmail ? ` <${r.buyerEmail}>` : ""} | placed ${date(r.placed)} (${days(r.placed)} days) | ${money(r.goodsExGst)} ex GST`).join("\n")}`;
  return { subject, html, text };
}

/** To someone a head-office admin has given ordering access in the trade portal. */
export function siteAccessEmail(p: { name: string; companyName: string; adminName: string; role: string; sites: string[]; loginUrl: string }): Email {
  const subject = `You can now order for ${p.companyName} in the Clearchoice trade portal`;
  const sitesText = p.sites.length > 6 ? `${p.sites.slice(0, 6).join(", ")} and ${p.sites.length - 6} more` : p.sites.join(", ");
  const intro = `Hi ${p.name}, ${p.adminName} has given you ${p.role === "admin" ? "location admin" : "ordering"} access for ${p.companyName}: ${sitesText}.`;
  const how = `Log in with this email address at ${p.loginUrl} (we'll email you a one-time code). You'll see your trade prices and can place orders for your site${p.sites.length === 1 ? "" : "s"}.`;
  return {
    subject,
    html: layout("Trade portal access", `<p>${esc(intro)}</p><p>${esc(how)}</p><p style="margin:20px 0"><a href="${esc(p.loginUrl)}" style="display:inline-block;background:${BRAND};color:#fff;font-weight:bold;font-size:16px;text-decoration:none;padding:12px 24px;border-radius:6px">Log in</a></p>`),
    text: `${intro}\n\n${how}`,
  };
}

/** To Clearchoice staff when a head-office admin changes who can order for their sites. */
export function teamChangeEmail(p: { companyName: string; adminName: string; change: string }): Email {
  const subject = `Site access changed: ${p.companyName}`;
  const intro = `${p.adminName} changed who can order for ${p.companyName}:`;
  return { subject, html: layout("Site access changed", `<p>${esc(intro)}</p><p><b>${esc(p.change)}</b></p>`), text: `${intro}\n\n${p.change}` };
}
