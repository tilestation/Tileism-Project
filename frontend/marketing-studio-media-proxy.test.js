/**
 * Regression test for the Marketing Studio "broken-image hero" bug
 * (23 May 2026).
 *
 * Symptom: after a Marketing Studio banner was published to the
 * homepage hero, the slide rendered with a broken-image icon in the
 * top-left and the rest of the banner blank. Root cause: published
 * slides stored their image as a relative URL
 *   `/api/website/marketing-media/<asset_id>.png`
 * which the browser resolved against the storefront origin
 * (tilestation.co.uk). The Express SPA server didn't proxy that
 * path → SPA fallback returned text/html → broken image.
 *
 * Two-pronged fix pinned by this test:
 *   1. server.js must mount /api/website/marketing-media (and
 *      /api/website/uploads as a defensive sibling) as proxies to
 *      the backend. Without this, legacy relative-URL slides stay
 *      broken even after the backend stores absolute URLs.
 *   2. The proxy MUST target BACKEND_URL (not a hardcoded host).
 *
 * Run: `cd /app/frontend && node marketing-studio-media-proxy.test.js`
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverSource = fs.readFileSync(
  path.join(__dirname, 'server.js'),
  'utf8',
);

// ── 1. /api/website/marketing-media MUST be mounted as a proxy ──
assert.match(
  serverSource,
  /app\.use\(\s*['"]\/api\/website\/marketing-media['"]\s*,\s*websiteMediaProxy\s*\)/,
  '/api/website/marketing-media must proxy to the FastAPI backend — ' +
    'without it, every Marketing-Studio-published banner shows as a ' +
    'broken image icon on the homepage hero',
);

// ── 2. /api/website/uploads also proxied (defensive sibling) ──
assert.match(
  serverSource,
  /app\.use\(\s*['"]\/api\/website\/uploads['"]\s*,\s*websiteMediaProxy\s*\)/,
  '/api/website/uploads should also be proxied — CMS uploads use this path',
);

// ── 3. The proxy MUST target BACKEND_URL, not a hardcoded host ──
const proxyBlock = serverSource.slice(
  serverSource.indexOf('const websiteMediaProxy'),
  serverSource.indexOf("app.use('/api/website/marketing-media'"),
);
assert.match(
  proxyBlock,
  /target:\s*BACKEND_URL/,
  'website-media proxy must forward to BACKEND_URL',
);
assert.match(
  proxyBlock,
  /changeOrigin:\s*true/,
  'proxy must set changeOrigin:true to avoid CORS / SNI issues',
);

console.log('✓ marketing-studio-media-proxy.test.js — all assertions passed');
