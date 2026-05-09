import React, { useState, useEffect } from 'react';
import { 
  Save, RefreshCw, Eye, EyeOff, Image, Plus, X, GripVertical, Upload, 
  ChevronRight, ChevronDown, Palette, Package, MapPin, Truck, Star, Heart,
  Loader2, ExternalLink, Settings, Layout, Sparkles, ImageIcon,
  Type, Link as LinkIcon, ToggleLeft, Trash2, Edit2, Check, Monitor,
  Building2, Percent, Gift, Headphones, Award, Zap, Shield, Clock, Copy,
  Video, Play, Film, MessageCircle, Search
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { toast } from 'sonner';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import InfoPagesEditor from './components/InfoPagesEditor';
import { normaliseImageUrl } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Default hero slides for collections page (Kitchen Tiles, Bathroom, etc.)
const DEFAULT_COLLECTIONS_HERO_SLIDES = [
  {
    id: 'bathroom',
    title: 'Bathroom Tiles',
    subtitle: 'Create your dream sanctuary',
    image: 'https://images.unsplash.com/photo-1765766600820-58eaf8687f1d?w=1600&q=80',
    link: '/tiles?category=bathroom-tiles',
    enabled: true
  },
  {
    id: 'kitchen',
    title: 'Kitchen Tiles',
    subtitle: 'Where style meets function',
    image: 'https://images.unsplash.com/photo-1758548157126-e4c0477f796e?w=1600&q=80',
    link: '/tiles?category=kitchen-tiles',
    enabled: true
  },
  {
    id: 'living',
    title: 'Living Spaces',
    subtitle: 'Elegance for every room',
    image: 'https://images.unsplash.com/photo-1696861080288-0cc2f1cd48d5?w=1600&q=80',
    link: '/tiles?category=floor-tiles',
    enabled: true
  },
  {
    id: 'outdoor',
    title: 'Outdoor Tiles',
    subtitle: 'Extend your living space',
    image: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1600&q=80',
    link: '/tiles?category=outdoor-tiles',
    enabled: true
  }
];

// Icon options for feature cards
const ICON_OPTIONS = [
  { value: 'Palette', label: 'Palette', icon: <Palette className="w-4 h-4" /> },
  { value: 'Package', label: 'Package', icon: <Package className="w-4 h-4" /> },
  { value: 'MapPin', label: 'Location', icon: <MapPin className="w-4 h-4" /> },
  { value: 'Truck', label: 'Truck', icon: <Truck className="w-4 h-4" /> },
  { value: 'Star', label: 'Star', icon: <Star className="w-4 h-4" /> },
  { value: 'Heart', label: 'Heart', icon: <Heart className="w-4 h-4" /> },
  { value: 'Sparkles', label: 'Sparkles', icon: <Sparkles className="w-4 h-4" /> },
];

export default function HomepageManager() {
  const [activeSection, setActiveSection] = useState('hero');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  
  // Data states
  const [heroSlides, setHeroSlides] = useState([]);
  const [benefitsBar, setBenefitsBar] = useState([]);
  const [categories, setCategories] = useState([]);
  const [featureCards, setFeatureCards] = useState([]);
  const [homepageContent, setHomepageContent] = useState({});
  const [pageBanners, setPageBanners] = useState([]);
  const [showBannerDialog, setShowBannerDialog] = useState(false);
  const [editingBanner, setEditingBanner] = useState(null);
  const [tradeSettings, setTradeSettings] = useState(null);
  const [tradeSaving, setTradeSaving] = useState(false);
  const [bannerForm, setBannerForm] = useState({
    title: '', subtitle: '', image: '', link: '', overlay: 'rgba(0,0,0,0.3)', enabled: true
  });

  useEffect(() => {
    fetchAllData();
  }, []);

  const fetchAllData = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: `Bearer ${token}` };

      // Fetch all homepage data in parallel
      const [heroRes, benefitsRes, categoriesRes, featuresRes, contentRes, collectionsRes, tradeRes] = await Promise.all([
        fetch(`${API_URL}/api/website-admin/hero-slides`, { headers }),
        fetch(`${API_URL}/api/website-admin/benefits-bar`, { headers }),
        fetch(`${API_URL}/api/website-admin/categories`, { headers }),
        fetch(`${API_URL}/api/website-admin/feature-cards`, { headers }),
        fetch(`${API_URL}/api/website-admin/homepage`, { headers }),
        fetch(`${API_URL}/api/website-admin/collections-page-settings`, { headers }),
        fetch(`${API_URL}/api/website-admin/trade-account-settings`, { headers }),
      ]);

      if (heroRes.ok) {
        const data = await heroRes.json();
        setHeroSlides(data.slides || data || []);
      }

      if (benefitsRes.ok) {
        const data = await benefitsRes.json();
        setBenefitsBar(data || []);
      }

      if (categoriesRes.ok) {
        const data = await categoriesRes.json();
        setCategories(data || []);
      }

      if (featuresRes.ok) {
        const data = await featuresRes.json();
        setFeatureCards(data || []);
      }

      if (contentRes.ok) {
        const data = await contentRes.json();
        setHomepageContent(data || {});
      }

      // Fetch collections page hero slides (Kitchen Tiles, Bathroom, etc.)
      if (collectionsRes.ok) {
        const data = await collectionsRes.json();
        const heroSlides = data.settings?.heroSlides || DEFAULT_COLLECTIONS_HERO_SLIDES;
        setPageBanners(heroSlides);
      } else {
        // Use defaults if no settings saved yet
        setPageBanners(DEFAULT_COLLECTIONS_HERO_SLIDES);
      }

      // Fetch trade account settings for the trade banner
      if (tradeRes.ok) {
        const data = await tradeRes.json();
        setTradeSettings(data.settings || {});
      }
    } catch (error) {
      console.error('Error fetching homepage data:', error);
      toast.error('Failed to load homepage data');
    } finally {
      setLoading(false);
    }
  };

  // Page Banner handlers - saves to collections page settings
  const handleSaveBanner = async () => {
    try {
      const token = localStorage.getItem('token');
      let updatedBanners;
      
      if (editingBanner) {
        // Update existing banner
        updatedBanners = pageBanners.map(b => 
          b.id === editingBanner.id ? { ...b, ...bannerForm, id: b.id } : b
        );
      } else {
        // Add new banner
        const newBanner = {
          ...bannerForm,
          id: `banner_${Date.now()}`,
          enabled: true
        };
        updatedBanners = [...pageBanners, newBanner];
      }
      
      // Save to collections page settings
      const res = await fetch(`${API_URL}/api/website-admin/collections-page-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          settings: {
            heroSlides: updatedBanners
          }
        })
      });
      
      if (res.ok) {
        toast.success(editingBanner ? 'Banner updated' : 'Banner created');
        setPageBanners(updatedBanners);
        setShowBannerDialog(false);
        setEditingBanner(null);
        setBannerForm({ title: '', subtitle: '', image: '', link: '', overlay: 'rgba(0,0,0,0.3)', enabled: true });
      } else {
        throw new Error('Failed to save');
      }
    } catch (error) {
      toast.error('Failed to save banner');
    }
  };

  const handleDeleteBanner = async (bannerId) => {
    if (!window.confirm('Delete this banner?')) return;
    try {
      const token = localStorage.getItem('token');
      const updatedBanners = pageBanners.filter(b => b.id !== bannerId);
      
      const res = await fetch(`${API_URL}/api/website-admin/collections-page-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          settings: {
            heroSlides: updatedBanners
          }
        })
      });
      
      if (res.ok) {
        toast.success('Banner deleted');
        setPageBanners(updatedBanners);
      } else {
        throw new Error('Failed to delete');
      }
    } catch (error) {
      toast.error('Failed to delete banner');
    }
  };

  const sections = [
    { id: 'hero', label: 'Hero Carousel', icon: <ImageIcon className="w-4 h-4" /> },
    { id: 'benefits', label: 'Benefits Bar', icon: <Type className="w-4 h-4" /> },
    { id: 'categories', label: 'Shop Categories', icon: <Layout className="w-4 h-4" /> },
    { id: 'styles', label: 'Shop by Styles', icon: <Palette className="w-4 h-4" /> },
    { id: 'trade', label: 'Trade Account Banner', icon: <Building2 className="w-4 h-4" /> },
    { id: 'features', label: 'Shopping With Us', icon: <Sparkles className="w-4 h-4" /> },
    { id: 'brands', label: 'Brand Marquee', icon: <Award className="w-4 h-4" /> },
    { id: 'video', label: 'Video Showroom', icon: <Video className="w-4 h-4" /> },
    { id: 'tours', label: 'Showroom Tours', icon: <Film className="w-4 h-4" /> },
    { id: 'reviews', label: 'Google Reviews', icon: <Star className="w-4 h-4" /> },
    { id: 'banners', label: 'Collections Banners', icon: <Monitor className="w-4 h-4" /> },
    { id: 'footer', label: 'Footer', icon: <Layout className="w-4 h-4" /> },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Homepage Manager</h1>
            <p className="text-sm text-gray-500">Manage all homepage sections in one place</p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => setShowPreview(!showPreview)}>
              <Eye className="w-4 h-4 mr-2" />
              {showPreview ? 'Hide Preview' : 'Show Preview'}
            </Button>
            <Button variant="outline" onClick={fetchAllData}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
            <a 
              href="/shop" 
              target="_blank" 
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800"
            >
              <ExternalLink className="w-4 h-4" />
              View Live Site
            </a>
            <a
              href="/admin/live-chat"
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              <MessageCircle className="w-4 h-4" />
              Live Chat
            </a>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex gap-6">
          {/* Sidebar Navigation */}
          <div className="w-64 flex-shrink-0">
            <div className="bg-white rounded-xl shadow-sm p-4 sticky top-24">
              <h3 className="font-semibold text-gray-900 mb-4">Sections</h3>
              <nav className="space-y-1">
                {sections.map((section) => (
                  <button
                    key={section.id}
                    onClick={() => setActiveSection(section.id)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors ${
                      activeSection === section.id
                        ? 'bg-amber-100 text-amber-900 font-medium'
                        : 'text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    {section.icon}
                    {section.label}
                  </button>
                ))}
              </nav>
            </div>
          </div>

          {/* Main Content */}
          <div className="flex-1">
            {activeSection === 'hero' && (
              <HeroSlidesEditor slides={heroSlides} setSlides={setHeroSlides} />
            )}
            {activeSection === 'benefits' && (
              <BenefitsBarEditor benefits={benefitsBar} setBenefits={setBenefitsBar} />
            )}
            {activeSection === 'categories' && (
              <HomepageCategoriesEditor categories={categories} setCategories={setCategories} onRefresh={fetchAllData} />
            )}
            {activeSection === 'styles' && (
              <HomepageStylesEditor />
            )}
            {activeSection === 'trade' && (
              <TradeBannerEditor settings={tradeSettings} setSettings={setTradeSettings} saving={tradeSaving} setSaving={setTradeSaving} />
            )}
            {activeSection === 'features' && (
              <FeatureCardsEditor cards={featureCards} setCards={setFeatureCards} />
            )}
            {activeSection === 'brands' && (
              <BrandMarqueeEditor />
            )}
            {activeSection === 'video' && (
              <VideoShowroomEditor />
            )}
            {activeSection === 'tours' && (
              <ShowroomToursEditor />
            )}
            {activeSection === 'reviews' && (
              <GoogleReviewsEditor />
            )}
            {activeSection === 'banners' && (
              <PageBannersEditor 
                banners={pageBanners} 
                setBanners={setPageBanners}
                showBannerDialog={showBannerDialog}
                setShowBannerDialog={setShowBannerDialog}
                editingBanner={editingBanner}
                setEditingBanner={setEditingBanner}
                bannerForm={bannerForm}
                setBannerForm={setBannerForm}
                handleSaveBanner={handleSaveBanner}
                handleDeleteBanner={handleDeleteBanner}
                onRefresh={fetchAllData}
              />
            )}
            {activeSection === 'footer' && (
              <>
                <FooterEditor />
                <div className="mt-8">
                  <InfoPagesEditor />
                </div>
              </>
            )}
          </div>

          {/* Preview Panel */}
          {showPreview && (
            <div className="w-96 flex-shrink-0">
              <div className="bg-white rounded-xl shadow-sm sticky top-24 overflow-hidden">
                <div className="p-4 border-b bg-gray-50">
                  <h3 className="font-semibold text-gray-900">Live Preview</h3>
                  <p className="text-xs text-gray-500">Preview how sections will appear</p>
                </div>
                <div className="h-[600px] overflow-y-auto">
                  <iframe 
                    src="/shop"
                    className="w-full h-full scale-50 origin-top-left"
                    style={{ width: '200%', height: '200%' }}
                    title="Homepage Preview"
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Hero Slides Editor Component
function HeroSlidesEditor({ slides, setSlides }) {
  const [saving, setSaving] = useState(false);
  const [editingSlide, setEditingSlide] = useState(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const heroFileInputRef = React.useRef(null);

  const copyImageUrl = (url) => {
    if (!url) return;
    navigator.clipboard.writeText(url);
    setCopiedUrl(true);
    toast.success('Image URL copied!');
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  // Handle image upload for hero slides
  const handleHeroImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !editingSlide) return;
    
    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }
    
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must be less than 5MB');
      return;
    }
    
    setUploadingImage(true);
    try {
      const token = localStorage.getItem('token');
      const formData = new FormData();
      formData.append('file', file);
      
      const res = await fetch(`${API_URL}/api/upload-image`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      
      if (res.ok) {
        const data = await res.json();
        updateSlide(editingSlide.id, 'image', data.url);
        toast.success('Image uploaded!');
      } else {
        throw new Error('Upload failed');
      }
    } catch (error) {
      toast.error('Failed to upload image');
    } finally {
      setUploadingImage(false);
      if (heroFileInputRef.current) heroFileInputRef.current.value = '';
    }
  };

  const handleSave = async (slidesToSave) => {
    const data = Array.isArray(slidesToSave) ? slidesToSave : slides;
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/hero-slides`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ slides: data })
      });

      if (res.ok) {
        toast.success('Hero slides saved!');
      } else {
        toast.error('Failed to save');
      }
    } catch (error) {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const addSlide = () => {
    const newSlide = {
      id: Date.now().toString(),
      title: 'New Slide',
      subtitle: 'Add your subtitle here',
      badge: 'NEW',
      cta: 'Shop Now',
      link: '/tiles',
      image: '',
      theme: 'default',
      discount: '',
      badgeColor: '',
      badgeTextColor: '',
      ctaColor: '',
      ctaTextColor: '',
      is_active: true
    };
    setSlides([...slides, newSlide]);
    setEditingSlide(newSlide);
  };

  const updateSlide = (id, field, value) => {
    setSlides(slides.map(s => s.id === id ? { ...s, [field]: value } : s));
    if (editingSlide?.id === id) {
      setEditingSlide({ ...editingSlide, [field]: value });
    }
  };

  const deleteSlide = (id) => {
    if (window.confirm('Delete this slide?')) {
      const remaining = slides.filter(s => s.id !== id);
      setSlides(remaining);
      if (editingSlide?.id === id) setEditingSlide(null);
      // Auto-save after deletion to keep backend in sync
      handleSave(remaining);
    }
  };

  const onDragEnd = (result) => {
    if (!result.destination) return;
    const reordered = Array.from(slides);
    const [moved] = reordered.splice(result.source.index, 1);
    reordered.splice(result.destination.index, 0, moved);
    setSlides(reordered);
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Hero Carousel</h2>
            <p className="text-sm text-gray-500">Manage the main banner slides on your homepage</p>
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={addSlide}>
              <Plus className="w-4 h-4 mr-2" />
              Add Slide
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save Changes
            </Button>
          </div>
        </div>

        {/* Slides Grid - Drag & Drop */}
        <DragDropContext onDragEnd={onDragEnd}>
          <Droppable droppableId="hero-slides" direction="horizontal">
            {(provided) => (
              <div 
                className="grid grid-cols-2 gap-4"
                ref={provided.innerRef}
                {...provided.droppableProps}
              >
                {slides.map((slide, idx) => (
                  <Draggable key={slide.id || `slide-${idx}`} draggableId={slide.id || `slide-${idx}`} index={idx}>
                    {(provided, snapshot) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.draggableProps}
                        className={`relative group rounded-lg overflow-hidden border-2 cursor-pointer transition-all ${
                          snapshot.isDragging ? 'border-amber-500 ring-2 ring-amber-300 shadow-xl z-10' :
                          editingSlide?.id === slide.id ? 'border-amber-500 ring-2 ring-amber-200' : 'border-gray-200 hover:border-gray-300'
                        }`}
                        onClick={() => setEditingSlide(slide)}
                        data-testid={`hero-slide-${idx}`}
                      >
                        {/* Drag handle */}
                        <div 
                          {...provided.dragHandleProps} 
                          className="absolute top-2 left-2 z-20 p-1.5 bg-white/90 rounded-lg shadow opacity-0 group-hover:opacity-100 transition-opacity cursor-grab active:cursor-grabbing"
                          onClick={(e) => e.stopPropagation()}
                          data-testid={`hero-slide-drag-handle-${idx}`}
                        >
                          <GripVertical className="w-4 h-4 text-gray-500" />
                        </div>
                        <div className="aspect-video bg-gray-100">
                          {slide.image ? (
                            <img src={normaliseImageUrl(slide.image)} alt={slide.title} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-400">
                              <ImageIcon className="w-12 h-12" />
                            </div>
                          )}
                        </div>
                        <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent pointer-events-none" />
                        <div className="absolute bottom-0 left-0 right-0 p-4 pointer-events-none">
                          <span className="inline-block px-2 py-1 bg-amber-400 text-xs font-bold rounded mb-2">{slide.badge}</span>
                          <h3 className="text-white font-bold line-clamp-1">{slide.title}</h3>
                          <p className="text-white/70 text-sm line-clamp-1">{slide.subtitle}</p>
                        </div>
                        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 z-20">
                          <button 
                            onClick={(e) => { e.stopPropagation(); setEditingSlide(slide); }}
                            className="p-1.5 bg-white rounded-lg shadow hover:bg-gray-100"
                          >
                            <Edit2 className="w-4 h-4 text-gray-600" />
                          </button>
                          <button 
                            onClick={(e) => { e.stopPropagation(); deleteSlide(slide.id); }}
                            className="p-1.5 bg-white rounded-lg shadow hover:bg-red-50"
                          >
                            <Trash2 className="w-4 h-4 text-red-600" />
                          </button>
                        </div>
                        {!slide.is_active && (
                          <div className="absolute top-2 left-10 px-2 py-1 bg-gray-800 text-white text-xs rounded z-10">
                            Hidden
                          </div>
                        )}
                      </div>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>

        {slides.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            <ImageIcon className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No slides yet. Click "Add Slide" to create one.</p>
          </div>
        )}
      </div>

      {/* Edit Slide Panel */}
      {editingSlide && (
        <div className="bg-white rounded-xl shadow-sm p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-bold text-gray-900">Edit Slide</h3>
            <button onClick={() => setEditingSlide(null)} className="p-2 hover:bg-gray-100 rounded-lg">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-4">
              {/* Theme Selector */}
              <div>
                <Label>Slide Theme</Label>
                <select
                  value={editingSlide.theme || 'default'}
                  onChange={(e) => updateSlide(editingSlide.id, 'theme', e.target.value)}
                  className="w-full mt-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-transparent"
                  data-testid="slide-theme-selector"
                >
                  <option value="default">Default (Yellow badge, white text)</option>
                  <option value="sale">Sale (Big bold red layout)</option>
                  <option value="image-only">Image Only (No text overlay)</option>
                </select>
              </div>

              {editingSlide.theme !== 'image-only' && (
                <>
                  <div>
                    <Label>Badge Text</Label>
                    <Input 
                      value={editingSlide.badge || ''} 
                      onChange={(e) => updateSlide(editingSlide.id, 'badge', e.target.value)}
                      placeholder={editingSlide.theme === 'sale' ? 'e.g., LIMITED TIME ONLY' : 'e.g., NEW, SALE'}
                    />
                  </div>
                  <div>
                    <Label>Title</Label>
                    <Input 
                      value={editingSlide.title || ''} 
                      onChange={(e) => updateSlide(editingSlide.id, 'title', e.target.value)}
                      placeholder={editingSlide.theme === 'sale' ? 'e.g., BIG SALE ON' : 'Main headline'}
                    />
                  </div>
                  {editingSlide.theme === 'sale' && (
                    <div>
                      <Label>Discount Text <span className="text-red-500 text-xs font-normal">(shown in red)</span></Label>
                      <Input 
                        value={editingSlide.discount || ''} 
                        onChange={(e) => updateSlide(editingSlide.id, 'discount', e.target.value)}
                        placeholder="e.g., UP TO 70% OFF"
                      />
                    </div>
                  )}
                  <div>
                    <Label>Subtitle</Label>
                    <Textarea 
                      value={editingSlide.subtitle || ''} 
                      onChange={(e) => updateSlide(editingSlide.id, 'subtitle', e.target.value)}
                      placeholder="Supporting text"
                      rows={2}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>Button Text</Label>
                      <Input 
                        value={editingSlide.cta || ''} 
                        onChange={(e) => updateSlide(editingSlide.id, 'cta', e.target.value)}
                        placeholder="Shop Now"
                      />
                    </div>
                    <div>
                      <Label>Button Link</Label>
                      <Input 
                        value={editingSlide.link || ''} 
                        onChange={(e) => updateSlide(editingSlide.id, 'link', e.target.value)}
                        placeholder="/tiles"
                      />
                    </div>
                  </div>

                  {/* Color Customisation */}
                  {editingSlide.theme !== 'default' && (
                    <div className="pt-2 border-t border-gray-100">
                      <p className="text-xs text-gray-500 font-medium mb-3 uppercase tracking-wider">Colours</p>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label className="text-xs">Badge Colour</Label>
                          <div className="flex items-center gap-2 mt-1">
                            <input type="color" value={editingSlide.badgeColor || '#DC2626'} onChange={(e) => updateSlide(editingSlide.id, 'badgeColor', e.target.value)} className="w-8 h-8 rounded cursor-pointer border-0" />
                            <Input value={editingSlide.badgeColor || '#DC2626'} onChange={(e) => updateSlide(editingSlide.id, 'badgeColor', e.target.value)} className="text-xs h-8" />
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs">Button Colour</Label>
                          <div className="flex items-center gap-2 mt-1">
                            <input type="color" value={editingSlide.ctaColor || '#DC2626'} onChange={(e) => updateSlide(editingSlide.id, 'ctaColor', e.target.value)} className="w-8 h-8 rounded cursor-pointer border-0" />
                            <Input value={editingSlide.ctaColor || '#DC2626'} onChange={(e) => updateSlide(editingSlide.id, 'ctaColor', e.target.value)} className="text-xs h-8" />
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}

              {editingSlide.theme === 'image-only' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label>Click Link</Label>
                    <Input 
                      value={editingSlide.link || ''} 
                      onChange={(e) => updateSlide(editingSlide.id, 'link', e.target.value)}
                      placeholder="/tiles?sale=true"
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="slide_active"
                  checked={editingSlide.is_active !== false}
                  onChange={(e) => updateSlide(editingSlide.id, 'is_active', e.target.checked)}
                  className="w-4 h-4 rounded"
                />
                <label htmlFor="slide_active" className="text-sm text-gray-700">Show this slide</label>
              </div>
            </div>
            <div>
              <Label>Background Image</Label>
              <div 
                className="mt-2 aspect-video bg-gray-100 rounded-lg overflow-hidden border-2 border-dashed border-gray-300 cursor-pointer hover:border-amber-400 transition-colors"
                onClick={() => !uploadingImage && heroFileInputRef.current?.click()}
                data-testid="hero-image-dropzone"
              >
                {editingSlide.image ? (
                  <img src={normaliseImageUrl(editingSlide.image)} alt="Preview" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center text-gray-400">
                    <Upload className="w-8 h-8 mb-2" />
                    <span className="text-sm">Upload image</span>
                  </div>
                )}
              </div>
              <div className="flex gap-2 mt-2">
                <Input 
                  className="flex-1"
                  value={editingSlide.image || ''} 
                  onChange={(e) => updateSlide(editingSlide.id, 'image', e.target.value)}
                  placeholder="Paste image URL or upload"
                />
                <input
                  type="file"
                  ref={heroFileInputRef}
                  onChange={handleHeroImageUpload}
                  accept="image/*"
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => heroFileInputRef.current?.click()}
                  disabled={uploadingImage}
                  data-testid="hero-upload-btn"
                >
                  {uploadingImage ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4" />
                  )}
                </Button>
                {editingSlide.image && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => copyImageUrl(editingSlide.image)}
                    data-testid="hero-copy-url-btn"
                    className={copiedUrl ? 'text-green-600 border-green-300' : ''}
                  >
                    {copiedUrl ? (
                      <Check className="w-4 h-4" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Benefits Bar Editor Component
function BenefitsBarEditor({ benefits, setBenefits }) {
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/benefits-bar`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(benefits)
      });

      if (res.ok) {
        toast.success('Benefits bar saved!');
      } else {
        toast.error('Failed to save');
      }
    } catch (error) {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const addBenefit = () => {
    setBenefits([...benefits, { text: 'New benefit', link: '/shop' }]);
  };

  const updateBenefit = (index, field, value) => {
    setBenefits(benefits.map((b, i) => i === index ? { ...b, [field]: value } : b));
  };

  const deleteBenefit = (index) => {
    setBenefits(benefits.filter((_, i) => i !== index));
  };

  return (
    <div className="bg-white rounded-xl shadow-sm p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Benefits Bar</h2>
          <p className="text-sm text-gray-500">The dark bar at the top showing key benefits</p>
        </div>
        <div className="flex gap-3">
          <Button variant="outline" onClick={addBenefit}>
            <Plus className="w-4 h-4 mr-2" />
            Add Benefit
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            Save
          </Button>
        </div>
      </div>

      {/* Preview */}
      <div className="bg-[#1a1a1a] text-white py-2 px-4 rounded-lg mb-6">
        <div className="flex justify-center items-center gap-8 text-sm flex-wrap">
          {benefits.map((benefit, idx) => (
            <span key={idx} className="hover:text-yellow-400">{benefit.text}</span>
          ))}
        </div>
      </div>

      {/* Editor */}
      <div className="space-y-3">
        {benefits.map((benefit, idx) => (
          <div key={idx} className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg">
            <GripVertical className="w-5 h-5 text-gray-400 cursor-move" />
            <div className="flex-1 grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs">Text</Label>
                <Input 
                  value={benefit.text}
                  onChange={(e) => updateBenefit(idx, 'text', e.target.value)}
                  placeholder="Benefit text"
                />
              </div>
              <div>
                <Label className="text-xs">Link</Label>
                <Input 
                  value={benefit.link}
                  onChange={(e) => updateBenefit(idx, 'link', e.target.value)}
                  placeholder="/shop/..."
                />
              </div>
            </div>
            <button onClick={() => deleteBenefit(idx)} className="p-2 hover:bg-red-100 rounded-lg">
              <Trash2 className="w-4 h-4 text-red-600" />
            </button>
          </div>
        ))}
      </div>

      {benefits.length === 0 && (
        <div className="text-center py-8 text-gray-500">
          <p>No benefits added. Click "Add Benefit" to create one.</p>
        </div>
      )}
    </div>
  );
}

// Homepage Categories Editor Component
function HomepageCategoriesEditor({ categories, setCategories, onRefresh }) {
  const [saving, setSaving] = useState(false);
  const [editingImage, setEditingImage] = useState(null); // category id being edited
  const [imageUrl, setImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [reordering, setReordering] = useState(false);
  // Editable destination link (paste any URL/path; empty = default category route)
  const [editingLink, setEditingLink] = useState(null); // category id being link-edited
  const [linkUrl, setLinkUrl] = useState('');
  // Quick-search filter for the category grid. With 12+ tiles on the
  // homepage AND a long "Available Categories" list, scrolling is slow
  // when admins are hunting for one specific tile (e.g. "Mosaic"). Match
  // is case-insensitive on category name; trims whitespace.
  const [categorySearch, setCategorySearch] = useState('');
  // Per-tab "I've QA'd this banner" checklist. Keyed by category id, value
  // is the exact URL that was verified — so if the admin later edits the
  // URL the green checkmark auto-clears (URL no longer matches). Lives in
  // sessionStorage so it survives navigation within the tab but resets on
  // tab close (we don't want stale "verified" cues hanging around forever).
  const VERIFIED_KEY = 'homepageManager_verifiedLinks';
  const [verifiedLinks, setVerifiedLinks] = useState(() => {
    try {
      const raw = sessionStorage.getItem(VERIFIED_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const persistVerified = (next) => {
    setVerifiedLinks(next);
    try { sessionStorage.setItem(VERIFIED_KEY, JSON.stringify(next)); } catch {}
  };
  const markLinkVerified = (catId, url) => {
    if (!url) return;
    persistVerified({ ...verifiedLinks, [catId]: url });
  };
  const clearLinkVerified = (catId) => {
    if (!(catId in verifiedLinks)) return;
    const next = { ...verifiedLinks };
    delete next[catId];
    persistVerified(next);
  };

  // Batch QA: opens every overridden category URL in a background tab,
  // 200ms apart, and stamps each one as verified for the session. Designed
  // for the "right-before-promo Friday" ritual — three seconds, all 8 tiles
  // checked, every pill goes emerald. Falls back gracefully if the browser
  // pop-up blocker swallows tabs (we always update the verified state, the
  // worst case is a re-click on the survivors).
  const verifyAllOverrides = () => {
    const targets = homepageCategories.filter(c => c.custom_url && c.custom_url.trim());
    if (targets.length === 0) {
      toast.info('No category overrides to verify yet — set a custom link first.');
      return;
    }
    toast.success(`Opening ${targets.length} ${targets.length === 1 ? 'tile' : 'tiles'} in new tabs…`);
    const next = { ...verifiedLinks };
    targets.forEach((cat, idx) => {
      const id = cat._id || cat.id;
      const url = cat.custom_url;
      next[id] = url;
      // Stagger opens 200ms apart so browsers treat them as user-initiated.
      setTimeout(() => {
        try { window.open(url, '_blank', 'noopener,noreferrer'); } catch {}
      }, idx * 200);
    });
    persistVerified(next);
  };

  // Copy the public storefront homepage URL to the clipboard so the admin
  // can drop it straight into Slack/email/marketing review without forcing
  // the recipient to log into admin. Live homepage already reflects every
  // current override, so the link IS the preview.
  const copyShareLink = async () => {
    try {
      const url = `${window.location.origin}/shop`;
      // navigator.clipboard requires HTTPS in most browsers — both preview
      // and Railway prod are HTTPS so we don't bother with a fallback.
      await navigator.clipboard.writeText(url);
      toast.success('Homepage link copied — paste it into Slack or email for sign-off', {
        description: url,
      });
    } catch {
      toast.error('Could not copy link — your browser may block clipboard access.');
    }
  };
  const homepageCategories = categories.filter(c => c.show_on_homepage)
    .sort((a, b) => (a.display_order || 0) - (b.display_order || 0));

  // Apply the search filter on top — kept as a separate derived list so
  // verifyAllOverrides / counts still operate on the FULL set even while
  // the admin is searching for a single tile.
  const searchTerm = categorySearch.trim().toLowerCase();
  const matchesSearch = (cat) => !searchTerm || (cat.name || '').toLowerCase().includes(searchTerm);
  const visibleHomepageCategories = homepageCategories.filter(matchesSearch);
  const visibleAvailableCategories = categories.filter(c => !c.show_on_homepage && matchesSearch(c));

  const toggleHomepage = async (category) => {
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/categories/${category._id || category.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ 
          ...category, 
          show_on_homepage: !category.show_on_homepage 
        })
      });

      if (res.ok) {
        toast.success(category.show_on_homepage ? 'Removed from homepage' : 'Added to homepage');
        onRefresh();
      }
    } catch (error) {
      toast.error('Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const handleImageUpload = async (category, file) => {
    setUploading(true);
    try {
      const token = localStorage.getItem('token');
      const formData = new FormData();
      formData.append('file', file);
      formData.append('folder', 'categories');

      const uploadRes = await fetch(`${API_URL}/api/website-admin/upload-image`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });

      if (uploadRes.ok) {
        const { url } = await uploadRes.json();
        const fullUrl = url.startsWith('http') ? url : `${API_URL}${url}`;
        await saveImageUrl(category, fullUrl);
      } else {
        toast.error('Image upload failed');
      }
    } catch (error) {
      toast.error('Image upload failed');
    } finally {
      setUploading(false);
    }
  };

  const saveImageUrl = async (category, url) => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/categories/${category._id || category.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...category, image_url: url })
      });

      if (res.ok) {
        toast.success('Image updated');
        setEditingImage(null);
        setImageUrl('');
        onRefresh();
      } else {
        toast.error('Failed to save image');
      }
    } catch (error) {
      toast.error('Failed to save image');
    }
  };

  // Save a custom destination link (relative path or full URL). Empty string
  // clears the override and reverts to the default category route.
  const saveCustomUrl = async (category, url) => {
    try {
      const token = localStorage.getItem('token');
      const trimmed = (url || '').trim();
      // Light validation: must be relative path or http(s) URL
      if (trimmed && !/^(https?:\/\/|\/)/.test(trimmed)) {
        toast.error('Link must start with /, http://, or https://');
        return;
      }
      const res = await fetch(`${API_URL}/api/website-admin/categories/${category._id || category.id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ ...category, custom_url: trimmed || null })
      });
      if (res.ok) {
        toast.success(trimmed ? 'Link updated' : 'Link cleared (default route restored)');
        // Editing/clearing the URL invalidates the "QA'd this tile" cue —
        // a fresh URL needs a fresh verification.
        clearLinkVerified(category._id || category.id);
        setEditingLink(null);
        setLinkUrl('');
        onRefresh();
      } else {
        const body = await res.json().catch(() => ({}));
        toast.error(body.detail || 'Failed to save link');
      }
    } catch (error) {
      toast.error('Failed to save link');
    }
  };

  const handleCategoryDragEnd = async (result) => {
    if (!result.destination || result.source.index === result.destination.index) return;
    const reordered = Array.from(homepageCategories);
    const [moved] = reordered.splice(result.source.index, 1);
    reordered.splice(result.destination.index, 0, moved);

    // Optimistic update
    const updatedCategories = categories.map(c => {
      const idx = reordered.findIndex(r => (r._id || r.id) === (c._id || c.id));
      if (idx !== -1) return { ...c, display_order: idx };
      return c;
    });
    setCategories(updatedCategories);

    // Save to backend
    setReordering(true);
    try {
      const token = localStorage.getItem('token');
      const order = reordered.map((cat, idx) => ({
        id: cat._id || cat.id,
        display_order: idx
      }));
      const res = await fetch(`${API_URL}/api/website-admin/categories/reorder`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(order)
      });
      if (res.ok) {
        toast.success('Categories reordered');
      } else {
        toast.error('Failed to save order');
        onRefresh();
      }
    } catch {
      toast.error('Failed to save order');
      onRefresh();
    } finally {
      setReordering(false);
    }
  };

  // Compact relative-time formatter for the "Updated X ago" tile footer.
  // Returns null when the category has no updated_at (legacy seeded rows).
  const formatRelativeTime = (iso) => {
    if (!iso) return null;
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return null;
    const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (diffSec < 60) return 'just now';
    const diffMin = Math.round(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.round(diffHr / 24);
    if (diffDay < 30) return `${diffDay}d ago`;
    const diffMo = Math.round(diffDay / 30);
    if (diffMo < 12) return `${diffMo}mo ago`;
    return `${Math.round(diffMo / 12)}y ago`;
  };

  const renderCategoryCard = (cat, isOnHomepage, dragHandleProps = null) => {
    const catId = cat._id || cat.id;
    const isEditing = editingImage === catId;
    const isEditingLink = editingLink === catId;
    const updatedRelative = formatRelativeTime(cat.updated_at);
    const updatedTitle = cat.updated_at ? new Date(cat.updated_at).toLocaleString() : '';

    return (
      <div key={catId} className="flex flex-col">
      <div 
        className={`relative group rounded-lg overflow-hidden border-2 ${
          isOnHomepage ? 'border-green-500' : 'border-gray-200 hover:border-gray-300'
        }`}
      >
        {/* Drag handle - only for homepage categories */}
        {dragHandleProps && (
          <div
            {...dragHandleProps}
            className="absolute top-2 left-2 p-1 bg-white/90 hover:bg-white rounded-md opacity-0 group-hover:opacity-100 transition-opacity z-10 cursor-grab active:cursor-grabbing"
            title="Drag to reorder"
          >
            <GripVertical className="w-4 h-4 text-gray-500" />
          </div>
        )}
        <div className="aspect-square bg-gray-100">
          {cat.image_url ? (
            <img src={normaliseImageUrl(cat.image_url)} alt={cat.name} className={`w-full h-full object-cover ${!isOnHomepage ? 'opacity-60' : ''}`} />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-400">
              <ImageIcon className="w-8 h-8" />
            </div>
          )}
        </div>
        <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
          <span className="text-white font-bold text-center px-2">{cat.name}</span>
        </div>

        {/* Toggle homepage button */}
        {isOnHomepage ? (
          <button
            onClick={() => toggleHomepage(cat)}
            className="absolute top-2 right-2 p-1.5 bg-green-500 text-white rounded-full z-10"
            disabled={saving}
            data-testid={`toggle-homepage-${catId}`}
          >
            <Check className="w-4 h-4" />
          </button>
        ) : (
          <div 
            className="absolute top-2 right-2 p-1.5 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer z-10"
            onClick={() => toggleHomepage(cat)}
          >
            <Plus className="w-4 h-4 text-gray-600" />
          </div>
        )}

        {/* Image edit button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditingImage(isEditing ? null : catId);
            setImageUrl(cat.image_url || '');
          }}
          className="absolute bottom-2 right-2 p-1.5 bg-white/90 hover:bg-white text-gray-700 rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-10"
          data-testid={`edit-image-${catId}`}
          title="Change image"
        >
          <Image className="w-4 h-4" />
        </button>

        {/* Link edit button — paste any URL/path to override the default
            category route. Empty value reverts to the default. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditingLink(isEditingLink ? null : catId);
            setLinkUrl(cat.custom_url || '');
          }}
          className={`absolute bottom-2 right-12 p-1.5 ${
            cat.custom_url
              ? 'bg-amber-500 text-white hover:bg-amber-600 opacity-100'
              : 'bg-white/90 hover:bg-white text-gray-700 opacity-0 group-hover:opacity-100'
          } rounded-full transition z-10`}
          data-testid={`edit-link-${catId}`}
          title={cat.custom_url ? `Custom link: ${cat.custom_url}` : 'Set custom link'}
        >
          <LinkIcon className="w-4 h-4" />
        </button>

        {/* Link edit overlay */}
        {isEditingLink && (
          <div className="absolute inset-0 bg-black/85 flex flex-col items-center justify-center p-3 z-30" onClick={(e) => e.stopPropagation()}>
            <p className="text-white text-xs font-medium mb-2">Custom destination link</p>
            <p className="text-gray-300 text-[10px] mb-2 leading-tight text-center">
              Paste any URL or path<br />
              (e.g. <code>/shop/collection/Ridgeway</code> or <code>https://...</code>)
            </p>
            <div className="w-full flex gap-1">
              <input
                type="text"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveCustomUrl(cat, linkUrl); }}
                placeholder="/shop/category/..."
                className="flex-1 px-2 py-1 text-xs rounded bg-white text-gray-900 min-w-0"
                data-testid={`link-url-input-${catId}`}
                autoFocus
              />
              <button
                onClick={() => saveCustomUrl(cat, linkUrl)}
                className="px-2 py-1 bg-green-500 hover:bg-green-600 text-white rounded text-xs"
                data-testid={`save-link-url-${catId}`}
                title="Save link"
              >
                <Check className="w-3 h-3" />
              </button>
            </div>
            <div className="w-full flex justify-between mt-2">
              <button
                onClick={() => { setEditingLink(null); setLinkUrl(''); }}
                className="text-gray-300 hover:text-white text-[11px] underline"
              >
                Cancel
              </button>
              {cat.custom_url && (
                <button
                  onClick={() => saveCustomUrl(cat, '')}
                  className="text-amber-300 hover:text-amber-100 text-[11px] underline"
                  data-testid={`clear-link-${catId}`}
                  title="Clear custom link, restore default"
                >
                  Reset to default
                </button>
              )}
            </div>
          </div>
        )}

        {/* Image edit overlay */}
        {isEditing && (
          <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center p-3 z-20" onClick={(e) => e.stopPropagation()}>
            <p className="text-white text-xs font-medium mb-2">Change Image</p>
            
            {/* Upload button */}
            <label className="w-full cursor-pointer mb-2">
              <div className="flex items-center justify-center gap-1 px-3 py-1.5 bg-white text-gray-800 rounded text-xs font-medium hover:bg-gray-100">
                <Upload className="w-3 h-3" />
                {uploading ? 'Uploading...' : 'Upload File'}
              </div>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  if (e.target.files[0]) handleImageUpload(cat, e.target.files[0]);
                }}
                data-testid={`upload-image-${catId}`}
              />
            </label>
            
            {/* URL input */}
            <div className="w-full flex gap-1">
              <input
                type="text"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="Paste URL..."
                className="flex-1 px-2 py-1 text-xs rounded bg-white text-gray-900 min-w-0"
                data-testid={`image-url-input-${catId}`}
              />
              <button
                onClick={() => { if (imageUrl.trim()) saveImageUrl(cat, imageUrl.trim()); }}
                className="px-2 py-1 bg-green-500 text-white rounded text-xs"
                disabled={!imageUrl.trim()}
                data-testid={`save-image-url-${catId}`}
              >
                <Check className="w-3 h-3" />
              </button>
            </div>

            {/* Cancel */}
            <button 
              onClick={() => { setEditingImage(null); setImageUrl(''); }}
              className="mt-2 text-white/70 hover:text-white text-xs"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
        {/* Custom-URL preview strip — when an admin has overridden the
            default route, show the saved link inline (truncated, with a
            tooltip for the full value) so they can scan all tiles at a
            glance instead of clicking each one to inspect. The path
            text opens the editor; the trailing arrow opens the URL in a
            new tab so you can spot-check typos (e.g. /Ridgway vs /Ridgeway)
            without leaving this screen. Once you've opened the link, the
            pill flips emerald with a ✓ for the rest of the session — a
            quick visual checklist when reviewing 8+ banners pre-promo. */}
        {cat.custom_url && (() => {
          const isVerified = verifiedLinks[catId] === cat.custom_url;
          const wrapClasses = isVerified
            ? 'mt-1.5 mx-auto max-w-full inline-flex items-center rounded bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-800 transition overflow-hidden'
            : 'mt-1.5 mx-auto max-w-full inline-flex items-center rounded bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-800 transition overflow-hidden';
          const arrowClasses = isVerified
            ? 'flex-shrink-0 px-1.5 py-0.5 border-l border-emerald-200 hover:bg-emerald-200 hover:text-emerald-900'
            : 'flex-shrink-0 px-1.5 py-0.5 border-l border-amber-200 hover:bg-amber-200 hover:text-amber-900';
          const textHoverClass = isVerified ? 'hover:bg-emerald-100' : 'hover:bg-amber-100';
          return (
            <div
              className={wrapClasses}
              data-testid={`category-link-preview-${catId}`}
              data-verified={isVerified ? 'true' : 'false'}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingLink(catId);
                  setLinkUrl(cat.custom_url || '');
                }}
                title={
                  isVerified
                    ? `Verified this session: ${cat.custom_url} (click to edit)`
                    : `Custom link: ${cat.custom_url} (click to edit)`
                }
                className={`flex-1 min-w-0 flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono truncate ${textHoverClass}`}
              >
                {isVerified ? (
                  <Check className="w-3 h-3 flex-shrink-0" />
                ) : (
                  <LinkIcon className="w-3 h-3 flex-shrink-0" />
                )}
                <span className="truncate">{cat.custom_url}</span>
              </button>
              <a
                href={cat.custom_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.stopPropagation();
                  // Mark this exact URL as QA'd for the rest of the session.
                  markLinkVerified(catId, cat.custom_url);
                }}
                title={
                  isVerified
                    ? "Verified this session — click to re-open"
                    : "Open in new tab to verify it lands on a real page"
                }
                className={arrowClasses}
                data-testid={`category-link-open-${catId}`}
              >
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          );
        })()}
        {/* Relative-time footer — instant QA cue for stale homepage tiles
            before promo go-lives. Falls back gracefully if updated_at missing. */}
        <p
          className="mt-1 text-[11px] text-gray-500 text-center truncate"
          title={updatedTitle ? `Last updated: ${updatedTitle}` : ''}
          data-testid={`category-updated-${catId}`}
        >
          {updatedRelative ? `Updated ${updatedRelative}` : <span className="text-gray-300">—</span>}
        </p>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Homepage Categories</h2>
            <p className="text-sm text-gray-500">Select which categories appear on the homepage and set their images</p>
          </div>
          <span className="text-sm text-gray-500">{homepageCategories.length} shown on homepage</span>
        </div>

        {/* Quick search filter — case-insensitive name match across both
            "Showing on Homepage" and "Available Categories". Verify-all and
            counts still operate on the full set so search never hides
            unverified tiles. */}
        <div className="relative mb-5 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          <input
            type="text"
            value={categorySearch}
            onChange={(e) => setCategorySearch(e.target.value)}
            placeholder="Search categories by name…"
            className="w-full pl-9 pr-9 py-2 text-sm rounded-md border border-gray-200 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            data-testid="category-search-input"
          />
          {categorySearch && (
            <button
              type="button"
              onClick={() => setCategorySearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
              title="Clear search"
              data-testid="category-search-clear"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Currently on Homepage - Drag to reorder */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-700">Showing on Homepage</h3>
            <div className="flex items-center gap-3">
              {reordering && <span className="text-xs text-indigo-500 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Saving order...</span>}
              {(() => {
                const overrideCount = homepageCategories.filter(c => c.custom_url && c.custom_url.trim()).length;
                if (overrideCount === 0) return null;
                const verifiedCount = homepageCategories.filter(c => c.custom_url && verifiedLinks[c._id || c.id] === c.custom_url).length;
                const allVerified = verifiedCount === overrideCount;
                return (
                  <>
                    <button
                      type="button"
                      onClick={verifyAllOverrides}
                      title="Opens every override URL in a new tab (200ms apart) and marks each as verified"
                      className={`text-xs font-medium px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 transition border ${
                        allVerified
                          ? 'bg-emerald-50 hover:bg-emerald-100 border-emerald-200 text-emerald-800'
                          : 'bg-amber-50 hover:bg-amber-100 border-amber-200 text-amber-800'
                      }`}
                      data-testid="verify-all-links-button"
                    >
                      {allVerified ? <Check className="w-3.5 h-3.5" /> : <ExternalLink className="w-3.5 h-3.5" />}
                      {allVerified
                        ? `All ${overrideCount} verified`
                        : `Verify all ${overrideCount} ${overrideCount === 1 ? 'link' : 'links'} (${verifiedCount}/${overrideCount})`}
                    </button>
                    {/* Once everything's been QA'd, surface a one-click share
                        link copier so admins can drop the homepage URL straight
                        into Slack/email for marketing sign-off. Stays visible
                        but de-emphasized when verification is incomplete so
                        admins still notice the verify step first. */}
                    <button
                      type="button"
                      onClick={copyShareLink}
                      title={allVerified
                        ? 'Copy the public storefront homepage URL — paste into Slack/email for sign-off'
                        : `Copy storefront link (tip: verify the ${overrideCount - verifiedCount} remaining ${overrideCount - verifiedCount === 1 ? 'override' : 'overrides'} first)`}
                      className={`text-xs font-medium px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 transition border ${
                        allVerified
                          ? 'bg-indigo-600 hover:bg-indigo-700 border-indigo-600 text-white'
                          : 'bg-white hover:bg-gray-50 border-gray-200 text-gray-600'
                      }`}
                      data-testid="copy-share-link-button"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      Copy share link
                    </button>
                  </>
                );
              })()}
            </div>
          </div>
          <DragDropContext onDragEnd={handleCategoryDragEnd}>
            <Droppable droppableId="homepage-categories" direction="horizontal">
              {(provided) => (
                <div
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className="flex flex-wrap gap-4"
                >
                  {visibleHomepageCategories.map((cat, index) => {
                    const catId = cat._id || cat.id;
                    return (
                      <Draggable key={catId} draggableId={catId} index={index}>
                        {(dragProvided, snapshot) => (
                          <div
                            ref={dragProvided.innerRef}
                            {...dragProvided.draggableProps}
                            className="w-[calc(25%-12px)]"
                            style={{
                              ...dragProvided.draggableProps.style,
                              ...(snapshot.isDragging ? { zIndex: 50, boxShadow: '0 10px 25px rgba(0,0,0,0.25)', opacity: 0.95 } : {})
                            }}
                          >
                            {renderCategoryCard(cat, true, dragProvided.dragHandleProps)}
                          </div>
                        )}
                      </Draggable>
                    );
                  })}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          </DragDropContext>
          {homepageCategories.length === 0 && (
            <p className="text-gray-500 text-sm">No categories selected for homepage</p>
          )}
          {homepageCategories.length > 0 && visibleHomepageCategories.length === 0 && (
            <p className="text-gray-500 text-sm italic">No homepage tiles match &ldquo;{categorySearch}&rdquo;</p>
          )}
        </div>

        {/* Available Categories */}
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Available Categories</h3>
          <div className="grid grid-cols-4 gap-4">
            {visibleAvailableCategories.map((cat) => renderCategoryCard(cat, false))}
          </div>
          {searchTerm && visibleAvailableCategories.length === 0 && (
            <p className="text-gray-500 text-sm italic">No available categories match &ldquo;{categorySearch}&rdquo;</p>
          )}
        </div>
      </div>
    </div>
  );
}


// Homepage Styles Editor Component
function HomepageStylesEditor() {
  const [styles, setStyles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [editingImage, setEditingImage] = useState(null);
  const [imageUrl, setImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);

  const fetchStyles = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/filters/homepage-styles/all`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setStyles(data);
      }
    } catch (error) {
      toast.error('Failed to load styles');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchStyles(); }, []);

  const toggleHomepage = async (style) => {
    setSaving(style.value);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/filters/homepage-styles/update-value`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filter_id: style.filter_id,
          value: style.value,
          show_on_homepage: !style.show_on_homepage
        })
      });
      if (res.ok) {
        toast.success(style.show_on_homepage ? 'Removed from homepage' : 'Added to homepage');
        fetchStyles();
      }
    } catch (error) {
      toast.error('Failed to update');
    } finally {
      setSaving(null);
    }
  };

  const handleImageUpload = async (style, file) => {
    setUploading(true);
    try {
      const token = localStorage.getItem('token');
      const formData = new FormData();
      formData.append('file', file);
      formData.append('folder', 'styles');

      const uploadRes = await fetch(`${API_URL}/api/website-admin/upload-image`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });

      if (uploadRes.ok) {
        const { url } = await uploadRes.json();
        const fullUrl = url.startsWith('http') ? url : `${API_URL}${url}`;
        await saveStyleImage(style, fullUrl);
      } else {
        toast.error('Image upload failed');
      }
    } catch (error) {
      toast.error('Image upload failed');
    } finally {
      setUploading(false);
    }
  };

  const saveStyleImage = async (style, url) => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/filters/homepage-styles/update-value`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filter_id: style.filter_id,
          value: style.value,
          image_url: url
        })
      });

      if (res.ok) {
        toast.success('Image updated');
        setEditingImage(null);
        setImageUrl('');
        fetchStyles();
      } else {
        toast.error('Failed to save image');
      }
    } catch (error) {
      toast.error('Failed to save image');
    }
  };

  const homepageStyles = styles.filter(s => s.show_on_homepage);
  const availableStyles = styles.filter(s => !s.show_on_homepage);

  const renderStyleCard = (style, isOnHomepage) => {
    const styleKey = `${style.filter_id}-${style.value}`;
    const isEditing = editingImage === styleKey;

    return (
      <div 
        key={styleKey}
        className={`relative group rounded-lg overflow-hidden border-2 ${
          isOnHomepage ? 'border-green-500' : 'border-gray-200 hover:border-gray-300'
        }`}
      >
        <div className="aspect-[4/3] bg-gray-100">
          {style.image_url ? (
            <img src={normaliseImageUrl(style.image_url)} alt={style.label} className={`w-full h-full object-cover ${!isOnHomepage ? 'opacity-60' : ''}`} />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-400">
              <ImageIcon className="w-8 h-8" />
            </div>
          )}
        </div>
        <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center">
          <span className="text-white font-bold text-center px-2">{style.label}</span>
          <span className="text-white/60 text-xs mt-0.5">{style.filter_name}</span>
        </div>

        {/* Toggle homepage */}
        {isOnHomepage ? (
          <button
            onClick={() => toggleHomepage(style)}
            className="absolute top-2 right-2 p-1.5 bg-green-500 text-white rounded-full z-10"
            disabled={saving === style.value}
            data-testid={`toggle-style-${style.value}`}
          >
            <Check className="w-4 h-4" />
          </button>
        ) : (
          <div 
            className="absolute top-2 right-2 p-1.5 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer z-10"
            onClick={() => toggleHomepage(style)}
          >
            <Plus className="w-4 h-4 text-gray-600" />
          </div>
        )}

        {/* Image edit button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditingImage(isEditing ? null : styleKey);
            setImageUrl(style.image_url || '');
          }}
          className="absolute bottom-2 right-2 p-1.5 bg-white/90 hover:bg-white text-gray-700 rounded-full opacity-0 group-hover:opacity-100 transition-opacity z-10"
          data-testid={`edit-style-image-${style.value}`}
          title="Change image"
        >
          <Image className="w-4 h-4" />
        </button>

        {/* Image edit overlay */}
        {isEditing && (
          <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center p-3 z-20" onClick={(e) => e.stopPropagation()}>
            <p className="text-white text-xs font-medium mb-2">Change Image</p>
            
            <label className="w-full cursor-pointer mb-2">
              <div className="flex items-center justify-center gap-1 px-3 py-1.5 bg-white text-gray-800 rounded text-xs font-medium hover:bg-gray-100">
                <Upload className="w-3 h-3" />
                {uploading ? 'Uploading...' : 'Upload File'}
              </div>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  if (e.target.files[0]) handleImageUpload(style, e.target.files[0]);
                }}
                data-testid={`upload-style-image-${style.value}`}
              />
            </label>
            
            <div className="w-full flex gap-1">
              <input
                type="text"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                placeholder="Paste URL..."
                className="flex-1 px-2 py-1 text-xs rounded bg-white text-gray-900 min-w-0"
                data-testid={`style-image-url-input-${style.value}`}
              />
              <button
                onClick={() => { if (imageUrl.trim()) saveStyleImage(style, imageUrl.trim()); }}
                className="px-2 py-1 bg-green-500 text-white rounded text-xs"
                disabled={!imageUrl.trim()}
              >
                <Check className="w-3 h-3" />
              </button>
            </div>

            <button 
              onClick={() => { setEditingImage(null); setImageUrl(''); }}
              className="mt-2 text-white/70 hover:text-white text-xs"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm p-6 flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Shop by Styles</h2>
            <p className="text-sm text-gray-500">Select which styles appear on the homepage and set their images</p>
          </div>
          <span className="text-sm text-gray-500">{homepageStyles.length} shown on homepage</span>
        </div>

        {/* On Homepage */}
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Showing on Homepage</h3>
          {homepageStyles.length > 0 ? (
            <div className="grid grid-cols-4 gap-4">
              {homepageStyles.map((style) => renderStyleCard(style, true))}
            </div>
          ) : (
            <p className="text-gray-500 text-sm">No styles selected for homepage. Add styles from below.</p>
          )}
        </div>

        {/* Available */}
        {availableStyles.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-gray-700 mb-3">Available Styles ({availableStyles.length})</h3>
            <div className="grid grid-cols-4 gap-4">
              {availableStyles.map((style) => renderStyleCard(style, false))}
            </div>
          </div>
        )}

        {styles.length === 0 && (
          <p className="text-gray-500 text-sm">No style filters found. Add style filters in Navigation & Structure first.</p>
        )}
      </div>
    </div>
  );
}


// Feature Cards Editor Component
function FeatureCardsEditor({ cards, setCards }) {
  const [saving, setSaving] = useState(false);
  const [editingCard, setEditingCard] = useState(null);

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      
      // Save each card. Backend returns the row id as `id` (not `_id`),
      // so check both fields when deciding PUT vs POST. Bug fix: previously
      // we only checked `_id` which was always undefined → every save
      // created a duplicate row instead of updating the existing one.
      for (const card of cards) {
        const cardId = card._id || card.id;
        const isExisting = !!cardId;
        const method = isExisting ? 'PUT' : 'POST';
        const url = isExisting
          ? `${API_URL}/api/website-admin/feature-cards/${cardId}`
          : `${API_URL}/api/website-admin/feature-cards`;
        
        await fetch(url, {
          method,
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(card)
        });
      }
      
      toast.success('Feature cards saved!');
    } catch (error) {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const addCard = () => {
    const newCard = {
      id: Date.now().toString(),
      title: 'New Feature',
      description: 'Describe this feature',
      icon: 'Star',
      link: '/shop',
      display_order: cards.length,
      is_active: true
    };
    setCards([...cards, newCard]);
    setEditingCard(newCard);
  };

  const updateCard = (id, field, value) => {
    setCards(cards.map(c => (c.id === id || c._id === id) ? { ...c, [field]: value } : c));
    if (editingCard && (editingCard.id === id || editingCard._id === id)) {
      setEditingCard({ ...editingCard, [field]: value });
    }
  };

  const deleteCard = async (card) => {
    if (!window.confirm('Delete this feature card?')) return;
    
    const cardId = card._id || card.id;
    if (cardId) {
      try {
        const token = localStorage.getItem('token');
        await fetch(`${API_URL}/api/website-admin/feature-cards/${cardId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${token}` }
        });
      } catch (error) {
        toast.error('Failed to delete');
        return;
      }
    }
    
    setCards(cards.filter(c => (c.id || c._id) !== cardId));
    if (editingCard && ((editingCard.id || editingCard._id) === cardId)) {
      setEditingCard(null);
    }
    toast.success('Card deleted');
  };

  const getIconComponent = (iconName) => {
    const iconMap = {
      'Palette': <Palette className="w-6 h-6" />,
      'Package': <Package className="w-6 h-6" />,
      'MapPin': <MapPin className="w-6 h-6" />,
      'Truck': <Truck className="w-6 h-6" />,
      'Star': <Star className="w-6 h-6" />,
      'Heart': <Heart className="w-6 h-6" />,
      'Sparkles': <Sparkles className="w-6 h-6" />,
    };
    return iconMap[iconName] || <Star className="w-6 h-6" />;
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Shopping With Us</h2>
            <p className="text-sm text-gray-500">Feature cards showing your key selling points</p>
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={addCard}>
              <Plus className="w-4 h-4 mr-2" />
              Add Card
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save
            </Button>
          </div>
        </div>

        {/* Preview */}
        <div className="bg-gray-50 p-6 rounded-lg mb-6">
          <h3 className="text-lg font-bold text-center mb-6">Preview: Shopping with us</h3>
          <div className="grid grid-cols-5 gap-4">
            {cards.filter(c => c.is_active !== false).map((card) => (
              <div key={card.id || card._id} className="bg-white rounded-xl p-4 text-center shadow-sm">
                <div className="w-12 h-12 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-3 text-amber-700">
                  {getIconComponent(card.icon)}
                </div>
                <h4 className="font-bold text-sm mb-1 line-clamp-1">{card.title}</h4>
                <p className="text-xs text-gray-500 line-clamp-2">{card.description}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Cards List */}
        <div className="space-y-3">
          {cards.map((card, idx) => (
            <div 
              key={card.id || card._id}
              className={`flex items-center gap-4 p-4 rounded-lg border-2 cursor-pointer transition-all ${
                editingCard && (editingCard.id === card.id || editingCard._id === card._id)
                  ? 'border-amber-500 bg-amber-50'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
              onClick={() => setEditingCard(card)}
            >
              <GripVertical className="w-5 h-5 text-gray-400 cursor-move" />
              <div className="w-10 h-10 bg-amber-100 rounded-full flex items-center justify-center text-amber-700">
                {getIconComponent(card.icon)}
              </div>
              <div className="flex-1">
                <h4 className="font-medium text-gray-900">{card.title}</h4>
                <p className="text-sm text-gray-500 line-clamp-1">{card.description}</p>
              </div>
              {card.is_active === false && (
                <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded">Hidden</span>
              )}
              <button 
                onClick={(e) => { e.stopPropagation(); deleteCard(card); }}
                className="p-2 hover:bg-red-100 rounded-lg"
              >
                <Trash2 className="w-4 h-4 text-red-600" />
              </button>
            </div>
          ))}
        </div>

        {cards.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            <p>No feature cards. Click "Add Card" to create one.</p>
          </div>
        )}
      </div>

      {/* Edit Card Panel */}
      {editingCard && (
        <div className="bg-white rounded-xl shadow-sm p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-bold text-gray-900">Edit Feature Card</h3>
            <button onClick={() => setEditingCard(null)} className="p-2 hover:bg-gray-100 rounded-lg">
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-4">
              <div>
                <Label>Icon</Label>
                <div className="flex gap-2 mt-2 flex-wrap">
                  {ICON_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => updateCard(editingCard.id || editingCard._id, 'icon', opt.value)}
                      className={`p-3 rounded-lg border-2 transition-all ${
                        editingCard.icon === opt.value 
                          ? 'border-amber-500 bg-amber-50' 
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                    >
                      {opt.icon}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <Label>Title</Label>
                <Input 
                  value={editingCard.title || ''} 
                  onChange={(e) => updateCard(editingCard.id || editingCard._id, 'title', e.target.value)}
                  placeholder="Feature title"
                />
              </div>
              <div>
                <Label>Description</Label>
                <Textarea 
                  value={editingCard.description || ''} 
                  onChange={(e) => updateCard(editingCard.id || editingCard._id, 'description', e.target.value)}
                  placeholder="Brief description"
                  rows={3}
                />
              </div>
              <div>
                <Label>Link</Label>
                <Input 
                  value={editingCard.link || ''} 
                  onChange={(e) => updateCard(editingCard.id || editingCard._id, 'link', e.target.value)}
                  placeholder="/shop/..."
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="card_active"
                  checked={editingCard.is_active !== false}
                  onChange={(e) => updateCard(editingCard.id || editingCard._id, 'is_active', e.target.checked)}
                  className="w-4 h-4 rounded"
                />
                <label htmlFor="card_active" className="text-sm text-gray-700">Show this card</label>
              </div>
            </div>
            <div className="flex items-center justify-center">
              {/* Card Preview */}
              <div className="bg-white rounded-xl p-6 text-center shadow-lg border w-48">
                <div className="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4 text-amber-700">
                  {getIconComponent(editingCard.icon)}
                </div>
                <h4 className="font-bold mb-2">{editingCard.title}</h4>
                <p className="text-sm text-gray-500">{editingCard.description}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// Trade Banner Icon Map
const TRADE_ICON_MAP = {
  Percent: Percent, Gift: Gift, Truck: Truck, Headphones: Headphones,
  Shield: Shield, Star: Star, Clock: Clock, Zap: Zap, Award: Award,
  Heart: Heart, Package: Package, MapPin: MapPin, Building2: Building2,
};

const TRADE_ICON_OPTIONS = Object.keys(TRADE_ICON_MAP).map(k => ({ value: k, label: k }));

// Trade Account Banner Editor
function TradeBannerEditor({ settings, setSettings, saving, setSaving }) {
  const s = settings || {};
  const banner = s.banner || {};
  const tp = s.trade_pricing || {};
  const benefits = s.banner_benefits || [];
  const [editingField, setEditingField] = useState(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const update = (path, value) => {
    setSettings(prev => {
      const next = { ...prev };
      const parts = path.split('.');
      let obj = next;
      for (let i = 0; i < parts.length - 1; i++) {
        obj[parts[i]] = { ...(obj[parts[i]] || {}) };
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
      return next;
    });
  };

  const updateBenefit = (idx, field, value) => {
    const updated = [...benefits];
    updated[idx] = { ...updated[idx], [field]: value };
    update('banner_benefits', updated);
  };

  const addBenefit = () => {
    update('banner_benefits', [...benefits, { icon: 'Star', text: 'New Benefit', enabled: true }]);
  };

  const removeBenefit = (idx) => {
    update('banner_benefits', benefits.filter((_, i) => i !== idx));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/trade-account-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ settings }),
      });
      if (res.ok) toast.success('Trade banner saved');
      else throw new Error('Failed');
    } catch {
      toast.error('Failed to save trade banner');
    } finally {
      setSaving(false);
    }
  };

  const isEnabled = banner.enabled !== false;

  // Inline editable text helper
  const EditableText = ({ value, onChange, placeholder, className, inputClassName, type = 'text' }) => {
    const fieldKey = placeholder;
    const isEditing = editingField === fieldKey;
    const inputRef = React.useRef(null);
    React.useEffect(() => { if (isEditing && inputRef.current) inputRef.current.focus(); }, [isEditing]);

    if (isEditing) {
      if (type === 'textarea') {
        return (
          <textarea
            ref={inputRef}
            value={value || ''}
            onChange={e => onChange(e.target.value)}
            onBlur={() => setEditingField(null)}
            onKeyDown={e => { if (e.key === 'Escape') setEditingField(null); }}
            placeholder={placeholder}
            className={`bg-white/90 text-gray-900 rounded px-2 py-1 w-full resize-none focus:outline-none focus:ring-2 focus:ring-[#F7EA1C] ${inputClassName || ''}`}
            rows={2}
          />
        );
      }
      if (type === 'number') {
        return (
          <input
            ref={inputRef}
            type="number"
            value={value ?? ''}
            onChange={e => onChange(parseFloat(e.target.value) || 0)}
            onBlur={() => setEditingField(null)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setEditingField(null); }}
            className={`bg-white/90 text-gray-900 rounded px-1 py-0.5 w-16 text-center focus:outline-none focus:ring-2 focus:ring-[#F7EA1C] ${inputClassName || ''}`}
          />
        );
      }
      return (
        <input
          ref={inputRef}
          value={value || ''}
          onChange={e => onChange(e.target.value)}
          onBlur={() => setEditingField(null)}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setEditingField(null); }}
          placeholder={placeholder}
          className={`bg-white/90 text-gray-900 rounded px-2 py-1 w-full focus:outline-none focus:ring-2 focus:ring-[#F7EA1C] ${inputClassName || ''}`}
        />
      );
    }

    return (
      <span
        onClick={() => setEditingField(fieldKey)}
        className={`cursor-pointer hover:ring-2 hover:ring-[#F7EA1C]/60 hover:ring-offset-1 rounded px-0.5 transition-all inline-block ${className || ''}`}
        title="Click to edit"
      >
        {value || <span className="italic opacity-50">{placeholder}</span>}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header with Save + Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Trade Account Banner</h2>
          <p className="text-sm text-gray-500">Click any text in the preview to edit it directly</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving} className="bg-amber-500 hover:bg-amber-600" data-testid="save-trade-banner">
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Save className="w-4 h-4 mr-1" />}
            Save Changes
          </Button>
        </div>
      </div>

      {/* LIVE EDITABLE PREVIEW */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden" data-testid="trade-banner-preview">
        {/* Visibility Toggle Bar */}
        <div className={`flex items-center justify-between px-5 py-3 border-b ${isEnabled ? 'bg-green-50' : 'bg-red-50'}`}>
          <div className="flex items-center gap-3">
            {isEnabled ? (
              <><Eye className="w-4 h-4 text-green-600" /><span className="text-sm font-medium text-green-700">Visible on Homepage</span></>
            ) : (
              <><EyeOff className="w-4 h-4 text-red-500" /><span className="text-sm font-medium text-red-600">Hidden from Homepage</span></>
            )}
          </div>
          <button
            onClick={() => update('banner.enabled', !isEnabled)}
            className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors shadow-sm ${isEnabled ? 'bg-green-500' : 'bg-gray-300'}`}
            data-testid="trade-banner-visibility-toggle"
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform shadow ${isEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>

        {/* Editable Preview */}
        <div className={`bg-[#333333] p-8 relative overflow-hidden transition-opacity ${!isEnabled ? 'opacity-40 pointer-events-none' : ''}`}>
          <div className="absolute inset-0 opacity-10">
            <div className="absolute inset-0" style={{
              backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'60\' height=\'60\' viewBox=\'0 0 60 60\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cg fill=\'none\' fill-rule=\'evenodd\'%3E%3Cg fill=\'%23F7EA1C\' fill-opacity=\'0.4\'%3E%3Cpath d=\'M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z\'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")',
            }} />
          </div>
          <div className="relative z-10 grid md:grid-cols-2 gap-6 max-w-4xl mx-auto">
            {/* Left Column */}
            <div className="text-white">
              <div className="inline-flex items-center gap-2 bg-[#F7EA1C] text-[#333] px-3 py-1 rounded-full text-xs font-semibold mb-3">
                <Award className="w-3 h-3" />
                <EditableText
                  value={banner.badge_text}
                  onChange={v => update('banner.badge_text', v)}
                  placeholder="Badge Text"
                  className="text-[#333]"
                  inputClassName="text-xs"
                />
              </div>
              <h2 className="text-2xl font-bold mb-2">
                <EditableText
                  value={banner.headline}
                  onChange={v => update('banner.headline', v)}
                  placeholder="Headline"
                  className="text-white"
                />{' '}
                <span className="text-[#F7EA1C]">
                  <EditableText
                    value={banner.headline_highlight}
                    onChange={v => update('banner.headline_highlight', v)}
                    placeholder="Highlight"
                    className="text-[#F7EA1C]"
                  />
                </span>
              </h2>
              <div className="text-gray-300 text-sm mb-4">
                <EditableText
                  value={banner.description}
                  onChange={v => update('banner.description', v)}
                  placeholder="Description"
                  type="textarea"
                  className="text-gray-300 block"
                  inputClassName="text-xs"
                />
              </div>
              <div className="grid grid-cols-2 gap-2 mb-4">
                {(benefits.length > 0 ? benefits.filter(b => b.enabled !== false) : [
                  { icon: 'Percent', text: `Up to ${tp.standard_discount ?? 40}% off Standard` },
                  { icon: 'Gift', text: `Up to ${tp.standard_credit_back ?? 5}% Credit Back` },
                  { icon: 'Truck', text: 'Priority Delivery' },
                  { icon: 'Headphones', text: 'Dedicated Support' },
                ]).map((b, idx) => {
                  const Icon = TRADE_ICON_MAP[b.icon] || Star;
                  return (
                    <div key={idx} className="flex items-center gap-2">
                      <div className="w-6 h-6 bg-[#F7EA1C]/20 rounded flex items-center justify-center">
                        <Icon className="w-3 h-3 text-[#F7EA1C]" />
                      </div>
                      <span className="text-xs">{b.text}</span>
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <span className="inline-flex items-center gap-1 bg-[#F7EA1C] text-[#333] font-bold px-4 py-2 rounded-lg text-xs">
                  <Building2 className="w-3 h-3" />
                  <EditableText
                    value={banner.cta_primary_text}
                    onChange={v => update('banner.cta_primary_text', v)}
                    placeholder="Primary CTA"
                    className="text-[#333]"
                    inputClassName="text-xs"
                  />
                </span>
                <span className="inline-flex items-center gap-1 border border-white/30 text-white px-4 py-2 rounded-lg text-xs">
                  <EditableText
                    value={banner.cta_secondary_text}
                    onChange={v => update('banner.cta_secondary_text', v)}
                    placeholder="Secondary CTA"
                    className="text-white"
                    inputClassName="text-xs"
                  />
                </span>
              </div>
            </div>
            {/* Right Column - Pricing */}
            <div className="space-y-2">
              <div className="bg-white/10 backdrop-blur rounded-xl p-3 border border-white/10">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-6 h-6 bg-[#F7EA1C] rounded flex items-center justify-center"><Percent className="w-3 h-3 text-[#333]" /></div>
                  <h3 className="text-white font-bold text-xs uppercase">Trade Discounts</h3>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-red-500/20 rounded-lg p-2 border border-red-500/20 text-center">
                    <p className="text-red-300 text-[9px] uppercase">Sale Prices</p>
                    <p className="text-white text-xl font-black">
                      <span className="text-[8px]">Up to </span>
                      <EditableText value={tp.sale_discount ?? 20} onChange={v => update('trade_pricing.sale_discount', v)} placeholder="20" type="number" className="text-white" inputClassName="text-lg font-black" />
                      <span className="text-xs">%</span>
                    </p>
                    <p className="text-red-300 text-[9px]">extra off</p>
                  </div>
                  <div className="bg-[#F7EA1C]/20 rounded-lg p-2 border border-[#F7EA1C]/20 text-center">
                    <p className="text-[#F7EA1C]/80 text-[9px] uppercase">Standard</p>
                    <p className="text-white text-xl font-black">
                      <span className="text-[8px]">Up to </span>
                      <EditableText value={tp.standard_discount ?? 40} onChange={v => update('trade_pricing.standard_discount', v)} placeholder="40" type="number" className="text-white" inputClassName="text-lg font-black" />
                      <span className="text-xs">%</span>
                    </p>
                    <p className="text-[#F7EA1C]/80 text-[9px]">off retail</p>
                  </div>
                </div>
              </div>
              <div className="bg-white/10 backdrop-blur rounded-xl p-3 border border-white/10">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-6 h-6 bg-green-500 rounded flex items-center justify-center"><Gift className="w-3 h-3 text-white" /></div>
                  <h3 className="text-white font-bold text-xs uppercase">Credit Back Rewards</h3>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-green-500/20 rounded-lg p-2 border border-green-500/20 text-center">
                    <p className="text-green-300 text-[9px] uppercase">From Sale</p>
                    <p className="text-white text-xl font-black">
                      <span className="text-[8px]">Up to </span>
                      <EditableText value={tp.sale_credit_back ?? 3} onChange={v => update('trade_pricing.sale_credit_back', v)} placeholder="3" type="number" className="text-white" inputClassName="text-lg font-black" />
                      <span className="text-xs">%</span>
                    </p>
                    <p className="text-green-300 text-[9px]">credit back</p>
                  </div>
                  <div className="bg-emerald-500/20 rounded-lg p-2 border border-emerald-500/20 text-center">
                    <p className="text-emerald-300 text-[9px] uppercase">Standard</p>
                    <p className="text-white text-xl font-black">
                      <span className="text-[8px]">Up to </span>
                      <EditableText value={tp.standard_credit_back ?? 5} onChange={v => update('trade_pricing.standard_credit_back', v)} placeholder="5" type="number" className="text-white" inputClassName="text-lg font-black" />
                      <span className="text-xs">%</span>
                    </p>
                    <p className="text-emerald-300 text-[9px]">credit back</p>
                  </div>
                </div>
              </div>
              <div className="bg-[#F7EA1C] rounded-lg py-2 px-3 text-center">
                <p className="text-[#333] font-black text-xs uppercase">
                  <EditableText
                    value={tp.tagline}
                    onChange={v => update('trade_pricing.tagline', v)}
                    placeholder="Tagline"
                    className="text-[#333]"
                    inputClassName="text-xs font-black uppercase text-center"
                  />
                </p>
              </div>
            </div>
          </div>
          {/* Hint overlay when not editing */}
          {!editingField && isEnabled && (
            <div className="absolute bottom-2 right-3 bg-black/50 text-white text-[10px] px-2 py-1 rounded-full z-20 pointer-events-none">
              Click any text to edit
            </div>
          )}
        </div>
      </div>

      {/* Benefits List */}
      <div className="bg-white rounded-xl shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-gray-900">Benefits List</h3>
            <p className="text-xs text-gray-500">Shown as bullet points on the left side of the banner</p>
          </div>
          <Button variant="outline" size="sm" onClick={addBenefit}><Plus className="w-4 h-4 mr-1" />Add</Button>
        </div>
        <div className="space-y-3">
          {benefits.map((b, idx) => {
            const Icon = TRADE_ICON_MAP[b.icon] || Star;
            return (
              <div key={idx} className="flex items-center gap-3 p-3 border rounded-lg">
                <div className="w-8 h-8 bg-amber-100 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Icon className="w-4 h-4 text-amber-700" />
                </div>
                <select
                  value={b.icon || 'Star'}
                  onChange={e => updateBenefit(idx, 'icon', e.target.value)}
                  className="text-sm border rounded px-2 py-1.5 w-32"
                >
                  {TRADE_ICON_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <Input value={b.text || ''} onChange={e => updateBenefit(idx, 'text', e.target.value)} className="flex-1" placeholder="Benefit text" />
                <button
                  onClick={() => updateBenefit(idx, 'enabled', !(b.enabled !== false))}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${b.enabled !== false ? 'bg-green-500' : 'bg-gray-300'}`}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${b.enabled !== false ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </button>
                <Button variant="ghost" size="sm" onClick={() => removeBenefit(idx)} className="text-red-500 hover:text-red-700"><Trash2 className="w-4 h-4" /></Button>
              </div>
            );
          })}
          {benefits.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-4">No benefits added. Default benefits will be shown.</p>
          )}
        </div>
      </div>

      {/* Advanced Settings (Collapsible) */}
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <button onClick={() => setShowAdvanced(!showAdvanced)} className="w-full flex items-center justify-between p-4 hover:bg-gray-50 transition-colors">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-gray-400" />
            <span className="font-semibold text-gray-700 text-sm">Advanced Settings</span>
            <span className="text-xs text-gray-400">(CTA links, etc.)</span>
          </div>
          <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
        </button>
        {showAdvanced && (
          <div className="p-4 pt-0 border-t space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs">Primary CTA Link</Label>
                <Input value={banner.cta_primary_link || ''} onChange={e => update('banner.cta_primary_link', e.target.value)} placeholder="/shop/trade/register" className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">Secondary CTA Link</Label>
                <Input value={banner.cta_secondary_link || ''} onChange={e => update('banner.cta_secondary_link', e.target.value)} placeholder="/shop/login" className="mt-1" />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


// Page Banners Editor Component - Manages Collections Page Hero Slides
function PageBannersEditor({ 
  banners, setBanners, showBannerDialog, setShowBannerDialog, 
  editingBanner, setEditingBanner, bannerForm, setBannerForm,
  handleSaveBanner, handleDeleteBanner, onRefresh
}) {
  const [showLinkBrowser, setShowLinkBrowser] = useState(false);
  const [categories, setCategories] = useState([]);
  const [categoryGroups, setCategoryGroups] = useState([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [copiedLink, setCopiedLink] = useState(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileInputRef = React.useRef(null);

  // Handle image upload
  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Validate file type
    if (!file.type.startsWith('image/')) {
      toast.error('Please select an image file');
      return;
    }
    
    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Image must be less than 5MB');
      return;
    }
    
    setUploadingImage(true);
    try {
      const token = localStorage.getItem('token');
      const formData = new FormData();
      formData.append('file', file);
      formData.append('folder', 'banners');
      
      const res = await fetch(`${API_URL}/api/website-admin/upload-image`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      
      if (res.ok) {
        const data = await res.json();
        setBannerForm({ ...bannerForm, image: data.url });
        toast.success('Image uploaded successfully!');
      } else {
        throw new Error('Upload failed');
      }
    } catch (error) {
      console.error('Upload error:', error);
      toast.error('Failed to upload image');
    } finally {
      setUploadingImage(false);
      // Reset file input
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Fetch categories and groups for link browser
  const fetchLinks = async () => {
    setLoadingLinks(true);
    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: `Bearer ${token}` };
      
      const [catRes, groupRes] = await Promise.all([
        fetch(`${API_URL}/api/website-admin/categories`, { headers }),
        fetch(`${API_URL}/api/website-admin/category-groups`, { headers })
      ]);
      
      if (catRes.ok) {
        const data = await catRes.json();
        setCategories(data.filter(c => c.is_active !== false) || []);
      }
      if (groupRes.ok) {
        const data = await groupRes.json();
        setCategoryGroups(data.filter(g => g.is_active !== false) || []);
      }
    } catch (e) {
      console.error('Error fetching links:', e);
    } finally {
      setLoadingLinks(false);
    }
  };

  const copyLink = (link) => {
    navigator.clipboard.writeText(link);
    setCopiedLink(link);
    toast.success('Link copied!');
    setTimeout(() => setCopiedLink(null), 2000);
  };

  const applyLink = (link) => {
    setBannerForm({ ...bannerForm, link });
    toast.success('Link added to banner');
  };

  const openEditDialog = (banner) => {
    setEditingBanner(banner);
    setBannerForm({
      title: banner.title || '',
      subtitle: banner.subtitle || '',
      image: banner.image || '',
      link: banner.link || '',
      overlay: banner.overlay || 'rgba(0,0,0,0.3)',
      enabled: banner.enabled !== false
    });
    setShowBannerDialog(true);
  };

  const openNewDialog = () => {
    setEditingBanner(null);
    setBannerForm({ title: '', subtitle: '', image: '', link: '', overlay: 'rgba(0,0,0,0.3)', enabled: true });
    setShowBannerDialog(true);
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl shadow-sm p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Collections Page Banners</h2>
            <p className="text-sm text-gray-500">Manage the rotating hero banners on the /tiles page (Kitchen Tiles, Bathroom, etc.)</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onRefresh}>
              <RefreshCw className="w-4 h-4 mr-1" />Refresh
            </Button>
            <Button onClick={openNewDialog} className="bg-amber-500 hover:bg-amber-600">
              <Plus className="w-4 h-4 mr-1" />Add Banner
            </Button>
          </div>
        </div>

        {/* Banners List */}
        <div className="grid gap-4">
          {banners.length === 0 ? (
            <div className="text-center py-12 text-gray-500">
              <Monitor className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No banners yet. Create one to get started.</p>
            </div>
          ) : (
            banners.map(banner => (
              <div key={banner.id} className="border rounded-lg p-4 flex items-center gap-4 hover:bg-gray-50 transition-colors">
                {/* Banner Preview */}
                <div className="w-40 h-24 rounded-lg overflow-hidden bg-gray-100 flex-shrink-0 relative">
                  {banner.image ? (
                    <img src={normaliseImageUrl(banner.image)} alt={banner.title} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-400">
                      <Image className="w-8 h-8" />
                    </div>
                  )}
                  <div className="absolute inset-0" style={{ background: banner.overlay || 'rgba(0,0,0,0.3)' }}></div>
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-white text-xs p-2">
                    <p className="font-bold truncate w-full text-center">{banner.title}</p>
                    <p className="opacity-75 truncate w-full text-center">{banner.subtitle}</p>
                  </div>
                </div>

                {/* Banner Info */}
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-gray-900">{banner.title || 'Untitled'}</h3>
                  <p className="text-sm text-gray-500 truncate">{banner.subtitle}</p>
                  <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                    <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded">Link: {banner.link || 'Not set'}</span>
                    <span className={`px-2 py-1 rounded ${banner.enabled !== false ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      {banner.enabled !== false ? 'Enabled' : 'Disabled'}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex gap-2 flex-shrink-0">
                  <Button variant="ghost" size="sm" onClick={() => openEditDialog(banner)}>
                    <Edit2 className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700" onClick={() => handleDeleteBanner(banner.id)}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Link Browser Panel */}
      <div className="bg-white rounded-xl shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-gray-900">Quick Link Browser</h3>
            <p className="text-sm text-gray-500">Find and copy category/collection links for your banners</p>
          </div>
          <Button 
            variant="outline" 
            size="sm"
            onClick={() => {
              setShowLinkBrowser(!showLinkBrowser);
              if (!showLinkBrowser && categories.length === 0) fetchLinks();
            }}
          >
            {showLinkBrowser ? 'Hide Links' : 'Browse Links'}
          </Button>
        </div>
        
        {showLinkBrowser && (
          <div className="space-y-4">
            {loadingLinks ? (
              <div className="text-center py-4 text-gray-500">Loading links...</div>
            ) : (
              <>
                {/* Category Groups */}
                {categoryGroups.length > 0 && (
                  <div>
                    <h4 className="font-medium text-gray-700 mb-2 text-sm">Category Groups</h4>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                      {categoryGroups.map(group => {
                        const link = `/tiles?group=${group.slug}`;
                        return (
                          <div key={group.slug} className="flex items-center justify-between bg-gray-50 rounded-lg p-2 text-sm">
                            <div className="truncate flex-1 mr-2">
                              <span className="font-medium">{group.name}</span>
                            </div>
                            <div className="flex gap-1">
                              <button 
                                onClick={() => copyLink(link)}
                                className={`px-2 py-1 rounded text-xs ${copiedLink === link ? 'bg-green-500 text-white' : 'bg-gray-200 hover:bg-gray-300'}`}
                              >
                                {copiedLink === link ? '✓' : 'Copy'}
                              </button>
                              {showBannerDialog && (
                                <button 
                                  onClick={() => applyLink(link)}
                                  className="px-2 py-1 rounded text-xs bg-amber-500 text-white hover:bg-amber-600"
                                >
                                  Use
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Categories */}
                {categories.length > 0 && (
                  <div>
                    <h4 className="font-medium text-gray-700 mb-2 text-sm">Categories</h4>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-h-64 overflow-y-auto">
                      {categories.map(cat => {
                        const link = `/tiles?category=${cat.slug}`;
                        return (
                          <div key={cat.slug} className="flex items-center justify-between bg-gray-50 rounded-lg p-2 text-sm">
                            <div className="truncate flex-1 mr-2">
                              <span className="font-medium">{cat.name}</span>
                            </div>
                            <div className="flex gap-1">
                              <button 
                                onClick={() => copyLink(link)}
                                className={`px-2 py-1 rounded text-xs ${copiedLink === link ? 'bg-green-500 text-white' : 'bg-gray-200 hover:bg-gray-300'}`}
                              >
                                {copiedLink === link ? '✓' : 'Copy'}
                              </button>
                              {showBannerDialog && (
                                <button 
                                  onClick={() => applyLink(link)}
                                  className="px-2 py-1 rounded text-xs bg-amber-500 text-white hover:bg-amber-600"
                                >
                                  Use
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Common Links */}
                <div>
                  <h4 className="font-medium text-gray-700 mb-2 text-sm">Common Links</h4>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {[
                      { name: 'All Tiles', link: '/tiles' },
                      { name: 'Clearance/Sale', link: '/tiles?sale=true' },
                      { name: 'New Arrivals', link: '/tiles?sort=newest' },
                      { name: 'Sample Service', link: '/sample-service' },
                      { name: 'Our Stores', link: '/stores' },
                      { name: 'Contact Us', link: '/contact' },
                      { name: 'Sign In', link: '/shop/tile-login' },
                      { name: 'Trade Sign In', link: '/shop/trade/login' },
                    ].map(item => (
                      <div key={item.link} className="flex items-center justify-between bg-blue-50 rounded-lg p-2 text-sm">
                        <div className="truncate flex-1 mr-2">
                          <span className="font-medium text-blue-700">{item.name}</span>
                        </div>
                        <div className="flex gap-1">
                          <button 
                            onClick={() => copyLink(item.link)}
                            className={`px-2 py-1 rounded text-xs ${copiedLink === item.link ? 'bg-green-500 text-white' : 'bg-blue-200 hover:bg-blue-300'}`}
                          >
                            {copiedLink === item.link ? '✓' : 'Copy'}
                          </button>
                          {showBannerDialog && (
                            <button 
                              onClick={() => applyLink(item.link)}
                              className="px-2 py-1 rounded text-xs bg-amber-500 text-white hover:bg-amber-600"
                            >
                              Use
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Banner Dialog */}
      {showBannerDialog && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold">{editingBanner ? 'Edit Banner' : 'Add New Banner'}</h3>
                <button onClick={() => setShowBannerDialog(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Title</Label>
                  <Input
                    value={bannerForm.title}
                    onChange={(e) => setBannerForm({ ...bannerForm, title: e.target.value })}
                    placeholder="e.g. Kitchen Tiles"
                  />
                </div>
                <div>
                  <Label>Subtitle</Label>
                  <Input
                    value={bannerForm.subtitle}
                    onChange={(e) => setBannerForm({ ...bannerForm, subtitle: e.target.value })}
                    placeholder="e.g. Where style meets function"
                  />
                </div>
              </div>

              <div>
                <Label>Image</Label>
                <div className="flex gap-2">
                  <Input
                    value={bannerForm.image}
                    onChange={(e) => setBannerForm({ ...bannerForm, image: e.target.value })}
                    placeholder="https://images.unsplash.com/... or upload"
                    className="flex-1"
                  />
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleImageUpload}
                    accept="image/*"
                    className="hidden"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingImage}
                    className="whitespace-nowrap"
                  >
                    {uploadingImage ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                        Uploading...
                      </>
                    ) : (
                      <>
                        <Upload className="w-4 h-4 mr-1" />
                        Upload
                      </>
                    )}
                  </Button>
                </div>
                <p className="text-xs text-gray-500 mt-1">Paste a URL or upload an image (max 5MB)</p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Link URL</Label>
                  <Input
                    value={bannerForm.link}
                    onChange={(e) => setBannerForm({ ...bannerForm, link: e.target.value })}
                    placeholder="/tiles?category=kitchen-tiles"
                  />
                </div>
                <div>
                  <Label>Overlay Color</Label>
                  <Input
                    value={bannerForm.overlay}
                    onChange={(e) => setBannerForm({ ...bannerForm, overlay: e.target.value })}
                    placeholder="rgba(0,0,0,0.3)"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="banner-enabled"
                  checked={bannerForm.enabled}
                  onChange={(e) => setBannerForm({ ...bannerForm, enabled: e.target.checked })}
                  className="w-4 h-4 text-amber-500 rounded"
                />
                <label htmlFor="banner-enabled" className="text-sm text-gray-700">Enabled (show in carousel)</label>
              </div>

              {/* Preview */}
              {(bannerForm.image || bannerForm.title) && (
                <div className="mt-4">
                  <Label>Preview</Label>
                  <div className="relative h-32 rounded-lg overflow-hidden bg-gray-100 mt-2">
                    {bannerForm.image && (
                      <img src={normaliseImageUrl(bannerForm.image)} alt="Preview" className="w-full h-full object-cover" />
                    )}
                    <div className="absolute inset-0" style={{ background: bannerForm.overlay || 'rgba(0,0,0,0.3)' }}></div>
                    <div className="absolute inset-0 flex flex-col items-center justify-center text-white">
                      <h3 className="text-2xl font-bold">{bannerForm.title || 'Title'}</h3>
                      <p className="text-sm opacity-90">{bannerForm.subtitle}</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="p-6 border-t flex justify-end gap-3">
              <Button variant="outline" onClick={() => setShowBannerDialog(false)}>Cancel</Button>
              <Button onClick={handleSaveBanner} className="bg-amber-500 hover:bg-amber-600">
                <Save className="w-4 h-4 mr-1" />Save Banner
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// ============ FOOTER EDITOR ============
const DEFAULT_FOOTER = {
  description: 'Premium quality tiles for your home. Visit our showrooms in Tonbridge, Gravesend, and Chingford.',
  phone: '01732 424242',
  email: 'info@tilestation.co.uk',
  quickLinks: [
    { text: 'All Tiles', url: '/tiles' },
    { text: 'Wall Tiles', url: '/tiles?type=wall' },
    { text: 'Floor Tiles', url: '/tiles?type=floor' },
    { text: 'Store Locations', url: '/shop/contact' },
    { text: 'Trade Accounts', url: '/shop/trade/register' },
  ],
  customerServiceLinks: [
    { text: 'Delivery Information', url: '/shop/info/delivery' },
    { text: 'Returns & Refunds', url: '/shop/info/returns' },
    { text: 'FAQs', url: '/shop/info/faq' },
    { text: 'Contact Us', url: '/shop/info/contact' },
    { text: 'Track Order', url: '/shop/info/track' },
  ],
  showrooms: [
    { name: 'Tonbridge', hours: 'Open 7 days a week' },
    { name: 'Gravesend', hours: 'Open 7 days a week' },
    { name: 'Chingford', hours: 'Open 7 days a week' },
  ],
  copyrightText: 'Tile Station Ltd. All rights reserved.',
  legalLinks: [
    { text: 'Privacy Policy', url: '/shop/info/privacy' },
    { text: 'Terms & Conditions', url: '/shop/info/terms' },
  ],
};

function FooterEditor() {
  const [footer, setFooter] = useState(DEFAULT_FOOTER);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [infoPages, setInfoPages] = useState([]);

  useEffect(() => {
    const fetchFooter = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch(`${API_URL}/api/website-admin/footer-settings`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          if (data.settings && Object.keys(data.settings).length > 0) {
            setFooter({ ...DEFAULT_FOOTER, ...data.settings });
          }
        }
      } catch (err) {
        console.error('Error fetching footer:', err);
      } finally {
        setLoading(false);
      }
    };
    const fetchInfoPages = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch(`${API_URL}/api/website-admin/info-pages`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          setInfoPages(data.pages || []);
        }
      } catch {}
    };
    fetchFooter();
    fetchInfoPages();
  }, []);

  const saveFooter = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/footer-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ settings: footer })
      });
      if (res.ok) {
        toast.success('Footer settings saved!');
      } else {
        toast.error('Failed to save footer settings');
      }
    } catch {
      toast.error('Failed to save footer settings');
    } finally {
      setSaving(false);
    }
  };

  const updateLink = (section, index, field, value) => {
    setFooter(prev => ({
      ...prev,
      [section]: prev[section].map((item, i) => i === index ? { ...item, [field]: value } : item)
    }));
  };

  const addLink = (section) => {
    const template = section === 'showrooms' ? { name: '', hours: '' } : { text: '', url: '' };
    setFooter(prev => ({ ...prev, [section]: [...prev[section], template] }));
  };

  const removeLink = (section, index) => {
    setFooter(prev => ({ ...prev, [section]: prev[section].filter((_, i) => i !== index) }));
  };

  const resetToDefaults = () => {
    if (window.confirm('Reset footer to defaults? This will discard unsaved changes.')) {
      setFooter(DEFAULT_FOOTER);
      toast.success('Reset to defaults. Click Save to apply.');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  const LinkListEditor = ({ title, section, items, fields }) => (
    <div className="space-y-3" data-testid={`footer-${section}-editor`}>
      <div className="flex items-center justify-between">
        <Label className="text-sm font-semibold text-gray-700">{title}</Label>
        <Button variant="outline" size="sm" onClick={() => addLink(section)} data-testid={`add-${section}`}>
          <Plus className="w-3 h-3 mr-1" /> Add
        </Button>
      </div>
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2 bg-gray-50 rounded-lg p-2">
          {fields.map(f => (
            <Input
              key={f.key}
              value={item[f.key] || ''}
              onChange={e => updateLink(section, i, f.key, e.target.value)}
              placeholder={f.placeholder}
              className="flex-1 text-sm"
            />
          ))}
          <button
            onClick={() => removeLink(section, i)}
            className="p-1.5 text-gray-400 hover:text-red-500 transition-colors flex-shrink-0"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );

  return (
    <div className="bg-white rounded-xl shadow-sm" data-testid="footer-editor">
      {/* Header */}
      <div className="p-6 border-b flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Footer</h2>
          <p className="text-sm text-gray-500">Manage the website footer content</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={resetToDefaults}>
            <RefreshCw className="w-4 h-4 mr-1" /> Reset
          </Button>
          <Button onClick={saveFooter} disabled={saving} size="sm" className="bg-amber-500 hover:bg-amber-600">
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Save className="w-4 h-4 mr-1" />}
            Save Footer
          </Button>
        </div>
      </div>

      <div className="p-6 space-y-8">
        {/* Company Info */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Company Info</h3>
          <div>
            <Label className="text-sm text-gray-600 mb-1 block">Description</Label>
            <Textarea
              value={footer.description}
              onChange={e => setFooter(prev => ({ ...prev, description: e.target.value }))}
              rows={2}
              placeholder="Company description for footer"
              data-testid="footer-description"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-sm text-gray-600 mb-1 block">Phone</Label>
              <Input
                value={footer.phone}
                onChange={e => setFooter(prev => ({ ...prev, phone: e.target.value }))}
                placeholder="01234 567890"
                data-testid="footer-phone"
              />
            </div>
            <div>
              <Label className="text-sm text-gray-600 mb-1 block">Email</Label>
              <Input
                value={footer.email}
                onChange={e => setFooter(prev => ({ ...prev, email: e.target.value }))}
                placeholder="info@company.co.uk"
                data-testid="footer-email"
              />
            </div>
          </div>
        </div>

        {/* Quick Links */}
        <LinkListEditor
          title="Quick Links"
          section="quickLinks"
          items={footer.quickLinks}
          fields={[
            { key: 'text', placeholder: 'Link text' },
            { key: 'url', placeholder: '/path' },
          ]}
        />

        {/* Customer Service Links */}
        <LinkListEditor
          title="Customer Service"
          section="customerServiceLinks"
          items={footer.customerServiceLinks}
          fields={[
            { key: 'text', placeholder: 'Link text' },
            { key: 'url', placeholder: '/path' },
          ]}
        />

        {/* Available Info Pages Quick-Add */}
        {infoPages.length > 0 && (
          <div className="space-y-3" data-testid="info-pages-quick-add">
            <Label className="text-sm font-semibold text-gray-700">Available Info Pages</Label>
            <p className="text-xs text-gray-400">Click to add any info page to the Customer Service links above</p>
            <div className="flex flex-wrap gap-2">
              {infoPages.filter(p => p.enabled !== false).map(p => {
                const url = `/shop/info/${p.slug}`;
                const alreadyAdded = footer.customerServiceLinks.some(l => l.url === url) 
                  || footer.legalLinks.some(l => l.url === url);
                return (
                  <button
                    key={p.slug}
                    onClick={() => {
                      if (!alreadyAdded) {
                        setFooter(prev => ({
                          ...prev,
                          customerServiceLinks: [...prev.customerServiceLinks, { text: p.title, url }]
                        }));
                        toast.success(`Added "${p.title}" to Customer Service links`);
                      }
                    }}
                    disabled={alreadyAdded}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                      alreadyAdded 
                        ? 'bg-green-50 text-green-600 border-green-200 cursor-default' 
                        : 'bg-white text-gray-600 border-gray-200 hover:bg-amber-50 hover:border-amber-300 hover:text-amber-700'
                    }`}
                    data-testid={`add-info-page-${p.slug}`}
                  >
                    {alreadyAdded ? '✓' : '+'} {p.title}
                    <span className="ml-1 text-gray-400 font-normal">/shop/info/{p.slug}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Showrooms */}
        <LinkListEditor
          title="Showrooms"
          section="showrooms"
          items={footer.showrooms}
          fields={[
            { key: 'name', placeholder: 'Showroom name' },
            { key: 'hours', placeholder: 'Opening hours' },
          ]}
        />

        {/* Legal / Copyright */}
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Legal</h3>
          <div>
            <Label className="text-sm text-gray-600 mb-1 block">Copyright Text</Label>
            <Input
              value={footer.copyrightText}
              onChange={e => setFooter(prev => ({ ...prev, copyrightText: e.target.value }))}
              placeholder="Company Ltd. All rights reserved."
              data-testid="footer-copyright"
            />
            <p className="text-xs text-gray-400 mt-1">Year is added automatically</p>
          </div>
          <LinkListEditor
            title="Legal Links"
            section="legalLinks"
            items={footer.legalLinks}
            fields={[
              { key: 'text', placeholder: 'Link text' },
              { key: 'url', placeholder: '/path' },
            ]}
          />
        </div>

        {/* Live Preview */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Preview</h3>
          <div className="bg-[#1a1a1a] text-white rounded-xl p-6 text-sm">
            <div className="grid grid-cols-4 gap-6">
              <div>
                <p className="text-gray-400 text-xs">{footer.description}</p>
                <p className="mt-2 text-xs text-yellow-400">{footer.phone}</p>
                <p className="text-xs text-yellow-400">{footer.email}</p>
              </div>
              <div>
                <h4 className="font-bold text-yellow-400 text-xs mb-2">Quick Links</h4>
                {footer.quickLinks.map((l, i) => (
                  <p key={i} className="text-gray-400 text-xs">{l.text}</p>
                ))}
              </div>
              <div>
                <h4 className="font-bold text-yellow-400 text-xs mb-2">Customer Service</h4>
                {footer.customerServiceLinks.map((l, i) => (
                  <p key={i} className="text-gray-400 text-xs">{l.text}</p>
                ))}
              </div>
              <div>
                <h4 className="font-bold text-yellow-400 text-xs mb-2">Our Showrooms</h4>
                {footer.showrooms.map((s, i) => (
                  <div key={i} className="mb-1">
                    <p className="text-white text-xs font-medium">{s.name}</p>
                    <p className="text-gray-400 text-xs">{s.hours}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="border-t border-gray-700 mt-4 pt-3 flex justify-between text-xs text-gray-500">
              <span>&copy; {new Date().getFullYear()} {footer.copyrightText}</span>
              <div className="flex gap-4">
                {footer.legalLinks.map((l, i) => (
                  <span key={i}>{l.text}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


const API_URL_ADMIN = process.env.REACT_APP_BACKEND_URL;


function GoogleReviewsEditor() {
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [visible, setVisible] = React.useState(true);
  const [rating, setRating] = React.useState('4.9');
  const [reviews, setReviews] = React.useState([]);

  React.useEffect(() => {
    const fetch_ = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch(`${API_URL_ADMIN}/api/website-admin/homepage`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const data = await res.json();
        if (data) {
          if (data.google_reviews_visible !== undefined) setVisible(data.google_reviews_visible);
          if (data.google_reviews_rating) setRating(data.google_reviews_rating);
          if (data.google_reviews?.length > 0) setReviews(data.google_reviews);
        }
      } catch (e) {
        console.error('Failed to load reviews', e);
      } finally {
        setLoading(false);
      }
    };
    fetch_();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL_ADMIN}/api/website-admin/homepage`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          google_reviews_visible: visible,
          google_reviews_rating: rating,
          google_reviews: reviews,
        }),
      });
      if (res.ok) toast.success('Reviews saved');
      else toast.error('Failed to save');
    } catch (e) {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const addReview = () => {
    setReviews(prev => [...prev, { id: Date.now().toString(), name: '', text: '', date: '' }]);
  };

  const updateReview = (i, field, val) => {
    setReviews(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: val } : r));
  };

  const removeReview = (i) => {
    setReviews(prev => prev.filter((_, idx) => idx !== i));
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  return (
    <div className="space-y-6" data-testid="google-reviews-editor">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Google Reviews</h2>
          <p className="text-sm text-gray-500">Curate your best 5-star reviews to display on the homepage</p>
        </div>
        <Button onClick={save} disabled={saving} size="sm" data-testid="save-reviews">
          {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
          Save Changes
        </Button>
      </div>

      {/* Visibility */}
      <div className="flex items-center justify-between p-4 bg-white rounded-lg border" data-testid="reviews-visibility">
        <div>
          <p className="font-medium">Show on Homepage</p>
          <p className="text-sm text-gray-500">Toggle the Google Reviews section</p>
        </div>
        <button
          onClick={() => setVisible(!visible)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${visible ? 'bg-amber-500' : 'bg-gray-300'}`}
          data-testid="reviews-toggle"
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${visible ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {/* Rating */}
      <div className="bg-white rounded-lg border p-6 space-y-3">
        <h3 className="font-semibold text-gray-900">Overall Rating</h3>
        <div className="flex items-center gap-3">
          <Input value={rating} onChange={(e) => setRating(e.target.value)} placeholder="4.9" className="w-24" data-testid="rating-input" />
          <div className="flex gap-0.5">
            {[1,2,3,4,5].map(s => (
              <Star key={s} className={`w-5 h-5 ${s <= Math.round(parseFloat(rating) || 0) ? 'fill-yellow-400 text-yellow-400' : 'text-gray-300'}`} />
            ))}
          </div>
          <span className="text-sm text-gray-500">Displayed as the headline rating</span>
        </div>
      </div>

      {/* Reviews List */}
      <div className="bg-white rounded-lg border p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">Reviews ({reviews.length})</h3>
          <Button variant="outline" size="sm" onClick={addReview} data-testid="add-review">
            <Plus className="w-4 h-4 mr-1" /> Add Review
          </Button>
        </div>

        {reviews.length === 0 && (
          <div className="text-center py-8 text-gray-400">
            <Star className="w-10 h-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No reviews added yet. Add your best Google reviews.</p>
          </div>
        )}

        <div className="space-y-3">
          {reviews.map((r, i) => (
            <div key={r.id || i} className="border rounded-lg p-4 space-y-3" data-testid={`review-${i}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 font-bold text-sm">
                    {(r.name || '?')[0].toUpperCase()}
                  </div>
                  <span className="font-medium text-sm">{r.name || 'New Review'}</span>
                </div>
                <button onClick={() => removeReview(i)} className="text-red-400 hover:text-red-600" data-testid={`review-remove-${i}`}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Reviewer Name</Label>
                  <Input value={r.name} onChange={(e) => updateReview(i, 'name', e.target.value)} placeholder="John Smith" className="h-9 text-sm" data-testid={`review-name-${i}`} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Date (optional)</Label>
                  <Input value={r.date} onChange={(e) => updateReview(i, 'date', e.target.value)} placeholder="2 weeks ago" className="h-9 text-sm w-36" data-testid={`review-date-${i}`} />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Review Text</Label>
                <Textarea value={r.text} onChange={(e) => updateReview(i, 'text', e.target.value)} placeholder="Write the review text..." rows={2} className="text-sm" data-testid={`review-text-${i}`} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


function ShowroomToursEditor() {
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [visible, setVisible] = React.useState(false);
  const [title, setTitle] = React.useState('Explore Our Showrooms');
  const [subtitle, setSubtitle] = React.useState('Take a virtual tour of each location');
  const [videos, setVideos] = React.useState([]);
  const [activePreviewIdx, setActivePreviewIdx] = React.useState(0);
  const [showPreview, setShowPreview] = React.useState(false);

  const fileInputRefs = React.useRef({});
  const thumbInputRefs = React.useRef({});

  React.useEffect(() => {
    const fetchSettings = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch(`${API_URL_ADMIN}/api/website-admin/homepage`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const data = await res.json();
        if (data) {
          if (data.showroom_tours_visible !== undefined) setVisible(data.showroom_tours_visible);
          if (data.showroom_tours_title) setTitle(data.showroom_tours_title);
          if (data.showroom_tours_subtitle) setSubtitle(data.showroom_tours_subtitle);
          if (data.showroom_tours_videos && data.showroom_tours_videos.length > 0) {
            setVideos(data.showroom_tours_videos);
          }
        }
      } catch (e) {
        console.error('Failed to load showroom tours settings', e);
      } finally {
        setLoading(false);
      }
    };
    fetchSettings();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL_ADMIN}/api/website-admin/homepage`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          showroom_tours_visible: visible,
          showroom_tours_title: title,
          showroom_tours_subtitle: subtitle,
          showroom_tours_videos: videos.map(({ _uploading, ...rest }) => rest),
        }),
      });
      if (res.ok) toast.success('Showroom tours saved');
      else toast.error('Failed to save');
    } catch (e) {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const addVideo = () => {
    setVideos(prev => [...prev, {
      id: Date.now().toString(),
      title: '',
      description: '',
      video_url: '',
      thumbnail_url: '',
      enabled: true,
    }]);
  };

  const updateVideo = (index, field, value) => {
    setVideos(prev => prev.map((v, i) => i === index ? { ...v, [field]: value } : v));
  };

  const removeVideo = (index) => {
    setVideos(prev => prev.filter((_, i) => i !== index));
    if (activePreviewIdx >= index && activePreviewIdx > 0) {
      setActivePreviewIdx(prev => prev - 1);
    }
  };

  const moveVideo = (index, direction) => {
    const newVideos = [...videos];
    const target = index + direction;
    if (target < 0 || target >= newVideos.length) return;
    [newVideos[index], newVideos[target]] = [newVideos[target], newVideos[index]];
    setVideos(newVideos);
  };

  const handleVideoUpload = async (index, e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 200 * 1024 * 1024) {
      toast.error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 200MB.`);
      return;
    }
    const validTypes = ['video/mp4', 'video/webm', 'video/quicktime'];
    if (!validTypes.includes(file.type)) {
      toast.error('Invalid file type. Allowed: MP4, WebM, MOV');
      return;
    }

    updateVideo(index, '_uploading', true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL_ADMIN}/api/website-admin/homepage/upload-video`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) throw new Error('Upload failed');
      const result = await res.json();
      const servePath = result.storage_path.replace('tile-station/homepage/', '');
      updateVideo(index, 'video_url', `${API_URL_ADMIN}/api/website-admin/homepage/media/${servePath}`);
      updateVideo(index, '_uploading', false);
      toast.success(`Video uploaded: ${result.original_filename}`);
    } catch (err) {
      updateVideo(index, '_uploading', false);
      toast.error('Video upload failed');
    }
  };

  const handleThumbUpload = async (index, e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image too large. Max 10MB.');
      return;
    }
    try {
      const formData = new FormData();
      formData.append('file', file);
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL_ADMIN}/api/website-admin/homepage/upload-thumbnail`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) throw new Error('Upload failed');
      const result = await res.json();
      const servePath = result.storage_path.replace('tile-station/homepage/', '');
      updateVideo(index, 'thumbnail_url', `${API_URL_ADMIN}/api/website-admin/homepage/media/${servePath}`);
      toast.success('Thumbnail uploaded');
    } catch (err) {
      toast.error('Thumbnail upload failed');
    }
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  const enabledVideos = videos.filter(v => v.enabled);
  const previewVideo = enabledVideos[activePreviewIdx] || enabledVideos[0];

  return (
    <div className="space-y-6" data-testid="showroom-tours-editor">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Showroom Tours</h2>
          <p className="text-sm text-gray-500">Multi-video playlist — visitors browse tours of each showroom location</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowPreview(!showPreview)} size="sm" data-testid="toggle-tours-preview">
            <Eye className="w-4 h-4 mr-2" /> {showPreview ? 'Hide Preview' : 'Show Preview'}
          </Button>
          <Button onClick={save} disabled={saving} size="sm" data-testid="save-showroom-tours">
            {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
            Save Changes
          </Button>
        </div>
      </div>

      {/* Visibility Toggle */}
      <div className="flex items-center justify-between p-4 bg-white rounded-lg border" data-testid="tours-visibility">
        <div>
          <p className="font-medium">Show on Homepage</p>
          <p className="text-sm text-gray-500">Toggle the entire Showroom Tours section on the live site</p>
        </div>
        <button
          onClick={() => setVisible(!visible)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${visible ? 'bg-amber-500' : 'bg-gray-300'}`}
          data-testid="tours-toggle"
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${visible ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {/* Section Title */}
      <div className="bg-white rounded-lg border p-6 space-y-4">
        <h3 className="font-semibold text-gray-900">Section Header</h3>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Explore Our Showrooms" data-testid="tours-title-input" />
          </div>
          <div className="space-y-2">
            <Label>Subtitle</Label>
            <Input value={subtitle} onChange={(e) => setSubtitle(e.target.value)} placeholder="Take a virtual tour of each location" data-testid="tours-subtitle-input" />
          </div>
        </div>
      </div>

      {/* Video List */}
      <div className="bg-white rounded-lg border p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">Tour Videos ({videos.length})</h3>
          <Button variant="outline" size="sm" onClick={addVideo} data-testid="add-tour-video">
            <Plus className="w-4 h-4 mr-1" /> Add Video
          </Button>
        </div>

        {videos.length === 0 && (
          <div className="text-center py-8 text-gray-400">
            <Film className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No tour videos yet. Add your first showroom tour video.</p>
          </div>
        )}

        <div className="space-y-4">
          {videos.map((video, i) => (
            <div key={video.id || i} className={`border rounded-lg p-4 space-y-3 ${!video.enabled ? 'opacity-60 bg-gray-50' : 'bg-white'}`} data-testid={`tour-video-${i}`}>
              {/* Video header row */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex flex-col gap-0.5">
                    <button onClick={() => moveVideo(i, -1)} disabled={i === 0} className="text-gray-400 hover:text-gray-600 disabled:opacity-30" title="Move up">
                      <ChevronRight className="w-4 h-4 -rotate-90" />
                    </button>
                    <button onClick={() => moveVideo(i, 1)} disabled={i === videos.length - 1} className="text-gray-400 hover:text-gray-600 disabled:opacity-30" title="Move down">
                      <ChevronRight className="w-4 h-4 rotate-90" />
                    </button>
                  </div>
                  <span className="text-sm font-medium text-gray-500">#{i + 1}</span>
                  <span className="font-medium text-gray-900">{video.title || 'Untitled Tour'}</span>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => updateVideo(i, 'enabled', !video.enabled)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${video.enabled ? 'bg-green-500' : 'bg-gray-300'}`}
                    title={video.enabled ? 'Enabled' : 'Disabled'}
                    data-testid={`tour-video-toggle-${i}`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${video.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                  </button>
                  <button onClick={() => removeVideo(i)} className="text-red-400 hover:text-red-600" data-testid={`tour-video-remove-${i}`}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Title + Description */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Title</Label>
                  <Input value={video.title} onChange={(e) => updateVideo(i, 'title', e.target.value)} placeholder="e.g. Tonbridge Showroom" className="h-9 text-sm" data-testid={`tour-video-title-${i}`} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Description</Label>
                  <Input value={video.description} onChange={(e) => updateVideo(i, 'description', e.target.value)} placeholder="Short description..." className="h-9 text-sm" data-testid={`tour-video-desc-${i}`} />
                </div>
              </div>

              {/* Video + Thumbnail uploads */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Video (MP4/WebM/MOV, max 200MB)</Label>
                  <input
                    ref={el => { if (el) fileInputRefs.current[i] = el; }}
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime"
                    className="hidden"
                    onChange={(e) => handleVideoUpload(i, e)}
                  />
                  {video.video_url ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-green-600 truncate flex-1">Video uploaded</span>
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => fileInputRefs.current[i]?.click()}>
                        Replace
                      </Button>
                    </div>
                  ) : video._uploading ? (
                    <div className="flex items-center gap-2 text-xs text-amber-600">
                      <Loader2 className="w-3 h-3 animate-spin" /> Uploading...
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => fileInputRefs.current[i]?.click()}>
                        <Upload className="w-3 h-3 mr-1" /> Upload
                      </Button>
                      <Input
                        value={video.video_url}
                        onChange={(e) => updateVideo(i, 'video_url', e.target.value)}
                        placeholder="Or paste URL..."
                        className="h-7 text-xs flex-1"
                      />
                    </div>
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Thumbnail Image</Label>
                  <input
                    ref={el => { if (el) thumbInputRefs.current[i] = el; }}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => handleThumbUpload(i, e)}
                  />
                  {video.thumbnail_url ? (
                    <div className="flex items-center gap-2">
                      <img src={normaliseImageUrl(video.thumbnail_url)} alt="" className="w-16 h-10 object-cover rounded" />
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => thumbInputRefs.current[i]?.click()}>
                        Replace
                      </Button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => thumbInputRefs.current[i]?.click()}>
                        <Upload className="w-3 h-3 mr-1" /> Upload
                      </Button>
                      <Input
                        value={video.thumbnail_url || ''}
                        onChange={(e) => updateVideo(i, 'thumbnail_url', e.target.value)}
                        placeholder="Or paste URL..."
                        className="h-7 text-xs flex-1"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Live Preview */}
      {showPreview && (
        <div className="bg-white rounded-lg border overflow-hidden" data-testid="tours-preview">
          <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
            <h3 className="font-semibold text-gray-900">Live Preview</h3>
            <span className="text-xs text-gray-400">Shows how it will appear on the homepage</span>
          </div>
          <div className="bg-slate-50">
            {!visible ? (
              <div className="py-12 text-center text-gray-400">
                <EyeOff className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">Section is hidden — toggle "Show on Homepage" to preview</p>
              </div>
            ) : enabledVideos.length === 0 ? (
              <div className="py-12 text-center text-gray-400">
                <Film className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">Add and enable at least one tour video to see the preview</p>
              </div>
            ) : (
              <div className="bg-slate-900 text-white py-10 px-6">
                <div className="text-center mb-6">
                  <h2 className="text-2xl font-black tracking-tight">{title || 'Explore Our Showrooms'}</h2>
                  <p className="text-slate-400 text-sm mt-1">{subtitle || 'Take a virtual tour of each location'}</p>
                </div>
                <div className="max-w-2xl mx-auto">
                  <div className="aspect-video rounded-xl overflow-hidden bg-slate-800 relative mb-4">
                    {previewVideo?.thumbnail_url ? (
                      <img src={normaliseImageUrl(previewVideo.thumbnail_url)} alt={previewVideo.title} className="w-full h-full object-cover" />
                    ) : previewVideo?.video_url ? (
                      <video src={previewVideo.video_url} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-slate-600">
                        <Film className="w-12 h-12" />
                      </div>
                    )}
                    <div className="absolute inset-0 bg-slate-900/20 flex items-center justify-center">
                      <div className="w-14 h-14 bg-white/90 rounded-full flex items-center justify-center">
                        <Play className="w-6 h-6 text-slate-900 ml-0.5" />
                      </div>
                    </div>
                  </div>
                  {previewVideo && (
                    <div className="text-center mb-4">
                      <h3 className="text-lg font-bold">{previewVideo.title || 'Untitled Tour'}</h3>
                      {previewVideo.description && <p className="text-slate-400 text-sm">{previewVideo.description}</p>}
                    </div>
                  )}
                  {enabledVideos.length > 1 && (
                    <div className="flex justify-center gap-3">
                      {enabledVideos.map((v, idx) => (
                        <button
                          key={v.id || idx}
                          onClick={() => setActivePreviewIdx(idx)}
                          className={`flex-shrink-0 w-24 rounded-lg overflow-hidden border-2 transition-all ${idx === activePreviewIdx ? 'border-[#F7EA1C] scale-105' : 'border-transparent opacity-60 hover:opacity-100'}`}
                        >
                          <div className="aspect-video bg-slate-700">
                            {v.thumbnail_url ? (
                              <img src={normaliseImageUrl(v.thumbnail_url)} alt={v.title} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <Film className="w-4 h-4 text-slate-500" />
                              </div>
                            )}
                          </div>
                          <p className="text-[10px] text-center py-1 truncate px-1">{v.title || 'Untitled'}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}



function VideoShowroomEditor() {
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [uploadProgress, setUploadProgress] = React.useState(0);
  const [visible, setVisible] = React.useState(true);
  const [badge, setBadge] = React.useState('Virtual Tour');
  const [title, setTitle] = React.useState('Experience Our Showrooms');
  const [description, setDescription] = React.useState("Can't visit in person? Take a virtual tour of our stunning showrooms. See thousands of tiles displayed in realistic room settings and get inspired for your next project.");
  const [videoUrl, setVideoUrl] = React.useState('');
  const [videoPath, setVideoPath] = React.useState('');
  const [videoFilename, setVideoFilename] = React.useState('');
  const [thumbnailUrl, setThumbnailUrl] = React.useState('');
  const [ctaPrimaryText, setCtaPrimaryText] = React.useState('Watch Tour');
  const [ctaPrimaryLink, setCtaPrimaryLink] = React.useState('');
  const [ctaSecondaryText, setCtaSecondaryText] = React.useState('Find a Showroom');
  const [ctaSecondaryLink, setCtaSecondaryLink] = React.useState('/shop/contact');
  const [stats, setStats] = React.useState([
    { value: '4', label: 'UK Showrooms' },
    { value: '10k+', label: 'Products' },
    { value: '25+', label: 'Years Experience' },
  ]);
  const [floatingTitle, setFloatingTitle] = React.useState('Free Design Consultation');
  const [floatingSubtitle, setFloatingSubtitle] = React.useState('Book your appointment today');

  const videoInputRef = React.useRef(null);
  const thumbInputRef = React.useRef(null);

  React.useEffect(() => {
    const fetchSettings = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch(`${API_URL_ADMIN}/api/website-admin/homepage`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const data = await res.json();
        if (data) {
          if (data.video_showroom_visible !== undefined) setVisible(data.video_showroom_visible);
          if (data.video_showroom_badge !== undefined) setBadge(data.video_showroom_badge);
          if (data.video_showroom_title !== undefined) setTitle(data.video_showroom_title);
          if (data.video_showroom_description !== undefined) setDescription(data.video_showroom_description);
          if (data.video_showroom_video_url !== undefined) setVideoUrl(data.video_showroom_video_url);
          if (data.video_showroom_video_path !== undefined) setVideoPath(data.video_showroom_video_path);
          if (data.video_showroom_thumbnail_url !== undefined) setThumbnailUrl(data.video_showroom_thumbnail_url);
          if (data.video_showroom_cta_primary_text !== undefined) setCtaPrimaryText(data.video_showroom_cta_primary_text);
          if (data.video_showroom_cta_primary_link !== undefined) setCtaPrimaryLink(data.video_showroom_cta_primary_link);
          if (data.video_showroom_cta_secondary_text !== undefined) setCtaSecondaryText(data.video_showroom_cta_secondary_text);
          if (data.video_showroom_cta_secondary_link !== undefined) setCtaSecondaryLink(data.video_showroom_cta_secondary_link);
          if (data.video_showroom_stats !== undefined) setStats(data.video_showroom_stats);
          if (data.video_showroom_floating_badge_title !== undefined) setFloatingTitle(data.video_showroom_floating_badge_title);
          if (data.video_showroom_floating_badge_subtitle !== undefined) setFloatingSubtitle(data.video_showroom_floating_badge_subtitle);
        }
      } catch (e) {
        console.error('Failed to load video showroom settings', e);
      } finally {
        setLoading(false);
      }
    };
    fetchSettings();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL_ADMIN}/api/website-admin/homepage`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_showroom_visible: visible,
          video_showroom_badge: badge,
          video_showroom_title: title,
          video_showroom_description: description,
          video_showroom_video_url: videoUrl,
          video_showroom_video_path: videoPath,
          video_showroom_thumbnail_url: thumbnailUrl,
          video_showroom_cta_primary_text: ctaPrimaryText,
          video_showroom_cta_primary_link: ctaPrimaryLink,
          video_showroom_cta_secondary_text: ctaSecondaryText,
          video_showroom_cta_secondary_link: ctaSecondaryLink,
          video_showroom_stats: stats,
          video_showroom_floating_badge_title: floatingTitle,
          video_showroom_floating_badge_subtitle: floatingSubtitle,
        }),
      });
      if (res.ok) {
        toast.success('Video showroom settings saved');
      } else {
        toast.error('Failed to save settings');
      }
    } catch (e) {
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleVideoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const maxSize = 200 * 1024 * 1024;
    if (file.size > maxSize) {
      toast.error(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 200MB.`);
      return;
    }

    const validTypes = ['video/mp4', 'video/webm', 'video/quicktime'];
    if (!validTypes.includes(file.type)) {
      toast.error('Invalid file type. Allowed: MP4, WebM, MOV');
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const token = localStorage.getItem('token');
      const xhr = new XMLHttpRequest();

      const uploadPromise = new Promise((resolve, reject) => {
        xhr.upload.addEventListener('progress', (event) => {
          if (event.lengthComputable) {
            setUploadProgress(Math.round((event.loaded / event.total) * 100));
          }
        });
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve(JSON.parse(xhr.responseText));
          } else {
            reject(new Error(xhr.responseText || 'Upload failed'));
          }
        });
        xhr.addEventListener('error', () => reject(new Error('Upload failed')));
        xhr.open('POST', `${API_URL_ADMIN}/api/website-admin/homepage/upload-video`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.send(formData);
      });

      const result = await uploadPromise;
      const servePath = result.storage_path.replace('tile-station/homepage/', '');
      const mediaUrl = `${API_URL_ADMIN}/api/website-admin/homepage/media/${servePath}`;
      setVideoUrl(mediaUrl);
      setVideoPath(result.storage_path);
      setVideoFilename(result.original_filename);

      // Auto-extract thumbnail from the uploaded video
      try {
        const videoEl = document.createElement('video');
        videoEl.crossOrigin = 'anonymous';
        videoEl.src = mediaUrl;
        videoEl.muted = true;
        await new Promise((res, rej) => {
          videoEl.onloadeddata = res;
          videoEl.onerror = rej;
          setTimeout(rej, 10000);
        });
        videoEl.currentTime = 1; // seek to 1 second
        await new Promise((res) => { videoEl.onseeked = res; });
        const canvas = document.createElement('canvas');
        canvas.width = videoEl.videoWidth;
        canvas.height = videoEl.videoHeight;
        canvas.getContext('2d').drawImage(videoEl, 0, 0);
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
        if (blob) {
          const thumbForm = new FormData();
          thumbForm.append('file', new File([blob], 'video-thumbnail.jpg', { type: 'image/jpeg' }));
          const thumbRes = await fetch(`${API_URL_ADMIN}/api/website-admin/homepage/upload-thumbnail`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: thumbForm,
          });
          if (thumbRes.ok) {
            const thumbResult = await thumbRes.json();
            const thumbPath = thumbResult.storage_path.replace('tile-station/homepage/', '');
            setThumbnailUrl(`${API_URL_ADMIN}/api/website-admin/homepage/media/${thumbPath}`);
            toast.success('Thumbnail auto-extracted from video');
          }
        }
        videoEl.remove();
      } catch (thumbErr) {
        console.log('Auto-thumbnail extraction skipped:', thumbErr);
      }

      toast.success(`Video uploaded: ${result.original_filename} (${(result.size / 1024 / 1024).toFixed(1)}MB)`);
    } catch (err) {
      console.error('Video upload error:', err);
      toast.error('Video upload failed. Please try again.');
    } finally {
      setUploading(false);
      setUploadProgress(0);
      if (videoInputRef.current) videoInputRef.current.value = '';
    }
  };

  const handleThumbnailUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image too large. Maximum is 10MB.');
      return;
    }

    try {
      const formData = new FormData();
      formData.append('file', file);

      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL_ADMIN}/api/website-admin/homepage/upload-thumbnail`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) throw new Error('Upload failed');
      const result = await res.json();
      const servePath = result.storage_path.replace('tile-station/homepage/', '');
      setThumbnailUrl(`${API_URL_ADMIN}/api/website-admin/homepage/media/${servePath}`);
      toast.success('Thumbnail uploaded');
    } catch (err) {
      toast.error('Thumbnail upload failed');
    } finally {
      if (thumbInputRef.current) thumbInputRef.current.value = '';
    }
  };

  const updateStat = (index, field, value) => {
    setStats(prev => prev.map((s, i) => i === index ? { ...s, [field]: value } : s));
  };

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  return (
    <div className="space-y-6" data-testid="video-showroom-editor">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Video Showroom Section</h2>
          <p className="text-sm text-gray-500">Manage the "Experience Our Showrooms" section with video tour</p>
        </div>
        <Button onClick={save} disabled={saving} size="sm" data-testid="save-video-showroom">
          {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
          Save Changes
        </Button>
      </div>

      {/* Visibility Toggle */}
      <div className="flex items-center justify-between p-4 bg-white rounded-lg border" data-testid="video-showroom-visibility">
        <div>
          <p className="font-medium">Show on Homepage</p>
          <p className="text-sm text-gray-500">Toggle visibility of the entire video showroom section</p>
        </div>
        <button
          onClick={() => setVisible(!visible)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${visible ? 'bg-amber-500' : 'bg-gray-300'}`}
          data-testid="video-showroom-toggle"
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${visible ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {/* Video Upload */}
      <div className="bg-white rounded-lg border p-6 space-y-4" data-testid="video-upload-section">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <Video className="w-4 h-4" /> Video File
        </h3>
        <p className="text-sm text-gray-500">Upload a video for the showroom tour. Max file size: 200MB. Accepted: MP4, WebM, MOV.</p>

        {videoUrl && (
          <div className="relative rounded-lg overflow-hidden bg-gray-900 aspect-video max-w-md">
            <video src={videoUrl} className="w-full h-full object-cover" controls />
          </div>
        )}

        <input
          ref={videoInputRef}
          type="file"
          accept="video/mp4,video/webm,video/quicktime"
          className="hidden"
          onChange={handleVideoUpload}
          data-testid="video-file-input"
        />

        {uploading ? (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin text-amber-500" />
              <span className="text-sm font-medium">Uploading... {uploadProgress}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2.5">
              <div className="bg-amber-500 h-2.5 rounded-full transition-all" style={{ width: `${uploadProgress}%` }} />
            </div>
          </div>
        ) : (
          <div className="flex gap-3">
            <Button variant="outline" onClick={() => videoInputRef.current?.click()} data-testid="upload-video-btn">
              <Upload className="w-4 h-4 mr-2" /> {videoUrl ? 'Replace Video' : 'Upload Video'}
            </Button>
            {videoFilename && <span className="text-sm text-gray-500 self-center">{videoFilename}</span>}
          </div>
        )}

        <div className="space-y-2">
          <Label>Or paste a video URL (YouTube/Vimeo embed)</Label>
          <Input
            value={videoUrl}
            onChange={(e) => setVideoUrl(e.target.value)}
            placeholder="https://..."
            data-testid="video-url-input"
          />
        </div>
      </div>

      {/* Thumbnail Upload */}
      <div className="bg-white rounded-lg border p-6 space-y-4" data-testid="thumbnail-section">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <ImageIcon className="w-4 h-4" /> Video Thumbnail
        </h3>
        <p className="text-sm text-gray-500">Image shown before the video plays. Max 10MB.</p>

        {thumbnailUrl && (
          <div className="relative rounded-lg overflow-hidden max-w-md aspect-video">
            <img src={normaliseImageUrl(thumbnailUrl)} alt="Thumbnail" className="w-full h-full object-cover" />
          </div>
        )}

        <input
          ref={thumbInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleThumbnailUpload}
          data-testid="thumbnail-file-input"
        />

        <div className="flex gap-3">
          <Button variant="outline" onClick={() => thumbInputRef.current?.click()} data-testid="upload-thumbnail-btn">
            <Upload className="w-4 h-4 mr-2" /> {thumbnailUrl ? 'Replace Thumbnail' : 'Upload Thumbnail'}
          </Button>
        </div>

        <div className="space-y-2">
          <Label>Or paste image URL</Label>
          <Input
            value={thumbnailUrl}
            onChange={(e) => setThumbnailUrl(e.target.value)}
            placeholder="https://..."
            data-testid="thumbnail-url-input"
          />
        </div>
      </div>

      {/* Text Content */}
      <div className="bg-white rounded-lg border p-6 space-y-4" data-testid="text-content-section">
        <h3 className="font-semibold text-gray-900">Text Content</h3>
        
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Badge Text</Label>
              {badge && <button onClick={() => setBadge('')} className="text-xs text-red-500 hover:text-red-700" data-testid="clear-badge">Clear</button>}
            </div>
            <Input value={badge} onChange={(e) => setBadge(e.target.value)} placeholder="Virtual Tour (leave empty to hide)" data-testid="badge-input" />
          </div>
          <div className="space-y-2">
            <Label>Section Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Experience Our Showrooms" data-testid="title-input" />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Description</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Can't visit in person? Take a virtual tour..."
            data-testid="description-input"
          />
        </div>
      </div>

      {/* CTA Buttons */}
      <div className="bg-white rounded-lg border p-6 space-y-4" data-testid="cta-section">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-900">Call-to-Action Buttons</h3>
          {(ctaPrimaryText || ctaSecondaryText) && (
            <button onClick={() => { setCtaPrimaryText(''); setCtaPrimaryLink(''); setCtaSecondaryText(''); setCtaSecondaryLink(''); }} className="text-xs text-red-500 hover:text-red-700" data-testid="clear-ctas">Clear All CTAs</button>
          )}
        </div>
        
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Primary Button Text</Label>
              {ctaPrimaryText && <button onClick={() => { setCtaPrimaryText(''); setCtaPrimaryLink(''); }} className="text-xs text-red-500 hover:text-red-700">Clear</button>}
            </div>
            <Input value={ctaPrimaryText} onChange={(e) => setCtaPrimaryText(e.target.value)} placeholder="Watch Tour (leave empty to hide)" data-testid="cta-primary-text" />
          </div>
          <div className="space-y-2">
            <Label>Primary Button Link (optional)</Label>
            <Input value={ctaPrimaryLink} onChange={(e) => setCtaPrimaryLink(e.target.value)} placeholder="Leave blank to play video" data-testid="cta-primary-link" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Secondary Button Text</Label>
              {ctaSecondaryText && <button onClick={() => { setCtaSecondaryText(''); setCtaSecondaryLink(''); }} className="text-xs text-red-500 hover:text-red-700">Clear</button>}
            </div>
            <Input value={ctaSecondaryText} onChange={(e) => setCtaSecondaryText(e.target.value)} placeholder="Find a Showroom (leave empty to hide)" data-testid="cta-secondary-text" />
          </div>
          <div className="space-y-2">
            <Label>Secondary Button Link</Label>
            <Input value={ctaSecondaryLink} onChange={(e) => setCtaSecondaryLink(e.target.value)} placeholder="/shop/contact" data-testid="cta-secondary-link" />
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="bg-white rounded-lg border p-6 space-y-4" data-testid="stats-section">
        <h3 className="font-semibold text-gray-900">Statistics</h3>
        <p className="text-sm text-gray-500">Displayed below the description as key business metrics</p>

        <div className="space-y-3">
          {stats.map((stat, i) => (
            <div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-3 items-center">
              <Input
                value={stat.value}
                onChange={(e) => updateStat(i, 'value', e.target.value)}
                placeholder="10k+"
                data-testid={`stat-value-${i}`}
              />
              <Input
                value={stat.label}
                onChange={(e) => updateStat(i, 'label', e.target.value)}
                placeholder="Products"
                data-testid={`stat-label-${i}`}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStats(prev => prev.filter((_, idx) => idx !== i))}
                data-testid={`stat-remove-${i}`}
              >
                <X className="w-4 h-4 text-red-500" />
              </Button>
            </div>
          ))}
          {stats.length < 5 && (
            <Button variant="outline" size="sm" onClick={() => setStats(prev => [...prev, { value: '', label: '' }])} data-testid="add-stat-btn">
              <Plus className="w-4 h-4 mr-1" /> Add Stat
            </Button>
          )}
        </div>
      </div>

      {/* Floating Badge */}
      <div className="bg-white rounded-lg border p-6 space-y-4" data-testid="floating-badge-section">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-gray-900">Floating Badge</h3>
            <p className="text-sm text-gray-500">Small callout badge overlapping the video thumbnail</p>
          </div>
          {(floatingTitle || floatingSubtitle) && (
            <button onClick={() => { setFloatingTitle(''); setFloatingSubtitle(''); }} className="text-xs text-red-500 hover:text-red-700" data-testid="clear-floating-badge">Clear</button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>Badge Title</Label>
            <Input value={floatingTitle} onChange={(e) => setFloatingTitle(e.target.value)} placeholder="Free Design Consultation (leave empty to hide)" data-testid="floating-title-input" />
          </div>
          <div className="space-y-2">
            <Label>Badge Subtitle</Label>
            <Input value={floatingSubtitle} onChange={(e) => setFloatingSubtitle(e.target.value)} placeholder="Book your appointment today" data-testid="floating-subtitle-input" />
          </div>
        </div>
      </div>
    </div>
  );
}


function BrandMarqueeEditor() {
  const [visible, setVisible] = React.useState(true);
  const [title, setTitle] = React.useState('Trusted by Leading Brands');
  const [brands, setBrands] = React.useState([]);
  const [newBrand, setNewBrand] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    const fetchSettings = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch(`${API_URL_ADMIN}/api/website-admin/homepage`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        const data = await res.json();
        if (data) {
          setVisible(data.brand_marquee_visible !== false);
          setTitle(data.brand_marquee_title || 'Trusted by Leading Brands');
          setBrands(data.brand_marquee_brands || [
            { name: 'PORCELANOSA' }, { name: 'RAK CERAMICS' },
            { name: 'VILLEROY & BOCH' }, { name: 'ROCA' },
            { name: 'GROHE' }, { name: 'IDEAL STANDARD' },
            { name: 'BRITISH CERAMIC TILE' }, { name: 'JOHNSON TILES' },
          ]);
        }
      } catch (e) {
        console.error('Failed to load brand marquee settings', e);
      } finally {
        setLoading(false);
      }
    };
    fetchSettings();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const token = localStorage.getItem('token');
      await fetch(`${API_URL_ADMIN}/api/website-admin/homepage`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          brand_marquee_visible: visible,
          brand_marquee_title: title,
          brand_marquee_brands: brands,
        }),
      });
      toast.success('Brand marquee settings saved');
    } catch (e) {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const addBrand = () => {
    if (newBrand.trim()) {
      setBrands([...brands, { name: newBrand.trim(), displayName: newBrand.trim().toUpperCase() }]);
      setNewBrand('');
    }
  };

  const removeBrand = (index) => {
    setBrands(brands.filter((_, i) => i !== index));
  };

  if (loading) return <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>;

  return (
    <div className="space-y-6" data-testid="brand-marquee-editor">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Brand Marquee</h3>
          <p className="text-sm text-gray-500">The scrolling brand bar on the homepage</p>
        </div>
        <Button onClick={save} disabled={saving} size="sm" data-testid="save-brand-marquee">
          {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Save className="w-4 h-4 mr-1" />}
          Save
        </Button>
      </div>

      {/* Visibility Toggle */}
      <div className="flex items-center justify-between p-4 bg-white rounded-lg border" data-testid="brand-marquee-visibility">
        <div>
          <p className="font-medium text-gray-900">Show on Homepage</p>
          <p className="text-sm text-gray-500">Toggle the scrolling brand bar visibility</p>
        </div>
        <button
          onClick={() => setVisible(!visible)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${visible ? 'bg-green-500' : 'bg-gray-300'}`}
          data-testid="brand-marquee-toggle"
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${visible ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      {/* Title */}
      <div className="p-4 bg-white rounded-lg border space-y-3">
        <label className="block text-sm font-medium text-gray-700">Section Title</label>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Trusted by Leading Brands"
          data-testid="brand-marquee-title-input"
        />
      </div>

      {/* Brand List */}
      <div className="p-4 bg-white rounded-lg border space-y-3">
        <label className="block text-sm font-medium text-gray-700">Brands ({brands.length})</label>
        <div className="flex flex-wrap gap-2">
          {brands.map((brand, i) => (
            <span key={i} className="inline-flex items-center gap-1 bg-gray-100 text-gray-700 text-sm px-3 py-1.5 rounded-full">
              {brand.displayName || brand.name}
              <button onClick={() => removeBrand(i)} className="text-gray-400 hover:text-red-500 ml-1">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            value={newBrand}
            onChange={(e) => setNewBrand(e.target.value)}
            placeholder="Add a brand name..."
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addBrand())}
            data-testid="add-brand-input"
          />
          <Button variant="outline" onClick={addBrand} disabled={!newBrand.trim()} data-testid="add-brand-btn">
            <Plus className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
