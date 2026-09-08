# Test Credentials

## Admin Account
- Email: admin@test.com
- Password: admin123
- Role: super_admin
- Login URL: /admin/login

## Pallet pricing test fixture (Feb 7, 2026 — half/full pallet feature)
- Tile: Alabaster Polished 60x60cm — series `TestSeries`
- m2_per_pallet=32, m2_per_half_pallet=16, half_pallet_price=27.5, pallet_price=26.09, room_lot_price=28.99
- Storefront PDP: /shop/collection/TestSeries → click 60x60cm size → pallet-tier-selector card visible
- Product (admin): id `3ab24973-a23e-4805-8164-9186e5888146` (Adhesive 20kg) — used by pallet PUT/GET round-trip tests

## Warehouse feature (Jul 17, 2026)
- Warehouse showroom is auto-created on first call to /api/warehouse/info (singleton, name "Tonbridge Warehouse", is_warehouse=True).
- Sample product used by warehouse pytest suite: `a83cc826-79e1-4dcb-b548-a798f5113c6e` (Floor Tile Grey 600x600, SKU FT-001).
- Test staff users are created/deleted per-run with prefix `TEST_warehouse_staff_*` — do not rely on any persistent staff account for warehouse tests.

## Trade discount % / £ fixture (Aug 3, 2026)
- Bulk-tier PUT `/api/supplier-sync/products/bulk-tier-update` accepts `trade_discount_type: 'percent'|'fixed'` plus optional `pallet_enabled`, `pallet_price`, `half_pallet_price`, `m2_per_pallet`, `m2_per_half_pallet`.
- Product-level SKU test round-trip: `Canopy / HE6000` — confirms both fixed £/m² trade discount and Half+Full pallet fields persist to `supplier_products` and propagate to `tiles`.
- Pricing calculate endpoint: `GET /api/tiles/pricing/calculate?base_price=50&quantity=100&is_trade=true&trade_discount=5&trade_discount_type=fixed` → `trade_current_price_per_m2=37.5` (deducts £5 flat off the tier-discounted RRP of £42.50).

## Bulk save verification + array-field publish (Aug 3, 2026)
- `POST /api/supplier-sync/products/bulk-update-unified` now returns `verification_checked`, `verification_failures[]`, `verification_ok` — re-reads **every** affected product from `supplier_products` (not a sample) and compares intended vs actual for the fields the admin set. Silent save failures now surface as a warning toast AND auto-open the Save Results dialog in the Bulk Category Editor.
- Auto-publish `tile_doc` in `supplier_sync.py` now includes the array fields (`colors`, `materials`, `styles`, `features`, `rooms`).
- `serialize_tile_for_shop` in `tiles.py` now returns `colors`, `materials`, `styles`, `features`, `rooms`, `main_category`, `sub_categories`.
- Collections list unique-colour aggregation prefers the `colors` array over the scalar `color`.
- PDP style/pattern selector label is context-aware (Materials→"Type" etc.).

## Materials Manager MVP (Aug 3, 2026)
- New admin route `/admin/materials` (`MaterialsManager.jsx`) — dedicated focused editor for adhesives, grouts, sealants, cleaning &amp; primers.
- Wired into `ProductsHub.js` as an orange NEW card next to Supplier Products.
- Filters `/api/supplier-sync/products/all` by `product_group === 'materials'` OR `main_category === 'Materials'` OR any `sub_categories` matches (adhesive/grout/sealant/cleaning/primer/etc.).
- Sub-tabs: All Materials / Adhesives / Grouts / Sealants / Cleaning / Other.
- Edit modal shows only material-relevant fields: Bag Weight, Coverage (m²/bag), Setting Time, Pot Life, Application Thickness, VOC Rating, Bag Colour, Colour, Suitability, Description. Saves via the shared `bulk-update-unified` endpoint so tier pricing / publish / stock all keep working.
- Verified: scoped save `SKU1+SKU2→Grey`, `SKU3→White` returned `verification_ok=true`, `checked=3`, `failures=0`, Mongo shows the correct `color` + `colors[]` on each SKU.

## Category classifier + routing (Aug 3, 2026)
- `POST /api/supplier-sync/products/backfill-product-group` — one-shot classifier that reads every supplier_product and assigns `product_group` (tiles / materials / flooring / bathroom / underfloor_heating / tools) based on `main_category`, `sub_categories`, and product name. Supports dry_run for preview.
- `POST /api/supplier-sync/products/bulk-assign-category` — sets `product_group` on a list of SKUs (overrides). Also backfills blank `main_category`, and auto-sets `pricing_unit='unit'` for materials.
- Legacy Bulk Editor: click "Edit" on a product → if `product_group` is set, browser routes to the matching Manager (`/admin/materials?edit=SKU` etc.) which auto-opens the edit modal for that SKU. Fallback QuickEditModal opens when unclassified.
- `?edit=SKU` query param handled by MaterialsManager + TilesManager to auto-open the row after navigation.
- New status filter: "⚠️ Needs Category (unclassified)" — surfaces products without a product_group so admin can bulk-assign them.
- Removed per-row Visibility dropdown (Online/In-Store/Hidden) and "Always In Stock" checkbox from the legacy product table (owner reported unused, took space).

## Workspace tabs + Custom Managers (Aug 3, 2026 — later still)
- New shared component `ManagerTabsBar` renders at the top of every Products page. Tabs: All Products / Tiles / Materials / Flooring / Bathroom / Underfloor Heat / Tools / <custom managers> / + New Custom Manager. Uses real Link routing (browser back + deep-link work).
- New shared component `ManagerFiltersPanel` renders facet dropdowns (Colour, Finish, Material, Size, Slip, Supplier, Status for tiles; Colour, Bag Colour, Suitability, Supplier, Status for materials). Options + counts computed live from the loaded product list. Active filters shown as chips above the panel.
- New backend CRUD `/api/manager-definitions` (GET public, POST/PATCH/DELETE require supplier_products permission). Fields: slug, name, description, theme, icon, sub_categories[], field_definitions[], product_group.
- New page `/admin/custom-manager/:slug` renders a data-driven Manager from a manager_definitions doc. Reuses AssignColoursModal, TierPricingModal, ManagerBulkBar, useManagerBulk. Products auto-classified by matching `product_group` OR `sub_categories` OR product name against the definition's keywords.
- Custom Manager builder modal `CustomManagerBuilder.jsx` — accessible from the "+ New Custom Manager" pill in every workspace tab bar. Curl-verified round-trip: create (200), list (returns doc), delete (soft-delete via deleted_at + audit log entry), duplicate slug → 409.

## Trade test account (Aug 18, 2026 — WAS price / sale flow testing)
- Email: trade.test@tilestation.co.uk
- Password: TradeTest123!
- is_trade=True, trade_approved=True, trade_discount=5%
- Login: storefront Sign In (or Trade Login) — used to verify trade discount stacks into sale/WAS savings

## WAS-price sale fixture (Aug 18, 2026)
- Tile LP-1214 (LEPORCE, "Dolomite Onyx Green 60x120cm Polished", series Dolomite Onyx): price £30 (unchanged), was_price £39.99, discount_percentage 25.0, sale_active=True — set via POST /api/supplier-sync/products/bulk-sale-pricing with {"was_price": 39.99}


## Trade access flow (Sep 8, 2026 — admin-created accounts / password reset)
- Admin-created trade account (via POST /api/trade-accounts): smoke.trade@example.com / SmokePass123! — T-00024, Bronze, "Smoke Trade Ltd" (set via setup link → /reset-password?token=…&for=trade)
- Admin-created accounts NO LONGER use "TempPass123!" — a random password is set and a 7-day set-password link is emailed (Resend rejects @example.com addresses, so in preview the link is returned in the API response `login_link.link` and via `POST /api/trade-accounts/{id}/send-login-link`).
- `/api/auth/forgot-password`, `/api/auth/reset-password`, `/api/auth/verify-reset-token` now serve BOTH `users` (staff) and `shop_customers` (retail + trade). Tokens live in `password_resets` with `account_type` = staff|shop, `purpose` = reset|setup.
- Storefront login `/api/shop/auth/login` is case-insensitive on email.
- Pytest: backend/tests/test_trade_access_flow.py (needs MONGO_URL, DB_NAME, REACT_APP_BACKEND_URL env).

## Trade Hub (Sep 8, 2026)
- Admin URL: /admin/trade (tabs ?tab=dashboard|traders|credit|settings). Old routes /admin/trade-accounts, /admin/trade-list, /admin/trade-account-settings, /admin/trade-credit-emails redirect here.
- Super-admin-only: POST /api/trade-hub/traders/{id}/credit-adjust, /credit-expiry/expire-now, /credit-expiry/set-bulk. Staff (any trade_accounts permission) can read ledger/summary/timeline, set expiry dates, send reminders/nudges/login links.
- Trade tiers are DISABLED (website_settings trade_account_settings.tiers_enabled=false; frontend treats missing as disabled). New accounts: trade_discount 0, trade_tier null.
- Registration source: X-Staff-Token header (admin JWT) on /api/shop/auth/trade-register → channel in_store; else showroom IP list (Trade Hub → Settings → Showroom computers; GET/PUT /api/trade-hub/showroom-ips, GET /api/trade-hub/my-ip) → in_store; else online + device from UA; admin-created → staff_created.
- Pytest: backend/tests/test_trade_hub.py (creates a temporary staff user hub_staff_*@example.com / StaffPass123! and deletes it).
