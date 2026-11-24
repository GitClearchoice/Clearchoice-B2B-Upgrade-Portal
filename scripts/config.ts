import { UnleashedClient } from "../src/unleashed/client.ts";
import type { DiscountRateFormat } from "../src/sync/mappers.ts";

export function loadConfig() {
  const apiId = process.env.UNLEASHED_API_ID;
  const apiKey = process.env.UNLEASHED_API_KEY;
  if (!apiId || !apiKey) {
    console.error("Set UNLEASHED_API_ID and UNLEASHED_API_KEY in .env (copy .env.example).");
    process.exit(1);
  }
  const format = (process.env.UNLEASHED_DISCOUNT_RATE_FORMAT ?? "fraction") as DiscountRateFormat;
  if (format !== "fraction" && format !== "percent") {
    console.error('UNLEASHED_DISCOUNT_RATE_FORMAT must be "fraction" or "percent".');
    process.exit(1);
  }
  const client = new UnleashedClient({
    apiId,
    apiKey,
    baseUrl: process.env.UNLEASHED_BASE_URL,
    clientType: process.env.UNLEASHED_CLIENT_TYPE,
  });
  return { client, discountFormat: format, snapshotPath: process.env.SNAPSHOT_PATH ?? "data/unleashed-snapshot.json" };
}
