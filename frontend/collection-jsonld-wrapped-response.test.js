/**
 * Regression test for the lookupCollection response-shape bug
 * (23 May 2026 evening).
 *
 * Long-standing silent SEO regression: lookupCollection only handled
 * a bare-array response from /api/tiles/collections. The backend was
 * later changed to wrap results as `{ collections: [...], total, ... }`
 * which made lookupCollection ALWAYS return null. Every collection
 * page then shipped with the generic WebPage JSON-LD instead of our
 * branded CollectionPage + ItemList, dragging the audit and reducing
 * SERP rich-result eligibility.
 *
 * Also pins the second half of the fix: ItemList now includes up to
 * 10 real product entries fetched from /api/tiles/collection/<name>.
 */
const assert = require('node:assert/strict');

// Patch global fetch behaviour via the module's fetchJson by faking
// out the BACKEND_URL + intercepting via a tiny http server. Cheaper:
// monkey-patch the require cache to install a stub fetchJson.

(async () => {
  // Force-reload module
  delete require.cache[require.resolve('./server-seo-enrich')];

  // Inject a custom fetchJson by reaching into module internals via
  // a require hook. Cleanest path: spin up a real Node http server
  // that mimics both backend endpoints, then point BACKEND_URL at it.
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/tiles/collections')) {
      // Wrapped shape (current production format)
      res.end(JSON.stringify({
        collections: [
          { series_name: 'Moonstone', product_count: 20 },
          { series_name: 'Bluestone', product_count: 14 },
        ],
        total: 2, total_products: 34, page: 1, limit: 100,
      }));
      return;
    }
    if (req.url.startsWith('/api/tiles/collection/Moonstone')) {
      res.end(JSON.stringify({
        products: [
          { slug: 'moonstone-ivory-30x60cm-matt', display_name: 'Moonstone Ivory 30x60cm Matt' },
          { slug: 'moonstone-ivory-60x120cm-matt', display_name: 'Moonstone Ivory 60x120cm Matt' },
        ],
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ detail: 'Not Found' }));
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  process.env.REACT_APP_BACKEND_URL = `http://127.0.0.1:${port}`;
  process.env.SEO_BACKEND_FETCH_TIMEOUT_MS = '3000';

  const m = require('./server-seo-enrich');

  // ── 1. Wrapped-response shape MUST be handled ──
  const c = await m.lookupCollection('Moonstone');
  assert.ok(c, 'lookupCollection must NOT return null for a wrapped collections response');
  assert.equal(c.series_name, 'Moonstone');

  // ── 2. Products MUST be enriched from /collection/<name> ──
  assert.ok(Array.isArray(c.products), 'Collection row must have products[] for ItemList');
  assert.ok(c.products.length >= 2, `Expected ≥2 products, got ${c.products.length}`);
  assert.equal(c.products[0].slug, 'moonstone-ivory-30x60cm-matt');

  // ── 3. buildCollectionMeta MUST emit CollectionPage + ItemList ──
  const meta = m.buildCollectionMeta(c, 'Moonstone');
  assert.equal(meta.jsonld['@type'], 'CollectionPage');
  assert.ok(meta.jsonld.mainEntity, 'ItemList (mainEntity) must be present');
  assert.equal(meta.jsonld.mainEntity['@type'], 'ItemList');
  assert.equal(meta.jsonld.mainEntity.itemListElement.length, 2);
  assert.match(
    meta.jsonld.mainEntity.itemListElement[0].url,
    /\/shop\/product\/moonstone-ivory-30x60cm-matt$/,
  );

  // ── 4. Title MUST be under 60 chars and include brand suffix ──
  assert.ok(meta.title.length <= 60,
    `Title too long: ${meta.title.length} chars: "${meta.title}"`);
  assert.ok(meta.title.endsWith('· Tile Station'));

  server.close();
  console.log('✓ collection-jsonld-wrapped-response.test.js — all assertions passed');
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
