// Node function tests for SSR SEO enrichment (iter 250)
const enrich = require('./server-seo-enrich.js');
const seo = require('./server-seo.js');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; console.log(`FAIL: ${name}${extra ? ' -- ' + extra : ''}`); }
}

// (a) buildProductMeta bodyContent
const fakeProduct = {
  name: 'Test Marble Tile',
  slug: 'test-marble-tile',
  material: 'Marble',
  size: '60x60cm',
  finish: 'Polished',
  color: 'White',
  price: 42.5,
  description: 'A beautiful white marble tile perfect for kitchens and bathrooms.',
  collection_name: 'Marble Collection',
  collection_slug: 'marble-collection',
  images: ['https://example.com/img.jpg'],
};
const pm = enrich.buildProductMeta(fakeProduct);
console.log('\n--- product bodyContent (first 400 chars) ---\n' + (pm.bodyContent||'').slice(0,400));
check('a1 buildProductMeta returns bodyContent string', typeof pm.bodyContent === 'string' && pm.bodyContent.length > 0);
check('a2 product bodyContent contains <h1>', /<h1[^>]*>/i.test(pm.bodyContent));
check('a3 product bodyContent contains breadcrumb <nav>', /<nav[^>]*>/i.test(pm.bodyContent));
check('a4 product bodyContent contains spec <ul>', /<ul[^>]*>[\s\S]*<\/ul>/i.test(pm.bodyContent));
check('a5 product bodyContent mentions material', /Marble/.test(pm.bodyContent));

// (b) buildCollectionMeta with products
const fakeCollection = {
  name: 'Marble Collection',
  slug: 'marble-collection',
  description: 'Elegant marble tiles.',
  products: [
    { name: 'Marble A', slug: 'marble-a' },
    { name: 'Marble B', slug: 'marble-b' },
    { name: 'Marble C', slug: 'marble-c' },
  ],
};
const cm = enrich.buildCollectionMeta(fakeCollection);
console.log('\n--- collection bodyContent (first 400 chars) ---\n' + (cm.bodyContent||'').slice(0,400));
check('b1 buildCollectionMeta returns bodyContent', typeof cm.bodyContent === 'string' && cm.bodyContent.length > 0);
check('b2 collection bodyContent contains <li><a> product links', /<li[^>]*>\s*<a[^>]+href=/i.test(cm.bodyContent));
check('b3 collection bodyContent contains marble-a link', /marble-a/.test(cm.bodyContent));

// (c) buildCityPageMeta with markdown, nearby cities and related collections
const fakeCity = {
  city: 'Gravesend',
  slug: 'tile-shop-gravesend',
  h1: 'Tile Shop in Gravesend',
  body_md: '## Welcome to Gravesend\n\nWe supply **top quality** tiles.\n\n- Free samples\n- Fast delivery\n- Local showroom\n\n### Why us\n\nExperienced team.',
  town: 'Gravesend',
  nearby_cities: [ { label: 'Dartford', url: '/tiles/tile-shop-dartford' }, { label: 'Rochester', url: '/tiles/tile-shop-rochester' } ],
  related_collections: [ { label: 'Marble', url: '/collections/marble' }, { label: 'Wood Effect', url: '/collections/wood-effect' } ],
};
const cpm = enrich.buildCityPageMeta(fakeCity);
console.log('\n--- city bodyContent (first 700 chars) ---\n' + (cpm.bodyContent||'').slice(0,700));
check('c1 buildCityPageMeta returns bodyContent', typeof cpm.bodyContent === 'string' && cpm.bodyContent.length > 0);
check('c2 city bodyContent has <h2>', /<h2[^>]*>/i.test(cpm.bodyContent));
check('c3 city bodyContent has <h3>', /<h3[^>]*>/i.test(cpm.bodyContent));
check('c4 city bodyContent has <ul><li>', /<ul[^>]*>[\s\S]*<li[^>]*>/i.test(cpm.bodyContent));
check('c5 city bodyContent has <strong>', /<strong[^>]*>/i.test(cpm.bodyContent));
check('c6 city bodyContent has nearby city link', /tile-shop-dartford/.test(cpm.bodyContent));
check('c7 city bodyContent has related collection link', /\/collections\/marble|marble/.test(cpm.bodyContent));

// (d) injectMeta places bodyContent inside <div id="root">
const html = '<!doctype html><html><head><title>x</title></head><body><div id="root"></div></body></html>';
const meta = { title: 'T', description: 'D', canonical: 'https://x/', bodyContent: '<h1 data-marker="probe">HELLO SSR BODY</h1>' };
const out = seo.injectMeta(html, meta);
const rootMatch = out.match(/<div id="root"[^>]*>([\s\S]*?)<\/div>/i);
check('d1 output has <div id="root">', !!rootMatch);
check('d2 bodyContent injected inside root', rootMatch && /HELLO SSR BODY/.test(rootMatch[1]));
check('d3 probe marker present in root', rootMatch && /data-marker="probe"/.test(rootMatch[1]));

// (e) resolveSeo sanity
const rRoot = seo.resolveSeo('/');
check('e1 resolveSeo("/") returns object with title', rRoot && typeof rRoot === 'object' && typeof rRoot.title === 'string' && rRoot.title.length > 0);
const rFaq = seo.resolveSeo('/shop/info/faq');
check('e2 resolveSeo("/shop/info/faq") returns object with title', rFaq && typeof rFaq === 'object' && typeof rFaq.title === 'string' && rFaq.title.length > 0);
console.log('resolveSeo("/") =>', JSON.stringify({title:rRoot.title, desc:(rRoot.description||'').slice(0,60)}));
console.log('resolveSeo("/shop/info/faq") =>', JSON.stringify({title:rFaq.title, desc:(rFaq.description||'').slice(0,60)}));

console.log(`\n===== Node tests: ${passed} passed, ${failed} failed =====`);
process.exit(failed > 0 ? 1 : 0);
