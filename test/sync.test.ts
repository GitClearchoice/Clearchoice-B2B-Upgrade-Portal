import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnleashedClient } from "../src/unleashed/client.ts";
import { mapCustomer, mapProduct, mapProductPrice } from "../src/sync/mappers.ts";
import { FileStore, MemoryStore } from "../src/sync/store.ts";
import { changesSync, fullSync } from "../src/sync/sync.ts";
import { priceLines } from "../src/index.ts";

const tiers = [
  { Tier: 1, Name: "Sell Price Tier 1" },
  { Tier: 2, Name: "Trade" },
  { Tier: 3, Name: "Sell Price Tier 3" },
];

const uProducts = [
  {
    Guid: "p1", ProductCode: "BLADE350", DefaultSellPrice: 300,
    SellPriceTier1: { Name: "Sell Price Tier 1", Value: 280 }, SellPriceTier2: { Name: "Trade", Value: "260.0000" },
    SellPriceTier3: { Name: "Sell Price Tier 3", Value: 0 },
    ProductGroup: { GroupName: "Diamond Blades" }, Obsolete: false, IsSellable: true, TaxableSales: true,
  },
  {
    Guid: "p2", ProductCode: "MOP01", DefaultSellPrice: 20,
    ProductGroup: { GroupName: "Mops" }, Obsolete: false, IsSellable: true, TaxableSales: true,
  },
  { Guid: "p3", ProductCode: "OLD01", DefaultSellPrice: 5, Obsolete: true, IsSellable: true },
];
const uCustomers = [
  { Guid: "c1", CustomerCode: "ASSETLINK", SellPriceTier: "Trade", DiscountRate: 0.05 },
  { Guid: "c2", CustomerCode: "SERCO", SellPriceTier: "Sell Price Tier 1", DiscountRate: null },
  { Guid: "c3", CustomerCode: "CASH", SellPriceTier: "", DiscountRate: 0 },
];
const uPrices = [
  { Guid: "pp1", Customer: { CustomerCode: "SERCO" }, Product: { ProductCode: "BLADE350" }, PriceType: "Fixed Price",
    CustomerPrice: 199, MinimumQuantity: 0, ValidFrom: null, ValidTo: null },
  { Guid: "pp2", Customer: { CustomerCode: "SERCO" }, ProductGroup: { GroupName: "Mops" }, PriceType: "Discount %",
    DiscountValue: 25, MinimumQuantity: 10, ValidFrom: "/Date(1764028800000)/", ValidTo: null },
  { Guid: "pp3", PriceType: "Fixed Price", CustomerPrice: 1 }, // no customer -> skipped
];

function fakeUnleashed(data: { products: unknown[]; customers: unknown[]; prices: unknown[] }) {
  const urls: string[] = [];
  const page = (items: unknown[]) => ({ Pagination: { NumberOfItems: items.length, PageSize: 200, PageNumber: 1, NumberOfPages: 1 }, Items: items });
  const fn = (async (url: string) => {
    urls.push(url);
    const path = new URL(url).pathname;
    const body = path.startsWith("/SellPriceTiers") ? { Items: tiers }
      : path.startsWith("/Products") ? page(data.products)
      : path.startsWith("/Customers") ? page(data.customers)
      : page(data.prices);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { client: new UnleashedClient({ apiId: "id", apiKey: "key", fetch: fn }), urls };
}

test("mapProduct: tier values as numbers or strings; 0 means not set", () => {
  const p = mapProduct(uProducts[0] as never);
  assert.deepEqual(p.tierPrices.slice(0, 3), [280, 260, null]);
  assert.equal(p.groupName, "Diamond Blades");
});

test("mapCustomer: renamed tier is matched by name", () => {
  assert.equal(mapCustomer(uCustomers[0] as never, tiers, "fraction").tier, 2);
  assert.equal(mapCustomer(uCustomers[1] as never, tiers, "fraction").tier, 1);
  assert.equal(mapCustomer(uCustomers[2] as never, tiers, "fraction").tier, null);
});

test("mapCustomer: discount format", () => {
  assert.equal(mapCustomer({ Guid: "x", CustomerCode: "X", DiscountRate: 10 } as never, tiers, "percent").discount, 0.1);
  assert.throws(() => mapCustomer({ Guid: "x", CustomerCode: "X", DiscountRate: 10 } as never, tiers, "fraction"), /out of range/);
});

test("mapProductPrice: fixed, discount, dates, and non-customer lines", () => {
  const fixed = mapProductPrice(uPrices[0] as never)!;
  assert.equal(fixed.type, "fixed");
  assert.equal(fixed.value, 199);
  const disc = mapProductPrice(uPrices[1] as never)!;
  assert.equal(disc.type, "discount");
  assert.equal(disc.groupName, "Mops");
  assert.equal(disc.validFrom, "2025-11-25");
  assert.equal(mapProductPrice(uPrices[2] as never), null);
});

test("full sync then price a cart end to end", async () => {
  const { client } = fakeUnleashed({ products: uProducts, customers: uCustomers, prices: uPrices });
  const store = new MemoryStore();
  const result = await fullSync(client, store, { discountFormat: "fraction" });
  assert.equal(result.products, 3);
  assert.equal(result.customers, 3);
  assert.equal(result.rules, 2);
  assert.equal(result.skippedRules, 1);

  const at = new Date("2026-11-25T01:00:00Z");
  const serco = await priceLines(store, "SERCO", [
    { sku: "BLADE350", quantity: 2 },
    { sku: "MOP01", quantity: 12 },
    { sku: "MOP01", quantity: 3 },
    { sku: "OLD01", quantity: 1 },
    { sku: "NOPE", quantity: 1 },
  ], { at });
  assert.deepEqual(serco.lines.map((l) => [l.productCode, l.unitExGst, l.source]), [
    ["BLADE350", 199, "customer-product"],
    ["MOP01", 15, "customer-group"],
    ["MOP01", 20, "default"],
  ]);
  assert.equal(serco.goodsExGst, 398 + 180 + 60);
  assert.deepEqual(serco.errors.map((e) => e.sku), ["OLD01", "NOPE"]);

  const asset = await priceLines(store, "ASSETLINK", [{ sku: "BLADE350", quantity: 1 }], { at });
  assert.equal(asset.lines[0].unitExGst, 247); // Trade tier 260 less 5%
});

test("full sync replaces data, so deleted price lines disappear", async () => {
  const store = new MemoryStore();
  await fullSync(fakeUnleashed({ products: uProducts, customers: uCustomers, prices: uPrices }).client, store, { discountFormat: "fraction" });
  await fullSync(fakeUnleashed({ products: uProducts, customers: uCustomers, prices: [] }).client, store, { discountFormat: "fraction" });
  assert.equal((await store.getRulesForCustomer("SERCO")).length, 0);
});

test("changes sync uses modifiedSince from the last run and upserts", async () => {
  const store = new MemoryStore();
  await fullSync(fakeUnleashed({ products: uProducts, customers: uCustomers, prices: uPrices }).client, store, {
    discountFormat: "fraction", now: () => new Date("2026-11-24T15:00:00Z"),
  });
  const changed = [{ ...uProducts[1], DefaultSellPrice: 22 }];
  const { client, urls } = fakeUnleashed({ products: changed, customers: [], prices: [] });
  const r = await changesSync(client, store, { discountFormat: "fraction" });
  assert.equal(r.mode, "changes");
  assert.ok(urls.some((u) => u.includes("/Products/1?") && u.includes("modifiedSince=2026-11-25")));
  assert.equal((await store.getProduct("MOP01"))?.defaultSellPrice, 22);
  assert.equal((await store.getProduct("BLADE350"))?.defaultSellPrice, 300);
  assert.equal((await store.getRulesForCustomer("SERCO")).length, 2);
});

test("bad customer discount is reported as a warning, not a crash", async () => {
  const store = new MemoryStore();
  const customers = [...uCustomers, { Guid: "c9", CustomerCode: "BAD", DiscountRate: 15 }];
  const r = await fullSync(fakeUnleashed({ products: uProducts, customers, prices: uPrices }).client, store, { discountFormat: "fraction" });
  assert.equal(r.customers, 3);
  assert.match(r.warnings.join("\n"), /BAD/);
});

test("FileStore persists between runs", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "ccb2b-")), "snap.json");
  const a = await FileStore.open(path);
  await fullSync(fakeUnleashed({ products: uProducts, customers: uCustomers, prices: uPrices }).client, a, { discountFormat: "fraction" });
  const b = await FileStore.open(path);
  assert.equal((await b.getState()).counts.rules, 2);
  assert.ok((await b.getState()).lastFullSyncAt);
});
