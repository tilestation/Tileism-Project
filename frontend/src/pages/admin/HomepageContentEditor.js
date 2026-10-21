import React, { useState, useEffect } from 'react';
import { Save, RefreshCw, Eye, Image, Plus, X, GripVertical, Upload } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { toast } from 'sonner';
import { normaliseImageUrl } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const defaultContent = {
  hero_title: "Transform Your Space with Beautiful Tiles",
  hero_subtitle: "Discover our exclusive collection of wall and floor tiles. Quality craftsmanship at competitive prices with expert advice.",
  hero_image: "",
  hero_cta_text: "Shop Now",
  hero_cta_link: "/tiles",
  usp_items: [
    { text: "FREE CLICK & COLLECT", link: "" },
    { text: "FREE UP TO 3 SAMPLES", link: "/shop/sample-service" },
    { text: "FREE DELIVERY OVER £500", link: "" }
  ],
  featured_categories: [],
  featured_products: [],
  banner_text: "Premium Quality Tiles",
  banner_link: "",
  about_title: "About Tile Station",
  about_text: "Premium quality tiles for your home. Visit our showrooms in Tonbridge, Gravesend and Sydenham.",
  about_image: ""
};

const HomepageContentEditor = () => {
  const [content, setContent] = useState(defaultContent);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState([]);
  const [products, setProducts] = useState([]);

  useEffect(() => {
    fetchContent();
    fetchCategories();
    fetchProducts();
  }, []);

  const fetchContent = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/homepage`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data && Object.keys(data).length > 0) {
        setContent({ ...defaultContent, ...data });
      }
    } catch (e) {
      console.log('Using default content');
    } finally {
      setLoading(false);
    }
  };

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

  const fetchProducts = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/products?limit=50&status=active`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      setProducts(data.products || []);
    } catch (e) {
      console.error('Failed to load products');
    }
  };

  const handleChange = (field, value) => {
    setContent(prev => ({ ...prev, [field]: value }));
  };

  const handleUSPChange = (index, field, value) => {
    setContent(prev => ({
      ...prev,
      usp_items: prev.usp_items.map((item, i) => 
        i === index ? { ...item, [field]: value } : item
      )
    }));
  };

  const handleAddUSP = () => {
    setContent(prev => ({
      ...prev,
      usp_items: [...prev.usp_items, { text: "NEW USP", link: "" }]
    }));
  };

  const handleRemoveUSP = (index) => {
    setContent(prev => ({
      ...prev,
      usp_items: prev.usp_items.filter((_, i) => i !== index)
    }));
  };

  const handleToggleCategory = (categoryId) => {
    setContent(prev => ({
      ...prev,
      featured_categories: prev.featured_categories.includes(categoryId)
        ? prev.featured_categories.filter(id => id !== categoryId)
        : [...prev.featured_categories, categoryId]
    }));
  };

  const handleToggleProduct = (productId) => {
    setContent(prev => ({
      ...prev,
      featured_products: prev.featured_products.includes(productId)
        ? prev.featured_products.filter(id => id !== productId)
        : [...prev.featured_products, productId]
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/homepage`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify(content)
      });

      if (!res.ok) throw new Error('Failed to save');

      toast.success('Homepage content saved!');
    } catch (e) {
      toast.error('Failed to save content');
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setContent(defaultContent);
    toast.info('Content reset to defaults (not saved yet)');
  };

  const handleImageUpload = async (e, field) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    formData.append('folder', 'homepage');

    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/upload-image`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });

      if (!res.ok) throw new Error('Upload failed');

      const data = await res.json();
      handleChange(field, data.url);
      toast.success('Image uploaded!');
    } catch (e) {
      toast.error('Failed to upload image');
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
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Homepage Content</h1>
            <p className="text-sm text-gray-500">Customize your homepage content</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => window.open('/tiles', '_blank')}>
              <Eye className="h-4 w-4 mr-2" />
              Preview
            </Button>
            <Button variant="outline" onClick={handleReset}>
              <RefreshCw className="h-4 w-4 mr-2" />
              Reset
            </Button>
            <Button onClick={handleSave} disabled={saving} className="bg-amber-500 hover:bg-amber-600">
              <Save className="h-4 w-4 mr-2" />
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        {/* Hero Section */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b">Hero Section</h2>
          <div className="space-y-4">
            <div>
              <Label>Hero Title</Label>
              <Input
                value={content.hero_title}
                onChange={(e) => handleChange('hero_title', e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label>Hero Subtitle</Label>
              <Textarea
                value={content.hero_subtitle}
                onChange={(e) => handleChange('hero_subtitle', e.target.value)}
                className="mt-1"
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>CTA Button Text</Label>
                <Input
                  value={content.hero_cta_text}
                  onChange={(e) => handleChange('hero_cta_text', e.target.value)}
                  className="mt-1"
                />
              </div>
              <div>
                <Label>CTA Button Link</Label>
                <Input
                  value={content.hero_cta_link}
                  onChange={(e) => handleChange('hero_cta_link', e.target.value)}
                  className="mt-1"
                />
              </div>
            </div>
            <div>
              <Label>Hero Background Image</Label>
              <div className="mt-1 flex gap-2">
                <Input
                  value={content.hero_image}
                  onChange={(e) => handleChange('hero_image', e.target.value)}
                  placeholder="Image URL or upload"
                  className="flex-1"
                />
                <label className="cursor-pointer">
                  <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'hero_image')} className="hidden" />
                  <Button type="button" variant="outline" asChild>
                    <span><Upload className="h-4 w-4" /></span>
                  </Button>
                </label>
              </div>
              {content.hero_image && (
                <img src={normaliseImageUrl(content.hero_image)} alt="" className="mt-2 w-full h-40 object-cover rounded" />
              )}
            </div>
          </div>
        </div>

        {/* USP Bar */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <div className="flex items-center justify-between mb-4 pb-2 border-b">
            <h2 className="text-lg font-semibold">USP Bar (Yellow Banner)</h2>
            <Button variant="outline" size="sm" onClick={handleAddUSP}>
              <Plus className="h-4 w-4 mr-1" />
              Add USP
            </Button>
          </div>
          <div className="space-y-3">
            {content.usp_items?.map((item, i) => (
              <div key={i} className="flex items-center gap-3 p-3 bg-gray-50 rounded">
                <GripVertical className="h-4 w-4 text-gray-400" />
                <Input
                  value={item.text}
                  onChange={(e) => handleUSPChange(i, 'text', e.target.value)}
                  placeholder="USP text"
                  className="flex-1"
                />
                <Input
                  value={item.link}
                  onChange={(e) => handleUSPChange(i, 'link', e.target.value)}
                  placeholder="Link (optional)"
                  className="w-48"
                />
                <Button variant="ghost" size="sm" onClick={() => handleRemoveUSP(i)} className="text-red-500">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        {/* Featured Categories */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b">Featured Categories</h2>
          <p className="text-sm text-gray-500 mb-4">Select categories to display on homepage</p>
          <div className="flex flex-wrap gap-2">
            {categories.map(cat => (
              <button
                key={cat.id}
                onClick={() => handleToggleCategory(cat.id)}
                className={`px-4 py-2 rounded-full text-sm border ${
                  content.featured_categories?.includes(cat.id)
                    ? 'bg-amber-100 border-amber-300 text-amber-800'
                    : 'bg-white border-gray-200 hover:border-gray-300'
                }`}
              >
                {cat.name}
              </button>
            ))}
            {categories.length === 0 && (
              <p className="text-gray-500 text-sm">No categories available. Create categories first.</p>
            )}
          </div>
        </div>

        {/* Featured Products */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b">Featured Products</h2>
          <p className="text-sm text-gray-500 mb-4">Select products to feature on homepage (max 8 recommended)</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-h-64 overflow-y-auto">
            {products.slice(0, 40).map(product => (
              <button
                key={product.id}
                onClick={() => handleToggleProduct(product.id)}
                className={`p-2 rounded border text-left ${
                  content.featured_products?.includes(product.id)
                    ? 'bg-amber-50 border-amber-300'
                    : 'bg-white border-gray-200 hover:border-gray-300'
                }`}
              >
                {product.images?.[0] ? (
                  <img src={normaliseImageUrl(product.images[0])} alt="" className="w-full h-16 object-cover rounded mb-1" />
                ) : (
                  <div className="w-full h-16 bg-gray-100 rounded mb-1 flex items-center justify-center">
                    <Image className="h-6 w-6 text-gray-400" />
                  </div>
                )}
                <p className="text-xs font-medium truncate">{product.website_name || product.name}</p>
              </button>
            ))}
          </div>
          {content.featured_products?.length > 0 && (
            <p className="text-sm text-amber-600 mt-2">{content.featured_products.length} products selected</p>
          )}
        </div>

        {/* Banner */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b">Banner Section</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Banner Text</Label>
              <Input
                value={content.banner_text}
                onChange={(e) => handleChange('banner_text', e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label>Banner Link</Label>
              <Input
                value={content.banner_link}
                onChange={(e) => handleChange('banner_link', e.target.value)}
                className="mt-1"
                placeholder="Link URL (optional)"
              />
            </div>
          </div>
        </div>

        {/* About Section */}
        <div className="bg-white rounded-lg shadow-sm p-6">
          <h2 className="text-lg font-semibold mb-4 pb-2 border-b">About Section</h2>
          <div className="space-y-4">
            <div>
              <Label>About Title</Label>
              <Input
                value={content.about_title}
                onChange={(e) => handleChange('about_title', e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label>About Text</Label>
              <Textarea
                value={content.about_text}
                onChange={(e) => handleChange('about_text', e.target.value)}
                className="mt-1"
                rows={4}
              />
            </div>
            <div>
              <Label>About Image</Label>
              <div className="mt-1 flex gap-2">
                <Input
                  value={content.about_image}
                  onChange={(e) => handleChange('about_image', e.target.value)}
                  placeholder="Image URL or upload"
                  className="flex-1"
                />
                <label className="cursor-pointer">
                  <input type="file" accept="image/*" onChange={(e) => handleImageUpload(e, 'about_image')} className="hidden" />
                  <Button type="button" variant="outline" asChild>
                    <span><Upload className="h-4 w-4" /></span>
                  </Button>
                </label>
              </div>
              {content.about_image && (
                <img src={normaliseImageUrl(content.about_image)} alt="" className="mt-2 w-48 h-32 object-cover rounded" />
              )}
            </div>
          </div>
        </div>

        {/* Save Button */}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={handleReset}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Reset to Defaults
          </Button>
          <Button onClick={handleSave} disabled={saving} className="bg-amber-500 hover:bg-amber-600">
            <Save className="h-4 w-4 mr-2" />
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default HomepageContentEditor;
