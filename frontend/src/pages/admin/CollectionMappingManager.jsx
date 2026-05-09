import React, { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  Search,
  Save,
  Trash2,
  Edit,
  X,
  Loader2,
  Package,
  Image,
  Star,
  Eye,
  EyeOff,
  ChevronRight,
  ChevronDown,
  Filter,
  CheckSquare,
  Square,
  ArrowRight,
  Sparkles,
  Users,
  Link2,
  Unlink
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { toast } from 'sonner';
import { normaliseImageUrl } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL || '';

export default function CollectionMappingManager({ embedded = false }) {
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedCollection, setSelectedCollection] = useState(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showProductsPanel, setShowProductsPanel] = useState(false);
  const [showAddProductsModal, setShowAddProductsModal] = useState(false);

  const fetchCollections = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/collection-mappings`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setCollections(data.collections || []);
      }
    } catch (error) {
      console.error('Error fetching collections:', error);
      toast.error('Failed to load collections');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCollections();
  }, [fetchCollections]);

  const handleSelectCollection = (collection) => {
    setSelectedCollection(collection);
    setShowProductsPanel(true);
  };

  return (
    <div className="h-full flex flex-col" data-testid="collection-mapping-manager">
      {/* Header */}
      <div className={`${embedded ? 'px-4 py-3' : 'p-6'} border-b bg-white`}>
        <div className="flex items-center justify-between">
          {!embedded && (
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Collection Mapping</h1>
              <p className="text-gray-500 mt-1">Create collections and assign products manually or with auto-rules</p>
            </div>
          )}
          <Button onClick={() => setShowCreateModal(true)}>
            <Plus className="w-4 h-4 mr-2" />
            New Collection
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Collections List */}
        <div className={`${showProductsPanel ? 'w-1/3' : 'w-full'} border-r overflow-auto bg-gray-50 p-4`}>
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
            </div>
          ) : collections.length === 0 ? (
            <div className="text-center py-20">
              <Package className="w-16 h-16 mx-auto text-gray-300 mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">No Collections Yet</h3>
              <p className="text-gray-500 mb-4">Create your first collection to start organizing products</p>
              <Button onClick={() => setShowCreateModal(true)}>
                <Plus className="w-4 h-4 mr-2" />
                Create Collection
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {collections.map((collection) => (
                <CollectionListItem
                  key={collection.id}
                  collection={collection}
                  isSelected={selectedCollection?.id === collection.id}
                  onClick={() => handleSelectCollection(collection)}
                  onRefresh={fetchCollections}
                />
              ))}
            </div>
          )}
        </div>

        {/* Products Panel */}
        {showProductsPanel && selectedCollection && (
          <div className="flex-1 overflow-hidden flex flex-col bg-white">
            <CollectionProductsPanel
              collection={selectedCollection}
              onClose={() => {
                setShowProductsPanel(false);
                setSelectedCollection(null);
              }}
              onAddProducts={() => setShowAddProductsModal(true)}
              onRefresh={fetchCollections}
            />
          </div>
        )}
      </div>

      {/* Create Collection Modal */}
      {showCreateModal && (
        <CreateCollectionModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            fetchCollections();
          }}
        />
      )}

      {/* Add Products Modal */}
      {showAddProductsModal && selectedCollection && (
        <AddProductsModal
          collection={selectedCollection}
          onClose={() => setShowAddProductsModal(false)}
          onAdded={() => {
            setShowAddProductsModal(false);
            fetchCollections();
          }}
        />
      )}
    </div>
  );
}

// Collection List Item Component
function CollectionListItem({ collection, isSelected, onClick, onRefresh }) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (e) => {
    e.stopPropagation();
    if (!window.confirm(`Delete "${collection.name}"? This will remove all product mappings.`)) return;
    
    setDeleting(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/collection-mappings/${collection.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        toast.success('Collection deleted');
        onRefresh();
      }
    } catch (error) {
      toast.error('Failed to delete collection');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      onClick={onClick}
      className={`p-4 rounded-lg border cursor-pointer transition-all ${
        isSelected 
          ? 'bg-blue-50 border-blue-300 shadow-sm' 
          : 'bg-white border-gray-200 hover:border-gray-300 hover:shadow-sm'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Thumbnail */}
        <div className="w-14 h-14 rounded-lg overflow-hidden bg-gray-100 flex-shrink-0">
          {collection.hero_image ? (
            <img src={normaliseImageUrl(collection.hero_image)} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-400">
              <Image className="w-6 h-6" />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-900 truncate">{collection.name}</h3>
            {collection.is_featured && (
              <Star className="w-4 h-4 text-amber-500 fill-amber-500" />
            )}
          </div>
          
          <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
            <span className="flex items-center gap-1">
              <Users className="w-3 h-3" />
              {collection.manual_product_count} manual
            </span>
            {collection.auto_rules?.length > 0 && (
              <span className="flex items-center gap-1">
                <Sparkles className="w-3 h-3" />
                {collection.auto_product_count} auto
              </span>
            )}
          </div>

          {/* Auto Rules Preview */}
          {collection.auto_rules?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {collection.auto_rules.slice(0, 3).map((rule, idx) => (
                <span key={idx} className="px-2 py-0.5 text-xs bg-purple-100 text-purple-700 rounded">
                  {rule}
                </span>
              ))}
              {collection.auto_rules.length > 3 && (
                <span className="px-2 py-0.5 text-xs bg-gray-100 text-gray-600 rounded">
                  +{collection.auto_rules.length - 3} more
                </span>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1">
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          </button>
          <ChevronRight className={`w-5 h-5 text-gray-400 transition-transform ${isSelected ? 'rotate-90' : ''}`} />
        </div>
      </div>
    </div>
  );
}

// Collection Products Panel
function CollectionProductsPanel({ collection, onClose, onAddProducts, onRefresh }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const params = new URLSearchParams({ page, limit: 30, search });
      const res = await fetch(
        `${API_URL}/api/website-admin/collection-mappings/${collection.id}/products?${params}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (res.ok) {
        const data = await res.json();
        setProducts(data.products || []);
        setTotalPages(data.pages || 1);
      }
    } catch (error) {
      console.error('Error fetching products:', error);
    } finally {
      setLoading(false);
    }
  }, [collection.id, page, search]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  const handleRemoveProduct = async (productId, exclude = false) => {
    try {
      const token = localStorage.getItem('token');
      const url = `${API_URL}/api/website-admin/collection-mappings/${collection.id}/products/${productId}${exclude ? '?exclude=true' : ''}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        toast.success(exclude ? 'Product excluded' : 'Product removed');
        fetchProducts();
        onRefresh();
      }
    } catch (error) {
      toast.error('Failed to remove product');
    }
  };

  return (
    <>
      {/* Panel Header */}
      <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-gray-900">{collection.name}</h2>
          <p className="text-sm text-gray-500">
            {collection.manual_product_count} manual + {collection.auto_product_count} auto-detected products
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={onAddProducts} size="sm">
            <Plus className="w-4 h-4 mr-1" />
            Add Products
          </Button>
          <button onClick={onClose} className="p-2 hover:bg-gray-200 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="p-4 border-b">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            placeholder="Search products..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="pl-10"
          />
        </div>
      </div>

      {/* Products List */}
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          </div>
        ) : products.length === 0 ? (
          <div className="text-center py-10 text-gray-500">
            No products in this collection yet
          </div>
        ) : (
          <div className="space-y-2">
            {products.map((product) => (
              <div
                key={product.id}
                className={`flex items-center gap-3 p-3 rounded-lg border ${
                  product.is_manual ? 'bg-blue-50 border-blue-200' : 'bg-white border-gray-200'
                }`}
              >
                {/* Thumbnail */}
                <div className="w-12 h-12 rounded overflow-hidden bg-gray-100 flex-shrink-0">
                  {product.image ? (
                    <img src={normaliseImageUrl(product.image)} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-400">
                      <Image className="w-5 h-5" />
                    </div>
                  )}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-gray-900 truncate">{product.name}</p>
                  <div className="flex items-center gap-2 text-sm text-gray-500">
                    <span>{product.sku}</span>
                    {product.price && <span>£{product.price.toFixed(2)}</span>}
                  </div>
                </div>

                {/* Badge */}
                {product.is_manual ? (
                  <span className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded flex items-center gap-1">
                    <Link2 className="w-3 h-3" />
                    Manual
                  </span>
                ) : (
                  <span className="px-2 py-1 text-xs bg-purple-100 text-purple-700 rounded flex items-center gap-1">
                    <Sparkles className="w-3 h-3" />
                    Auto
                  </span>
                )}

                {/* Remove Button */}
                <button
                  onClick={() => handleRemoveProduct(product.id, !product.is_manual)}
                  className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded"
                  title={product.is_manual ? 'Remove from collection' : 'Exclude from auto-detection'}
                >
                  <Unlink className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="p-4 border-t flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage(p => p - 1)}
          >
            Previous
          </Button>
          <span className="text-sm text-gray-500">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </>
  );
}

// Create Collection Modal
function CreateCollectionModal({ onClose, onCreated }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [autoRules, setAutoRules] = useState(['']);
  const [saving, setSaving] = useState(false);

  const handleAddRule = () => {
    setAutoRules([...autoRules, '']);
  };

  const handleRemoveRule = (index) => {
    setAutoRules(autoRules.filter((_, i) => i !== index));
  };

  const handleRuleChange = (index, value) => {
    const newRules = [...autoRules];
    newRules[index] = value;
    setAutoRules(newRules);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Collection name is required');
      return;
    }

    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/collection-mappings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          auto_rules: autoRules.filter(r => r.trim())
        })
      });

      if (res.ok) {
        toast.success('Collection created!');
        onCreated();
      } else {
        const error = await res.json();
        toast.error(error.detail || 'Failed to create collection');
      }
    } catch (error) {
      toast.error('Failed to create collection');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-auto">
        <div className="p-6 border-b">
          <h2 className="text-xl font-bold text-gray-900">Create New Collection</h2>
          <p className="text-gray-500 mt-1">Define a collection and set auto-detection rules</p>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Collection Name *
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Marble Collection"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description..."
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
              rows={2}
            />
          </div>

          {/* Auto Rules */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Auto-Detection Rules
              <span className="text-gray-400 font-normal ml-2">
                (Products matching these patterns will be auto-added)
              </span>
            </label>
            <div className="space-y-2">
              {autoRules.map((rule, idx) => (
                <div key={idx} className="flex gap-2">
                  <Input
                    value={rule}
                    onChange={(e) => handleRuleChange(idx, e.target.value)}
                    placeholder="e.g., Marble, Carrara, Calacatta"
                  />
                  {autoRules.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleRemoveRule(idx)}
                      className="p-2 text-red-500 hover:bg-red-50 rounded"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={handleAddRule}
                className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1"
              >
                <Plus className="w-4 h-4" />
                Add another rule
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Products with names containing these patterns will be automatically included.
              Manual assignments will override auto-detection.
            </p>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Create Collection
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Add Products Modal
function AddProductsModal({ collection, onClose, onAdded }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [supplier, setSupplier] = useState('');
  const [suppliers, setSuppliers] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [adding, setAdding] = useState(false);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const params = new URLSearchParams({ page, limit: 30, search, supplier });
      const res = await fetch(
        `${API_URL}/api/website-admin/collection-mappings/available-products?${params}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (res.ok) {
        const data = await res.json();
        setProducts(data.products || []);
        setTotalPages(data.pages || 1);
        if (data.suppliers) setSuppliers(data.suppliers);
      }
    } catch (error) {
      console.error('Error fetching products:', error);
    } finally {
      setLoading(false);
    }
  }, [page, search, supplier]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  const toggleSelect = (id) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === products.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(products.map(p => p.id)));
    }
  };

  const handleAddSelected = async () => {
    if (selectedIds.size === 0) {
      toast.error('No products selected');
      return;
    }

    setAdding(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(
        `${API_URL}/api/website-admin/collection-mappings/${collection.id}/products`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ product_ids: Array.from(selectedIds) })
        }
      );

      if (res.ok) {
        const data = await res.json();
        toast.success(`Added ${data.added} products to collection`);
        onAdded();
      }
    } catch (error) {
      toast.error('Failed to add products');
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="p-6 border-b flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Add Products to {collection.name}</h2>
            <p className="text-gray-500 mt-1">Search and select products to add manually</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-gray-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Filters */}
        <div className="p-4 border-b flex gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              placeholder="Search by name or SKU..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="pl-10"
            />
          </div>
          <select
            value={supplier}
            onChange={(e) => { setSupplier(e.target.value); setPage(1); }}
            className="px-3 py-2 border rounded-lg bg-white"
          >
            <option value="">All Suppliers</option>
            {suppliers.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        {/* Selection Info */}
        <div className="px-4 py-2 bg-blue-50 border-b flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={toggleSelectAll}
              className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
            >
              {selectedIds.size === products.length && products.length > 0 ? (
                <CheckSquare className="w-4 h-4" />
              ) : (
                <Square className="w-4 h-4" />
              )}
              Select All
            </button>
            <span className="text-sm text-gray-600">
              {selectedIds.size} product{selectedIds.size !== 1 ? 's' : ''} selected
            </span>
          </div>
          <Button
            onClick={handleAddSelected}
            disabled={selectedIds.size === 0 || adding}
            size="sm"
          >
            {adding ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <ArrowRight className="w-4 h-4 mr-2" />}
            Add to Collection
          </Button>
        </div>

        {/* Products List */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : products.length === 0 ? (
            <div className="text-center py-10 text-gray-500">
              No products found
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {products.map((product) => (
                <div
                  key={product.id}
                  onClick={() => toggleSelect(product.id)}
                  className={`p-3 rounded-lg border cursor-pointer transition-all ${
                    selectedIds.has(product.id)
                      ? 'bg-blue-50 border-blue-300 ring-2 ring-blue-200'
                      : 'bg-white border-gray-200 hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    {/* Checkbox */}
                    <div className={`w-5 h-5 rounded border flex items-center justify-center ${
                      selectedIds.has(product.id) ? 'bg-blue-500 border-blue-500' : 'border-gray-300'
                    }`}>
                      {selectedIds.has(product.id) && (
                        <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>

                    {/* Thumbnail */}
                    <div className="w-14 h-14 rounded overflow-hidden bg-gray-100 flex-shrink-0">
                      {product.image ? (
                        <img src={normaliseImageUrl(product.image)} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400">
                          <Image className="w-5 h-5" />
                        </div>
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 text-sm truncate">{product.name}</p>
                      <p className="text-xs text-gray-500 truncate">{product.sku}</p>
                      {product.supplier && (
                        <p className="text-xs text-gray-400 truncate">{product.supplier}</p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="p-4 border-t flex items-center justify-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
            >
              Previous
            </Button>
            <span className="text-sm text-gray-500">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
