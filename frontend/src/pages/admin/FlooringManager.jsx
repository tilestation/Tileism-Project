/**
 * FlooringManager — LVT, laminate, engineered wood, vinyl.
 * Follows the same pattern as TilesManager but with flooring-specific fields
 * (plank/tile size, wear layer, click system, underlay compatibility, colour).
 *
 * Reuses the shared Managers scaffolding — ManagerTabsBar, ManagerFiltersPanel,
 * ManagerBulkBar, useManagerBulk, AssignColoursModal, TierPricingModal,
 * BulkFieldsModal, BulkAIDescriptionsModal, AddProductWizard.
 *
 * URL: /admin/flooring
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Grid3X3, ArrowLeft, RefreshCw, Search, Save, X, Edit2, Filter, ExternalLink, AlertCircle, CheckCircle, Plus, Settings,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../components/ui/dialog';

import AddProductWizard from './components/AddProductWizard';
import ManagerBulkBar from './components/managers/ManagerBulkBar';
import ManagerTabsBar from './components/managers/ManagerTabsBar';
import ManagerFiltersPanel, { applyManagerFilters } from './components/managers/ManagerFiltersPanel';
import CustomManagerBuilder from './components/managers/CustomManagerBuilder';
import BulkFieldsModal from './components/managers/BulkFieldsModal';
import BulkAIDescriptionsModal from './components/managers/BulkAIDescriptionsModal';
import BulkImageUploadModal from './components/managers/BulkImageUploadModal';
import ManagerConfigModal from './components/managers/ManagerConfigModal';
import AssignColoursModal from './components/managers/AssignColoursModal';
import TierPricingModal from './components/supplier-products/TierPricingModal';
import { useManagerBulk } from './components/managers/useManagerBulk';
import { useManagerConfig } from './components/managers/useManagerConfig';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const FLOOR_SUB_TABS = [
  { key: 'all',     label: 'All Flooring', match: () => true },
  { key: 'lvt',     label: 'LVT',          match: (t, sc) => /lvt|luxury vinyl/i.test(t || '') || sc.some(s => /lvt|luxury vinyl/i.test(s)) },
  { key: 'laminate', label: 'Laminate',    match: (t, sc) => /laminate/i.test(t || '') || sc.some(s => /laminate/i.test(s)) },
  { key: 'wood',    label: 'Wood',         match: (t, sc) => /(engineered|solid)? ?wood/i.test(t || '') || sc.some(s => /wood|engineered/i.test(s)) },
  { key: 'vinyl',   label: 'Vinyl',        match: (t, sc) => /vinyl/i.test(t || '') || sc.some(s => /vinyl/i.test(s)) },
];

const isFlooring = (p) => {
  const grp = String(p.product_group || '').toLowerCase();
  const mainCat = String(p.main_category || '').toLowerCase();
  const subCats = Array.isArray(p.sub_categories) ? p.sub_categories : [];
  if (grp === 'flooring' || mainCat === 'flooring') return true;
  return subCats.some(sc => /flooring|lvt|laminate|engineered|vinyl|luxury vinyl/i.test(String(sc)));
};

const FlooringManager = () => {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [subTab, setSubTab] = useState('all');
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
  const [showConfig, setShowConfig] = useState(false);
  const { config: managerConfig, save: saveManagerConfig } = useManagerConfig('flooring');
  const effectiveFilterFacets = Array.isArray(managerConfig?.filter_facets) && managerConfig.filter_facets.length > 0 ? managerConfig.filter_facets : null;
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

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products?limit=5000`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const all = data.products || [];
      const flooring = all.filter(isFlooring);
      setProducts(flooring);
      setLastRefresh(new Date());
    } catch (err) {
      toast.error(`Failed to load flooring: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  const bulk = useManagerBulk({ products, onRefresh: fetchProducts });

  useEffect(() => {
    const editSku = searchParams.get('edit');
    if (editSku && products.length > 0) {
      const target = products.find(p => p.sku === editSku || p.supplier_code === editSku);
      if (target) { openEdit(target); setSearchParams({}); }
    }
  }, [products, searchParams, setSearchParams]);

  const filteredProducts = useMemo(() => {
    let list = products;
    const tab = FLOOR_SUB_TABS.find(t => t.key === subTab) || FLOOR_SUB_TABS[0];
    if (subTab !== 'all') {
      list = list.filter(p => tab.match(p.type, Array.isArray(p.sub_categories) ? p.sub_categories : []));
    }
    list = applyManagerFilters(list, filters, 'tiles', effectiveFilterFacets);
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
  }, [products, subTab, filters, search]);

  const groupCounts = useMemo(() => {
    const counts = { all: products.length };
    FLOOR_SUB_TABS.forEach(tab => {
      if (tab.key === 'all') return;
      counts[tab.key] = products.filter(p => tab.match(p.type, Array.isArray(p.sub_categories) ? p.sub_categories : [])).length;
    });
    return counts;
  }, [products]);

  const openEdit = (product) => {
    setEditingProduct(product);
    setEditForm({
      size: product.size || '',
      thickness: product.thickness || '',
      wear_layer: product.wear_layer || '',
      finish: product.finish || '',
      click_system: product.click_system || '',
      underlay_included: product.underlay_included || '',
      material: product.material || '',
      color: product.color || (Array.isArray(product.colors) && product.colors[0]) || '',
      suitability: product.suitability || '',
      pack_coverage: product.pack_coverage || '',
      made_in: product.made_in || '',
      description: product.description || '',
    });
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
        console.warn('[Flooring Manager] Verification failures:', result.verification_failures);
      } else {
        toast.success(`Saved ${editingProduct.our_product_name || productId}`);
      }
      closeEdit();
      fetchProducts();
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      <ManagerTabsBar active="flooring" onNewCustom={() => setBuilderOpen(true)} />

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/admin" className="text-gray-500 hover:text-gray-700" data-testid="flooring-back-link">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div className="w-10 h-10 rounded-lg bg-amber-100 text-amber-600 flex items-center justify-center">
              <Grid3X3 className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Flooring Manager</h1>
              <p className="text-xs text-gray-500">LVT, laminate, engineered wood, vinyl — {products.length} products</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {lastRefresh && (
              <span className="text-xs text-gray-400">Refreshed {lastRefresh.toLocaleTimeString()}</span>
            )}
            <Button
              size="sm"
              className="bg-amber-600 hover:bg-amber-700 text-white"
              onClick={() => setWizardOpen(true)}
              data-testid="flooring-add-new-btn"
            >
              <Plus className="w-4 h-4 mr-1.5" />
              Add New Flooring
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowConfig(true)} data-testid="flooring-configure-btn" title="Add/edit Filters, Sub-Tabs and Spec Fields for Flooring">
              <Settings className="w-4 h-4 mr-1.5" /> Configure
            </Button>
            <Button size="sm" variant="outline" onClick={fetchProducts} disabled={loading} data-testid="flooring-refresh-btn">
              <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Link to="/admin/supplier-products" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
              Legacy full editor <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
        </div>

        {/* Sub-tabs */}
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex flex-wrap gap-1 border-b border-gray-100">
            {FLOOR_SUB_TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => setSubTab(tab.key)}
                data-testid={`flooring-tab-${tab.key}`}
                className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                  subTab === tab.key ? 'border-amber-500 text-amber-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab.label}
                <span className={`ml-1.5 text-xs ${subTab === tab.key ? 'text-amber-500' : 'text-gray-400'}`}>
                  ({groupCounts[tab.key] || 0})
                </span>
              </button>
            ))}
          </div>
        </div>
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
            data-testid="flooring-search-input"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-gray-400 hover:text-gray-600">
              <X className="w-4 h-4" />
            </button>
          )}
          <Badge variant="outline" className="text-xs" data-testid="flooring-visible-count">
            {filteredProducts.length} visible
          </Badge>
        </div>

        <ManagerFiltersPanel
          products={products}
          filters={filters}
          onChange={setFilters}
          category="tiles"
          themeColor="orange"
          customFacets={effectiveFilterFacets}
        />

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">How this page works</p>
            <ul className="text-xs text-amber-700 mt-0.5 space-y-0.5 list-disc list-inside">
              <li><strong>Search or filter</strong> to find a floor (LVT, Laminate, Wood, Vinyl).</li>
              <li>Click <strong>Edit</strong> on a row to change fields — only flooring-relevant ones show.</li>
              <li>Use <strong>+ Add New Flooring</strong> for a brand-new product (opens the Wizard).</li>
              <li>Tier pricing, publish, stock &amp; refund flows still work through the shared backend.</li>
            </ul>
          </div>
        </div>

        {loading ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto text-gray-400" />
            <p className="mt-2 text-sm text-gray-500">Loading flooring…</p>
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <Filter className="w-6 h-6 mx-auto text-gray-400" />
            <p className="mt-2 text-sm text-gray-500">No flooring products match your filter.</p>
            <p className="mt-1 text-xs text-gray-400">
              Products not showing up? Reassign them via the legacy Bulk Editor or the <em>Assign Category</em> button.
            </p>
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
                      className="w-4 h-4 accent-amber-600"
                      data-testid="flooring-select-all"
                    />
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Product</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Size</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Thickness</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Wear Layer</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Finish</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Colour</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((p) => {
                  const key = `${p.supplier || 'unk'}|||${p.sku || p.supplier_code || p._id}`;
                  const name = p.our_product_name || p.product_name || p.name || '(no name)';
                  const colour = p.color || (Array.isArray(p.colors) && p.colors[0]) || '—';
                  return (
                    <tr key={key} className={`border-b border-gray-100 hover:bg-gray-50 ${bulk.isSelected(p) ? 'bg-amber-50' : ''}`} data-testid={`flooring-row-${p.sku || p.supplier_code}`}>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={bulk.isSelected(p)}
                          onChange={() => bulk.toggleProduct(p)}
                          className="w-4 h-4 accent-amber-600"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium text-gray-900 line-clamp-1">{name}</div>
                        <div className="text-xs text-gray-500">
                          {p.supplier} · {p.sku || p.supplier_code}
                          {p.published && <CheckCircle className="w-3 h-3 inline ml-1 text-green-500" />}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-gray-700">{p.size || '—'}</td>
                      <td className="px-3 py-2 text-gray-700">{p.thickness || '—'}</td>
                      <td className="px-3 py-2 text-gray-700">{p.wear_layer || '—'}</td>
                      <td className="px-3 py-2 text-gray-700">{p.finish || '—'}</td>
                      <td className="px-3 py-2 text-gray-700">{colour}</td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => openEdit(p)} data-testid={`flooring-edit-${p.sku || p.supplier_code}`}>
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
          <div className="grid grid-cols-2 gap-4 py-2">
            {[
              { key: 'size',              label: 'Size',                 hint: 'e.g., 1220x180mm' },
              { key: 'thickness',         label: 'Thickness',            hint: 'e.g., 8mm' },
              { key: 'wear_layer',        label: 'Wear Layer',           hint: 'e.g., 0.5mm' },
              { key: 'finish',            label: 'Finish' },
              { key: 'click_system',      label: 'Click System',         hint: 'e.g., Uniclic, DropLock, Angle-Angle' },
              { key: 'underlay_included', label: 'Underlay Included',    hint: 'yes / no / bundled' },
              { key: 'material',          label: 'Material',             hint: 'LVT, Laminate, Engineered Wood, Vinyl' },
              { key: 'color',             label: 'Colour' },
              { key: 'pack_coverage',     label: 'Pack Coverage (m²)',   hint: 'e.g., 2.20' },
              { key: 'suitability',       label: 'Suitability',          hint: 'Indoor / Wet room / Underfloor Heat' },
              { key: 'made_in',           label: 'Made In' },
            ].map(f => (
              <div key={f.key}>
                <label className="block text-xs font-medium text-gray-700 mb-1">{f.label}</label>
                <Input value={editForm[f.key] || ''} onChange={(e) => setEditForm(prev => ({ ...prev, [f.key]: e.target.value }))} data-testid={`flooring-edit-${f.key}`} />
                {f.hint && <p className="text-[11px] text-gray-400 mt-0.5">{f.hint}</p>}
              </div>
            ))}
            <div className="col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">Short Description</label>
              <textarea
                value={editForm.description || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, description: e.target.value }))}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                data-testid="flooring-edit-description"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeEdit} disabled={saving}>Cancel</Button>
            <Button onClick={saveEdit} disabled={saving} className="bg-amber-600 hover:bg-amber-700 text-white" data-testid="flooring-edit-save">
              {saving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Product Wizard */}
      <AddProductWizard open={wizardOpen} onOpenChange={setWizardOpen} presetCategory="flooring" onSuccess={() => { setWizardOpen(false); fetchProducts(); }} />

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
        themeColor="orange"
        hideActions={['category']}
      />

      <AssignColoursModal open={showAssignColours} onOpenChange={setShowAssignColours} selectedList={bulk.getSelectedList()} onSuccess={() => { bulk.clearAll(); fetchProducts(); }} />
      <CustomManagerBuilder open={builderOpen} onOpenChange={setBuilderOpen} />
      <BulkFieldsModal open={showBulkFields} onOpenChange={setShowBulkFields} selectedList={bulk.getSelectedList()} themeColor="orange" onSuccess={() => { bulk.clearAll(); fetchProducts(); }} />
      <BulkAIDescriptionsModal open={showAIDescriptions} onOpenChange={setShowAIDescriptions} selectedList={bulk.getSelectedList()} themeColor="orange" onSuccess={() => { fetchProducts(); }} />
      <BulkImageUploadModal open={showBulkImages} onOpenChange={setShowBulkImages} selectedList={bulk.getSelectedList()} themeColor="amber" onSuccess={() => { bulk.clearAll(); fetchProducts(); }} />

      {/* Per-Manager Config (Filters / Sub-Tabs / Spec Fields) */}
      <ManagerConfigModal open={showConfig} onOpenChange={setShowConfig} slug="flooring" config={managerConfig} onSave={saveManagerConfig} themeColor="amber" />

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
          if (withPrice.length === 0) return { avgListPrice: 35, avgCostPrice: 18, minListPrice: 35, maxListPrice: 35, count: 0 };
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
        getFilterDisplayLabel={() => 'flooring'}
        overrideListPrice={null}
        overrideCostPrice={null}
        tierProductScope={new Set()}
        selectedPricingUnit="m2"
      />
    </div>
  );
};

export default FlooringManager;
