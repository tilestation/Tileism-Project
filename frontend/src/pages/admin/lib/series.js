/**
 * Series grouping helper — one source of truth used by:
 *   - /admin/supplier-products (SupplierProducts.js)
 *   - /admin/materials, /admin/tiles, /admin/flooring, /admin/bathroom,
 *     /admin/underfloor-heating, /admin/tools, /admin/custom-manager/*
 *     (all via ManagerPageShell)
 *
 * A "clean" series name is a short label like "Dolomite Onyx" or
 * "Ultra Tile Cleaning & Maintenance". Historical Canopy imports have
 * dumped full product names into series-carrying fields; we filter those
 * out so a row doesn't end up in its own singleton bucket.
 *
 * The name-parsing fallback strips descriptor words (colours, finishes,
 * sizes) so a product like "Grigio Polished 60x60cm Wall Tile" reduces
 * to the "Grigio" series (or better, its multi-word prefix).
 */

// Words that describe COLOUR — usually appear at the end of a product name
// as a modifier. Stripped from the tail during series parsing so "Dolomite
// Onyx White" and "Dolomite Onyx Grey" collapse into the same "Dolomite Onyx"
// series bucket.
export const SERIES_COLOR_WORDS = new Set([
  'white','grey','gray','black','beige','cream','brown','blue','green',
  'red','pink','yellow','orange','purple','silver','gold','ivory',
  'charcoal','anthracite','taupe','sand','bone','pearl','light','dark',
  'crema','bianco','grigio','nero','avorio','noce','cenere','pietra',
  'polvere','verde','rosa','marfil',
  'blanco','gris','perla','ceniza','grafito','hueso','arena',
  'marengo','roble','terra','acacia','arce','nuez',
  'decor','feature','border','listello',
  'brilliant','bright','jet','royal','midnight','pale','deep','ultra',
  'sky','ocean','aqua','teal','azure','cobalt','turquoise','indigo','denim','navy','jean',
  'sage','olive','emerald','mint','forest','moss',
  'coral','salmon','blush','rose','orchid','magenta',
  'burgundy','maroon','garnet','bordeaux','ruby','wine','claret',
  'rust','terracotta','copper','bronze','brass','amber','honey','caramel',
  'walnut','chocolate','coffee','mocha','tobacco','cinnamon','chestnut',
  'smoke','ash','graphite','slate','onyx','ice','snow','carbon',
  'smoky','greige','platinum','titanium','pewter','lead',
  'violet','lilac','lavender','mauve','lemon',
  'pigment','leaf','romantic','storm','pepper','blonde','golden',
  'warm','cool','soft','fumes','lawa','thunder',
  'breccia','carrara','natural','stone','earth','clay',
  'alga','invisible','sugar','brillo','antrecide',
  'blu',
]);

// Words that describe FINISH / SURFACE / SHAPE / MATERIAL — stripped from
// anywhere in the name during series parsing so they don't fragment groups.
export const SERIES_ATTRIBUTE_WORDS = new Set([
  'outdoor','indoor','external','internal','anti-slip','antislip',
  'rectified','unrectified','honed','lappato','lapato','structured',
  'polished','matt','matte','gloss','glossy','satin','silk','rustic',
  'linear','plain','scored','textured','embossed','riven','tumbled',
  'brushed','glazed','unglazed','smooth','flamed','hammered','bush-hammered',
  'oiled','lacquered','whitewashed','smoked','unfinished','sanded',
  'carving','high-gloss','semi','waxed','primed','brillo','mate',
  'savage','garden','mosaic','patchwork','stripe','chevron','herringbone',
  'hexagon','split','face','endless','deluxe','lounge','unique',
  'square','flat','bumpy','bevelled','round',
  'tiles','tile','wall','floor','and','slabs','slab',
  'effect','marble','wood','concrete','ceramic','metro',
  'quarry','travertine','terrazzo','porcelain','patterned',
  'laminate','engineered','lvt','plank','straight',
]);

// Reject values that are clearly product names, not series labels.
export const looksLikeCleanSeriesName = (v) => {
  if (!v) return false;
  const s = String(v).trim();
  if (!s) return false;
  if (s.length > 60) return false;                       // too long — likely a product name
  if (s.includes(' - ')) return false;                   // subtitled — e.g. "SKU - Name"
  if (/\d{2,}\s*(x|cm|mm|kg|l|g)\b/i.test(s)) return false; // dimension token anywhere
  if (/^\s*\d+\s*x\s*\d+/i.test(s)) return false;        // starts with dimension like "800x800 …"
  // Count real word tokens (ignore single-char connectors like "&"). A series
  // label is usually 1–4 words; more than that is almost always a product name.
  const wordTokens = s.split(/\s+/).filter(t => t.length > 1);
  if (wordTokens.length >= 6) return false;
  return true;
};

// Normalise a word for lookup (lowercase + strip diacritics).
const nw = (w) => w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Smart series-name parser from a raw product name string.
 *
 *   "Dolomite Onyx Grey Polished 60x60cm"        → "Dolomite Onyx"
 *   "Ultra Tile ProClean Cleaner 1L"             → "Ultra Tile ProClean Cleaner"
 *   "SKU12345 - Some Long Product Name"          → "SKU12345"          (dash-prefix pattern)
 *   "Decor25x60cm"                               → "Decor"             (concatenated tokens)
 *
 * Behaviour: keep prefix words; break on the first dimension token; strip
 * attribute words anywhere; strip trailing colour words. Falls back gracefully
 * to first-word Title Case for pathological inputs.
 */
export const getSeriesNameFromString = (productName) => {
  if (!productName) return '';
  const raw = String(productName).trim();
  if (!raw) return '';

  // Dash-prefix pattern: "SKU - Longer Name" → keep the SKU portion.
  if (raw.includes(' - ')) {
    const prefix = raw.split(' - ')[0].trim();
    if (prefix) return prefix;
  }

  // Pre-process: split concatenated word+dimension tokens like
  // "Decor25x60cm" into "Decor" + "25x60cm" so the dimension gets stripped
  // and the word survives.
  const rawParts = raw.split(/\s+/);
  const parts = [];
  for (const p of rawParts) {
    const m = p.match(/^([A-Za-z]+)(\d+(?:\.\d+)?[xX]\d+.*)$/);
    if (m) { parts.push(m[1]); parts.push(m[2]); }
    else parts.push(p);
  }

  // Walk left-to-right: break on the first dimension token; skip mm-only
  // tokens; skip descriptor attribute words entirely.
  const sp = [];
  for (const p of parts) {
    if (/^\d+(\.\d+)?[xX]\d+/.test(p)) break;
    if (/^\d+mm$/i.test(p)) continue;
    if (SERIES_ATTRIBUTE_WORDS.has(nw(p))) continue;
    sp.push(p);
  }

  if (sp.length === 0) return '';  // Everything stripped — send to Individual bucket, not a garbage series.
  // Trailing colour words don't belong in the series label.
  while (sp.length > 0 && SERIES_COLOR_WORDS.has(nw(sp[sp.length - 1]))) sp.pop();

  if (sp.length === 0) return '';  // Colour-only labels → Individual bucket.
  // Final safety: if the resulting label doesn't look clean itself, drop it.
  const candidate = sp.join(' ');
  if (!looksLikeCleanSeriesName(candidate)) return '';
  return candidate;
};

/**
 * Resolve the effective series name for a product object OR raw string.
 * Priority (each filtered by looksLikeCleanSeriesName except the fallback):
 *   1. range_name       (explicit admin assignment — Auto-Assign / Bulk Set Series)
 *   2. series           (canonical field the API returns)
 *   3. series_name      (legacy alias)
 *   4. original_series  (LOW priority — on Verona/Canopy rows this holds the
 *                        ORIGINAL SUPPLIER PRODUCT NAME, never overwritten)
 *   5. unique_name      (older Canopy-imports store the range here)
 *   6. fallback: smart parse of the display name
 */
export const getSeriesName = (productOrName) => {
  if (productOrName && typeof productOrName === 'object') {
    for (const k of ['range_name', 'series', 'series_name', 'original_series', 'unique_name']) {
      const v = productOrName[k];
      if (looksLikeCleanSeriesName(v)) return String(v).trim();
    }
    return getSeriesNameFromString(
      productOrName.our_product_name ||
      productOrName.display_name ||
      productOrName.name ||
      productOrName.product_name ||
      ''
    );
  }
  return getSeriesNameFromString(productOrName);
};

/**
 * Group an array of product objects by series. Returns an array of buckets
 * in stable order (first-seen), each bucket:
 *   { series: 'Dolomite Onyx', products: [ ... ] }
 * Products with no clean series land in a final bucket labelled 'Individual'.
 */
export const groupBySeries = (products) => {
  const buckets = new Map();
  const individuals = [];
  for (const p of products || []) {
    const s = getSeriesName(p);
    if (!s) {
      individuals.push(p);
      continue;
    }
    if (!buckets.has(s)) buckets.set(s, []);
    buckets.get(s).push(p);
  }
  const out = [];
  for (const [series, ps] of buckets.entries()) {
    out.push({ series, products: ps });
  }
  if (individuals.length > 0) out.push({ series: 'Individual', products: individuals });
  return out;
};
