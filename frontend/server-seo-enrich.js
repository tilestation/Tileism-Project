/**
 * Dynamic SEO metadata enrichment.
 *
 * Layered on top of `server-seo.js`. For dynamic routes
 * (`/tiles/:slug`, `/products/:slug`, `/collections/:slug`) we fetch
 * the actual product/collection from the backend at request time and
 * use real data in the title + description. Slug-only fallback from
 * `server-seo.js` kicks in if the backend is slow or returns nothing.
 *
 * Performance
 * -----------
 *   • 5-minute in-memory LRU cache (capped at 1000 entries — every
 *     hot product hits cache after first crawl).
 *   • 250ms backend timeout — never block page render for crawlers.
 *   • Fallback to the static (slug-prettified) version on any error.
 *
 * Bonus: produces Schema.org `Product` JSON-LD for product pages so
 * Google can render Rich Results (price, availability, image).
 */
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL
  || process.env.BACKEND_URL
  || 'http://localhost:8001';
const SITE_URL = process.env.PUBLIC_SITE_URL || 'https://tilestation.co.uk';
const BRAND = 'Tile Station';
// 23 May 2026 — bumped from 250ms → 1500ms after Cloudflare was put in
// front of `tile-station-production.up.railway.app`. The CDN edge adds
// ~50-150ms of overhead to each backend call; with the old 250ms
// budget, /shop/product/<slug> requests timed out before the backend
// responded, lookupProduct() returned null, and JSON-LD was silently
// dropped from every PDP — the exact root cause of the SEO Self-Audit
// "Missing schema.org/Product" failure on ardesia-slate-white-30x60cm-
// matt. Googlebot waits 30s per page, so 1500ms is conservative and
// still far short of any real crawler timeout.
const FETCH_TIMEOUT_MS = parseInt(process.env.SEO_BACKEND_FETCH_TIMEOUT_MS || '1500', 10);
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 1000;

// Tiny LRU. Insertion order matters — when full we evict the oldest entry.
const cache = new Map();

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { cache.delete(key); return null; }
  // refresh recency
  cache.delete(key);
  cache.set(key, e);
  return e.value;
}
function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, exp: Date.now() + CACHE_TTL_MS });
}

function fetchJson(url) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { return resolve(null); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(parsed, { method: 'GET', timeout: FETCH_TIMEOUT_MS }, (res) => {
      // Don't chase redirects from the SPA proxy — if backend isn't
      // reachable directly, give up and fall back. Consumes the body
      // anyway so the socket can be released.
      if (res.statusCode && res.statusCode >= 300) {
        res.resume();
        return resolve(null);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve(body ? JSON.parse(body) : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Look up a product by slug (or supplier_code, or 24-char ObjectId).
 * Mirrors the backend's `/api/tiles/products` query that the storefront
 * uses, but limited to one row.
 */
async function lookupProduct(slug) {
  if (!slug) return null;
  const key = `prod:${slug}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  // Try the exact-slug endpoint first (fast path — single doc lookup
  // by indexed `slug` field). Falls back to ?search= if the slug isn't
  // recognised (e.g. the storefront uses a different identifier).
  const base = BACKEND_URL.replace(/\/$/, '');
  let row = await fetchJson(`${base}/api/tiles/products/${encodeURIComponent(slug)}`);
  if (!row || row.detail) {  // 404 returns {detail: "..."}
    const data = await fetchJson(`${base}/api/tiles/products?search=${encodeURIComponent(slug)}&limit=1`);
    const list = Array.isArray(data) ? data : (data && (data.products || data.items) || []);
    row = list.length > 0 ? list[0] : null;
  }
  // 23 May 2026 — only cache POSITIVE lookups. Caching `null` for 5
  // minutes meant a transient backend hiccup (or the old 250ms
  // timeout) would suppress JSON-LD on a hot product page for 5
  // minutes — exactly long enough for a Googlebot crawl to record
  // "no Product schema" against the URL. Negative misses just retry
  // next time.
  if (row) cacheSet(key, row);
  return row;
}

async function lookupCityPage(slug) {
  if (!slug) return null;
  const key = `city:${slug}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const base = BACKEND_URL.replace(/\/$/, '');
  // Public read endpoint. Returns full row with body_md, meta_*,
  // jsonld_local_business, jsonld_article, nearby_cities, related_collections.
  let row = await fetchJson(`${base}/api/shop/city-page/${encodeURIComponent(slug)}`);
  if (row && row.detail) row = null;
  cacheSet(key, row);
  return row;
}

function buildCityPageMeta(row, slug) {
  if (!row) return null;
  const title = (row.meta_title || row.headline || row.display_name || slug);
  const description = (row.meta_description || (row.body_md || '').slice(0, 200)).slice(0, 250);
  // Combine LocalBusiness + Article in a single graph block — Google
  // accepts an array of @types in one <script> for richer rendering.
  const graph = [];
  if (row.jsonld_local_business) graph.push(row.jsonld_local_business);
  if (row.jsonld_article) graph.push(row.jsonld_article);
  const jsonld = graph.length > 0 ? { '@context': 'https://schema.org', '@graph': graph } : undefined;
  // Stealth keywords on city pages — injected invisibly into <meta
  // keywords> + og:alt-names so local searches like "tiles gravesend"
  // that would never render visually still signal this page to Google.
  const rawKw = row.hidden_seo_keywords;
  let stealthKeywords;
  if (rawKw) {
    const list = Array.isArray(rawKw)
      ? rawKw
      : String(rawKw).split(/[,\n]+/);
    stealthKeywords = list
      .map((s) => (s == null ? '' : String(s)).trim())
      .filter((s) => s && s.length <= 80 && s.toLowerCase() !== title.toLowerCase())
      .slice(0, 25);
    if (stealthKeywords.length === 0) stealthKeywords = undefined;
  }
  const meta = { title, description, jsonld };
  if (stealthKeywords) meta.stealthKeywords = stealthKeywords;
  // ── SSR body content (8 Sep 2026 — national SEO push) ──
  // These are the programmatic town × intent pages that carry the
  // national-ranking strategy — but they're 100% client-fetched
  // (CityLandingPage.jsx does its own `fetch` after mount), so a
  // crawler that reads raw HTML previously saw NOTHING here — the
  // single biggest content gap vs a competitor with server-rendered
  // local pages. Render the actual `body_md` (LLM-written local copy)
  // plus the real nearby-city / related-collection internal links.
  const nearby = Array.isArray(row.nearby_cities) ? row.nearby_cities : [];
  const related = Array.isArray(row.related_collections) ? row.related_collections : [];
  const linkList = (items) => items
    .slice(0, 6)
    .map((i) => `<li><a href="${escapeHtmlText(i.url)}">${inlineMd(i.label)}</a></li>`)
    .join('');
  const townLabel = row.town || row.display_name || slug.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  meta.bodyContent = (
    `<nav aria-label="Breadcrumb"><a href="/">Home</a> &rsaquo; <a href="/tiles">Tiles</a> &rsaquo; <span>${inlineMd(townLabel)}</span></nav>` +
    `<h1>${inlineMd(row.h1 || title)}</h1>` +
    markdownToHtmlLite(row.body_md) +
    (nearby.length > 0 ? `<h2>Nearby areas we cover</h2><ul>${linkList(nearby)}</ul>` : '') +
    (related.length > 0 ? `<h2>Popular tile collections</h2><ul>${linkList(related)}</ul>` : '')
  );
  return meta;
}

async function lookupCollection(slug) {
  if (!slug) return null;
  const key = `coll:${slug}`;
  const hit = cacheGet(key);
  if (hit !== null) return hit;
  const base = BACKEND_URL.replace(/\/$/, '');
  const data = await fetchJson(`${base}/api/tiles/collections`);
  // 23 May 2026 — the endpoint historically returned a bare array, but
  // now wraps the list as `{ collections: [...], total, ... }`. Without
  // handling both shapes lookupCollection ALWAYS returned null and
  // collection PDPs shipped without our custom JSON-LD / og tags. Long-
  // standing silent SEO regression — uncovered when the audit's
  // Collection JSON-LD check failed.
  const list = Array.isArray(data)
    ? data
    : (data && Array.isArray(data.collections))
      ? data.collections
      : (data && Array.isArray(data.items))
        ? data.items
        : [];
  let row = null;
  if (list.length > 0) {
    const lower = slug.toLowerCase().replace(/[-_\s]+/g, '');
    row = list.find((c) => {
      const candidates = [c.slug, c.id, c.name, c.display_name, c.series_name].filter(Boolean);
      return candidates.some((s) => String(s).toLowerCase().replace(/[-_\s]+/g, '') === lower);
    }) || null;
  }
  // Enrich row with the first 10 products so buildCollectionMeta can
  // emit a populated ItemList JSON-LD (richer Google SERP cards).
  // Best-effort: failure is silent and we still get a CollectionPage
  // with metadata.
  if (row) {
    const seriesName = row.series_name || row.name || row.display_name;
    if (seriesName) {
      const prodResp = await fetchJson(
        `${base}/api/tiles/collection/${encodeURIComponent(seriesName)}?limit=10`
      );
      const productList = (prodResp && Array.isArray(prodResp.products))
        ? prodResp.products
        : Array.isArray(prodResp) ? prodResp : [];
      if (productList.length > 0) {
        row.products = productList.slice(0, 10).map((p) => ({
          slug: p.slug || p.url_slug || p.id,
          display_name: p.display_name || p.name,
        }));
      }
    }
  }
  cacheSet(key, row);
  return row;
}

async function lookupCollectionStealthKeywords(collectionKey) {
  // Read-only join from `seo_collection_keywords` for the SSR meta
  // injector. Failures fall back silently so we never block render.
  if (!collectionKey) return [];
  const cacheKey = `coll-stealth:${collectionKey.toLowerCase()}`;
  const hit = cacheGet(cacheKey);
  if (hit !== null) return hit;
  const base = BACKEND_URL.replace(/\/$/, '');
  const data = await fetchJson(
    `${base}/api/shop/seo/stealth-keywords/collection/${encodeURIComponent(collectionKey)}`
  );
  const keys = Array.isArray(data && data.keywords) ? data.keywords : [];
  cacheSet(cacheKey, keys);
  return keys;
}

// ─────────────────────────────────────────────────────────────────
// Tiny markdown → HTML for LLM-generated `body_md` (city pages). Only
// covers the handful of constructs the city-page generator actually
// produces (## headings, paragraphs, - bullet lists, **bold**) — not
// a general-purpose parser. Escapes raw HTML first so nothing injected
// by the LLM can break out of the SSR block.
function escapeHtmlText(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function inlineMd(s) {
  return escapeHtmlText(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
function markdownToHtmlLite(md) {
  if (!md) return '';
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let listOpen = false;
  const closeList = () => { if (listOpen) { out.push('</ul>'); listOpen = false; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { closeList(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      // Markdown level maps 1:1 to h2/h3/h4 — except a literal single
      // `#` (markdown h1) is bumped to h2 so it never collides with
      // the page's real <h1> (already rendered above this block).
      const hashLen = h[1].length;
      const level = hashLen === 1 ? 2 : Math.min(hashLen, 4);
      out.push(`<h${level}>${inlineMd(h[2])}</h${level}>`);
      continue;
    }
    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      if (!listOpen) { out.push('<ul>'); listOpen = true; }
      out.push(`<li>${inlineMd(li[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  closeList();
  return out.join('');
}

function buildProductMeta(product, slug) {
  if (!product) return null;
  const name = (product.display_name || product.name || product.our_name || slug).trim();
  const price = product.price_per_m2 || product.our_price || product.price;
  const material = product.material || product.category || product.collection || '';
  const sizeMatch = name.match(/\d+\s*[xX]\s*\d+/);
  const size = product.size || (sizeMatch ? sizeMatch[0] : '');
  // ── Title length (23 May 2026 fix) ──
  //
  // Google truncates SERP titles around 55-60 characters on desktop
  // and as little as 50 on mobile. The old logic concatenated
  //   "<name> · <material> · From £X/m² · Tile Station"
  // which routinely landed at 75-90 chars and showed in search results
  // as "Ardesia Slate White 30x60cm Matt · Porcelain · ...". The audit
  // flagged "title too long (76 chars, want 50-60)" weight 5.
  //
  // New strategy: name + brand fits ~95% of products under 60. Only
  // append the price/material if there's room. Final hard cap at 60
  // (a couple of chars under what Google truncates) so brand suffix
  // is always preserved.
  const brandSuffix = ` · ${BRAND}`;
  const TITLE_TARGET = 60;
  const availableForName = TITLE_TARGET - brandSuffix.length;
  let titleBody = name;
  if (titleBody.length > availableForName) {
    titleBody = titleBody.slice(0, availableForName - 1).trimEnd() + '…';
  } else {
    // Plenty of room — try to enrich with material/price *only* if it
    // fits without breaking the 60-char target.
    const extras = [];
    if (material && !name.toLowerCase().includes(material.toLowerCase())) extras.push(material);
    if (price) extras.push(`£${Number(price).toFixed(2)}/m²`);
    for (const ex of extras) {
      const candidate = `${titleBody} · ${ex}`;
      if ((candidate + brandSuffix).length <= TITLE_TARGET) {
        titleBody = candidate;
      } else {
        break;
      }
    }
  }
  const title = `${titleBody}${brandSuffix}`;
  const descParts = [
    `Buy ${name} at ${BRAND}.`,
    material ? `${material} tile${size ? ' ' + size : ''}.` : '',
    price ? `From £${Number(price).toFixed(2)}/m².` : '',
    'Free UK samples, trade pricing, fast delivery.',
  ].filter(Boolean);
  const description = descParts.join(' ').slice(0, 250);

  // ── Stealth keywords (supplier-original product names like "Opal",
  //    "LP-6611", "Onyx White") that we want indexable but invisible
  //    on the rendered page. The backend ships them via two fields:
  //    `hidden_seo_keywords` (comma-separated string) and
  //    `original_name` (single canonical supplier name). We also
  //    accept `seo_keywords` for backwards compatibility.
  const stealthSources = [
    product.hidden_seo_keywords,
    product.original_name,
    product.seo_keywords,
  ];
  const stealthSet = new Set();
  for (const src of stealthSources) {
    if (!src) continue;
    const items = (typeof src === 'string'
      ? src.split(/[,\n]+/)
      : Array.isArray(src) ? src : [String(src)]);
    for (const raw of items) {
      const s = (raw || '').trim();
      if (!s || s.length > 80) continue;
      if (s.toLowerCase() === name.toLowerCase()) continue;  // dedupe vs the customer-facing name
      stealthSet.add(s);
    }
  }
  const stealthKeywords = [...stealthSet].slice(0, 25);

  // Schema.org Product JSON-LD for rich results
  const images = (Array.isArray(product.images) ? product.images : [])
    .map((i) => (typeof i === 'string' ? i : (i && i.url) || ''))
    .filter(Boolean);
  const jsonld = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name,
    description,
    sku: product.supplier_code || product.id,
    image: images.length > 0 ? images : undefined,
    brand: { '@type': 'Brand', name: BRAND },
    // alternateName + keywords carry the supplier-original names so
    // Google indexes "Opal" → our /tiles/artisan-marble-50x50 listing
    // without ever rendering "Opal" on the visible page.
    alternateName: stealthKeywords.length > 0 ? stealthKeywords : undefined,
    keywords: stealthKeywords.length > 0 ? stealthKeywords.join(', ') : undefined,
    offers: price ? {
      '@type': 'Offer',
      priceCurrency: 'GBP',
      price: Number(price).toFixed(2),
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        unitCode: 'MTK',  // ISO unit code for square metre
        price: Number(price).toFixed(2),
        priceCurrency: 'GBP',
      },
      availability: 'https://schema.org/InStock',
      url: `${SITE_URL}/tiles/${slug}`,
    } : undefined,
  };
  // ── SSR body content (8 Sep 2026 — national SEO push) ──
  // Previously the pre-hydration HTML only ever showed a generic
  // title + description + nav links, even though enrichSeo already
  // has the real price/material/size/description/stock for this
  // product. Crawlers that don't wait for the React bundle (or that
  // time out first-pass rendering) saw a thin page regardless of how
  // rich the actual PDP is — a real content-depth disadvantage vs a
  // competitor whose category/product pages are indexed with full text.
  // This renders a proper breadcrumb + spec list + long description in
  // the same off-screen block injectMeta already uses.
  const finish = product.finish || '';
  const color = product.color || product.colour || '';
  const inStock = product.in_stock !== false;
  const longDesc = product.description || product.short_description || description;
  const specs = [
    material ? `Material: ${material}` : '',
    size ? `Size: ${size}` : '',
    finish ? `Finish: ${finish}` : '',
    color ? `Colour: ${color}` : '',
    price ? `Price: £${Number(price).toFixed(2)} per m²` : '',
    `Availability: ${inStock ? 'In stock' : 'Out of stock'}`,
  ].filter(Boolean);
  const bodyContent = (
    `<nav aria-label="Breadcrumb"><a href="/">Home</a> &rsaquo; <a href="/tiles">Tiles</a>` +
    (material ? ` &rsaquo; <a href="/tiles?material=${encodeURIComponent(material)}">${inlineMd(material)}</a>` : '') +
    ` &rsaquo; <span>${inlineMd(name)}</span></nav>` +
    `<h1>${inlineMd(name)}</h1>` +
    `<p>${inlineMd(longDesc)}</p>` +
    (specs.length > 0 ? `<ul>${specs.map((s) => `<li>${inlineMd(s)}</li>`).join('')}</ul>` : '')
  );

  return { title, description, jsonld, stealthKeywords, bodyContent, product: {
    name,
    price: price ? Number(price).toFixed(2) : null,
    currency: 'GBP',
    availability: inStock ? 'in stock' : 'out of stock',
    image: images.length > 0 ? images[0] : null,
    images,
    brand: BRAND,
    sku: product.supplier_code || product.id || '',
    retailerItemId: product.supplier_code || product.id || '',
  }};
}

function buildCollectionMeta(collection, slug, stealthKeywords = []) {
  if (!collection) return null;
  const name = (collection.display_name || collection.name || collection.series_name || slug).trim();
  const productCount = collection.product_count || collection.count;
  // ── Title length (23 May 2026) ──
  // Same 60-char Google SERP target as PDPs. Brand suffix always
  // preserved; collection-name truncated with ellipsis if needed.
  const brandSuffix = ` · ${BRAND}`;
  const TITLE_TARGET = 60;
  const baseLabel = `${name} Tile Collection`;
  const availableForBody = TITLE_TARGET - brandSuffix.length;
  let titleBody = baseLabel;
  if (titleBody.length > availableForBody) {
    titleBody = titleBody.slice(0, availableForBody - 1).trimEnd() + '…';
  } else if (productCount) {
    const candidate = `${baseLabel} · ${productCount} Tiles`;
    if ((candidate + brandSuffix).length <= TITLE_TARGET) {
      titleBody = candidate;
    }
  }
  const title = `${titleBody}${brandSuffix}`;
  const description = [
    `Explore the ${name} tile collection at ${BRAND}.`,
    productCount ? `${productCount} curated tiles.` : '',
    'Free UK samples, trade pricing, fast delivery.',
  ].filter(Boolean).join(' ').slice(0, 250);
  const cleaned = (Array.isArray(stealthKeywords) ? stealthKeywords : [])
    .map((s) => (s == null ? '' : String(s)).trim())
    .filter((s) => s && s.length <= 80 && s.toLowerCase() !== name.toLowerCase());
  // ── CollectionPage + ItemList JSON-LD (23 May 2026 fix) ──
  //
  // The SEO audit "Collection JSON-LD" check (weight 6) was failing
  // because buildCollectionMeta didn't emit any structured data.
  // CollectionPage tells Google this URL groups multiple products,
  // and the embedded ItemList enumerates the products inside (Google
  // uses the first ~5 to render rich "products in this collection"
  // cards on SERPs).
  //
  // We only include the first 10 product slugs because:
  //   1. The audit only requires schema PRESENCE, not exhaustive enumeration.
  //   2. Larger ItemList blocks bloat the HTML and slow first paint.
  //   3. Google's docs cap useful ItemList depth around 10-15 entries
  //      for "products in collection" rich results.
  const products = Array.isArray(collection.products)
    ? collection.products
    : Array.isArray(collection.items)
      ? collection.items
      : [];
  const itemListElement = products
    .slice(0, 10)
    .map((p, idx) => {
      const pSlug = p?.slug || p?.url_slug || p?.id;
      if (!pSlug) return null;
      const pName = p?.display_name || p?.name || pSlug;
      return {
        '@type': 'ListItem',
        position: idx + 1,
        name: pName,
        url: `${SITE_URL.replace(/\/$/, '')}/shop/product/${pSlug}`,
      };
    })
    .filter(Boolean);
  const jsonld = {
    '@context': 'https://schema.org/',
    '@type': 'CollectionPage',
    name: `${name} Tile Collection`,
    description,
    url: `${SITE_URL.replace(/\/$/, '')}/shop/collection/${encodeURIComponent(slug)}`,
    isPartOf: {
      '@type': 'WebSite',
      name: BRAND,
      url: SITE_URL,
    },
  };
  if (itemListElement.length > 0) {
    jsonld.mainEntity = {
      '@type': 'ItemList',
      numberOfItems: productCount || itemListElement.length,
      itemListElement,
    };
  }
  const meta = { title, description, jsonld };
  if (cleaned.length > 0) meta.stealthKeywords = cleaned.slice(0, 25);
  // ── SSR body content (8 Sep 2026 — national SEO push) ──
  // Breadcrumb + intro paragraph + real links to the first 10 products
  // in the collection (already fetched above for the ItemList JSON-LD).
  // Gives crawlers actual outgoing links + readable text before React
  // mounts, instead of only the generic nav strip.
  const prodLinks = products
    .slice(0, 10)
    .map((p) => {
      const pSlug = p?.slug || p?.url_slug || p?.id;
      if (!pSlug) return '';
      const pName = p?.display_name || p?.name || pSlug;
      return `<li><a href="/shop/product/${encodeURIComponent(pSlug)}">${inlineMd(pName)}</a></li>`;
    })
    .filter(Boolean)
    .join('');
  meta.bodyContent = (
    `<nav aria-label="Breadcrumb"><a href="/">Home</a> &rsaquo; <a href="/tiles">Tiles</a> &rsaquo; <a href="/collections">Collections</a> &rsaquo; <span>${inlineMd(name)}</span></nav>` +
    `<h1>${inlineMd(name)} Collection</h1>` +
    `<p>${inlineMd(description)}</p>` +
    (prodLinks ? `<h2>Products in this collection</h2><ul>${prodLinks}</ul>` : '')
  );
  return meta;
}

/**
 * Async enrichment over the static `resolveSeo` baseline. Always
 * returns a meta object — never throws — so callers can use it
 * directly. Falls back to baseline silently on any error.
 */
async function enrichSeo(rawPath, baseline) {
  if (!baseline) return baseline;
  try {
    const pathname = (rawPath || '/').split(/[?#]/)[0] || '/';
    const normalised = pathname.replace(/\/+$/, '') || '/';

    // /tiles/:slug is a SHARED namespace — the frontend router
    // (TileProductRedirect.js) checks city-landing-pages FIRST, then
    // falls back to a real product. 8 Sep 2026 fix: this enrichment
    // was checking PRODUCT first, so every city page (the whole
    // national-ranking strategy — tile-shop-<town>, kitchen-tiles-
    // <town> etc, all served at /tiles/<slug>) fell through
    // lookupProduct (miss) → buildProductMeta returns null → then
    // NEITHER the collection nor the old city-page regex below ever
    // matched `/tiles/<slug>` (that regex only matched `/tile-shop/…`
    // with a literal extra slash, or single-segment paths with no
    // slash at all). Net effect: hundreds of city pages were served
    // with zero real SSR content — the exact soft-404/thin-content
    // risk this whole SSR layer exists to prevent. Mirror the
    // frontend's precedence here.
    let m = normalised.match(/^\/(?:tiles|products)\/([^/?#]+)\/?$/);
    if (m) {
      const cityRow = await lookupCityPage(m[1]);
      const cityReal = buildCityPageMeta(cityRow, m[1]);
      if (cityReal) {
        return { ...baseline, ...cityReal };
      }
      const product = await lookupProduct(m[1]);
      const real = buildProductMeta(product, m[1]);
      if (real) {
        return { ...baseline, ...real };
      }
    }
    // Product detail
    // Storefront uses /shop/product/<slug> as the canonical PDP URL.
    m = normalised.match(/^\/shop\/product\/([^/?#]+)\/?$/);
    if (m) {
      const product = await lookupProduct(m[1]);
      const real = buildProductMeta(product, m[1]);
      if (real) {
        return { ...baseline, ...real };
      }
    }
    // Collection
    // Storefront uses /shop/collection/<name>. /collections/<slug>
    // retained for legacy.
    m = normalised.match(/^\/shop\/collection\/([^/?#]+)\/?$/)
        || normalised.match(/^\/collections\/([^/?#]+)\/?$/);
    if (m) {
      const coll = await lookupCollection(m[1]);
      // Look the keyword set up by every plausible identifier — admin
      // saved the keys against either `series_name`, `name`, or
      // `display_name` so we try each in order until one matches.
      let stealthKeys = [];
      if (coll) {
        const candidates = [coll.series_name, coll.name, coll.display_name, m[1]]
          .filter(Boolean)
          .map((s) => String(s));
        const seen = new Set();
        for (const cand of candidates) {
          if (seen.has(cand.toLowerCase())) continue;
          seen.add(cand.toLowerCase());
          const found = await lookupCollectionStealthKeywords(cand);
          if (found && found.length > 0) {
            stealthKeys = found;
            break;
          }
        }
      }
      const real = buildCollectionMeta(coll, m[1], stealthKeys);
      if (real) {
        return { ...baseline, ...real };
      }
    }
    // City landing pages — match the slugs the autogen generates
    // (`tile-shop-near-me-london`, `tile-shop-london`, `installer-london`)
    // and any other arbitrary path that's been seeded as a city page.
    if (
      /^\/(?:tile-shop|tile-shop-near-me|tile-shops?|installer|tile-installer|tilers)\//.test(normalised)
      || /^\/[a-z0-9-]{3,}$/.test(normalised)  // single-segment paths fallback
    ) {
      const slug = normalised.replace(/^\//, '');
      const row = await lookupCityPage(slug);
      const real = buildCityPageMeta(row, slug);
      if (real) {
        return { ...baseline, ...real };
      }
    }
  } catch (e) {
    // Never fail — just return the slug-prettified baseline
  }
  return baseline;
}

module.exports = { enrichSeo, lookupProduct, lookupCollection, lookupCityPage,
                   lookupCollectionStealthKeywords,
                   buildProductMeta, buildCollectionMeta, buildCityPageMeta };
