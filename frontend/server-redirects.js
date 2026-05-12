/**
 * Legacy URL → current URL 301 redirect map.
 *
 * Extracted from server.js for testability. Used by the Express
 * legacy-redirect middleware to issue real HTTP 301s for old Wix-style
 * URLs that Google Search Console flagged as "Page with redirect"
 * on 12 May 2026.
 *
 * Why server-side 301 (not client-side React Router Navigate):
 *   • Passes SEO link-juice from the old URL to the new one
 *   • Googlebot sees a real HTTP 301 instead of a client-side bounce,
 *     which it interprets as a proper move (not a soft redirect)
 *   • Stops GSC's "Page with redirect" warning permanently
 */

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
  const direct = LEGACY_301_MAP[lower];
  if (direct) return direct;
  for (const { test, to } of LEGACY_301_PATTERNS) {
    const m = pathOnly.match(test);
    if (m) return to(m);
  }
  return null;
}

module.exports = { LEGACY_301_MAP, LEGACY_301_PATTERNS, resolveLegacyRedirect };
