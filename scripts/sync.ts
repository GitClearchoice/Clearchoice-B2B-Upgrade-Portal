// Nightly:  npm run sync            (full sync; Render cron at ~2:00am Sydney)
// Daytime:  npm run sync:changes    (only records modified since the last run)
// With DATABASE_URL set, syncs into Postgres (what the app reads); otherwise into the JSON snapshot.
import { FileStore, type PriceStore } from "../src/sync/store.ts";
import { changesSync, fullSync } from "../src/sync/sync.ts";
import { loadConfig } from "./config.ts";

const { client, discountFormat, snapshotPath } = loadConfig();
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

let store: PriceStore;
let close = async () => {};
let recordError = async (_msg: string | null) => {};
if (process.env.DATABASE_URL && !process.argv.includes("--file")) {
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaStore } = await import("../src/sync/prismaStore.ts");
  const db = new PrismaClient();
  const ps = new PrismaStore(db);
  store = ps;
  close = () => db.$disconnect();
  recordError = (msg) => ps.setState({ lastError: msg });
  log("Store: Postgres (DATABASE_URL)");
} else {
  store = await FileStore.open(snapshotPath);
  log(`Store: ${snapshotPath}`);
}

const run = process.argv.includes("--changes") ? changesSync : fullSync;
try {
  const result = await run(client, store, { discountFormat, log });
  await recordError(null);
  log(`Done (${result.mode}): ${result.products} products, ${result.customers} customers, ${result.rules} customer price lines, ${result.quantityPrices} quantity prices.`);
  for (const w of result.warnings) log(`WARNING ${w}`);
} catch (e) {
  log(`Sync failed: ${(e as Error).message}`);
  await recordError((e as Error).message).catch(() => {});
  process.exitCode = 1;
} finally {
  await close();
}
