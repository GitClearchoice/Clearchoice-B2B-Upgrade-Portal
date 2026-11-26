// Step 2: create the reviewed trade customers in Shopify as companies, sites and head-office admins.
//   npm run import:companies                       dry run for everyone with Include = Y (no changes)
//   npm run import:companies -- --only CODE        dry run for one customer
//   npm run import:companies -- --only CODE --apply    really create one customer (do this first)
//   npm run import:companies -- --apply            really create everyone with Include = Y
// Safe to re-run: it only adds what's missing and never deletes. Report: data/import-report.csv
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseCsvObjects, toCsv } from "../src/b2b/csv.ts";
import {
  applyCompany, loadPaymentTermsTemplates, planCompany, reasonCounts, REPORT_HEADER, reportRow, SKIPPED_HEADER, skippedRows,
  type CompanyPlan, type ImportResult,
} from "../src/b2b/import.ts";
import { ShopifyAdmin } from "../src/shopify/client.ts";
import { PostcodeLookup } from "../src/b2b/address.ts";
import { loadConfig } from "./config.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;
if (onlyIdx >= 0 && !only) { console.log("--only needs a customer code (use quotes if it has spaces)"); process.exit(1); }

const shop = process.env.SHOPIFY_SHOP;
if (!shop) { console.log("Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET in .env"); process.exit(1); }
const admin = new ShopifyAdmin({
  shop,
  clientId: process.env.SHOPIFY_CLIENT_ID,
  clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN || undefined,
  apiVersion: process.env.SHOPIFY_API_VERSION || undefined,
});
const defaultNetDays = Number(process.env.DEFAULT_NET_DAYS ?? 30);

// Who to import
const csvPath = process.env.TRADE_CSV_PATH ?? "data/trade-customers.csv";
let codes: string[] = [];
try {
  const rows = parseCsvObjects(await readFile(csvPath, "utf8"));
  codes = rows.filter((r) => /^y(es)?$/i.test(r["Include"] ?? "")).map((r) => r["Customer Code"]).filter(Boolean);
} catch {
  console.log(`Can't read ${csvPath}. Run: npm run trade:candidates`);
  process.exit(1);
}
if (only) {
  if (!codes.includes(only)) console.log(`Note: ${only} isn't marked Include = Y in ${csvPath}; importing it anyway because you asked for it.`);
  codes = [only];
}
if (!codes.length) { console.log("No customers marked Include = Y."); process.exit(0); }

console.log(`${apply ? "APPLYING to" : "Dry run against"} ${admin.shopDomain} for ${codes.length} customer(s).${apply ? "" : " Nothing will be changed."}`);

const { client } = loadConfig();
console.log("Reading customers and delivery addresses from Unleashed…");
const [customers, delivery] = await Promise.all([
  client.customers({ includeObsolete: true }),
  client.customerDeliveryAddresses(),
]);
const byCode = new Map(customers.map((c) => [c.CustomerCode, c]));
const sitesByCode = new Map(delivery.map((d) => [d.CustomerCode, d.Addresses ?? []]));

// Learn suburb → postcode from every complete address in Unleashed (all customers), to fill in missing postcodes.
const lookup = new PostcodeLookup()
  .learn(customers.flatMap((c) => c.Addresses ?? []))
  .learn(delivery.flatMap((d) => d.Addresses ?? []));
console.log(`Learned postcodes for ${lookup.size} suburbs from existing Unleashed addresses.`);

const mapPath = "data/company-map.json";
let companyMap: Record<string, string> = {};
try { companyMap = JSON.parse(await readFile(mapPath, "utf8")); } catch {}

const templates = await loadPaymentTermsTemplates(admin);
const ctx = { admin, dryRun: !apply, templates, companyMap };

const results: ImportResult[] = [];
const plans: CompanyPlan[] = [];
for (const [i, code] of codes.entries()) {
  const customer = byCode.get(code);
  if (!customer) {
    results.push({ code, name: "", status: "error", companyId: "", sitesCreated: 0, sitesExisting: 0, sitesSkipped: [], contact: "", paymentTerms: "", notes: ["not found in Unleashed"] });
    continue;
  }
  const plan = planCompany(customer, sitesByCode.get(code), defaultNetDays, lookup);
  plans.push(plan);
  const r = await applyCompany(ctx, plan);
  results.push(r);
  const verb = apply ? r.status : r.status === "created" ? "would create" : r.status === "updated" ? "would update" : r.status;
  const otherNotes = r.notes.filter((n) => !n.startsWith("Site ")); // per-site detail goes to the skipped-sites file
  console.log(`[${i + 1}/${codes.length}] ${code}: ${verb}, sites +${r.sitesCreated} (${r.sitesExisting} already there${r.sitesSkipped.length ? `, ${r.sitesSkipped.length} skipped` : ""}), admin ${r.contact || "-"}${otherNotes.length ? `\n      ${otherNotes.join("\n      ")}` : ""}`);
  if (apply) await writeFile(mapPath, JSON.stringify(companyMap, null, 2));
}

await mkdir("data", { recursive: true });
const reportPath = apply ? "data/import-report.csv" : "data/import-dry-run.csv";
await writeFile(reportPath, toCsv([REPORT_HEADER, ...results.map(reportRow)]));
const skipped = plans.flatMap(skippedRows);
if (skipped.length) {
  await writeFile("data/skipped-sites.csv", toCsv([SKIPPED_HEADER, ...skipped]));
  console.log(`\n${skipped.length} site(s) skipped because of their address. Most common reasons:`);
  for (const [reason, n] of reasonCounts(plans).slice(0, 6)) console.log(`  ${String(n).padStart(4)}  ${reason}`);
  console.log("Details (fix these on the customer's Delivery tab in Unleashed, then re-run): data/skipped-sites.csv");
}
const count = (s: string) => results.filter((r) => r.status === s).length;
console.log(`\n${apply ? "Done" : "Dry run done"}: ${count("created")} created, ${count("updated")} updated, ${count("unchanged")} unchanged, ${count("skipped")} skipped, ${count("error")} errors.`);
console.log(`Report: ${reportPath}`);
if (!apply) console.log("Nothing was changed. Add --apply to make these changes.");
