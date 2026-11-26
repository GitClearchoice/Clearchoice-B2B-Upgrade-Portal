import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSalesOrder } from "../src/unleashed/salesOrder.ts";
import { UnleashedClient } from "../src/unleashed/client.ts";
import { signQuery } from "../src/unleashed/signature.ts";
import type { ResolvedPrice } from "../src/pricing/types.ts";

const line = (code: string, qty: number, unit: number): ResolvedPrice => ({
  productCode: code, customerCode: "C", quantity: qty, unitExGst: unit, unitIncGst: Math.round(unit * 110) / 100,
  lineExGst: Math.round(unit * qty * 100) / 100, source: "tier", detail: "",
});
const base = {
  guid: "11111111-2222-3333-4444-555555555555",
  customerCode: "ASSETLINKSERVICESPTYLTD",
  poNumber: " PO-123 ",
  site: { name: "Western Sydney International Airport", address: { address1: "100 Eaton Rd", city: "Badgerys Creek", zoneCode: "NSW", zip: "2555", countryCode: "AU" } },
  warehouse: { Guid: "w1", WarehouseCode: "CCW", WarehouseName: "Clearchoice Warehouse" },
  taxCode: "G.S.T.", taxRate: 0.1, status: "Parked",
  orderDate: new Date("2026-11-26T00:00:00Z"),
};

test("sales order: customer, PO as Customer Reference, site as delivery name, Parked, warehouse, tax", () => {
  const o = buildSalesOrder({ ...base, lines: [line("1-CT-0014", 2, 35.77)], taxable: () => true });
  assert.equal(o.Customer.CustomerCode, "ASSETLINKSERVICESPTYLTD");
  assert.equal(o.CustomerRef, "PO-123");
  assert.equal(o.DeliveryName, "Western Sydney International Airport");
  assert.deepEqual([o.DeliveryStreetAddress, o.DeliverySuburb, o.DeliveryRegion, o.DeliveryPostCode, o.DeliveryCountry], ["100 Eaton Rd", "Badgerys Creek", "NSW", "2555", "Australia"]);
  assert.equal(o.OrderStatus, "Parked");
  assert.equal(o.Warehouse.WarehouseName, "Clearchoice Warehouse");
  assert.deepEqual(o.Tax, { TaxCode: "G.S.T." });
  assert.equal(o.TaxRate, 0.1);
  assert.equal(o.ExchangeRate, 1);
  assert.equal(o.Guid, base.guid);
});

test("sales order totals: SubTotal = sum of lines, TaxTotal = sum of line tax, Total = both; GST-free lines get no tax", () => {
  const o = buildSalesOrder({
    ...base,
    lines: [line("A", 3, 19.99), line("B", 1, 0.05), line("FREE", 2, 10)],
    taxable: (c) => c !== "FREE",
  });
  assert.deepEqual(o.SalesOrderLines.map((l) => [l.LineTotal, l.LineTax]), [[59.97, 6.0], [0.05, 0.01], [20, 0]]);
  assert.equal(o.SubTotal, 80.02);
  assert.equal(o.TaxTotal, 6.01);
  assert.equal(o.Total, 86.03);
  assert.equal(o.SalesOrderLines[2].LineTaxCode, undefined);
});

test("sales order refuses empty lines or a blank PO", () => {
  assert.throws(() => buildSalesOrder({ ...base, lines: [], taxable: () => true }), /at least one line/);
  assert.throws(() => buildSalesOrder({ ...base, poNumber: "  ", lines: [line("A", 1, 1)], taxable: () => true }), /PO number/);
});

test("client POST: signs the empty query string, sends JSON, doesn't retry a 500", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response("boom", { status: 500 });
  }) as unknown as typeof fetch;
  const client = new UnleashedClient({ apiId: "id", apiKey: "key", fetch: fn, sleep: async () => {} });
  await assert.rejects(client.post("/SalesOrders/abc", { a: 1 }), /POST \/SalesOrders\/abc failed: 500/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, JSON.stringify({ a: 1 }));
  assert.equal((calls[0].init.headers as Record<string, string>)["api-auth-signature"], signQuery("", "key"));
});
