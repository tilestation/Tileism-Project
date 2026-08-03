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
- `POST /api/supplier-sync/products/bulk-update-unified` now returns `verification_checked`, `verification_failures[]`, `verification_ok` — samples up to 10 saved products and re-reads them from `supplier_products` to confirm the intended fields persisted. Silent save failures now surface as a toast in the Bulk Category Editor.
- Auto-publish `tile_doc` in `supplier_sync.py` now includes the array fields (`colors`, `materials`, `styles`, `features`, `rooms`) that were previously omitted — so freshly-published multi-colour products show the correct number of COLOUR swatches on the collection card.
- `serialize_tile_for_shop` in `tiles.py` now returns `colors`, `materials`, `styles`, `features`, `rooms`, `main_category`, `sub_categories` so the storefront PDP + collection card can group correctly.
- Collections list unique-colour aggregation (`tiles.py::_group_products_by_series`) prefers the `colors` array over the scalar `color` so multi-colour groupings are counted correctly.
- PDP style/pattern selector label is now context-aware: Tiles→"Pattern", Materials→"Type", Flooring→"Finish", Bathroom→"Model", Underfloor Heating→"Kit Size", Tools→"Model" (`CollectionDetailPage.js::styleSelectorLabel`).
