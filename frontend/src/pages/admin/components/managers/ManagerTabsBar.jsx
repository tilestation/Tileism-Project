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
  Layers, Grid3X3, Package, Square, Bath, Flame, Wrench, Plus, Sparkles, AlertTriangle, RefreshCw,
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

const ManagerTabsBar = ({
  active = 'all',
  onNewCustom,
  selectionKeys = null,
  selectionByCategory = null,   // { materials: [key1, ...], tiles: [...] } — optional per-category
}) => {
  const [customTabs, setCustomTabs] = useState([]);
  const [duplicatesCount, setDuplicatesCount] = useState(0);
  const [cleaning, setCleaning] = useState(false);

  const loadTabs = React.useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/manager-definitions`);
      if (!res.ok) return;
      const data = await res.json();
      // Only render TRUE custom managers here. Three safeguards:
      //   1. Skip anything with is_builtin: true (server-flagged built-ins).
      //   2. Skip anything whose slug matches a hardcoded tab (belt-and-braces
      //      in case a legacy row was created without the is_builtin flag).
      //   3. Skip anything whose display name matches a built-in name — catches
      //      the case where someone created "Materials Manager" as a custom with
      //      a differently-shaped slug (e.g. materials-manager).
      const hardcodedSlugs = new Set(HARDCODED_TABS.map(t => t.key));
      const hardcodedNames = new Set([
        'tiles manager','materials manager','flooring manager','bathroom manager',
        'underfloor heating manager','underfloor heat manager','tools manager',
      ]);
      const all = (data.definitions || []).filter(def => !def.is_builtin);
      const filtered = all.filter(def =>
        !hardcodedSlugs.has(def.slug)
        && !hardcodedNames.has(String(def.name || '').trim().toLowerCase())
      );
      setCustomTabs(filtered);
      setDuplicatesCount(all.length - filtered.length);
    } catch { /* silent — tabs still render */ }
  }, []);

  useEffect(() => {
    let ignore = false;
    (async () => { if (!ignore) await loadTabs(); })();
    return () => { ignore = true; };
  }, [loadTabs]);

  const handleCleanup = async () => {
    if (cleaning) return;
    if (!window.confirm(`Remove ${duplicatesCount} duplicate custom Manager${duplicatesCount === 1 ? '' : 's'}? Products stay in the database — only the duplicate tab is hidden.`)) return;
    setCleaning(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/manager-definitions/cleanup-duplicates`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Import toast lazily so the module stays lean when not needed
      const { toast } = await import('sonner');
      toast.success(`Removed ${data.removed_count} duplicate tab${data.removed_count === 1 ? '' : 's'}`);
      await loadTabs();
    } catch (err) {
      const { toast } = await import('sonner');
      toast.error(`Cleanup failed: ${err.message}`);
    } finally {
      setCleaning(false);
    }
  };

  // Per-tab key list: if the parent classified selection by Manager, use that
  // bucket for the tab — otherwise fall back to the flat selectionKeys list
  // (backward-compat for callers that don't classify).
  const keysForTab = (tabKey) => {
    if (selectionByCategory && Object.prototype.hasOwnProperty.call(selectionByCategory, tabKey)) {
      return selectionByCategory[tabKey] || [];
    }
    // No per-category map → the parent didn't classify. Only decorate the
    // 'all'-tabs case with the flat list. Individual Manager tabs stay blank
    // unless we know the products actually belong to them.
    if (!selectionByCategory) return selectionKeys || [];
    return [];
  };

  // If the parent handed us a non-empty selection for THIS tab, append
  // ?ids=<encoded-keys>&mode=bulk so the target Manager can pre-select and
  // open its bulk bar.
  const withSelection = (path, tabKey) => {
    const keys = keysForTab(tabKey);
    if (!Array.isArray(keys) || keys.length === 0) return path;
    const enc = keys.map(k => encodeURIComponent(k)).join(',');
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
              to={withSelection(tab.to, tab.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap transition-colors ${activeCls}`}
              data-testid={`manager-tab-${tab.key}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
              {tab.key !== active && keysForTab(tab.key).length > 0 && (
                <span className="ml-1 px-1.5 py-0 rounded bg-amber-100 text-amber-700 text-[9px] font-bold" title={`Carries ${keysForTab(tab.key).length} selected products`}>
                  +{keysForTab(tab.key).length}
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
              to={withSelection(`/admin/custom-manager/${def.slug}`, `custom:${def.slug}`)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap transition-colors ${themeCls}`}
              data-testid={`manager-tab-custom-${def.slug}`}
              title={def.description || def.name}
            >
              <Sparkles className="w-3.5 h-3.5" />
              {def.name}
              <span className="ml-0.5 px-1 py-0 rounded bg-white/80 text-[9px] font-bold uppercase tracking-wide opacity-70">Custom</span>
              {!isActive && keysForTab(`custom:${def.slug}`).length > 0 && (
                <span className="ml-1 px-1.5 py-0 rounded bg-amber-100 text-amber-700 text-[9px] font-bold">
                  +{keysForTab(`custom:${def.slug}`).length}
                </span>
              )}
            </Link>
          );
        })}

        {/* + New Custom Manager pill */}
        {duplicatesCount > 0 && (
          <button
            onClick={handleCleanup}
            disabled={cleaning}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-amber-400 bg-amber-50 text-xs font-medium text-amber-800 hover:bg-amber-100 whitespace-nowrap ml-auto flex-shrink-0 disabled:opacity-60"
            data-testid="manager-tab-cleanup-duplicates"
            title={`${duplicatesCount} custom Manager tab${duplicatesCount === 1 ? '' : 's'} clash with built-in tabs — click to soft-delete them`}
          >
            {cleaning ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <AlertTriangle className="w-3.5 h-3.5" />}
            Clean up {duplicatesCount} duplicate tab{duplicatesCount === 1 ? '' : 's'}
          </button>
        )}
        {onNewCustom && (
          <button
            onClick={onNewCustom}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-dashed border-purple-400 text-xs font-medium text-purple-600 hover:bg-purple-50 whitespace-nowrap flex-shrink-0 ${duplicatesCount > 0 ? '' : 'ml-auto'}`}
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
