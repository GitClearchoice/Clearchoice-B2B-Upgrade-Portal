import prisma from "./db.server";
import { PrismaStore } from "../src/sync/prismaStore.ts";

// Synced Unleashed pricing data in Postgres (filled by the `npm run sync` cron job).
export const priceStore = new PrismaStore(prisma);
export { priceLines } from "../src/index.ts";
