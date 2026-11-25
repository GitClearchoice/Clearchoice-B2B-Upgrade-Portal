// Step 1 of the company import: list everyone who ordered in the last 12 months, for review.
//   npm run trade:candidates
// Writes data/trade-customers.csv. Open it in Excel, set Include to Y or N for each row, save as CSV.
import { mkdir, writeFile } from "node:fs/promises";
import { buildCandidates, CANDIDATE_HEADER, candidateRow } from "../src/b2b/candidates.ts";
import { toCsv } from "../src/b2b/csv.ts";
import { loadConfig } from "./config.ts";

const { client } = loadConfig();
const out = process.env.TRADE_CSV_PATH ?? "data/trade-customers.csv";
const candidates = await buildCandidates(client, { months: 12, log: (m) => console.log(m) });

await mkdir("data", { recursive: true });
await writeFile(out, toCsv([CANDIDATE_HEADER, ...candidates.map(candidateRow)]));

const included = candidates.filter((c) => c.include).length;
const web = candidates.filter((c) => c.flags.includes("looks like a web customer")).length;
console.log(`\nWrote ${out}: ${candidates.length} customers ordered in the last 12 months.`);
console.log(`  ${included} marked Include = Y, ${web} look like web customers (marked N).`);
console.log("Review it in Excel, change Include where needed, save (keep CSV format), then run:");
console.log("  npm run import:companies -- --only <one customer code>     (dry run for one customer)");
