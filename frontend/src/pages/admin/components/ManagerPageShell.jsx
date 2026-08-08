/**
 * ManagerPageShell — shared shell for every hardcoded Manager page
 * (Tiles / Materials / Flooring / Bathroom / UFH / Tools). Each Manager just
 * passes a config: category key, theme, icon, product predicate, sub-tabs,
 * table columns, edit fields. The shell handles everything else:
 *   - Workspace tabs bar
 *   - Header (title + subtitle + Add New / Refresh / Legacy link)
 *   - Search + Filters panel (facet-driven)
 *   - Sub-tabs with live counts
 *   - Info banner ("How this page works")
 *   - Product table with select-all + per-row Edit
 *   - Edit modal (config-driven fields with a Description textarea)
 *   - Add Product Wizard (presetCategory)
 *   - Bulk bar with all shared bulk actions
 *   - AssignColoursModal + TierPricingModal + BulkFieldsModal + BulkAIDescriptionsModal
 *   - Draft recovery (auto-save + restore prompt) on the edit modal
 *   - Custom Manager builder mount (opens from workspace tabs "+ New")
 *
 * Every Manager is ~60 lines of config after this — a huge win over duplicating.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft, RefreshCw, Search, Save, X, Edit2, Filter, ExternalLink, AlertCircle, CheckCircle, Plus, FileSpreadsheet, Settings,
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../../components/ui/dialog';

import AddProductWizard from './AddProductWizard';
import ManagerBulkBar from './managers/ManagerBulkBar';
import ManagerTabsBar from './managers/ManagerTabsBar';
import { bucketSelectionByManager } from './managers/classifyProductToManager';
import ManagerFiltersPanel, { applyManagerFilters } from './managers/ManagerFiltersPanel';
import CustomManagerBuilder from './managers/CustomManagerBuilder';
import BulkFieldsModal from './managers/BulkFieldsModal';
import BulkSpecsFiltersModal from './managers/BulkSpecsFiltersModal';
import QuickEditProductDrawer from './managers/QuickEditProductDrawer';
import BulkAIDescriptionsModal from './managers/BulkAIDescriptionsModal';
import BulkImageUploadModal from './managers/BulkImageUploadModal';
import CsvImportModal from './managers/CsvImportModal';
import ManagerConfigModal from './managers/ManagerConfigModal';
import AssignColoursModal from './managers/AssignColoursModal';
import TierPricingModal from './supplier-products/TierPricingModal';
import BulkSaleModal from './supplier-products/BulkSaleModal';
import { useManagerBulk } from './managers/useManagerBulk';
import { useDraftRecovery } from './managers/useDraftRecovery';
import { useManagerConfig } from './managers/useManagerConfig';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Given a stored sub-tab config ({key, label, keywords[]}) and a product,
// return whether the product should appear in that sub-tab. `all` / empty
// keywords always match everything.
const tabMatches = (tab, product) => {
  const keywords = Array.isArray(tab.keywords) ? tab.keywords : [];
  if (tab.key === 'all' || keywords.length === 0) return true;
  const haystack = (
    (product.our_product_name || product.product_name || product.name || '') + ' ' +
    (Array.isArray(product.sub_categories) ? product.sub_categories.join(' ') : '') + ' ' +
    (product.type || '')
  ).toLowerCase();
  return keywords.some(kw => haystack.includes(String(kw).toLowerCase()));
};

// Tailwind class maps keyed by theme (used for header icon, bulk bar accent, buttons, sub-tab active borders)
const THEME_MAP = {
  blue:    { headerIcon: 'bg-blue-100 text-blue-600',    ctaBtn: 'bg-blue-600 hover:bg-blue-700',    tabActive: 'border-blue-500 text-blue-600',    banner: 'bg-blue-50 border-blue-200 text-blue-800',       rowHi: 'bg-blue-50' },
  orange:  { headerIcon: 'bg-orange-100 text-orange-600', ctaBtn: 'bg-orange-600 hover:bg-orange-700', tabActive: 'border-orange-500 text-orange-600', banner: 'bg-orange-50 border-orange-200 text-orange-800', rowHi: 'bg-orange-50' },
  amber:   { headerIcon: 'bg-amber-100 text-amber-600',   ctaBtn: 'bg-amber-600 hover:bg-amber-700',   tabActive: 'border-amber-500 text-amber-600',   banner: 'bg-amber-50 border-amber-200 text-amber-800',    rowHi: 'bg-amber-50' },
  cyan:    { headerIcon: 'bg-cyan-100 text-cyan-600',     ctaBtn: 'bg-cyan-600 hover:bg-cyan-700',     tabActive: 'border-cyan-500 text-cyan-600',     banner: 'bg-cyan-50 border-cyan-200 text-cyan-800',       rowHi: 'bg-cyan-50' },
  red:     { headerIcon: 'bg-red-100 text-red-600',       ctaBtn: 'bg-red-600 hover:bg-red-700',       tabActive: 'border-red-500 text-red-600',       banner: 'bg-red-50 border-red-200 text-red-800',          rowHi: 'bg-red-50' },
  slate:   { headerIcon: 'bg-slate-100 text-slate-700',   ctaBtn: 'bg-slate-700 hover:bg-slate-800',   tabActive: 'border-slate-500 text-slate-700',   banner: 'bg-slate-50 border-slate-200 text-slate-800',    rowHi: 'bg-slate-50' },
};

const ManagerPageShell = ({
  categoryKey,           // 'flooring' | 'bathroom' | …
  title,
  subtitle,
  icon: Icon,
  theme = 'orange',      // key from THEME_MAP
  isMatch,               // (product) => boolean — classify product into this Manager
  subTabs = [],          // [{key, label, match: (product) => bool}]
  columns = [],          // [{key, label, render?}]  (Product + Actions are added automatically)
  editFields = [],       // [{key, label, type?, options?, hint?}]
  presetCategory,        // slug passed to AddProductWizard
  bannerBullets = [],    // list of "How this page works" bullets
  facetCategory = 'tiles', // 'tiles' | 'materials' | 'custom' — drives ManagerFiltersPanel
  tierPricingDefaults = {},
  themeFilter = null,    // filter-panel theme override (defaults to `theme`)
  bulkBarTheme = null,   // bulk-bar theme override (defaults to `theme`)
  tabsBarActive = null,  // override for <ManagerTabsBar active=...> (e.g. 'custom:slug' for CustomManager)
  extraHeaderActions = null, // ReactNode slot rendered in the header action row (e.g. delete-manager button)
  topBanner = null,      // ReactNode slot rendered above the search bar (e.g. sub-category chips)
  showLegacyLink = true, // hide the "Legacy full editor" link for pages where it's not relevant
  hideDefaultBanner = false, // hide the built-in "How this page works" info banner
}) => {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [subTab, setSubTab] = useState(subTabs[0]?.key || 'all');
  const [editingProduct, setEditingProduct] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [filters, setFilters] = useState({});
  const [searchParams, setSearchParams] = useSearchParams();
  const [showAssignColours, setShowAssignColours] = useState(false);
  const [showTierPricing, setShowTierPricing] = useState(false);
  const [showBulkFields, setShowBulkFields] = useState(false);
  const [showAIDescriptions, setShowAIDescriptions] = useState(false);
  const [showBulkImages, setShowBulkImages] = useState(false);
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [showConfig, setShowConfig] = useState(false);

  // Per-product overrides for the Tier Pricing modal.
  // Shape: { 'supplier|||sku': { trade_discount?, credit_back_rate?, disabled? } }
  const [tierProductOverrides, setTierProductOverrides] = useState({});

  // Bulk Sale/Labels modal state (Sale %, Sale, Clearance, New Arrival, etc.)
  const [showBulkSaleLabels, setShowBulkSaleLabels] = useState(false);
  const [bulkSaleForm, setBulkSaleForm] = useState({
    labels: [], custom_labels: [], discount_percentage: '', action: 'add', applyDiscount: false,
  });
  const [bulkSaleSaving, setBulkSaleSaving] = useState(false);

  // Bulk Specs / Filters modal state (Configure-driven fields)
  const [showBulkSpecs, setShowBulkSpecs] = useState(false);

  // ---- Per-Manager config (facets, sub-tabs, spec fields) from the DB ----
  const { config, save: saveConfig, refresh: refreshConfig } = useManagerConfig(categoryKey);

  // Merge props with DB config. DB config wins if present — so admin's custom
  // filters/tabs/fields survive across page reloads.
  // ---- Config precedence: MERGE, not override ----
  // Props supply the SCHEMA (type/options/hint); DB config supplies ADDITIONS + reordering.
  // For any field present in BOTH, the prop version's type/options/hint win when DB row is
  // missing those keys (older DB rows only stored key/label). Fields present only in DB
  // still render (custom fields added via Configure modal). Fields present only in props
  // still render (silent-upgrade migrations like Tiles select fields).
  const mergeConfig = (dbRows, propRows) => {
    if (!Array.isArray(dbRows) || dbRows.length === 0) return propRows;
    if (!Array.isArray(propRows) || propRows.length === 0) return dbRows;
    const propMap = new Map(propRows.map(f => [f.key, f]));
    // Start with DB order (so admin re-ordering sticks), enrich each row from props.
    // Structural schema upgrades (type/options declared in code) WIN over DB defaults —
    // this lets a code-level migration ship richer field metadata (select dropdowns,
    // number inputs, textareas) without requiring an admin to click Configure first.
    const merged = dbRows.map(dbRow => {
      const propRow = propMap.get(dbRow.key);
      if (!propRow) return dbRow;
      const propHasSchema  = propRow.type && propRow.type !== 'text';
      const propHasOptions = Array.isArray(propRow.options) && propRow.options.length > 0;
      const dbHasOptions   = Array.isArray(dbRow.options) && dbRow.options.length > 0;
      return {
        ...propRow,
        ...dbRow,
        // Prefer richer prop metadata; fall back to DB's when prop is generic
        type:    propHasSchema  ? propRow.type    : (dbRow.type    || propRow.type),
        options: propHasOptions ? propRow.options : (dbHasOptions ? dbRow.options : propRow.options),
        hint:    dbRow.hint     || propRow.hint,
        label:   dbRow.label    || propRow.label,
      };
    });
    // Append prop-only fields (new fields shipped in a migration, not yet in DB)
    const dbKeys = new Set(dbRows.map(r => r.key));
    propRows.forEach(pr => { if (!dbKeys.has(pr.key)) merged.push(pr); });
    return merged;
  };

  const effectiveFilterFacets = Array.isArray(config?.filter_facets) && config.filter_facets.length > 0
    ? config.filter_facets
    : null;   // null means: fall back to ManagerFiltersPanel's category preset
  const effectiveSubTabs = (() => {
    const merged = mergeConfig(config?.sub_tabs, subTabs);
    if (!Array.isArray(merged) || merged.length === 0) return subTabs;
    return merged.map(t => ({
      ...t,
      match: t.match || ((p) => tabMatches(t, p)),
    }));
  })();
  const effectiveEditFields = mergeConfig(config?.spec_fields, editFields);
  const [tierPricingConfig, setTierPricingConfig] = useState({
    thresholds: [10, 50, 100],
    discounts: [0, 5, 10, 15],
    custom_quote_threshold: 150,
    trade_discount_default: 5,
    trade_discount_type: 'percent',
    credit_back_default: 2,
    pallet_enabled: false,
    pallet_price: null, half_pallet_price: null,
    m2_per_pallet: null, m2_per_half_pallet: null,
    ...tierPricingDefaults,
  });

  const themeCls = THEME_MAP[theme] || THEME_MAP.orange;

  // ---- Fetch ----
  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products?limit=5000`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const all = data.products || [];
      const filtered = all.filter(isMatch);
      setProducts(filtered);
      setLastRefresh(new Date());
    } catch (err) {
      toast.error(`Failed to load ${categoryKey}: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [isMatch, categoryKey]);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);
  const bulk = useManagerBulk({ products, onRefresh: fetchProducts, storageKey: categoryKey });

  // Auto-open edit on ?edit=SKU
  useEffect(() => {
    const editSku = searchParams.get('edit');
    if (editSku && products.length > 0) {
      const target = products.find(p => p.sku === editSku || p.supplier_code === editSku);
      if (target) { openEdit(target); setSearchParams({}); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, searchParams]);

  // Cross-page selection carry-over: ?ids=<encoded key1>,<encoded key2>,...&mode=bulk
  // Set by ManagerTabsBar when the user clicks a Manager tab from /admin/supplier-products
  // (or another Manager) with products selected. Pre-selects them here + opens the bulk bar.
  useEffect(() => {
    const idsParam = searchParams.get('ids');
    if (!idsParam || products.length === 0) return;
    const wantedKeys = idsParam.split(',').map(k => decodeURIComponent(k)).filter(Boolean);
    if (wantedKeys.length === 0) return;
    const productKeySet = new Set(products.map(p => `${p.supplier || 'unknown'}|||${p.sku || p.supplier_code || p._id}`));
    const matched = wantedKeys.filter(k => productKeySet.has(k));
    if (matched.length > 0) {
      bulk.setSelectedProducts(new Set(matched));
      toast.success(`${matched.length} of ${wantedKeys.length} selected products carried over`);
      if (wantedKeys.length > matched.length) {
        // Some SKUs don't belong to this Manager (data-classification gap)
        toast.info(`${wantedKeys.length - matched.length} products didn't match this Manager — they stay selected in Supplier Products`);
      }
    } else {
      toast.warning(`None of the ${wantedKeys.length} selected products belong to ${title}`);
    }
    // Strip the URL params so a refresh doesn't re-apply
    const next = new URLSearchParams(searchParams);
    next.delete('ids');
    next.delete('mode');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, searchParams]);

  const filteredProducts = useMemo(() => {
    let list = products;
    // Sub-tab
    const tab = effectiveSubTabs.find(t => t.key === subTab) || effectiveSubTabs[0];
    if (subTab !== 'all' && tab) {
      list = list.filter(p => tab.match ? tab.match(p) : tabMatches(tab, p));
    }
    // Facet filters
    list = applyManagerFilters(list, filters, facetCategory, effectiveFilterFacets);
    // Search
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(p => {
        const name = String(p.our_product_name || p.product_name || p.name || '').toLowerCase();
        const sku = String(p.sku || p.supplier_code || '').toLowerCase();
        const supplier = String(p.supplier || '').toLowerCase();
        return name.includes(q) || sku.includes(q) || supplier.includes(q);
      });
    }
    return list;
  }, [products, subTab, filters, search, effectiveSubTabs, effectiveFilterFacets, facetCategory]);

  // Sub-tab counts (used to badge each tab)
  const groupCounts = useMemo(() => {
    const counts = { all: products.length };
    effectiveSubTabs.forEach(tab => {
      if (tab.key === 'all') return;
      counts[tab.key] = products.filter(p => tab.match ? tab.match(p) : tabMatches(tab, p)).length;
    });
    return counts;
  }, [products, effectiveSubTabs]);

  // ---- Edit modal ----
  const openEdit = (product) => {
    setEditingProduct(product);
    const initial = {};
    effectiveEditFields.forEach(f => { initial[f.key] = product[f.key] ?? ''; });
    initial.description = product.description || '';
    setEditForm(initial);
  };
  const closeEdit = () => { setEditingProduct(null); setEditForm({}); };

  const saveEdit = async () => {
    if (!editingProduct) return;
    setSaving(true);
    try {
      const idField = editingProduct.sku ? 'sku' : 'supplier_code';
      const productId = editingProduct.sku || editingProduct.supplier_code;
      const updates = {};
      Object.entries(editForm).forEach(([k, v]) => {
        if (v !== '' && v !== null && v !== undefined) updates[k] = v;
      });
      if (updates.color) updates.colors = [updates.color];
      const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_ids: [productId], id_field: idField, updates, mode: 'replace' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      if (Array.isArray(result.verification_failures) && result.verification_failures.length > 0) {
        toast.warning(`Saved, but ${result.verification_failures.length} field(s) didn't stick — see console`);
        console.warn(`[${categoryKey} Manager] Verification failures:`, result.verification_failures);
      } else {
        toast.success(`Saved ${editingProduct.our_product_name || productId}`);
      }
      draft.clearDraft();
      closeEdit();
      fetchProducts();
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Draft recovery for the edit form (auto-save every 3s, restore on modal open)
  const draft = useDraftRecovery({
    scope: `manager-edit:${categoryKey}`,
    key: editingProduct ? (editingProduct.sku || editingProduct.supplier_code) : null,
    form: editForm,
    setForm: setEditForm,
    active: !!editingProduct,
  });

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      <ManagerTabsBar
        active={tabsBarActive || categoryKey}
        onNewCustom={() => setBuilderOpen(true)}
        selectionKeys={bulk.selectedProducts && bulk.selectedProducts.size > 0 ? [...bulk.selectedProducts] : null}
        selectionByCategory={bulk.selectedProducts && bulk.selectedProducts.size > 0
          ? bucketSelectionByManager(products, bulk.selectedProducts, (p) => `${p.supplier || 'unknown'}|||${p.sku || p.supplier_code || p._id}`)
          : null}
      />

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/admin" className="text-gray-500 hover:text-gray-700" data-testid={`${categoryKey}-back-link`}>
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${themeCls.headerIcon}`}>
              <Icon className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
              <p className="text-xs text-gray-500">{subtitle} — {products.length} products</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {lastRefresh && (
              <span className="text-xs text-gray-400">Refreshed {lastRefresh.toLocaleTimeString()}</span>
            )}
            <Button size="sm" className={`text-white ${themeCls.ctaBtn}`} onClick={() => setWizardOpen(true)} data-testid={`${categoryKey}-add-new-btn`}>
              <Plus className="w-4 h-4 mr-1.5" /> Add New
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowConfig(true)} data-testid={`${categoryKey}-configure-btn`} title="Add/edit Filters, Sub-Tabs and Spec Fields for this Manager">
              <Settings className="w-4 h-4 mr-1.5" /> Configure
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowCsvImport(true)} data-testid={`${categoryKey}-csv-import-btn`} title="Bulk import products from CSV">
              <FileSpreadsheet className="w-4 h-4 mr-1.5" /> CSV Import
            </Button>
            <Button size="sm" variant="outline" onClick={fetchProducts} disabled={loading} data-testid={`${categoryKey}-refresh-btn`}>
              <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            {extraHeaderActions}
            {showLegacyLink && (
              <Link to="/admin/supplier-products" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                Legacy full editor <ExternalLink className="w-3 h-3" />
              </Link>
            )}
          </div>
        </div>

        {/* Sub-tabs */}
        {effectiveSubTabs.length > 1 && (
          <div className="max-w-7xl mx-auto px-4">
            <div className="flex flex-wrap gap-1 border-b border-gray-100">
              {effectiveSubTabs.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setSubTab(tab.key)}
                  data-testid={`${categoryKey}-tab-${tab.key}`}
                  className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                    subTab === tab.key ? themeCls.tabActive : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {tab.label}
                  <span className={`ml-1.5 text-xs ${subTab === tab.key ? '' : 'text-gray-400'}`}>({groupCounts[tab.key] || 0})</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        {topBanner}
        <div className="bg-white rounded-lg border border-gray-200 p-3 flex items-center gap-3">
          <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <Input
            placeholder="Search by product name, SKU or supplier…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border-0 focus-visible:ring-0 flex-1"
            data-testid={`${categoryKey}-search-input`}
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
          )}
          <Badge variant="outline" className="text-xs" data-testid={`${categoryKey}-visible-count`}>
            {filteredProducts.length} visible
          </Badge>
        </div>

        <ManagerFiltersPanel
          products={products}
          filters={filters}
          onChange={setFilters}
          category={facetCategory}
          themeColor={themeFilter || theme}
          customFacets={effectiveFilterFacets}
        />

        {!hideDefaultBanner && (
          <div className={`rounded-lg p-3 text-sm flex items-start gap-2 border ${themeCls.banner}`}>
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">How this page works</p>
              <ul className="text-xs mt-0.5 space-y-0.5 list-disc list-inside opacity-90">
                {(bannerBullets.length > 0 ? bannerBullets : [
                  'Search or filter to find the product you need.',
                  'Click Edit on a row to change fields — only category-relevant ones show.',
                  'Use + Add New for a brand-new product (opens the Wizard).',
                  'Tick multiple rows to open the Bulk bar (pricing, images, AI, publish, delete).',
                ]).map((b, i) => <li key={i}>{b}</li>)}
              </ul>
            </div>
          </div>
        )}

        {loading ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto text-gray-400" />
            <p className="mt-2 text-sm text-gray-500">Loading {categoryKey}…</p>
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <Filter className="w-6 h-6 mx-auto text-gray-400" />
            <p className="mt-2 text-sm text-gray-500">No {categoryKey} products match your filter.</p>
            <p className="mt-1 text-xs text-gray-400">Products not showing up? Reassign them via the legacy Bulk Editor.</p>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-3 py-2 text-center w-8">
                    <input
                      type="checkbox"
                      checked={filteredProducts.length > 0 && filteredProducts.every(p => bulk.isSelected(p))}
                      onChange={(e) => { if (e.target.checked) bulk.selectAll(filteredProducts); else bulk.clearAll(); }}
                      className="w-4 h-4"
                      data-testid={`${categoryKey}-select-all`}
                    />
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Product</th>
                  {columns.map(c => (
                    <th key={c.key} className="px-3 py-2 text-left font-medium text-gray-700">{c.label}</th>
                  ))}
                  <th className="px-3 py-2 text-right font-medium text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((p) => {
                  const key = `${p.supplier || 'unk'}|||${p.sku || p.supplier_code || p._id}`;
                  const name = p.our_product_name || p.product_name || p.name || '(no name)';
                  return (
                    <tr key={key} className={`border-b border-gray-100 hover:bg-gray-50 ${bulk.isSelected(p) ? themeCls.rowHi : ''}`} data-testid={`${categoryKey}-row-${p.sku || p.supplier_code}`}>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={bulk.isSelected(p)}
                          onChange={() => bulk.toggleProduct(p)}
                          className="w-4 h-4"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-gray-900 line-clamp-1">{name}</div>
                        <div className="text-xs text-gray-500">
                          {p.supplier} · {p.sku || p.supplier_code}
                          {p.published && <CheckCircle className="w-3 h-3 inline ml-1 text-green-500" />}
                        </div>
                      </td>
                      {columns.map(c => (
                        <td key={c.key} className="px-3 py-2 text-gray-700">
                          {c.render ? c.render(p) : (p[c.key] ?? '—')}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => openEdit(p)} data-testid={`${categoryKey}-edit-${p.sku || p.supplier_code}`}>
                          <Edit2 className="w-3 h-3 mr-1" /> Edit
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit modal */}
      <QuickEditProductDrawer
        open={!!editingProduct}
        onOpenChange={(o) => !o && closeEdit()}
        product={editingProduct}
        onSaved={() => { closeEdit(); fetchProducts(); }}
        moreSpecsConfig={config}
      />

      {/* Wizard */}
      <AddProductWizard open={wizardOpen} onOpenChange={setWizardOpen} presetCategory={presetCategory || categoryKey} onSuccess={() => { setWizardOpen(false); fetchProducts(); }} />

      {/* Bulk bar */}
      <ManagerBulkBar
        selectedCount={bulk.selectedProducts.size}
        onClearAll={bulk.clearAll}
        onSelectAll={() => bulk.selectAll(filteredProducts)}
        onBulkPublish={bulk.bulkPublish}
        onBulkUnpublish={bulk.bulkUnpublish}
        onBulkArchive={bulk.bulkArchive}
        onBulkDelete={bulk.bulkDelete}
        onOpenAssignColours={() => setShowAssignColours(true)}
        onOpenTierPricing={() => setShowTierPricing(true)}
        onOpenBulkFields={() => setShowBulkFields(true)}
        onOpenAIDescriptions={() => setShowAIDescriptions(true)}
        onOpenBulkImages={() => setShowBulkImages(true)}
        onOpenSaleLabels={() => setShowBulkSaleLabels(true)}
        onOpenBulkSpecs={() => setShowBulkSpecs(true)}
        onOpenReassignCategory={bulk.bulkAssignCategory}
        saving={bulk.bulkSaving}
        themeColor={bulkBarTheme || theme}
        hideActions={['category']}
      />

      <AssignColoursModal open={showAssignColours} onOpenChange={setShowAssignColours} selectedList={bulk.getSelectedList()} onSuccess={() => { bulk.clearAll(); fetchProducts(); }} />
      <CustomManagerBuilder open={builderOpen} onOpenChange={setBuilderOpen} />
      <BulkFieldsModal open={showBulkFields} onOpenChange={setShowBulkFields} selectedList={bulk.getSelectedList()} themeColor={theme} onSuccess={() => { bulk.clearAll(); fetchProducts(); }} />

      {/* Bulk Specs / Filters / Sub-Categories — driven by the Manager's Configure schema */}
      <BulkSpecsFiltersModal
        open={showBulkSpecs}
        onOpenChange={setShowBulkSpecs}
        config={config}
        selectedProducts={bulk.getSelectedList()}
        categoryLabel={title}
        themeColor={theme}
        onSuccess={() => { bulk.clearAll(); fetchProducts(); }}
      />
      <BulkAIDescriptionsModal open={showAIDescriptions} onOpenChange={setShowAIDescriptions} selectedList={bulk.getSelectedList()} themeColor={theme} onSuccess={() => fetchProducts()} />
      <BulkImageUploadModal open={showBulkImages} onOpenChange={setShowBulkImages} selectedList={bulk.getSelectedList()} themeColor={theme} onSuccess={() => { bulk.clearAll(); fetchProducts(); }} />

      {/* Sale % + Labels (Sale, Clearance, New Arrival, Limited Stock, Best Seller) */}
      <BulkSaleModal
        open={showBulkSaleLabels}
        onOpenChange={setShowBulkSaleLabels}
        selectedProducts={new Set([...bulk.selectedProducts])}
        products={products}
        getProductKey={(p) => `${p.supplier || 'unknown'}|||${p.sku || p.supplier_code || p._id}`}
        form={bulkSaleForm}
        setForm={setBulkSaleForm}
        loading={bulkSaleSaving}
        onApply={async (targetProductKeys) => {
          const selectedList = bulk.getSelectedList();
          const scopedList = (targetProductKeys && targetProductKeys.size > 0)
            ? selectedList.filter(p => targetProductKeys.has(`${p.supplier || 'unknown'}|||${p.sku || p.supplier_code || p._id}`))
            : selectedList;
          if (scopedList.length === 0) return;
          const productIds = scopedList.map(p => ({ sku: p.sku || p.supplier_code || p._id, supplier: p.supplier }));

          setBulkSaleSaving(true);
          try {
            // Labels
            if (bulkSaleForm.labels.length > 0 || bulkSaleForm.custom_labels.length > 0 || bulkSaleForm.action === 'clear') {
              const labelsAction = bulkSaleForm.action === 'clear' ? 'replace' : bulkSaleForm.action;
              await fetch(`${API_URL}/api/supplier-sync/products/bulk-labels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  product_ids: productIds,
                  labels: bulkSaleForm.action === 'clear' ? [] : bulkSaleForm.labels,
                  custom_labels: bulkSaleForm.action === 'clear' ? [] : bulkSaleForm.custom_labels,
                  action: labelsAction,
                }),
              });
            }
            // Sale discount %
            if (bulkSaleForm.applyDiscount && bulkSaleForm.discount_percentage) {
              await fetch(`${API_URL}/api/supplier-sync/products/bulk-sale-pricing`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  product_ids: productIds,
                  discount_percentage: parseFloat(bulkSaleForm.discount_percentage),
                  sale_active: true,
                  clear_sale: false,
                }),
              });
            }
            // Clear-sale action
            if (bulkSaleForm.action === 'clear') {
              await fetch(`${API_URL}/api/supplier-sync/products/bulk-sale-pricing`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ product_ids: productIds, clear_sale: true }),
              });
            }
            toast.success(`Updated ${scopedList.length} product${scopedList.length !== 1 ? 's' : ''}`);
            setShowBulkSaleLabels(false);
            setBulkSaleForm({ labels: [], custom_labels: [], discount_percentage: '', action: 'add', applyDiscount: false });
            bulk.clearAll();
            fetchProducts();
          } catch (err) {
            toast.error(`Sale/Labels update failed: ${err.message}`);
          } finally {
            setBulkSaleSaving(false);
          }
        }}
      />

      <CsvImportModal
        open={showCsvImport}
        onOpenChange={setShowCsvImport}
        category={categoryKey}
        categoryLabel={title}
        themeColor={theme}
        onSuccess={() => { fetchProducts(); }}
      />

      <ManagerConfigModal
        open={showConfig}
        onOpenChange={setShowConfig}
        slug={categoryKey}
        config={config}
        onSave={saveConfig}
        onRefresh={refreshConfig}
        themeColor={theme}
      />

      <TierPricingModal
        open={showTierPricing}
        onOpenChange={(next) => {
          setShowTierPricing(next);
          if (!next) setTierProductOverrides({});  // reset overrides when the modal closes
        }}
        selectedProducts={new Set([...bulk.selectedProducts])}
        selectedProductsList={bulk.getSelectedList()}
        productOverrides={tierProductOverrides}
        setProductOverrides={setTierProductOverrides}
        pricingSizeFilter="all"
        tierPricingConfig={tierPricingConfig}
        setTierPricingConfig={setTierPricingConfig}
        tierPricingSaving={bulk.bulkSaving}
        onSave={async () => {
          const selectedList = bulk.getSelectedList();
          if (selectedList.length === 0) return;
          try {
            // Merge global settings with per-product overrides. Overrides win row-by-row on the server.
            const payload = selectedList.map(p => {
              const key = `${p.supplier || ''}|||${p.sku || p.supplier_code || ''}`;
              const o = tierProductOverrides[key] || {};
              return {
                supplier: p.supplier,
                sku: p.sku || p.supplier_code,
                ...(o.trade_discount !== undefined ? { trade_discount: o.trade_discount } : {}),
                ...(o.credit_back_rate !== undefined ? { credit_back_rate: o.credit_back_rate } : {}),
                ...(o.disabled !== undefined ? { disabled: o.disabled } : {}),
              };
            });
            const overrideCount = Object.keys(tierProductOverrides).length;
            const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-tier-update`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                products: payload,
                tier_thresholds: tierPricingConfig.thresholds,
                tier_discounts: tierPricingConfig.discounts,
                trade_discount: tierPricingConfig.trade_discount_default,
                trade_discount_type: tierPricingConfig.trade_discount_type || 'percent',
                credit_back_rate: tierPricingConfig.credit_back_default,
                disabled: tierPricingConfig.disabled || false,
                pallet_enabled: !!tierPricingConfig.pallet_enabled,
                pallet_price: tierPricingConfig.pallet_price,
                half_pallet_price: tierPricingConfig.half_pallet_price,
                m2_per_pallet: tierPricingConfig.m2_per_pallet,
                m2_per_half_pallet: tierPricingConfig.m2_per_half_pallet,
              }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const overrideNote = overrideCount > 0 ? ` (${overrideCount} customised)` : '';
            toast.success(`Tier pricing saved: ${data.updated_count || selectedList.length}${overrideNote}`);
            setShowTierPricing(false);
            setTierProductOverrides({});
            fetchProducts();
          } catch (err) { toast.error(`Save failed: ${err.message}`); }
        }}
        getProductsFilteredBySize={() => products}
        getSelectedProductsPricing={() => {
          const list = bulk.getSelectedList();
          const withPrice = list.filter(p => p.list_price || p.retail_price);
          if (withPrice.length === 0) return { avgListPrice: 25, avgCostPrice: 12, minListPrice: 25, maxListPrice: 25, count: 0 };
          const prices = withPrice.map(p => Number(p.list_price || p.retail_price || 0));
          const costs = withPrice.map(p => Number(p.cost_price || 0));
          return {
            avgListPrice: prices.reduce((a, b) => a + b, 0) / prices.length,
            avgCostPrice: costs.reduce((a, b) => a + b, 0) / costs.length,
            minListPrice: Math.min(...prices),
            maxListPrice: Math.max(...prices),
            count: withPrice.length,
          };
        }}
        getFilterDisplayLabel={() => categoryKey}
        overrideListPrice={null}
        overrideCostPrice={null}
        tierProductScope={new Set()}
        selectedPricingUnit={tierPricingDefaults.default_unit || 'unit'}
      />
    </div>
  );
};

export default ManagerPageShell;
