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
2. **Quantity Prices** (product record > Sale > Quantity Prices; apply to every customer): synced from `/ProductPrices` lines that have a product but no customer. Highest qualifying minimum quantity wins; dates respected; % off is from the Default Sell Price unless Unleashed returns its own price.
3. **Sell Price Tier** less the customer's `DiscountRate`.
4. **Default Sell Price**: used when the customer has no tier or the tier is blank on that product. The customer discount also applies here (switch: `applyDiscountToDefault`).

Customer Pricing is **not** reduced again by the customer discount.

## Phase 2: trade customers → Shopify companies (dev store)

Trade customer = ordered in the last 12 months (Unleashed sales orders), reviewed by you.

| Unleashed | Shopify |
|---|---|
| Customer (code, name) | Company (`externalId` = customer code) |
| Each address on the customer's **Delivery** tab | Company location (`externalId` = Unleashed address Guid; delivery instruction → location note) |
| Primary contact (name + email) | Company contact, main contact, **Location admin** on every site, and company metafield `b2b.budget_admin_contact` |
| Payment term ("30 Days") | Location payment terms (Net 30; unreadable terms use `DEFAULT_NET_DAYS`) |

Every location is set to **submit orders as drafts** and **no one-time shipping addresses** (the handover's safeguards).
No customer gets emailed: creating contacts doesn't send account invites.

```bash
npm run trade:candidates                          # writes data/trade-customers.csv to review in Excel
npm run import:companies -- --only "CODE"         # dry run for one customer (no changes)
npm run import:companies -- --only "CODE" --apply # create that one; check it in Shopify admin
npm run import:companies                          # dry run for everyone marked Include = Y
npm run import:companies -- --apply               # create them all (safe to re-run)
```

**Groups:** list customers run by the same person in `config/company-groups.csv` (columns `Group Name`, `Customer Code`). They become one Shopify company; each site keeps its own Unleashed customer code (location metafield `unleashed.customer_code`) so orders still go to the right customer. Delete any member already imported as its own company before running the group. `--only "Group Name"` imports one group.

Reports: `data/import-dry-run.csv` / `data/import-report.csv`. The import never deletes or overwrites; re-running adds only what's missing (new sites, a missing admin).

Shopify setup: in the Dev Dashboard app, add the scopes `write_companies`, `write_customers`, `read_payment_terms`, release a new version and reinstall it on the dev store. Put `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` in `.env`.

## Phase 3, step 1: test order straight to Unleashed

```bash
npm run order:test            # dry run: prints the order it would send
npm run order:test -- --send  # sends ONE test order to the Unleashed sandbox
# options: --customer CODE --site "part of site name/address" --sku CODE --qty N --po TEXT
```

Checks the warehouse and tax code exist first, prices from the last sync, and saves the order's Guid to `data/test-orders.json` before sending (so a retry can't duplicate it). Settings: `UNLEASHED_ORDER_STATUS`, `UNLEASHED_WAREHOUSE`, `UNLEASHED_TAX_CODE`, `UNLEASHED_TAX_RATE`.

## Running it

Needs Node 22.18 or later. No runtime dependencies.

```bash
cp .env.example .env          # add the NEW sandbox API ID and key
npm test                      # 35 tests, no network needed
npm run sandbox:check         # checks auth, shows field formats, does a full sync
npm run sandbox:check -- CUSTCODE SKU 5   # prices one line; compare with an Unleashed sales order
npm run price -- CUSTCODE SKU 1 48 50   # quick: prices from the last sync, no Unleashed calls
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
- Quantity Prices: assumed to be the `/ProductPrices` lines with no customer (10 in the sandbox). Confirm with `npm run price` on a product that has one (e.g. 1-CT-0014), either side of its minimum quantity.
- Does the Unleashed Shopify app import draft-originated B2B orders with the right site and prices? (Phase 6 test, worth doing early.)
- Hosting (Fly.io or Render), email sender domain, approximate SKU count.
