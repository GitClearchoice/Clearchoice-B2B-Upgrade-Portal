// Nightly:  npm run sync            (full sync; schedule with cron, e.g. 2:00am Sydney)
// Daytime:  npm run sync:changes    (only records modified since the last run)
import { FileStore } from "../src/sync/store.ts";
import { changesSync, fullSync } from "../src/sync/sync.ts";
import { loadConfig } from "./config.ts";

const { client, discountFormat, snapshotPath } = loadConfig();
const store = await FileStore.open(snapshotPath);
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

const run = process.argv.includes("--changes") ? changesSync : fullSync;
try {
  const result = await run(client, store, { discountFormat, log });
  log(`Done (${result.mode}): ${result.products} products, ${result.customers} customers, ${result.rules} price lines.`);
  for (const w of result.warnings) log(`WARNING ${w}`);
} catch (e) {
  log(`Sync failed: ${(e as Error).message}`);
  process.exit(1);
}
