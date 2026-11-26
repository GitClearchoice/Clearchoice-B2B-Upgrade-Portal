import type { UAddress, UCustomer } from "../unleashed/types.ts";
import { assertNoUserErrors, type ShopifyAdmin, type UserError } from "../shopify/client.ts";
import { siteExternalId, siteName, toShopifyAddress, type ShopifyAddress } from "./address.ts";
import { activeDeliveryAddresses } from "./candidates.ts";

// ---------------------------------------------------------------------------------------------
// Plan: what we want in Shopify for one Unleashed customer. Pure, no API calls.
// ---------------------------------------------------------------------------------------------

export interface PlannedSite {
  externalId: string;
  name: string;
  address: ShopifyAddress;
  note?: string;
}

export interface CompanyPlan {
  code: string;
  name: string;
  contact: { firstName: string; lastName: string; email: string } | null;
  sites: PlannedSite[];
  skippedSites: { name: string; reason: string }[];
  unleashedPaymentTerm: string;
  netDays: number;
  notes: string[];
}

/** "30 Days" → 30; "Same Day" / "Prepaid" → 0 (due on receipt). Anything else uses the default (and says so). */
export function parseNetDays(term: string | null | undefined, fallback: number): { days: number; note?: string } {
  const t = (term ?? "").trim();
  const m = /(\d+)\s*days?/i.exec(t);
  if (m) return { days: Number(m[1]) };
  if (/same\s*day|prepaid|cod|cash/i.test(t)) return { days: 0, note: `Unleashed payment term "${t}" set to due on receipt` };
  return { days: fallback, note: t ? `Unleashed payment term "${t}" mapped to Net ${fallback}` : `no payment term in Unleashed; using Net ${fallback}` };
}

export function planCompany(customer: UCustomer, deliveryAddresses: UAddress[] | undefined, defaultNetDays: number): CompanyPlan {
  const code = customer.CustomerCode;
  const name = (customer.CustomerName ?? "").trim() || code;
  const notes: string[] = [];

  let sources = activeDeliveryAddresses(deliveryAddresses);
  if (!sources.length) {
    const main = (customer.Addresses ?? []).filter((a) => a.StreetAddress);
    const pick =
      main.find((a) => /shipping/i.test(a.AddressType ?? "")) ??
      main.find((a) => /physical/i.test(a.AddressType ?? "")) ??
      main.find((a) => a.IsDefault) ??
      main[0];
    if (pick) {
      sources = [{ ...pick, AddressName: pick.AddressName || "Main site" }];
      notes.push("no Delivery tab sites; used the customer's main address");
    }
  }

  const sites: PlannedSite[] = [];
  const skippedSites: { name: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const a of sources) {
    const nm = siteName(a);
    const { address, problems } = toShopifyAddress(a, name);
    if (!address) { skippedSites.push({ name: nm, reason: problems.join(", ") }); continue; }
    const externalId = siteExternalId(code, a);
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    // Shopify location names must be unique within a company.
    let unique = nm;
    for (let i = 2; sites.some((s) => s.name === unique); i++) unique = `${nm} (${i})`;
    sites.push({ externalId, name: unique, address, ...(a.DeliveryInstruction ? { note: a.DeliveryInstruction.trim() } : {}) });
  }
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

// ---------------------------------------------------------------------------------------------
// Apply: make Shopify match the plan. Safe to re-run: finds existing companies, sites and
// contacts by external ID / email and only creates what's missing. Never deletes anything.
// ---------------------------------------------------------------------------------------------

export interface PaymentTermsTemplate { id: string; name: string; paymentTermsType: string; dueInDays: number | null }

export interface ImportContext {
  admin: ShopifyAdmin;
  dryRun: boolean;
  templates: PaymentTermsTemplate[];
  /** Unleashed code → Shopify company GID, remembered between runs. */
  companyMap: Record<string, string>;
}

export interface ImportResult {
  code: string;
  name: string;
  status: "created" | "updated" | "unchanged" | "skipped" | "error";
  companyId: string;
  sitesCreated: number;
  sitesExisting: number;
  sitesSkipped: string[];
  contact: string;
  paymentTerms: string;
  notes: string[];
}

interface ExistingCompany {
  id: string;
  externalId: string | null;
  mainContact: { id: string } | null;
  locations: { id: string; externalId: string | null; name: string }[];
  contacts: { id: string; email: string | null; customerId: string | null; locationIdsWithRole: string[] }[];
  roles: { id: string; name: string }[];
}

const COMPANY_FIELDS = `
  id externalId
  mainContact { id }
  locations(first: 250) { nodes { id externalId name } pageInfo { hasNextPage endCursor } }
  contacts(first: 100) { nodes { id customer { id email } roleAssignments(first: 250) { nodes { companyLocation { id } } pageInfo { hasNextPage endCursor } } } }
  contactRoles(first: 10) { nodes { id name } }
`;

type PageInfo = { hasNextPage: boolean; endCursor: string | null };

type RawCompany = {
  id: string; externalId: string | null; mainContact: { id: string } | null;
  locations: { nodes: { id: string; externalId: string | null; name: string }[]; pageInfo?: PageInfo };
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
    const q = `external_id:"${code.replace(/(["\\])/g, "\\$1")}"`;
    const r = await ctx.admin.graphql<{ companies: { nodes: RawCompany[] } }>(
      `query($q: String!) { companies(first: 10, query: $q) { nodes { ${COMPANY_FIELDS} } } }`,
      { q },
    );
    raw = r.companies.nodes.find((c) => c.externalId === code);
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
  const out: { id: string; externalId: string | null; name: string }[] = [];
  let after: string | null = null;
  for (;;) {
    const r: { company: { locations: { nodes: typeof out; pageInfo: PageInfo } } } = await ctx.admin.graphql(
      `query($id: ID!, $after: String) { company(id: $id) { locations(first: 250, after: $after) { nodes { id externalId name } pageInfo { hasNextPage endCursor } } } }`,
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
    const receipt = templates.find((t) => /receipt/i.test(t.paymentTermsType));
    return receipt ? { template: receipt } : { note: "Shopify has no 'due on receipt' terms; none set" };
  }
  const net = templates.filter((t) => /net/i.test(t.paymentTermsType) && t.dueInDays != null);
  const exact = net.find((t) => t.dueInDays === days);
  if (exact) return { template: exact };
  if (!net.length) return { note: "no Net payment terms available in Shopify" };
  const nearest = net.slice().sort((a, b) => Math.abs(a.dueInDays! - days) - Math.abs(b.dueInDays! - days))[0];
  return { template: nearest, note: `Shopify has no Net ${days}; used ${nearest.name}` };
}

function locationInput(site: PlannedSite, templateId: string | undefined) {
  return {
    name: site.name,
    externalId: site.externalId,
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
    code: plan.code, name: plan.name, status: "unchanged", companyId: "", sitesCreated: 0, sitesExisting: 0,
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

    // 1. Company (created with its first site)
    if (!company) {
      const first = plan.sites[0];
      if (dry) {
        company = { id: fakeId("company", plan.code), externalId: plan.code, mainContact: null, locations: [], contacts: [], roles: [] };
        company.locations.push({ id: fakeId("site", first.externalId), externalId: first.externalId, name: first.name });
      } else {
        const r = await ctx.admin.graphql<{ companyCreate: { company: RawCompany | null; userErrors: UserError[] } }>(
          `mutation($input: CompanyCreateInput!) { companyCreate(input: $input) { company { ${COMPANY_FIELDS} } userErrors { field message code } } }`,
          {
            input: {
              company: { name: plan.name, externalId: plan.code, note: `Unleashed customer ${plan.code}` },
              companyLocation: locationInput(first, template?.id),
            },
          },
        );
        assertNoUserErrors(`Creating company ${plan.code}`, r.companyCreate.userErrors);
        company = toExisting(r.companyCreate.company!);
      }
      result.status = "created";
      result.sitesCreated++;
      changed = true;
    }
    result.companyId = company.id;
    if (!dry || !company.id.startsWith("(")) ctx.companyMap[plan.code] = company.id;

    // 2. Remaining sites
    const byExt = new Map(company.locations.map((l) => [l.externalId ?? "", l]));
    for (const site of plan.sites) {
      if (byExt.has(site.externalId)) {
        if (!(result.status === "created" && site === plan.sites[0])) result.sitesExisting++;
        continue;
      }
      let id: string;
      if (dry) id = fakeId("site", site.externalId);
      else {
        const r = await ctx.admin.graphql<{ companyLocationCreate: { companyLocation: { id: string } | null; userErrors: UserError[] } }>(
          `mutation($companyId: ID!, $input: CompanyLocationInput!) { companyLocationCreate(companyId: $companyId, input: $input) { companyLocation { id } userErrors { field message code } } }`,
          { companyId: company.id, input: locationInput(site, template?.id) },
        );
        assertNoUserErrors(`Creating site "${site.name}" for ${plan.code}`, r.companyLocationCreate.userErrors);
        id = r.companyLocationCreate.companyLocation!.id;
      }
      company.locations.push({ id, externalId: site.externalId, name: site.name });
      byExt.set(site.externalId, company.locations[company.locations.length - 1]);
      result.sitesCreated++;
      changed = true;
    }

    // 3. Head-office admin = Unleashed primary contact
    if (plan.contact) {
      const email = plan.contact.email.toLowerCase();
      let contact = company.contacts.find((c) => (c.email ?? "").toLowerCase() === email);
      if (contact) result.contact = `existing (${plan.contact.email})`;
      else {
        let contactId: string;
        if (dry) contactId = fakeId("contact", email);
        else contactId = await createOrAttachContact(ctx, company.id, plan.contact);
        contact = { id: contactId, email, customerId: null, locationIdsWithRole: [] };
        company.contacts.push(contact);
        result.contact = `added (${plan.contact.email})`;
        changed = true;
      }

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
    } else {
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
