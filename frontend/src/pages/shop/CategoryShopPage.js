/**
 * CategoryShopPage — universal customer-facing product listing for any
 * category (bathroom, materials, flooring, underfloor_heating, tools, or a
 * custom Manager slug). Same pattern as `TileListingPage` but data-driven.
 *
 * URL: /shop/browse/:category
 *
 * Reads:
 *   GET /api/shop/category/:category/filters   → facet options
 *   GET /api/shop/category/:category/products  → paginated products
 *
 * Layout:
 *   - Left sidebar with facet dropdowns (5-8 facets per category preset)
 *   - Right: product grid (24/page) with sort + search
 *   - Sticky filter chip strip at top for active facets
 */

import React, { useState, useEffect, useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Search, X, ChevronDown, ChevronUp, ArrowLeft, ShoppingCart } from 'lucide-react';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { normaliseImageUrl } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Category → theme + label + facet order + product-card hint fields
const CATEGORY_META = {
  tiles:             { label: 'Tiles',            theme: 'blue',    facetOrder: ['sizes', 'finishes', 'materials', 'colors', 'slip_ratings', 'suppliers'] },
  flooring:          { label: 'Flooring',         theme: 'amber',   facetOrder: ['sizes', 'finishes', 'materials', 'thicknesses', 'colors', 'click_systems', 'suppliers'] },
  materials:         { label: 'Materials',        theme: 'orange',  facetOrder: ['colors', 'bag_colours', 'suitabilities', 'suppliers'] },
  bathroom:          { label: 'Bathroom',         theme: 'cyan',    facetOrder: ['sub_types', 'brands', 'finishes', 'materials', 'colors', 'sizes', 'suppliers'] },
  underfloor_heating:{ label: 'Underfloor Heating', theme: 'red',   facetOrder: ['coverages', 'voltages', 'mat_types', 'thermostat_types', 'suppliers'] },
  tools:             { label: 'Tools',            theme: 'slate',   facetOrder: ['brands', 'materials', 'sizes', 'suppliers'] },
};

const FACET_LABELS = {
  sizes:             'Size',
  finishes:          'Finish',
  materials:         'Material',
  colors:            'Colour',
  slip_ratings:      'Slip rating',
  suppliers:         'Supplier',
  thicknesses:       'Thickness',
  click_systems:     'Click system',
  bag_colours:       'Bag colour',
  suitabilities:     'Suitability',
  sub_types:         'Type',
  brands:            'Brand',
  coverages:         'Coverage (m²)',
  voltages:          'Voltage',
  mat_types:         'Mat type',
  thermostat_types:  'Thermostat',
};

// Facet key → the URL query param the backend expects (singular)
const FACET_TO_QUERY = {
  sizes: 'size', finishes: 'finish', materials: 'material', colors: 'color',
  slip_ratings: 'slip_rating', suppliers: 'supplier', thicknesses: 'thickness',
  click_systems: 'click_system', bag_colours: 'bag_colour',
  suitabilities: 'suitability', sub_types: 'sub_type', brands: 'brand',
  coverages: 'coverage', voltages: 'voltage', mat_types: 'mat_type',
  thermostat_types: 'thermostat_type',
};

const THEME_CLASSES = {
  blue:   { chip: 'bg-blue-50 text-blue-700 border-blue-200',      accent: 'bg-blue-600 hover:bg-blue-700 text-white',  hdr: 'from-blue-50 to-blue-100' },
  amber:  { chip: 'bg-amber-50 text-amber-700 border-amber-200',    accent: 'bg-amber-600 hover:bg-amber-700 text-white', hdr: 'from-amber-50 to-amber-100' },
  orange: { chip: 'bg-orange-50 text-orange-700 border-orange-200', accent: 'bg-orange-600 hover:bg-orange-700 text-white', hdr: 'from-orange-50 to-orange-100' },
  cyan:   { chip: 'bg-cyan-50 text-cyan-700 border-cyan-200',       accent: 'bg-cyan-600 hover:bg-cyan-700 text-white',  hdr: 'from-cyan-50 to-cyan-100' },
  red:    { chip: 'bg-red-50 text-red-700 border-red-200',          accent: 'bg-red-600 hover:bg-red-700 text-white',    hdr: 'from-red-50 to-red-100' },
  slate:  { chip: 'bg-slate-50 text-slate-700 border-slate-200',    accent: 'bg-slate-700 hover:bg-slate-800 text-white', hdr: 'from-slate-50 to-slate-100' },
};

export default function CategoryShopPage() {
  const { category } = useParams();
  const meta = CATEGORY_META[category] || { label: category.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), theme: 'slate', facetOrder: [] };
  const themeCls = THEME_CLASSES[meta.theme] || THEME_CLASSES.slate;

  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState({ total_products: 0 });
  const [products, setProducts] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [expandedFacets, setExpandedFacets] = useState({});

  const currentFilters = useMemo(() => ({
    search:       searchParams.get('search')       || '',
    supplier:     searchParams.get('supplier')     || '',
    size:         searchParams.get('size')         || '',
    finish:       searchParams.get('finish')       || '',
    color:        searchParams.get('color')        || '',
    material:     searchParams.get('material')     || '',
    brand:        searchParams.get('brand')        || '',
    slip_rating:  searchParams.get('slip_rating')  || '',
    thickness:    searchParams.get('thickness')    || '',
    click_system: searchParams.get('click_system') || '',
    voltage:      searchParams.get('voltage')      || '',
    thermostat_type: searchParams.get('thermostat_type') || '',
    mat_type:     searchParams.get('mat_type')     || '',
    sub_type:     searchParams.get('sub_type')     || '',
    bag_colour:   searchParams.get('bag_colour')   || '',
    suitability:  searchParams.get('suitability')  || '',
    sort:         searchParams.get('sort')         || 'featured',
    page:         Number(searchParams.get('page')  || 1),
  }), [searchParams]);

  // Load filters (once per category)
  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/shop/category/${encodeURIComponent(category)}/filters`);
        if (!res.ok) return;
        const data = await res.json();
        if (!ignore) setFilters(data);
      } catch (e) { console.error('Error loading filters:', e); }
    })();
    return () => { ignore = true; };
  }, [category]);

  // Load products whenever filters change
  useEffect(() => {
    let ignore = false;
    (async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        Object.entries(currentFilters).forEach(([k, v]) => {
          if (v !== '' && v !== 0 && k !== 'sort' && k !== 'page') {
            const backendKey = FACET_TO_QUERY[`${k}s`] || k;
            params.append(backendKey, v);
          }
        });
        params.append('sort_by', currentFilters.sort);
        params.append('page', currentFilters.page);
        params.append('limit', '24');
        const res = await fetch(`${API_URL}/api/shop/category/${encodeURIComponent(category)}/products?${params}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!ignore) {
          setProducts(data.products || []);
          setTotal(data.total || 0);
          setTotalPages(data.total_pages || 1);
        }
      } catch (e) { console.error('Error loading products:', e); }
      finally { if (!ignore) setLoading(false); }
    })();
    return () => { ignore = true; };
  }, [category, currentFilters]);

  const updateFilter = (key, value) => {
    const p = new URLSearchParams(searchParams);
    if (value) p.set(key, value); else p.delete(key);
    if (key !== 'page') p.set('page', '1');
    setSearchParams(p);
  };
  const clearAll = () => setSearchParams({});
  const activeCount = Object.entries(currentFilters).filter(([k, v]) => v && !['sort', 'page', 'search'].includes(k)).length;

  const facetOrder = meta.facetOrder.length > 0
    ? meta.facetOrder
    : Object.keys(filters).filter(k => Array.isArray(filters[k])); // fall back to whatever the backend returns

  return (
    <div className="min-h-screen bg-white">
      <ShopHeader />

      {/* Category header */}
      <div className={`bg-gradient-to-r ${themeCls.hdr} border-b border-gray-200`}>
        <div className="max-w-7xl mx-auto px-4 py-6">
          <Link to="/" className="text-xs text-gray-600 hover:text-gray-900 flex items-center gap-1 mb-2">
            <ArrowLeft className="w-3 h-3" /> Home
          </Link>
          <h1 className="text-3xl font-semibold text-gray-900" data-testid="category-title">{meta.label}</h1>
          <p className="text-sm text-gray-600 mt-1">
            {filters.total_products || total} product{(filters.total_products || total) === 1 ? '' : 's'} · shop by {facetOrder.slice(0, 3).map(f => FACET_LABELS[f] || f).join(', ').toLowerCase()}
          </p>
        </div>
      </div>

      {/* Body */}
      <div className="max-w-7xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-6">
        {/* Sidebar */}
        <aside className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-2 top-2.5 text-gray-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search…"
              value={currentFilters.search}
              onChange={(e) => updateFilter('search', e.target.value)}
              className="w-full pl-8 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500"
              data-testid="category-search-input"
            />
          </div>

          {/* Active chips */}
          {activeCount > 0 && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-2 space-y-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Active</span>
                <button onClick={clearAll} className="text-[10px] text-red-500 hover:text-red-700" data-testid="category-clear-all">Clear all</button>
              </div>
              {Object.entries(currentFilters).map(([k, v]) => {
                if (!v || ['sort', 'page', 'search'].includes(k)) return null;
                return (
                  <button
                    key={k}
                    onClick={() => updateFilter(k, '')}
                    className={`text-[11px] px-2 py-0.5 rounded border ${themeCls.chip} flex items-center gap-1 w-full justify-between`}
                    data-testid={`category-chip-${k}`}
                  >
                    <span>{FACET_LABELS[`${k}s`] || k}: {v}</span>
                    <X className="w-2.5 h-2.5" />
                  </button>
                );
              })}
            </div>
          )}

          {/* Facet dropdowns */}
          {facetOrder.map(facetKey => {
            const opts = Array.isArray(filters[facetKey]) ? filters[facetKey] : [];
            if (opts.length === 0) return null;
            const queryKey = FACET_TO_QUERY[facetKey] || facetKey.replace(/s$/, '');
            const currentVal = currentFilters[queryKey] || '';
            const expanded = expandedFacets[facetKey] ?? true;
            return (
              <div key={facetKey} className="border border-gray-200 rounded-lg" data-testid={`facet-${facetKey}`}>
                <button
                  onClick={() => setExpandedFacets(prev => ({ ...prev, [facetKey]: !expanded }))}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-gray-800 uppercase tracking-wide"
                >
                  {FACET_LABELS[facetKey] || facetKey}
                  {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                </button>
                {expanded && (
                  <div className="px-2 pb-2 space-y-0.5 max-h-64 overflow-y-auto">
                    {opts.slice(0, 30).map(opt => {
                      const v = typeof opt === 'string' ? opt : opt.value;
                      const c = typeof opt === 'string' ? null : opt.count;
                      const isActive = currentVal === v;
                      return (
                        <button
                          key={v}
                          onClick={() => updateFilter(queryKey, isActive ? '' : v)}
                          className={`w-full flex items-center justify-between px-2 py-1 rounded text-xs hover:bg-gray-50 ${isActive ? 'bg-gray-100 font-medium text-gray-900' : 'text-gray-700'}`}
                          data-testid={`facet-${facetKey}-${v}`}
                        >
                          <span className="truncate">{v}</span>
                          {c !== null && <span className="text-gray-400 text-[10px]">{c}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </aside>

        {/* Product grid */}
        <div>
          {/* Sort bar */}
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-gray-600">{total} result{total === 1 ? '' : 's'}</span>
            <select
              value={currentFilters.sort}
              onChange={(e) => updateFilter('sort', e.target.value)}
              className="text-xs border border-gray-200 rounded px-2 py-1 focus:outline-none"
              data-testid="category-sort-select"
            >
              <option value="featured">Featured</option>
              <option value="price_asc">Price: low → high</option>
              <option value="price_desc">Price: high → low</option>
              <option value="name_asc">Name A → Z</option>
              <option value="name_desc">Name Z → A</option>
              <option value="newest">Newest</option>
            </select>
          </div>

          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {Array(8).fill(0).map((_, i) => (
                <div key={i} className="bg-gray-100 rounded-lg aspect-[3/4] animate-pulse" />
              ))}
            </div>
          ) : products.length === 0 ? (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-12 text-center">
              <p className="text-lg font-medium text-gray-700">No products match your filters</p>
              <p className="text-sm text-gray-500 mt-1">Try clearing filters or changing the category.</p>
              {activeCount > 0 && (
                <button onClick={clearAll} className={`mt-4 px-4 py-2 rounded ${themeCls.accent} text-sm`}>
                  Clear all filters
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4" data-testid="category-product-grid">
              {products.map(p => (
                <ProductCard key={p.sku || p.id} product={p} themeCls={themeCls} />
              ))}
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-6 flex items-center justify-center gap-1">
              <button
                onClick={() => updateFilter('page', String(Math.max(1, currentFilters.page - 1)))}
                disabled={currentFilters.page <= 1}
                className="px-3 py-1 text-sm border border-gray-200 rounded disabled:opacity-40"
                data-testid="category-page-prev"
              >Prev</button>
              <span className="text-sm text-gray-600 px-3">Page {currentFilters.page} of {totalPages}</span>
              <button
                onClick={() => updateFilter('page', String(Math.min(totalPages, currentFilters.page + 1)))}
                disabled={currentFilters.page >= totalPages}
                className="px-3 py-1 text-sm border border-gray-200 rounded disabled:opacity-40"
                data-testid="category-page-next"
              >Next</button>
            </div>
          )}
        </div>
      </div>

      <ShopFooter />
    </div>
  );
}

const ProductCard = ({ product, themeCls }) => {
  const img = normaliseImageUrl(product.image_url || (Array.isArray(product.images) && product.images[0]));
  const name = product.our_product_name || product.product_name || product.name || product.sku;
  const price = Number(product.list_price || product.retail_price || 0);
  const slug = product.slug || product.sku;
  return (
    <Link to={`/shop/products/${encodeURIComponent(slug)}`} className="group block" data-testid={`product-card-${product.sku}`}>
      <div className="bg-gray-100 rounded-lg overflow-hidden aspect-square mb-2 relative">
        {img ? (
          <img src={img} alt={name} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">No image</div>
        )}
        {product.sale_pct > 0 && (
          <span className={`absolute top-2 left-2 px-2 py-0.5 rounded text-[10px] font-semibold ${themeCls.accent}`}>{product.sale_pct}% off</span>
        )}
      </div>
      <div className="text-sm font-medium text-gray-900 line-clamp-1">{name}</div>
      <div className="text-xs text-gray-500 line-clamp-1">{product.finish || product.material || product.brand || product.supplier}</div>
      {price > 0 && (
        <div className="text-sm font-semibold text-gray-900 mt-1">
          £{price.toFixed(2)}
          {product.pricing_unit === 'm2' && <span className="text-[10px] text-gray-500 ml-0.5">/m²</span>}
          {product.pricing_unit === 'unit' && <span className="text-[10px] text-gray-500 ml-0.5">/unit</span>}
        </div>
      )}
    </Link>
  );
};
