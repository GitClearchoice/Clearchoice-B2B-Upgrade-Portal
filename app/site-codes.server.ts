// The customer's own code for each site (their system's unique identifier). Stored on SiteStatus.
import prisma from "./db.server";

export async function siteCodes(shop: string, companyId?: string): Promise<Map<string, string>> {
  const rows = await prisma.siteStatus.findMany({
    where: { shop, ...(companyId ? { companyId } : {}), siteCode: { not: null } },
    select: { locationId: true, siteCode: true },
  });
  return new Map(rows.filter((r) => r.siteCode).map((r) => [r.locationId, r.siteCode!]));
}

export async function siteCodeFor(shop: string, locationId: string): Promise<string | null> {
  const r = await prisma.siteStatus.findUnique({ where: { shop_locationId: { shop, locationId } }, select: { siteCode: true } });
  return r?.siteCode ?? null;
}

/** Sets (or clears, with blank) a site's code. */
export async function setSiteCode(shop: string, site: { companyId: string; locationId: string; name: string }, code: string | null) {
  const value = code?.trim().slice(0, 100) || null;
  await prisma.siteStatus.upsert({
    where: { shop_locationId: { shop, locationId: site.locationId } },
    create: { shop, companyId: site.companyId, locationId: site.locationId, siteName: site.name, siteCode: value },
    update: { siteCode: value, siteName: site.name },
  });
}
