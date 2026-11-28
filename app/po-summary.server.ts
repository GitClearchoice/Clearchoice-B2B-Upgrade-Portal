// Daily email to Clearchoice staff (STAFF_EMAIL): trade orders in Unleashed still marked "PO REQUIRED".
// Before listing, each order is checked in Unleashed: once staff have entered the PO there as the
// Customer Reference, the order drops off (and the app records the PO).
import prisma from "./db.server";
import { emailer } from "./orders.server";
import { COMMITTED } from "./budget.server";
import { UnleashedClient, UnleashedError } from "../src/unleashed/client.ts";
import { needsPo, poRequiredSummaryEmail, type PoRequiredRow } from "../src/email/templates.ts";
import { sydneyDate } from "../src/pricing/engine.ts";

function unleashed() {
  const apiId = process.env.UNLEASHED_API_ID;
  const apiKey = process.env.UNLEASHED_API_KEY;
  if (!apiId || !apiKey) throw new Error("UNLEASHED_API_ID / UNLEASHED_API_KEY are not set");
  return new UnleashedClient({ apiId, apiKey, baseUrl: process.env.UNLEASHED_BASE_URL, clientType: process.env.UNLEASHED_CLIENT_TYPE });
}

/** The orders still waiting for a PO (checked against Unleashed). */
export async function openPoRequired(): Promise<PoRequiredRow[]> {
  const since = new Date(Date.now() - 180 * 86_400_000);
  const candidates = (await prisma.tradeOrder.findMany({
    where: { status: { in: COMMITTED }, createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
  })).filter((o) => needsPo(o.poNumber));
  if (!candidates.length) return [];
  const client = unleashed();
  const rows: PoRequiredRow[] = [];
  for (const o of candidates) {
    if (o.status === "sent") {
      try {
        const r = await client.get<{ Items?: { CustomerRef?: string | null; OrderStatus?: string | null }[]; CustomerRef?: string | null; OrderStatus?: string | null }>(`/SalesOrders/${o.id}`);
        const so = r.Items ? r.Items[0] : r;
        if (/deleted/i.test(so?.OrderStatus ?? "")) continue;
        const ref = (so?.CustomerRef ?? "").trim();
        if (ref && !needsPo(ref)) {
          await prisma.tradeOrder.update({ where: { id: o.id }, data: { poNumber: ref } }); // PO entered in Unleashed
          continue;
        }
      } catch (e) {
        if (e instanceof UnleashedError && e.status === 404) continue; // gone from Unleashed
        console.error(`[po-summary] couldn't check ${o.unleashedOrderNumber ?? o.id}: ${(e as Error).message}`);
      }
    }
    rows.push({
      placed: o.createdAt,
      unleashedOrderNumber: o.unleashedOrderNumber,
      reference: o.draftOrderName,
      companyName: o.companyName,
      siteName: o.siteName,
      buyerName: o.buyerName,
      buyerEmail: o.buyerEmail,
      poNumber: o.poNumber,
      goodsExGst: Number(o.goodsExGst.toString()),
    });
  }
  return rows;
}

/** Sends the summary if there's anything on it. Returns how many orders were listed. */
export async function sendPoSummary(): Promise<number> {
  const staff = process.env.STAFF_EMAIL;
  if (!staff) throw new Error("STAFF_EMAIL is not set");
  const rows = await openPoRequired();
  if (rows.length) {
    const e = poRequiredSummaryEmail(rows, new Date());
    await emailer().send({ to: staff, subject: e.subject, html: e.html, text: e.text, tag: "po-required-summary" });
  }
  return rows.length;
}

// Once a day from 8am Sydney time (checked every 30 minutes; the sent date is kept in the DB so a
// restart doesn't send it twice).
declare global {
  // eslint-disable-next-line no-var
  var poSummaryTimer: ReturnType<typeof setInterval> | undefined;
}
export function startPoSummaryLoop() {
  if (globalThis.poSummaryTimer || process.env.PO_SUMMARY_DISABLED === "1") return;
  const tick = async () => {
    try {
      const now = new Date();
      const hour = Number(new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Sydney", hour: "2-digit", hourCycle: "h23" }).format(now));
      const today = sydneyDate(now);
      if (hour < 8 || !process.env.STAFF_EMAIL) return;
      const state = await prisma.syncState.findUnique({ where: { id: 1 } });
      if (state?.poSummarySentOn === today) return;
      await prisma.syncState.upsert({ where: { id: 1 }, create: { id: 1, poSummarySentOn: today }, update: { poSummarySentOn: today } });
      const n = await sendPoSummary();
      console.log(`[po-summary] ${today}: ${n} order(s) waiting for a PO${n ? ", emailed" : ", nothing sent"}`);
    } catch (e) {
      console.error(`[po-summary] ${(e as Error).message}`);
    }
  };
  globalThis.poSummaryTimer = setInterval(tick, 30 * 60_000);
  setTimeout(tick, 60_000);
}
