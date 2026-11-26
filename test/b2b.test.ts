import { test } from "node:test";
import assert from "node:assert/strict";
import { siteExternalId, toShopifyAddress } from "../src/b2b/address.ts";
import { parseCsvObjects, toCsv } from "../src/b2b/csv.ts";
import { buildCandidates, looksLikeWebCustomer } from "../src/b2b/candidates.ts";
import { applyCompany, parseNetDays, pickTemplate, planCompany, type ImportContext } from "../src/b2b/import.ts";
import { ShopifyAdmin } from "../src/shopify/client.ts";
import { UnleashedClient } from "../src/unleashed/client.ts";

// ---------- address / csv / helpers

test("Unleashed address → Shopify address, with state and country mapping", () => {
  const { address, problems } = toShopifyAddress({ StreetAddress: " 1 Hilton  Ave ", Suburb: "Sydenham", Region: "New South Wales", Country: "Australia", PostalCode: "2044" }, "Clearchoice");
  assert.deepEqual(problems, []);
  assert.deepEqual(address, { address1: "1 Hilton Ave", city: "Sydenham", zoneCode: "NSW", zip: "2044", countryCode: "AU", recipient: "Clearchoice" });
  assert.equal(toShopifyAddress({ StreetAddress: "1 A St", City: "Perth", Region: "wa", PostalCode: "6000" }).address?.zoneCode, "WA");
});

test("bad addresses are reported, not sent", () => {
  const r = toShopifyAddress({ StreetAddress: "", City: "Sydney", Region: "XX", PostalCode: "20" });
  assert.equal(r.address, undefined);
  const all = r.problems.join();
  for (const re of [/no street address/, /unknown state/, /postcode "20"/]) assert.match(all, re);
});

test("site external ID uses the Unleashed address Guid", () => {
  assert.equal(siteExternalId("ACME", { Guid: "abc-123" }), "abc-123");
  assert.equal(siteExternalId("ACME", { AddressName: "Depot" }), "ACME|depot");
});

test("CSV round-trips through Excel-style quoting and BOM", () => {
  const csv = toCsv([["Include", "Customer Code", "Name"], ["Y", "DELUXE CLEANING P/L", 'He said "hi", ok']]);
  assert.ok(csv.startsWith("﻿"));
  const rows = parseCsvObjects(csv);
  assert.deepEqual(rows, [{ Include: "Y", "Customer Code": "DELUXE CLEANING P/L", Name: 'He said "hi", ok' }]);
});

test("web customer detection and payment term parsing", () => {
  assert.ok(looksLikeWebCustomer("7969747075384"));
  assert.ok(!looksLikeWebCustomer("ASSETLINKSERVICESPTYLTD"));
  assert.deepEqual(parseNetDays("30 Days", 30), { days: 30 });
  assert.equal(parseNetDays("14 days", 30).days, 14);
  assert.match(parseNetDays("20th of month following", 30).note!, /mapped to Net 30/);
});

test("payment terms template: exact, nearest, none", () => {
  const t = [7, 15, 30, 60].map((d) => ({ id: `t${d}`, name: `Net ${d}`, paymentTermsType: "NET", dueInDays: d }));
  assert.equal(pickTemplate(t, 30).template?.id, "t30");
  const near = pickTemplate(t, 14);
  assert.equal(near.template?.id, "t15");
  assert.match(near.note!, /no Net 14/);
  assert.ok(pickTemplate([], 30).note);
});

// ---------- planning

const customer = {
  Guid: "c1", CustomerCode: "ASSETLINK", CustomerName: "Assetlink Services Pty Ltd",
  ContactFirstName: "Jo", ContactLastName: "Smith", Email: "jo@assetlink.example", PaymentTerm: "30 Days",
  Addresses: [{ AddressType: "Physical", StreetAddress: "9 Main Rd", City: "Parramatta", Region: "NSW", PostalCode: "2150" }],
};
const sites = [
  { Guid: "s1", AddressName: "Western Sydney", StreetAddress: "1 West St", Suburb: "Penrith", Region: "NSW", PostalCode: "2750", DeliveryInstruction: "Dock 2" },
  { Guid: "s2", AddressName: "Hospital", StreetAddress: "2 Health Ave", City: "Westmead", Region: "NSW", PostalCode: "2145" },
  { Guid: "s3", AddressName: "Old site", StreetAddress: "3 Gone St", City: "X", Region: "NSW", PostalCode: "2000", Obsolete: true },
  { Guid: "s4", AddressName: "Broken", StreetAddress: "4 No Postcode St", City: "Y" },
];

test("plan uses Delivery tab sites, skips obsolete, reports bad ones", () => {
  const p = planCompany(customer as never, sites as never, 30);
  assert.deepEqual(p.sites.map((s) => s.name), ["Western Sydney", "Hospital"]);
  assert.equal(p.sites[0].note, "Dock 2");
  assert.deepEqual(p.skippedSites.map((s) => [s.name, s.reason]), [["Broken", "no postcode, no state"]]);
  assert.deepEqual(p.contact, { email: "jo@assetlink.example", firstName: "Jo", lastName: "Smith" });
  assert.equal(p.netDays, 30);
});

test("plan falls back to the main address when the Delivery tab is empty", () => {
  const p = planCompany(customer as never, [], 30);
  assert.equal(p.sites.length, 1);
  assert.equal(p.sites[0].address.city, "Parramatta");
  assert.match(p.notes.join(), /used the customer's main address/);
});

test("plan with no email has no admin and says so", () => {
  const p = planCompany({ ...customer, Email: "" } as never, sites as never, 30);
  assert.equal(p.contact, null);
  assert.match(p.notes.join(), /no head-office admin/);
});

// ---------- candidates (fake Unleashed)

function fakeUnleashed(routes: Record<string, unknown[]>) {
  const fn = (async (url: string) => {
    const path = new URL(url).pathname.split("/")[1];
    const items = routes[path] ?? [];
    return new Response(JSON.stringify({ Pagination: { NumberOfItems: items.length, PageSize: 200, PageNumber: 1, NumberOfPages: 1 }, Items: items }));
  }) as unknown as typeof fetch;
  return new UnleashedClient({ apiId: "id", apiKey: "k", fetch: fn });
}

test("candidates: customers who ordered, web customers marked N, flags filled in", async () => {
  const client = fakeUnleashed({
    SalesOrders: [
      { OrderDate: "/Date(1763000000000)/", Customer: { CustomerCode: "ASSETLINK" } },
      { OrderDate: "/Date(1764000000000)/", Customer: { CustomerCode: "ASSETLINK" } },
      { OrderDate: "/Date(1764000000000)/", Customer: { CustomerCode: "7969747075384" } },
    ],
    Customers: [customer, { Guid: "w", CustomerCode: "7969747075384", CustomerName: "Web Shopper" }],
    CustomerDeliveryAddresses: [{ CustomerCode: "ASSETLINK", Addresses: sites }],
    ProductPrices: [{ Guid: "p", Customer: { CustomerCode: "ASSETLINK" }, Product: { ProductCode: "X" } }],
  });
  const c = await buildCandidates(client, { now: new Date("2026-11-26T00:00:00Z") });
  assert.deepEqual(c.map((x) => [x.code, x.include, x.orders]), [["ASSETLINK", true, 2], ["7969747075384", false, 1]]);
  assert.equal(c[0].deliverySites, 3); // obsolete one excluded
  assert.equal(c[0].customerPricingLines, 1);
  assert.match(c[1].flags.join(), /web customer.*no delivery sites.*no primary contact email.*no trade pricing/);
});

// ---------- apply (fake Shopify)

interface Call { query: string; variables: Record<string, unknown> }

function fakeShopify(existingCompany: unknown | null = null, existingCustomer: unknown | null = null) {
  const calls: Call[] = [];
  let locN = 10;
  const fn = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/admin/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 86399 }));
    }
    const { query, variables } = JSON.parse(String(init!.body));
    calls.push({ query, variables });
    const reply = (data: unknown) => new Response(JSON.stringify({ data }));
    const companyNode = (locs: { id: string; externalId: string; name: string }[]) => ({
      id: "gid://shopify/Company/1", externalId: "ASSETLINK", mainContact: null,
      locations: { nodes: locs }, contacts: { nodes: [] },
      contactRoles: { nodes: [{ id: "role-admin", name: "Location admin" }, { id: "role-order", name: "Ordering only" }] },
    });
    if (query.includes("companies(")) return reply({ companies: { nodes: existingCompany ? [existingCompany] : [] } });
    if (query.includes("company(id: $id) {")) return reply({ company: existingCompany });
    if (query.includes("companyCreate")) {
      const loc = variables.input.companyLocation;
      return reply({ companyCreate: { company: companyNode([{ id: `loc-${locN++}`, externalId: loc.externalId, name: loc.name }]), userErrors: [] } });
    }
    if (query.includes("companyLocationCreate")) return reply({ companyLocationCreate: { companyLocation: { id: `loc-${locN++}` }, userErrors: [] } });
    if (query.includes("customers(")) return reply({ customers: { nodes: existingCustomer ? [existingCustomer] : [] } });
    if (query.includes("companyAssignCustomerAsContact")) return reply({ companyAssignCustomerAsContact: { companyContact: { id: "contact-attached" }, userErrors: [] } });
    if (query.includes("companyContactCreate")) return reply({ companyContactCreate: { companyContact: { id: "contact-new" }, userErrors: [] } });
    if (query.includes("companyAssignMainContact")) return reply({ companyAssignMainContact: { userErrors: [] } });
    if (query.includes("companyContactAssignRoles")) return reply({ companyContactAssignRoles: { userErrors: [] } });
    if (query.includes("metafieldsSet")) return reply({ metafieldsSet: { userErrors: [] } });
    throw new Error(`unexpected query: ${query.slice(0, 80)}`);
  }) as unknown as typeof fetch;
  const admin = new ShopifyAdmin({ shop: "test.myshopify.com", clientId: "id", clientSecret: "secret", fetch: fn });
  return { admin, calls };
}

const templates = [{ id: "net30", name: "Net 30", paymentTermsType: "NET", dueInDays: 30 }];
const ctxFor = (admin: ShopifyAdmin, dryRun: boolean): ImportContext => ({ admin, dryRun, templates, companyMap: {} });

test("apply: creates company with first site, adds other sites, admin, roles, budget flag", async () => {
  const { admin, calls } = fakeShopify();
  const ctx = ctxFor(admin, false);
  const r = await applyCompany(ctx, planCompany(customer as never, sites as never, 30));
  assert.equal(r.status, "created", r.notes.join());
  assert.equal(r.sitesCreated, 2);
  assert.equal(r.contact, "added (jo@assetlink.example)");
  assert.equal(ctx.companyMap.ASSETLINK, "gid://shopify/Company/1");

  const create = calls.find((c) => c.query.includes("companyCreate"))!;
  const loc = (create.variables.input as any).companyLocation;
  assert.equal((create.variables.input as any).company.externalId, "ASSETLINK");
  assert.equal(loc.externalId, "s1");
  assert.deepEqual(loc.buyerExperienceConfiguration, { checkoutToDraft: true, editableShippingAddress: false, paymentTermsTemplateId: "net30" });
  assert.equal(loc.note, "Dock 2");

  const roles = calls.find((c) => c.query.includes("companyContactAssignRoles"))!;
  assert.equal((roles.variables.roles as any[]).length, 2);
  assert.ok((roles.variables.roles as any[]).every((x) => x.companyContactRoleId === "role-admin"));
  const meta = calls.find((c) => c.query.includes("metafieldsSet") && (c.variables.m as any[])[0].key === "budget_admin_contact")!;
  assert.deepEqual((meta.variables.m as any[])[0], { ownerId: "gid://shopify/Company/1", namespace: "b2b", key: "budget_admin_contact", type: "single_line_text_field", value: "contact-new" });
});

test("apply: existing Shopify customer with the admin's email is attached, not duplicated", async () => {
  const { admin, calls } = fakeShopify(null, { id: "gid://shopify/Customer/9", email: "JO@assetlink.example" });
  const r = await applyCompany(ctxFor(admin, false), planCompany(customer as never, sites as never, 30));
  assert.equal(r.status, "created");
  assert.ok(calls.some((c) => c.query.includes("companyAssignCustomerAsContact")));
  assert.ok(!calls.some((c) => c.query.includes("companyContactCreate")));
});

test("apply: dry run makes no changes", async () => {
  const { admin, calls } = fakeShopify();
  const r = await applyCompany(ctxFor(admin, true), planCompany(customer as never, sites as never, 30));
  assert.equal(r.status, "created");
  assert.equal(r.sitesCreated, 2);
  assert.ok(calls.every((c) => !/mutation/.test(c.query)), "no mutations in a dry run");
});

test("apply: re-run on an existing company only adds what's missing", async () => {
  const existing = {
    id: "gid://shopify/Company/1", externalId: "ASSETLINK", mainContact: { id: "contact-1" },
    locations: { nodes: [{ id: "loc-1", externalId: "s1", name: "Western Sydney" }] },
    contacts: { nodes: [{ id: "contact-1", customer: { id: "cust-1", email: "jo@assetlink.example" }, roleAssignments: { nodes: [{ companyLocation: { id: "loc-1" } }] } }] },
    contactRoles: { nodes: [{ id: "role-admin", name: "Location admin" }] },
  };
  const { admin, calls } = fakeShopify(existing);
  const r = await applyCompany(ctxFor(admin, false), planCompany(customer as never, sites as never, 30));
  assert.equal(r.status, "updated");
  assert.equal(r.sitesCreated, 1);
  assert.equal(r.sitesExisting, 1);
  assert.equal(r.contact, "existing (jo@assetlink.example)");
  assert.ok(!calls.some((c) => c.query.includes("companyCreate")));
  assert.ok(!calls.some((c) => c.query.includes("companyAssignMainContact")));
  const roles = calls.find((c) => c.query.includes("companyContactAssignRoles"))!;
  assert.deepEqual((roles.variables.roles as any[]).map((x) => x.companyLocationId), ["loc-10"]);
});

test("apply: company with no usable site is skipped", async () => {
  const { admin, calls } = fakeShopify();
  const r = await applyCompany(ctxFor(admin, false), planCompany({ ...customer, Addresses: [] } as never, [sites[3]] as never, 30));
  assert.equal(r.status, "skipped");
  assert.equal(calls.length, 0);
});

test("apply: Shopify user errors are reported per customer, not thrown", async () => {
  const fn = (async (url: string) => {
    if (url.endsWith("/access_token")) return new Response(JSON.stringify({ access_token: "t" }));
    return new Response(JSON.stringify({ data: { companies: { nodes: [] }, companyCreate: { company: null, userErrors: [{ field: ["input", "company", "externalId"], message: "External ID has already been taken" }] } } }));
  }) as unknown as typeof fetch;
  const admin = new ShopifyAdmin({ shop: "t.myshopify.com", clientId: "a", clientSecret: "b", fetch: fn });
  const r = await applyCompany(ctxFor(admin, false), planCompany(customer as never, sites as never, 30));
  assert.equal(r.status, "error");
  assert.match(r.notes.join(), /External ID has already been taken/);
});

test("shopify client: token via client credentials, sent as header, cached", async () => {
  const seen: { url: string; headers?: Record<string, string>; body?: string }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: init?.headers as Record<string, string>, body: String(init?.body) });
    if (url.endsWith("/access_token")) return new Response(JSON.stringify({ access_token: "abc", expires_in: 86399 }));
    return new Response(JSON.stringify({ data: { shop: { name: "x" } } }));
  }) as unknown as typeof fetch;
  const admin = new ShopifyAdmin({ shop: "https://clearchoice-upgrade.myshopify.com/", clientId: "cid", clientSecret: "sec", fetch: fn });
  await admin.graphql("{ shop { name } }");
  await admin.graphql("{ shop { name } }");
  assert.equal(seen.filter((s) => s.url.endsWith("/access_token")).length, 1);
  assert.match(seen[0].body!, /grant_type=client_credentials&client_id=cid&client_secret=sec/);
  assert.equal(seen[1].url, "https://clearchoice-upgrade.myshopify.com/admin/api/2026-10/graphql.json");
  assert.equal(seen[1].headers!["X-Shopify-Access-Token"], "abc");
});

test("Prepaid / Same Day map to due on receipt; month-following uses the default", () => {
  assert.equal(parseNetDays("Prepaid", 30).days, 0);
  assert.equal(parseNetDays("Same Day", 30).days, 0);
  assert.equal(parseNetDays("30th Month following", 30).days, 30); // "30th" isn't "30 days"
  const t = [{ id: "r", name: "Due on receipt", paymentTermsType: "RECEIPT", dueInDays: null }, { id: "n30", name: "Net 30", paymentTermsType: "NET", dueInDays: 30 }];
  assert.equal(pickTemplate(t, 0).template, undefined); // Shopify rejects due-on-receipt for B2B locations
  assert.equal(pickTemplate(t, 30).template?.id, "n30");
});

test("apply: company with more than 250 sites is paged, so re-runs don't recreate sites", async () => {
  const calls: string[] = [];
  const locs = Array.from({ length: 300 }, (_, i) => ({ id: `loc-${i}`, externalId: `s${i}`, name: `Site ${i}` }));
  const fn = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/access_token")) return new Response(JSON.stringify({ access_token: "t" }));
    const { query, variables } = JSON.parse(String(init!.body));
    calls.push(query);
    const reply = (data: unknown) => new Response(JSON.stringify({ data }));
    if (query.includes("companies(")) return reply({ companies: { nodes: [{ id: "C1", externalId: "BIG" }] } });
    if (query.includes("locations(first: 250, after")) {
      const start = variables.after ? 250 : 0;
      const nodes = locs.slice(start, start + 250);
      return reply({ company: { locations: { nodes, pageInfo: { hasNextPage: start + 250 < locs.length, endCursor: `c${start + 250}` } } } });
    }
    if (query.includes("company(id: $id) {")) {
      return reply({ company: {
        id: "C1", externalId: "BIG", mainContact: { id: "k1" },
        locations: { nodes: locs.slice(0, 250), pageInfo: { hasNextPage: true, endCursor: "c250" } },
        contacts: { nodes: [{ id: "k1", customer: { id: "u1", email: "a@b.co" }, roleAssignments: { nodes: locs.slice(0, 250).map((l) => ({ companyLocation: { id: l.id } })), pageInfo: { hasNextPage: true, endCursor: "r250" } } }] },
        contactRoles: { nodes: [{ id: "role", name: "Location admin" }] },
      } });
    }
    if (query.includes("locations(first: 250, after")) {
      const start = variables.after ? 250 : 0;
      const nodes = locs.slice(start, start + 250);
      return reply({ company: { locations: { nodes, pageInfo: { hasNextPage: start + 250 < locs.length, endCursor: `c${start + 250}` } } } });
    }
    if (query.includes("companyContact(id")) {
      const start = variables.after ? 250 : 0;
      const nodes = locs.slice(start, start + 250).map((l) => ({ companyLocation: { id: l.id } }));
      return reply({ companyContact: { roleAssignments: { nodes, pageInfo: { hasNextPage: start + 250 < locs.length, endCursor: `r${start + 250}` } } } });
    }
    if (query.includes("metafieldsSet")) return reply({ metafieldsSet: { userErrors: [] } });
    throw new Error(`unexpected: ${query.slice(0, 60)}`);
  }) as unknown as typeof fetch;
  const admin = new ShopifyAdmin({ shop: "t.myshopify.com", clientId: "a", clientSecret: "b", fetch: fn });
  const plan = {
    code: "BIG", name: "Big Co", contact: { email: "a@b.co", firstName: "A", lastName: "B" },
    sites: locs.map((l) => ({ externalId: l.externalId, name: l.name, address: { address1: "1 St", city: "Sydney", zoneCode: "NSW", zip: "2000", countryCode: "AU" } })),
    skippedSites: [], unleashedPaymentTerm: "30 days", netDays: 30, notes: [],
  };
  const r = await applyCompany({ admin, dryRun: false, templates, companyMap: {} }, plan);
  assert.equal(r.status, "unchanged", r.notes.join());
  assert.equal(r.sitesExisting, 300);
  assert.equal(r.sitesCreated, 0);
  assert.ok(!calls.some((q) => q.includes("companyLocationCreate") || q.includes("companyContactAssignRoles")));
});

test("state comes from the postcode when the State field is blank or odd", async () => {
  const { stateFromPostcode } = await import("../src/b2b/address.ts");
  assert.deepEqual(["2044", "2600", "2620", "3000", "4000", "5000", "6000", "7000", "0800", "2900"].map(stateFromPostcode),
    ["NSW", "ACT", "NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"]);
  assert.equal(toShopifyAddress({ StreetAddress: "1 A St", City: "Penrith", Region: "", PostalCode: "2750" }).address?.zoneCode, "NSW");
  assert.equal(toShopifyAddress({ StreetAddress: "1 A St", City: "Penrith", Region: "N.S.W.", PostalCode: "2750" }).address?.zoneCode, "NSW");
  const inRegion = toShopifyAddress({ StreetAddress: "1 A St", City: "Sydney", Region: "NSW 2000", PostalCode: "" });
  assert.deepEqual([inRegion.address?.zip, inRegion.address?.zoneCode], ["2000", "NSW"]);
  assert.match(toShopifyAddress({ StreetAddress: "1 A St", City: "X", Region: "", PostalCode: "" }).problems.join(), /no postcode.*no state/);
});

test("skipped sites are listed with their address and reasons are counted", async () => {
  const { skippedRows, reasonCounts } = await import("../src/b2b/import.ts");
  const p = planCompany(customer as never, [...sites, { Guid: "s5", AddressName: "No street", City: "Y", PostalCode: "2000" }] as never, 30);
  const rows = skippedRows(p);
  assert.ok(rows.some((r) => r[1] === "No street" && /no street address/.test(r[9])));
  assert.ok(reasonCounts([p]).some(([r]) => r === "no street address"));
});

test("rebuilds addresses typed into the wrong fields", () => {
  const r = (a: Record<string, string>, name = "Site") => toShopifyAddress(a as never, undefined, name);
  // state + postcode in City, suburb in Suburb, junk in Country
  let x = r({ StreetAddress: "17 Example St", StreetAddress2: "Level 4", Suburb: "Blacktown", City: "NSW  2148", Region: "9999 0000", Country: "Level 4" });
  assert.deepEqual([x.address?.address1, x.address?.city, x.address?.zoneCode, x.address?.zip], ["17 Example St", "Blacktown", "NSW", "2148"]);
  assert.ok(x.rebuilt);
  // "SUBURB, 1234" in Street 2
  x = r({ StreetAddress: "14 Sample Road", StreetAddress2: "WEST RYDE, 2114", Suburb: "0400 000 000" });
  assert.deepEqual([x.address?.city, x.address?.zip, x.address?.zoneCode], ["West Ryde", "2114", "NSW"]);
  assert.match(x.extraNote!, /0400 000 000/);
  // whole address in one comma-separated field
  x = r({ StreetAddress: "Unit 2 8 Test Place, Prestons, NSW,  2170", StreetAddress2: "note" });
  assert.deepEqual([x.address?.address1, x.address?.city, x.address?.zip], ["Unit 2 8 Test Place", "Prestons", "2170"]);
  // street and locality in one field without commas
  x = r({ StreetAddress: "Market Place", StreetAddress2: "197 Old Test Hwy Mittagong NSW 2575" });
  assert.deepEqual([x.address?.address1, x.address?.city], ["197 Old Test Hwy", "Mittagong"]);
  // street only in the site name
  x = r({ Suburb: "ST LEONARDS", Region: "NSW", PostalCode: "2065" }, "72 Sample Street");
  assert.equal(x.address?.address1, "72 Sample Street");
  // explicit state beats a shared postcode (2620 = NSW and ACT)
  x = r({ StreetAddress: "2/69 Test Cres", StreetAddress2: "Beard ACT 2620" });
  assert.equal(x.address?.zoneCode, "ACT");
});

test("phone numbers are never read as postcodes", () => {
  const x = toShopifyAddress({ StreetAddress: "13 Test Road", Suburb: "KINGSWOOD", Country: "Raphel 4736 8211" } as never, undefined, "Site");
  assert.equal(x.address, undefined);
});

test("notes saved as addresses are flagged, not imported", () => {
  for (const a of [{ AddressName: "Picked up by Someone" }, { AddressName: "X", StreetAddress: "24/04/26" }]) {
    const x = toShopifyAddress(a as never, undefined, a.AddressName);
    assert.equal(x.address, undefined);
    assert.ok(x.notASite);
  }
});

test("postcode lookup: fills a missing postcode only when the data agrees", async () => {
  const { PostcodeLookup } = await import("../src/b2b/address.ts");
  const lookup = new PostcodeLookup().learn([
    { StreetAddress: "1 A St", City: "Pyrmont", Region: "NSW", PostalCode: "2009" },
    { StreetAddress: "2 B St", City: "PYRMONT", PostalCode: "2009" },
    { StreetAddress: "1 C St", City: "Richmond", Region: "NSW", PostalCode: "2753" },
    { StreetAddress: "1 D St", City: "Richmond", Region: "VIC", PostalCode: "3121" },
  ] as never);
  assert.deepEqual(lookup.find("pyrmont"), { postcode: "2009", state: "NSW" });
  assert.equal(lookup.find("Richmond"), null); // ambiguous across states
  assert.deepEqual(lookup.find("Richmond", "VIC"), { postcode: "3121", state: "VIC" });

  const x = toShopifyAddress({ StreetAddress: "120 Test Street", StreetAddress2: "Pyrmont" } as never, undefined, "Job 61", lookup);
  assert.deepEqual([x.address?.address1, x.address?.city, x.address?.zip, x.address?.zoneCode], ["120 Test Street", "Pyrmont", "2009", "NSW"]);
  assert.ok(x.postcodeFilled);
  const amb = toShopifyAddress({ StreetAddress: "5 Test Rd", StreetAddress2: "Richmond" } as never, undefined, "S", lookup);
  assert.equal(amb.address, undefined);
});

test("more patterns: 'Deliver to:', trailing dots, street+suburb in one field, long lot numbers", () => {
  const r = (a: Record<string, string>) => toShopifyAddress(a as never, undefined, "S");
  let x = r({ StreetAddress: "LOTS 53, 54 & 56 7-13 TEST STREET, SYDNEY, NSW,  2000" });
  assert.deepEqual([x.address?.address1, x.address?.zip], ["LOTS 53, 54 & 56 7-13 TEST STREET", "2000"]);
  x = r({ StreetAddress: "219 Sample Street Strawberry Hills, NSW 2012" });
  assert.deepEqual([x.address?.address1, x.address?.city], ["219 Sample Street", "Strawberry Hills"]);
  x = r({ StreetAddress: "78-94 Test Drive", StreetAddress2: "Welshpool WA", Region: "", PostalCode: "6106." });
  assert.deepEqual([x.address?.city, x.address?.zip, x.address?.zoneCode], ["Welshpool", "6106", "WA"]);
  x = r({ StreetAddress: "Deliver to:", StreetAddress2: "23/1 Test Road", Suburb: "MACQUARIE PARK 2113" });
  assert.equal(x.address?.address1, "23/1 Test Road");
});

test("customer with no usable Delivery tab sites falls back to their main address", () => {
  const p = planCompany({ ...customer, Addresses: [{ AddressType: "Postal", StreetAddress: "PO Box 1", City: "Sydney", PostalCode: "2001" }, { AddressType: "Physical", StreetAddress: "9 Main Rd", City: "Parramatta", Region: "NSW", PostalCode: "2150" }] } as never,
    [{ Guid: "n1", AddressName: "Picked up by Someone" }, { Guid: "n2", AddressName: "TARONGA ZOO" }] as never, 30);
  assert.equal(p.sites.length, 1);
  assert.equal(p.sites[0].address.city, "Parramatta");
  assert.match(p.notes.join(), /used the customer's main address as their one site/);
});

test("external IDs: spaces become underscores; exact code saved in a metafield", async () => {
  const { shopifyExternalId } = await import("../src/b2b/import.ts");
  assert.equal(shopifyExternalId("BIC SERVICES"), "BIC_SERVICES");
  assert.equal(shopifyExternalId("DELUXE CLEANING P/L"), "DELUXE_CLEANING_P/L");
  assert.equal(shopifyExternalId("ASSETLINKSERVICESPTYLTD"), "ASSETLINKSERVICESPTYLTD");
  assert.equal(shopifyExternalId("ACME|depot one"), "ACME_depot_one");

  const { admin, calls } = fakeShopify();
  const r = await applyCompany(ctxFor(admin, false), planCompany({ ...customer, CustomerCode: "ASSET LINK" } as never, sites as never, 30));
  assert.equal(r.status, "created", r.notes.join());
  const create = calls.find((c) => c.query.includes("companyCreate"))!;
  assert.equal((create.variables.input as any).company.externalId, "ASSET_LINK");
  const search = calls.find((c) => c.query.includes("companies("))!;
  assert.equal(search.variables.q, 'external_id:"ASSET_LINK"');
  const metas = calls.filter((c) => c.query.includes("metafieldsSet")).flatMap((c) => c.variables.m as any[]);
  assert.ok(metas.some((m) => m.namespace === "unleashed" && m.key === "customer_code" && m.value === "ASSET LINK"));
});

test("a site Shopify rejects is skipped; the rest of the customer carries on", async () => {
  let n = 0;
  const { admin } = fakeShopify();
  const orig = admin.graphql.bind(admin);
  admin.graphql = (async (q: string, v: Record<string, unknown>) => {
    if (q.includes("companyLocationCreate") && n++ === 0) {
      return { companyLocationCreate: { companyLocation: null, userErrors: [{ field: ["input", "shippingAddress", "zip"], message: "Zip is invalid" }] } };
    }
    return orig(q, v);
  }) as typeof admin.graphql;
  const plan = planCompany(customer as never, [...sites, { Guid: "s6", AddressName: "Third", StreetAddress: "3 Test St", City: "Sydney", Region: "NSW", PostalCode: "2000" }] as never, 30);
  const r = await applyCompany(ctxFor(admin, false), plan);
  assert.equal(r.status, "created", r.notes.join());
  assert.equal(r.sitesCreated, 2); // first (with company) + third; second rejected
  assert.match(r.sitesSkipped.join(), /Hospital: Shopify rejected it: Zip is invalid/);
  assert.ok(plan.skippedSites.some((s) => /Zip is invalid/.test(s.reason)));
  assert.match(r.contact, /added/);
});

test("an admin who is already a contact for another company is noted, not an error", async () => {
  const { admin } = fakeShopify(null, { id: "gid://shopify/Customer/9", email: "jo@assetlink.example" });
  const orig = admin.graphql.bind(admin);
  admin.graphql = (async (q: string, v: Record<string, unknown>) => {
    if (q.includes("companyAssignCustomerAsContact")) {
      return { companyAssignCustomerAsContact: { companyContact: null, userErrors: [{ field: ["companyId"], message: "Customer is already associated with a company contact." }] } };
    }
    return orig(q, v);
  }) as typeof admin.graphql;
  const r = await applyCompany(ctxFor(admin, false), planCompany(customer as never, sites as never, 30));
  assert.equal(r.status, "created", r.notes.join());
  assert.match(r.contact, /not set: .* already the admin for another company/);
  assert.match(r.notes.join(), /different primary contact in Unleashed/);
});

test("group: one company, sites named by member, each site keeps its own Unleashed code and terms", async () => {
  const { planGroup } = await import("../src/b2b/import.ts");
  const a = planCompany({ ...customer, CustomerCode: "CMMD", CustomerName: "CMMD", PaymentTerm: "30 Days" } as never, [sites[0]] as never, 30);
  const b = planCompany({ ...customer, CustomerCode: "GRIMESQUAD PTY LTD", CustomerName: "Grimesquad", PaymentTerm: "14 Days" } as never, [sites[1]] as never, 30);
  const g = planGroup("FIT Services Group", [{ code: "CMMD", name: "CMMD", plan: a }, { code: "GRIMESQUAD PTY LTD", name: "Grimesquad", plan: b }]);
  assert.equal(g.code, "GROUP:FIT Services Group");
  assert.deepEqual(g.sites.map((s) => [s.name, s.customerCode, s.netDays]), [
    ["CMMD - Western Sydney", "CMMD", 30],
    ["Grimesquad - Hospital", "GRIMESQUAD PTY LTD", 14],
  ]);

  const { admin, calls } = fakeShopify();
  const t = [...templates, { id: "net15", name: "Net 15", paymentTermsType: "NET", dueInDays: 15 }];
  const r = await applyCompany({ admin, dryRun: false, templates: t, companyMap: {} }, g);
  assert.equal(r.status, "created", r.notes.join());
  const create = calls.find((c) => c.query.includes("companyCreate"))!;
  assert.equal((create.variables.input as any).company.externalId, "GROUP:FIT_Services_Group");
  assert.equal((create.variables.input as any).company.name, "FIT Services Group");
  const loc2 = calls.find((c) => c.query.includes("companyLocationCreate"))!;
  assert.equal((loc2.variables.input as any).buyerExperienceConfiguration.paymentTermsTemplateId, "net15");
  const metas = calls.filter((c) => c.query.includes("metafieldsSet")).flatMap((c) => c.variables.m as any[]);
  assert.ok(metas.some((m) => m.key === "group_members" && m.value === "CMMD; GRIMESQUAD PTY LTD"));
  const siteCodes = metas.filter((m) => m.namespace === "unleashed" && m.key === "customer_code").map((m) => m.value).sort();
  assert.deepEqual(siteCodes, ["CMMD", "GRIMESQUAD PTY LTD"]);
});
