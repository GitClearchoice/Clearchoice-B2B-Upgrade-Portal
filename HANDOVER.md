# Clearchoice B2B Portal — Handover (updated 25 Nov 2026, phase 1 code written)

Upload this file to the new Claude project, then start a chat with:
"Read clearchoice-b2b-handover.md and continue from 'Next steps'."

## Decisions made
- Store: clearchoiceproducts.com, Shopify **Grow** plan. Dev store: **clearchoice-upgrade.myshopify.com**.
- Unleashed is the inventory system. Orders already sync Shopify → Unleashed via the **Unleashed Software public app**. The "Trade+ Portal" is Unleashed's own separate B2B portal.
- ~200 trade customers. Most use Unleashed **Sell Price Tiers**; ~10% have their own Customer Pricing.
- Trade customers pay **on account, net terms, invoiced later**.
- Chosen approach: **Option A**: a custom Shopify app on Grow that places trade orders as **B2B draft orders** with Unleashed prices (no Shopify Functions, no Plus-only features).
- Budgets: a **monthly total per delivery site**, goods only (ex GST, ex freight).
  - Set by **one head-office admin per customer** for all of that customer's sites.
  - Orders that would go over budget are **sent for approval** to that admin.
  - A page shows site budgets (editable), an **annual budget summary** and a **per-site order history report**.
- Claude writes the code.
- GitHub repo: https://github.com/GitClearchoice/Clearchoice-B2B-Upgrade-Portal

## Setup needed in the new Claude account
1. Settings → Capabilities: allow `clearchoice-upgrade.myshopify.com` and `api.unleashedsoftware.com`.
2. Settings → Connectors: connect GitHub with an account that has Write access to the repo above.
3. In the new chat, provide:
   - the Dev Dashboard app's Client ID and Client Secret (dev store only);
   - a **newly regenerated** Unleashed sandbox API ID and key (the old key was pasted in the previous chat).

## Open questions
- Do store prices include GST?
- Does the Unleashed Shopify app import draft-originated B2B orders with the right site and prices? Test this first.
- Do Unleashed Quantity Prices need supporting in phase 1?
- Hosting account (Fly.io or Render) and email sender domain.
- Approximate SKU count.

## Next steps
Phase 1 code is written and unit-tested (35 tests, see README.md): Unleashed client, nightly full sync + daytime changes sync, pricing engine, cart pricing.
Still to do for phase 1:
1. Push this code to the repo.
2. Regenerate the Unleashed sandbox key, put it in `.env`, run `npm run sandbox:check`, and do the four checks in README.md ("Sandbox checks").
3. Fix anything those checks show (most likely `UNLEASHED_DISCOUNT_RATE_FORMAT`).
Then phase 2: scaffold the Shopify app (Shopify CLI, React Router), move storage to Postgres (prisma/schema.prisma), import companies/sites and link them to Unleashed customer codes.

---

# Technical spec (v0.1)

## Pricing (R1)
Pricing order, mirroring Unleashed:
1. Customer Pricing (product or product group, with min qty and valid-from/to)
2. Quantity Prices
3. The customer's Sell Price Tier, minus the customer's Discount %
4. Default Sell Price

## Shopify data model
- **Company** = Unleashed customer (`company.externalId` = Unleashed Customer Code).
- **Company location** = delivery site (its own address, net terms).
- **Head-office admin** = company contact flagged `b2b.budget_admin`.
- **Budgets** = metaobject `site_budget` {location, year, month, amount_ex_gst}, plus a default monthly amount per location.
- Variant SKU = Unleashed Product Code.

## Components
1. **Shopify app** (Shopify CLI, React Router, TypeScript), custom distribution, hosted with Postgres.
2. **Unleashed client + sync.** HMAC-signed requests. Nightly plus on-demand sync of:
   - Products (tier prices, default sell price)
   - SellPriceTiers
   - Customers (tier, discount %)
   - ProductPrices?customerCode= for customers with special pricing
3. **Theme app extension:**
   - shows customer prices on product, collection and cart pages;
   - replaces Checkout with "Place order" for trade customers, with PO number and site.
4. **App proxy endpoints** (signed): prices, place-order, budget status.
5. **Order flow:**
   1. Work out prices on the server.
   2. `draftOrderCreate` (company/location, variantId + priceOverride, PO number, net terms).
   3. Budget check: the site's month-to-date spend (Sydney calendar month) + this order's goods ex GST, compared with that month's budget.
      - **Within budget:** complete the draft with payment pending → an order is created → the Unleashed app syncs it.
      - **Over budget:** tag the draft `awaiting-approval`, lock prices, email the head-office admin. Approve → complete. Reject → cancel and notify the buyer.
6. **Customer account page "Site budgets"** (head-office admin only):
   - monthly budget per site per month;
   - annual summary;
   - per-site order history with CSV export;
   - approvals queue.
7. **App admin page** for Clearchoice staff:
   - link companies to Unleashed codes;
   - flag head-office admins;
   - sync status;
   - overrides.
8. **Transactional email** (Postmark or Resend).

## Safeguards
- Locations set to "Submit all orders as drafts for review", as a safety net if a buyer reaches native checkout.
- One-time shipping addresses turned off.
- Prices always recalculated on the server.

## Phases
1. Unleashed client + pricing engine
2. Company/site import and linking
3. Price display + "Place order" (within budget)
4. Budgets, approvals, emails
5. Site budgets page and reports
6. Staging tests (incl. the Unleashed sync check) → production
