import type { UAddress } from "../unleashed/types.ts";

/** Shopify CompanyAddressInput (the fields we fill). */
export interface ShopifyAddress {
  address1: string;
  address2?: string;
  city: string;
  zoneCode?: string;
  zip?: string;
  countryCode: string;
  recipient?: string;
}

const COUNTRIES: Record<string, string> = {
  australia: "AU", au: "AU", aus: "AU",
  "new zealand": "NZ", nz: "NZ",
};

const AU_STATES: Record<string, string> = {
  nsw: "NSW", "new south wales": "NSW",
  vic: "VIC", victoria: "VIC",
  qld: "QLD", queensland: "QLD",
  sa: "SA", "south australia": "SA",
  wa: "WA", "western australia": "WA",
  tas: "TAS", tasmania: "TAS",
  nt: "NT", "northern territory": "NT",
  act: "ACT", "australian capital territory": "ACT",
};

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Australian state/territory from a postcode (Australia Post ranges). */
export function stateFromPostcode(zip: string): string | undefined {
  if (!/^\d{4}$/.test(zip)) return undefined;
  const n = Number(zip);
  const inR = (a: number, b: number) => n >= a && n <= b;
  if (inR(200, 299) || inR(2600, 2618) || inR(2900, 2920)) return "ACT";
  if (inR(1000, 2599) || inR(2619, 2899) || inR(2921, 2999)) return "NSW";
  if (inR(3000, 3999) || inR(8000, 8999)) return "VIC";
  if (inR(4000, 4999) || inR(9000, 9999)) return "QLD";
  if (inR(5000, 5999)) return "SA";
  if (inR(6000, 6999)) return "WA";
  if (inR(7000, 7999)) return "TAS";
  if (inR(800, 999)) return "NT";
  return undefined;
}

export interface AddressResult {
  address?: ShopifyAddress;
  problems: string[];
}

/**
 * Unleashed address → Shopify company address. Country defaults to Australia when blank.
 * Unleashed uses Suburb and City inconsistently, so we use City, falling back to Suburb.
 */
export function toShopifyAddress(a: UAddress, recipient?: string): AddressResult {
  const problems: string[] = [];
  const address1 = clean(a.StreetAddress);
  const address2 = clean(a.StreetAddress2);
  const city = clean(a.City) || clean(a.Suburb);
  const countryRaw = clean(a.Country).toLowerCase();
  const countryCode = countryRaw ? COUNTRIES[countryRaw] ?? (countryRaw.length === 2 ? countryRaw.toUpperCase() : "") : "AU";
  const regionRaw = clean(a.Region).toLowerCase().replace(/\./g, "").trim();
  let zip = clean(a.PostalCode).replace(/\s/g, "");
  // Postcode sometimes typed into the state or city field ("NSW 2000"); pick it up from there.
  if (!/^\d{4}$/.test(zip)) {
    const m = /\b(\d{4})\b/.exec(`${a.Region ?? ""} ${a.City ?? ""} ${a.Suburb ?? ""}`);
    if (m && countryRaw !== "new zealand" && countryRaw !== "nz") zip = m[1];
  }

  if (!address1) problems.push("no street address");
  if (!city) problems.push("no suburb/city");
  if (!countryCode) problems.push(`unknown country "${a.Country}"`);
  let zoneCode: string | undefined;
  if (countryCode === "AU") {
    const regionWord = regionRaw.replace(/\b\d{4}\b/, "").trim();
    // Trust the postcode over the State field: it's typed more reliably.
    zoneCode = stateFromPostcode(zip) ?? AU_STATES[regionWord];
    if (!/^\d{4}$/.test(zip)) problems.push(zip ? `postcode "${clean(a.PostalCode)}" isn't 4 digits` : "no postcode");
    if (!zoneCode) problems.push(regionWord ? `unknown state "${a.Region}"` : "no state");
  }
  if (problems.length) return { problems };
  return {
    address: {
      address1,
      ...(address2 ? { address2 } : {}),
      city,
      ...(zoneCode ? { zoneCode } : {}),
      ...(zip ? { zip } : {}),
      countryCode,
      ...(recipient ? { recipient } : {}),
    },
    problems,
  };
}

/**
 * A stable key so re-running the import recognises sites it already created. The Unleashed
 * address Guid is unique on its own; without one we fall back to code + name (kept to 64 chars).
 */
export function siteExternalId(customerCode: string, a: UAddress): string {
  if (a.Guid) return a.Guid;
  const name = clean(a.AddressName) || `${clean(a.StreetAddress)} ${clean(a.PostalCode)}`;
  return `${customerCode}|${name.toLowerCase()}`.slice(0, 64);
}

export function siteName(a: UAddress): string {
  return clean(a.AddressName) || [clean(a.StreetAddress), clean(a.City) || clean(a.Suburb)].filter(Boolean).join(", ") || "Main site";
}
