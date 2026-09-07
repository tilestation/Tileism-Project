// Shared, module-cached loader for shop tab destinations.
// Used by: ShopTabsAssignModal (bulk bar), Quick Edit Shop Tabs panel,
// and the Manager table's destination chips column.
const API_URL = process.env.REACT_APP_BACKEND_URL;

export const MANAGER_TO_SHOP_GROUP = {
  tiles: 'tiles',
  flooring: 'flooring',
  materials: 'materials',
  bathroom: 'bathroom',
  tools: 'tools-accessories',
  underfloor_heating: 'underfloor-heating',
};

let cache = null;

export const fetchShopTabDestinations = async (force = false) => {
  if (cache && !force) return cache;
  try {
    const res = await fetch(`${API_URL}/api/supplier-sync/shop-tab-destinations`);
    cache = res.ok ? (await res.json()).pages || [] : [];
  } catch {
    cache = [];
  }
  return cache;
};

export const clearShopTabDestinationsCache = () => { cache = null; };

export const resolveShopGroupSlug = (managerSlug) => {
  const raw = String(managerSlug || '').trim();
  if (!raw) return null;
  return MANAGER_TO_SHOP_GROUP[raw] || raw;
};

export const filterShopTabPagesForManager = (pages = [], managerSlug = null) => {
  const target = resolveShopGroupSlug(managerSlug);
  if (!target) return Array.isArray(pages) ? pages : [];
  return (Array.isArray(pages) ? pages : []).filter(page => page.group_slug === target);
};

// Map of lowercased category_name -> { label, groupSlug, name } for quick chip lookups.
export const buildDestinationMap = (pages) => {
  const map = new Map();
  (pages || []).forEach(page => (page.tabs || []).forEach(tab => {
    if (tab.assignable && tab.category_name) {
      map.set(tab.category_name.toLowerCase(), { label: tab.label, groupSlug: page.group_slug, name: tab.category_name });
    }
  }));
  return map;
};
