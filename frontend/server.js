/* eslint-disable no-console */
/**
 * Production-only static server with backend proxy.
 *
 * Why we don't just use `serve -s build`
 * --------------------------------------
 * Googlebot needs `tilestation.co.uk/sitemap.xml` and
 * `tilestation.co.uk/robots.txt` to return real XML / text. Those URLs
 * have to be served at the document root (Google won't accept them at
 * a sub-path or a different host without the right cross-host
 * directives). Our XML sitemap is generated dynamically by the FastAPI
 * backend at `/api/sitemap.xml` so we proxy the two SEO paths through
 * to the backend, and serve the React SPA for every other path.
 *
 * Local dev still uses `craco start` via supervisor — this server is
 * only invoked in the production Railway deploy.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const compression = require('compression');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { resolveSeo, injectMeta } = require('./server-seo');
const { enrichSeo } = require('./server-seo-enrich');
const { resolveLegacyRedirect, startDynamicRedirectRefresher } = require('./server-redirects');
const { startOverrideRefresher } = require('./server-seo-overrides');

const app = express();

// Strip Express's vanity header — defence in depth, no functional impact.
app.disable('x-powered-by');

// Gzip + brotli compression on every text response. Semrush flagged 97
// "not compressed" pages on the May 3 2026 crawl — `compression`
// middleware fixes all of them at once. Skips already-compressed
// formats (images, fonts, video) and respects `Cache-Control: no-transform`.
app.use(compression({
  threshold: 1024,  // don't bother compressing payloads < 1 KB
  level: 6,         // balanced gzip level — better ratio than default 1
}));

// We deliberately read this at boot so the proxy target is locked in
// for the lifetime of the process. If the backend URL is missing we
// log loudly and continue serving the SPA — sitemap/robots will 502
// but the rest of the storefront still works (degraded gracefully).
const BACKEND_URL =
  process.env.REACT_APP_BACKEND_URL ||
  process.env.BACKEND_URL ||
  null;

if (!BACKEND_URL) {
  console.warn(
    '[server] REACT_APP_BACKEND_URL not set — /sitemap.xml and /robots.txt ' +
    'will not be reachable. Set it in Railway env vars to fix.',
  );
} else {
  // Proxy the two SEO endpoints to the backend. We rewrite the path so
  // tilestation.co.uk/sitemap.xml hits backend /api/sitemap.xml. Same
  // for robots.txt. Both are GET-only, so we register them only on GET
  // to avoid accidentally exposing other backend verbs.
  const seoProxy = createProxyMiddleware({
    target: BACKEND_URL,
    changeOrigin: true,
    xfwd: true,
    pathRewrite: {
      '^/sitemap.xml': '/api/sitemap.xml',
      '^/robots.txt': '/api/robots.txt',
    },
    onError: (err, req, res) => {
      console.error('[server] SEO proxy error for', req.url, '—', err.message);
      // 503 not 500 — tells Google "try again later" instead of
      // "this URL is broken forever".
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Sitemap/robots backend temporarily unavailable.');
    },
    logLevel: 'warn',
  });
  app.get('/sitemap.xml', seoProxy);
  app.get('/robots.txt', seoProxy);
  app.head('/sitemap.xml', seoProxy);
  app.head('/robots.txt', seoProxy);

  // ──────────────────────────────────────────────────────────────────
  // IndexNow key-file proxy (May 16 2026).
  //
  // The IndexNow protocol (Bing/Yandex/DuckDuckGo re-indexing) verifies
  // ownership by GETing `https://tilestation.co.uk/<INDEXNOW_KEY>.txt`
  // and expecting the file's body to equal the key. We keep the key in
  // a backend env var so rotation is one-step, then proxy any
  // `/<32-128 hex>.txt` request at the root to the backend route which
  // returns the env value (or 404 if the key doesn't match).
  //
  // The regex restricts the proxy to hex strings of plausible IndexNow
  // length so it never collides with a real SPA path.
  // ──────────────────────────────────────────────────────────────────
  const indexnowProxy = createProxyMiddleware({
    target: BACKEND_URL,
    changeOrigin: true,
    xfwd: true,
    pathRewrite: (path) => {
      // path = "/<hex>.txt" — strip the leading slash + ".txt" and
      // rebuild the backend URL.
      const key = path.replace(/^\//, '').replace(/\.txt$/, '');
      return `/api/seo/indexnow/${key}.txt`;
    },
    onError: (err, req, res) => {
      console.error('[server] IndexNow proxy error for', req.url, '—', err.message);
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('IndexNow verifier temporarily unavailable.');
    },
    logLevel: 'warn',
  });
  app.get(/^\/[a-f0-9]{8,128}\.txt$/i, indexnowProxy);

  // Proxy the Google Search Console OAuth callback through to the
  // backend. Google redirects the user to
  // tilestation.co.uk/api/admin/gsc/callback after consent; without
  // this rule Express would serve the SPA instead of hitting the
  // FastAPI handler that actually stores the refresh token.
  //
  // We proxy the whole /api/admin/gsc path (not just /callback) so
  // connect/disconnect/status can also be reached via the public
  // domain if an admin ever opens devtools on tilestation.co.uk —
  // matches the redirect URI registered with Google 1:1.
  const gscProxy = createProxyMiddleware({
    target: BACKEND_URL,
    changeOrigin: true,
    xfwd: true,
    // No pathRewrite — the backend expects /api/admin/gsc/* as-is.
    onError: (err, req, res) => {
      console.error('[server] GSC proxy error for', req.url, '—', err.message);
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Search Console backend temporarily unavailable.');
    },
    logLevel: 'warn',
  });
  app.use('/api/admin/gsc', gscProxy);

  // Proxy the Google Business Profile OAuth + read endpoints, same
  // rationale as the GSC proxy above. Google redirects the user to
  // tilestation.co.uk/api/admin/gbp/callback after consent — without
  // this rule Express would serve the SPA instead of the FastAPI
  // handler that stores the refresh token. We proxy /api/admin/gbp
  // (not just /callback) so /status, /locations, /reviews, /insights
  // are reachable on the public domain too.
  const gbpProxy = createProxyMiddleware({
    target: BACKEND_URL,
    changeOrigin: true,
    xfwd: true,
    onError: (err, req, res) => {
      console.error('[server] GBP proxy error for', req.url, '—', err.message);
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Business Profile backend temporarily unavailable.');
    },
    logLevel: 'warn',
  });
  app.use('/api/admin/gbp', gbpProxy);

  // ──────────────────────────────────────────────────────────────────
  // Device-approval magic links (23 May 2026 fix).
  //
  // Bug: emails embed buttons like
  //   https://tilestation.co.uk/api/device-approvals/{id}/approve?token=...
  // because `COMPANY_WEBSITE` (the public storefront host) is the
  // brand the recipient trusts. Without a proxy, those requests hit
  // THIS Express server, fall through to the SPA catch-all, the
  // React Router then bounces unknown routes to "/" — so every click
  // landed the admin on the homepage instead of the approve/deny
  // handler. Same fix pattern as the GSC/GBP OAuth callbacks above.
  //
  // We proxy the *whole* /api/device-approvals path (not just the
  // magic-link GET) so a future admin-side device-approvals UI that
  // calls these endpoints from the storefront origin keeps working.
  // ──────────────────────────────────────────────────────────────────
  const deviceApprovalProxy = createProxyMiddleware({
    target: BACKEND_URL,
    changeOrigin: true,
    xfwd: true,
    onError: (err, req, res) => {
      console.error('[server] Device-approval proxy error for', req.url, '—', err.message);
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Device approval service temporarily unavailable.');
    },
    logLevel: 'warn',
  });
  app.use('/api/device-approvals', deviceApprovalProxy);

  // ──────────────────────────────────────────────────────────────────
  // Marketing Studio media (23 May 2026 fix).
  //
  // Bug: published hero banners stored their image as a relative path
  //   `/api/website/marketing-media/<asset_id>.png`
  // which the browser resolves against the storefront origin
  // (tilestation.co.uk). Without a proxy here, those image requests
  // fell through to the SPA catch-all and returned text/html — so
  // every Marketing-Studio-published banner rendered as a broken
  // image icon on the homepage. We also proxy /website/uploads and
  // /api/website/uploads which historically host CMS-uploaded media
  // referenced by absolute-but-same-origin URLs (defensive).
  // ──────────────────────────────────────────────────────────────────
  const websiteMediaProxy = createProxyMiddleware({
    target: BACKEND_URL,
    changeOrigin: true,
    xfwd: true,
    onError: (err, req, res) => {
      console.error('[server] website-media proxy error for', req.url, '—', err.message);
      res.statusCode = 503;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('Media backend temporarily unavailable.');
    },
    logLevel: 'warn',
  });
  app.use('/api/website/marketing-media', websiteMediaProxy);
  app.use('/api/website/uploads', websiteMediaProxy);
}

// Static assets — build/ contains hashed JS/CSS/images. `index: false`
// forbids serving directory listings or auto-index.html so we can
// route SPA fallback explicitly below.
const BUILD_DIR = path.join(__dirname, 'build');
app.use(express.static(BUILD_DIR, {
  index: false,
  maxAge: '1d',
  fallthrough: true,
  setHeaders: (res, file) => {
    // Hashed bundles can cache forever. index.html must not.
    if (file.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (/\.(?:js|css|png|jpe?g|webp|svg|woff2?)$/i.test(file)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// ────────────────────────────────────────────────────────────────────
// LEGACY 301 REDIRECTS — old Wix-style URLs that Google Search Console
// flagged as "Page with redirect" on 12 May 2026. The React Router
// catch-all (`path="*"` → Navigate to "/") was redirecting these URLs
// client-side, which Google interprets as a soft redirect and refuses
// to index. Replacing those client-side bounces with real HTTP 301s:
//   1. Passes SEO link-juice from the old URL to the new one
//   2. Removes the "Page with redirect" error from GSC
//   3. Lets the bots stop re-crawling the old URLs (cleaner crawl budget)
//
// Map + resolution live in `server-redirects.js` (testable in isolation).
// ────────────────────────────────────────────────────────────────────
app.get('*', (req, res, next) => {
  const target = resolveLegacyRedirect(req.path);
  if (target) {
    return res.redirect(301, target);
  }
  return next();
});

// Health check for Railway / load balancer pings.
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Read index.html ONCE at boot — it's the same for every route, we
// just inject route-specific metadata at request time. Saves ~5-10ms
// per request vs reading from disk each time. The ETag header is
// disabled since the body now varies per URL.
const BUILD_INDEX = path.join(BUILD_DIR, 'index.html');
let INDEX_HTML = '';
try {
  INDEX_HTML = fs.readFileSync(BUILD_INDEX, 'utf8');
  console.log(`[server] Loaded SPA shell from ${BUILD_INDEX} (${INDEX_HTML.length} bytes)`);
} catch (err) {
  console.error(`[server] Failed to read ${BUILD_INDEX} — ${err.message}`);
}

// SPA fallback — every other GET returns index.html with route-aware
// SEO metadata injected (<title>, <meta description>, canonical, OG
// tags). Crawlers without JS execution (Semrush, AhrefsBot, Bing's
// "crawl pass") see real per-page metadata; users get the same SPA
// bundle as before. May 3 2026 production fix for the 57 "Title tag
// missing or empty" errors flagged by Semrush.
app.get('*', async (req, res) => {
  if (!INDEX_HTML) {
    return res.status(503).type('text/plain')
      .send('Storefront temporarily unavailable.');
  }
  const baseline = resolveSeo(req.path);
  if (!baseline) {
    // Asset-like path that didn't match a real file — let the SPA show
    // its 404 page; still serve the bundle but skip metadata injection.
    return res.type('html').send(INDEX_HTML);
  }
  // Enrichment fetches real product/collection data with a 250ms timeout
  // and falls back silently to the baseline. Cached for 5 minutes per
  // slug so repeat crawler hits are basically free.
  const meta = await enrichSeo(req.path, baseline);
  const html = injectMeta(INDEX_HTML, meta);
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('html').send(html);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] Tile Station storefront listening on :${PORT}`);
  if (BACKEND_URL) {
    console.log(`[server] Proxying /sitemap.xml + /robots.txt → ${BACKEND_URL}/api/...`);
    // Start the 5-min dynamic-redirect refresher (12 May 2026 — wired so
    // the SEO autopilot's auto-fixed 404 redirects start serving without
    // needing a code deploy).
    startDynamicRedirectRefresher(BACKEND_URL);
    console.log('[server] Dynamic SEO redirect refresher started (5-min interval)');
    // Same pattern for SEO overrides (titles/descriptions/JSON-LD repairs)
    startOverrideRefresher(BACKEND_URL);
    console.log('[server] Dynamic SEO override refresher started (5-min interval)');
  }
});
