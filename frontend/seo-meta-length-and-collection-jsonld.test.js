/**
 * Regression tests for the SEO meta-title length + Collection
 * JSON-LD fixes (23 May 2026).
 *
 * Background — both shipped in the same session that took the
 * SEO Self-Audit from F (33%) → B (87%):
 *
 *   1. Product titles regularly clocked in at 75-90 chars. Google
 *      truncates SERP titles at ~55-60 chars, so the trailing
 *      "Tile Station" brand suffix was being cut. The audit flagged
 *      "title too long (76 chars, want 50-60)" weight 5.
 *
 *   2. Collection pages emitted ZERO Schema.org JSON-LD. The audit
 *      flagged "no CollectionPage/ItemList schema detected" weight 6.
 *
 * Run: `cd /app/frontend && node seo-meta-length-and-collection-jsonld.test.js`
 */
const assert = require('node:assert/strict');

process.env.REACT_APP_BACKEND_URL = process.env.REACT_APP_BACKEND_URL ||
  'http://localhost:8001';

// Import the (CJS) module under test.
const enrich = require('./server-seo-enrich');
const buildProductMeta = enrich.buildProductMeta;
const buildCollectionMeta = enrich.buildCollectionMeta;

assert.ok(buildProductMeta, 'buildProductMeta must be exported');
assert.ok(buildCollectionMeta, 'buildCollectionMeta must be exported');

// ─── 1. PRODUCT TITLE LENGTH ─────────────────────────────────────────
// Realistic problem cases pulled from the production audit.
const cases = [
  {
    name: 'Ardesia Slate White 30x60cm Matt',
    price: 42.99,
    material: 'Porcelain',
  },
  {
    // Very long name that must be ellipsized while preserving brand.
    name: 'Super Long Branded Ceramic Subway Tile Premium Edition 30x60cm Matte Charcoal',
    price: 25,
    material: 'Ceramic',
  },
  {
    name: 'Onyx',
    price: 18,
    material: 'Stone',
  },
];

for (const product of cases) {
  const meta = buildProductMeta(product, 'slug-x');
  assert.ok(meta && meta.title, `meta.title must exist for "${product.name}"`);
  assert.ok(
    meta.title.length <= 60,
    `Product title must be ≤60 chars; got ${meta.title.length}: "${meta.title}"`,
  );
  assert.ok(
    meta.title.endsWith('· Tile Station'),
    `Brand suffix must always be preserved; got: "${meta.title}"`,
  );
}

// ─── 2. PRODUCT JSON-LD still present (no regression on earlier fix) ──
{
  const meta = buildProductMeta({
    name: 'Ardesia Slate White 30x60cm Matt',
    price: 42.99,
    material: 'Porcelain',
    supplier_code: 'PSLPRAC',
    images: ['https://example.com/x.jpg'],
  }, 'ardesia-slate-white');
  assert.equal(meta.jsonld['@type'], 'Product');
  assert.equal(meta.jsonld.sku, 'PSLPRAC');
  assert.equal(meta.jsonld.offers.price, '42.99');
  assert.equal(meta.jsonld.offers.priceCurrency, 'GBP');
}

// ─── 3. COLLECTION META — title ≤60 + JSON-LD shape ─────────────────
const collMeta = buildCollectionMeta({
  display_name: 'Ardesia',
  product_count: 12,
  products: [
    { slug: 'ardesia-slate-white', display_name: 'Slate White' },
    { slug: 'ardesia-slate-grey', display_name: 'Slate Grey' },
    { slug: 'ardesia-slate-black', display_name: 'Slate Black' },
  ],
}, 'ardesia');
assert.ok(collMeta && collMeta.title);
assert.ok(
  collMeta.title.length <= 60,
  `Collection title must be ≤60 chars; got ${collMeta.title.length}: "${collMeta.title}"`,
);
assert.ok(
  collMeta.title.endsWith('· Tile Station'),
  `Collection brand suffix preserved; got: "${collMeta.title}"`,
);

// JSON-LD must be a CollectionPage with an embedded ItemList.
assert.ok(collMeta.jsonld, 'Collection MUST emit jsonld now (was missing — audit weight 6)');
assert.equal(collMeta.jsonld['@type'], 'CollectionPage');
assert.equal(collMeta.jsonld.name, 'Ardesia Tile Collection');
assert.ok(collMeta.jsonld.mainEntity, 'mainEntity (ItemList) must be present when products[] given');
assert.equal(collMeta.jsonld.mainEntity['@type'], 'ItemList');
assert.equal(collMeta.jsonld.mainEntity.itemListElement.length, 3);
assert.equal(collMeta.jsonld.mainEntity.itemListElement[0].name, 'Slate White');
assert.match(
  collMeta.jsonld.mainEntity.itemListElement[0].url,
  /\/shop\/product\/ardesia-slate-white$/,
);

// Collection with no products should still emit CollectionPage but
// without the ItemList block (otherwise Google logs a structured-data
// validation warning for an empty ItemList).
{
  const empty = buildCollectionMeta({
    display_name: 'Empty Collection',
    product_count: 0,
  }, 'empty');
  assert.ok(empty.jsonld, 'empty collection still gets a CollectionPage jsonld');
  assert.equal(empty.jsonld['@type'], 'CollectionPage');
  assert.ok(!empty.jsonld.mainEntity, 'empty ItemList must NOT be emitted');
}

console.log('✓ seo-meta-length-and-collection-jsonld.test.js — all assertions passed');
