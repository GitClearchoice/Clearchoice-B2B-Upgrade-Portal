// Run against the Unleashed SANDBOX before trusting the engine:
//   npm run sandbox:check                      -> checks auth and prints what the data looks like
//   npm run sandbox:check -- CUST01 SKU123 5   -> also prices SKU123 x5 for customer CUST01
// Compare the printed price with what Unleashed shows on a new sales order for the same
// customer, product and quantity. They should match to the cent.
import { FileStore } from "../src/sync/store.ts";
import { fullSync } from "../src/sync/sync.ts";
import { priceLines } from "../src/index.ts";
import { loadConfig } from "./config.ts";

const { client, discountFormat, snapshotPath } = loadConfig();

console.log("1. Auth check (GET /SellPriceTiers)…");
const tiers = await client.sellPriceTiers();
console.log(`   OK, ${tiers.length} tiers:`, tiers.map((t) => `${t.Tier}=${t.Name}`).join(", "));

console.log("2. Raw sample, to confirm field formats…");
const customers = await client.customers();
const withDiscount = customers.find((c) => c.DiscountRate);
console.log(
  `   Customer DiscountRate example: ${withDiscount ? `${withDiscount.CustomerCode} = ${withDiscount.DiscountRate}` : "(no customer has one)"}`,
  `\n   -> if 10% shows as 0.1 keep UNLEASHED_DISCOUNT_RATE_FORMAT=fraction; if it shows as 10 set it to percent.`,
);
const prices = await client.productPrices();
const types = [...new Set(prices.map((p) => p.PriceType))];
console.log(`   ${prices.length} customer price lines; price types seen: ${types.join(", ") || "(none)"}`);
const qtyLines = prices.filter((p) => !p.Customer?.CustomerCode && p.Product?.ProductCode);
console.log(`   ${qtyLines.length} of them have a product but no customer (product Quantity Prices).`);
if (qtyLines[0]) {
  const q = qtyLines[0];
  console.log("   Quantity Price sample:", JSON.stringify({
    ProductCode: q.Product?.ProductCode, PriceType: q.PriceType, DiscountValue: q.DiscountValue,
    CustomerPrice: q.CustomerPrice, DefaultSellPrice: q.DefaultSellPrice, MinimumQuantity: q.MinimumQuantity,
  }));
}
const sample = prices.find((p) => /discount/i.test(p.PriceType ?? ""));
if (sample) {
  console.log("   Discount-% line sample:", JSON.stringify({
    PriceType: sample.PriceType, DiscountValue: sample.DiscountValue, CustomerPrice: sample.CustomerPrice,
    DefaultSellPrice: sample.DefaultSellPrice, MinimumQuantity: sample.MinimumQuantity,
  }));
}

console.log("3. Full sync into", snapshotPath, "…");
const store = await FileStore.open(snapshotPath);
const result = await fullSync(client, store, { discountFormat, log: (m) => console.log("  ", m) });
for (const w of result.warnings.slice(0, 10)) console.log("   WARNING", w);
console.log(`   Done: ${result.products} products, ${result.customers} customers, ${result.rules} customer price lines, ${result.quantityPrices} quantity prices, ${result.warnings.length} warnings.`);

const [customerCode, sku, qty] = process.argv.slice(2);
if (customerCode && sku) {
  console.log(`4. Pricing ${sku} x${qty ?? 1} for ${customerCode}…`);
  const out = await priceLines(store, customerCode, [{ sku, quantity: Number(qty ?? 1) }]);
  console.log(JSON.stringify(out, null, 2));
}
