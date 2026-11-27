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
