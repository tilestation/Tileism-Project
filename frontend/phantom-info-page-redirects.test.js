/**
 * Regression test for the "phantom info-page URL" bug
 * (24 May 2026 — user reported the Google Business Profile sitelink
 * "About Tile Station" landed on Page Not Found).
 *
 * Root cause:
 *   server-seo-enrich.js injected <title>/<meta description>/<h1>
 *   for /about, /contact, /faq, /delivery, /returns, /privacy,
 *   /terms, /reviews — so Google indexed all 8 phantom URLs — but
 *   the React SPA had no client-side routes for any of them. Real
 *   users hit the SPA's NotFound fallback while crawlers happily
 *   indexed phantom pages.
 *
 * Contract pinned:
 *   1. server-redirects.js LEGACY_301_MAP maps each phantom path
 *      (and its trailing-slash variant) to the working canonical.
 *   2. /contact → /shop/contact (its dedicated ContactPage), all
 *      others → /shop/info/<slug>.
 *   3. App.js carries matching client-side redirects so any SPA-
 *      internal Navigate() to these paths also routes correctly
 *      (defence in depth — protects against direct in-app links).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { resolveLegacyRedirect } = require('./server-redirects');
const appSource = fs.readFileSync(
  path.join(__dirname, 'src/App.js'),
  'utf8',
);

// ── 1. Server-side 301s (these are what Google sees) ────────────
const expectedServerRedirects = [
  ['/about', '/shop/info/about'],
  ['/about/', '/shop/info/about'],
  ['/contact', '/shop/contact'],
  ['/contact/', '/shop/contact'],
  ['/faq', '/shop/info/faq'],
  ['/faq/', '/shop/info/faq'],
  ['/delivery', '/shop/info/delivery'],
  ['/delivery/', '/shop/info/delivery'],
  ['/returns', '/shop/info/returns'],
  ['/returns/', '/shop/info/returns'],
  ['/privacy', '/shop/info/privacy'],
  ['/privacy/', '/shop/info/privacy'],
  ['/terms', '/shop/info/terms'],
  ['/terms/', '/shop/info/terms'],
  ['/reviews', '/shop/info/reviews'],
  ['/reviews/', '/shop/info/reviews'],
];

for (const [from, to] of expectedServerRedirects) {
  const actual = resolveLegacyRedirect(from);
  assert.equal(
    actual,
    to,
    `Server-side 301: expected ${from} → ${to}, got ${actual}`,
  );
}

// ── 2. Client-side React Router redirects (defence in depth) ────
const expectedClientRedirects = [
  ['/about', '/shop/info/about'],
  ['/contact', '/shop/contact'],
  ['/faq', '/shop/info/faq'],
  ['/delivery', '/shop/info/delivery'],
  ['/returns', '/shop/info/returns'],
  ['/privacy', '/shop/info/privacy'],
  ['/terms', '/shop/info/terms'],
  ['/reviews', '/shop/info/reviews'],
];

for (const [from, to] of expectedClientRedirects) {
  const escFrom = from.replace(/\//g, '\\/');
  const escTo = to.replace(/\//g, '\\/');
  const pattern = new RegExp(
    `<Route\\s+path="${escFrom}"\\s+element=\\{<Navigate\\s+to="${escTo}"\\s+replace\\s*/?>\\}\\s*/>`,
  );
  assert.match(
    appSource,
    pattern,
    `App.js must contain client-side redirect ${from} → ${to} so SPA-internal Navigate() also routes correctly`,
  );
}

// ── 3. Real existing canonical paths must NOT redirect (sanity) ─
const shouldNotRedirect = [
  '/shop/info/about',
  '/shop/info/faq',
  '/shop/contact',
  '/tiles',
  '/shop/track',
  '/',
];
for (const p of shouldNotRedirect) {
  assert.equal(
    resolveLegacyRedirect(p),
    null,
    `Canonical path ${p} must NOT redirect (would create a loop)`,
  );
}

console.log('✓ phantom-info-page-redirects.test.js — all assertions passed');
