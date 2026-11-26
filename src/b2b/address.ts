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
  /** The address was rebuilt from details typed into the wrong fields. Worth a glance in Shopify. */
  rebuilt?: boolean;
  /** Leftover text from the address fields (contacts, phone numbers, dock notes), for the site's note. */
  extraNote?: string;
  /** Looks like a note saved as an address ("Picked up by Peter", a date, a name), not a delivery site. */
  notASite?: boolean;
}

/**
 * Unleashed address → Shopify company address. Country defaults to Australia when blank.
 * Unleashed uses Suburb and City inconsistently, so we use City, falling back to Suburb.
 */
export function toShopifyAddress(a: UAddress, recipient?: string, siteName?: string): AddressResult {
  const strict = strictAddress(a, recipient);
  if (strict.address) return strict;
  const rebuilt = rebuildAddress(a, recipient, siteName);
  if (rebuilt.address) return rebuilt;
  if (looksLikeNote(a, siteName)) return { problems: ["not a delivery address (looks like a note)"], notASite: true };
  return strict;
}

function strictAddress(a: UAddress, recipient?: string): AddressResult {
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
    // An explicit state wins (some postcodes, like 2620, span NSW and ACT); else work it out from the postcode.
    zoneCode = AU_STATES[regionWord] ?? stateFromPostcode(zip);
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

// ---------------------------------------------------------------------------------------------
// Rebuilding addresses typed into the wrong fields
// e.g. Suburb "Blacktown", City "NSW 2148", Country "Level 4 Centre Management"
//      Street 2 "WEST RYDE, 2114"; Street "Lots 53, 7-13 Hunter Street, SYDNEY, NSW, 2000"
// ---------------------------------------------------------------------------------------------

const STATE_WORDS = "N\\.?S\\.?W\\.?|NEW SOUTH WALES|VIC|VICTORIA|QLD|QUEENSLAND|S\\.?A\\.?|SOUTH AUSTRALIA|W\\.?A\\.?|WESTERN AUSTRALIA|TAS|TASMANIA|N\\.?T\\.?|NORTHERN TERRITORY|A\\.?C\\.?T\\.?";
const STREET_SUFFIX = "st|street|rd|road|hwy|highway|dr|drive|ave|avenue|av|pde|parade|cres|crescent|cr|pl|place|cl|close|ct|court|tce|terrace|way|lane|ln|blvd|boulevard|cct|circuit|parkway|pkwy|esp|esplanade|gr|grove|sq|square";

const tidy = (s: string | null | undefined) =>
  (s ?? "").replace(/\*+/g, " ").replace(/\s+/g, " ").replace(/^[\s,.\-:]+|[\s,]+$/g, "").trim();

/** Phone numbers: 8+ digits, or typical AU formats. These must never be read as postcodes. */
export function isPhoneLike(s: string): boolean {
  const digits = s.replace(/\D/g, "");
  return digits.length >= 8 || /\b0[2-478]\s?\d{4}\s?\d{4}\b/.test(s) || /\(0\d\)\s*\d{4}/.test(s);
}

const NOTEISH = /picked up|pick up|\battn?\b|attention|contact|\bcall\b|site contact|requested|for saturday|work for|loading dock|\bdock\b|before \d|\d\s?(am|pm)\b|@|deliver|leave at|walk in|^for\b|^c\/o\b|cleaner\b|manager\b|reference/i;
const isNoteish = (s: string) => isPhoneLike(s) || NOTEISH.test(s);

function isStreetLike(s: string): boolean {
  if (!s || isNoteish(s)) return false;
  if (new RegExp(`^((${STATE_WORDS})[\\s,]*)?\\d{4}$`, "i").test(s)) return false;
  const l = findLocality(s);
  if (l && !l.before) return false;
  if (/\d/.test(s) && /[a-z]{2}/i.test(s)) return true;
  return new RegExp(`\\b(cnr|crn|corner)\\b|\\b(${STREET_SUFFIX})\\.?$`, "i").test(s);
}

function isPlaceLike(s: string): boolean {
  return !!s && /^[a-z][a-z .'\-]*$/i.test(s) && !isNoteish(s) && !isStreetLike(s) && !new RegExp(`^(${STATE_WORDS})$`, "i").test(s) && s.length <= 40;
}

interface Locality { suburb: string; state?: string; postcode: string; before: string }

/** Finds "SUBURB [STATE] 1234" at the end of a field; `before` is any street text ahead of it. */
function findLocality(text: string): Locality | null {
  if (!text || isPhoneLike(text)) return null;
  const withComma = new RegExp(`^(?<before>.*?)(?:^|,)\\s*(?<sub>[a-z][a-z .'\\-]*?)?[\\s,]*(?:(?<st>${STATE_WORDS})[\\s,]*)?(?<pc>\\d{4})$`, "i");
  const noComma = new RegExp(`^(?<before>\\d.*?\\b(?:${STREET_SUFFIX})\\.?)\\s+(?<sub>[a-z][a-z .'\\-]*?)\\s*(?:(?<st>${STATE_WORDS})\\s*)?(?<pc>\\d{4})$`, "i");
  for (const re of [noComma, withComma]) {
    const m = re.exec(text);
    if (!m?.groups) continue;
    let suburb = tidy(m.groups.sub);
    let st = m.groups.st;
    // "Penrith NSW" can be read as suburb "Penrith NSW" when the state has no separator: split it off.
    const tail = new RegExp(`\\s(${STATE_WORDS})$`, "i").exec(suburb);
    if (!st && tail) { st = tail[1]; suburb = suburb.slice(0, tail.index).trim(); }
    if (new RegExp(`^(${STATE_WORDS})$`, "i").test(suburb)) { st = st ?? suburb; suburb = ""; }
    return { suburb, state: st, postcode: m.groups.pc, before: tidy(m.groups.before) };
  }
  return null;
}

function stateCode(word: string | undefined): string | undefined {
  if (!word) return undefined;
  return AU_STATES[word.toLowerCase().replace(/\./g, "").trim()];
}

export function rebuildAddress(a: UAddress, recipient?: string, siteName?: string): AddressResult {
  const fields = [a.StreetAddress, a.StreetAddress2, a.Suburb, a.City, a.Region, a.PostalCode, a.Country].map(tidy);
  const name = tidy(siteName ?? a.AddressName);

  // 1. Locality: scan the fields, then the site name.
  let loc: Locality | null = null;
  let locIdx = -1;
  for (let i = 0; i < fields.length && !loc; i++) {
    loc = findLocality(fields[i]);
    if (loc) locIdx = i;
  }
  if (!loc) { loc = findLocality(name); if (loc) locIdx = -2; }
  if (!loc) return { problems: ["couldn't find a suburb and postcode in any field"] };

  const state = stateCode(loc.state) ?? stateFromPostcode(loc.postcode);
  if (!state) return { problems: [`postcode ${loc.postcode} isn't an Australian postcode`] };

  const used = new Set<number>();
  if (locIdx >= 0) used.add(locIdx);

  // 2. Suburb: from the locality, else the nearest place-like field before it.
  let suburb = loc.suburb;
  if (!suburb && locIdx >= 0) {
    for (let i = locIdx - 1; i >= 0; i--) {
      if (isPlaceLike(fields[i])) { suburb = fields[i]; used.add(i); break; }
    }
  }
  if (!suburb) return { problems: ["found a postcode but no suburb"] };

  // 3. Street: text before the locality, else the first street-like field (digits first), else the site name.
  let street = isStreetLike(loc.before) ? loc.before : "";
  if (!street) {
    const order = fields.map((f, i) => i).filter((i) => !used.has(i));
    const withDigits = order.find((i) => /\d/.test(fields[i]) && isStreetLike(fields[i]) && !/^\d{4}$/.test(fields[i]));
    const other = order.find((i) => isStreetLike(fields[i]) && !/^\d{4}$/.test(fields[i]));
    const pick = withDigits ?? other;
    if (pick !== undefined) { street = fields[pick]; used.add(pick); }
  }
  if (!street) {
    const fromName = new RegExp(`\\d[\\w/\\- &]*?\\b(${STREET_SUFFIX})\\b\\.?`, "i").exec(name)?.[0] ?? (isStreetLike(name) && /\d/.test(name) ? name.split(",")[0] : "");
    street = tidy(fromName);
  }
  if (!street) return { problems: ["found a suburb and postcode but no street address"] };

  // 4. Everything else useful goes in the site note (contacts, phone numbers, dock notes).
  const stateOnly = new RegExp(`^(${STATE_WORDS})$`, "i");
  const leftovers = [...new Set(fields.filter((f, i) =>
    f && !used.has(i) && f !== street && !/^(australia|au)$/i.test(f) && f.toLowerCase() !== suburb.toLowerCase() &&
    !/^\d{4}$/.test(f) && !stateOnly.test(f) && !findLocality(f)))];
  return {
    address: {
      address1: street.replace(/,$/, ""),
      city: suburb.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w/g, (c) => c.toLowerCase()),
      zoneCode: state,
      zip: loc.postcode,
      countryCode: "AU",
      ...(recipient ? { recipient } : {}),
    },
    problems: [],
    rebuilt: true,
    ...(leftovers.length ? { extraNote: leftovers.join(" | ") } : {}),
  };
}

/** "Picked up by Peter", "Marco", "24/04/26", "Transport T3 to T1"… with no address anywhere. */
function looksLikeNote(a: UAddress, siteName?: string): boolean {
  const all = [siteName ?? a.AddressName, a.StreetAddress, a.StreetAddress2, a.Suburb, a.City].map(tidy).filter(Boolean).join(" ");
  return /picked up|pick up|repairs|work for|for saturday|\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b|^(peter|marco|gavin|suba)\b/i.test(all);
}
