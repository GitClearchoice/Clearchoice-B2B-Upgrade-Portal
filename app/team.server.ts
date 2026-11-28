// "Site managers" on the head-office admin's Site budgets page: the company's contacts and which
// sites each can order for (Shopify company contacts + roles "Ordering only" / "Location admin").
import { emailer } from "./orders.server";
import { openSites } from "./customer-budgets.server";
import { siteAccessEmail, teamChangeEmail } from "../src/email/templates.ts";
import type { ShopifyGraphql } from "../src/orders/placeOrder.ts";

type UserError = { field?: string[] | null; message: string };
const check = (what: string, errs: UserError[] | undefined) => {
  if (errs?.length) throw new Error(`${what}: ${errs.map((e) => e.message).join("; ")}`);
};

const ROLES = `#graphql
  query TeamRoles($id: ID!) {
    company(id: $id) { name contactRoles(first: 10) { nodes { id name } } }
    shop { primaryDomain { url } }
  }`;

const CONTACTS = `#graphql
  query TeamContacts($id: ID!, $after: String) {
    company(id: $id) {
      contacts(first: 25, after: $after) {
        nodes {
          id
          isMainContact
          customer { id firstName lastName displayName defaultEmailAddress { emailAddress } }
          roleAssignments(first: 30) {
            nodes { id role { id name } companyLocation { id name } }
            pageInfo { hasNextPage endCursor }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

const MORE_ROLES = `#graphql
  query TeamContactRoles($id: ID!, $after: String) {
    companyContact(id: $id) {
      roleAssignments(first: 250, after: $after) {
        nodes { id role { id name } companyLocation { id name } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }`;

type Assignment = { id: string; role: { id: string; name: string }; companyLocation: { id: string; name: string } | null };
type Contact = {
  id: string;
  isMainContact: boolean;
  customer: { id: string; firstName: string | null; lastName: string | null; displayName: string; defaultEmailAddress: { emailAddress: string } | null } | null;
  roleAssignments: { nodes: Assignment[]; pageInfo: { hasNextPage: boolean; endCursor: string } };
};

export type TeamRole = "ordering" | "admin";
const roleKey = (name: string): TeamRole => (/admin/i.test(name) ? "admin" : "ordering");

async function companyRoles(shopify: ShopifyGraphql, companyId: string) {
  const d = await shopify<{ company: { name: string; contactRoles: { nodes: { id: string; name: string }[] } } | null; shop: { primaryDomain: { url: string } } }>(ROLES, { id: companyId });
  if (!d.company) throw new Error("Company not found");
  const nodes = d.company.contactRoles.nodes;
  const admin = nodes.find((r) => /admin/i.test(r.name));
  const ordering = nodes.find((r) => /order/i.test(r.name)) ?? nodes.find((r) => r !== admin);
  if (!admin || !ordering) throw new Error("This company has no Ordering only / Location admin roles in Shopify");
  return { companyName: d.company.name, roles: { admin, ordering }, storeUrl: d.shop.primaryDomain.url };
}

async function allAssignments(shopify: ShopifyGraphql, c: Contact): Promise<Assignment[]> {
  const out = [...c.roleAssignments.nodes];
  let page = c.roleAssignments.pageInfo;
  while (page.hasNextPage) {
    const d: { companyContact: { roleAssignments: { nodes: Assignment[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } } = await shopify(MORE_ROLES, { id: c.id, after: page.endCursor });
    out.push(...d.companyContact.roleAssignments.nodes);
    page = d.companyContact.roleAssignments.pageInfo;
  }
  return out;
}

async function contacts(shopify: ShopifyGraphql, companyId: string): Promise<Contact[]> {
  const out: Contact[] = [];
  let after: string | null = null;
  for (let i = 0; i < 40; i++) {
    const d: { company: { contacts: { nodes: Contact[]; pageInfo: { hasNextPage: boolean; endCursor: string } } } | null } = await shopify(CONTACTS, { id: companyId, after });
    if (!d.company) break;
    out.push(...d.company.contacts.nodes);
    if (!d.company.contacts.pageInfo.hasNextPage) break;
    after = d.company.contacts.pageInfo.endCursor;
  }
  return out;
}

/** The people who can order for the company, for the Site managers list. */
export async function teamView(shop: string, shopify: ShopifyGraphql, companyId: string, adminEmail: string | null) {
  const [list, sites] = await Promise.all([contacts(shopify, companyId), openSites(shop, shopify, companyId)]);
  const people = [];
  for (const c of list) {
    if (!c.customer) continue;
    const email = c.customer.defaultEmailAddress?.emailAddress ?? null;
    const isYou = !!email && !!adminEmail && email.toLowerCase() === adminEmail.toLowerCase();
    const assignments = c.roleAssignments.pageInfo.hasNextPage && !isYou ? await allAssignments(shopify, c) : c.roleAssignments.nodes;
    const siteRoles = assignments.filter((a) => a.companyLocation).map((a) => ({ id: a.companyLocation!.id, name: a.companyLocation!.name, role: roleKey(a.role.name) }));
    people.push({
      id: c.id,
      name: c.customer.displayName,
      email,
      isYou,
      isMainContact: c.isMainContact,
      // Head-office admin (you) / main contact: shown, not editable here.
      locked: isYou || c.isMainContact,
      role: siteRoles.some((r) => r.role === "admin") ? "admin" : "ordering",
      siteCount: isYou && c.roleAssignments.pageInfo.hasNextPage ? sites.length : siteRoles.length,
      sites: isYou ? [] : siteRoles.map((r) => ({ id: r.id, name: r.name })),
    });
  }
  people.sort((a, b) => Number(b.locked) - Number(a.locked) || a.name.localeCompare(b.name));
  return { people, sites: sites.map((s) => ({ id: s.locationId, name: s.name })) };
}

async function findContact(shopify: ShopifyGraphql, companyId: string, contactId: string) {
  const c = (await contacts(shopify, companyId)).find((x) => x.id === contactId);
  if (!c) throw new Error("That person isn't a contact of your company");
  return c;
}

async function setSites(shopify: ShopifyGraphql, contact: Contact, roleId: string, siteIds: string[]) {
  const current = await allAssignments(shopify, contact);
  const keep = new Set<string>();
  const revoke: string[] = [];
  for (const a of current) {
    const loc = a.companyLocation?.id;
    if (loc && siteIds.includes(loc) && a.role.id === roleId) keep.add(loc);
    else revoke.push(a.id);
  }
  for (let i = 0; i < revoke.length; i += 50) {
    const r = await shopify<{ companyContactRevokeRoles: { userErrors: UserError[] } }>(
      `#graphql
      mutation TeamRevoke($id: ID!, $ids: [ID!]!) { companyContactRevokeRoles(companyContactId: $id, roleAssignmentIds: $ids) { userErrors { field message } } }`,
      { id: contact.id, ids: revoke.slice(i, i + 50) },
    );
    check("Removing site access", r.companyContactRevokeRoles.userErrors);
  }
  const add = siteIds.filter((s) => !keep.has(s));
  for (let i = 0; i < add.length; i += 50) {
    const r = await shopify<{ companyContactAssignRoles: { userErrors: UserError[] } }>(
      `#graphql
      mutation TeamAssign($id: ID!, $roles: [CompanyContactRoleAssign!]!) { companyContactAssignRoles(companyContactId: $id, rolesToAssign: $roles) { userErrors { field message } } }`,
      { id: contact.id, roles: add.slice(i, i + 50).map((l) => ({ companyContactRoleId: roleId, companyLocationId: l })) },
    );
    check("Giving site access", r.companyContactAssignRoles.userErrors);
  }
}

export interface TeamActor { name: string; email: string | null }

async function notifyStaff(companyName: string, actor: TeamActor, change: string) {
  const staff = process.env.STAFF_EMAIL;
  if (!staff) return;
  const e = teamChangeEmail({ companyName, adminName: `${actor.name}${actor.email ? ` <${actor.email}>` : ""}`, change });
  await emailer().send({ to: staff, subject: e.subject, html: e.html, text: e.text, tag: "site-access" }).catch((err) => console.error(`[team] staff email: ${err.message}`));
}

/** Adds a person (new or existing customer) to the company with access to the chosen sites. */
export async function addPerson(
  shop: string,
  shopify: ShopifyGraphql,
  companyId: string,
  actor: TeamActor,
  p: { firstName: string; lastName: string; email: string; role: TeamRole; sites: string[] },
) {
  const email = p.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address");
  if (!p.lastName.trim() && !p.firstName.trim()) throw new Error("Enter their name");
  const open = new Set((await openSites(shop, shopify, companyId)).map((s) => s.locationId));
  const sites = [...new Set(p.sites)].filter((s) => open.has(s));
  if (!sites.length) throw new Error("Choose at least one site");
  const { companyName, roles, storeUrl } = await companyRoles(shopify, companyId);

  const existing = (await contacts(shopify, companyId)).find((c) => c.customer?.defaultEmailAddress?.emailAddress?.toLowerCase() === email);
  let contactId = existing?.id;
  if (!contactId) {
    const found = await shopify<{ customers: { nodes: { id: string; defaultEmailAddress: { emailAddress: string } | null }[] } }>(
      `#graphql
      query TeamCustomer($q: String!) { customers(first: 5, query: $q) { nodes { id defaultEmailAddress { emailAddress } } } }`,
      { q: `email:"${email.replace(/"/g, "")}"` },
    );
    const customer = found.customers.nodes.find((n) => n.defaultEmailAddress?.emailAddress?.toLowerCase() === email);
    if (customer) {
      const r = await shopify<{ companyAssignCustomerAsContact: { companyContact: { id: string } | null; userErrors: UserError[] } }>(
        `#graphql
        mutation TeamAttach($company: ID!, $customer: ID!) { companyAssignCustomerAsContact(companyId: $company, customerId: $customer) { companyContact { id } userErrors { field message } } }`,
        { company: companyId, customer: customer.id },
      );
      if (r.companyAssignCustomerAsContact.userErrors.some((e) => /already associated/i.test(e.message))) {
        throw new Error("That email is already used by another company in the trade portal (Shopify allows one company per person). Please contact Clearchoice.");
      }
      check("Adding them to your company", r.companyAssignCustomerAsContact.userErrors);
      contactId = r.companyAssignCustomerAsContact.companyContact!.id;
    } else {
      const r = await shopify<{ companyContactCreate: { companyContact: { id: string } | null; userErrors: UserError[] } }>(
        `#graphql
        mutation TeamCreate($company: ID!, $input: CompanyContactInput!) { companyContactCreate(companyId: $company, input: $input) { companyContact { id } userErrors { field message } } }`,
        { company: companyId, input: { email, firstName: p.firstName.trim() || undefined, lastName: p.lastName.trim() || p.firstName.trim() } },
      );
      check("Creating their login", r.companyContactCreate.userErrors);
      contactId = r.companyContactCreate.companyContact!.id;
    }
  }
  const contact = await findContact(shopify, companyId, contactId);
  if (contact.isMainContact) throw new Error("That person is your company's main contact; Clearchoice manages their access.");
  await setSites(shopify, contact, p.role === "admin" ? roles.admin.id : roles.ordering.id, sites);

  const siteNames = (await openSites(shop, shopify, companyId)).filter((s) => sites.includes(s.locationId)).map((s) => s.name);
  const name = `${p.firstName} ${p.lastName}`.trim() || email;
  const e = siteAccessEmail({ name: p.firstName.trim() || name, companyName, adminName: actor.name, role: p.role, sites: siteNames, loginUrl: `${storeUrl.replace(/\/$/, "")}/account/login` });
  await emailer().send({ to: email, subject: e.subject, html: e.html, text: e.text, tag: "site-access", replyTo: actor.email ?? undefined }).catch((err) => console.error(`[team] welcome email: ${err.message}`));
  await notifyStaff(companyName, actor, `Added ${name} <${email}> as ${p.role === "admin" ? "Location admin" : "Ordering only"} for ${siteNames.length} site(s): ${siteNames.slice(0, 10).join(", ")}${siteNames.length > 10 ? "…" : ""}`);
  return { name, sites: siteNames.length };
}

/** Changes a person's sites and role (replaces their current access). */
export async function updatePerson(shop: string, shopify: ShopifyGraphql, companyId: string, actor: TeamActor, p: { contactId: string; role: TeamRole; sites: string[] }) {
  const contact = await findContact(shopify, companyId, p.contactId);
  const email = contact.customer?.defaultEmailAddress?.emailAddress ?? "";
  if (contact.isMainContact || (actor.email && email.toLowerCase() === actor.email.toLowerCase())) throw new Error("You can't change this person's access here; please contact Clearchoice.");
  const open = new Set((await openSites(shop, shopify, companyId)).map((s) => s.locationId));
  const sites = [...new Set(p.sites)].filter((s) => open.has(s));
  if (!sites.length) throw new Error("Choose at least one site, or remove the person instead");
  const { companyName, roles } = await companyRoles(shopify, companyId);
  await setSites(shopify, contact, p.role === "admin" ? roles.admin.id : roles.ordering.id, sites);
  await notifyStaff(companyName, actor, `Changed ${contact.customer?.displayName} <${email}> to ${p.role === "admin" ? "Location admin" : "Ordering only"} for ${sites.length} site(s)`);
}

/** Removes a person from the company (their login stays, but they can no longer order for it). */
export async function removePerson(shopify: ShopifyGraphql, companyId: string, actor: TeamActor, contactId: string) {
  const contact = await findContact(shopify, companyId, contactId);
  const email = contact.customer?.defaultEmailAddress?.emailAddress ?? "";
  if (contact.isMainContact || (actor.email && email.toLowerCase() === actor.email.toLowerCase())) throw new Error("You can't remove this person here; please contact Clearchoice.");
  const r = await shopify<{ companyContactRemoveFromCompany: { userErrors: UserError[] } }>(
    `#graphql
    mutation TeamRemove($id: ID!) { companyContactRemoveFromCompany(companyContactId: $id) { userErrors { field message } } }`,
    { id: contactId },
  );
  check("Removing them", r.companyContactRemoveFromCompany.userErrors);
  const { companyName } = await companyRoles(shopify, companyId);
  await notifyStaff(companyName, actor, `Removed ${contact.customer?.displayName} <${email}> from the company`);
}
