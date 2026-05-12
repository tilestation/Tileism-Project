/**
 * Dynamic SEO Overrides — server-side companion to seo_overrides DB.
 *
 * Why this exists
 * ────────────────
 * server-seo.js has STATIC rules for every known route shape:
 *   EXACT[path]          (e.g. "/contact")
 *   PREFIXES[regex]      (e.g. /^\/shop\/collection\/(.+)$/)
 *   FALLBACK             (brand-only — last resort)
 *
 * The SEO Self-Crawler + Auto-Fixer find URLs where EVEN the static
 * rules produce a bad result (duplicate titles across two unrelated
 * URLs, fallback title triggered, missing JSON-LD on a thin page).
 * Auto-Fixer writes a per-URL override to `db.seo_overrides`.
 *
 * THIS module polls /api/seo/overrides every 5 minutes and exposes the
 * latest snapshot via `getOverrideForPath(path)`. server-seo.js merges
 * the override on top of the resolved baseline so titles / descriptions
 * / canonicals / JSON-LD can be repaired live without a deploy.
 *
 * Failure modes
 * ─────────────
 *   - Backend unreachable → keep using the last known map (graceful)
 *   - Bad payload → skip update (graceful)
 *   - First fetch fails → return empty map (no overrides, falls through
 *     to baseline)
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');

let OVERRIDES = {};
let NOINDEX_PATHS = new Set();
let LAST_UPDATED = null;

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

async function refreshOverrides(backendUrl) {
  if (!backendUrl) return { ok: false, reason: 'no_backend_url' };
  try {
    const payload = await _fetchJson(`${backendUrl.replace(/\/$/, '')}/api/seo/overrides`);
    const ov = (payload && payload.overrides) || {};
    if (typeof ov !== 'object' || Array.isArray(ov)) {
      throw new Error('bad payload shape');
    }
    OVERRIDES = ov;
    NOINDEX_PATHS = new Set(Array.isArray(payload.noindex_paths) ? payload.noindex_paths : []);
    LAST_UPDATED = new Date();
    return { ok: true, count: Object.keys(ov).length, noindex: NOINDEX_PATHS.size };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

function startOverrideRefresher(backendUrl, intervalMs = 5 * 60 * 1000) {
  if (!backendUrl) return null;
  refreshOverrides(backendUrl).then((res) => {
    if (res.ok) {
      // eslint-disable-next-line no-console
      console.log(`[seo-overrides] initial fetch OK: ${res.count} overrides, ${res.noindex} noindex paths`);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[seo-overrides] initial fetch FAILED: ${res.reason}`);
    }
  }).catch(() => {});
  const handle = setInterval(() => {
    refreshOverrides(backendUrl).catch(() => {});
  }, intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  return handle;
}

function getOverrideForPath(path) {
  if (!path) return null;
  // Try exact match first, then lowercase (Googlebot mixed-case
  // crawls). Path-with-trailing-slash treated equivalent to without.
  return (
    OVERRIDES[path]
    || OVERRIDES[(path || '').toLowerCase()]
    || OVERRIDES[path.replace(/\/$/, '')]
    || OVERRIDES[(path.replace(/\/$/, '') || '').toLowerCase()]
    || null
  );
}

function isNoindexPath(path) {
  if (!path) return false;
  return NOINDEX_PATHS.has(path) || NOINDEX_PATHS.has((path || '').toLowerCase());
}

// Test helpers
function _setOverridesForTest(map) {
  OVERRIDES = map || {};
}
function _setNoindexForTest(paths) {
  NOINDEX_PATHS = new Set(paths || []);
}

module.exports = {
  refreshOverrides, startOverrideRefresher,
  getOverrideForPath, isNoindexPath,
  _setOverridesForTest, _setNoindexForTest,
};
