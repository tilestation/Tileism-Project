/**
 * MaterialsManager — dedicated admin section for adhesives, grouts, sealants,
 * cleaning products. Reuses the existing `supplier_products` / `tiles` backend
 * so nothing has to be rebuilt (tier pricing, publish flow, stock, refunds
 * all still work). This page ONLY shows material-relevant fields so admins
 * aren't distracted by tile-only fields (slip rating, rectified, edge etc.).
 *
 * URL: /admin/materials
 * Sibling: /admin/supplier-products (legacy — still available as a fallback)
 *
 * Fields shown per product (material-specific):
 *  - Bag Weight (kg)
 *  - Coverage (m² per bag)
 *  - Setting Time (hours)
 *  - Pot Life (minutes)
 *  - Application Thickness (mm)
 *  - VOC rating
 *  - Suitability (Indoor / Outdoor / Wet room)
 *  - Bag Colour (for identification only — Pink/Red/Green bag)
 *  - Colour (product colour, e.g. Grey / White)
 *
 * NEXT SESSION: Add category-specific product form ("Add New Adhesive"),
 * split into Adhesives / Grouts / Sealants / Cleaning tabs, bulk sub-cat editor.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Package, ArrowLeft, RefreshCw, Search, Save, X, Edit2, Filter, ExternalLink, AlertCircle, CheckCircle, Plus, Settings, FileSpreadsheet,
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
import CsvImportModal from './components/managers/CsvImportModal';
import AssignColoursModal from './components/managers/AssignColoursModal';
import TierPricingModal from './components/supplier-products/TierPricingModal';
import { useManagerBulk, getProductKey } from './components/managers/useManagerBulk';
import { useDraftRecovery } from './components/managers/useDraftRecovery';
import { useManagerConfig } from './components/managers/useManagerConfig';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Material sub-categories that qualify a product for this manager
const MATERIAL_SUBCATS = [
  'adhesive', 'adhesives', 'flexible adhesive', 'rapid adhesive',
  'grout', 'grouts', 'wall grout', 'floor grout', 'epoxy grout',
  'sealant', 'sealants', 'silicone',
  'cleaning', 'cleaner', 'cleaning & maintenance',
  'primer', 'primers',
  'levelling compound', 'self-levelling',
];

const MATERIAL_SUB_TABS = [
  { key: 'all', label: 'All Materials', match: () => true },
  { key: 'adhesives', label: 'Adhesives', match: (s) => /adhesive|primer/i.test(s) },
  { key: 'grouts', label: 'Grouts', match: (s) => /grout/i.test(s) },
  { key: 'sealants', label: 'Sealants', match: (s) => /sealant|silicone/i.test(s) },
  { key: 'cleaning', label: 'Cleaning', match: (s) => /clean/i.test(s) },
  { key: 'other', label: 'Other', match: (s) => /levelling|primer|underlay/i.test(s) },
];

const MaterialsManager = () => {
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
  
  // Bulk operation state (multi-select, publish, unpublish, archive, assign colours,
  // tier pricing) — provided by the shared useManagerBulk hook so every Manager
  // shares the same implementation and hits the same backend endpoints.
  const bulk = useManagerBulk({ products, onRefresh: () => fetchProducts() });
  const [showAssignColours, setShowAssignColours] = useState(false);
  const [showTierPricing, setShowTierPricing] = useState(false);
  const [showBulkFields, setShowBulkFields] = useState(false);
  const [showAIDescriptions, setShowAIDescriptions] = useState(false);
  const [showBulkImages, setShowBulkImages] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const [showCsvImport, setShowCsvImport] = useState(false);
  const { config: managerConfig, save: saveManagerConfig, refresh: refreshManagerConfig } = useManagerConfig('materials');
  const effectiveFilterFacets = Array.isArray(managerConfig?.filter_facets) && managerConfig.filter_facets.length > 0 ? managerConfig.filter_facets : null;
  const [tierPricingConfig, setTierPricingConfig] = useState({
    thresholds: [10, 50, 100],
    discounts: [0, 5, 10, 15],
    custom_quote_threshold: 150,
    trade_discount_default: 2,
    trade_discount_type: 'fixed',    // Materials default to £/unit
    credit_back_default: 2,
    pallet_enabled: false,
    pallet_price: null,
    half_pallet_price: null,
    m2_per_pallet: null,
    m2_per_half_pallet: null,
  });

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch all supplier products via the paginated /products endpoint
      // (asking for a big limit so we get everything up to 5000). The endpoint
      // returns {products: [...], total: N} and includes product_group /
      // main_category / pricing_unit so our filter below is reliable.
      const res = await fetch(`${API_URL}/api/supplier-sync/products?limit=5000`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const all = data.products || [];
      const materials = all.filter(p => {
        const group = String(p.product_group || '').toLowerCase();
        const mainCat = String(p.main_category || '').toLowerCase();
        const subCats = Array.isArray(p.sub_categories) ? p.sub_categories : [];
        if (group === 'materials' || mainCat === 'materials') return true;
        return subCats.some(sc => MATERIAL_SUBCATS.some(m => String(sc).toLowerCase().includes(m)));
      });
      setProducts(materials);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('MaterialsManager: fetch failed', err);
      toast.error(`Failed to load materials: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // Auto-open the edit modal for a specific SKU when routed here from the
  // legacy Bulk Editor via /admin/materials?edit=SKU.
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

  const filteredProducts = useMemo(() => {
    let list = products;
    // Sub-tab filter
    const tab = MATERIAL_SUB_TABS.find(t => t.key === subTab) || MATERIAL_SUB_TABS[0];
    if (subTab !== 'all') {
      list = list.filter(p => {
        const scs = Array.isArray(p.sub_categories) ? p.sub_categories : [];
        return scs.some(sc => tab.match(String(sc)));
      });
    }
    // Facet filters (Colour, Bag Colour, Suitability, Supplier, Status)
    list = applyManagerFilters(list, filters, 'materials', effectiveFilterFacets);
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
  }, [products, subTab, filters, search]);

  const groupCounts = useMemo(() => {
    const counts = { all: products.length };
    MATERIAL_SUB_TABS.forEach(tab => {
      if (tab.key === 'all') return;
      counts[tab.key] = products.filter(p => {
        const scs = Array.isArray(p.sub_categories) ? p.sub_categories : [];
        return scs.some(sc => tab.match(String(sc)));
      }).length;
    });
    return counts;
  }, [products]);

  const openEdit = (product) => {
    setEditingProduct(product);
    setEditForm({
      // Material-specific fields
      bag_weight_kg: product.bag_weight_kg ?? product.bag_weight ?? '',
      coverage_m2_per_bag: product.coverage_m2_per_bag ?? product.coverage ?? '',
      setting_time_hours: product.setting_time_hours ?? product.setting_time ?? '',
      pot_life_minutes: product.pot_life_minutes ?? product.pot_life ?? '',
      application_thickness_mm: product.application_thickness_mm ?? product.application_thickness ?? '',
      voc_rating: product.voc_rating ?? '',
      bag_colour: product.bag_colour ?? '',
      // Standard fields
      color: product.color || (Array.isArray(product.colors) && product.colors[0]) || '',
      suitability: product.suitability || '',
      description: product.description || '',
    });
  };

  const closeEdit = () => {
    setEditingProduct(null);
    setEditForm({});
  };

  const saveEdit = async () => {
    if (!editingProduct) return;
    setSaving(true);
    try {
      const idField = editingProduct.sku ? 'sku' : 'supplier_code';
      const productId = editingProduct.sku || editingProduct.supplier_code;
      const updates = {};
      // Only include non-empty values so we don't overwrite good data with empty strings
      Object.entries(editForm).forEach(([k, v]) => {
        if (v !== '' && v !== null && v !== undefined) {
          updates[k] = v;
        }
      });
      // If colour was set, also sync to the array field so storefront picks it up
      if (updates.color) {
        updates.colors = [updates.color];
      }

      const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_ids: [productId],
          id_field: idField,
          updates,
          mode: 'replace',
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      const verFailed = Array.isArray(result.verification_failures) && result.verification_failures.length > 0;
      if (verFailed) {
        toast.warning(
          `Saved, but ${result.verification_failures.length} field(s) didn't stick — see console for details`,
          { duration: 12000 }
        );
        console.warn('[Materials Manager] Verification failures:', result.verification_failures);
      } else {
        toast.success(`Saved ${editingProduct.our_product_name || editingProduct.product_name || productId}`);
      }
      closeEdit();
      fetchProducts();
    } catch (err) {
      console.error('MaterialsManager: save failed', err);
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      {/* Workspace tabs (unified across Managers) */}
      <ManagerTabsBar active="materials" onNewCustom={() => setBuilderOpen(true)} />

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/admin" className="text-gray-500 hover:text-gray-700" data-testid="materials-back-link">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div className="w-10 h-10 rounded-lg bg-orange-100 text-orange-600 flex items-center justify-center">
              <Package className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Materials Manager</h1>
              <p className="text-xs text-gray-500">Adhesives, grouts, sealants, cleaning &amp; primers — {products.length} products</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {lastRefresh && (
              <span className="text-xs text-gray-400" data-testid="materials-last-refresh">
                Refreshed {lastRefresh.toLocaleTimeString()}
              </span>
            )}
            <Button
              size="sm"
              className="bg-orange-600 hover:bg-orange-700 text-white"
              onClick={() => setWizardOpen(true)}
              data-testid="materials-add-new-btn"
            >
              <Plus className="w-4 h-4 mr-1.5" />
              Add New Material
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowConfig(true)} data-testid="materials-configure-btn" title="Add/edit Filters, Sub-Tabs and Spec Fields for Materials">
              <Settings className="w-4 h-4 mr-1.5" /> Configure
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowCsvImport(true)} data-testid="materials-csv-import-btn" title="Bulk import Materials from CSV">
              <FileSpreadsheet className="w-4 h-4 mr-1.5" /> CSV Import
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={fetchProducts}
              disabled={loading}
              data-testid="materials-refresh-btn"
            >
              <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Link
              to="/admin/supplier-products"
              className="text-xs text-blue-600 hover:underline flex items-center gap-1"
              data-testid="materials-legacy-link"
            >
              Legacy full editor <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
        </div>

        {/* Sub-tabs */}
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex flex-wrap gap-1 border-b border-gray-100">
            {MATERIAL_SUB_TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => setSubTab(tab.key)}
                data-testid={`materials-tab-${tab.key}`}
                className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                  subTab === tab.key
                    ? 'border-orange-500 text-orange-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab.label}
                <span className={`ml-1.5 text-xs ${subTab === tab.key ? 'text-orange-500' : 'text-gray-400'}`}>
                  ({groupCounts[tab.key] || 0})
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        {/* Search bar */}
        <div className="bg-white rounded-lg border border-gray-200 p-3 flex items-center gap-3">
          <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <Input
            placeholder="Search by product name, SKU or supplier…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border-0 focus-visible:ring-0 flex-1"
            data-testid="materials-search-input"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-gray-400 hover:text-gray-600" data-testid="materials-search-clear">
              <X className="w-4 h-4" />
            </button>
          )}
          <Badge variant="outline" className="text-xs" data-testid="materials-visible-count">
            {filteredProducts.length} visible
          </Badge>
        </div>

        {/* Filters (facet-driven, honours admin-configured facets) */}
        <ManagerFiltersPanel
          products={products}
          filters={filters}
          onChange={setFilters}
          category="materials"
          themeColor="orange"
          customFacets={effectiveFilterFacets}
        />

        {/* Info banner */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">How this page works</p>
            <ul className="text-xs text-blue-700 mt-0.5 space-y-0.5 list-disc list-inside">
              <li><strong>Search or filter</strong> to find a material (Adhesives, Grouts, Sealants, Cleaning).</li>
              <li>Click <strong>Edit</strong> on a row to change fields — only material-relevant ones show.</li>
              <li>Use <strong>+ Add New Material</strong> for a brand-new product (opens the 3-step Wizard).</li>
              <li>Tier pricing, publish, stock &amp; refund flows still work through the shared backend.</li>
              <li>Products save with <strong>100% verification</strong> — any field that didn&apos;t stick is flagged immediately.</li>
            </ul>
          </div>
        </div>

        {/* Product list */}
        {loading ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto text-gray-400" />
            <p className="mt-2 text-sm text-gray-500">Loading materials…</p>
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <Filter className="w-6 h-6 mx-auto text-gray-400" />
            <p className="mt-2 text-sm text-gray-500">No materials match your filter.</p>
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
                      onChange={(e) => {
                        if (e.target.checked) bulk.selectAll(filteredProducts);
                        else bulk.clearAll();
                      }}
                      className="w-4 h-4 accent-orange-600"
                      data-testid="materials-select-all"
                      title="Select all visible"
                    />
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Product</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Colour</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Coverage</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Bag Wt.</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Setting</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Suitability</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Sub-cat</th>
                  <th className="px-3 py-2 text-right font-medium text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.map((p) => {
                  const key = `${p.supplier || 'unk'}|||${p.sku || p.supplier_code || p._id}`;
                  const name = p.our_product_name || p.product_name || p.name || '(no name)';
                  const colour = p.color || (Array.isArray(p.colors) && p.colors[0]) || '—';
                  const coverage = p.coverage_m2_per_bag ?? p.coverage ?? '—';
                  const bagWt = p.bag_weight_kg ?? p.bag_weight ?? '—';
                  const setTime = p.setting_time_hours ?? p.setting_time ?? '—';
                  const suit = p.suitability || '—';
                  const subCats = (p.sub_categories || []).filter(sc =>
                    MATERIAL_SUBCATS.some(m => String(sc).toLowerCase().includes(m))
                  );
                  return (
                    <tr key={key} className={`border-b border-gray-100 hover:bg-gray-50 ${bulk.isSelected(p) ? 'bg-orange-50' : ''}`} data-testid={`materials-row-${p.sku || p.supplier_code}`}>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={bulk.isSelected(p)}
                          onChange={() => bulk.toggleProduct(p)}
                          className="w-4 h-4 accent-orange-600"
                          data-testid={`materials-select-${p.sku || p.supplier_code}`}
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
                      <td className="px-3 py-2 text-gray-700">{coverage !== '—' ? `${coverage} m²` : coverage}</td>
                      <td className="px-3 py-2 text-gray-700">{bagWt !== '—' ? `${bagWt} kg` : bagWt}</td>
                      <td className="px-3 py-2 text-gray-700">{setTime !== '—' ? `${setTime} h` : setTime}</td>
                      <td className="px-3 py-2 text-gray-700 text-xs">{suit}</td>
                      <td className="px-3 py-2 text-xs">
                        {subCats.length > 0 ? (
                          <div className="flex flex-wrap gap-0.5">
                            {subCats.slice(0, 2).map((sc, i) => (
                              <Badge key={i} variant="outline" className="text-[10px] py-0 px-1">{sc}</Badge>
                            ))}
                            {subCats.length > 2 && <span className="text-gray-400">+{subCats.length - 2}</span>}
                          </div>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => openEdit(p)}
                          data-testid={`materials-edit-${p.sku || p.supplier_code}`}
                        >
                          <Edit2 className="w-3 h-3 mr-1" />
                          Edit
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
            <FormField label="Colour" hint="e.g. Grey / White / Beige">
              <Input
                value={editForm.color || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, color: e.target.value }))}
                data-testid="materials-edit-color"
              />
            </FormField>
            <FormField label="Bag Colour" hint="Pink / Red / Green (for identification)">
              <Input
                value={editForm.bag_colour || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, bag_colour: e.target.value }))}
                data-testid="materials-edit-bag-colour"
              />
            </FormField>
            <FormField label="Bag Weight (kg)">
              <Input
                type="number"
                step="0.5"
                value={editForm.bag_weight_kg || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, bag_weight_kg: e.target.value }))}
                data-testid="materials-edit-bag-weight"
              />
            </FormField>
            <FormField label="Coverage (m² per bag)">
              <Input
                type="number"
                step="0.1"
                value={editForm.coverage_m2_per_bag || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, coverage_m2_per_bag: e.target.value }))}
                data-testid="materials-edit-coverage"
              />
            </FormField>
            <FormField label="Setting Time (hours)">
              <Input
                type="number"
                step="0.5"
                value={editForm.setting_time_hours || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, setting_time_hours: e.target.value }))}
                data-testid="materials-edit-setting-time"
              />
            </FormField>
            <FormField label="Pot Life (minutes)">
              <Input
                type="number"
                value={editForm.pot_life_minutes || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, pot_life_minutes: e.target.value }))}
                data-testid="materials-edit-pot-life"
              />
            </FormField>
            <FormField label="Application Thickness (mm)" hint="e.g. 3-15 or 6">
              <Input
                value={editForm.application_thickness_mm || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, application_thickness_mm: e.target.value }))}
                data-testid="materials-edit-thickness"
              />
            </FormField>
            <FormField label="VOC Rating" hint="e.g. Low, EC1 Plus">
              <Input
                value={editForm.voc_rating || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, voc_rating: e.target.value }))}
                data-testid="materials-edit-voc"
              />
            </FormField>
            <FormField label="Suitability" hint="Indoor / Outdoor / Wet room / Underfloor heating" className="col-span-2">
              <Input
                value={editForm.suitability || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, suitability: e.target.value }))}
                data-testid="materials-edit-suitability"
              />
            </FormField>
            <FormField label="Short Description" className="col-span-2">
              <textarea
                value={editForm.description || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, description: e.target.value }))}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-orange-500 focus:border-transparent"
                data-testid="materials-edit-description"
              />
            </FormField>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeEdit} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={saveEdit}
              disabled={saving}
              className="bg-orange-600 hover:bg-orange-700 text-white"
              data-testid="materials-edit-save"
            >
              {saving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Product Wizard — preset to materials */}
      <AddProductWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        presetCategory="materials"
        onSuccess={() => { setWizardOpen(false); fetchProducts(); }}
      />

      {/* Floating Quick Actions Bar — appears when any product is selected */}
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
        hideActions={['category']} /* categories & filters modal — coming Session B */
      />

      {/* Bulk: Assign Colours (per-value scoping) */}
      <AssignColoursModal
        open={showAssignColours}
        onOpenChange={setShowAssignColours}
        selectedList={bulk.getSelectedList()}
        onSuccess={() => { bulk.clearAll(); fetchProducts(); }}
      />

      {/* Custom Manager builder — opens from workspace tabs "+ New" */}
      <CustomManagerBuilder open={builderOpen} onOpenChange={setBuilderOpen} />

      {/* Bulk: Price / Cost / Stock */}
      <BulkFieldsModal
        open={showBulkFields}
        onOpenChange={setShowBulkFields}
        selectedList={bulk.getSelectedList()}
        themeColor="orange"
        onSuccess={() => { bulk.clearAll(); fetchProducts(); }}
      />

      {/* Bulk: AI Descriptions */}
      <BulkAIDescriptionsModal
        open={showAIDescriptions}
        onOpenChange={setShowAIDescriptions}
        selectedList={bulk.getSelectedList()}
        themeColor="orange"
        onSuccess={() => { fetchProducts(); }}
      />

      {/* Bulk: Image Upload */}
      <BulkImageUploadModal
        open={showBulkImages}
        onOpenChange={setShowBulkImages}
        selectedList={bulk.getSelectedList()}
        themeColor="orange"
        onSuccess={() => { bulk.clearAll(); fetchProducts(); }}
      />

      {/* Per-Manager Config (Filters / Sub-Tabs / Spec Fields) */}
      <ManagerConfigModal
        open={showConfig}
        onOpenChange={setShowConfig}
        slug="materials"
        config={managerConfig}
        onSave={saveManagerConfig}
        onRefresh={refreshManagerConfig}
        themeColor="orange"
      />

      {/* Bulk CSV Import (tailored to Materials columns) */}
      <CsvImportModal
        open={showCsvImport}
        onOpenChange={setShowCsvImport}
        category="materials"
        categoryLabel="Materials Manager"
        themeColor="orange"
        onSuccess={() => { fetchProducts(); }}
      />

      {/* Bulk: Tier Pricing (% / £ trade + Half+Full Pallet, unit-aware for materials) */}
      <TierPricingModal
        open={showTierPricing}
        onOpenChange={setShowTierPricing}
        selectedProducts={new Set([...bulk.selectedProducts])}
        pricingSizeFilter="all"
        tierPricingConfig={tierPricingConfig}
        setTierPricingConfig={setTierPricingConfig}
        tierPricingSaving={bulk.bulkSaving}
        onSave={async () => {
          // Reuse the same bulk-tier-update endpoint the legacy editor uses
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
            toast.success(`Tier pricing saved: ${data.updated_count || selectedList.length} product(s)`);
            setShowTierPricing(false);
            fetchProducts();
          } catch (err) {
            toast.error(`Save failed: ${err.message}`);
          }
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
        getFilterDisplayLabel={() => 'materials'}
        overrideListPrice={null}
        overrideCostPrice={null}
        tierProductScope={new Set()}
        selectedPricingUnit="unit"
      />
    </div>
  );
};

const FormField = ({ label, hint, children, className = '' }) => (
  <div className={className}>
    <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
    {children}
    {hint && <p className="text-[11px] text-gray-400 mt-0.5">{hint}</p>}
  </div>
);

export default MaterialsManager;
