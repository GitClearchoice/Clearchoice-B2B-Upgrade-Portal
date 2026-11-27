# Clearchoice B2B Portal — Handover (updated 27 Nov 2026, phase 3 Place order written)

Upload this file to the new Claude project, then start a chat with:
"Read clearchoice-b2b-handover.md and continue from 'Next steps'."

## Decisions made
- Store: clearchoiceproducts.com, Shopify **Grow** plan. Dev store: **clearchoice-upgrade.myshopify.com**.
- Unleashed is the inventory system. **Retail** orders sync Shopify → Unleashed via the **Unleashed Software public app** (Shopify Order Status = Paid, on both live and dev integrations). **Trade orders don't use that app** (see below). The "Trade+ Portal" is Unleashed's own separate B2B portal.
- ~200 trade customers. Most use Unleashed **Sell Price Tiers**; ~10% have their own Customer Pricing.
- Trade customers pay **on account, net terms, invoiced later**.
- Chosen approach: **Option A**: a custom Shopify app on Grow that places trade orders as **B2B draft orders** with Unleashed prices (no Shopify Functions, no Plus-only features).
- **Trade orders go straight to Unleashed via its API (decided 26 Nov).** The app creates the Unleashed sales order itself: customer = company's Unleashed code, delivery name = site name, PO number = Customer Reference. The Shopify draft order stays a draft (the Shopify-side record) and is never completed, so the Unleashed Shopify app never imports it and can't duplicate it.
  - Why: the 26 Nov sandbox test showed the Unleashed Shopify app is person-based. It created a new customer from the buyer (code = Shopify customer ID) instead of using the company's Unleashed customer, used the site contact as delivery name, and dropped the PO number. Only the price was right.
- Budgets: a **monthly total per delivery site**, goods only (ex GST, ex freight).
  - Set by **one head-office admin per customer** for all of that customer's sites.
  - Orders that would go over budget are **sent for approval** to that admin.
  - A page shows site budgets (editable), an **annual budget summary** and a **per-site order history report**.
- Store prices are **ex GST**; Shopify adds GST at checkout. Draft order lines use the engine's ex-GST unit price as `priceOverride`.
- Hosting: **Render** (app + Postgres).
- Email sender: **service@clearchoiceproducts.com** (needs SPF/DKIM DNS records for the chosen email service).
- Claude writes the code.
- GitHub repo: https://github.com/GitClearchoice/Clearchoice-B2B-Upgrade-Portal

## Setup needed in the new Claude account
1. Settings → Capabilities: allow `clearchoice-upgrade.myshopify.com` and `api.unleashedsoftware.com`.
2. Settings → Connectors: connect GitHub with an account that has Write access to the repo above.
3. In the new chat, provide:
   - the Dev Dashboard app's Client ID and Client Secret (dev store only);
   - the Unleashed sandbox API ID and key go in `.env` only (Unleashed keys can't be regenerated; never paste the live key into a chat).

## Open questions
- GST-free products: if any products are GST-free (Unleashed "Taxable Sales" off), confirm how their lines should be coded on sales orders (phase 3 test).
- Quantity Prices: supported; confirm against 1-CT-0014 in the sandbox.
- Email service: Postmark or Resend (sender service@clearchoiceproducts.com).

## Next steps
**Phase 1 — complete (25 Nov).** Unleashed client, nightly/changes sync, pricing engine (incl. Quantity Prices), quick check `npm run price -- CUST SKU QTY...`. Prices match Unleashed sales orders for tier, quantity-price and customer-pricing cases. Sandbox: 9,023 products, 2,832 customers, 4,307 customer price lines, 10 quantity prices. Confirmed formats: Customer.DiscountRate and ProductPrices.DiscountValue are fractions (0.1 = 10%).

**Draft-order → Unleashed test (26 Nov).** Completed B2B draft order (Net terms) imported via the Unleashed Shopify app with Shopify Order Status = Pending. Result: price correct; customer wrong (new customer created from the buyer, Peter Zakinthos, instead of ASSETLINKSERVICESPTYLTD); delivery name wrong (site contact Marco Polo instead of Western Sydney International Airport); PO number missing (should be Customer Reference). **Decision: trade orders go straight to Unleashed via the API** (see Decisions and Order flow). Dev store integration set back to Paid; test order and the extra customer to be deleted from the sandbox.

**Phase 2 — code written (26 Nov), not yet run.** Decisions: trade customers = ordered in the last 12 months, reviewed in a CSV (numeric web-customer codes default to N); sites = Unleashed Delivery tab; head-office admin = Unleashed primary contact. Shopify B2B companies, locations and net terms are available on Grow, and the current Admin API has no Plus restriction on company mutations.
1. Add Dev Dashboard app scopes `write_companies`, `write_customers`, `read_payment_terms`; reinstall on the dev store; put Shopify credentials in `.env`.
2. `npm run trade:candidates` → review `data/trade-customers.csv`.
3. `npm run import:companies -- --only "CODE"` (dry run), then `--apply` for one, check in Shopify admin, then all.

**Phase 2 — complete (26 Nov).** Final run: 0 errors; 63 customers imported as 59 Shopify companies (3 groups) on the dev store, ~1,460 sites. Fixes along the way: spaces not allowed in Shopify external IDs (→ `_`); no "due on receipt" terms for B2B locations (Prepaid/Same Day get none); one email can only be a contact for one company. Decisions: HealthShare NSW + SLHD → HealthShare NSW Group (SLHD has moved under HealthShare); CMMD + Grimesquad + Fit Services Syd → FIT Services Group; Ecomist City West + Ecomist Eastern Suburbs → Ecomist Group. Rule of thumb: customers sharing an admin email are one person running several accounts → group them. 7 customers still have no usable address in Unleashed (Palpa, SKL, Essence Clean, Eastern Suburbs Cleaning Group, ABI Australia, Chief Capital Corp, MKD Clean). Skipped sites are listed in `data/skipped-sites.csv` for cleanup in Unleashed; re-running the import adds any fixed ones.

**Phase 3, step 1 — done (26 Nov).** `npm run order:test` sent a Parked test order for Assetlink (Westpoint Blacktown) straight to the Unleashed sandbox: it landed under the right customer. Corrections: tax code OUTPUT ("GST on Income (10%)"), City left blank. Re-tested 26 Nov: customer, delivery name and address, Customer Reference (PO), prices, GST and warehouse all confirmed correct in Unleashed.

**Phase 3, step 2 — app live on Render (27 Nov).** https://clearchoice-b2b.onrender.com, installed on the dev store, sync cron filled Postgres (home page shows the counts). The repo root is the Shopify app (React Router template) as well as the engine (`src/`): Postgres (sessions, pricing), `PrismaStore`, buyer → site → Unleashed code (`src/b2b/buyer.ts`), `GET /apps/b2b/prices`, staff home page (sync status + price check), `render.yaml` (web + Postgres + nightly cron, Singapore). `shopify.app.toml` uses the existing Dev Dashboard app (client ID 4b83…) and keeps the import scopes plus `write_app_proxy`.

**Phase 3, step 3 — "Place order" code written (27 Nov), not yet tested on the store.**
- `src/orders/placeOrder.ts`: site + SKUs read from Shopify (never the browser) → server prices → TradeOrder row with the Unleashed Guid saved first → draft order (company/location/contact, priceOverride ex GST, PO, note, tag `trade-order`, never completed) → `POST /SalesOrders/{guid}` → tags `sent-to-unleashed` + `unleashed-SO-…`, or `unleashed-failed`. Same `requestKey` twice returns the first order. If the draft fails, nothing is kept and the buyer can retry.
- Retries: every 5 min in the web process (`app/orders.server.ts`), up to 10 attempts; each retry first asks Unleashed whether the Guid already exists, so a lost reply can't create a duplicate. Staff emails on failure come with phase 4 (email service).
- `POST /apps/b2b/orders` (JSON only, so a cross-site form can't place an order). Migration `20261127010000_trade_orders` runs on deploy.
- Theme app extension `extensions/trade-portal`: **Trade price** block (product page: price for the selected variant and quantity, ex and inc GST), **Trade order** block (cart page: lines with trade prices, subtotal/GST/total, PO number, delivery note, Place order; re-prices if the cart changed, clears the cart after), **Trade portal** app embed (hides checkout and express-checkout buttons for trade buyers). Uses the buyer's current site from Shopify's own B2B location selector (`customer.current_location`). Retail customers see nothing.
- No budget check yet: every order is sent (budgets/approvals are phase 4).

**Phase 3, storefront set-up — done (27 Nov).** Live theme copied to the dev store (its `templates/product.json` was skipped on upload because of a Search & Discovery dynamic source, `shopify--discovery--product_search_boost`; recreated with that setting emptied). Trade portal embed on, Trade price block on Default product, Trade order block on Cart. Test buyer contact on Assetlink. Product page trade price confirmed working.
- Lessons: the app proxy only works once the app has been opened in the store admin (that stores the offline session on Render); until then the storefront gets "There was an error in the third-party application".
- Changed after testing: no site name on the product price; the **Trade portal** embed hides the theme's retail prices for trade buyers (setting "Theme price elements to hide", default `.price, product-price, .product__price, .product-price, [data-product-price]`) and puts the trade price (qty 1, ex GST, "From" for mixed variants) on product cards: recently viewed, collections, search, recommendations (cards found by their `/products/` link; prices via `/products/<handle>.js` + `/apps/b2b/prices`).

**Phase 3, Place order — tested (27 Nov).** Test order reached the Unleashed sandbox under Assetlink with the right prices (incl. Sell Price Tier 10 lines that are 10% above the store's normal price). Changes from testing:
- Theme cart prices/totals hidden for trade buyers (embed setting "Theme cart price elements to hide"; this theme uses `.price__current`). The theme's cart footer (order note, subtotal) to be hidden the same way once its class is known.
- Trade order block: works inside the theme's cart `<form>` (no nested form); searchable site picker (Shopify `url_to_set_as_current`); delivery note label "Phone Number / Delivery hours"; Place order button Pantone 192 C (#E40046), bold, larger; re-prices when the theme changes the cart (fetch/XHR watch + re-check after clicks and every 4 s; `/cart.js` only, no API cost).
- Quantity breaks: `/apps/b2b/prices?breaks=1` returns each buyer's real breaks (`src/pricing/breaks.ts`); shown under the theme cart's quantity boxes and the product trade price, 16px, active break in red.
- Dev store: stock comes from the Unleashed Shopify app's stock sync; some products still show 0 (Unleashed integration linking/warehouse), so the theme's backorder message shows. Live store sells when out of stock (inventory policy continue + theme's Back order button), so the app needs no stock logic.
- Pricing changes in Unleashed show after the nightly full sync (or Render → clearchoice-b2b-sync → Trigger Run). A daytime changes-sync cron was offered and declined (27 Nov).

**Phase 4 — budgets, approvals, emails: code written (28 Nov), not yet run on the store.** Email service: **Postmark** (decided 27 Nov).
- Budgets live in the app's Postgres (`SiteBudget`), not a metaobject: per site, "default" (every month) or a `YYYY-MM` amount that overrides it; no row = no limit. Staff set them in the app: **Site budgets** page (search company by any part of name or code → all its sites: every month + this month and the next 3, "set every month for all sites"; **quarterly summary** per site: quarter budget, ordered, waiting for approval, remaining, with previous/next quarter; recent trade orders and their status).
- Budget check at Place order (`src/orders/budget.ts`): Sydney calendar month, goods ex GST; committed = sent + sending + retrying (incl. approved); awaiting-approval and declined orders don't count. Over budget → draft tagged `awaiting-approval`, prices locked in the saved Unleashed payload, nothing sent.
- Approver = company metafield `b2b.budget_admin_contact` (CompanyContact GID) → else company main contact → else `STAFF_EMAIL`. An order placed by the approver themselves isn't held.
- Approval email has a **Review order** button → `https://<app>/approvals/<order id>?t=<signed token>` (HMAC with `SHOPIFY_API_SECRET`, 30 days; no Shopify login). Approve → sent to Unleashed with the locked prices, draft tagged `approved`; Decline (optional note) → `rejected`. A second click does nothing.
- Emails (`src/email/`): buyer — order received / waiting for approval / approved / declined; admin — approval request (reply-to = buyer); staff — Unleashed failure on the first attempt and when retries run out. Email failures never stop an order.
- Cart: budget tracker under the delivery site (`GET /apps/b2b/budget`): budget, already ordered, this order, remaining or over by, waiting for approval; over budget turns red and the button says **Send for approval**.
- Migration `20261128000000_budgets` (checked against Postgres 16: applies cleanly, no drift). 102 tests pass.

**Closed and dormant sites (28 Nov).** Unleashed stays the master list of sites.
- A site whose Unleashed delivery address is obsolete (or removed from a customer that still has a Delivery tab), or whose customer is obsolete, is switched off: location metafield `b2b.closed` = true + `SiteStatus` row. It's hidden from the cart site picker, can't be ordered for (`buyerContext` skips it), and is hidden from Site budgets and the quarterly summary. Reactivated in Unleashed → reopened automatically. Never deleted (history kept).
- **Site details follow Unleashed too** (28 Nov): the same daily run first updates existing sites' **name, delivery address and delivery note** from Unleashed (matched on the address Guid, so renames are found; groups keep "Member - Site") and **adds new Delivery tab sites** to existing trade companies, giving them to the contacts who already have every site (the head-office admin). It doesn't create companies or touch contacts / main contact / budget admin. Edit sites in Unleashed, not Shopify: Shopify edits are overwritten. (`applyCompany` with `updateExisting` + `sitesOnly`; `refreshSitesFromUnleashed` in `app/sites.server.ts`.)
- Runs daily in the web process (15 min after start, then every 24 h) and from **Site budgets → "Update sites from Unleashed now"**, which lists every change. Closed sites: "Show closed sites" → why/when/by whom, **Reopen**.
- **Dormant** badge on Site budgets: no order for **6 months** (Unleashed sales orders matched on customer code + delivery name, plus portal orders; recorded by the daily check).
- Head-office admin closes a site: `POST /apps/b2b/sites/close` (only the company's budget approver) → switched off at once + staff emailed to obsolete it in Unleashed. Button comes with the phase 5 customer budgets page.

**Phase 4 next:**
1. You: Postmark account → add sender signature / domain **clearchoiceproducts.com**, add its DKIM and Return-Path DNS records, create a Server and copy its **Server API token**.
2. You: on Render, web service → Environment: `POSTMARK_SERVER_TOKEN` (the token) and `STAFF_EMAIL` (who gets failed orders). Blueprint → Manual Sync if the new keys don't appear. (Until the token is set, emails only go to the Render log.)
3. You: `git pull` → `npm run shopify app deploy` (cart tracker). Render redeploys the web service from main (runs the migration).
4. Test: app → **Site budgets** → Assetlink → small budget on the test buyer's site; make the test contact's company admin someone you can read (metafield `b2b.budget_admin_contact`, or use a site where the buyer isn't the admin); order within budget, then over budget → approval email → Approve → Unleashed; again → Decline.
5. Phase 5: head-office admin's own "Site budgets" page in their customer account, annual summary, per-site order history + CSV.

---

# Technical spec (v0.1)

## Pricing (R1)
Pricing order, mirroring Unleashed:
1. Customer Pricing (product or product group, with min qty and valid-from/to)
2. Quantity Prices
3. The customer's Sell Price Tier, minus the customer's Discount %
4. Default Sell Price

## Shopify data model
- **Company** = Unleashed customer. `company.externalId` = Unleashed Customer Code with spaces turned into `_` (Shopify doesn't allow spaces); the **exact** code is in company metafield `unleashed.customer_code`. Use the metafield when sending orders to Unleashed.
- **Groups** (`config/company-groups.csv`): several Unleashed customers run by one person become **one** Shopify company (`externalId` = `GROUP:<name>`, metafield `unleashed.group_members`). Each site is named "<member> - <site>" and carries its own Unleashed code in **location** metafield `unleashed.customer_code`, plus that member's payment terms. First group: **FIT Services Group** = CMMD, GRIMESQUAD PTY LTD, FIT SERVICES SYD (same admin email, payables@fitservices.com.au; Shopify allows a person to be a contact for only one company).
- **Which Unleashed customer an order goes to:** the site's `unleashed.customer_code` location metafield if present, else the company's `unleashed.customer_code`.
- **Company location** = delivery site from the customer's Unleashed Delivery tab (`externalId` = Unleashed address Guid; its own address, net terms from the Unleashed payment term).
- **Head-office admin** = Unleashed primary contact → company main contact, Location admin on every site, and company metafield `b2b.budget_admin_contact` = the contact's GID.
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
5. **Order flow** (revised 26 Nov: trade orders go straight to Unleashed):
   1. Work out prices on the server.
   2. `draftOrderCreate` (company/location, variantId + priceOverride ex GST, PO number, net terms, tag `trade-order`). **Never completed**: it stays a draft as the Shopify-side record.
   3. Budget check: the site's month-to-date spend (Sydney calendar month) + this order's goods ex GST, compared with that month's budget.
      - Buyers see portal orders on the portal's order history page, not in their Shopify account's order list (drafts don't show there). Agreed 26 Nov.
      - **Within budget:** send the order to Unleashed (below), tag the draft `sent-to-unleashed`, store the Unleashed order number on the draft and in the app DB, email the buyer a confirmation.
      - **Over budget:** tag the draft `awaiting-approval`, lock prices, email the head-office admin. Approve → send to Unleashed. Reject → tag `rejected`, notify the buyer.
   4. **Send to Unleashed** (`POST /SalesOrders/{guid}`):
      - `Customer.CustomerCode` = company `externalId`; `CustomerRef` = PO number.
      - `DeliveryName` = company location name; delivery street/suburb/city/region/postcode/country = the location's shipping address.
      - Lines: `Product.ProductCode` = SKU, `OrderQuantity`, `UnitPrice` ex GST, `LineTotal`, `LineTax` (10% GST on taxable products).
      - `SubTotal` / `TaxTotal` / `Total` (sum of lines; Total = SubTotal + TaxTotal), `Tax`/`TaxRate`, `ExchangeRate` = 1.
      - `OrderStatus` = **Parked**; `Warehouse` = **Clearchoice Factory**; tax code **OUTPUT** ("GST on Income (10%)") at rate **0.1** (corrected 26 Nov; not G.S.T., which Unleashed uses for two different taxes, sales and purchases). Tax kept in a setting and checked against Unleashed's tax list (code or description) before sending. Delivery suburb goes in `DeliverySuburb`; `DeliveryCity` left blank.
      - `DeliveryInstruction`: the site's note in Shopify (Unleashed delivery instruction + site contacts/phones/dock notes found in the address fields during import) plus the buyer's note from the order form.
      - `Comments`: Shopify draft name, buyer name and email.
      - The app generates the order's Guid and saves it **before** posting, so a retry can never create a duplicate.
      - If Unleashed rejects or is down: the draft is tagged `unleashed-failed`, the order is retried automatically, and Clearchoice staff are emailed. The buyer still sees "order received".
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
- Trade drafts are never completed, so the Unleashed Shopify app (set to import Paid orders only) can't import them.
- Stock: trade orders don't reduce Shopify inventory directly; Unleashed allocates the stock and its normal stock export updates Shopify.

## Phases
1. Unleashed client + pricing engine
2. Company/site import and linking
3. Price display + "Place order" (within budget). **Start with a one-off script that creates a test order for Assetlink in the Unleashed sandbox via the API**, and check customer, delivery name/address, Customer Reference and prices before building on it.
4. Budgets, approvals, emails
5. Site budgets page and reports
6. Staging tests (incl. retail orders still importing via the Unleashed Shopify app, trade orders arriving via the API, no duplicates) → production
