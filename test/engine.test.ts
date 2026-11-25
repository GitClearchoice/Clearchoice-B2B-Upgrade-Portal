import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePrice, sydneyDate } from "../src/pricing/engine.ts";
import { applyDiscount, roundCents } from "../src/pricing/money.ts";
import type { Customer, CustomerPriceRule, Product } from "../src/pricing/types.ts";

const product = (over: Partial<Product> = {}): Product => ({
  code: "BLADE350",
  groupName: "Diamond Blades",
  defaultSellPrice: 300,
  tierPrices: [280, 260, 240, null, null, null, null, null, null, null],
  taxable: true,
  obsolete: false,
  sellable: true,
  ...over,
});
const customer = (over: Partial<Customer> = {}): Customer => ({
  code: "ASSETLINK", tier: 2, discount: 0, obsolete: false, ...over,
});
const rule = (over: Partial<CustomerPriceRule> = {}): CustomerPriceRule => ({
  id: "r1", customerCode: "ASSETLINK", productCode: "BLADE350", groupName: null,
  type: "fixed", value: 199, unleashedCustomerPrice: null, minQty: 0, validFrom: null, validTo: null,
  ...over,
});
const at = new Date("2026-11-25T01:00:00Z"); // 12pm 25 Nov Sydney

test("tier price applies when there is no customer pricing", () => {
  const r = resolvePrice({ product: product(), customer: customer(), quantity: 1, rules: [], at });
  assert.equal(r.source, "tier");
  assert.equal(r.unitExGst, 260);
  assert.equal(r.unitIncGst, 286);
});

test("tier price less customer discount", () => {
  const r = resolvePrice({ product: product(), customer: customer({ discount: 0.05 }), quantity: 3, rules: [], at });
  assert.equal(r.unitExGst, 247);
  assert.equal(r.lineExGst, 741);
  assert.match(r.detail, /5% customer discount/);
});

test("blank tier falls back to default sell price", () => {
  const r = resolvePrice({ product: product(), customer: customer({ tier: 4 }), quantity: 1, rules: [], at });
  assert.equal(r.source, "default");
  assert.equal(r.unitExGst, 300);
});

test("no tier uses default; discount applies unless switched off", () => {
  const c = customer({ tier: null, discount: 0.1 });
  assert.equal(resolvePrice({ product: product(), customer: c, quantity: 1, rules: [], at }).unitExGst, 270);
  assert.equal(
    resolvePrice({ product: product(), customer: c, quantity: 1, rules: [], at, settings: { applyDiscountToDefault: false } }).unitExGst,
    300,
  );
});

test("customer product pricing beats tier", () => {
  const r = resolvePrice({ product: product(), customer: customer(), quantity: 1, rules: [rule()], at });
  assert.equal(r.source, "customer-product");
  assert.equal(r.unitExGst, 199);
  assert.equal(r.ruleId, "r1");
});

test("product line beats group line", () => {
  const rules = [rule({ id: "g", productCode: null, groupName: "Diamond Blades", value: 150 }), rule({ id: "p", value: 210 })];
  assert.equal(resolvePrice({ product: product(), customer: customer(), quantity: 1, rules, at }).ruleId, "p");
});

test("group line applies to products in that group", () => {
  const rules = [rule({ productCode: null, groupName: "Diamond Blades", type: "discount", value: 20 })];
  const r = resolvePrice({ product: product(), customer: customer(), quantity: 1, rules, at });
  assert.equal(r.source, "customer-group");
  assert.equal(r.unitExGst, 208); // 20% off tier 2 (260)
});

test("minimum quantity: highest qualifying break wins", () => {
  const rules = [rule({ id: "a", value: 250, minQty: 0 }), rule({ id: "b", value: 230, minQty: 10 }), rule({ id: "c", value: 210, minQty: 50 })];
  assert.equal(resolvePrice({ product: product(), customer: customer(), quantity: 9, rules, at }).unitExGst, 250);
  assert.equal(resolvePrice({ product: product(), customer: customer(), quantity: 10, rules, at }).unitExGst, 230);
  assert.equal(resolvePrice({ product: product(), customer: customer(), quantity: 60, rules, at }).unitExGst, 210);
});

test("min qty not met falls through to tier", () => {
  const rules = [rule({ minQty: 10 })];
  assert.equal(resolvePrice({ product: product(), customer: customer(), quantity: 2, rules, at }).source, "tier");
});

test("valid-from / valid-to are inclusive Sydney dates", () => {
  const today = sydneyDate(at);
  assert.equal(today, "2026-11-25");
  const ok = (r: Partial<CustomerPriceRule>) =>
    resolvePrice({ product: product(), customer: customer(), quantity: 1, rules: [rule(r)], at }).source === "customer-product";
  assert.ok(ok({ validFrom: "2026-11-25", validTo: "2026-11-25" }));
  assert.ok(!ok({ validFrom: "2026-11-26" }));
  assert.ok(!ok({ validTo: "2026-11-24" }));
});

test("Sydney date rolls over before UTC midnight", () => {
  assert.equal(sydneyDate(new Date("2026-11-30T13:30:00Z")), "2026-12-01");
});

test("other customers' rules are ignored", () => {
  const r = resolvePrice({ product: product(), customer: customer(), quantity: 1, rules: [rule({ customerCode: "OTHER" })], at });
  assert.equal(r.source, "tier");
});

test("Unleashed-calculated CustomerPrice is preferred for discount lines", () => {
  const rules = [rule({ type: "discount", value: 10, unleashedCustomerPrice: 233.33 })];
  assert.equal(resolvePrice({ product: product(), customer: customer(), quantity: 1, rules, at }).unitExGst, 233.33);
});

test("customer pricing is not further reduced by the customer discount", () => {
  const r = resolvePrice({ product: product(), customer: customer({ discount: 0.1 }), quantity: 1, rules: [rule()], at });
  assert.equal(r.unitExGst, 199);
});

test("quantity prices sit between customer pricing and tier", () => {
  const q = (minQty: number, value: number) => ({ id: `q${minQty}`, productCode: "BLADE350", type: "fixed" as const, value, unleashedPrice: null, minQty, validFrom: null, validTo: null });
  const qp = [q(5, 255), q(20, 245)];
  assert.equal(resolvePrice({ product: product(), customer: customer(), quantity: 4, rules: [], quantityPrices: qp, at }).source, "tier");
  assert.equal(resolvePrice({ product: product(), customer: customer(), quantity: 25, rules: [], quantityPrices: qp, at }).unitExGst, 245);
  assert.equal(resolvePrice({ product: product(), customer: customer(), quantity: 25, rules: [rule()], quantityPrices: qp, at }).unitExGst, 199);
});

test("non-taxable product has the same inc and ex GST price", () => {
  const r = resolvePrice({ product: product({ taxable: false }), customer: customer(), quantity: 1, rules: [], at });
  assert.equal(r.unitIncGst, r.unitExGst);
});

test("product with no price at all throws", () => {
  assert.throws(
    () => resolvePrice({ product: product({ defaultSellPrice: null, tierPrices: Array(10).fill(null) }), customer: customer(), quantity: 1, rules: [], at }),
    /No price/,
  );
});

test("rejects zero or negative quantity", () => {
  assert.throws(() => resolvePrice({ product: product(), customer: customer(), quantity: 0, rules: [], at }), RangeError);
});

test("money: 4-decimal prices and half-up rounding", () => {
  assert.equal(roundCents(12.345), 12.35);
  assert.equal(roundCents(1.005), 1.01);
  assert.equal(applyDiscount(19.9999, 0.125), 17.4999);
  assert.equal(roundCents(applyDiscount(0.1 + 0.2, 0)), 0.3);
});

test("quantity price beats tier, respects dates, and %-off works from default price", () => {
  const base = { productCode: "BLADE350", unleashedPrice: null, validFrom: null, validTo: null };
  const disc = [{ ...base, id: "d", type: "discount" as const, value: 20, minQty: 10 }];
  const r = resolvePrice({ product: product(), customer: customer(), quantity: 10, rules: [], quantityPrices: disc, at });
  assert.equal(r.source, "quantity");
  assert.equal(r.unitExGst, 240); // 20% off default 300, even though tier 2 is 260
  const expired = [{ ...base, id: "x", type: "fixed" as const, value: 100, minQty: 0, validTo: "2026-11-24" }];
  assert.equal(resolvePrice({ product: product(), customer: customer(), quantity: 1, rules: [], quantityPrices: expired, at }).source, "tier");
  const withUnleashed = [{ ...base, id: "u", type: "discount" as const, value: 10, unleashedPrice: 31.5, minQty: 0 }];
  assert.equal(resolvePrice({ product: product(), customer: customer(), quantity: 1, rules: [], quantityPrices: withUnleashed, at }).unitExGst, 31.5);
});
