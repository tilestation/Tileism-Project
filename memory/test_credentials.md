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
