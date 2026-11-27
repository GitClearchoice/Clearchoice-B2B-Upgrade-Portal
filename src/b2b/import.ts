import type { UAddress, UCustomer } from "../unleashed/types.ts";
import { assertNoUserErrors, type ShopifyAdmin, type UserError } from "../shopify/client.ts";
import { siteExternalId, siteName, toShopifyAddress, type PostcodeLookup, type ShopifyAddress } from "./address.ts";
import { activeDeliveryAddresses } from "./candidates.ts";

// ---------------------------------------------------------------------------------------------
// Plan: what we want in Shopify for one Unleashed customer. Pure, no API calls.
// ---------------------------------------------------------------------------------------------

export interface PlannedSite {
  externalId: string;
  name: string;
  address: ShopifyAddress;
  note?: string;
  /** Unleashed customer this site belongs to (differs per site in a group company). */
  customerCode?: string;
  /** Payment terms for this site's customer, when it differs from the company's. */
  netDays?: number;
}

export interface SkippedSite {
  name: string;
  reason: string;
  address?: UAddress;
}

export interface CompanyPlan {
  /** Unleashed customer code, or "GROUP:<name>" for a group company. */
  code: string;
  /** For a group company: the Unleashed customer codes it combines. */
  members?: string[];
  name: string;
  contact: { firstName: string; lastName: string; email: string } | null;
  sites: PlannedSite[];
  skippedSites: SkippedSite[];
  unleashedPaymentTerm: string;
  netDays: number;
  notes: string[];
}

/** "30 Days" → 30; "Same Day" / "Prepaid" → 0 (due on receipt). Anything else uses the default (and says so). */
/**
 * Shopify external IDs allow letters, numbers and some symbols, but not spaces. Unleashed codes
 * often have spaces ("BIC SERVICES"), so spaces (and anything else not allowed) become "_".
 * The exact Unleashed code is kept in the company metafield unleashed.customer_code.
 */
export function shopifyExternalId(code: string): string {
  return code.trim().replace(/[^A-Za-z0-9!@#$%^&*(){}\[\]\\/?<>_\-~,.;:'`"]/g, "_").slice(0, 255);
}

export function parseNetDays(term: string | null | undefined, fallback: number): { days: number; note?: string } {
  const t = (term ?? "").trim();
  const m = /(\d+)\s*days?/i.exec(t);
  if (m) return { days: Number(m[1]) };
  if (/same\s*day|prepaid|cod|cash/i.test(t)) return { days: 0, note: `Unleashed payment term "${t}" set to due on receipt` };
  return { days: fallback, note: t ? `Unleashed payment term "${t}" mapped to Net ${fallback}` : `no payment term in Unleashed; using Net ${fallback}` };
}

/** The customer's own addresses (not the Delivery tab), best first: Shipping, Physical, default, Postal. */
function mainAddresses(customer: UCustomer): UAddress[] {
  const main = (customer.Addresses ?? []).filter((a) => a.StreetAddress || a.Suburb || a.City);
  const rank = (a: UAddress) =>
    /shipping/i.test(a.AddressType ?? "") ? 0 : /physical/i.test(a.AddressType ?? "") ? 1 : a.IsDefault ? 2 : 3;
  return main.slice().sort((a, b) => rank(a) - rank(b)).map((a) => ({ ...a, AddressName: a.AddressName || "Main site" }));
}

export function planCompany(
  customer: UCustomer,
  deliveryAddresses: UAddress[] | undefined,
  defaultNetDays: number,
  lookup?: PostcodeLookup,
): CompanyPlan {
  const code = customer.CustomerCode;
  const name = (customer.CustomerName ?? "").trim() || code;
  const notes: string[] = [];

  let sources = activeDeliveryAddresses(deliveryAddresses);
  let usingMain = false;
  if (!sources.length) {
    sources = mainAddresses(customer).slice(0, 1);
    usingMain = sources.length > 0;
    if (usingMain) notes.push("no Delivery tab sites; used the customer's main address");
  }

  const sites: PlannedSite[] = [];
  const skippedSites: SkippedSite[] = [];
  const seen = new Set<string>();
  let rebuiltCount = 0;
  let filledCount = 0;
  for (const a of sources) {
    const nm = siteName(a);
    const { address, problems, rebuilt, extraNote, postcodeFilled } = toShopifyAddress(a, name, nm, lookup);
    if (!address) { skippedSites.push({ name: nm, reason: problems.join(", "), address: a }); continue; }
    if (postcodeFilled) filledCount++;
    else if (rebuilt) rebuiltCount++;
    const externalId = siteExternalId(code, a);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    // Shopify location names must be unique within a company.
    let unique = nm;
    for (let i = 2; sites.some((s) => s.name === unique); i++) unique = `${nm} (${i})`;
    const note = [a.DeliveryInstruction?.trim(), extraNote].filter(Boolean).join(" | ");
    sites.push({ externalId, name: unique, address, ...(note ? { note } : {}) });
  }
  // None of the Delivery tab entries were usable: fall back to the customer's main address so their buyers can still order.
  if (!sites.length && !usingMain) {
    for (const a of mainAddresses(customer)) {
      const { address, extraNote } = toShopifyAddress(a, name, "Main site", lookup);
      if (!address) continue;
      sites.push({ externalId: siteExternalId(code, a), name: "Main site", address, ...(extraNote ? { note: extraNote } : {}) });
      notes.push("none of the Delivery tab addresses were usable; used the customer's main address as their one site");
      break;
    }
  }
  if (rebuiltCount) notes.push(`${rebuiltCount} site address(es) rebuilt from details in the wrong fields; spot-check them in Shopify`);
  if (filledCount) notes.push(`${filledCount} site(s) had no postcode in Unleashed; filled in from other addresses in the same suburb`);
  if (!sites.length) notes.push("no usable delivery address, so no company will be created");

  const email = (customer.Email ?? "").trim();
  const contact = email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? {
        email,
        firstName: (customer.ContactFirstName ?? "").trim(),
        lastName: (customer.ContactLastName ?? "").trim() || name,
      }
    : null;
  if (!contact) notes.push(email ? `primary contact email "${email}" looks invalid` : "no primary contact email, so no head-office admin");

  const { days, note } = parseNetDays(customer.PaymentTerm, defaultNetDays);
  if (note) notes.push(note);

  return { code, name, contact, sites, skippedSites, unleashedPaymentTerm: (customer.PaymentTerm ?? "").trim(), netDays: days, notes };
}

/**
 * Several Unleashed customers run by the same person become one Shopify company. Each site keeps
 * its own Unleashed customer code (and payment terms), so orders still go to the right customer.
 */
export function planGroup(groupName: string, members: { code: string; name: string; plan: CompanyPlan }[]): CompanyPlan {
  const sites: PlannedSite[] = [];
  const skippedSites: SkippedSite[] = [];
  const notes: string[] = [`group of ${members.map((m) => m.code).join(", ")}`];
  for (const m of members) {
    for (const s of m.plan.sites) {
      let name = `${m.name} - ${s.name}`;
      for (let i = 2; sites.some((x) => x.name === name); i++) name = `${m.name} - ${s.name} (${i})`;
      sites.push({ ...s, name, customerCode: m.code, netDays: m.plan.netDays });
    }
    skippedSites.push(...m.plan.skippedSites.map((s) => ({ ...s, name: `${m.name} - ${s.name}` })));
    notes.push(...m.plan.notes.map((n) => `${m.code}: ${n}`));
  }
  const contact = members.map((m) => m.plan.contact).find(Boolean) ?? null;
  const emails = new Set(members.map((m) => m.plan.contact?.email.toLowerCase()).filter(Boolean));
  if (emails.size > 1) notes.push(`members have different primary contacts; using ${contact?.email} as the group's admin`);
  return {
    code: `GROUP:${groupName}`,
    members: members.map((m) => m.code),
    name: groupName,
    contact,
    sites,
    skippedSites,
    unleashedPaymentTerm: members[0]?.plan.unleashedPaymentTerm ?? "",
    netDays: members[0]?.plan.netDays ?? 30,
    notes,
  };
}

// ---------------------------------------------------------------------------------------------
// Apply: make Shopify match the plan. Safe to re-run: finds existing companies, sites and
// contacts by external ID / email and only creates what's missing. Never deletes anything.
// ---------------------------------------------------------------------------------------------

export interface PaymentTermsTemplate { id: string; name: string; paymentTermsType: string; dueInDays: number | null }

export interface ImportContext {
  admin: Pick<ShopifyAdmin, "graphql">;
  dryRun: boolean;
  templates: PaymentTermsTemplate[];
  /** Unleashed code → Shopify company GID, remembered between runs. */
  companyMap: Record<string, string>;
  /** Also bring existing sites' name, address and delivery note into line with Unleashed (daily site refresh). */
  updateExisting?: boolean;
  /**
   * Sites only (daily site refresh): don't touch contacts, main contact or the budget admin flag (staff
   * may have changed them in Shopify); new sites go to whoever already has every existing site.
   */
  sitesOnly?: boolean;
}

export interface ImportResult {
  code: string;
  name: string;
  status: "created" | "updated" | "unchanged" | "skipped" | "error";
  companyId: string;
  sitesCreated: number;
  sitesExisting: number;
  sitesUpdated: number;
  /** Human-readable list of what was created or changed (shown after a manual site refresh). */
  changes: string[];
  sitesSkipped: string[];
  contact: string;
  paymentTerms: string;
  notes: string[];
}

type ExistingAddress = { address1: string | null; address2: string | null; city: string | null; zoneCode: string | null; zip: string | null; countryCode: string | null; recipient: string | null } | null;
interface ExistingLocation { id: string; externalId: string | null; name: string; note?: string | null; shippingAddress?: ExistingAddress }

interface ExistingCompany {
  id: string;
  externalId: string | null;
  mainContact: { id: string } | null;
  locations: ExistingLocation[];
  contacts: { id: string; email: string | null; customerId: string | null; locationIdsWithRole: string[] }[];
  roles: { id: string; name: string }[];
}

const LOCATION_FIELDS = "id externalId name note shippingAddress { address1 address2 city zoneCode zip countryCode recipient }";

const COMPANY_FIELDS = `
  id externalId
  mainContact { id }
  locations(first: 100) { nodes { ${LOCATION_FIELDS} } pageInfo { hasNextPage endCursor } }
  contacts(first: 10) { nodes { id customer { id email } roleAssignments(first: 25) { nodes { companyLocation { id } } pageInfo { hasNextPage endCursor } } } }
  contactRoles(first: 10) { nodes { id name } }
`;

type PageInfo = { hasNextPage: boolean; endCursor: string | null };

type RawCompany = {
  id: string; externalId: string | null; mainContact: { id: string } | null;
  locations: { nodes: ExistingLocation[]; pageInfo?: PageInfo };
  contacts: { nodes: { id: string; customer: { id: string; email: string | null } | null; roleAssignments: { nodes: { companyLocation: { id: string } | null }[]; pageInfo?: PageInfo } }[] };
  contactRoles: { nodes: { id: string; name: string }[] };
};

function toExisting(c: RawCompany): ExistingCompany {
  return {
    id: c.id,
    externalId: c.externalId,
    mainContact: c.mainContact,
    locations: c.locations.nodes,
    contacts: c.contacts.nodes.map((n) => ({
      id: n.id,
      email: n.customer?.email ?? null,
      customerId: n.customer?.id ?? null,
      locationIdsWithRole: n.roleAssignments.nodes.map((r) => r.companyLocation?.id).filter((x): x is string => !!x),
    })),
    roles: c.contactRoles.nodes,
  };
}

export async function findCompany(ctx: ImportContext, code: string): Promise<ExistingCompany | null> {
  let raw: RawCompany | undefined;
  const known = ctx.companyMap[code];
  if (known) {
    const r = await ctx.admin.graphql<{ company: RawCompany | null }>(`query($id: ID!) { company(id: $id) { ${COMPANY_FIELDS} } }`, { id: known });
    if (r.company) raw = r.company;
  }
  if (!raw) {
    // Search with a light query (Shopify limits query cost), then load the one match in full.
    const ext = shopifyExternalId(code);
    const q = `external_id:"${ext.replace(/(["\\])/g, "\\$1")}"`;
    const r = await ctx.admin.graphql<{ companies: { nodes: { id: string; externalId: string | null }[] } }>(
      `query($q: String!) { companies(first: 10, query: $q) { nodes { id externalId } } }`,
      { q },
    );
    const hit = r.companies.nodes.find((c) => c.externalId === ext);
    if (hit) {
      const full = await ctx.admin.graphql<{ company: RawCompany | null }>(`query($id: ID!) { company(id: $id) { ${COMPANY_FIELDS} } }`, { id: hit.id });
      raw = full.company ?? undefined;
    }
  }
  if (!raw) return null;
  const company = toExisting(raw);
  // Some customers have hundreds of sites: fetch the rest so re-runs don't try to recreate them.
  if (raw.locations.pageInfo?.hasNextPage) company.locations = await allLocations(ctx, company.id);
  for (const [i, c] of raw.contacts.nodes.entries()) {
    if (c.roleAssignments.pageInfo?.hasNextPage) company.contacts[i].locationIdsWithRole = await allRoleLocationIds(ctx, c.id);
  }
  return company;
}

async function allLocations(ctx: ImportContext, companyId: string) {
  const out: ExistingLocation[] = [];
  let after: string | null = null;
  for (;;) {
    const r: { company: { locations: { nodes: typeof out; pageInfo: PageInfo } } } = await ctx.admin.graphql(
      `query($id: ID!, $after: String) { company(id: $id) { locations(first: 250, after: $after) { nodes { ${LOCATION_FIELDS} } pageInfo { hasNextPage endCursor } } } }`,
      { id: companyId, after },
    );
    out.push(...r.company.locations.nodes);
    if (!r.company.locations.pageInfo.hasNextPage) return out;
    after = r.company.locations.pageInfo.endCursor;
  }
}

async function allRoleLocationIds(ctx: ImportContext, contactId: string): Promise<string[]> {
  const out: string[] = [];
  let after: string | null = null;
  for (;;) {
    const r: { companyContact: { roleAssignments: { nodes: { companyLocation: { id: string } | null }[]; pageInfo: PageInfo } } } = await ctx.admin.graphql(
      `query($id: ID!, $after: String) { companyContact(id: $id) { roleAssignments(first: 250, after: $after) { nodes { companyLocation { id } } pageInfo { hasNextPage endCursor } } } }`,
      { id: contactId, after },
    );
    out.push(...r.companyContact.roleAssignments.nodes.map((n) => n.companyLocation?.id).filter((x): x is string => !!x));
    if (!r.companyContact.roleAssignments.pageInfo.hasNextPage) return out;
    after = r.companyContact.roleAssignments.pageInfo.endCursor;
  }
}

export function pickTemplate(templates: PaymentTermsTemplate[], days: number): { template?: PaymentTermsTemplate; note?: string } {
  if (days === 0) {
    // Shopify doesn't allow "due on receipt" on B2B locations. Trade orders are invoiced by Unleashed
    // anyway (the Shopify draft is never completed), so no Shopify terms is fine here.
    return { note: "Prepaid / Same Day in Unleashed: no payment terms set in Shopify" };
  }
  const net = templates.filter((t) => /net/i.test(t.paymentTermsType) && t.dueInDays != null);
  const exact = net.find((t) => t.dueInDays === days);
  if (exact) return { template: exact };
  if (!net.length) return { note: "no Net payment terms available in Shopify" };
  const nearest = net.slice().sort((a, b) => Math.abs(a.dueInDays! - days) - Math.abs(b.dueInDays! - days))[0];
  return { template: nearest, note: `Shopify has no Net ${days}; used ${nearest.name}` };
}

function siteTemplateId(ctx: ImportContext, site: PlannedSite, fallback: string | undefined): string | undefined {
  if (site.netDays === undefined) return fallback;
  return pickTemplate(ctx.templates, site.netDays).template?.id;
}

function locationInput(site: PlannedSite, templateId: string | undefined) {
  return {
    name: site.name,
    externalId: shopifyExternalId(site.externalId),
    shippingAddress: site.address,
    billingSameAsShipping: true,
    ...(site.note ? { note: site.note } : {}),
    buyerExperienceConfiguration: {
      checkoutToDraft: true, // safety net if a buyer ever reaches native checkout
      editableShippingAddress: false, // no one-time shipping addresses
      ...(templateId ? { paymentTermsTemplateId: templateId } : {}),
    },
  };
}

export async function applyCompany(ctx: ImportContext, plan: CompanyPlan): Promise<ImportResult> {
  const result: ImportResult = {
    code: plan.code, name: plan.name, status: "unchanged", companyId: "", sitesCreated: 0, sitesExisting: 0, sitesUpdated: 0, changes: [],
    sitesSkipped: plan.skippedSites.map((s) => `${s.name}: ${s.reason}`), contact: "", paymentTerms: "", notes: [...plan.notes],
  };
  if (!plan.sites.length) { result.status = "skipped"; return result; }

  const { template, note } = pickTemplate(ctx.templates, plan.netDays);
  if (note) result.notes.push(note);
  result.paymentTerms = template?.name ?? "none";
  const dry = ctx.dryRun;
  const fakeId = (kind: string, key: string) => `(new ${kind} ${key})`;

  try {
    let company = await findCompany(ctx, plan.code);
    let changed = false;
    const newSiteCodes: { id: string; code: string }[] = [];

    // 1. Company (created with its first site)
    if (!company) {
      const first = plan.sites[0];
      if (dry) {
        company = { id: fakeId("company", plan.code), externalId: shopifyExternalId(plan.code), mainContact: null, locations: [], contacts: [], roles: [] };
        company.locations.push({ id: fakeId("site", first.externalId), externalId: shopifyExternalId(first.externalId), name: first.name });
      } else {
        const r = await ctx.admin.graphql<{ companyCreate: { company: RawCompany | null; userErrors: UserError[] } }>(
          `mutation($input: CompanyCreateInput!) { companyCreate(input: $input) { company { ${COMPANY_FIELDS} } userErrors { field message code } } }`,
          {
            input: {
              company: { name: plan.name, externalId: shopifyExternalId(plan.code), note: `Unleashed customer ${plan.code}` },
              companyLocation: locationInput(first, siteTemplateId(ctx, first, template?.id)),
            },
          },
        );
        assertNoUserErrors(`Creating company ${plan.code}`, r.companyCreate.userErrors);
        company = toExisting(r.companyCreate.company!);
      }
      result.status = "created";
      result.sitesCreated++;
      changed = true;
      const firstLoc = company.locations.find((l) => l.externalId === shopifyExternalId(first.externalId));
      if (firstLoc) newSiteCodes.push({ id: firstLoc.id, code: first.customerCode ?? plan.code });
    }
    result.companyId = company.id;
    if (!dry) {
      const r = await ctx.admin.graphql<{ metafieldsSet: { userErrors: UserError[] } }>(
        `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message code } } }`,
        {
          m: [
            plan.members
              ? { ownerId: company.id, namespace: "unleashed", key: "group_members", type: "single_line_text_field", value: plan.members.join("; ") }
              : { ownerId: company.id, namespace: "unleashed", key: "customer_code", type: "single_line_text_field", value: plan.code },
          ],
        },
      );
      assertNoUserErrors(`Saving Unleashed code for ${plan.code}`, r.metafieldsSet.userErrors);
    }
    if (!dry || !company.id.startsWith("(")) ctx.companyMap[plan.code] = company.id;

    // 2. Remaining sites
    const byExt = new Map(company.locations.map((l) => [l.externalId ?? "", l]));
    const existingIds = new Set(company.locations.map((l) => l.id));
    for (const site of plan.sites) {
      const have = byExt.get(shopifyExternalId(site.externalId)) ?? byExt.get(site.externalId);
      if (have) {
        if (!(result.status === "created" && site === plan.sites[0])) result.sitesExisting++;
        if (ctx.updateExisting && !dry) {
          try {
            const what = await updateLocation(ctx, have, site);
            if (what.length) {
              result.sitesUpdated++;
              result.changes.push(`Updated ${have.name === site.name ? site.name : `"${have.name}" → "${site.name}"`}: ${what.join(", ")}`);
              changed = true;
            }
          } catch (e) {
            result.changes.push(`Couldn't update ${site.name}: ${(e as Error).message}`);
          }
        }
        continue;
      }
      let id: string;
      if (dry) id = fakeId("site", site.externalId);
      else {
        const r = await ctx.admin.graphql<{ companyLocationCreate: { companyLocation: { id: string } | null; userErrors: UserError[] } }>(
          `mutation($companyId: ID!, $input: CompanyLocationInput!) { companyLocationCreate(companyId: $companyId, input: $input) { companyLocation { id } userErrors { field message code } } }`,
          { companyId: company.id, input: locationInput(site, siteTemplateId(ctx, site, template?.id)) },
        );
        const errs = r.companyLocationCreate.userErrors;
        if (errs?.length || !r.companyLocationCreate.companyLocation) {
          // One bad site (e.g. a postcode Shopify won't accept) shouldn't stop the rest of the customer.
          const why = `Shopify rejected it: ${(errs ?? []).map((e) => e.message).join("; ") || "unknown error"}`;
          result.sitesSkipped.push(`${site.name}: ${why}`);
          plan.skippedSites.push({
            name: site.name,
            reason: why,
            address: { StreetAddress: site.address.address1, StreetAddress2: site.address.address2, City: site.address.city, Region: site.address.zoneCode, PostalCode: site.address.zip, Country: site.address.countryCode },
          });
          continue;
        }
        id = r.companyLocationCreate.companyLocation.id;
      }
      company.locations.push({ id, externalId: shopifyExternalId(site.externalId), name: site.name });
      byExt.set(shopifyExternalId(site.externalId), company.locations[company.locations.length - 1]);
      result.sitesCreated++;
      result.changes.push(`Added site ${site.name}`);
      changed = true;
      newSiteCodes.push({ id, code: site.customerCode ?? plan.code });
    }

    // Each new site records its Unleashed customer code (orders are sent to Unleashed using it).
    if (!dry) {
      for (let i = 0; i < newSiteCodes.length; i += 25) {
        const r = await ctx.admin.graphql<{ metafieldsSet: { userErrors: UserError[] } }>(
          `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message code } } }`,
          { m: newSiteCodes.slice(i, i + 25).map((s) => ({ ownerId: s.id, namespace: "unleashed", key: "customer_code", type: "single_line_text_field", value: s.code })) },
        );
        assertNoUserErrors(`Saving Unleashed codes on sites of ${plan.code}`, r.metafieldsSet.userErrors);
      }
    }

    // Daily site refresh: give new sites to the contacts who already have every existing site
    // (the head-office admin(s)); leave contacts and the budget admin as staff set them.
    if (ctx.sitesOnly) {
      const newIds = company.locations.filter((l) => !existingIds.has(l.id)).map((l) => l.id);
      if (newIds.length && !dry && existingIds.size) {
        const role = company.roles.find((r) => /admin/i.test(r.name)) ?? company.roles.find((r) => /order/i.test(r.name)) ?? company.roles[0];
        for (const c of company.contacts) {
          if (!role || ![...existingIds].every((id) => c.locationIdsWithRole.includes(id))) continue;
          const r = await ctx.admin.graphql<{ companyContactAssignRoles: { userErrors: UserError[] } }>(
            `mutation($id: ID!, $roles: [CompanyContactRoleAssign!]!) { companyContactAssignRoles(companyContactId: $id, rolesToAssign: $roles) { userErrors { field message code } } }`,
            { id: c.id, roles: newIds.map((l) => ({ companyContactRoleId: role.id, companyLocationId: l })) },
          );
          assertNoUserErrors(`Giving ${c.email ?? c.id} the new sites of ${plan.code}`, r.companyContactAssignRoles.userErrors);
        }
      }
      if (result.status !== "created") result.status = changed ? "updated" : "unchanged";
      return result;
    }

    // 3. Head-office admin = Unleashed primary contact
    if (plan.contact) {
      const email = plan.contact.email.toLowerCase();
      let contact = company.contacts.find((c) => (c.email ?? "").toLowerCase() === email);
      if (contact) result.contact = `existing (${plan.contact.email})`;
      else {
        let contactId: string | null = null;
        if (dry) contactId = fakeId("contact", email);
        else {
          try {
            contactId = await createOrAttachContact(ctx, company.id, plan.contact);
          } catch (e) {
            // Shopify: one person can be a contact for only one company.
            if (!/already associated with a company contact/i.test((e as Error).message)) throw e;
            result.contact = `not set: ${plan.contact.email} is already the admin for another company`;
            result.notes.push(
              `head-office admin not set: ${plan.contact.email} is already a contact for another company, and Shopify allows only one. Give this customer a different primary contact in Unleashed and re-run.`,
            );
          }
        }
        if (contactId) {
          contact = { id: contactId, email, customerId: null, locationIdsWithRole: [] };
          company.contacts.push(contact);
          result.contact = `added (${plan.contact.email})`;
          changed = true;
        }
      }
    }

    // Admin roles, main contact and budget flag (only when there is an admin).
    const contactEmail = plan.contact?.email.toLowerCase();
    const contact = contactEmail ? company.contacts.find((c) => (c.email ?? "").toLowerCase() === contactEmail) : undefined;
    if (plan.contact && contact) {
      if (company.mainContact?.id !== contact.id) {
        if (!dry) {
          const r = await ctx.admin.graphql<{ companyAssignMainContact: { userErrors: UserError[] } }>(
            `mutation($companyId: ID!, $contactId: ID!) { companyAssignMainContact(companyId: $companyId, companyContactId: $contactId) { userErrors { field message code } } }`,
            { companyId: company.id, contactId: contact.id },
          );
          assertNoUserErrors(`Setting main contact for ${plan.code}`, r.companyAssignMainContact.userErrors);
        }
        changed = true;
      }

      // Give the admin a role on every site so they can order for (and later approve) all of them.
      const role = company.roles.find((r) => /admin/i.test(r.name)) ?? company.roles.find((r) => /order/i.test(r.name)) ?? company.roles[0];
      const missing = company.locations.filter((l) => !contact!.locationIdsWithRole.includes(l.id));
      if (missing.length) {
        if (!dry) {
          if (!role) throw new Error(`No contact roles found on company ${plan.code}`);
          for (let i = 0; i < missing.length; i += 50) {
            const r = await ctx.admin.graphql<{ companyContactAssignRoles: { userErrors: UserError[] } }>(
              `mutation($id: ID!, $roles: [CompanyContactRoleAssign!]!) { companyContactAssignRoles(companyContactId: $id, rolesToAssign: $roles) { userErrors { field message code } } }`,
              { id: contact.id, roles: missing.slice(i, i + 50).map((l) => ({ companyContactRoleId: role.id, companyLocationId: l.id })) },
            );
            assertNoUserErrors(`Assigning ${plan.contact.email} to sites of ${plan.code}`, r.companyContactAssignRoles.userErrors);
          }
        }
        contact.locationIdsWithRole.push(...missing.map((l) => l.id));
        changed = true;
      }

      // Flag the budget admin on the company (read by the budgets/approvals features later).
      if (!dry) {
        const r = await ctx.admin.graphql<{ metafieldsSet: { userErrors: UserError[] } }>(
          `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message code } } }`,
          { m: [{ ownerId: company.id, namespace: "b2b", key: "budget_admin_contact", type: "single_line_text_field", value: contact.id }] },
        );
        assertNoUserErrors(`Flagging budget admin for ${plan.code}`, r.metafieldsSet.userErrors);
      }
    } else if (!plan.contact) {
      result.contact = "none";
    }

    if (result.status !== "created") result.status = changed ? "updated" : "unchanged";
    return result;
  } catch (e) {
    result.status = "error";
    result.notes.push((e as Error).message);
    return result;
  }
}

const ADDRESS_KEYS = ["address1", "address2", "city", "zoneCode", "zip", "countryCode", "recipient"] as const;
const clean = (v: unknown) => String(v ?? "").trim();

/** What differs between a Shopify site and its Unleashed version (empty = nothing). */
export function siteDifferences(have: ExistingLocation, want: PlannedSite): string[] {
  const out: string[] = [];
  if (clean(have.name) !== clean(want.name)) out.push("name");
  const a = have.shippingAddress;
  if (!a || ADDRESS_KEYS.some((k) => clean(a[k]) !== clean(want.address[k]))) out.push("address");
  if (clean(have.note) !== clean(want.note)) out.push("delivery note");
  return out;
}

async function updateLocation(ctx: ImportContext, have: ExistingLocation, want: PlannedSite): Promise<string[]> {
  const diff = siteDifferences(have, want);
  if (diff.includes("name") || diff.includes("delivery note")) {
    const r = await ctx.admin.graphql<{ companyLocationUpdate: { userErrors: UserError[] } }>(
      `mutation($id: ID!, $input: CompanyLocationUpdateInput!) { companyLocationUpdate(companyLocationId: $id, input: $input) { userErrors { field message code } } }`,
      { id: have.id, input: { name: want.name, note: want.note ?? "" } },
    );
    assertNoUserErrors(`Updating site ${want.name}`, r.companyLocationUpdate.userErrors);
  }
  if (diff.includes("address")) {
    const r = await ctx.admin.graphql<{ companyLocationAssignAddress: { userErrors: UserError[] } }>(
      `mutation($id: ID!, $address: CompanyAddressInput!) { companyLocationAssignAddress(locationId: $id, address: $address, addressTypes: [SHIPPING, BILLING]) { userErrors { field message code } } }`,
      { id: have.id, address: want.address },
    );
    assertNoUserErrors(`Updating the address of ${want.name}`, r.companyLocationAssignAddress.userErrors);
  }
  return diff;
}

async function createOrAttachContact(
  ctx: ImportContext,
  companyId: string,
  c: { firstName: string; lastName: string; email: string },
): Promise<string> {
  // If a Shopify customer already has this email (e.g. they've shopped online), attach them.
  const found = await ctx.admin.graphql<{ customers: { nodes: { id: string; email: string | null }[] } }>(
    `query($q: String!) { customers(first: 5, query: $q) { nodes { id email } } }`,
    { q: `email:"${c.email.replace(/"/g, "")}"` },
  );
  const existing = found.customers.nodes.find((n) => (n.email ?? "").toLowerCase() === c.email.toLowerCase());
  if (existing) {
    const r = await ctx.admin.graphql<{ companyAssignCustomerAsContact: { companyContact: { id: string } | null; userErrors: UserError[] } }>(
      `mutation($companyId: ID!, $customerId: ID!) { companyAssignCustomerAsContact(companyId: $companyId, customerId: $customerId) { companyContact { id } userErrors { field message code } } }`,
      { companyId, customerId: existing.id },
    );
    assertNoUserErrors(`Attaching ${c.email}`, r.companyAssignCustomerAsContact.userErrors);
    return r.companyAssignCustomerAsContact.companyContact!.id;
  }
  const r = await ctx.admin.graphql<{ companyContactCreate: { companyContact: { id: string } | null; userErrors: UserError[] } }>(
    `mutation($companyId: ID!, $input: CompanyContactInput!) { companyContactCreate(companyId: $companyId, input: $input) { companyContact { id } userErrors { field message code } } }`,
    { companyId, input: { email: c.email, firstName: c.firstName || undefined, lastName: c.lastName } },
  );
  assertNoUserErrors(`Creating contact ${c.email}`, r.companyContactCreate.userErrors);
  return r.companyContactCreate.companyContact!.id;
}

export async function loadPaymentTermsTemplates(admin: ShopifyAdmin): Promise<PaymentTermsTemplate[]> {
  const r = await admin.graphql<{ paymentTermsTemplates: PaymentTermsTemplate[] }>(
    `query { paymentTermsTemplates { id name paymentTermsType dueInDays } }`,
  );
  return r.paymentTermsTemplates;
}

export const REPORT_HEADER = [
  "Customer Code", "Customer Name", "Result", "Shopify Company ID", "Sites Created", "Sites Already There",
  "Sites Skipped", "Head-office Admin", "Payment Terms", "Notes",
];

export function reportRow(r: ImportResult): (string | number)[] {
  return [r.code, r.name, r.status, r.companyId, r.sitesCreated, r.sitesExisting, r.sitesSkipped.join(" | "), r.contact, r.paymentTerms, r.notes.join(" | ")];
}

export const SKIPPED_HEADER = ["Customer Code", "Site Name", "Street", "Street 2", "Suburb", "City", "State", "Postcode", "Country", "Why it was skipped"];

export function skippedRows(plan: CompanyPlan): string[][] {
  return plan.skippedSites.map((s) => [
    plan.code, s.name, s.address?.StreetAddress ?? "", s.address?.StreetAddress2 ?? "", s.address?.Suburb ?? "",
    s.address?.City ?? "", s.address?.Region ?? "", s.address?.PostalCode ?? "", s.address?.Country ?? "", s.reason,
  ]);
}

/** "no postcode, no state" x 40 → [["no postcode", 40], ["no state", 40]] */
export function reasonCounts(plans: CompanyPlan[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const p of plans) for (const s of p.skippedSites) for (const r of s.reason.split(", ")) {
    const key = r.replace(/".*"/, '"…"');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}
