import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { priceLines, priceStore } from "../pricing.server";
import { parseLinesParam } from "../../src/b2b/buyer.ts";
import { sendPoSummary } from "../po-summary.server";

// Staff home: sync status and a price check (same engine and data the storefront uses).

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const [state, row] = await Promise.all([
    priceStore.getState(),
    prisma.syncState.findUnique({ where: { id: 1 } }),
  ]);
  return { state, lastError: row?.lastError ?? null };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") === "po-summary") {
    try {
      const n = await sendPoSummary();
      return { poSummary: n ? `Sent: ${n} order(s) waiting for a PO.` : "No orders are waiting for a PO, so nothing was sent." };
    } catch (e) {
      return { poSummary: `Couldn't send: ${(e as Error).message}` };
    }
  }
  const customer = String(form.get("customer") ?? "").trim();
  try {
    const lines = parseLinesParam(String(form.get("lines") ?? "").replace(/\s+/g, ","));
    if (!customer || lines.length === 0) return { error: "Enter a customer code and at least one SKU:QTY" };
    const r = await priceLines(priceStore, customer, lines);
    return { customer, ...r };
  } catch (e) {
    return { error: (e as Error).message };
  }
};

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-AU", { timeZone: "Australia/Sydney" }) : "never";
const money = (n: number) => `$${n.toFixed(2)}`;

export default function Index() {
  const { state, lastError } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === "submitting";

  return (
    <s-page heading="Clearchoice B2B Portal">
      <s-section heading="Unleashed sync">
        <s-paragraph>Last full sync: {fmt(state.lastFullSyncAt)}</s-paragraph>
        <s-paragraph>Last changes sync: {fmt(state.lastChangeSyncAt)}</s-paragraph>
        <s-paragraph>
          {state.counts.products} products, {state.counts.customers} customers, {state.counts.rules} customer
          price lines, {state.counts.quantityPrices} quantity prices
        </s-paragraph>
        {lastError && <s-banner tone="critical">Last sync failed: {lastError}</s-banner>}
      </s-section>

      <s-section heading="Orders waiting for a PO">
        <s-paragraph>
          Every morning from 8am your team (STAFF_EMAIL) gets a list of trade orders sent as "PO REQUIRED" that still
          have no PO in Unleashed. Enter the PO as the order's Customer Reference in Unleashed and it drops off the list.
        </s-paragraph>
        <Form method="post">
          <input type="hidden" name="intent" value="po-summary" />
          <s-button type="submit" variant="secondary">Send the summary now</s-button>
        </Form>
        {result && "poSummary" in result && <s-banner tone="info">{result.poSummary}</s-banner>}
      </s-section>

      <s-section heading="Price check">
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-text-field label="Unleashed customer code" name="customer" />
            <s-text-field label="Lines (SKU:QTY, separated by spaces or commas)" name="lines" placeholder="1-CT-0014:1 1-CT-0014:48" />
            <s-button type="submit" {...(busy ? { loading: true } : {})}>Check prices</s-button>
          </s-stack>
        </Form>
        {result && "error" in result && <s-banner tone="critical">{result.error}</s-banner>}
        {result && "lines" in result && (
          <s-table>
            <s-table-header-row>
              <s-table-header>SKU</s-table-header>
              <s-table-header>Qty</s-table-header>
              <s-table-header>Unit ex GST</s-table-header>
              <s-table-header>Line ex GST</s-table-header>
              <s-table-header>Why</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {result.lines.map((l, i) => (
                <s-table-row key={i}>
                  <s-table-cell>{l.productCode}</s-table-cell>
                  <s-table-cell>{l.quantity}</s-table-cell>
                  <s-table-cell>{money(l.unitExGst)}</s-table-cell>
                  <s-table-cell>{money(l.lineExGst)}</s-table-cell>
                  <s-table-cell>{l.detail}</s-table-cell>
                </s-table-row>
              ))}
              {result.errors.map((e, i) => (
                <s-table-row key={`e${i}`}>
                  <s-table-cell>{e.sku}</s-table-cell>
                  <s-table-cell />
                  <s-table-cell />
                  <s-table-cell />
                  <s-table-cell>{e.error}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
