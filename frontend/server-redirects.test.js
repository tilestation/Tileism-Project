/**
 * Unit tests for server-redirects.js — the 19 legacy URLs flagged
 * by Google Search Console on 12 May 2026 as "Page with redirect".
 *
 * Each URL must resolve to a real current page (not /, the home
 * page) so Google sees a proper move instead of a soft-redirect.
 *
 * Run: `cd /app/frontend && node server-redirects.test.js`
 */
const assert = require('node:assert/strict');
const { resolveLegacyRedirect, _setDynamicRedirectsForTest } = require('./server-redirects');

const cases = [
  // The 19 URLs from the GSC screenshot — every one must resolve to
  // a real, non-home URL.
  { from: '/product-page/hartley-collection', to: '/shop/collection/Hartley' },
  { from: '/shop/reviews', to: '/shop/info/reviews' },
  { from: '/shop', to: '/tiles' },
  { from: '/shop/', to: '/tiles' },
  { from: '/category/ceramic-tiles', to: '/tiles?material=ceramic' },
  { from: '/category/spanish-tiles', to: '/tiles?origin=spain' },
  { from: '/category/polish-tiles', to: '/tiles?finish=polished' },
  { from: '/category/metro-tiles', to: '/tiles?shape=metro' },
  { from: '/shop/track-order', to: '/shop/track' },
  { from: '/bathroom', to: '/shop/bathroom' },

  // Variants
  { from: '/track', to: '/shop/track' },
  { from: '/track-order', to: '/shop/track' },
  { from: '/track-order/', to: '/shop/track' },
  { from: '/bathroom/', to: '/shop/bathroom' },
  { from: '/shop/reviews/', to: '/shop/info/reviews' },
  { from: '/category/ceramic-tiles/', to: '/tiles?material=ceramic' },

  // Double /shop/ scraper pattern (e.g. /shop/info/terms/shop/track)
  { from: '/shop/info/terms/shop/track', to: '/shop/track' },
  { from: '/shop/info/terms/shop/track/', to: '/shop/track' },
  { from: '/shop/foo/shop/bar', to: '/tiles' },

  // Unknown category slugs fall through to /tiles with category=<slug>
  { from: '/category/random-tiles', to: '/tiles?category=random' },
  // Random /category/* with no -tiles suffix → /tiles
  { from: '/category/foo', to: '/tiles' },
  { from: '/category', to: '/tiles' },

  // Case-insensitive
  { from: '/SHOP', to: '/tiles' },
  { from: '/Category/Ceramic-Tiles', to: '/tiles?material=ceramic' },

  // No redirect for canonical URLs — must return null so SPA serves them
  { from: '/', to: null },
  { from: '/tiles', to: null },
  { from: '/shop/track', to: null },
  { from: '/shop/bathroom', to: null },
  { from: '/shop/info/reviews', to: null },
  { from: '/shop/collection/Hartley', to: null },
  { from: '/contact', to: null },
  { from: '/about', to: null },
];

let pass = 0;
let fail = 0;

for (const { from, to } of cases) {
  const result = resolveLegacyRedirect(from);
  const ok = result === to;
  if (ok) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL  ${from}`);
    console.error(`      expected: ${JSON.stringify(to)}`);
    console.error(`      actual:   ${JSON.stringify(result)}`);
  }
}

console.log(`\nserver-redirects.test.js — ${pass} passed, ${fail} failed`);
assert.equal(fail, 0, 'one or more redirect tests failed');

// ─── Dynamic redirect override tests ─────────────────────────────────
// Tests that the runtime DB-driven map overrides the static map.

let dynPass = 0;
let dynFail = 0;

function dynCase(name, fn) {
  try {
    fn();
    dynPass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    dynFail++;
    console.error(`  ✗ ${name} — ${e.message}`);
  }
}

console.log('\nDynamic redirect overrides:');

// Inject some DB-side redirects
_setDynamicRedirectsForTest({
  '/old-product-x': '/shop/collection/Hartley',
  '/seasonal/spring-2026': '/tiles?effect=stone',
});

dynCase('dynamic redirect resolves', () => {
  assert.equal(resolveLegacyRedirect('/old-product-x'), '/shop/collection/Hartley');
});

dynCase('dynamic redirect overrides static map for /shop', () => {
  _setDynamicRedirectsForTest({ '/shop': '/tiles/new-route' });
  assert.equal(resolveLegacyRedirect('/shop'), '/tiles/new-route');
  // Restore for cleanliness
  _setDynamicRedirectsForTest({});
});

dynCase('falls back to static when dynamic is empty', () => {
  _setDynamicRedirectsForTest({});
  assert.equal(resolveLegacyRedirect('/shop'), '/tiles');
});

dynCase('returns null for unknown path with no dynamic match', () => {
  _setDynamicRedirectsForTest({ '/foo': '/bar' });
  assert.equal(resolveLegacyRedirect('/never-existed'), null);
});

// Reset
_setDynamicRedirectsForTest({});

console.log(`\nDynamic — ${dynPass} passed, ${dynFail} failed`);
assert.equal(dynFail, 0, 'dynamic redirect tests failed');
