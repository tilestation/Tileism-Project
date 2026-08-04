/**
 * CustomManager — generic Manager page rendered from a `manager_definitions`
 * doc. Reuses the same shared pieces every hardcoded Manager uses:
 *  - ManagerTabsBar (workspace tabs)
 *  - ManagerFiltersPanel + applyManagerFilters (facets)
 *  - ManagerBulkBar (multi-select, publish, archive, colours, tier pricing)
 *  - AssignColoursModal + TierPricingModal
 *  - useManagerBulk hook
 *
 * URL: /admin/custom-manager/:slug
 * Reads its config live from /api/manager-definitions/:slug, then filters
 * products whose sub_categories match any of the definition's keywords.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft, RefreshCw, Search, Save, X, Edit2, Filter as FilterIcon, ExternalLink,
  Plus, Sparkles, Settings, Trash2, AlertCircle, CheckCircle,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../components/ui/dialog';

import ManagerTabsBar from './components/managers/ManagerTabsBar';
import ManagerFiltersPanel, { applyManagerFilters } from './components/managers/ManagerFiltersPanel';
import ManagerBulkBar from './components/managers/ManagerBulkBar';
import AssignColoursModal from './components/managers/AssignColoursModal';
import CustomManagerBuilder from './components/managers/CustomManagerBuilder';
import BulkFieldsModal from './components/managers/BulkFieldsModal';
import BulkAIDescriptionsModal from './components/managers/BulkAIDescriptionsModal';
import BulkImageUploadModal from './components/managers/BulkImageUploadModal';
import TierPricingModal from './components/supplier-products/TierPricingModal';
import AddProductWizard from './components/AddProductWizard';
import { useManagerBulk } from './components/managers/useManagerBulk';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const THEME_TO_TAILWIND = {
  purple:  { text: 'text-purple-700',  bg: 'bg-purple-100',  btn: 'bg-purple-600 hover:bg-purple-700',   focus: 'focus:ring-purple-500' },
  pink:    { text: 'text-pink-700',    bg: 'bg-pink-100',    btn: 'bg-pink-600 hover:bg-pink-700',       focus: 'focus:ring-pink-500' },
  emerald: { text: 'text-emerald-700', bg: 'bg-emerald-100', btn: 'bg-emerald-600 hover:bg-emerald-700', focus: 'focus:ring-emerald-500' },
  amber:   { text: 'text-amber-700',   bg: 'bg-amber-100',   btn: 'bg-amber-600 hover:bg-amber-700',     focus: 'focus:ring-amber-500' },
  cyan:    { text: 'text-cyan-700',    bg: 'bg-cyan-100',    btn: 'bg-cyan-600 hover:bg-cyan-700',       focus: 'focus:ring-cyan-500' },
  red:     { text: 'text-red-700',     bg: 'bg-red-100',     btn: 'bg-red-600 hover:bg-red-700',         focus: 'focus:ring-red-500' },
  slate:   { text: 'text-slate-700',   bg: 'bg-slate-100',   btn: 'bg-slate-700 hover:bg-slate-800',     focus: 'focus:ring-slate-500' },
};

const CustomManager = () => {
  const { slug } = useParams();
  const [definition, setDefinition] = useState(null);
  const [defLoading, setDefLoading] = useState(true);
  const [defError, setDefError] = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState({});
  const [editingProduct, setEditingProduct] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [showAssignColours, setShowAssignColours] = useState(false);
  const [showTierPricing, setShowTierPricing] = useState(false);
  const [showBulkFields, setShowBulkFields] = useState(false);
  const [showAIDescriptions, setShowAIDescriptions] = useState(false);
  const [showBulkImages, setShowBulkImages] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
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
  });
  const navigate = useNavigate();

  // ---- Load definition ----
  const fetchDefinition = useCallback(async () => {
    setDefLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/manager-definitions/${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error(res.status === 404 ? 'This custom Manager doesn\'t exist' : `HTTP ${res.status}`);
      const def = await res.json();
      setDefinition(def);
      setDefError(null);
    } catch (err) {
      setDefError(err.message);
    } finally {
      setDefLoading(false);
    }
  }, [slug]);

  useEffect(() => { fetchDefinition(); }, [fetchDefinition]);

  // ---- Load products ----
  const fetchProducts = useCallback(async () => {
    if (!definition) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products?limit=5000`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const all = data.products || [];
      const cleaned = all.filter(p => matchesDefinition(p, definition));
      setProducts(cleaned);
    } catch (err) {
      toast.error(`Failed to load products: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [definition]);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  const bulk = useManagerBulk({ products, onRefresh: fetchProducts });

  const filteredProducts = useMemo(() => {
    let list = applyManagerFilters(products, filters, 'custom');
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
  }, [products, filters, search]);

  // Auto-open edit when routed with ?edit=SKU
  useEffect(() => {
    const editSku = searchParams.get('edit');
    if (editSku && products.length > 0) {
      const target = products.find(p => p.sku === editSku || p.supplier_code === editSku);
      if (target) {
        openEdit(target);
        setSearchParams({});
      }
    }
  }, [products, searchParams, setSearchParams]);

  // ---- Edit dialog ----
  const fieldDefs = useMemo(() => {
    if (definition?.field_definitions?.length) return definition.field_definitions;
    // Fall back to a universal 6-field set
    return [
      { key: 'color',       label: 'Colour',      type: 'text' },
      { key: 'size',        label: 'Size',        type: 'text' },
      { key: 'material',    label: 'Material',    type: 'text' },
      { key: 'finish',      label: 'Finish',      type: 'text' },
      { key: 'suitability', label: 'Suitability', type: 'text' },
      { key: 'description', label: 'Description', type: 'textarea' },
    ];
  }, [definition]);

  const openEdit = (p) => {
    setEditingProduct(p);
    const initial = {};
    fieldDefs.forEach(f => {
      initial[f.key] = p[f.key] ?? '';
    });
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
      const verFailed = Array.isArray(result.verification_failures) && result.verification_failures.length > 0;
      if (verFailed) {
        toast.warning(`Saved, but ${result.verification_failures.length} field(s) didn't stick — see console`);
        console.warn('[Custom Manager] Verification failures:', result.verification_failures);
      } else {
        toast.success(`Saved`);
      }
      closeEdit();
      fetchProducts();
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // ---- Delete this Manager ----
  const [confirmDelete, setConfirmDelete] = useState(false);
  const handleDeleteManager = async () => {
    if (!definition) return;
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/manager-definitions/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`Deleted Manager "${definition.name}"`);
      navigate('/admin/supplier-products');
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
    }
  };

  // -------- render --------
  if (defLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <ManagerTabsBar active={`custom:${slug}`} onNewCustom={() => setBuilderOpen(true)} />
        <div className="max-w-7xl mx-auto px-4 py-12 text-center">
          <RefreshCw className="w-6 h-6 mx-auto animate-spin text-gray-400" />
          <p className="mt-2 text-sm text-gray-500">Loading Manager…</p>
        </div>
      </div>
    );
  }

  if (defError || !definition) {
    return (
      <div className="min-h-screen bg-gray-50">
        <ManagerTabsBar active={`custom:${slug}`} onNewCustom={() => setBuilderOpen(true)} />
        <div className="max-w-md mx-auto mt-16 bg-white border border-red-200 rounded-lg p-8 text-center">
          <AlertCircle className="w-8 h-8 mx-auto text-red-500 mb-2" />
          <p className="text-lg font-semibold text-red-700">{defError || 'Manager not found'}</p>
          <p className="text-xs text-gray-500 mt-1">Slug: <code>{slug}</code></p>
          <div className="mt-4 flex gap-2 justify-center">
            <Link to="/admin/supplier-products">
              <Button variant="outline"><ArrowLeft className="w-4 h-4 mr-1" /> Back to Products</Button>
            </Link>
            <Button onClick={() => setBuilderOpen(true)} className="bg-purple-600 text-white">
              <Plus className="w-4 h-4 mr-1" /> Create a new one
            </Button>
          </div>
        </div>
        <CustomManagerBuilder open={builderOpen} onOpenChange={setBuilderOpen} />
      </div>
    );
  }

  const theme = THEME_TO_TAILWIND[definition.theme] || THEME_TO_TAILWIND.purple;

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      <ManagerTabsBar active={`custom:${slug}`} onNewCustom={() => setBuilderOpen(true)} />

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/admin" className="text-gray-500 hover:text-gray-700" data-testid="custom-manager-back-link">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div className={`w-10 h-10 rounded-lg ${theme.bg} ${theme.text} flex items-center justify-center`}>
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-gray-900" data-testid="custom-manager-title">{definition.name}</h1>
              <p className="text-xs text-gray-500">
                {definition.description || 'Custom Manager'} — {products.length} products
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className={`${theme.btn} text-white`}
              onClick={() => setWizardOpen(true)}
              data-testid="custom-manager-add-btn"
            >
              <Plus className="w-4 h-4 mr-1.5" />
              Add New Product
            </Button>
            <Button size="sm" variant="outline" onClick={fetchProducts} disabled={loading} data-testid="custom-manager-refresh-btn">
              <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              className="text-red-500 hover:text-red-700"
              data-testid="custom-manager-delete-btn"
              title="Delete this custom Manager"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="max-w-7xl mx-auto px-4 py-4 space-y-3">
        {/* Sub-category chips (info) */}
        {definition.sub_categories?.length > 0 && (
          <div className="bg-white border border-gray-200 rounded-lg p-2 flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">
              Auto-included when sub-category matches
            </span>
            {definition.sub_categories.map(sc => (
              <Badge key={sc} variant="outline" className="text-[10px]">{sc}</Badge>
            ))}
          </div>
        )}

        {/* Search bar */}
        <div className="bg-white rounded-lg border border-gray-200 p-3 flex items-center gap-3">
          <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <Input
            placeholder="Search by product name, SKU or supplier…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border-0 focus-visible:ring-0 flex-1"
            data-testid="custom-manager-search"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-gray-400 hover:text-gray-600">
              <X className="w-4 h-4" />
            </button>
          )}
          <Badge variant="outline" className="text-xs">{filteredProducts.length} visible</Badge>
        </div>

        {/* Filters */}
        <ManagerFiltersPanel
          products={products}
          filters={filters}
          onChange={setFilters}
          category="custom"
          themeColor={definition.theme}
        />

        {/* Product table */}
        {loading ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto text-gray-400" />
            <p className="mt-2 text-sm text-gray-500">Loading products…</p>
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <FilterIcon className="w-6 h-6 mx-auto text-gray-400" />
            <p className="mt-2 text-sm text-gray-500">No products match — try adjusting filters or add a new product.</p>
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
                      data-testid="custom-manager-select-all"
                    />
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Product</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Colour</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Supplier</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Sub-cat</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((p) => {
                  const key = `${p.supplier || 'unk'}|||${p.sku || p.supplier_code || p._id}`;
                  const name = p.our_product_name || p.product_name || p.name || '(no name)';
                  const colour = p.color || (Array.isArray(p.colors) && p.colors[0]) || '—';
                  const subCats = (p.sub_categories || []).slice(0, 2);
                  return (
                    <tr key={key} className={`border-b border-gray-100 hover:bg-gray-50 ${bulk.isSelected(p) ? theme.bg : ''}`} data-testid={`custom-manager-row-${p.sku || p.supplier_code}`}>
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
                      <td className="px-3 py-2 text-gray-700">{colour}</td>
                      <td className="px-3 py-2 text-gray-700">{p.supplier || '—'}</td>
                      <td className="px-3 py-2 text-xs">
                        {subCats.length > 0 ? (
                          <div className="flex flex-wrap gap-0.5">
                            {subCats.map((sc, i) => <Badge key={i} variant="outline" className="text-[10px] py-0 px-1">{sc}</Badge>)}
                          </div>
                        ) : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => openEdit(p)} data-testid={`custom-manager-edit-${p.sku || p.supplier_code}`}>
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

      {/* Edit Modal */}
      <Dialog open={!!editingProduct} onOpenChange={(o) => !o && closeEdit()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Edit — {editingProduct?.our_product_name || editingProduct?.product_name || editingProduct?.name}
            </DialogTitle>
            <p className="text-xs text-gray-500">
              {editingProduct?.supplier} · {editingProduct?.sku || editingProduct?.supplier_code}
            </p>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 py-2">
            {fieldDefs.map(f => (
              <div key={f.key} className={f.type === 'textarea' ? 'col-span-2' : ''}>
                <label className="block text-xs font-medium text-gray-700 mb-1">{f.label}</label>
                {f.type === 'textarea' ? (
                  <textarea
                    value={editForm[f.key] || ''}
                    onChange={(e) => setEditForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                    data-testid={`custom-edit-${f.key}`}
                  />
                ) : f.type === 'select' && Array.isArray(f.options) ? (
                  <select
                    value={editForm[f.key] || ''}
                    onChange={(e) => setEditForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                    data-testid={`custom-edit-${f.key}`}
                  >
                    <option value="">— select —</option>
                    {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <Input
                    value={editForm[f.key] || ''}
                    onChange={(e) => setEditForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                    type={f.type === 'number' ? 'number' : 'text'}
                    data-testid={`custom-edit-${f.key}`}
                  />
                )}
                {f.hint && <p className="text-[11px] text-gray-400 mt-0.5">{f.hint}</p>}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeEdit} disabled={saving}>Cancel</Button>
            <Button onClick={saveEdit} disabled={saving} className={`${theme.btn} text-white`} data-testid="custom-manager-edit-save">
              {saving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Wizard */}
      <AddProductWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        presetCategory={definition.product_group || slug}
        onSuccess={() => { setWizardOpen(false); fetchProducts(); }}
      />

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
        themeColor={definition.theme === 'purple' ? 'orange' : definition.theme}
        hideActions={['category']}
      />

      {/* Colours + Tier Pricing */}
      <AssignColoursModal
        open={showAssignColours}
        onOpenChange={setShowAssignColours}
        selectedList={bulk.getSelectedList()}
        onSuccess={() => { bulk.clearAll(); fetchProducts(); }}
      />
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
          const costs = withPrice.map(p => Number(p.cost_price || p.cost_each || 0));
          return {
            avgListPrice: prices.reduce((a, b) => a + b, 0) / prices.length,
            avgCostPrice: costs.reduce((a, b) => a + b, 0) / costs.length,
            minListPrice: Math.min(...prices),
            maxListPrice: Math.max(...prices),
            count: withPrice.length,
          };
        }}
        getFilterDisplayLabel={() => definition.name}
        overrideListPrice={null}
        overrideCostPrice={null}
        tierProductScope={new Set()}
        selectedPricingUnit="unit"
      />

      {/* Delete confirm */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-red-600 flex items-center gap-2">
              <Trash2 className="w-5 h-5" /> Delete &ldquo;{definition.name}&rdquo;?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-700">
            This removes the Manager tab. Products already tagged with this category stay in the database — you can re-classify them anytime.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button className="bg-red-600 hover:bg-red-700 text-white" onClick={handleDeleteManager} data-testid="custom-manager-confirm-delete">
              <Trash2 className="w-4 h-4 mr-1" /> Delete Manager
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CustomManagerBuilder open={builderOpen} onOpenChange={setBuilderOpen} />

      {/* Bulk: Price / Cost / Stock */}
      <BulkFieldsModal
        open={showBulkFields}
        onOpenChange={setShowBulkFields}
        selectedList={bulk.getSelectedList()}
        themeColor={definition.theme || 'purple'}
        onSuccess={() => { bulk.clearAll(); fetchProducts(); }}
      />

      {/* Bulk: AI Descriptions */}
      <BulkAIDescriptionsModal
        open={showAIDescriptions}
        onOpenChange={setShowAIDescriptions}
        selectedList={bulk.getSelectedList()}
        themeColor={definition.theme || 'purple'}
        onSuccess={() => { fetchProducts(); }}
      />

      {/* Bulk: Image Upload */}
      <BulkImageUploadModal
        open={showBulkImages}
        onOpenChange={setShowBulkImages}
        selectedList={bulk.getSelectedList()}
        themeColor={definition.theme || 'purple'}
        onSuccess={() => { bulk.clearAll(); fetchProducts(); }}
      />
    </div>
  );
};

// Classification: a product belongs to a custom Manager if any of its sub_categories
// (or product_group) matches any of the definition's keywords (case-insensitive contains).
function matchesDefinition(p, def) {
  if (!def) return false;
  const group = String(p.product_group || '').toLowerCase();
  if (def.product_group && group === String(def.product_group).toLowerCase()) return true;
  if (def.product_group && group === def.slug.toLowerCase()) return true;
  if (!Array.isArray(def.sub_categories) || def.sub_categories.length === 0) return false;
  const subCats = (Array.isArray(p.sub_categories) ? p.sub_categories : []).map(s => String(s).toLowerCase());
  const nameLc = String(p.our_product_name || p.product_name || p.name || '').toLowerCase();
  return def.sub_categories.some(keyword => {
    const k = String(keyword).toLowerCase();
    return subCats.some(sc => sc.includes(k)) || nameLc.includes(k);
  });
}

export default CustomManager;
