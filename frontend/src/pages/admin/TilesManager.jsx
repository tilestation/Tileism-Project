/**
 * TilesManager — dedicated admin section for wall & floor tiles, mosaics, borders.
 *
 * Sibling of /admin/materials and /admin/supplier-products (legacy).
 * Uses the same shared backend so tier pricing, publish flow, stock, refunds
 * and marketing tools all keep working — this page only affects what the
 * admin *sees and edits*.
 *
 * URL: /admin/tiles
 * Fields shown per product: Size, Thickness, Material, Finish, Rectified,
 * Slip Rating, Edge, Type, Colour, Suitability.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Square, ArrowLeft, RefreshCw, Search, Save, X, Edit2, Filter, ExternalLink, AlertCircle, CheckCircle, Plus,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../components/ui/dialog';
import AddProductWizard from './components/AddProductWizard';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Tile sub-tabs — read from product `type` or `sub_categories`
const TILE_SUB_TABS = [
  { key: 'all', label: 'All Tiles', match: () => true },
  { key: 'floor', label: 'Floor', match: (t, sc) => /floor/i.test(t || '') || sc.some(s => /floor tile|floor tiles/i.test(s)) },
  { key: 'wall', label: 'Wall', match: (t, sc) => /wall/i.test(t || '') || sc.some(s => /wall tile|wall tiles/i.test(s)) },
  { key: 'mosaic', label: 'Mosaic', match: (t, sc) => /mosaic/i.test(t || '') || sc.some(s => /mosaic/i.test(s)) },
  { key: 'feature', label: 'Feature', match: (t, sc) => /feature|border/i.test(t || '') || sc.some(s => /feature|border/i.test(s)) },
];

const isTile = (p) => {
  const grp = String(p.product_group || '').toLowerCase();
  const mainCat = String(p.main_category || '').toLowerCase();
  const subCats = Array.isArray(p.sub_categories) ? p.sub_categories : [];
  if (grp === 'tiles' || mainCat === 'tiles') return true;
  return subCats.some(sc => /tile|mosaic|border/i.test(String(sc)));
};

const TilesManager = () => {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [subTab, setSubTab] = useState('all');
  const [editingProduct, setEditingProduct] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products/all?limit=5000`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const all = Array.isArray(data) ? data : (data.products || []);
      const tiles = all.filter(isTile);
      setProducts(tiles);
      setLastRefresh(new Date());
    } catch (err) {
      console.error('TilesManager: fetch failed', err);
      toast.error(`Failed to load tiles: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  // Auto-open the edit modal for a specific SKU when routed from legacy editor
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
    const tab = TILE_SUB_TABS.find(t => t.key === subTab) || TILE_SUB_TABS[0];
    if (subTab !== 'all') {
      list = list.filter(p => tab.match(p.type, Array.isArray(p.sub_categories) ? p.sub_categories : []));
    }
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
  }, [products, subTab, search]);

  const groupCounts = useMemo(() => {
    const counts = { all: products.length };
    TILE_SUB_TABS.forEach(tab => {
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
      material: product.material || '',
      finish: product.finish || '',
      slip_rating: product.slip_rating || '',
      edge: product.edge || '',
      type: product.type || '',
      color: product.color || (Array.isArray(product.colors) && product.colors[0]) || '',
      suitability: product.suitability || '',
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
        console.warn('[Tiles Manager] Verification failures:', result.verification_failures);
      } else {
        toast.success(`Saved ${editingProduct.our_product_name || editingProduct.product_name || productId}`);
      }
      closeEdit();
      fetchProducts();
    } catch (err) {
      console.error('TilesManager: save failed', err);
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/admin" className="text-gray-500 hover:text-gray-700" data-testid="tiles-back-link">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div className="w-10 h-10 rounded-lg bg-blue-100 text-blue-600 flex items-center justify-center">
              <Square className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-gray-900">Tiles Manager</h1>
              <p className="text-xs text-gray-500">Wall &amp; floor tiles, mosaics, borders — {products.length} products</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {lastRefresh && (
              <span className="text-xs text-gray-400" data-testid="tiles-last-refresh">
                Refreshed {lastRefresh.toLocaleTimeString()}
              </span>
            )}
            <Button
              size="sm"
              className="bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => setWizardOpen(true)}
              data-testid="tiles-add-new-btn"
            >
              <Plus className="w-4 h-4 mr-1.5" />
              Add New Tile
            </Button>
            <Button size="sm" variant="outline" onClick={fetchProducts} disabled={loading} data-testid="tiles-refresh-btn">
              <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Link
              to="/admin/supplier-products"
              className="text-xs text-blue-600 hover:underline flex items-center gap-1"
              data-testid="tiles-legacy-link"
            >
              Legacy full editor <ExternalLink className="w-3 h-3" />
            </Link>
          </div>
        </div>

        {/* Sub-tabs */}
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex flex-wrap gap-1 border-b border-gray-100">
            {TILE_SUB_TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => setSubTab(tab.key)}
                data-testid={`tiles-tab-${tab.key}`}
                className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                  subTab === tab.key ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab.label}
                <span className={`ml-1.5 text-xs ${subTab === tab.key ? 'text-blue-500' : 'text-gray-400'}`}>
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
            data-testid="tiles-search-input"
          />
          {search && (
            <button onClick={() => setSearch('')} className="text-gray-400 hover:text-gray-600" data-testid="tiles-search-clear">
              <X className="w-4 h-4" />
            </button>
          )}
          <Badge variant="outline" className="text-xs" data-testid="tiles-visible-count">
            {filteredProducts.length} visible
          </Badge>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-800 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">How this page works</p>
            <ul className="text-xs text-blue-700 mt-0.5 space-y-0.5 list-disc list-inside">
              <li><strong>Search or filter</strong> to find a tile (Floor, Wall, Mosaic, Feature).</li>
              <li>Click <strong>Edit</strong> on a row to change fields — only tile-relevant ones show.</li>
              <li>Use <strong>+ Add New Tile</strong> for a brand-new product (opens the 3-step Wizard).</li>
              <li>Tier pricing, publish, stock &amp; refund flows still work through the shared backend.</li>
              <li>Products save with <strong>100% verification</strong> — any field that didn&apos;t stick is flagged immediately.</li>
            </ul>
          </div>
        </div>

        {loading ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <RefreshCw className="w-6 h-6 animate-spin mx-auto text-gray-400" />
            <p className="mt-2 text-sm text-gray-500">Loading tiles…</p>
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <Filter className="w-6 h-6 mx-auto text-gray-400" />
            <p className="mt-2 text-sm text-gray-500">No tiles match your filter.</p>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Product</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Size</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Thickness</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Material</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Finish</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Slip</th>
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
                    <tr key={key} className="border-b border-gray-100 hover:bg-gray-50" data-testid={`tiles-row-${p.sku || p.supplier_code}`}>
                      <td className="px-3 py-2">
                        <div className="font-medium text-gray-900 line-clamp-1">{name}</div>
                        <div className="text-xs text-gray-500">
                          {p.supplier} · {p.sku || p.supplier_code}
                          {p.published && <CheckCircle className="w-3 h-3 inline ml-1 text-green-500" />}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-gray-700">{p.size || '—'}</td>
                      <td className="px-3 py-2 text-gray-700">{p.thickness || '—'}</td>
                      <td className="px-3 py-2 text-gray-700">{p.material || '—'}</td>
                      <td className="px-3 py-2 text-gray-700">{p.finish || '—'}</td>
                      <td className="px-3 py-2 text-gray-700">{p.slip_rating || '—'}</td>
                      <td className="px-3 py-2 text-gray-700">{colour}</td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => openEdit(p)} data-testid={`tiles-edit-${p.sku || p.supplier_code}`}>
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
            <TileField label="Size" hint="e.g., 600x600, 300x600">
              <Input value={editForm.size || ''} onChange={(e) => setEditForm(prev => ({ ...prev, size: e.target.value }))} data-testid="tiles-edit-size" />
            </TileField>
            <TileField label="Thickness" hint="e.g., 10mm">
              <Input value={editForm.thickness || ''} onChange={(e) => setEditForm(prev => ({ ...prev, thickness: e.target.value }))} data-testid="tiles-edit-thickness" />
            </TileField>
            <TileField label="Material">
              <select
                value={editForm.material || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, material: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                data-testid="tiles-edit-material"
              >
                <option value="">— select —</option>
                {['Porcelain','Ceramic','Natural Stone','Glass','Mosaic'].map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </TileField>
            <TileField label="Finish">
              <select
                value={editForm.finish || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, finish: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                data-testid="tiles-edit-finish"
              >
                <option value="">— select —</option>
                {['Matt','Polished','Satin','Textured','Semi-polished','Rustic'].map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </TileField>
            <TileField label="Slip Rating">
              <select
                value={editForm.slip_rating || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, slip_rating: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                data-testid="tiles-edit-slip"
              >
                <option value="">— select —</option>
                {['R9','R10','R11','R12','R13'].map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </TileField>
            <TileField label="Edge">
              <select
                value={editForm.edge || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, edge: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                data-testid="tiles-edit-edge"
              >
                <option value="">— select —</option>
                {['Rectified','Non-rectified','Bevelled'].map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </TileField>
            <TileField label="Tile Type">
              <select
                value={editForm.type || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, type: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
                data-testid="tiles-edit-type"
              >
                <option value="">— select —</option>
                {['Floor Tile','Wall Tile','Floor & Wall','Mosaic','Feature','Border'].map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </TileField>
            <TileField label="Colour" hint="e.g., Grey, White, Beige">
              <Input value={editForm.color || ''} onChange={(e) => setEditForm(prev => ({ ...prev, color: e.target.value }))} data-testid="tiles-edit-color" />
            </TileField>
            <TileField label="Suitability" hint="Indoor / Outdoor / Wet area" className="col-span-2">
              <Input value={editForm.suitability || ''} onChange={(e) => setEditForm(prev => ({ ...prev, suitability: e.target.value }))} data-testid="tiles-edit-suitability" />
            </TileField>
            <TileField label="Made In" className="col-span-2">
              <Input value={editForm.made_in || ''} onChange={(e) => setEditForm(prev => ({ ...prev, made_in: e.target.value }))} data-testid="tiles-edit-made-in" />
            </TileField>
            <TileField label="Short Description" className="col-span-2">
              <textarea
                value={editForm.description || ''}
                onChange={(e) => setEditForm(prev => ({ ...prev, description: e.target.value }))}
                rows={3}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                data-testid="tiles-edit-description"
              />
            </TileField>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeEdit} disabled={saving}>Cancel</Button>
            <Button onClick={saveEdit} disabled={saving} className="bg-blue-600 hover:bg-blue-700 text-white" data-testid="tiles-edit-save">
              {saving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Product Wizard — preset to tiles */}
      <AddProductWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        presetCategory="tiles"
        onSuccess={() => { setWizardOpen(false); fetchProducts(); }}
      />
    </div>
  );
};

const TileField = ({ label, hint, children, className = '' }) => (
  <div className={className}>
    <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
    {children}
    {hint && <p className="text-[11px] text-gray-400 mt-0.5">{hint}</p>}
  </div>
);

export default TilesManager;
