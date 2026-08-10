/**
 * ShopTabGapsCard — compact admin-dashboard card showing how many products
 * are not assigned to any shop tab, per product group, with jump links that
 * open the matching Manager with the gap filter pre-enabled (?gaps=1).
 */
import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, LayoutGrid } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const GROUP_ROUTES = {
  tiles: '/admin/tiles',
  materials: '/admin/materials',
  flooring: '/admin/flooring',
  bathroom: '/admin/bathroom',
  underfloor_heating: '/admin/underfloor-heating',
  'underfloor-heating': '/admin/underfloor-heating',
  tools: '/admin/tools',
};

export const ShopTabGapsCard = () => {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/api/supplier-sync/products/shop-tab-gaps`)
      .then(res => (res.ok ? res.json() : null))
      .then(setData)
      .catch(() => setData(null));
  }, []);

  if (!data) return null;

  if (data.total_gaps === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-sm text-emerald-700" data-testid="shop-tab-gaps-card">
        <CheckCircle2 className="w-4 h-4" />
        All {data.total_products} products are assigned to shop tabs — nothing hiding from customers.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3" data-testid="shop-tab-gaps-card">
      <div className="flex items-center gap-2 flex-wrap">
        <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
        <span className="text-sm font-semibold text-amber-900" data-testid="shop-tab-gaps-total">
          {data.total_gaps} of {data.total_products} products aren't on any shop tab
        </span>
        <span className="text-xs text-amber-600">— customers can't browse to them. Click a category to fix:</span>
      </div>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {data.by_group.map(({ group, count }) => {
          const route = GROUP_ROUTES[group];
          const label = `${group.replace(/[_-]/g, ' ')} · ${count}`;
          return route ? (
            <Link
              key={group}
              to={`${route}?gaps=1`}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-amber-300 text-amber-800 text-xs font-medium hover:bg-amber-100 transition-colors capitalize"
              data-testid={`gaps-link-${group}`}
            >
              <LayoutGrid className="w-3 h-3" />
              {label}
            </Link>
          ) : (
            <span key={group} className="inline-flex px-2.5 py-1 rounded-full bg-white/60 border border-amber-200 text-amber-600 text-xs capitalize" title="Manage from All Products" data-testid={`gaps-chip-${group}`}>
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
};

export default ShopTabGapsCard;
