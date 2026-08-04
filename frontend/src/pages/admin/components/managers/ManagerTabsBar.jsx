/**
 * ManagerTabsBar — unified tab bar shown at the top of every Manager page and
 * the legacy Bulk Editor. Clicking a tab navigates to the corresponding route
 * so the user perceives a single "Products Workspace" with category tabs.
 *
 * Route mapping (each tab is a real route, so browser Back / deep-links work):
 *   All Products (Legacy) → /admin/supplier-products
 *   Tiles                 → /admin/tiles
 *   Materials             → /admin/materials
 *   Flooring              → /admin/flooring          (coming soon placeholder)
 *   Bathroom              → /admin/bathroom          (coming soon placeholder)
 *   Underfloor Heating    → /admin/underfloor-heating (coming soon placeholder)
 *   Tools                 → /admin/tools              (coming soon placeholder)
 *   Custom …              → /admin/custom-manager/:slug (dynamic, from backend)
 *   + New Custom Manager  → opens the CustomManagerBuilder modal
 *
 * Prop `active` = which tab to visually mark active. Prop `onNewCustom` invoked
 * when the user clicks the "+ New Custom Manager" pill (parent opens the modal).
 */

import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Layers, Grid3X3, Package, Square, Bath, Flame, Wrench, Plus, Sparkles,
} from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const HARDCODED_TABS = [
  { key: 'all',       label: 'All Products',   icon: Layers,   to: '/admin/supplier-products', theme: 'gray' },
  { key: 'tiles',     label: 'Tiles',          icon: Square,   to: '/admin/tiles',             theme: 'blue' },
  { key: 'materials', label: 'Materials',      icon: Package,  to: '/admin/materials',         theme: 'orange' },
  { key: 'flooring',  label: 'Flooring',       icon: Grid3X3,  to: '/admin/flooring',          theme: 'amber' },
  { key: 'bathroom',  label: 'Bathroom',       icon: Bath,     to: '/admin/bathroom',          theme: 'cyan' },
  { key: 'underfloor_heating',       label: 'Underfloor Heat', icon: Flame,   to: '/admin/underfloor-heating', theme: 'red' },
  { key: 'tools',     label: 'Tools',          icon: Wrench,   to: '/admin/tools',             theme: 'slate' },
];

const THEME_ACTIVE = {
  gray:   'border-slate-600  text-slate-800  bg-slate-50',
  blue:   'border-blue-600   text-blue-700   bg-blue-50',
  orange: 'border-orange-600 text-orange-700 bg-orange-50',
  amber:  'border-amber-600  text-amber-700  bg-amber-50',
  cyan:   'border-cyan-600   text-cyan-700   bg-cyan-50',
  red:    'border-red-600    text-red-700    bg-red-50',
  slate:  'border-slate-700  text-slate-800  bg-slate-100',
  emerald:'border-emerald-600 text-emerald-700 bg-emerald-50',
  purple: 'border-purple-600 text-purple-700 bg-purple-50',
  pink:   'border-pink-600   text-pink-700   bg-pink-50',
};

const ManagerTabsBar = ({ active = 'all', onNewCustom, selectionKeys = null }) => {
  const [customTabs, setCustomTabs] = useState([]);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/manager-definitions`);
        if (!res.ok) return;
        const data = await res.json();
        if (!ignore) setCustomTabs(Array.isArray(data.definitions) ? data.definitions : []);
      } catch { /* silent — tabs still render */ }
    })();
    return () => { ignore = true; };
  }, []);

  // If the parent handed us a non-empty selection, append ?ids=<encoded-keys>&mode=bulk
  // so the target Manager page can pre-select and open its bulk bar.
  const withSelection = (path) => {
    if (!Array.isArray(selectionKeys) || selectionKeys.length === 0) return path;
    const enc = selectionKeys.map(k => encodeURIComponent(k)).join(',');
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}ids=${enc}&mode=bulk`;
  };

  return (
    <div className="bg-white border-b border-gray-200" data-testid="manager-tabs-bar">
      <div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-2 overflow-x-auto">
        <span className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold pr-2 flex-shrink-0">
          Workspace
        </span>
        {HARDCODED_TABS.map(tab => {
          const isActive = tab.key === active;
          const Icon = tab.icon;
          const activeCls = isActive ? THEME_ACTIVE[tab.theme] : 'border-transparent text-gray-500 hover:text-gray-800 hover:bg-gray-50';
          if (tab.comingSoon) {
            return (
              <span
                key={tab.key}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap opacity-70 cursor-not-allowed ${activeCls}`}
                data-testid={`manager-tab-${tab.key}`}
                title="Coming soon"
              >
                <Icon className="w-3.5 h-3.5" />
                {tab.label}
                <span className="ml-0.5 px-1 py-0 rounded bg-gray-200 text-gray-500 text-[9px] font-bold">SOON</span>
              </span>
            );
          }
          return (
            <Link
              key={tab.key}
              to={withSelection(tab.to)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap transition-colors ${activeCls}`}
              data-testid={`manager-tab-${tab.key}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
              {tab.key !== active && Array.isArray(selectionKeys) && selectionKeys.length > 0 && (
                <span className="ml-1 px-1.5 py-0 rounded bg-amber-100 text-amber-700 text-[9px] font-bold" title={`Carries ${selectionKeys.length} selected products`}>
                  +{selectionKeys.length}
                </span>
              )}
            </Link>
          );
        })}

        {/* Custom Manager tabs (loaded from backend) */}
        {customTabs.length > 0 && <div className="h-4 w-px bg-gray-200 mx-1 flex-shrink-0" />}
        {customTabs.map(def => {
          const isActive = active === `custom:${def.slug}`;
          const themeCls = isActive ? THEME_ACTIVE[def.theme || 'purple'] : 'border-transparent text-gray-500 hover:text-gray-800 hover:bg-gray-50';
          return (
            <Link
              key={def.slug}
              to={withSelection(`/admin/custom-manager/${def.slug}`)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap transition-colors ${themeCls}`}
              data-testid={`manager-tab-custom-${def.slug}`}
              title={def.description || def.name}
            >
              <Sparkles className="w-3.5 h-3.5" />
              {def.name}
              <span className="ml-0.5 px-1 py-0 rounded bg-white/80 text-[9px] font-bold uppercase tracking-wide opacity-70">Custom</span>
              {!isActive && Array.isArray(selectionKeys) && selectionKeys.length > 0 && (
                <span className="ml-1 px-1.5 py-0 rounded bg-amber-100 text-amber-700 text-[9px] font-bold">
                  +{selectionKeys.length}
                </span>
              )}
            </Link>
          );
        })}

        {/* + New Custom Manager pill */}
        {onNewCustom && (
          <button
            onClick={onNewCustom}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-dashed border-purple-400 text-xs font-medium text-purple-600 hover:bg-purple-50 whitespace-nowrap ml-auto flex-shrink-0"
            data-testid="manager-tab-add-custom"
            title="Create a new custom Manager (e.g. Paint, Lighting, Grout Extras)"
          >
            <Plus className="w-3.5 h-3.5" />
            New Custom Manager
          </button>
        )}
      </div>
    </div>
  );
};

export default ManagerTabsBar;
