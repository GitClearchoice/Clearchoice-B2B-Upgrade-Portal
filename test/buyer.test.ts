import { test } from "node:test";
import assert from "node:assert/strict";
import { BuyerError, buyerContext, parseLinesParam, type BuyerQueryData } from "../src/b2b/buyer.ts";

const loc = (id: number, name: string, code?: string) => ({
  companyLocation: { id: `gid://shopify/CompanyLocation/${id}`, name, code: code ? { value: code } : null },
});
const data = (companyCode: string | null, nodes: ReturnType<typeof loc>[]): BuyerQueryData => ({
  customer: {
    id: "gid://shopify/Customer/1",
    displayName: "Pat Buyer",
    email: { emailAddress: "pat@example.com" },
    companyContactProfiles: [
      { id: "gid://shopify/CompanyContact/5", company: { id: "gid://shopify/Company/9", name: "Acme", code: companyCode ? { value: companyCode } : null }, roleAssignments: { nodes } },
    ],
  },
});

test("retail customer (no company) is not a trade buyer", () => {
  assert.equal(buyerContext({ customer: { id: "x", displayName: "R", email: null, companyContactProfiles: [] } }), null);
  assert.equal(buyerContext({ customer: null }), null);
});

test("site uses the company's Unleashed code; defaults to first site by name", () => {
  const b = buyerContext(data("ASSET LINK", [loc(2, "Westpoint"), loc(1, "Airport"), loc(1, "Airport")]))!;
  assert.equal(b.sites.length, 2);
  assert.equal(b.site.name, "Airport");
  assert.equal(b.site.customerCode, "ASSET LINK");
});

test("grouped company: site's own code wins; location picked by numeric id", () => {
  const b = buyerContext(data(null, [loc(1, "CMMD - A", "CMMD"), loc(2, "FIT - B", "FIT SERVICES SYD")]), "2")!;
  assert.equal(b.site.customerCode, "FIT SERVICES SYD");
  assert.throws(() => buyerContext(data(null, [loc(1, "A", "CMMD")]), "99"), BuyerError);
});

test("no linked sites is an error", () => {
  assert.throws(() => buyerContext(data(null, [loc(1, "A")])), BuyerError);
});

test("parseLinesParam", () => {
  assert.deepEqual(parseLinesParam("1-CT-0014:48, ABC"), [
    { sku: "1-CT-0014", quantity: 48 },
    { sku: "ABC", quantity: 1 },
  ]);
  assert.deepEqual(parseLinesParam(null), []);
  assert.throws(() => parseLinesParam("X:0"), BuyerError);
  assert.throws(() => parseLinesParam("X:1.5"), BuyerError);
});

test("closed sites are left out and can't be ordered for", () => {
  const closed = { companyLocation: { ...loc(1, "Airport").companyLocation, closed: { value: "true" } } };
  const b = buyerContext(data("ASSET", [closed, loc(2, "Westpoint")]))!;
  assert.deepEqual(b.sites.map((s) => s.name), ["Westpoint"]);
  assert.throws(() => buyerContext(data("ASSET", [closed, loc(2, "Westpoint")]), "1"), /closed/);
  assert.throws(() => buyerContext(data("ASSET", [closed])), /no open sites/);
});
