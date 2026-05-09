import React, { useState, useEffect, useCallback } from 'react';
import { Search, Edit2, Plus, Image, X, Save, Trash2, Upload, ChevronLeft, ChevronRight, Eye, EyeOff, Star, StarOff, ExternalLink } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import { toast } from 'sonner';
import { normaliseImageUrl } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const WebsiteProductsEditor = () => {
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [newImageUrl, setNewImageUrl] = useState('');

  // Fetch products
  const fetchProducts = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const params = new URLSearchParams({
        page: currentPage,
        limit: 20,
        ...(searchQuery && { search: searchQuery }),
        ...(statusFilter !== 'all' && { status: statusFilter })
      });

      const res = await fetch(`${API_URL}/api/website-admin/products?${params}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      setProducts(data.products || []);
      setTotalPages(data.pages || 1);
    } catch (e) {
      toast.error('Failed to load products');
    } finally {
      setLoading(false);
    }
  }, [currentPage, searchQuery, statusFilter]);

  // Fetch categories
  const fetchCategories = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/categories`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      setCategories(data);
    } catch (e) {
      console.error('Failed to load categories');
    }
  };

  useEffect(() => {
    fetchProducts();
    fetchCategories();
  }, [fetchProducts]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      setCurrentPage(1);
      fetchProducts();
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const handleSelectProduct = (product) => {
    setSelectedProduct(product);
    setShowCreateForm(false);
    setEditForm({
      website_name: product.website_name || product.name || '',
      description: product.description || '',
      short_description: product.short_description || '',
      seo_title: product.seo_title || '',
      seo_description: product.seo_description || '',
      category_ids: product.category_ids || [],
      tags: product.tags || [],
      is_featured: product.is_featured || false,
      is_active: product.is_active !== false,
      images: product.images || [],
      specifications: product.specifications || {}
    });
  };

  const handleSaveProduct = async () => {
    if (!selectedProduct) return;
    setSaving(true);

    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/products/${selectedProduct.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(editForm)
      });

      if (!res.ok) throw new Error('Failed to save');

      toast.success('Product updated!');
      fetchProducts();
      
      // Update selected product in state
      setSelectedProduct(prev => ({ ...prev, ...editForm }));
    } catch (e) {
      toast.error('Failed to save product');
    } finally {
      setSaving(false);
    }
  };

  const handleAddImage = () => {
    if (!newImageUrl.trim()) {
      toast.error('Please enter an image URL');
      return;
    }
    setEditForm(prev => ({
      ...prev,
      images: [...prev.images, newImageUrl.trim()]
    }));
    setNewImageUrl('');
  };

  const handleRemoveImage = (index) => {
    setEditForm(prev => ({
      ...prev,
      images: prev.images.filter((_, i) => i !== index)
    }));
  };

  const handleImageUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('folder', 'products');

    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/upload-image`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });

      if (!res.ok) throw new Error('Upload failed');

      const data = await res.json();
      setEditForm(prev => ({
        ...prev,
        images: [...prev.images, data.url]
      }));
      toast.success('Image uploaded!');
    } catch (e) {
      toast.error('Failed to upload image');
    }
  };

  const handleToggleFeatured = async (product) => {
    const token = localStorage.getItem('token');
    try {
      await fetch(`${API_URL}/api/website-admin/products/${product.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ is_featured: !product.is_featured })
      });
      fetchProducts();
      toast.success(product.is_featured ? 'Removed from featured' : 'Added to featured');
    } catch (e) {
      toast.error('Failed to update');
    }
  };

  const handleToggleActive = async (product) => {
    const token = localStorage.getItem('token');
    try {
      await fetch(`${API_URL}/api/website-admin/products/${product.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ is_active: product.is_active === false })
      });
      fetchProducts();
      toast.success(product.is_active === false ? 'Product activated' : 'Product deactivated');
    } catch (e) {
      toast.error('Failed to update');
    }
  };

  if (loading) {
    return (
      <div className="p-6">
        <div className="animate-spin w-8 h-8 border-4 border-gray-400 border-t-transparent rounded-full mx-auto"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <div className="bg-white shadow-sm border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Website Products</h1>
            <p className="text-sm text-gray-500">Edit product details, descriptions, and images</p>
          </div>
          <Button onClick={() => { setShowCreateForm(true); setSelectedProduct(null); }}>
            <Plus className="h-4 w-4 mr-2" />
            Add Manual Product
          </Button>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Product List */}
          <div className={`${selectedProduct || showCreateForm ? 'lg:col-span-1' : 'lg:col-span-3'}`}>
            <div className="bg-white rounded-lg shadow-sm">
              {/* Search & Filters */}
              <div className="p-4 border-b space-y-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search by name, SKU..."
                    className="pl-10"
                  />
                </div>
                <div className="flex gap-2">
                  {['all', 'active', 'inactive'].map(status => (
                    <button
                      key={status}
                      onClick={() => { setStatusFilter(status); setCurrentPage(1); }}
                      className={`px-3 py-1 text-sm rounded-full ${statusFilter === status ? 'bg-gray-900 text-white' : 'bg-gray-100'}`}
                    >
                      {status.charAt(0).toUpperCase() + status.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Product List */}
              <div className="divide-y max-h-[600px] overflow-y-auto">
                {products.map(product => (
                  <div
                    key={product.id}
                    onClick={() => handleSelectProduct(product)}
                    className={`flex items-center gap-3 p-3 cursor-pointer hover:bg-gray-50 ${selectedProduct?.id === product.id ? 'bg-amber-50' : ''}`}
                  >
                    {product.images?.[0] ? (
                      <img src={normaliseImageUrl(product.images[0])} alt="" className="w-14 h-14 rounded object-cover" />
                    ) : (
                      <div className="w-14 h-14 rounded bg-gray-200 flex items-center justify-center">
                        <Image className="h-6 w-6 text-gray-400" />
                      </div>
                    )}

                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">{product.website_name || product.name}</div>
                      <div className="text-xs text-gray-500">{product.sku}</div>
                      <div className="text-xs text-gray-500">£{product.price?.toFixed(2)}</div>
                    </div>

                    <div className="flex flex-col items-end gap-1">
                      <div className="flex gap-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleToggleFeatured(product); }}
                          className={`p-1 rounded ${product.is_featured ? 'text-amber-500' : 'text-gray-300 hover:text-amber-500'}`}
                        >
                          {product.is_featured ? <Star className="h-4 w-4 fill-current" /> : <StarOff className="h-4 w-4" />}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleToggleActive(product); }}
                          className={`p-1 rounded ${product.is_active !== false ? 'text-green-500' : 'text-gray-300 hover:text-green-500'}`}
                        >
                          {product.is_active !== false ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                        </button>
                      </div>
                      {product.is_manual && (
                        <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">Manual</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Pagination */}
              <div className="p-4 border-t flex items-center justify-between">
                <span className="text-sm text-gray-500">Page {currentPage} of {totalPages}</span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </div>

          {/* Edit Panel */}
          {selectedProduct && (
            <div className="lg:col-span-2">
              <div className="bg-white rounded-lg shadow-sm">
                <div className="p-4 border-b flex items-center justify-between">
                  <div>
                    <h2 className="font-semibold">Edit Product</h2>
                    <p className="text-sm text-gray-500">SKU: {selectedProduct.sku}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => window.open(`/tiles/${selectedProduct.slug}`, '_blank')}>
                      <ExternalLink className="h-4 w-4 mr-1" />
                      View
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setSelectedProduct(null)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="p-4 space-y-6 max-h-[700px] overflow-y-auto">
                  {/* Basic Info */}
                  <div className="space-y-4">
                    <h3 className="font-medium text-sm text-gray-700 uppercase tracking-wide">Basic Info</h3>
                    
                    <div>
                      <Label>Original Name (from supplier)</Label>
                      <Input value={selectedProduct.name || ''} disabled className="bg-gray-50" />
                    </div>

                    <div>
                      <Label>Website Display Name *</Label>
                      <Input
                        value={editForm.website_name}
                        onChange={(e) => setEditForm(prev => ({ ...prev, website_name: e.target.value }))}
                        placeholder="Custom name for your website"
                      />
                    </div>

                    <div>
                      <Label>Short Description</Label>
                      <Textarea
                        value={editForm.short_description}
                        onChange={(e) => setEditForm(prev => ({ ...prev, short_description: e.target.value }))}
                        placeholder="Brief description (shown in listings)"
                        rows={2}
                      />
                    </div>

                    <div>
                      <Label>Full Description</Label>
                      <Textarea
                        value={editForm.description}
                        onChange={(e) => setEditForm(prev => ({ ...prev, description: e.target.value }))}
                        placeholder="Detailed product description"
                        rows={5}
                      />
                    </div>
                  </div>

                  {/* Categories */}
                  <div className="space-y-3">
                    <h3 className="font-medium text-sm text-gray-700 uppercase tracking-wide">Categories</h3>
                    <div className="flex flex-wrap gap-2">
                      {categories.map(cat => (
                        <button
                          key={cat.id}
                          onClick={() => {
                            setEditForm(prev => ({
                              ...prev,
                              category_ids: prev.category_ids.includes(cat.id)
                                ? prev.category_ids.filter(id => id !== cat.id)
                                : [...prev.category_ids, cat.id]
                            }));
                          }}
                          className={`px-3 py-1.5 rounded-full text-sm border ${
                            editForm.category_ids.includes(cat.id)
                              ? 'bg-amber-100 border-amber-300 text-amber-800'
                              : 'bg-white border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          {cat.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Images */}
                  <div className="space-y-3">
                    <h3 className="font-medium text-sm text-gray-700 uppercase tracking-wide">Images</h3>
                    
                    {editForm.images?.length > 0 && (
                      <div className="grid grid-cols-4 gap-2">
                        {editForm.images.map((img, i) => (
                          <div key={i} className="relative group">
                            <img src={img} alt="" className="w-full h-24 object-cover rounded" />
                            <button
                              onClick={() => handleRemoveImage(i)}
                              className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition"
                            >
                              <X className="h-3 w-3" />
                            </button>
                            {i === 0 && (
                              <span className="absolute bottom-1 left-1 bg-black/50 text-white text-xs px-1.5 py-0.5 rounded">Main</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Input
                        value={newImageUrl}
                        onChange={(e) => setNewImageUrl(e.target.value)}
                        placeholder="Paste image URL"
                        className="flex-1"
                      />
                      <Button variant="outline" onClick={handleAddImage}>
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>

                    <div className="text-center">
                      <label className="cursor-pointer">
                        <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
                        <span className="inline-flex items-center gap-2 text-sm text-amber-600 hover:text-amber-700">
                          <Upload className="h-4 w-4" />
                          Upload from computer
                        </span>
                      </label>
                    </div>
                  </div>

                  {/* SEO */}
                  <div className="space-y-4">
                    <h3 className="font-medium text-sm text-gray-700 uppercase tracking-wide">SEO</h3>
                    
                    <div>
                      <Label>SEO Title</Label>
                      <Input
                        value={editForm.seo_title}
                        onChange={(e) => setEditForm(prev => ({ ...prev, seo_title: e.target.value }))}
                        placeholder="Page title for search engines"
                      />
                    </div>

                    <div>
                      <Label>SEO Description</Label>
                      <Textarea
                        value={editForm.seo_description}
                        onChange={(e) => setEditForm(prev => ({ ...prev, seo_description: e.target.value }))}
                        placeholder="Meta description for search engines"
                        rows={2}
                      />
                    </div>
                  </div>

                  {/* Status */}
                  <div className="space-y-4">
                    <h3 className="font-medium text-sm text-gray-700 uppercase tracking-wide">Status</h3>
                    
                    <div className="flex items-center justify-between p-3 bg-gray-50 rounded">
                      <div>
                        <div className="font-medium">Active</div>
                        <div className="text-sm text-gray-500">Show on website</div>
                      </div>
                      <Switch
                        checked={editForm.is_active}
                        onCheckedChange={(v) => setEditForm(prev => ({ ...prev, is_active: v }))}
                      />
                    </div>

                    <div className="flex items-center justify-between p-3 bg-gray-50 rounded">
                      <div>
                        <div className="font-medium">Featured</div>
                        <div className="text-sm text-gray-500">Show on homepage</div>
                      </div>
                      <Switch
                        checked={editForm.is_featured}
                        onCheckedChange={(v) => setEditForm(prev => ({ ...prev, is_featured: v }))}
                      />
                    </div>
                  </div>
                </div>

                {/* Save Button */}
                <div className="p-4 border-t">
                  <Button 
                    onClick={handleSaveProduct} 
                    disabled={saving}
                    className="w-full bg-amber-500 hover:bg-amber-600"
                  >
                    <Save className="h-4 w-4 mr-2" />
                    {saving ? 'Saving...' : 'Save Changes'}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Create Manual Product Form */}
          {showCreateForm && !selectedProduct && (
            <div className="lg:col-span-2">
              <div className="bg-white rounded-lg shadow-sm">
                <div className="p-4 border-b flex items-center justify-between">
                  <h2 className="font-semibold">Create Manual Product</h2>
                  <Button variant="ghost" size="sm" onClick={() => setShowCreateForm(false)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const formData = new FormData(e.target);
                    const token = localStorage.getItem('token');

                    try {
                      const res = await fetch(`${API_URL}/api/website-admin/products`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${token}` },
                        body: formData
                      });

                      if (!res.ok) {
                        const error = await res.json();
                        throw new Error(error.detail || 'Failed to create product');
                      }

                      toast.success('Product created!');
                      setShowCreateForm(false);
                      fetchProducts();
                    } catch (e) {
                      toast.error(e.message);
                    }
                  }}
                  className="p-4 space-y-4"
                >
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>Product Name *</Label>
                      <Input name="name" required placeholder="Tile name" />
                    </div>
                    <div>
                      <Label>SKU *</Label>
                      <Input name="sku" required placeholder="Unique product code" />
                    </div>
                  </div>

                  <div>
                    <Label>Website Display Name</Label>
                    <Input name="website_name" placeholder="Custom display name (optional)" />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>Price (£/m²) *</Label>
                      <Input name="price" type="number" step="0.01" required placeholder="0.00" />
                    </div>
                    <div>
                      <Label>Size</Label>
                      <Input name="size" placeholder="e.g., 600x600mm" />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>Finish</Label>
                      <Input name="finish" placeholder="e.g., Matt, Gloss" />
                    </div>
                    <div>
                      <Label>Material</Label>
                      <Input name="material" placeholder="e.g., Porcelain" />
                    </div>
                  </div>

                  <div>
                    <Label>Color</Label>
                    <Input name="color" placeholder="e.g., Grey, White" />
                  </div>

                  <div>
                    <Label>Description</Label>
                    <Textarea name="description" placeholder="Product description" rows={4} />
                  </div>

                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" name="is_active" defaultChecked className="rounded" />
                      <span>Active</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" name="is_featured" className="rounded" />
                      <span>Featured</span>
                    </label>
                  </div>

                  <div className="flex gap-2 pt-4">
                    <Button type="button" variant="outline" className="flex-1" onClick={() => setShowCreateForm(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" className="flex-1 bg-amber-500 hover:bg-amber-600">
                      Create Product
                    </Button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default WebsiteProductsEditor;
