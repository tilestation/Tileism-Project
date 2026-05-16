/**
 * Regression test for the Ahrefs "Multiple title / Multiple meta description"
 * duplicate-tag bug fix (17 May 2026).
 *
 * Background: server-seo.js injects ~16 SEO tags into the SSR HTML
 * (title, description, canonical, og:*, twitter:*, robots, jsonld, etc.)
 * After React 19 hydrates, the per-page <SeoHead/> component ALSO emits
 * the same tag types via React's automatic head hoisting. JS-rendering
 * crawlers (Ahrefs, Screaming Frog with JS, browsers) end up seeing
 * BOTH sets in the live DOM → "Multiple title tags" and "Multiple meta
 * description tags" alerts on every product/collection page.
 *
 * Fix: every SSR-injected SEO tag now carries `data-ssr-seo="1"`. An
 * inline strip script (in the same SEO block) runs once before the
 * React bundle and removes those marked tags from <head>, letting
 * <SeoHead/> be the single source of truth in the live DOM.
 *
 * This test pins the contract:
 *   - Every SSR-injected SEO tag must carry `data-ssr-seo="1"`
 *   - The inline strip script must be present in the output
 *   - Re-running injectMeta on the same HTML must be idempotent
 *     (no growth in tag count, strip script not duplicated)
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

console.log('Running server-seo duplicate-tag fix tests...');

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

  // Every one of those must carry the marker.
  assert.ok(titleTags[0].includes('data-ssr-seo'), '<title> must carry data-ssr-seo marker');
  assert.ok(descTags[0].includes('data-ssr-seo'), '<meta description> must carry marker');
  assert.ok(canonicals[0].includes('data-ssr-seo'), '<link canonical> must carry marker');
  assert.ok(ogTitle[0].includes('data-ssr-seo'), 'og:title must carry marker');
  assert.ok(ogImage[0].includes('data-ssr-seo'), 'og:image must carry marker');
  assert.ok(twitterCard[0].includes('data-ssr-seo'), 'twitter:card must carry marker');
  assert.ok(jsonld[0].includes('data-ssr-seo'), 'jsonld <script> must carry marker');

  console.log('  ✅ Test 1 — every SSR SEO tag carries data-ssr-seo');
}

// ── Test 2: strip-on-mount inline script must be present ──────────
{
  const html = injectMeta(FAKE_SHELL, PRODUCT_META);
  assert.ok(html.includes('__seoSsrStripped'), 'strip-on-mount script must be present');
  assert.ok(html.includes("querySelectorAll('[data-ssr-seo]')"), 'strip script must query data-ssr-seo nodes');
  assert.ok(html.includes('.remove()'), 'strip script must call .remove() on matched nodes');
  console.log('  ✅ Test 2 — strip-on-mount script present and correct');
}

// ── Test 3: idempotency — running injectMeta twice does not duplicate ──
{
  const once = injectMeta(FAKE_SHELL, PRODUCT_META);
  const twice = injectMeta(once, PRODUCT_META);

  const titleOnce = (once.match(/<title[^>]*>/g) || []).length;
  const titleTwice = (twice.match(/<title[^>]*>/g) || []).length;
  const stripOnce = (once.match(/<script>[^<]*__seoSsrStripped[\s\S]*?<\/script>/g) || []).length;
  const stripTwice = (twice.match(/<script>[^<]*__seoSsrStripped[\s\S]*?<\/script>/g) || []).length;

  assert.strictEqual(titleTwice, titleOnce, 'running injectMeta twice must not duplicate <title>');
  assert.strictEqual(stripTwice, stripOnce, 'running injectMeta twice must not duplicate strip script');
  console.log('  ✅ Test 3 — idempotent on rebuild');
}

// ── Test 4: no SEO tag without the marker (escape hatch — every tag
//           must be strippable so React owns the head after mount) ───
{
  const html = injectMeta(FAKE_SHELL, PRODUCT_META);
  // Scan the SSR block region for any meta/link/title/script tag
  // and make sure each one carries the marker.
  const block = html.match(/<!-- SSR-injected SEO[\s\S]*?<!-- \/SSR-injected SEO -->/);
  assert.ok(block, 'expected an SSR-injected SEO block');

  const tagRe = /<(title|meta|link|script)\b[^>]*>/g;
  const tags = block[0].match(tagRe) || [];
  for (const tag of tags) {
    assert.ok(tag.includes('data-ssr-seo'), `SEO tag missing data-ssr-seo marker: ${tag.slice(0, 100)}`);
  }
  console.log(`  ✅ Test 4 — all ${tags.length} SSR tags carry the marker`);
}

// ── Test 5: idempotent strip-script removal — re-running injectMeta
//           where input already includes the SSR block + strip script
//           must NOT produce two strip scripts. (Caught a bug during
//           the initial design where the regex stripped the SEO block
//           but left the orphan strip <script> behind.)
{
  const once = injectMeta(FAKE_SHELL, PRODUCT_META);
  const twice = injectMeta(once, { ...PRODUCT_META, title: 'New Title v2' });
  // Count <script> tags that mention __seoSsrStripped — accurate even
  // if the flag is referenced multiple times inside the same script.
  const stripScripts = (twice.match(/<script>[^<]*__seoSsrStripped[\s\S]*?<\/script>/g) || []).length;
  assert.strictEqual(stripScripts, 1, 'strip script must appear exactly once after re-injection');
  // And the new title must have replaced the old one in <title> tag.
  // (Note: jsonld payload carries the original product name from
  // PRODUCT_META.jsonld and persists across both injections — that's
  // separate from the <title> tag and intentionally not asserted.)
  const titleMatch = twice.match(/<title[^>]*>([^<]+)<\/title>/);
  assert.ok(titleMatch, 'new HTML must have a <title> tag');
  assert.strictEqual(titleMatch[1], 'New Title v2', 're-injection must update <title> text');
  console.log('  ✅ Test 5 — re-injection cleans previous strip script + updates content');
}

console.log('\nAll server-seo SSR duplicate-tag tests passed ✅');
