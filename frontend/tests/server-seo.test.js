/**
 * Regression test for the Ahrefs "Multiple title / Multiple meta description"
 * duplicate-tag fix attempt and its 17 May 2026 revert.
 *
 * Background: server-seo.js injects ~22 SEO tags into the SSR HTML
 * (title, description, canonical, og:*, twitter:*, robots, jsonld, etc.).
 * After React 19 hydrates, the per-page <SeoHead/> component ALSO emits
 * the same tag types via React's automatic head hoisting. JS-rendering
 * crawlers (Ahrefs, Screaming Frog with JS, browsers) end up seeing
 * BOTH sets in the live DOM → "Multiple title tags" and "Multiple meta
 * description tags" alerts on every product/collection page.
 *
 * First attempt (REVERTED): every SSR tag got a `data-ssr-seo="1"`
 * marker AND an inline strip-on-mount script that removed those tags
 * before React mounts. Disastrously, <SeoHead/> isn't present on every
 * page — 77 collection/category pages had their <title> stripped with
 * nothing replacing it. Ahrefs Health Score crashed 90s → 63 in one
 * crawl. The strip script was reverted.
 *
 * What we KEEP: the `data-ssr-seo` markers are still added. They cost
 * nothing and will be useful when the proper duplicate-tag fix is
 * implemented (the right place for that is inside <SeoHead/> itself —
 * it should remove matching SSR-marked tags before injecting its own,
 * so only pages that use <SeoHead/> have the cleanup happen).
 *
 * These tests pin both invariants:
 *   - Every SSR-injected SEO tag carries `data-ssr-seo="1"`
 *   - The inline strip script is NOT present (so it can't get
 *     accidentally re-introduced without a proper fix)
 *   - injectMeta is idempotent (re-running doesn't duplicate the block)
 */
/* eslint-disable */
const assert = require('assert');
const { injectMeta } = require('../server-seo.js');

const FAKE_SHELL = '<!doctype html><html><head><meta charset="utf-8" /></head><body><div id="root"></div></body></html>';

const PRODUCT_META = {
  title: 'Verona Carrara 60x60cm | Tile Station',
  description: 'Premium polished porcelain — 60x60cm grey marble effect, £29.99/m².',
  canonical: 'https://tilestation.co.uk/tile/verona-carrara-60x60cm',
  product: {
    image: 'https://tilestation.co.uk/tile/verona-carrara.jpg',
    name: 'Verona Carrara 60x60cm',
    price: '29.99',
    currency: 'GBP',
    availability: 'in stock',
    brand: 'Tile Station',
  },
  jsonld: { '@context': 'https://schema.org', '@type': 'Product', name: 'Verona Carrara 60x60cm' },
};

console.log('Running server-seo SSR tag tests...');

// ── Test 1: every SSR SEO tag must carry data-ssr-seo ──────────────
{
  const html = injectMeta(FAKE_SHELL, PRODUCT_META);

  const titleTags = html.match(/<title[^>]*>/g) || [];
  const descTags = html.match(/<meta[^>]*name="description"[^>]*>/g) || [];
  const canonicals = html.match(/<link[^>]*rel="canonical"[^>]*>/g) || [];
  const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*>/g) || [];
  const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*>/g) || [];
  const twitterCard = html.match(/<meta[^>]*name="twitter:card"[^>]*>/g) || [];
  const jsonld = html.match(/<script[^>]*application\/ld\+json[^>]*>/g) || [];

  assert.strictEqual(titleTags.length, 1, 'should have exactly one <title>');
  assert.strictEqual(descTags.length, 1, 'should have exactly one <meta description>');
  assert.strictEqual(canonicals.length, 1, 'should have exactly one canonical');
  assert.strictEqual(ogTitle.length, 1, 'should have exactly one og:title');
  assert.strictEqual(ogImage.length, 1, 'should have exactly one og:image');
  assert.strictEqual(twitterCard.length, 1, 'should have exactly one twitter:card');
  assert.strictEqual(jsonld.length, 1, 'should have exactly one jsonld script');

  // Every one of those must carry the marker so a future per-page
  // cleanup can identify them without touching unrelated tags.
  assert.ok(titleTags[0].includes('data-ssr-seo'), '<title> must carry data-ssr-seo marker');
  assert.ok(descTags[0].includes('data-ssr-seo'), '<meta description> must carry marker');
  assert.ok(canonicals[0].includes('data-ssr-seo'), '<link canonical> must carry marker');
  assert.ok(ogTitle[0].includes('data-ssr-seo'), 'og:title must carry marker');
  assert.ok(ogImage[0].includes('data-ssr-seo'), 'og:image must carry marker');
  assert.ok(twitterCard[0].includes('data-ssr-seo'), 'twitter:card must carry marker');
  assert.ok(jsonld[0].includes('data-ssr-seo'), 'jsonld <script> must carry marker');

  console.log('  ✅ Test 1 — every SSR SEO tag carries data-ssr-seo');
}

// ── Test 2: inline strip-on-mount script MUST be absent ───────────
//   (Reverted 17 May 2026 — see server-seo.js comment. Guard against
//   accidental re-introduction without a proper SeoHead-side cleanup.)
{
  const html = injectMeta(FAKE_SHELL, PRODUCT_META);
  assert.ok(!html.includes('__seoSsrStripped'), (
    'inline strip-on-mount script must NOT be present (took down 77 ' +
    'pages on production when introduced — see server-seo.js comment).'
  ));
  console.log('  ✅ Test 2 — no inline strip script (proper duplicate fix belongs in SeoHead)');
}

// ── Test 3: idempotency — running injectMeta twice does not duplicate ──
{
  const once = injectMeta(FAKE_SHELL, PRODUCT_META);
  const twice = injectMeta(once, PRODUCT_META);

  const titleOnce = (once.match(/<title[^>]*>/g) || []).length;
  const titleTwice = (twice.match(/<title[^>]*>/g) || []).length;
  const blocksOnce = (once.match(/<!-- SSR-injected SEO/g) || []).length;
  const blocksTwice = (twice.match(/<!-- SSR-injected SEO/g) || []).length;

  assert.strictEqual(titleTwice, titleOnce, 'running injectMeta twice must not duplicate <title>');
  assert.strictEqual(blocksTwice, blocksOnce, 're-injection must not duplicate the SEO block');
  console.log('  ✅ Test 3 — idempotent on rebuild');
}

// ── Test 4: every <title|meta|link|script> inside the SSR block must
//           carry the marker (escape hatch for future per-tag cleanups)
{
  const html = injectMeta(FAKE_SHELL, PRODUCT_META);
  const block = html.match(/<!-- SSR-injected SEO[\s\S]*?<!-- \/SSR-injected SEO -->/);
  assert.ok(block, 'expected an SSR-injected SEO block');

  const tagRe = /<(title|meta|link|script)\b[^>]*>/g;
  const tags = block[0].match(tagRe) || [];
  for (const tag of tags) {
    assert.ok(tag.includes('data-ssr-seo'), `SEO tag missing data-ssr-seo marker: ${tag.slice(0, 100)}`);
  }
  console.log(`  ✅ Test 4 — all ${tags.length} SSR tags carry the marker`);
}

// ── Test 5: re-injection updates content correctly ──────────────────
{
  const once = injectMeta(FAKE_SHELL, PRODUCT_META);
  const twice = injectMeta(once, { ...PRODUCT_META, title: 'New Title v2' });

  // <title> tag content must update
  const titleMatch = twice.match(/<title[^>]*>([^<]+)<\/title>/);
  assert.ok(titleMatch, 'new HTML must have a <title> tag');
  assert.strictEqual(titleMatch[1], 'New Title v2', 're-injection must update <title> text');

  // Only ONE SEO block — old one was stripped before the new one was inserted
  const blocks = (twice.match(/<!-- SSR-injected SEO/g) || []).length;
  assert.strictEqual(blocks, 1, 're-injection must not accumulate SEO blocks');

  console.log('  ✅ Test 5 — re-injection updates content without accumulating blocks');
}

console.log('\nAll server-seo SSR tag tests passed ✅');
