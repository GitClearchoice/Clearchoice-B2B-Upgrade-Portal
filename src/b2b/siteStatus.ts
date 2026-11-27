// Closed and dormant delivery sites (decided 28 Nov):
// - Unleashed is the master list. A site whose Unleashed delivery address is obsolete (or removed),
//   or whose customer is obsolete, is switched off in the portal; it comes back if reactivated.
// - A head-office admin can close a site themselves: it's switched off at once and Clearchoice staff
//   are emailed to obsolete it in Unleashed.
// - "Dormant" = no order for 6 months (Unleashed sales orders to that site, plus portal orders).
// Switched off = hidden from buyers' site picker, budgets pages and summaries; never deleted, so
// order history stays.
import { parseUnleashedDate } from "../unleashed/client.ts";
import type { UAddress, UCustomer, USalesOrder } from "../unleashed/types.ts";

export type CloseSource = "unleashed" | "customer" | "staff";

export interface PortalSite {
  locationId: string;
  companyId: string;
  name: string;
  /** Location externalId: the Unleashed delivery address Guid (see siteExternalId). */
  externalId: string | null;
  /** Unleashed customer this site orders under (location metafield, else the company's). */
  customerCode: string | null;
}

export interface SiteState {
  closed: boolean;
  source: CloseSource | null;
}

export interface UnleashedSites {
  customers: Map<string, UCustomer>;
  /** Customer code → its Delivery tab addresses (incl. obsolete ones, if Unleashed returns them). */
  delivery: Map<string, UAddress[]>;
}

export interface SiteChange {
  site: PortalSite;
  action: "close" | "reopen";
  reason: string;
}

const isGuid = (s: string | null) => !!s && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** Why Unleashed says this site is no longer used, or null if it's active (or we can't tell). */
export function unleashedClosedReason(site: PortalSite, u: UnleashedSites): string | null {
  if (!site.customerCode) return null;
  const customer = u.customers.get(site.customerCode);
  if (!customer) return null; // not in this download: don't guess
  if (customer.Obsolete) return `customer ${site.customerCode} is obsolete in Unleashed`;
  if (!isGuid(site.externalId)) return null; // site built from a name, not an Unleashed address Guid
  const guid = site.externalId!.toLowerCase();
  const delivery = u.delivery.get(site.customerCode) ?? [];
  const hit = delivery.find((a) => a.Guid?.toLowerCase() === guid);
  if (hit) return hit.Obsolete ? "delivery address is obsolete in Unleashed" : null;
  // Sites made from the customer's main address (no Delivery tab) aren't in the delivery list.
  if ((customer.Addresses ?? []).some((a) => a.Guid?.toLowerCase() === guid)) return null;
  // Only call it removed when we have the customer's delivery list to compare with.
  return delivery.length ? "delivery address no longer in Unleashed" : null;
}

/**
 * What to change: close sites Unleashed says are gone; reopen sites we closed because of Unleashed
 * once they're active there again. Sites closed by the customer or staff stay closed (staff obsolete
 * them in Unleashed, or reopen them by hand).
 */
export function planSiteChanges(sites: PortalSite[], state: Map<string, SiteState>, u: UnleashedSites): SiteChange[] {
  const out: SiteChange[] = [];
  for (const site of sites) {
    const reason = unleashedClosedReason(site, u);
    const cur = state.get(site.locationId);
    if (reason && !cur?.closed) out.push({ site, action: "close", reason });
    else if (!reason && cur?.closed && cur.source === "unleashed") out.push({ site, action: "reopen", reason: "active again in Unleashed" });
  }
  return out;
}

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Last order date per site from Unleashed sales orders, matched on customer code + delivery name
 * (sites are named after their Unleashed delivery address; grouped companies prefix "<member> - ").
 */
export function lastOrdersFromUnleashed(sites: PortalSite[], orders: Iterable<USalesOrder>): Map<string, Date> {
  const byKey = new Map<string, string[]>();
  for (const s of sites) {
    if (!s.customerCode) continue;
    const names = new Set([norm(s.name), norm(s.name.replace(/^.+? - /, ""))]);
    for (const n of names) {
      if (!n) continue;
      const k = `${s.customerCode}|${n}`;
      byKey.set(k, [...(byKey.get(k) ?? []), s.locationId]);
    }
  }
  const last = new Map<string, Date>();
  for (const o of orders) {
    if (/deleted|cancel/i.test(o.OrderStatus ?? "")) continue;
    const code = o.Customer?.CustomerCode;
    const when = parseUnleashedDate(o.OrderDate);
    if (!code || !when) continue;
    for (const loc of byKey.get(`${code}|${norm(o.DeliveryName)}`) ?? []) {
      const prev = last.get(loc);
      if (!prev || when > prev) last.set(loc, when);
    }
  }
  return last;
}

export const DORMANT_MONTHS = 6;

export function isDormant(lastOrderAt: Date | null, now: Date, months = DORMANT_MONTHS): boolean {
  if (!lastOrderAt) return true;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - months);
  return lastOrderAt < cutoff;
}
