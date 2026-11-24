# Clearchoice B2B Portal

Custom Shopify app (Grow plan) that places trade orders as B2B draft orders with Unleashed prices.
See `HANDOVER.md` for the decisions, the spec and the phase plan.

## Phase 1: Unleashed client, price sync and pricing engine

| Part | File | What it does |
|---|---|---|
| Unleashed client | `src/unleashed/client.ts` | Signed GET requests (HMAC-SHA256 of the query string, `client-type` header), paging, retries on 429/5xx, Unleashed `/Date()/` parsing |
| Sync | `src/sync/sync.ts` | **Nightly full sync** of tiers, products, customers and all Customer Pricing lines (replaces everything, so lines deleted in Unleashed disappear). **Daytime changes sync** using `modifiedSince`. |
| Mapping | `src/sync/mappers.ts` | Unleashed JSON to clean records; renamed tiers matched by name; 0/blank tier values treated as not set |
| Pricing engine | `src/pricing/engine.ts` | Unleashed order of precedence (below), Sydney dates, 4-decimal maths with rounding to cents only at the end, ex and inc GST |
| Cart pricing | `src/index.ts` → `priceLines()` | Prices a customer's cart from synced data; this is what the app proxy and place-order flow will call |
| Storage | `src/sync/store.ts`, `prisma/schema.prisma` | JSON-file store for the scripts now; Postgres tables ready for the app |

### Pricing order
1. **Customer Pricing**: product line first, then product-group line. Only lines that are valid today (Sydney date, inclusive) and whose minimum quantity is met; the highest qualifying minimum quantity wins. If Unleashed returns its own calculated `CustomerPrice`, that's used; otherwise fixed price, or % off the customer's tier price (or Default Sell Price).
2. **Quantity Prices**: supported by the engine, but **not synced yet** (see open questions).
3. **Sell Price Tier** less the customer's `DiscountRate`.
4. **Default Sell Price**: used when the customer has no tier or the tier is blank on that product. The customer discount also applies here (switch: `applyDiscountToDefault`).

Customer Pricing is **not** reduced again by the customer discount.

## Running it

Needs Node 22.18 or later. No runtime dependencies.

```bash
cp .env.example .env          # add the NEW sandbox API ID and key
npm test                      # 35 tests, no network needed
npm run sandbox:check         # checks auth, shows field formats, does a full sync
npm run sandbox:check -- CUSTCODE SKU 5   # prices one line; compare with an Unleashed sales order
npm run sync                  # nightly full sync (cron at ~2am Sydney)
npm run sync:changes          # optional daytime top-up
```

`npm install` then `npm run typecheck` for a full TypeScript check.

## Sandbox checks to do before phase 2
1. **Discount format**: `sandbox:check` prints a customer's `DiscountRate`. 10% shown as `0.1` → keep `fraction`; shown as `10` → set `UNLEASHED_DISCOUNT_RATE_FORMAT=percent`.
2. **Price match**: for 5–10 real cases (a tier customer, one with a discount, one with product pricing, one with group pricing, one with a min-qty break), compare `sandbox:check -- CUST SKU QTY` with the price Unleashed puts on a new sales order. They should match to the cent.
3. **Discount-% lines**: confirm `CustomerPrice` comes back filled in for "Discount %" lines (the check prints a sample). If it's empty, check whether the line discounts from the Default Sell Price or the tier (Unleashed's "Discount From Type", which the API doesn't return).
4. **Speed**: note how long the full sync takes with the real product count.

## Open questions (carried from the handover)
- Do store prices include GST? The engine returns both ex and inc GST, so either way works.
- Quantity Prices: the public API docs show no endpoint for product-level quantity breaks (only Customer Pricing with a minimum quantity). If Clearchoice uses them, they need a source (CSV export or another endpoint) before phase 3.
- Does the Unleashed Shopify app import draft-originated B2B orders with the right site and prices? (Phase 6 test, worth doing early.)
- Hosting (Fly.io or Render), email sender domain, approximate SKU count.
