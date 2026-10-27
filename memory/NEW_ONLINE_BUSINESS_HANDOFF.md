# Handoff Brief: New Online-Only Tile Business (Dropship/Hybrid)

Paste this whole file as your first message to the new Emergent project (after importing
the Tile Station GitHub repo into it). It tells the new project's agent exactly what to
keep, adapt, strip and build fresh — so it doesn't have to rediscover any of this.

## Context
This codebase was imported from "Tile Station" — a multi-showroom tiles & bathroom
e-commerce + EPOS platform. We are building a **second, fully independent business**:
an **online-only** tile shop (no showrooms, no EPOS, no in-store staff), using the
**same suppliers** as Tile Station, fulfilled via **dropshipping to start, with the option
to hold our own stock later**. Payments via **Stripe**.

## 1. Keep as-is (core commerce — safe to reuse directly)
- `backend/models/product.py`, `backend/models/order.py`, `backend/models/user.py`,
  `backend/models/common.py`, `backend/models/invoice.py` — product/order/user schemas.
- `backend/services/stripe_checkout.py` + the Klarna/PayPal Express session logic in
  `backend/routes/shop.py` (functions `create_klarna_express_session`,
  `create_paypal_express_session`, and the shared `extract_stripe_customer_fields()`
  helper) — this checkout logic was just hardened (address collection, webhook capture,
  fractional-quantity rounding) on 23 Oct 2026, so it's the most battle-tested part of
  the codebase. Carry the fixed version, not an older commit.
- `backend/services/object_storage.py` — image/file upload handling (product photos).
- Storefront cart/catalog/checkout endpoints in `backend/routes/shop.py` — filter down to:
  product listing/search, cart, checkout session creation, order creation, guest
  checkout status polling, order confirmation emails. Skip anything store/showroom-specific
  (click & collect, `/stores`, showroom-linked order assignment).
- Frontend: `TileCartPage.js`, `TileCheckoutPage.js`, `ShopProducts.js`/`TileListingPage.js`,
  `TileDetailPage.js`, `ShopLogin.js`/`ShopRegister.js`, `TileAccountPage.js`,
  `OrderSuccessPage.js` — the customer-facing shop pages. Strip any "visit our showroom"
  copy/links (same cleanup just done for the Chingford closure is a good reference for
  where that copy tends to hide: homepage footer, sample-service pages, info pages).
- `backend/routes/orders.py` (the parts that build/send order confirmation emails and
  generate invoice PDFs) and `backend/services/email.py` (Resend-based sending) —
  reusable, just swap the branding/sender details.
- Basic admin shell: `frontend/src/pages/admin/Layout.js` (sidebar/nav structure) and
  `AdminLogin`/auth pages — reuse the shape, trim the sidebar to only the sections you
  still need (Products, Orders, Customers, Settings).

## 2. CRITICAL — Supplier Sync & Stock Pipeline (must keep — this is the only way stock/prices reach the website)
I undersold this in the first draft by lumping it into "reuse with adaptation." It's
actually the backbone of the whole business — without it, nothing from your suppliers
ever reaches the live site. The real pipeline has **4 stages**, each a separate piece:

1. **Scrape/pull raw supplier data** — `backend/services/scrapers/` (`verona_scraper.py`,
   `splendour_scraper.py`, `ceramica_impex_scraper.py`, `wallcano_scraper.py`,
   `base_scraper.py`) + the Verona Chrome extension receiver endpoints in
   `routes/supplier_sync.py` (Verona is blocked server-side by Cloudflare, so it's
   pulled via a browser extension instead — see `/extension` endpoints and
   `VeronaExtensionStatus.jsx`). Pulls current price/stock/images per supplier.
2. **Staging / review queue** — `backend/routes/sync_staging.py` (2,700+ lines) holds
   incoming changes as `updates` (existing products with a changed price/stock) and
   `new_products` (not yet in your catalog) until an admin reviews them. Nothing touches
   your live catalog until this review happens.
3. **Apply to working catalog** — admin reviews in the **Sync Hub** UI
   (`frontend/src/pages/admin/SyncHub.js`, 3,200+ lines — per-supplier tabs, diff view,
   bulk-approve new products, "Review Mode" fast-approve overlay) and clicks Apply,
   which writes into the `supplier_products` collection via `sync_staging.py`'s
   `/{supplier}/apply` endpoint. This is your actual working catalog with margins/SKU
   mapping — **not yet live on the website**.
4. **Publish to website** — `frontend/src/pages/admin/PublishSupplierProducts.js` calls
   `/api/supplier-sync/publish-to-website` (in `routes/supplier_sync.py`), which copies
   from `supplier_products` into the `tiles` collection — **this is the only thing the
   live storefront actually reads from**. Skipping this step is why "I updated the
   price but the website still shows the old one" bugs happen — it's easy to forget
   there's a separate publish step after apply.

Supporting pieces that belong to this same pipeline — keep these too:
- `frontend/src/pages/admin/SupplierProducts.js` (17,000+ lines — the main admin catalog
  browser: margin calc, image management, SKU↔product mapping, per-supplier filtering).
  This is huge; if the new business starts with 1-2 suppliers, consider having the new
  project's agent build a trimmed single-supplier version first rather than porting the
  whole file, then grow it back out.
- `routes/stock_sync.py`, `services/sync/stock_sync_service.py`,
  `services/sync/resilient_sync_service.py` — stock-quantity reconciliation + retry logic.
- `routes/live_sync.py`, `routes/nightly_sync.py` — scheduled re-sync jobs.
- `routes/supplier_health.py` + `frontend/src/pages/admin/SupplierHealthDashboard.js` +
  `SupplierSyncDashboard.js` — monitors stale/failed syncs per supplier.
- `routes/suppliers.py` + `frontend/src/pages/admin/Suppliers.js` — supplier contact/
  credential records.

**For dropshipping specifically**: keep stages 1-4 exactly as the "what products exist,
at what price/stock, on the website" engine — that doesn't change. The **new** dropship
logic (section 4 below) plugs in at **order time**, not sync time: when a customer buys
a product that's mapped to a dropship supplier, the order-routing logic looks up that
same `supplier_products` mapping to know which supplier to forward the order to.

## 3. Reuse with real adaptation (don't copy blindly)
- `backend/routes/products.py` / Tiles Manager-style admin catalog pages — reuse the
  catalog data model, but the "Manager" admin UIs (`TilesManager.jsx`,
  `MaterialsManager.jsx`, etc.) are overbuilt for a single-business MVP — rebuild a
  single simpler "Products" admin page instead of porting 6+ separate manager pages.
- Pricing logic — Tile Station has trade/VAT tiering, pallet pricing, and per-showroom
  price overrides (`business_config/business_rules.py`, `pallet_pricing_admin.py`).
  Review this for just the plain-retail-pricing parts; strip showroom-tier pricing.

## 4. Build new (doesn't exist in Tile Station — it's a stock-holding business)
- **Dropship order routing**: when an order is placed, auto-generate and send a
  purchase order / email / API call to the relevant supplier with the customer's
  delivery address, instead of decrementing your own stock. Needs a per-supplier
  "how do we place an order with them" integration (email-based PO is the simplest MVP;
  API-based is a later upgrade if a supplier offers one).
- **Margin/markup logic**: since you don't hold stock, your retail price needs to be
  supplier cost + your markup, calculated live or synced — not a manually-set shelf price.
- **Delivery expectation messaging**: dropship lead times vary by supplier, so the
  product page/checkout needs supplier-specific delivery estimates instead of the
  "same-day from our warehouse" messaging Tile Station uses.
- A lightweight **order status sync** from supplier → your admin (even manual status
  updates to start) so customers can be told when their dropshipped order has shipped.

## 5. Explicitly exclude (Tile Station-specific, out of scope for this MVP)
Showrooms/EPOS (`routes/showrooms.py`, `Epos.js`, `ShowroomEpos.js`, cash counter,
stock transfers between stores), HR/staff (`hr_*`, `StaffChat.js`, time tracking,
staff leaderboard/competition), the SEO Autopilot/Ahrefs/stealth-SEO automation suite
(`seo_autopilot*.py`, `stealth_seo*.py`, `seo_autonomous.py`), Marketing Studio/Radio
Studio/video generation, Room Visualizer, Trade Credit Accounts, WhatsApp/Telegram ops
tooling. All of this is real cost to carry over and none of it is needed to launch a
lean online-only dropship shop — revisit later if the business grows into needing it.

## 6. Secrets you'll need to re-enter in the new project (not exported from GitHub)
- `STRIPE_API_KEY` (your own Stripe account — do **not** reuse Tile Station's, for
  separate bookkeeping/payouts)
- Resend API key (for order emails) — can be a new sender domain/account
- Supplier credentials for whichever suppliers you're reusing from Tile Station
  (API keys or scraper logins) — ask in chat for these and the new project's agent will
  collect them securely
- `MONGO_URL`/`DB_NAME` are auto-provisioned per project — nothing to do there

## 7. Suggested first build order for the new project's agent
1. Strip the repo down per sections 1/2/3/5 above (remove excluded modules first — makes
   the codebase much easier to reason about).
2. Get basic product catalog + storefront browsing working with a handful of seeded
   products — including the trimmed single-supplier version of the sync pipeline
   (sections 2 + 3) so stock/price updates actually flow end-to-end from day one.
3. Wire up Stripe checkout (reusing the hardened Klarna/PayPal Express logic).
4. Build the dropship order-routing flow for your first 1–2 suppliers.
5. Re-skin the storefront with the new business's name/branding once decided.
