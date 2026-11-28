// Works out which company, site and Unleashed customer a logged-in storefront buyer orders for.
// Rule (HANDOVER "Shopify data model"): the site's location metafield unleashed.customer_code if
// present (grouped companies), else the company's unleashed.customer_code.

export const BUYER_QUERY = `#graphql
  query BuyerContext($id: ID!) {
    customer(id: $id) {
      id
      displayName
      email: defaultEmailAddress { emailAddress }
      companyContactProfiles {
        id
        company {
          id
          name
          code: metafield(namespace: "unleashed", key: "customer_code") { value }
          noPo: metafield(namespace: "b2b", key: "po_not_required") { value }
        }
        roleAssignments(first: 250) {
          nodes {
            companyLocation {
              id
              name
              code: metafield(namespace: "unleashed", key: "customer_code") { value }
              closed: metafield(namespace: "b2b", key: "closed") { value }
            }
          }
        }
      }
    }
  }`;

export interface BuyerQueryData {
  customer: {
    id: string;
    displayName: string;
    email: { emailAddress: string } | null;
    companyContactProfiles: {
      id: string;
      company: { id: string; name: string; code: { value: string } | null; noPo?: { value: string } | null };
      roleAssignments: {
        nodes: { companyLocation: { id: string; name: string; code: { value: string } | null; closed?: { value: string } | null } | null }[];
      };
    }[];
  } | null;
}

export interface BuyerSite {
  id: string;
  name: string;
  customerCode: string;
}

export interface BuyerContext {
  customerId: string;
  name: string;
  email: string | null;
  /** CompanyContact GID (draft orders need it). */
  contactId: string;
  companyId: string;
  companyName: string;
  /** Company setting "we don't use purchase orders" (company metafield b2b.po_not_required). */
  poNotRequired: boolean;
  sites: BuyerSite[];
  site: BuyerSite;
}

export class BuyerError extends Error {}

/**
 * @param locationId the site the buyer picked (GID or numeric id); defaults to their first site.
 * Returns null when the customer isn't a contact of any company (a retail customer).
 */
export function buyerContext(data: BuyerQueryData, locationId?: string | null): BuyerContext | null {
  const c = data.customer;
  if (!c) return null;
  // Shopify allows a person to be a contact of only one company (see HANDOVER, phase 2).
  const profile = c.companyContactProfiles[0];
  if (!profile) return null;

  const companyCode = profile.company.code?.value?.trim() || null;
  const seen = new Set<string>();
  const sites: BuyerSite[] = [];
  for (const n of profile.roleAssignments.nodes) {
    const loc = n.companyLocation;
    if (!loc || seen.has(loc.id)) continue;
    seen.add(loc.id);
    if (loc.closed?.value === "true") continue; // site closed (obsolete in Unleashed, or closed by the customer)
    const customerCode = loc.code?.value?.trim() || companyCode;
    if (!customerCode) continue; // not linked to Unleashed: can't price or order
    sites.push({ id: loc.id, name: loc.name, customerCode });
  }
  if (sites.length === 0) {
    throw new BuyerError(`${profile.company.name} has no open sites linked to an Unleashed customer`);
  }
  sites.sort((a, b) => a.name.localeCompare(b.name));

  let site = sites[0]!;
  if (locationId) {
    const want = locationId.startsWith("gid://") ? locationId : `gid://shopify/CompanyLocation/${locationId}`;
    const hit = sites.find((s) => s.id === want);
    if (!hit) throw new BuyerError("That site isn't one you can order for (it may have been closed). Please choose another site.");
    site = hit;
  }
  return {
    customerId: c.id,
    name: c.displayName,
    email: c.email?.emailAddress ?? null,
    contactId: profile.id,
    companyId: profile.company.id,
    companyName: profile.company.name,
    poNotRequired: profile.company.noPo?.value === "true",
    sites,
    site,
  };
}

/** Parses "SKU:QTY,SKU:QTY" (the storefront's price request). Quantities must be whole and positive. */
export function parseLinesParam(raw: string | null, max = 250): { sku: string; quantity: number }[] {
  if (!raw) return [];
  const out: { sku: string; quantity: number }[] = [];
  for (const part of raw.split(",")) {
    if (!part.trim()) continue;
    const i = part.lastIndexOf(":");
    const sku = (i === -1 ? part : part.slice(0, i)).trim();
    const qty = i === -1 ? 1 : Number(part.slice(i + 1));
    if (!sku || !Number.isInteger(qty) || qty < 1 || qty > 100_000) throw new BuyerError(`Bad line "${part}"`);
    out.push({ sku, quantity: qty });
    if (out.length > max) throw new BuyerError(`At most ${max} lines`);
  }
  return out;
}
