/**
 * Legacy URL → current URL 301 redirect map.
 *
 * TWO sources of truth, merged in this order:
 *   1. STATIC (defined below) — hard-coded legacy Wix-style URLs.
 *      Survives Railway redeploys, no DB dependency.
 *   2. DYNAMIC (from <BACKEND_URL>/api/seo/redirects) — refreshed every
 *      5 minutes. Populated by the SEO Self-Crawler + 404 Autopilot
 *      backend services. When a 404 hits and the autopilot finds a
 *      sensible target, the redirect appears here within 5 minutes —
 *      no deploy needed.
 *
 * Why server-side 301 (not client-side React Router Navigate):
 *   • Passes SEO link-juice from the old URL to the new one
 *   • Googlebot sees a real HTTP 301 instead of a client-side bounce,
 *     which it interprets as a proper move (not a soft redirect)
 *   • Stops GSC's "Page with redirect" warning permanently
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

const LEGACY_301_MAP = {
  // Old Wix product pages → new collection URL
  '/product-page/hartley-collection': '/shop/collection/Hartley',

  // /shop → /tiles (the actual shop listing page)
  '/shop': '/tiles',
  '/shop/': '/tiles',

  // /shop/reviews never existed as a route — point at the testimonials
  // page hosted under /shop/info
  '/shop/reviews': '/shop/info/reviews',
  '/shop/reviews/': '/shop/info/reviews',

  // Order tracking — multiple legacy paths
  '/shop/track-order': '/shop/track',
  '/shop/track-order/': '/shop/track',
  '/track': '/shop/track',
  '/track/': '/shop/track',
  '/track-order': '/shop/track',
  '/track-order/': '/shop/track',

  // /bathroom (root) → /shop/bathroom (the real route)
  '/bathroom': '/shop/bathroom',
  '/bathroom/': '/shop/bathroom',

  // ──────────────────────────────────────────────────────────────
  // 24 May 2026 — Phantom info-page URLs. SSR was injecting full
  // SEO meta tags for these top-level paths (so Google indexed them
  // and even used "About Tile Station" as a Business Profile
  // sitelink), but the React SPA had no client-side routes — real
  // users hit the SPA's NotFound fallback. Real HTTP 301s here:
  //   • Removes the "Page with redirect" warning from GSC
  //   • Tells Google to consolidate ranking onto the canonical
  //     /shop/info/:slug URL
  //   • Stops broken sitelinks the instant the redirect is live
  '/about': '/shop/info/about',
  '/about/': '/shop/info/about',
  '/contact': '/shop/contact',
  '/contact/': '/shop/contact',
  '/faq': '/shop/info/faq',
  '/faq/': '/shop/info/faq',
  '/delivery': '/shop/info/delivery',
  '/delivery/': '/shop/info/delivery',
  '/returns': '/shop/info/returns',
  '/returns/': '/shop/info/returns',
  '/privacy': '/shop/info/privacy',
  '/privacy/': '/shop/info/privacy',
  '/terms': '/shop/info/terms',
  '/terms/': '/shop/info/terms',
  '/reviews': '/shop/info/reviews',
  '/reviews/': '/shop/info/reviews',
};

const LEGACY_301_PATTERNS = [
  // /category/<material>-tiles → /tiles?<filter>
  {
    test: /^\/category\/([a-z0-9-]+)-tiles\/?$/i,
    to: (m) => {
      const slug = m[1].toLowerCase();
      const filterMap = {
        ceramic: 'material=ceramic',
        porcelain: 'material=porcelain',
        marble: 'material=marble',
        stone: 'material=stone',
        natural: 'material=stone',
        spanish: 'origin=spain',
        polish: 'finish=polished',
        polished: 'finish=polished',
        metro: 'shape=metro',
        mosaic: 'shape=mosaic',
        wood: 'effect=wood',
        'wood-effect': 'effect=wood',
        concrete: 'effect=concrete',
        terrazzo: 'effect=terrazzo',
      };
      return `/tiles?${filterMap[slug] || 'category=' + slug}`;
    },
  },
  // /category/* (any other) → /tiles
  { test: /^\/category(\/.*)?$/i, to: () => '/tiles' },
  // Double /shop/ scraper pattern — first map /shop/.../shop/track
  // to /shop/track, then collapse remaining double-shop URLs to /tiles
  { test: /^\/shop\/.*\/shop\/track\/?$/i, to: () => '/shop/track' },
  { test: /^\/shop\/.*\/shop\/.+\/?$/i, to: () => '/tiles' },
];

/**
 * Resolve a legacy path to its current 301 target.
 * Returns null when no redirect applies (caller should fall through
 * to the SPA fallback).
 */
function resolveLegacyRedirect(pathOnly) {
  // Literal map first — O(1) lookup. Case-insensitive on the LHS so that
  // Googlebot-style mixed-case crawls (/SHOP, /Bathroom) still hit, but
  // the redirect TARGET stays exactly as defined in the map.
  const lower = (pathOnly || '').toLowerCase();

  // 1. Dynamic redirects (from DB) — highest priority, ALWAYS fresh.
  const dyn = DYNAMIC_REDIRECTS[pathOnly] || DYNAMIC_REDIRECTS[lower];
  if (dyn) return dyn;

  // 2. Static legacy map
  const direct = LEGACY_301_MAP[lower];
  if (direct) return direct;

  // 3. Pattern matches
  for (const { test, to } of LEGACY_301_PATTERNS) {
    const m = pathOnly.match(test);
    if (m) return to(m);
  }
  return null;
}


// ─────────────────────────────────────────────────────────────────────
// Dynamic redirects — refreshed every 5 min from <BACKEND_URL>/api/seo/redirects
// Populated at process boot, then on a 5-min interval. Never blocks
// request handling — if the fetch fails we simply keep using the last
// good snapshot (or the static map if we've never had one).
// ─────────────────────────────────────────────────────────────────────
let DYNAMIC_REDIRECTS = {};
let DYNAMIC_LAST_UPDATED = null;

function _fetchJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method: 'GET',
      timeout: timeoutMs,
      headers: { 'User-Agent': 'TileStation-SSR/1.0', 'Accept': 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

async function refreshDynamicRedirects(backendUrl) {
  if (!backendUrl) return { ok: false, reason: 'no_backend_url' };
  try {
    const payload = await _fetchJson(`${backendUrl.replace(/\/$/, '')}/api/seo/redirects`);
    const map = (payload && payload.redirects) || {};
    if (typeof map !== 'object' || Array.isArray(map)) {
      throw new Error('bad payload shape');
    }
    DYNAMIC_REDIRECTS = map;
    DYNAMIC_LAST_UPDATED = new Date();
    return { ok: true, count: Object.keys(map).length };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

function startDynamicRedirectRefresher(backendUrl, intervalMs = 5 * 60 * 1000) {
  if (!backendUrl) return null;
  // Initial fetch, fire-and-forget
  refreshDynamicRedirects(backendUrl).then((res) => {
    if (res.ok) {
      // eslint-disable-next-line no-console
      console.log(`[seo-redirects] initial fetch OK: ${res.count} dynamic redirects loaded`);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[seo-redirects] initial fetch FAILED: ${res.reason}`);
    }
  }).catch(() => {});
  // Recurring refresh
  const handle = setInterval(() => {
    refreshDynamicRedirects(backendUrl).catch(() => {});
  }, intervalMs);
  // Don't block process exit on the timer
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}

function _setDynamicRedirectsForTest(map) {
  // Only used by server-redirects.test.js
  DYNAMIC_REDIRECTS = map || {};
}

module.exports = {
  LEGACY_301_MAP, LEGACY_301_PATTERNS, resolveLegacyRedirect,
  refreshDynamicRedirects, startDynamicRedirectRefresher,
  _setDynamicRedirectsForTest,
};
