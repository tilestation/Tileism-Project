/**
 * ManagerFiltersPanel — shared filter panel for every Manager (Tiles, Materials,
 * Custom …). Renders a collapsible bar with facet dropdowns derived from the
 * product list: Colour, Finish, Size, Supplier, Material (tiles-only), Bag Colour
 * (materials-only), Publish state.
 *
 * Facets: derived live from the incoming `products` array so every Manager gets
 * accurate options without hardcoding. Selecting multiple values within a facet
 * is an OR; across facets is an AND (standard e-commerce filter behaviour).
 *
 * Parent renders it above the product table and receives `filters` state + a
 * setter. The panel does *not* filter the products itself — the parent does
 * that via `applyManagerFilters(products, filters)` (exported helper below).
 */

import React, { useMemo, useState } from 'react';
import { X, Filter as FilterIcon, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';

// -------- Facet extraction --------
const FACET_KEYS = {
  tiles: [
    { key: 'color',       label: 'Colour',   pluck: p => p.color || (Array.isArray(p.colors) && p.colors[0]) },
    { key: 'finish',      label: 'Finish',   pluck: p => p.finish },
    { key: 'material',    label: 'Material', pluck: p => p.material },
    { key: 'size',        label: 'Size',     pluck: p => p.size },
    { key: 'slip_rating', label: 'Slip',     pluck: p => p.slip_rating },
    { key: 'supplier',    label: 'Supplier', pluck: p => p.supplier },
    { key: 'published',   label: 'Status',   pluck: p => (p.published ? 'Published' : 'Draft') },
  ],
  materials: [
    { key: 'color',       label: 'Colour',      pluck: p => p.color || (Array.isArray(p.colors) && p.colors[0]) },
    { key: 'bag_colour',  label: 'Bag Colour',  pluck: p => p.bag_colour },
    { key: 'suitability', label: 'Suitability', pluck: p => p.suitability },
    { key: 'supplier',    label: 'Supplier',    pluck: p => p.supplier },
    { key: 'published',   label: 'Status',      pluck: p => (p.published ? 'Published' : 'Draft') },
  ],
  custom: [
    { key: 'color',       label: 'Colour',      pluck: p => p.color || (Array.isArray(p.colors) && p.colors[0]) },
    { key: 'supplier',    label: 'Supplier',    pluck: p => p.supplier },
    { key: 'published',   label: 'Status',      pluck: p => (p.published ? 'Published' : 'Draft') },
  ],
};

const buildFacetOptions = (products, facetConfig) => {
  const map = {};
  facetConfig.forEach(f => (map[f.key] = new Map()));
  products.forEach(p => {
    facetConfig.forEach(f => {
      const raw = f.pluck(p);
      if (raw === null || raw === undefined || raw === '') return;
      const val = String(raw).trim();
      if (!val) return;
      map[f.key].set(val, (map[f.key].get(val) || 0) + 1);
    });
  });
  const out = {};
  Object.entries(map).forEach(([k, m]) => {
    out[k] = [...m.entries()].map(([v, count]) => ({ value: v, count })).sort((a, b) => b.count - a.count);
  });
  return out;
};

// -------- Apply filters helper --------
export const applyManagerFilters = (products, filters, category = 'tiles') => {
  if (!filters || Object.keys(filters).length === 0) return products;
  const cfg = FACET_KEYS[category] || FACET_KEYS.custom;
  return products.filter(p => {
    return cfg.every(f => {
      const chosen = filters[f.key];
      if (!chosen || chosen.length === 0) return true;
      const raw = f.pluck(p);
      if (raw === null || raw === undefined || raw === '') return false;
      return chosen.includes(String(raw).trim());
    });
  });
};

// -------- Panel component --------
const ManagerFiltersPanel = ({
  products = [],
  filters = {},
  onChange,
  category = 'tiles',
  themeColor = 'blue',   // 'blue' | 'orange' | 'purple' | …
}) => {
  const [expanded, setExpanded] = useState(false);
  const facetConfig = FACET_KEYS[category] || FACET_KEYS.custom;
  const facets = useMemo(() => buildFacetOptions(products, facetConfig), [products, facetConfig]);

  const activeCount = Object.values(filters).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
  const themeBtn = {
    blue:   'text-blue-700   border-blue-200   hover:bg-blue-50',
    orange: 'text-orange-700 border-orange-200 hover:bg-orange-50',
    purple: 'text-purple-700 border-purple-200 hover:bg-purple-50',
    slate:  'text-slate-700  border-slate-200  hover:bg-slate-50',
  }[themeColor] || 'text-gray-700 border-gray-200 hover:bg-gray-50';

  const toggleValue = (facetKey, value) => {
    const prev = Array.isArray(filters[facetKey]) ? filters[facetKey] : [];
    const next = prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value];
    const nextFilters = { ...filters, [facetKey]: next };
    if (next.length === 0) delete nextFilters[facetKey];
    onChange(nextFilters);
  };
  const clearAll = () => onChange({});

  return (
    <div className="bg-white border border-gray-200 rounded-lg" data-testid="manager-filters-panel">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-gray-700"
        data-testid="manager-filters-toggle"
      >
        <span className="flex items-center gap-2">
          <FilterIcon className="w-4 h-4 text-gray-500" />
          Filters
          {activeCount > 0 && (
            <Badge variant="outline" className={`text-[10px] py-0 px-1.5 ${themeBtn}`}>
              {activeCount} active
            </Badge>
          )}
        </span>
        <span className="flex items-center gap-2">
          {activeCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); clearAll(); }}
              className="text-[11px] text-gray-500 hover:text-gray-800 flex items-center gap-0.5"
              data-testid="manager-filters-clear"
            >
              <RotateCcw className="w-3 h-3" /> Clear all
            </button>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </span>
      </button>

      {/* Active chips row — always visible */}
      {activeCount > 0 && (
        <div className="px-3 pb-2 flex flex-wrap gap-1">
          {Object.entries(filters).map(([k, vals]) =>
            (vals || []).map(v => (
              <button
                key={`${k}-${v}`}
                onClick={() => toggleValue(k, v)}
                className="inline-flex items-center gap-1 text-[11px] bg-gray-100 hover:bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full"
                data-testid={`manager-filter-chip-${k}-${v}`}
              >
                <span className="text-gray-500 text-[10px] uppercase">{(facetConfig.find(f => f.key === k)?.label || k)}:</span>
                <span className="font-medium">{v}</span>
                <X className="w-2.5 h-2.5" />
              </button>
            ))
          )}
        </div>
      )}

      {expanded && (
        <div className="border-t border-gray-100 p-3 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {facetConfig.map(f => {
            const opts = facets[f.key] || [];
            if (opts.length === 0) return null;
            return (
              <div key={f.key} data-testid={`manager-filter-facet-${f.key}`}>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold mb-1">{f.label}</div>
                <div className="max-h-40 overflow-y-auto border border-gray-100 rounded p-1">
                  {opts.slice(0, 40).map(o => {
                    const checked = Array.isArray(filters[f.key]) && filters[f.key].includes(o.value);
                    return (
                      <label
                        key={o.value}
                        className={`flex items-center gap-1.5 px-1.5 py-0.5 text-xs rounded cursor-pointer hover:bg-gray-50 ${checked ? 'font-semibold text-gray-900' : 'text-gray-700'}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleValue(f.key, o.value)}
                          className="w-3 h-3"
                          data-testid={`manager-filter-check-${f.key}-${o.value}`}
                        />
                        <span className="flex-1 truncate" title={o.value}>{o.value}</span>
                        <span className="text-gray-400 text-[10px]">{o.count}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className="col-span-2 md:col-span-3 lg:col-span-4 flex justify-end">
            <Button size="sm" variant="outline" onClick={clearAll} data-testid="manager-filters-clear-btn">
              <RotateCcw className="w-3 h-3 mr-1" /> Reset filters
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ManagerFiltersPanel;
