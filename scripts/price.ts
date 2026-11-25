// Quick price check from the last sync. No calls to Unleashed, so it takes about a second.
//   npm run price -- CUSTOMERCODE PRODUCTCODE QTY [QTY ...]
//   e.g. npm run price -- ASSETLINKSERVICESPTYLTD 1-CT-0014 1 48 50 100
// Run `npm run sync` first (and again whenever prices change in Unleashed).
import { FileStore } from "../src/sync/store.ts";
import { priceLines } from "../src/index.ts";

const [customerCode, sku, ...qtyArgs] = process.argv.slice(2);
if (!customerCode || !sku) {
  console.log("Usage: npm run price -- CUSTOMERCODE PRODUCTCODE QTY [QTY ...]");
  process.exit(1);
}
const quantities = (qtyArgs.length ? qtyArgs : ["1"]).map(Number);
if (quantities.some((q) => !(q > 0))) {
  console.log("Quantities must be positive numbers.");
  process.exit(1);
}

const store = await FileStore.open(process.env.SNAPSHOT_PATH ?? "data/unleashed-snapshot.json");
const state = await store.getState();
if (!state.lastFullSyncAt) {
  console.log("No synced data yet. Run: npm run sync");
  process.exit(1);
}

const customer = await store.getCustomer(customerCode);
const product = await store.getProduct(sku);
const syncedAt = new Date((state.lastChangeSyncAt ?? state.lastFullSyncAt) as string).toLocaleString("en-AU", { timeZone: "Australia/Sydney" });
console.log(`Data synced ${syncedAt}`);
if (!customer) { console.log(`Customer ${customerCode} not found. Check the code (it's case-sensitive).`); process.exit(1); }
if (!product) { console.log(`Product ${sku} not found. Check the code (it's case-sensitive).`); process.exit(1); }

// What the engine has to work with
const money = (n: number | null | undefined) => (n == null ? "-" : `$${n.toFixed(2)}`);
console.log(`\nCustomer ${customer.code}${customer.name ? ` (${customer.name})` : ""}: tier ${customer.tier ?? "none"}, discount ${Math.round(customer.discount * 10000) / 100}%`);
console.log(`Product  ${product.code}${product.description ? ` (${product.description})` : ""}: default ${money(product.defaultSellPrice)}, ` +
  `customer's tier ${customer.tier ? money(product.tierPrices[customer.tier - 1]) : "-"}, group "${product.groupName ?? "-"}"`);

const qps = await store.getQuantityPrices(product.code);
if (qps.length) {
  console.log("Quantity Prices:");
  for (const q of qps.sort((a, b) => a.minQty - b.minQty)) {
    const what = q.type === "fixed" ? money(q.value) : `${q.value}% off default`;
    const dates = q.validFrom || q.validTo ? `, valid ${q.validFrom ?? "…"} to ${q.validTo ?? "…"}` : "";
    console.log(`  min qty ${q.minQty}: ${what}${q.unleashedPrice ? ` (Unleashed price ${money(q.unleashedPrice)})` : ""}${dates}`);
  }
} else if (state.counts.quantityPrices === 0) {
  console.log("Quantity Prices: none synced yet. Run `npm run sync` once to pick them up.");
} else {
  console.log("Quantity Prices: none for this product");
}

const rules = (await store.getRulesForCustomer(customer.code)).filter(
  (r) => r.productCode === product.code || (!r.productCode && r.groupName === product.groupName),
);
if (rules.length) {
  console.log("Customer Pricing:");
  for (const r of rules.sort((a, b) => a.minQty - b.minQty)) {
    const what = r.type === "fixed" ? money(r.value) : `${r.value}% off`;
    const scope = r.productCode ? "product" : `group "${r.groupName}"`;
    const dates = r.validFrom || r.validTo ? `, valid ${r.validFrom ?? "…"} to ${r.validTo ?? "…"}` : "";
    console.log(`  ${scope}, min qty ${r.minQty}: ${what}${dates}`);
  }
} else {
  console.log("Customer Pricing: none for this product");
}

// The prices
const { lines, errors } = await priceLines(store, customer.code, quantities.map((quantity) => ({ sku, quantity })));
console.log("\n  Qty   Unit ex GST  Unit inc GST   Line ex GST  From");
for (const l of lines) {
  console.log(
    `${String(l.quantity).padStart(5)}  ${money(l.unitExGst).padStart(11)}  ${money(l.unitIncGst).padStart(12)}  ${money(l.lineExGst).padStart(12)}  ${l.detail}`,
  );
}
for (const e of errors) console.log(`  ${e.sku}: ${e.error}`);
