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
  ArrowLeft, RefreshCw, Search, Save, X, Edit2, Filter, ExternalLink, AlertCircle, CheckCircle, Plus,
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
import ManagerFiltersPanel, { applyManagerFilters } from './managers/ManagerFiltersPanel';
import CustomManagerBuilder from './managers/CustomManagerBuilder';
import BulkFieldsModal from './managers/BulkFieldsModal';
import BulkAIDescriptionsModal from './managers/BulkAIDescriptionsModal';
import BulkImageUploadModal from './managers/BulkImageUploadModal';
import AssignColoursModal from './managers/AssignColoursModal';
import TierPricingModal from './supplier-products/TierPricingModal';
import { useManagerBulk } from './managers/useManagerBulk';
import { useDraftRecovery } from './managers/useDraftRecovery';

const API_URL = process.env.REACT_APP_BACKEND_URL;

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
  const bulk = useManagerBulk({ products, onRefresh: fetchProducts });

  // Auto-open edit on ?edit=SKU
  useEffect(() => {
    const editSku = searchParams.get('edit');
    if (editSku && products.length > 0) {
      const target = products.find(p => p.sku === editSku || p.supplier_code === editSku);
      if (target) { openEdit(target); setSearchParams({}); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products, searchParams]);

  const filteredProducts = useMemo(() => {
    let list = products;
    // Sub-tab
    const tab = subTabs.find(t => t.key === subTab) || subTabs[0];
    if (subTab !== 'all' && tab) {
      list = list.filter(p => tab.match(p));
    }
    // Facet filters
    list = applyManagerFilters(list, filters, facetCategory);
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
  }, [products, subTab, filters, search, subTabs, facetCategory]);

  // Sub-tab counts
  const groupCounts = useMemo(() => {
    const counts = { all: products.length };
    subTabs.forEach(tab => {
      if (tab.key === 'all') return;
      counts[tab.key] = products.filter(p => tab.match(p)).length;
    });
    return counts;
  }, [products, subTabs]);

  // ---- Edit modal ----
  const openEdit = (product) => {
    setEditingProduct(product);
    const initial = {};
    editFields.forEach(f => { initial[f.key] = product[f.key] ?? ''; });
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
      <ManagerTabsBar active={categoryKey} onNewCustom={() => setBuilderOpen(true)} />

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
            <Button size="sm" variant="outline" onClick={fetchProducts} disabled={loading} data-testid={`${categoryKey}-refresh-btn`}>
              <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Link to="/admin/supplier-products" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
              Legacy full editor <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
        </div>

        {/* Sub-tabs */}
        {subTabs.length > 1 && (
          <div className="max-w-7xl mx-auto px-4">
            <div className="flex flex-wrap gap-1 border-b border-gray-100">
              {subTabs.map(tab => (
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
        />

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
      <Dialog open={!!editingProduct} onOpenChange={(o) => !o && closeEdit()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit — {editingProduct?.our_product_name || editingProduct?.product_name || editingProduct?.name}</DialogTitle>
            <p className="text-xs text-gray-500">{editingProduct?.supplier} · {editingProduct?.sku || editingProduct?.supplier_code}</p>
          </DialogHeader>
          {draft.showRestore && (
            <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-800 text-xs p-2 rounded" data-testid={`${categoryKey}-draft-restore-banner`}>
              <AlertCircle className="w-3.5 h-3.5" />
              <span>You have an unsaved draft for this product from {draft.draftTimeLabel}.</span>
              <Button size="sm" variant="outline" onClick={draft.restore} className="ml-auto" data-testid={`${categoryKey}-draft-restore-btn`}>Restore</Button>
              <Button size="sm" variant="ghost" onClick={draft.dismiss} data-testid={`${categoryKey}-draft-dismiss-btn`}>Dismiss</Button>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4 py-2">
            {editFields.map(f => (
              <div key={f.key} className={f.type === 'textarea' ? 'col-span-2' : ''}>
                <label className="block text-xs font-medium text-gray-700 mb-1">{f.label}</label>
                {f.type === 'textarea' ? (
                  <textarea
                    value={editForm[f.key] || ''}
                    onChange={(e) => setEditForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    data-testid={`${categoryKey}-edit-${f.key}`}
                  />
                ) : f.type === 'select' && Array.isArray(f.options) ? (
                  <select
                    value={editForm[f.key] || ''}
                    onChange={(e) => setEditForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                    data-testid={`${categoryKey}-edit-${f.key}`}
                  >
                    <option value="">— select —</option>
                    {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <Input
                    value={editForm[f.key] || ''}
                    onChange={(e) => setEditForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    type={f.type === 'number' ? 'number' : 'text'}
                    data-testid={`${categoryKey}-edit-${f.key}`}
                  />
                )}
                {f.hint && <p className="text-[11px] text-gray-400 mt-0.5">{f.hint}</p>}
              </div>
            ))}
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">Short Description</label>
              <textarea
                value={editForm.description || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, description: e.target.value }))}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                data-testid={`${categoryKey}-edit-description`}
              />
            </div>
          </div>
          <DialogFooter>
            <div className="text-[11px] text-gray-400 mr-auto flex items-center gap-1" data-testid={`${categoryKey}-draft-status`}>
              {draft.status === 'saved' && <><CheckCircle className="w-3 h-3 text-emerald-500" /> Draft saved</>}
              {draft.status === 'saving' && <><RefreshCw className="w-3 h-3 animate-spin" /> Auto-saving…</>}
            </div>
            <Button
              variant="outline"
              onClick={async () => {
                if (!editingProduct) return;
                const name = window.prompt(`Save "${editingProduct.our_product_name || editingProduct.product_name}" as a template. Template name:`,
                  `${editingProduct.our_product_name || editingProduct.product_name || 'Product'} template`);
                if (!name) return;
                try {
                  const token = localStorage.getItem('token');
                  const res = await fetch(`${API_URL}/api/product-templates/from-product`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                    body: JSON.stringify({ sku: editingProduct.sku || editingProduct.supplier_code, name, product_group: categoryKey }),
                  });
                  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || `HTTP ${res.status}`); }
                  const tpl = await res.json();
                  toast.success(`Saved template "${tpl.name}" — pick it in the Wizard next time`);
                } catch (err) {
                  toast.error(`Failed to save template: ${err.message}`);
                }
              }}
              disabled={saving}
              data-testid={`${categoryKey}-save-as-template`}
            >
              Save as Template
            </Button>
            <Button variant="outline" onClick={closeEdit} disabled={saving}>Cancel</Button>
            <Button onClick={saveEdit} disabled={saving} className={`text-white ${themeCls.ctaBtn}`} data-testid={`${categoryKey}-edit-save`}>
              {saving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
        onOpenReassignCategory={bulk.bulkAssignCategory}
        saving={bulk.bulkSaving}
        themeColor={bulkBarTheme || theme}
        hideActions={['category']}
      />

      <AssignColoursModal open={showAssignColours} onOpenChange={setShowAssignColours} selectedList={bulk.getSelectedList()} onSuccess={() => { bulk.clearAll(); fetchProducts(); }} />
      <CustomManagerBuilder open={builderOpen} onOpenChange={setBuilderOpen} />
      <BulkFieldsModal open={showBulkFields} onOpenChange={setShowBulkFields} selectedList={bulk.getSelectedList()} themeColor={theme} onSuccess={() => { bulk.clearAll(); fetchProducts(); }} />
      <BulkAIDescriptionsModal open={showAIDescriptions} onOpenChange={setShowAIDescriptions} selectedList={bulk.getSelectedList()} themeColor={theme} onSuccess={() => fetchProducts()} />
      <BulkImageUploadModal open={showBulkImages} onOpenChange={setShowBulkImages} selectedList={bulk.getSelectedList()} themeColor={theme} onSuccess={() => { bulk.clearAll(); fetchProducts(); }} />

      <TierPricingModal
        open={showTierPricing}
        onOpenChange={setShowTierPricing}
        selectedProducts={new Set([...bulk.selectedProducts])}
        pricingSizeFilter="all"
        tierPricingConfig={tierPricingConfig}
        setTierPricingConfig={setTierPricingConfig}
        tierPricingSaving={bulk.bulkSaving}
        onSave={async () => {
          const selectedList = bulk.getSelectedList();
          if (selectedList.length === 0) return;
          try {
            const payload = selectedList.map(p => ({ supplier: p.supplier, sku: p.sku || p.supplier_code }));
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
            toast.success(`Tier pricing saved: ${data.updated_count || selectedList.length}`);
            setShowTierPricing(false);
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
