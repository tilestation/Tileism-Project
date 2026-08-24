import React, { useState, useEffect, useCallback } from 'react';
import { 
  Image, 
  Upload, 
  Star, 
  StarOff, 
  EyeOff, 
  Eye, 
  Save, 
  X, 
  Loader2, 
  Search,
  RefreshCw,
  Cloud,
  Trash2,
  GripVertical,
  Check,
  Settings,
  Palette,
  Square,
  Circle,
  ZoomIn,
  Sparkles,
  ArrowUp,
  ArrowDown,
  List,
  Grid,
  FileText,
  Move
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { toast } from 'sonner';
import { ImageFramingModal } from './components/managers/ProductImagesGridPanel';

const API_URL = process.env.REACT_APP_BACKEND_URL || '';

// Default card settings
const DEFAULT_CARD_SETTINGS = {
  enableZoom: false,
  shadowStyle: 'elegant', // 'none', 'subtle', 'elegant', 'strong'
  borderRadius: 'rounded', // 'none', 'slight', 'rounded', 'pill'
  showBorder: true,
  hoverEffect: 'shadow', // 'none', 'shadow', 'lift', 'glow'
};

export default function CollectionManager({ embedded = false }) {
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [editingCollection, setEditingCollection] = useState(null);
  const [uploadingFor, setUploadingFor] = useState(null);
  const [showCardSettings, setShowCardSettings] = useState(false);
  const [cardSettings, setCardSettings] = useState(DEFAULT_CARD_SETTINGS);
  const [savingSettings, setSavingSettings] = useState(false);
  const [viewMode, setViewMode] = useState('grid'); // 'grid' or 'reorder'
  const [savingOrder, setSavingOrder] = useState(false);
  const [adjustFor, setAdjustFor] = useState(null); // collection being view-adjusted

  const handleSaveAdjust = async (seriesName, zoom, posX, posY) => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/collections/${encodeURIComponent(seriesName)}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hero_zoom: zoom, hero_pos_x: posX, hero_pos_y: posY }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`"${seriesName}" card view saved — website updates within a minute`);
      setAdjustFor(null);
      setCollections(prev => prev.map(c => c.series_name === seriesName
        ? { ...c, hero_zoom: zoom, hero_pos_x: posX, hero_pos_y: posY }
        : c));
    } catch (error) {
      toast.error('Failed to save view adjustment');
    }
  };

  const fetchCollections = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/collections`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      setCollections(data.collections || []);
    } catch (error) {
      console.error('Error fetching collections:', error);
      toast.error('Failed to load collections');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch card display settings
  const fetchCardSettings = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/collection-card-settings`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setCardSettings({ ...DEFAULT_CARD_SETTINGS, ...data });
      }
    } catch (error) {
      console.error('Error fetching card settings:', error);
    }
  }, []);

  // Save card display settings
  const saveCardSettings = async () => {
    setSavingSettings(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/collection-card-settings`, {
        method: 'PUT',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(cardSettings)
      });
      if (res.ok) {
        toast.success('Card settings saved!');
      } else {
        throw new Error('Failed to save');
      }
    } catch (error) {
      toast.error('Failed to save card settings');
    } finally {
      setSavingSettings(false);
    }
  };

  useEffect(() => {
    fetchCollections();
    fetchCardSettings();
  }, [fetchCollections, fetchCardSettings]);

  const handleImageUpload = async (e, seriesName) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingFor(seriesName);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('series_name', seriesName);

    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/collections/upload-image`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });

      if (res.ok) {
        const result = await res.json();
        toast.success('Collection image updated!', {
          description: result.storage === 'r2' ? 'Uploaded to cloud storage' : 'Saved locally'
        });
        fetchCollections();
      } else {
        throw new Error('Upload failed');
      }
    } catch (error) {
      console.error('Upload error:', error);
      toast.error('Failed to upload image');
    } finally {
      setUploadingFor(null);
    }
  };

  const handleRemoveCustomImage = async (seriesName) => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/collections/${encodeURIComponent(seriesName)}/image`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (res.ok) {
        toast.success('Custom image removed');
        fetchCollections();
      }
    } catch (error) {
      toast.error('Failed to remove image');
    }
  };

  const handleUpdateSettings = async (seriesName, settings) => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/collections/${encodeURIComponent(seriesName)}`, {
        method: 'PUT',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(settings)
      });

      if (res.ok) {
        toast.success('Collection updated');
        fetchCollections();
      }
    } catch (error) {
      toast.error('Failed to update collection');
    }
  };

  const toggleFeatured = (collection) => {
    handleUpdateSettings(collection.series_name, { 
      is_featured: !collection.is_featured 
    });
  };

  const toggleHidden = (collection) => {
    handleUpdateSettings(collection.series_name, { 
      is_hidden: !collection.is_hidden 
    });
  };

  // Move collection up in order
  const moveUp = async (index) => {
    if (index === 0) return;
    const collection = filteredCollections[index];
    const prevCollection = filteredCollections[index - 1];
    
    // Swap display orders
    const newOrder = prevCollection.display_order || index - 1;
    const prevNewOrder = collection.display_order || index;
    
    await handleUpdateSettings(collection.series_name, { display_order: newOrder });
    await handleUpdateSettings(prevCollection.series_name, { display_order: prevNewOrder });
  };

  // Move collection down in order
  const moveDown = async (index) => {
    if (index >= filteredCollections.length - 1) return;
    const collection = filteredCollections[index];
    const nextCollection = filteredCollections[index + 1];
    
    // Swap display orders
    const newOrder = nextCollection.display_order || index + 1;
    const nextNewOrder = collection.display_order || index;
    
    await handleUpdateSettings(collection.series_name, { display_order: newOrder });
    await handleUpdateSettings(nextCollection.series_name, { display_order: nextNewOrder });
  };

  // Save all display orders at once
  const saveAllOrders = async () => {
    setSavingOrder(true);
    try {
      const token = localStorage.getItem('token');
      const updates = filteredCollections.map((c, idx) => ({
        series_name: c.series_name,
        display_order: idx
      }));
      
      // Update all at once
      for (const update of updates) {
        await fetch(`${API_URL}/api/website-admin/collections/${encodeURIComponent(update.series_name)}`, {
          method: 'PUT',
          headers: { 
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ display_order: update.display_order })
        });
      }
      
      toast.success('Collection order saved!');
      fetchCollections();
    } catch (error) {
      toast.error('Failed to save order');
    } finally {
      setSavingOrder(false);
    }
  };

  const filteredCollections = collections.filter(c => 
    (c.series_name || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  const isR2Url = (url) => url?.includes('images.tilestation.co.uk') || url?.includes('r2.dev');


  return (
    <div className={`${embedded ? 'p-4' : 'p-6'} max-w-7xl mx-auto`} data-testid="collection-manager">
      {!embedded && (
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Collection Manager</h1>
            <p className="text-gray-500 mt-1">Manage collection images, featured status, and visibility</p>
          </div>
        </div>
      )}
      <div className={`flex items-center justify-between ${embedded ? 'mb-4' : 'mb-6'}`}>
        <div className="flex gap-2 flex-wrap">
          {/* View Mode Toggle */}
          <div className="flex border rounded-lg overflow-hidden">
            <button
              onClick={() => setViewMode('grid')}
              className={`px-3 py-2 flex items-center gap-1 text-sm ${
                viewMode === 'grid' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              <Grid className="w-4 h-4" />
              Grid
            </button>
            <button
              onClick={() => setViewMode('reorder')}
              className={`px-3 py-2 flex items-center gap-1 text-sm ${
                viewMode === 'reorder' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              <List className="w-4 h-4" />
              Reorder
            </button>
          </div>
          <Button 
            onClick={() => setShowCardSettings(!showCardSettings)} 
            variant="outline"
            className={showCardSettings ? 'bg-gray-100' : ''}
          >
            <Settings className="w-4 h-4 mr-2" />
            Card Settings
          </Button>
          <Button 
            onClick={fetchCollections} 
            variant="outline" 
            disabled={loading}
            data-testid="refresh-collections"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Card Display Settings Panel */}
      {showCardSettings && (
        <div className="bg-gradient-to-r from-gray-50 to-slate-50 border rounded-xl p-6 mb-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-900 flex items-center gap-2">
              <Palette className="w-5 h-5 text-purple-500" />
              Collection Card Display Settings
            </h3>
            <Button 
              onClick={saveCardSettings} 
              disabled={savingSettings}
              size="sm"
            >
              {savingSettings ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save Settings
            </Button>
          </div>
          
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {/* Zoom Effect */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                <ZoomIn className="w-4 h-4 inline mr-1" />
                Image Zoom on Hover
              </label>
              <div className="flex gap-2">
                <button
                  onClick={() => setCardSettings(s => ({ ...s, enableZoom: false }))}
                  className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-all ${
                    !cardSettings.enableZoom 
                      ? 'bg-purple-500 text-white border-purple-500' 
                      : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  Off
                </button>
                <button
                  onClick={() => setCardSettings(s => ({ ...s, enableZoom: true }))}
                  className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-all ${
                    cardSettings.enableZoom 
                      ? 'bg-purple-500 text-white border-purple-500' 
                      : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  On
                </button>
              </div>
            </div>

            {/* Shadow Style */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                <Sparkles className="w-4 h-4 inline mr-1" />
                Shadow Style
              </label>
              <select
                value={cardSettings.shadowStyle}
                onChange={(e) => setCardSettings(s => ({ ...s, shadowStyle: e.target.value }))}
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              >
                <option value="none">None</option>
                <option value="subtle">Subtle</option>
                <option value="elegant">Elegant</option>
                <option value="strong">Strong</option>
              </select>
            </div>

            {/* Border Radius */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                <Square className="w-4 h-4 inline mr-1" />
                Corner Style
              </label>
              <select
                value={cardSettings.borderRadius}
                onChange={(e) => setCardSettings(s => ({ ...s, borderRadius: e.target.value }))}
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              >
                <option value="none">Sharp Corners</option>
                <option value="slight">Slightly Rounded</option>
                <option value="rounded">Rounded</option>
                <option value="pill">Extra Rounded</option>
              </select>
            </div>

            {/* Hover Effect */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Hover Effect
              </label>
              <select
                value={cardSettings.hoverEffect}
                onChange={(e) => setCardSettings(s => ({ ...s, hoverEffect: e.target.value }))}
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-white focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              >
                <option value="none">None</option>
                <option value="shadow">Deeper Shadow</option>
                <option value="lift">Lift Up</option>
                <option value="glow">Glow</option>
              </select>
            </div>
          </div>

          {/* Preview Card */}
          <div className="mt-6 pt-4 border-t">
            <p className="text-sm text-gray-500 mb-3">Preview:</p>
            <div className="flex gap-4">
              <div 
                className={`w-32 h-40 bg-gradient-to-br from-gray-200 to-gray-300 transition-all duration-300 ${
                  cardSettings.borderRadius === 'none' ? '' :
                  cardSettings.borderRadius === 'slight' ? 'rounded' :
                  cardSettings.borderRadius === 'rounded' ? 'rounded-lg' : 'rounded-2xl'
                } ${
                  cardSettings.shadowStyle === 'none' ? '' :
                  cardSettings.shadowStyle === 'subtle' ? 'shadow-sm' :
                  cardSettings.shadowStyle === 'elegant' ? 'shadow-[0_4px_20px_rgba(0,0,0,0.08)]' : 'shadow-lg'
                } ${
                  cardSettings.showBorder ? 'border border-gray-200' : ''
                }`}
                style={{
                  transform: cardSettings.hoverEffect === 'lift' ? 'translateY(-2px)' : 'none',
                }}
              >
                <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">
                  Card Preview
                </div>
              </div>
              <div className="text-sm text-gray-500">
                <p><strong>Zoom:</strong> {cardSettings.enableZoom ? 'Enabled' : 'Disabled'}</p>
                <p><strong>Shadow:</strong> {cardSettings.shadowStyle}</p>
                <p><strong>Corners:</strong> {cardSettings.borderRadius}</p>
                <p><strong>Hover:</strong> {cardSettings.hoverEffect}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Search */}
      <div className="relative mb-6">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <Input
          placeholder="Search collections..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-10"
          data-testid="collection-search"
        />
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-white border rounded-lg p-4">
          <div className="text-2xl font-bold text-gray-900">{collections.length}</div>
          <div className="text-sm text-gray-500">Total Collections</div>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <div className="text-2xl font-bold text-amber-600">
            {collections.filter(c => c.is_featured).length}
          </div>
          <div className="text-sm text-gray-500">Featured</div>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <div className="text-2xl font-bold text-green-600">
            {collections.filter(c => c.custom_hero_image).length}
          </div>
          <div className="text-sm text-gray-500">Custom Images</div>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <div className="text-2xl font-bold text-red-600">
            {collections.filter(c => c.is_hidden).length}
          </div>
          <div className="text-sm text-gray-500">Hidden</div>
        </div>
      </div>

      {/* Collection Grid or Reorder List */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
        </div>
      ) : viewMode === 'reorder' ? (
        /* Reorder Mode - List View */
        <div className="bg-white border rounded-lg overflow-hidden">
          <div className="p-4 bg-gradient-to-r from-purple-50 to-indigo-50 border-b flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-gray-900">Reorder Collections</h3>
              <p className="text-sm text-gray-500">Use arrows to change the display order on the shop page</p>
            </div>
            <Button onClick={saveAllOrders} disabled={savingOrder}>
              {savingOrder ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save Order
            </Button>
          </div>
          <div className="divide-y">
            {filteredCollections.map((collection, index) => (
              <div 
                key={collection.series_name}
                className={`flex items-center gap-4 p-4 hover:bg-gray-50 ${
                  collection.is_hidden ? 'opacity-50 bg-gray-50' : ''
                } ${collection.is_featured ? 'bg-amber-50' : ''}`}
              >
                {/* Position Number */}
                <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center font-bold text-gray-600">
                  {index + 1}
                </div>
                
                {/* Thumbnail */}
                <div className="w-16 h-16 rounded-lg overflow-hidden bg-gray-100 flex-shrink-0">
                  {collection.hero_image ? (
                    <img 
                      src={collection.hero_image} 
                      alt={collection.series_name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-400">
                      <Image className="w-6 h-6" />
                    </div>
                  )}
                </div>
                
                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="font-medium text-gray-900 truncate">{collection.series_name}</h4>
                    {collection.is_featured && (
                      <span className="px-2 py-0.5 text-xs bg-amber-100 text-amber-700 rounded">Featured</span>
                    )}
                    {collection.is_hidden && (
                      <span className="px-2 py-0.5 text-xs bg-red-100 text-red-700 rounded">Hidden</span>
                    )}
                    {collection.custom_hero_image && (
                      <span className="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded flex items-center gap-1">
                        <Cloud className="w-3 h-3" />
                        Custom
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-500">{collection.product_count} products</p>
                </div>
                
                {/* Actions */}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => toggleFeatured(collection)}
                    className={collection.is_featured ? 'bg-amber-100 border-amber-300' : ''}
                  >
                    <Star className={`w-4 h-4 ${collection.is_featured ? 'fill-amber-500 text-amber-500' : ''}`} />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => toggleHidden(collection)}
                    className={collection.is_hidden ? 'bg-red-100 border-red-300' : ''}
                  >
                    {collection.is_hidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </Button>
                  <div className="flex flex-col gap-1">
                    <button
                      onClick={() => moveUp(index)}
                      disabled={index === 0}
                      className="p-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <ArrowUp className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => moveDown(index)}
                      disabled={index >= filteredCollections.length - 1}
                      className="p-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      <ArrowDown className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* Grid View */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredCollections.map((collection) => (
            <CollectionCard
              key={collection.series_name}
              collection={collection}
              onImageUpload={handleImageUpload}
              onRemoveImage={handleRemoveCustomImage}
              onToggleFeatured={toggleFeatured}
              onToggleHidden={toggleHidden}
              onUpdateSettings={handleUpdateSettings}
              onAdjustView={setAdjustFor}
              isUploading={uploadingFor === collection.series_name}
              isR2Url={isR2Url}
            />
          ))}
        </div>
      )}

      {filteredCollections.length === 0 && !loading && (
        <div className="text-center py-20 text-gray-500">
          {searchTerm ? 'No collections match your search' : 'No collections found'}
        </div>
      )}

      {adjustFor && (
        <ImageFramingModal
          img={adjustFor.hero_image || adjustFor.auto_hero_image}
          title={`Adjust card view — ${adjustFor.series_name}`}
          aspectClass="aspect-[3/4]"
          hint="Drag to reposition • slide to zoom. The bright window is exactly how the card looks on the website."
          initial={adjustFor.hero_zoom || adjustFor.hero_pos_x != null ? { zoom: adjustFor.hero_zoom || 1, x: adjustFor.hero_pos_x ?? 50, y: adjustFor.hero_pos_y ?? 50 } : undefined}
          onClose={() => setAdjustFor(null)}
          onSave={(z, x, y) => handleSaveAdjust(adjustFor.series_name, z, x, y)}
        />
      )}
    </div>
  );
}

function CollectionCard({ 
  collection, 
  onImageUpload, 
  onRemoveImage,
  onToggleFeatured, 
  onToggleHidden,
  onUpdateSettings,
  onAdjustView,
  isUploading,
  isR2Url
}) {
  const [showDetails, setShowDetails] = useState(false);
  const fileInputRef = React.useRef(null);

  const hasCustomImage = !!collection.custom_hero_image;
  const displayImage = collection.hero_image || collection.auto_hero_image;

  return (
    <div 
      className={`bg-white border rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow ${
        collection.is_hidden ? 'opacity-60' : ''
      } ${collection.is_featured ? 'ring-2 ring-amber-400' : ''}`}
      data-testid={`collection-card-${collection.series_name}`}
    >
      {/* Image Section */}
      <div className="relative aspect-[4/3] bg-gray-100 group">
        {displayImage ? (
          <img 
            src={displayImage} 
            alt={collection.series_name}
            className="w-full h-full object-cover"
            onError={(e) => {
              e.target.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="%23f3f4f6" width="100" height="100"/><text x="50%" y="50%" text-anchor="middle" dy=".3em" fill="%239ca3af" font-size="10">No Image</text></svg>';
            }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-400">
            <Image className="w-12 h-12" />
          </div>
        )}

        {/* Image badges */}
        <div className="absolute top-2 left-2 flex gap-1">
          {hasCustomImage && (
            <span className="bg-green-500 text-white text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1">
              <Check className="w-3 h-3" />
              Custom
            </span>
          )}
          {isR2Url(displayImage) && (
            <span className="bg-blue-500 text-white text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1">
              <Cloud className="w-3 h-3" />
              R2
            </span>
          )}
        </div>

        {/* Badges */}
        <div className="absolute top-2 right-2 flex gap-1">
          {collection.is_featured && (
            <span className="bg-amber-500 text-white text-[10px] px-1.5 py-0.5 rounded">
              Featured
            </span>
          )}
          {collection.is_hidden && (
            <span className="bg-red-500 text-white text-[10px] px-1.5 py-0.5 rounded">
              Hidden
            </span>
          )}
        </div>

        {/* Upload overlay */}
        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={(e) => onImageUpload(e, collection.series_name)}
            className="hidden"
          />
          
          {isUploading ? (
            <div className="flex flex-col items-center text-white">
              <Loader2 className="w-8 h-8 animate-spin" />
              <span className="text-sm mt-2">Uploading...</span>
            </div>
          ) : (
            <>
              <Button
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                className="bg-white text-gray-900 hover:bg-gray-100"
              >
                <Upload className="w-4 h-4 mr-1" />
                {hasCustomImage ? 'Change' : 'Upload'}
              </Button>
              
              {displayImage && (
                <Button
                  size="sm"
                  onClick={() => onAdjustView(collection)}
                  className="bg-indigo-600 text-white hover:bg-indigo-700"
                  title="Drag to reposition and zoom the card image"
                  data-testid={`adjust-view-${collection.series_name}`}
                >
                  <Move className="w-4 h-4 mr-1" />
                  Adjust
                </Button>
              )}
              
              {hasCustomImage && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => onRemoveImage(collection.series_name)}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Info Section */}
      <div className="p-3">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-gray-900 truncate flex-1" title={collection.series_name}>
            {collection.series_name}
          </h3>
          {collection.custom_description && (
            <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded flex items-center gap-0.5" title="Has custom description">
              <FileText className="w-3 h-3" />
              Desc
            </span>
          )}
        </div>
        <p className="text-sm text-gray-500">
          {collection.product_count} products
        </p>

        {/* Action buttons */}
        <div className="flex gap-1 mt-3">
          <Button
            size="sm"
            variant={collection.is_featured ? "default" : "outline"}
            onClick={() => onToggleFeatured(collection)}
            className={`flex-1 ${collection.is_featured ? 'bg-amber-500 hover:bg-amber-600' : ''}`}
            title={collection.is_featured ? 'Remove from featured' : 'Mark as featured'}
          >
            {collection.is_featured ? (
              <Star className="w-4 h-4 mr-1 fill-current" />
            ) : (
              <StarOff className="w-4 h-4 mr-1" />
            )}
            {collection.is_featured ? 'Featured' : 'Feature'}
          </Button>
          
          <Button
            size="sm"
            variant={collection.is_hidden ? "destructive" : "outline"}
            onClick={() => onToggleHidden(collection)}
            title={collection.is_hidden ? 'Show collection' : 'Hide collection'}
          >
            {collection.is_hidden ? (
              <EyeOff className="w-4 h-4" />
            ) : (
              <Eye className="w-4 h-4" />
            )}
          </Button>
        </div>

        {/* Expand for more details */}
        {showDetails && (
          <div className="mt-3 pt-3 border-t text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-500">Price Range:</span>
              <span className="font-medium">
                £{Number(collection.min_price || 0).toFixed(2)} - £{Number(collection.max_price || 0).toFixed(2)}
              </span>
            </div>
            {collection.custom_description && (
              <div>
                <span className="text-gray-500 block mb-1">Custom Description:</span>
                <p className="text-gray-700 text-xs bg-purple-50 p-2 rounded border border-purple-100 line-clamp-3">
                  {collection.custom_description}
                </p>
              </div>
            )}
            {collection.auto_hero_image && hasCustomImage && (
              <div>
                <span className="text-gray-500 block mb-1">Auto-generated image:</span>
                <img 
                  src={collection.auto_hero_image} 
                  alt="Auto" 
                  className="w-full h-20 object-cover rounded border"
                />
              </div>
            )}
          </div>
        )}

        <button
          onClick={() => setShowDetails(!showDetails)}
          className="text-xs text-blue-600 hover:underline mt-2 block"
          data-testid={`toggle-details-${collection.series_name}`}
        >
          {showDetails ? 'Hide details' : 'Show details'}
        </button>
      </div>
    </div>
  );
}
