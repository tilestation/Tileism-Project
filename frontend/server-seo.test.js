/**
 * Unit tests for server-seo.js.
 *
 * Run with: cd /app/frontend && node server-seo.test.js
 *
 * No test framework needed — uses Node's `assert` so the test runs
 * in any container without yarn/npm installs. Exits non-zero on
 * failure so CI can pick it up.
 */
const assert = require('node:assert/strict');
const { resolveSeo, injectMeta } = require('./server-seo');

const cases = [
  // Exact matches
  { path: '/', expectTitle: /Tile Station/, expectCanonical: 'https://tilestation.co.uk/' },
  { path: '/contact', expectTitle: /Contact/, expectCanonical: 'https://tilestation.co.uk/contact' },
  { path: '/contact/', expectCanonical: 'https://tilestation.co.uk/contact', note: 'trailing slash stripped' },
  { path: '/contact?ref=email', expectCanonical: 'https://tilestation.co.uk/contact', note: 'query stripped' },
  { path: '/visualizer', expectTitle: /Coming Soon/, note: 'visualizer hidden CTA' },

  // Dynamic prefixes
  { path: '/tiles/spanish-floor-marble-60x60', expectTitle: /Spanish Floor Marble 60x60/ },
  { path: '/products/onyx-white', expectTitle: /Onyx White/ },
  { path: '/collections/bathroom', expectTitle: /Bathroom Collection/ },
  { path: '/tiles/category/porcelain', expectTitle: /Porcelain Tiles/ },
  { path: '/tile-shop/london', expectTitle: /Tile Shop London/ },
  { path: '/installer/manchester', expectTitle: /Tile Installers in Manchester/ },
  { path: '/blog/how-to-grout-tiles', expectTitle: /How To Grout Tiles/ },

  // Visualizer share — must be noindex
  { path: '/visualizer/share/abc123', expectTitle: /Shared/, expectNoindex: true },

  // ─── /shop/* exact pages (12 May 2026 Ahrefs hotfix) ──────────────
  { path: '/shop/faq', expectTitle: /^FAQ ·/, note: 'shop FAQ' },
  { path: '/shop/sample-service', expectTitle: /Sample Service/ },
  { path: '/shop/tile-forgot-password', expectTitle: /Reset/, expectNoindex: true },
  { path: '/shop/track', expectTitle: /Track Your Order/ },
  { path: '/shop/bathroom', expectTitle: /Bathroom Tiles/ },
  { path: '/shop/contact', expectTitle: /Contact Us/ },
  { path: '/shop/refer', expectTitle: /Refer a Friend/ },
  { path: '/shop/compare', expectTitle: /Compare Tiles/ },
  { path: '/shop/all-tiles', expectTitle: /All Tiles/ },
  { path: '/shop/info/faq', expectTitle: /^FAQ ·/ },
  { path: '/shop/info/privacy', expectTitle: /Privacy Policy/ },
  { path: '/shop/info/terms', expectTitle: /Terms & Conditions/ },
  { path: '/shop/info/returns', expectTitle: /Returns/ },
  { path: '/shop/info/delivery', expectTitle: /Delivery/ },
  { path: '/shop/info/reviews', expectTitle: /Customer Reviews/ },

  // ─── /shop/* dynamic prefix patterns ──────────────────────────────
  { path: '/shop/collection/Fossil', expectTitle: /Fossil Collection ·/ },
  { path: '/shop/collection/Brilliant%20White', expectTitle: /Brilliant White Collection ·/, note: 'URL-encoded collection name decoded' },
  { path: '/shop/collection/Coral%20Grey%2060%C3%9760cm%20Matt', expectTitle: /Coral Grey 60×60cm Matt Collection ·/, note: '×-char survives decode' },
  { path: '/shop/collection/Amalfi%20Flat', expectTitle: /Amalfi Flat Collection ·/ },
  { path: '/shop/product/marble-veneto', expectTitle: /Marble Veneto ·/ },
  { path: '/shop/products/marble-veneto', expectTitle: /Marble Veneto ·/, note: 'legacy /shop/products/' },
  { path: '/shop/tiles/dark-onyx', expectTitle: /Dark Onyx ·/ },
  { path: '/shop/info/about', expectTitle: /About Tile Station/, note: 'mapped in EXACT (no titlecase ·)' },
  { path: '/shop/tile-scale-print/30x60cm', expectTitle: /Tile Scale Print/, expectNoindex: true },
  // Sub-path under a collection — should be noindex
  { path: '/shop/collection/Fossil/somesub', expectTitle: /Fossil Collection/, expectNoindex: true },

  // Asset-like paths must be skipped (return null)
  { path: '/static/js/main.abc.js', expectNull: true },
  { path: '/api/anything', expectNull: true },
  { path: '/icon-192.png', expectNull: true },
];

let pass = 0, fail = 0;
for (const c of cases) {
  try {
    const meta = resolveSeo(c.path);
    if (c.expectNull) {
      assert.equal(meta, null, `expected null for ${c.path}`);
    } else {
      assert.ok(meta, `expected meta for ${c.path}`);
      assert.ok(meta.title, `title missing for ${c.path}`);
      assert.ok(meta.description, `description missing for ${c.path}`);
      assert.ok(meta.canonical, `canonical missing for ${c.path}`);
      if (c.expectTitle) assert.match(meta.title, c.expectTitle, `title mismatch for ${c.path}: ${meta.title}`);
      if (c.expectCanonical) assert.equal(meta.canonical, c.expectCanonical, `canonical mismatch for ${c.path}`);
      if (c.expectNoindex) assert.equal(meta.noindex, true, `noindex missing for ${c.path}`);
    }
    pass++;
    console.log(`  ✓ ${c.path}${c.note ? ` (${c.note})` : ''}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${c.path} — ${e.message}`);
  }
}

// injectMeta tests
console.log('\ninjectMeta:');
const fakeShell = '<!doctype html><html><head><meta charset="utf-8" /></head><body><div id="root"></div></body></html>';
const meta = resolveSeo('/contact');
const html = injectMeta(fakeShell, meta);

const injectionTests = [
  { name: '<title> injected', check: () => /<title>Contact[^<]*<\/title>/.test(html) },
  { name: '<meta description> injected', check: () => /<meta name="description"[^>]+>/.test(html) },
  { name: '<link canonical> injected', check: () => /<link rel="canonical"[^>]+>/.test(html) },
  { name: 'og:title injected', check: () => /<meta property="og:title"[^>]+>/.test(html) },
  { name: 'twitter:card injected', check: () => /<meta name="twitter:card"[^>]+>/.test(html) },
  { name: 'idempotent — running injectMeta twice yields same result', check: () => injectMeta(html, meta).match(/<title>/g).length === 1 },
  { name: 'no <noindex> on regular pages', check: () => !/<meta name="robots"[^>]+noindex/.test(html) },
];
const shareHtml = injectMeta(fakeShell, resolveSeo('/visualizer/share/x'));
injectionTests.push({
  name: 'noindex IS injected on /visualizer/share',
  check: () => /<meta name="robots"[^>]+noindex/.test(shareHtml),
});

// SSR body content injection (12 May 2026 Soft 404 hotfix)
const collectionHtml = injectMeta(fakeShell, resolveSeo('/shop/collection/Hartley'));
injectionTests.push({
  name: 'SSR body H1 injected for /shop/collection/Hartley',
  check: () => /<h1[^>]*>Hartley Collection[^<]*<\/h1>/.test(collectionHtml),
});
injectionTests.push({
  name: 'SSR body paragraph injected for collection page',
  check: () => /<p[^>]*>Explore the Hartley[^<]*<\/p>/.test(collectionHtml),
});
injectionTests.push({
  name: 'SSR body content NOT injected on noindex pages',
  check: () => !/<h1[^>]*>Shared/.test(shareHtml),
});
injectionTests.push({
  name: 'SSR body content placed INSIDE the empty #root div',
  check: () => /<div id="root">\s*<div class="ssr-fallback"/.test(collectionHtml),
});

for (const t of injectionTests) {
  try {
    assert.ok(t.check(), t.name);
    pass++;
    console.log(`  ✓ ${t.name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${t.name}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
