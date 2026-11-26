// Phase 3, step 1: send ONE test trade order straight to the Unleashed SANDBOX and check it there.
//   npm run order:test                         dry run: shows the order it would send (nothing sent)
//   npm run order:test -- --send               sends it
// Options (defaults in brackets):
//   --customer CODE   [ASSETLINKSERVICESPTYLTD]
//   --site "TEXT"     [Western Sydney International]  part of the Delivery tab site name
//   --sku CODE        [1-CT-0014]
//   --qty N           [2]
//   --po TEXT         [TEST-PO-<date>]
// Prices come from the last sync (npm run sync), the same way the portal will price orders.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { FileStore } from "../src/sync/store.ts";
import { priceLines } from "../src/index.ts";
import { siteName, toShopifyAddress, PostcodeLookup } from "../src/b2b/address.ts";
import { activeDeliveryAddresses } from "../src/b2b/candidates.ts";
import { buildSalesOrder } from "../src/unleashed/salesOrder.ts";
import { loadConfig } from "./config.ts";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const send = args.includes("--send");
const customerCode = opt("customer", "ASSETLINKSERVICESPTYLTD");
const siteSearch = opt("site", "Western Sydney International");
const sku = opt("sku", "1-CT-0014");
const qty = Number(opt("qty", "2"));
const po = opt("po", `TEST-PO-${new Date().toISOString().slice(0, 10)}`);

const status = process.env.UNLEASHED_ORDER_STATUS ?? "Parked";
const warehouseName = process.env.UNLEASHED_WAREHOUSE ?? "Clearchoice Factory";
const taxCode = process.env.UNLEASHED_TAX_CODE ?? "GST on Income";
const taxRate = Number(process.env.UNLEASHED_TAX_RATE ?? 0.1);

const { client, snapshotPath } = loadConfig();
console.log(send ? "SENDING a test order to Unleashed." : "Dry run: nothing will be sent. Add --send to send it.");

// 1. Settings exist in Unleashed?
const [warehouses, taxes] = await Promise.all([client.warehouses(), client.taxes()]);
const warehouse = warehouses.find((w) => w.WarehouseName.trim().toLowerCase() === warehouseName.toLowerCase());
if (!warehouse) {
  console.log(`Warehouse "${warehouseName}" not found. Unleashed has: ${warehouses.map((w) => `"${w.WarehouseName}" (${w.WarehouseCode})`).join(", ")}`);
  console.log("Set UNLEASHED_WAREHOUSE in .env to one of these names.");
  process.exit(1);
}
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const tax = taxes.find((t) => t.TaxCode === taxCode) ?? taxes.find((t) => norm(t.TaxCode) === norm(taxCode) || norm(t.Description) === norm(taxCode));
if (!tax) {
  console.log(`Tax "${taxCode}" not found. Unleashed has: ${taxes.map((t) => `"${t.TaxCode}"${t.Description ? ` / "${t.Description}"` : ""} (${t.TaxRate})`).join(", ")}`);
  console.log("Set UNLEASHED_TAX_CODE in .env to the exact code.");
  process.exit(1);
}
if (Math.abs(tax.TaxRate - taxRate) > 1e-9) console.log(`Note: Unleashed says ${taxCode} is ${tax.TaxRate}; .env says ${taxRate}. Using ${tax.TaxRate}.`);
console.log(`Warehouse: ${warehouse.WarehouseName} (${warehouse.WarehouseCode}). Tax: ${tax.TaxCode}${tax.Description && tax.Description !== tax.TaxCode ? ` ("${tax.Description}")` : ""} at ${tax.TaxRate}.`);

// 2. The site, from the customer's Delivery tab (same address rules as the Shopify import).
const [delivery, customers] = await Promise.all([client.customerDeliveryAddresses({ customerCode }), client.customers()]);
const customer = customers.find((c) => c.CustomerCode === customerCode);
if (!customer) { console.log(`Customer ${customerCode} not found in Unleashed.`); process.exit(1); }
const addresses = activeDeliveryAddresses(delivery.find((d) => d.CustomerCode === customerCode)?.Addresses);
const needle = siteSearch.toLowerCase();
const matches = addresses.filter((a) =>
  [siteName(a), a.StreetAddress, a.StreetAddress2, a.Suburb, a.City, a.DeliveryInstruction].some((f) => (f ?? "").toLowerCase().includes(needle)),
);
if (!matches.length) {
  console.log(`No Delivery tab site matching "${siteSearch}". Some of ${customerCode}'s sites:`);
  for (const a of addresses.slice(0, 15)) console.log(`  ${siteName(a)}`);
  process.exit(1);
}
const lookup = new PostcodeLookup().learn(customers.flatMap((c) => c.Addresses ?? [])).learn(addresses);
const siteAddr = matches[0];
const name = siteName(siteAddr);
const mapped = toShopifyAddress(siteAddr, undefined, name, lookup);
if (!mapped.address) { console.log(`Site "${name}" has no usable address: ${mapped.problems.join(", ")}`); process.exit(1); }
if (matches.length > 1) console.log(`(${matches.length} sites match "${siteSearch}"; using "${name}")`);

// 3. Price it from synced data, exactly as the portal will.
const store = await FileStore.open(snapshotPath);
if (!(await store.getState()).lastFullSyncAt) { console.log("No synced price data. Run: npm run sync"); process.exit(1); }
const priced = await priceLines(store, customerCode, [{ sku, quantity: qty }]);
if (priced.errors.length) { console.log(`Can't price ${sku}: ${priced.errors[0].error}`); process.exit(1); }
const products = new Map<string, boolean>();
for (const l of priced.lines) products.set(l.productCode, (await store.getProduct(l.productCode))?.taxable !== false);

// 4. Build the order.
const guid = randomUUID();
const order = buildSalesOrder({
  guid,
  customerCode,
  poNumber: po,
  site: { name, address: mapped.address },
  lines: priced.lines,
  taxable: (code) => products.get(code) ?? true,
  warehouse,
  taxCode: tax.TaxCode,
  taxRate: tax.TaxRate,
  status,
  comments: "TEST order from the B2B portal build. Safe to delete.",
});

console.log(`\nCustomer:      ${customerCode}`);
console.log(`Delivery name: ${order.DeliveryName}`);
console.log(`Deliver to:    ${[order.DeliveryStreetAddress, order.DeliveryStreetAddress2, order.DeliverySuburb, order.DeliveryRegion, order.DeliveryPostCode].filter(Boolean).join(", ")}`);
console.log(`Customer Ref:  ${order.CustomerRef}`);
for (const l of order.SalesOrderLines) console.log(`Line:          ${l.Product.ProductCode} x${l.OrderQuantity} @ $${l.UnitPrice.toFixed(2)} = $${l.LineTotal.toFixed(2)} + GST $${l.LineTax.toFixed(2)}`);
console.log(`Totals:        $${order.SubTotal.toFixed(2)} + GST $${order.TaxTotal.toFixed(2)} = $${order.Total.toFixed(2)}`);
console.log(`Status:        ${order.OrderStatus}, warehouse ${order.Warehouse.WarehouseName}`);

if (!send) {
  console.log("\nFull order JSON:\n" + JSON.stringify(order, null, 2));
  console.log("\nNothing sent. If this looks right, run again with --send.");
  process.exit(0);
}

// 5. Save the Guid first, so a retry can't create a duplicate, then send.
await mkdir("data", { recursive: true });
const logPath = "data/test-orders.json";
let log: unknown[] = [];
try { log = JSON.parse(await readFile(logPath, "utf8")); } catch {}
log.push({ guid, po, customerCode, at: new Date().toISOString(), sent: false });
await writeFile(logPath, JSON.stringify(log, null, 2));

try {
  const created = await client.post<{ OrderNumber?: string; Guid?: string; OrderStatus?: string }>(`/SalesOrders/${guid}`, order);
  (log[log.length - 1] as Record<string, unknown>).sent = true;
  (log[log.length - 1] as Record<string, unknown>).orderNumber = created.OrderNumber;
  await writeFile(logPath, JSON.stringify(log, null, 2));
  console.log(`\nSent. Unleashed order number: ${created.OrderNumber ?? "(not returned)"} (status ${created.OrderStatus ?? status}).`);
  console.log("Open it in the Unleashed sandbox and check: customer, delivery name and address, Customer Reference, prices, GST, warehouse.");
} catch (e) {
  console.log(`\nUnleashed rejected the order: ${(e as Error).message}`);
  console.log("Nothing was created. Paste this message to Claude.");
  process.exit(1);
}
