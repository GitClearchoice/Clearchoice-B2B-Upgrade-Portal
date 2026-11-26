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
  assert.match(r.problems.join(), /no street address.*unknown state.*postcode/);
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
  { Guid: "s4", AddressName: "Broken", StreetAddress: "4 No State St", City: "Y", PostalCode: "2000" },
];

test("plan uses Delivery tab sites, skips obsolete, reports bad ones", () => {
  const p = planCompany(customer as never, sites as never, 30);
  assert.deepEqual(p.sites.map((s) => s.name), ["Western Sydney", "Hospital"]);
  assert.equal(p.sites[0].note, "Dock 2");
  assert.deepEqual(p.skippedSites, [{ name: "Broken", reason: "no state" }]);
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
  const meta = calls.find((c) => c.query.includes("metafieldsSet"))!;
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
  assert.equal(pickTemplate(t, 0).template?.id, "r");
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
    if (query.includes("companies(")) {
      return reply({ companies: { nodes: [{
        id: "C1", externalId: "BIG", mainContact: { id: "k1" },
        locations: { nodes: locs.slice(0, 250), pageInfo: { hasNextPage: true, endCursor: "c250" } },
        contacts: { nodes: [{ id: "k1", customer: { id: "u1", email: "a@b.co" }, roleAssignments: { nodes: locs.slice(0, 250).map((l) => ({ companyLocation: { id: l.id } })), pageInfo: { hasNextPage: true, endCursor: "r250" } } }] },
        contactRoles: { nodes: [{ id: "role", name: "Location admin" }] },
      }] } });
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
