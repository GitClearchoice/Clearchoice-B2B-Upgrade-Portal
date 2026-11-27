import { test } from "node:test";
import assert from "node:assert/strict";
import { isDormant, lastOrdersFromUnleashed, planSiteChanges, type PortalSite, type SiteState, type UnleashedSites } from "../src/b2b/siteStatus.ts";
import type { UCustomer } from "../src/unleashed/types.ts";

const G1 = "11111111-1111-1111-1111-111111111111";
const G2 = "22222222-2222-2222-2222-222222222222";
const G3 = "33333333-3333-3333-3333-333333333333";
const MAIN = "44444444-4444-4444-4444-444444444444";
const site = (id: string, externalId: string | null, name = id, customerCode: string | null = "ASSET"): PortalSite =>
  ({ locationId: id, companyId: "co", name, externalId, customerCode });
const customer = (over: Partial<UCustomer> = {}): UCustomer => ({ Guid: "c", CustomerCode: "ASSET", Addresses: [{ Guid: MAIN }], ...over });

test("closes sites obsolete or removed in Unleashed; keeps active, main-address and unknown ones", () => {
  const u: UnleashedSites = {
    customers: new Map([["ASSET", customer()]]),
    delivery: new Map([["ASSET", [{ Guid: G1 }, { Guid: G2, Obsolete: true }]]]),
  };
  const sites = [site("a", G1), site("b", G2), site("c", G3), site("d", MAIN), site("e", "ASSET|depot"), site("f", G3, "f", "UNKNOWN")];
  const changes = planSiteChanges(sites, new Map(), u);
  assert.deepEqual(changes.map((c) => [c.site.locationId, c.action, c.reason]), [
    ["b", "close", "delivery address is obsolete in Unleashed"],
    ["c", "close", "delivery address no longer in Unleashed"],
  ]);
});

test("an obsolete customer closes all its sites", () => {
  const u: UnleashedSites = { customers: new Map([["ASSET", customer({ Obsolete: true })]]), delivery: new Map() };
  assert.deepEqual(planSiteChanges([site("a", G1), site("b", "x")], new Map(), u).map((c) => c.action), ["close", "close"]);
});

test("reopens only sites closed because of Unleashed; customer/staff closures stay; no repeat closes", () => {
  const u: UnleashedSites = { customers: new Map([["ASSET", customer()]]), delivery: new Map([["ASSET", [{ Guid: G1 }, { Guid: G2 }, { Guid: G3, Obsolete: true }]]]) };
  const state = new Map<string, SiteState>([
    ["a", { closed: true, source: "unleashed" }],
    ["b", { closed: true, source: "customer" }],
    ["c", { closed: true, source: "unleashed" }],
  ]);
  const changes = planSiteChanges([site("a", G1), site("b", G2), site("c", G3)], state, u);
  assert.deepEqual(changes.map((c) => [c.site.locationId, c.action]), [["a", "reopen"]]);
});

test("no delivery list for a customer: a missing Guid isn't treated as removed", () => {
  const u: UnleashedSites = { customers: new Map([["ASSET", customer()]]), delivery: new Map() };
  assert.deepEqual(planSiteChanges([site("a", G1)], new Map(), u), []);
});

test("last order per site from Unleashed sales orders (name match, group prefix, ignores deleted)", () => {
  const sites = [site("a", G1, "Westpoint Blacktown"), site("b", G2, "CMMD - Head Office", "CMMD")];
  const last = lastOrdersFromUnleashed(sites, [
    { OrderDate: "/Date(1767225600000)/", Customer: { CustomerCode: "ASSET" }, DeliveryName: "WESTPOINT  BLACKTOWN", OrderStatus: "Completed" },
    { OrderDate: "/Date(1777593600000)/", Customer: { CustomerCode: "ASSET" }, DeliveryName: "Westpoint Blacktown", OrderStatus: "Deleted" },
    { OrderDate: "/Date(1772323200000)/", Customer: { CustomerCode: "CMMD" }, DeliveryName: "Head Office", OrderStatus: "Parked" },
    { OrderDate: "/Date(1772323200000)/", Customer: { CustomerCode: "OTHER" }, DeliveryName: "Head Office" },
  ]);
  assert.equal(last.get("a")?.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.equal(last.get("b")?.toISOString(), "2026-03-01T00:00:00.000Z");
});

test("dormant: no order in 6 months, or never", () => {
  const now = new Date("2026-11-28T00:00:00Z");
  assert.equal(isDormant(null, now), true);
  assert.equal(isDormant(new Date("2026-05-27T00:00:00Z"), now), true);
  assert.equal(isDormant(new Date("2026-06-01T00:00:00Z"), now), false);
});

// ---------- daily site refresh (applyCompany with updateExisting + sitesOnly)
import { applyCompany, siteDifferences, type CompanyPlan, type ImportContext } from "../src/b2b/import.ts";

function fakeShopify() {
  const calls: { q: string; v: any }[] = [];
  const company = {
    id: "gid://shopify/Company/1", externalId: "ASSET", mainContact: { id: "gid://shopify/CompanyContact/9" },
    locations: { nodes: [
      { id: "L1", externalId: G1, name: "Westpoint Blactown", note: null, shippingAddress: { address1: "17 Patrick St", address2: null, city: "Blacktown", zoneCode: "NSW", zip: "2148", countryCode: "AU", recipient: "Assetlink" } },
      { id: "L2", externalId: G2, name: "Airport", note: "Dock 3", shippingAddress: { address1: "1 Airport Rd", address2: null, city: "Badgerys Creek", zoneCode: "NSW", zip: "2555", countryCode: "AU", recipient: "Assetlink" } },
    ], pageInfo: { hasNextPage: false, endCursor: null } },
    contacts: { nodes: [
      { id: "C-admin", customer: { id: "u1", email: "admin@x" }, roleAssignments: { nodes: [{ companyLocation: { id: "L1" } }, { companyLocation: { id: "L2" } }] } },
      { id: "C-buyer", customer: { id: "u2", email: "buyer@x" }, roleAssignments: { nodes: [{ companyLocation: { id: "L1" } }] } },
    ] },
    contactRoles: { nodes: [{ id: "R-admin", name: "Location admin" }] },
  };
  const admin = {
    graphql: async <T,>(q: string, v: any = {}): Promise<T> => {
      calls.push({ q, v });
      if (q.includes("company(id: $id)")) return { company } as T;
      if (q.includes("companyLocationCreate")) return { companyLocationCreate: { companyLocation: { id: "L3" }, userErrors: [] } } as T;
      if (q.includes("metafieldsSet")) return { metafieldsSet: { userErrors: [] } } as T;
      if (q.includes("companyLocationUpdate")) return { companyLocationUpdate: { userErrors: [] } } as T;
      if (q.includes("companyLocationAssignAddress")) return { companyLocationAssignAddress: { userErrors: [] } } as T;
      if (q.includes("companyContactAssignRoles")) return { companyContactAssignRoles: { userErrors: [] } } as T;
      throw new Error(`unexpected ${q.slice(0, 60)}`);
    },
  };
  return { admin, calls };
}

const addr = (address1: string, city: string, zip: string) => ({ address1, city, zoneCode: "NSW", zip, countryCode: "AU", recipient: "Assetlink" });
const plan: CompanyPlan = {
  code: "ASSET", name: "Assetlink", contact: { firstName: "A", lastName: "B", email: "unleashed-primary@x" },
  sites: [
    { externalId: G1, name: "Westpoint Blacktown", address: addr("17 Patrick St", "Blacktown", "2148") }, // name typo fixed
    { externalId: G2, name: "Airport", address: addr("2 Airport Rd", "Badgerys Creek", "2555"), note: "Dock 3" }, // address fixed
    { externalId: G3, name: "New Depot", address: addr("5 New St", "Penrith", "2750") }, // new in Unleashed
  ],
  skippedSites: [], unleashedPaymentTerm: "30 Days", netDays: 30, notes: [],
};

test("site refresh: fixes names/addresses, adds new sites for the existing admin, leaves contacts alone", async () => {
  const { admin, calls } = fakeShopify();
  const ctx: ImportContext = { admin, dryRun: false, templates: [], companyMap: { ASSET: "gid://shopify/Company/1" }, updateExisting: true, sitesOnly: true };
  const r = await applyCompany(ctx, plan);
  assert.equal(r.status, "updated");
  assert.equal(r.sitesCreated, 1);
  assert.equal(r.sitesUpdated, 2);
  assert.deepEqual(r.changes, ['Updated "Westpoint Blactown" → "Westpoint Blacktown": name', "Updated Airport: address", "Added site New Depot"]);
  const rename = calls.find((c) => c.q.includes("companyLocationUpdate"))!;
  assert.deepEqual(rename.v, { id: "L1", input: { name: "Westpoint Blacktown", note: "" } });
  assert.equal(calls.find((c) => c.q.includes("companyLocationAssignAddress"))!.v.address.address1, "2 Airport Rd");
  // New site goes to the contact with every existing site (the admin), not the buyer with one site.
  const roles = calls.filter((c) => c.q.includes("companyContactAssignRoles"));
  assert.deepEqual(roles.map((c) => [c.v.id, c.v.roles.map((x: any) => x.companyLocationId)]), [["C-admin", ["L3"]]]);
  // Contacts and the budget admin flag aren't touched.
  assert.ok(!calls.some((c) => /companyAssignMainContact|companyContactCreate|budget_admin_contact/.test(JSON.stringify(c))));
});

test("site refresh: nothing to change when Shopify already matches", async () => {
  const same = { id: "L1", externalId: G1, name: "Airport", note: "Dock 3", shippingAddress: { ...addr("2 Airport Rd", "Badgerys Creek", "2555"), address2: null } };
  assert.deepEqual(siteDifferences(same, plan.sites[1]!), []);
  assert.deepEqual(siteDifferences({ ...same, note: null }, plan.sites[1]!), ["delivery note"]);
});
