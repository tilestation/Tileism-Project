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
 */

// Reject values that are clearly product names, not series labels.
export const looksLikeCleanSeriesName = (v) => {
  if (!v) return false;
  const s = String(v).trim();
  if (!s) return false;
  if (s.length > 60) return false;                       // too long — likely a product name
  if (s.includes(' - ')) return false;                   // subtitled — e.g. "SKU - Name"
  if (/\d{2,}\s*(x|cm|mm|kg|l|g)\b/i.test(s)) return false; // dimension token
  return true;
};

// Parse a series name from a raw product name string (first word, Title Case).
const parseFromName = (name) => {
  if (!name) return '';
  const s = String(name).trim();
  if (!s) return '';
  const first = (s.split(/\s+/)[0] || '').replace(/[^a-zA-Z0-9]/g, '');
  if (!first) return '';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
};

/**
 * Resolve the effective series name for a product object OR raw string.
 * Priority (each filtered by looksLikeCleanSeriesName except the fallback):
 *   1. original_series  (admin manual override, if clean)
 *   2. range_name       (Auto-Assign / Bulk Set Series audit field)
 *   3. series           (canonical field the API returns)
 *   4. series_name      (legacy alias)
 *   5. unique_name      (older Canopy-imports store the range here)
 *   6. fallback: parse first word of the product display name
 */
export const getSeriesName = (productOrName) => {
  if (productOrName && typeof productOrName === 'object') {
    if (looksLikeCleanSeriesName(productOrName.original_series)) {
      return String(productOrName.original_series).trim();
    }
    for (const k of ['range_name', 'series', 'series_name', 'unique_name']) {
      const v = productOrName[k];
      if (looksLikeCleanSeriesName(v)) return String(v).trim();
    }
    return parseFromName(
      productOrName.our_product_name ||
      productOrName.display_name ||
      productOrName.name ||
      productOrName.product_name ||
      ''
    );
  }
  return parseFromName(productOrName);
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
