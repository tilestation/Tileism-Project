/**
 * classifyProductToManager — inspect a product object and return the slug of the
 * built-in Manager it belongs to ('tiles', 'materials', 'flooring', 'bathroom',
 * 'underfloor_heating', 'tools'), or null if it doesn't cleanly map to one.
 *
 * Order of precedence:
 *   1. Explicit `product_group` or `main_category` matching a Manager slug.
 *   2. `sub_categories[]` keywords that uniquely identify a Manager.
 *   3. Free-text `product_name` keywords (last resort).
 *
 * Used by SupplierProducts.js + ManagerTabsBar to show per-Manager selection
 * chips (so highlighting 14 Materials doesn't badge every other tab).
 */

const ANY = (arr, re) => arr.some(s => re.test(String(s)));

export function classifyProductToManager(p) {
  if (!p) return null;
  const grp = String(p.product_group || '').toLowerCase().replace(/\s+/g, '_');
  const mainCat = String(p.main_category || '').toLowerCase().replace(/\s+/g, '_');
  const primary = grp || mainCat;
  if (['tiles', 'materials', 'flooring', 'bathroom', 'tools'].includes(primary)) return primary;
  if (primary === 'underfloor_heating' || primary === 'underfloor_heat') return 'underfloor_heating';

  const subCats = Array.isArray(p.sub_categories) ? p.sub_categories : [];
  if (ANY(subCats, /tile|mosaic|border/i))                                 return 'tiles';
  if (ANY(subCats, /adhesive|grout|sealant|silicone|primer|cleaning|clean|levelling|underlay/i)) return 'materials';
  if (ANY(subCats, /lvt|laminate|engineered|vinyl|flooring|wood/i))        return 'flooring';
  if (ANY(subCats, /toilet|basin|bath|shower|tap|wc|vanity|mirror|bathroom/i)) return 'bathroom';
  if (ANY(subCats, /underfloor|thermostat|heating cable|heating mat|ufh/i))return 'underfloor_heating';
  if (ANY(subCats, /tool|trowel|spacer|mixer|cutter|blade/i))              return 'tools';

  const name = String(p.our_product_name || p.product_name || p.name || '');
  if (/(tile|mosaic|border)\b/i.test(name))                                return 'tiles';
  if (/adhesive|grout|sealant|silicone|primer|cleaner\b/i.test(name))      return 'materials';
  if (/lvt|laminate|engineered wood|vinyl floor/i.test(name))              return 'flooring';
  if (/toilet|basin|bath|shower|tap|vanity/i.test(name))                   return 'bathroom';
  if (/underfloor|thermostat|heating cable|heating mat/i.test(name))       return 'underfloor_heating';
  if (/trowel|spacer|mixer|cutter/i.test(name))                            return 'tools';

  return null;
}

/**
 * Given a list of products and a Set of selection keys (supplier|||sku),
 * return { [managerSlug]: [key1, key2, ...] } — the buckets each key belongs to.
 * Products that don't classify to any built-in Manager are dropped from the map.
 */
export function bucketSelectionByManager(products, selectedKeys, getKey) {
  const map = {};
  if (!selectedKeys || selectedKeys.size === 0 || !Array.isArray(products)) return map;
  for (const p of products) {
    const key = getKey(p);
    if (!selectedKeys.has(key)) continue;
    const slug = classifyProductToManager(p);
    if (!slug) continue;
    if (!map[slug]) map[slug] = [];
    map[slug].push(key);
  }
  return map;
}
