import React, { useState, useEffect } from 'react';
import { 
  Save, 
  Plus, 
  Trash2, 
  GripVertical, 
  Image as ImageIcon,
  Eye,
  EyeOff,
  ChevronUp,
  ChevronDown,
  Filter,
  Home,
  AlertCircle,
  Layers
} from 'lucide-react';
import { toast } from 'sonner';
import { normaliseImageUrl } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// All product groups
const PRODUCT_GROUPS = [
  { id: 'tiles', label: 'Tiles', color: '#F59E0B' },
  { id: 'flooring', label: 'Flooring', color: '#8B5CF6' },
  { id: 'materials', label: 'Materials', color: '#059669' },
  { id: 'tools-accessories', label: 'Tools & Accessories', color: '#DC2626' },
  { id: 'underfloor-heating', label: 'Underfloor Heating', color: '#2563EB' },
];

// Default hero slides per group
const DEFAULT_GROUP_HEROES = {
  tiles: [
    { id: 'bathroom', title: 'Bathroom Tiles', subtitle: 'Create your dream sanctuary', image: 'https://images.unsplash.com/photo-1765766600820-58eaf8687f1d?w=1600&q=80', link: '/tiles?category=bathroom-tiles', enabled: true },
    { id: 'kitchen', title: 'Kitchen Tiles', subtitle: 'Where style meets function', image: 'https://images.unsplash.com/photo-1758548157126-e4c0477f796e?w=1600&q=80', link: '/tiles?category=kitchen-tiles', enabled: true },
    { id: 'living', title: 'Living Spaces', subtitle: 'Elegance for every room', image: 'https://images.unsplash.com/photo-1696861080288-0cc2f1cd48d5?w=1600&q=80', link: '/tiles?category=floor-tiles', enabled: true },
    { id: 'outdoor', title: 'Outdoor Tiles', subtitle: 'Extend your living space', image: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1600&q=80', link: '/tiles?category=outdoor-tiles', enabled: true },
  ],
  flooring: [
    { id: 'vinyl', title: 'Vinyl Flooring', subtitle: 'Durable luxury for every room', image: 'https://images.pexels.com/photos/7587865/pexels-photo-7587865.jpeg?auto=compress&cs=tinysrgb&w=1600', link: '/tiles?group=flooring&category=vinyl', enabled: true },
    { id: 'laminate', title: 'Laminate Flooring', subtitle: 'Stunning styles, unbeatable value', image: 'https://images.unsplash.com/photo-1769736436809-eab3de70b175?w=1600&q=80', link: '/tiles?group=flooring&category=laminate', enabled: true },
    { id: 'engineered', title: 'Engineered Wood', subtitle: 'Natural beauty that lasts', image: 'https://images.pexels.com/photos/6438755/pexels-photo-6438755.jpeg?auto=compress&cs=tinysrgb&w=1600', link: '/tiles?group=flooring&category=engineered-wood', enabled: true },
  ],
  materials: [
    { id: 'adhesives', title: 'Adhesives & Grout', subtitle: 'Professional-grade bonding solutions', image: 'https://images.pexels.com/photos/6474342/pexels-photo-6474342.jpeg?auto=compress&cs=tinysrgb&w=1600', link: '/tiles?group=materials&category=adhesives', enabled: true },
    { id: 'levelling', title: 'Levelling Compounds', subtitle: 'The perfect foundation for any floor', image: 'https://images.pexels.com/photos/6473974/pexels-photo-6473974.jpeg?auto=compress&cs=tinysrgb&w=1600', link: '/tiles?group=materials&category=levelling', enabled: true },
    { id: 'waterproofing', title: 'Waterproofing', subtitle: 'Protect every surface with confidence', image: 'https://images.pexels.com/photos/3616755/pexels-photo-3616755.jpeg?auto=compress&cs=tinysrgb&w=1600', link: '/tiles?group=materials&category=waterproofing', enabled: true },
  ],
  tools: [
    { id: 'cutting', title: 'Cutting Tools', subtitle: 'Precision cuts, every time', image: 'https://images.unsplash.com/photo-1560846389-956694677531?w=1600&q=80', link: '/tiles?group=tools-accessories&category=cutting-tools', enabled: true },
    { id: 'trowels', title: 'Trowels & Spreaders', subtitle: 'Essential tools for every tiler', image: 'https://images.unsplash.com/photo-1636200534256-c08268363482?w=1600&q=80', link: '/tiles?group=tools-accessories&category=trowels', enabled: true },
    { id: 'levelling-tools', title: 'Levelling Systems', subtitle: 'Achieve a flawless, flat finish', image: 'https://images.unsplash.com/photo-1628002580365-f3c0a322d577?w=1600&q=80', link: '/tiles?group=tools-accessories&category=levelling-systems', enabled: true },
  ],
  accessories: [
    { id: 'trims', title: 'Trims & Profiles', subtitle: 'The perfect finishing touch', image: 'https://images.unsplash.com/photo-1765876192094-984b1929304c?w=1600&q=80', link: '/tiles?group=tools-accessories&category=trims', enabled: true },
    { id: 'spacers', title: 'Spacers & Wedges', subtitle: 'Consistent gaps, professional results', image: 'https://images.unsplash.com/photo-1705258814435-65ed6ce0e99a?w=1600&q=80', link: '/tiles?group=tools-accessories&category=spacers', enabled: true },
    { id: 'membranes', title: 'Membranes & Matting', subtitle: 'Protect, decouple, insulate', image: 'https://images.pexels.com/photos/7173661/pexels-photo-7173661.jpeg?auto=compress&cs=tinysrgb&w=1600', link: '/tiles?group=tools-accessories&category=membranes', enabled: true },
  ],
  // Unified group used by the storefront — merges the legacy `tools` and
  // `accessories` defaults so admins see ONE tab instead of two.
  'tools-accessories': [
    { id: 'cutting', title: 'Cutting Tools', subtitle: 'Precision cuts, every time', image: 'https://images.unsplash.com/photo-1560846389-956694677531?w=1600&q=80', link: '/tiles?group=tools-accessories&category=cutting-tools', enabled: true },
    { id: 'trowels', title: 'Trowels & Spreaders', subtitle: 'Essential tools for every tiler', image: 'https://images.unsplash.com/photo-1636200534256-c08268363482?w=1600&q=80', link: '/tiles?group=tools-accessories&category=trowels', enabled: true },
    { id: 'levelling-tools', title: 'Levelling Systems', subtitle: 'Achieve a flawless, flat finish', image: 'https://images.unsplash.com/photo-1628002580365-f3c0a322d577?w=1600&q=80', link: '/tiles?group=tools-accessories&category=levelling-systems', enabled: true },
    { id: 'trims', title: 'Trims & Profiles', subtitle: 'The perfect finishing touch', image: 'https://images.unsplash.com/photo-1765876192094-984b1929304c?w=1600&q=80', link: '/tiles?group=tools-accessories&category=trims', enabled: true },
    { id: 'spacers', title: 'Spacers & Wedges', subtitle: 'Consistent gaps, professional results', image: 'https://images.unsplash.com/photo-1705258814435-65ed6ce0e99a?w=1600&q=80', link: '/tiles?group=tools-accessories&category=spacers', enabled: true },
    { id: 'membranes', title: 'Membranes & Matting', subtitle: 'Protect, decouple, insulate', image: 'https://images.pexels.com/photos/7173661/pexels-photo-7173661.jpeg?auto=compress&cs=tinysrgb&w=1600', link: '/tiles?group=tools-accessories&category=membranes', enabled: true },
  ],
  'underfloor-heating': [
    { id: 'electric', title: 'Electric Heating Mats', subtitle: 'Warmth beneath every step', image: 'https://images.unsplash.com/photo-1695651832926-66591245a88c?w=1600&q=80', link: '/tiles?group=underfloor-heating&category=electric', enabled: true },
    { id: 'water-systems', title: 'Water Heating Systems', subtitle: 'Efficient whole-home comfort', image: 'https://images.unsplash.com/photo-1562863658-51483065f301?w=1600&q=80', link: '/tiles?group=underfloor-heating&category=water-systems', enabled: true },
    { id: 'thermostats', title: 'Smart Thermostats', subtitle: 'Total control at your fingertips', image: 'https://images.pexels.com/photos/7587734/pexels-photo-7587734.jpeg?auto=compress&cs=tinysrgb&w=1600', link: '/tiles?group=underfloor-heating&category=thermostats', enabled: true },
  ],
};

// Default room links per group
const DEFAULT_GROUP_ROOMS = {
  tiles: [
    { id: 'bathroom', label: 'Bathroom', icon: '🛁', link: '/tiles?category=bathroom-tiles', enabled: true },
    { id: 'kitchen', label: 'Kitchen', icon: '🍳', link: '/tiles?category=kitchen-tiles', enabled: true },
    { id: 'living', label: 'Living Room', icon: '🛋️', link: '/tiles?category=floor-tiles', enabled: true },
    { id: 'outdoor', label: 'Outdoor', icon: '🌿', link: '/tiles?category=outdoor-tiles', enabled: true },
    { id: 'hallway', label: 'Hallway', icon: '🚪', link: '/tiles?category=floor-tiles', enabled: true },
  ],
  flooring: [
    { id: 'vinyl', label: 'Vinyl', icon: '🏠', link: '/tiles?group=flooring&category=vinyl', enabled: true },
    { id: 'laminate', label: 'Laminate', icon: '🪵', link: '/tiles?group=flooring&category=laminate', enabled: true },
    { id: 'lvt', label: 'LVT', icon: '✨', link: '/tiles?group=flooring&category=lvt', enabled: true },
    { id: 'engineered', label: 'Engineered Wood', icon: '🌳', link: '/tiles?group=flooring&category=engineered-wood', enabled: true },
  ],
  materials: [
    { id: 'adhesives', label: 'Adhesives', icon: '🧱', link: '/tiles?group=materials&category=adhesives', enabled: true },
    { id: 'grout', label: 'Grout & Silicone', icon: '🪣', link: '/tiles?group=materials&category=grout', enabled: true },
    { id: 'levelling', label: 'Self Levelling', icon: '📐', link: '/tiles?group=materials&category=levelling', enabled: true },
    { id: 'waterproofing', label: 'Waterproofing', icon: '💧', link: '/tiles?group=materials&category=waterproofing', enabled: true },
    { id: 'cleaning', label: 'Cleaning', icon: '🧹', link: '/tiles?group=materials&category=cleaning', enabled: true },
  ],
  tools: [
    { id: 'cutting', label: 'Tile Cutters', icon: '🔪', link: '/tiles?group=tools-accessories&category=cutting-tools', enabled: true },
    { id: 'trowels', label: 'Trowels', icon: '🔧', link: '/tiles?group=tools-accessories&category=trowels', enabled: true },
    { id: 'levelling', label: 'Levelling Systems', icon: '📏', link: '/tiles?group=tools-accessories&category=levelling-systems', enabled: true },
    { id: 'mixing', label: 'Mixing Tools', icon: '⚙️', link: '/tiles?group=tools-accessories&category=mixing', enabled: true },
  ],
  accessories: [
    { id: 'trims', label: 'Trims & Profiles', icon: '📎', link: '/tiles?group=tools-accessories&category=trims', enabled: true },
    { id: 'spacers', label: 'Spacers', icon: '➕', link: '/tiles?group=tools-accessories&category=spacers', enabled: true },
    { id: 'membranes', label: 'Membranes', icon: '🛡️', link: '/tiles?group=tools-accessories&category=membranes', enabled: true },
    { id: 'sealing', label: 'Sealing Tape', icon: '🔒', link: '/tiles?group=tools-accessories&category=sealing', enabled: true },
  ],
  'tools-accessories': [
    { id: 'cutting', label: 'Tile Cutters', icon: '🔪', link: '/tiles?group=tools-accessories&category=cutting-tools', enabled: true },
    { id: 'trowels', label: 'Trowels', icon: '🔧', link: '/tiles?group=tools-accessories&category=trowels', enabled: true },
    { id: 'levelling', label: 'Levelling Systems', icon: '📏', link: '/tiles?group=tools-accessories&category=levelling-systems', enabled: true },
    { id: 'mixing', label: 'Mixing Tools', icon: '⚙️', link: '/tiles?group=tools-accessories&category=mixing', enabled: true },
    { id: 'trims', label: 'Trims & Profiles', icon: '📎', link: '/tiles?group=tools-accessories&category=trims', enabled: true },
    { id: 'spacers', label: 'Spacers', icon: '➕', link: '/tiles?group=tools-accessories&category=spacers', enabled: true },
    { id: 'membranes', label: 'Membranes', icon: '🛡️', link: '/tiles?group=tools-accessories&category=membranes', enabled: true },
    { id: 'sealing', label: 'Sealing Tape', icon: '🔒', link: '/tiles?group=tools-accessories&category=sealing', enabled: true },
  ],
  'underfloor-heating': [
    { id: 'electric', label: 'Electric Mats', icon: '⚡', link: '/tiles?group=underfloor-heating&category=electric', enabled: true },
    { id: 'water', label: 'Water Systems', icon: '🌊', link: '/tiles?group=underfloor-heating&category=water-systems', enabled: true },
    { id: 'thermostats', label: 'Thermostats', icon: '🌡️', link: '/tiles?group=underfloor-heating&category=thermostats', enabled: true },
    { id: 'insulation', label: 'Insulation Boards', icon: '🧊', link: '/tiles?group=underfloor-heating&category=insulation', enabled: true },
  ],
};

const GROUP_HERO_LABEL = {
  tiles: 'Shop by Room',
  flooring: 'Shop by Type',
  materials: 'Shop by Category',
  tools: 'Shop by Category',
  accessories: 'Shop by Category',
  'tools-accessories': 'Shop by Category',
  'underfloor-heating': 'Shop by Type',
};

const EMOJI_OPTIONS = ['🛁', '🍳', '🛋️', '🌿', '🚪', '🏠', '🛏️', '🚿', '🪴', '🎨', '✨', '🔥', '💎', '⭐', '🧱', '🪣', '📐', '💧', '🧹', '🔪', '🔧', '📏', '⚙️', '📎', '➕', '🛡️', '🔒', '⚡', '🌊', '🌡️', '🧊', '🪵', '🌳'];

const DEFAULT_POPULAR_FILTERS = [
  { id: 'large', label: 'Large Format', filter: 'size:large', enabled: true },
  { id: 'marble', label: 'Marble Effect', filter: 'style:marble', enabled: true },
  { id: 'wood', label: 'Wood Effect', filter: 'style:wood', enabled: true },
  { id: 'matt', label: 'Matt Finish', filter: 'finish:matt', enabled: true },
  { id: 'budget', label: 'Under £30/m²', filter: 'price:0-30', enabled: true },
  { id: 'stock', label: 'In Stock', filter: 'stock:true', enabled: true },
];

const CollectionsPageSettings = ({ embedded = false }) => {
  const [activeTab, setActiveTab] = useState('hero');
  const [activeGroup, setActiveGroup] = useState('tiles');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewSlide, setPreviewSlide] = useState(0);
  
  // Full settings from server
  const [fullSettings, setFullSettings] = useState({});
  
  // Current group's editable state
  const [heroSlides, setHeroSlides] = useState([]);
  const [roomLinks, setRoomLinks] = useState([]);
  const [popularFilters, setPopularFilters] = useState(DEFAULT_POPULAR_FILTERS);
  const [heroEnabled, setHeroEnabled] = useState(true);
  const [roomLinksEnabled, setRoomLinksEnabled] = useState(true);
  const [filtersEnabled, setFiltersEnabled] = useState(true);

  // Load settings from server
  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch(`${API_URL}/api/website-admin/collections-page-settings`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          if (data.settings) {
            setFullSettings(data.settings);
          }
        }
      } catch (e) {
        console.error('Error loading settings:', e);
      } finally {
        setLoading(false);
      }
    };
    fetchSettings();
  }, []);

  // When group changes or settings load, populate the editable state
  useEffect(() => {
    if (loading) return;
    
    if (activeGroup === 'tiles') {
      // Tiles uses top-level settings (backward compatible)
      setHeroSlides(fullSettings.heroSlides?.length > 0 ? fullSettings.heroSlides : DEFAULT_GROUP_HEROES.tiles);
      setRoomLinks(fullSettings.roomLinks?.length > 0 ? fullSettings.roomLinks : DEFAULT_GROUP_ROOMS.tiles);
      setHeroEnabled(fullSettings.heroEnabled !== undefined ? fullSettings.heroEnabled : true);
      setRoomLinksEnabled(fullSettings.roomLinksEnabled !== undefined ? fullSettings.roomLinksEnabled : true);
    } else {
      // Other groups use settings.groups[group]
      const groupData = fullSettings.groups?.[activeGroup] || {};
      setHeroSlides(groupData.heroSlides?.length > 0 ? groupData.heroSlides : DEFAULT_GROUP_HEROES[activeGroup] || []);
      setRoomLinks(groupData.roomLinks?.length > 0 ? groupData.roomLinks : DEFAULT_GROUP_ROOMS[activeGroup] || []);
      setHeroEnabled(groupData.heroEnabled !== undefined ? groupData.heroEnabled : true);
      setRoomLinksEnabled(groupData.roomLinksEnabled !== undefined ? groupData.roomLinksEnabled : true);
    }
    
    // Popular filters are global (not per-group)
    setPopularFilters(fullSettings.popularFilters?.length > 0 ? fullSettings.popularFilters : DEFAULT_POPULAR_FILTERS);
    setFiltersEnabled(fullSettings.filtersEnabled !== undefined ? fullSettings.filtersEnabled : true);
    
    setPreviewSlide(0);
  }, [activeGroup, fullSettings, loading]);

  // Save settings
  const handleSave = async () => {
    setSaving(true);
    try {
      // Build the settings payload
      const updatedSettings = { ...fullSettings };
      
      if (activeGroup === 'tiles') {
        updatedSettings.heroSlides = heroSlides;
        updatedSettings.roomLinks = roomLinks;
        updatedSettings.heroEnabled = heroEnabled;
        updatedSettings.roomLinksEnabled = roomLinksEnabled;
      } else {
        if (!updatedSettings.groups) updatedSettings.groups = {};
        updatedSettings.groups[activeGroup] = {
          heroSlides,
          roomLinks,
          heroEnabled,
          roomLinksEnabled,
        };
      }
      
      // Global settings
      updatedSettings.popularFilters = popularFilters;
      updatedSettings.filtersEnabled = filtersEnabled;
      
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/collections-page-settings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ settings: updatedSettings })
      });
      if (res.ok) {
        setFullSettings(updatedSettings);
        toast.success(`${PRODUCT_GROUPS.find(g => g.id === activeGroup)?.label} settings saved!`);
      } else {
        throw new Error('Failed to save');
      }
    } catch (e) {
      toast.error('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  // Hero slide handlers
  const updateHeroSlide = (index, field, value) => {
    const updated = [...heroSlides];
    updated[index] = { ...updated[index], [field]: value };
    setHeroSlides(updated);
  };

  const addHeroSlide = () => {
    setHeroSlides([...heroSlides, {
      id: `slide-${Date.now()}`,
      title: 'New Slide',
      subtitle: 'Add your subtitle here',
      image: '',
      link: activeGroup === 'tiles' ? '/tiles' : `/tiles?group=${activeGroup}`,
      enabled: true
    }]);
  };

  const removeHeroSlide = (index) => {
    if (heroSlides.length <= 1) {
      toast.error('You need at least one hero slide');
      return;
    }
    setHeroSlides(heroSlides.filter((_, i) => i !== index));
    if (previewSlide >= heroSlides.length - 1) {
      setPreviewSlide(Math.max(0, heroSlides.length - 2));
    }
  };

  const moveHeroSlide = (index, direction) => {
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= heroSlides.length) return;
    const updated = [...heroSlides];
    [updated[index], updated[newIndex]] = [updated[newIndex], updated[index]];
    setHeroSlides(updated);
  };

  // Room links handlers
  const updateRoomLink = (index, field, value) => {
    const updated = [...roomLinks];
    updated[index] = { ...updated[index], [field]: value };
    setRoomLinks(updated);
  };

  const addRoomLink = () => {
    setRoomLinks([...roomLinks, {
      id: `room-${Date.now()}`,
      label: 'New Link',
      icon: '🏠',
      link: activeGroup === 'tiles' ? '/tiles' : `/tiles?group=${activeGroup}`,
      enabled: true
    }]);
  };

  const removeRoomLink = (index) => {
    setRoomLinks(roomLinks.filter((_, i) => i !== index));
  };

  // Popular filters handlers
  const updateFilter = (index, field, value) => {
    const updated = [...popularFilters];
    updated[index] = { ...updated[index], [field]: value };
    setPopularFilters(updated);
  };

  const addFilter = () => {
    setPopularFilters([...popularFilters, {
      id: `filter-${Date.now()}`,
      label: 'New Filter',
      filter: 'category:tiles',
      enabled: true
    }]);
  };

  const removeFilter = (index) => {
    setPopularFilters(popularFilters.filter((_, i) => i !== index));
  };

  // Reset current group to defaults
  const handleResetDefaults = () => {
    if (!window.confirm(`Reset ${PRODUCT_GROUPS.find(g => g.id === activeGroup)?.label} to default hero slides and quick links?`)) return;
    setHeroSlides(DEFAULT_GROUP_HEROES[activeGroup] || []);
    setRoomLinks(DEFAULT_GROUP_ROOMS[activeGroup] || []);
    setPreviewSlide(0);
    toast.info('Reset to defaults. Click Save to apply.');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin w-8 h-8 border-2 border-amber-500 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  const currentPreviewSlide = heroSlides[previewSlide] || heroSlides[0];
  const activeGroupInfo = PRODUCT_GROUPS.find(g => g.id === activeGroup);
  const heroLabel = GROUP_HERO_LABEL[activeGroup] || 'Shop by Room';
  const quickLinksLabel = activeGroup === 'tiles' ? 'Room' : 'Category';

  // Check if group has custom admin settings saved
  const hasGroupSettings = (groupId) => {
    if (groupId === 'tiles') return fullSettings.heroSlides?.length > 0;
    return fullSettings.groups?.[groupId]?.heroSlides?.length > 0;
  };

  return (
    <div className={`${embedded ? 'p-4' : 'p-6'} max-w-7xl mx-auto`} data-testid="collections-page-settings">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        {!embedded && (
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Collections Page Settings</h1>
            <p className="text-gray-500 mt-1">Manage hero banners and quick links for each product group</p>
          </div>
        )}
        <div className="flex items-center gap-3">
          <button
            onClick={handleResetDefaults}
            className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-600 hover:text-gray-900 border border-gray-300 hover:border-gray-400 rounded-lg transition-all"
            data-testid="reset-defaults-btn"
          >
            Reset Defaults
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-6 py-2.5 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-lg transition-all disabled:opacity-50"
            data-testid="save-settings-btn"
          >
            {saving ? (
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <Save className="w-5 h-5" />
            )}
            Save Changes
          </button>
        </div>
      </div>

      {/* Product Group Selector */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-2">
          <Layers className="w-4 h-4 text-gray-500" />
          <span className="text-sm font-medium text-gray-600">Product Group</span>
        </div>
        <div className="flex flex-wrap gap-2" data-testid="group-selector">
          {PRODUCT_GROUPS.map((group) => (
            <button
              key={group.id}
              onClick={() => setActiveGroup(group.id)}
              data-testid={`group-btn-${group.id}`}
              className={`relative flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                activeGroup === group.id
                  ? 'text-white shadow-md'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
              style={activeGroup === group.id ? { backgroundColor: group.color } : {}}
            >
              {group.label}
              {hasGroupSettings(group.id) && (
                <span className={`w-2 h-2 rounded-full ${activeGroup === group.id ? 'bg-white/80' : 'bg-green-500'}`} title="Custom settings saved" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Content Tabs */}
      <div className="flex gap-2 mb-6 border-b border-gray-200">
        {[
          { id: 'hero', label: 'Hero Banners', icon: ImageIcon },
          { id: 'rooms', label: quickLinksLabel + ' Quick Links', icon: Home },
          ...(activeGroup === 'tiles' ? [{ id: 'filters', label: 'Popular Filters', icon: Filter }] : []),
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-3 font-medium transition-all border-b-2 -mb-px ${
              activeTab === tab.id 
                ? 'border-amber-500' 
                : 'text-gray-500 border-transparent hover:text-gray-900'
            }`}
            style={activeTab === tab.id ? { color: activeGroupInfo?.color } : {}}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Hero Banners Tab */}
      {activeTab === 'hero' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Editor */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold">Hero Slides - {activeGroupInfo?.label}</h2>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={heroEnabled}
                    onChange={(e) => setHeroEnabled(e.target.checked)}
                    className="rounded"
                  />
                  Enabled
                </label>
              </div>
              <button
                onClick={addHeroSlide}
                className="flex items-center gap-1 px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                data-testid="add-hero-slide-btn"
              >
                <Plus className="w-4 h-4" />
                Add Slide
              </button>
            </div>

            <div className="space-y-3 max-h-[600px] overflow-y-auto pr-2">
              {heroSlides.map((slide, index) => (
                <div 
                  key={slide.id}
                  data-testid={`hero-slide-${index}`}
                  className={`p-4 border rounded-xl transition-all cursor-pointer ${
                    previewSlide === index ? 'border-amber-500 bg-amber-50' : 'border-gray-200 hover:border-gray-300'
                  }`}
                  onClick={() => setPreviewSlide(index)}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex flex-col items-center gap-1 pt-2">
                      <GripVertical className="w-4 h-4 text-gray-400" />
                      <button onClick={(e) => { e.stopPropagation(); moveHeroSlide(index, 'up'); }} disabled={index === 0} className="p-1 hover:bg-gray-200 rounded disabled:opacity-30">
                        <ChevronUp className="w-3 h-3" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); moveHeroSlide(index, 'down'); }} disabled={index === heroSlides.length - 1} className="p-1 hover:bg-gray-200 rounded disabled:opacity-30">
                        <ChevronDown className="w-3 h-3" />
                      </button>
                    </div>

                    <div className="w-24 h-16 rounded-lg overflow-hidden bg-gray-100 flex-shrink-0">
                      {slide.image ? (
                        <img src={normaliseImageUrl(slide.image)} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400">
                          <ImageIcon className="w-6 h-6" />
                        </div>
                      )}
                    </div>

                    <div className="flex-1 space-y-2">
                      <input type="text" value={slide.title} onChange={(e) => updateHeroSlide(index, 'title', e.target.value)} placeholder="Slide Title" className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent" onClick={(e) => e.stopPropagation()} />
                      <input type="text" value={slide.subtitle} onChange={(e) => updateHeroSlide(index, 'subtitle', e.target.value)} placeholder="Subtitle" className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent" onClick={(e) => e.stopPropagation()} />
                      <input type="text" value={slide.image} onChange={(e) => updateHeroSlide(index, 'image', e.target.value)} placeholder="Image URL" className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent" onClick={(e) => e.stopPropagation()} />
                      <input type="text" value={slide.link} onChange={(e) => updateHeroSlide(index, 'link', e.target.value)} placeholder="Link URL" className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent" onClick={(e) => e.stopPropagation()} />
                    </div>

                    <div className="flex flex-col gap-1">
                      <button onClick={(e) => { e.stopPropagation(); updateHeroSlide(index, 'enabled', !slide.enabled); }} className={`p-2 rounded-lg transition-colors ${slide.enabled ? 'text-green-600 bg-green-50' : 'text-gray-400 bg-gray-100'}`} title={slide.enabled ? 'Enabled' : 'Disabled'}>
                        {slide.enabled ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); removeHeroSlide(index); }} className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="Delete">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Live Preview */}
          <div className="lg:sticky lg:top-4">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Eye className="w-5 h-5" />
              Live Preview
            </h2>
            <div className="relative aspect-[16/9] rounded-xl overflow-hidden bg-gray-900 shadow-2xl">
              {currentPreviewSlide?.image ? (
                <img src={normaliseImageUrl(currentPreviewSlide.image)} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-500">
                  <ImageIcon className="w-16 h-16" />
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-r from-black/60 via-black/30 to-transparent" />
              <div className="absolute inset-0 flex flex-col justify-center p-8">
                <p className="text-amber-400 text-xs font-medium tracking-widest uppercase mb-2">
                  {heroLabel}
                </p>
                <h2 className="text-2xl md:text-3xl font-light text-white mb-2">
                  {currentPreviewSlide?.title || 'Slide Title'}
                </h2>
                <p className="text-white/80 text-sm mb-4">
                  {currentPreviewSlide?.subtitle || 'Subtitle text'}
                </p>
                <button className="self-start px-4 py-2 bg-white text-gray-900 text-sm font-semibold rounded-full">
                  Explore Collection
                </button>
              </div>
              <div className="absolute bottom-4 right-4 flex gap-1.5">
                {heroSlides.filter(s => s.enabled).map((_, idx) => (
                  <button key={idx} onClick={() => setPreviewSlide(idx)} className={`w-2 h-2 rounded-full transition-all ${idx === previewSlide ? 'bg-white w-6' : 'bg-white/40'}`} />
                ))}
              </div>
            </div>

            {/* Quick links preview */}
            <div className="mt-4 flex flex-wrap gap-2">
              {roomLinks.filter(r => r.enabled).map((room) => (
                <span key={room.id} className="flex items-center gap-1.5 px-3 py-1.5 bg-white/90 rounded-full text-xs font-medium shadow-sm border border-gray-200">
                  {room.icon} {room.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Quick Links Tab */}
      {activeTab === 'rooms' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold">{quickLinksLabel} Quick Links - {activeGroupInfo?.label}</h2>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={roomLinksEnabled} onChange={(e) => setRoomLinksEnabled(e.target.checked)} className="rounded" />
                  Enabled
                </label>
              </div>
              <button onClick={addRoomLink} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors" data-testid="add-room-link-btn">
                <Plus className="w-4 h-4" />
                Add Link
              </button>
            </div>

            <div className="space-y-3">
              {roomLinks.map((room, index) => (
                <div key={room.id} className="p-4 border border-gray-200 rounded-xl hover:border-gray-300 transition-all" data-testid={`room-link-${index}`}>
                  <div className="flex items-center gap-3">
                    <select value={room.icon} onChange={(e) => updateRoomLink(index, 'icon', e.target.value)} className="w-14 h-10 text-xl text-center border border-gray-200 rounded-lg appearance-none cursor-pointer">
                      {EMOJI_OPTIONS.map((emoji) => (
                        <option key={emoji} value={emoji}>{emoji}</option>
                      ))}
                    </select>
                    <input type="text" value={room.label} onChange={(e) => updateRoomLink(index, 'label', e.target.value)} placeholder="Label" className="flex-1 px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent" />
                    <input type="text" value={room.link} onChange={(e) => updateRoomLink(index, 'link', e.target.value)} placeholder="/tiles?group=..." className="flex-1 px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent text-sm" />
                    <button onClick={() => updateRoomLink(index, 'enabled', !room.enabled)} className={`p-2 rounded-lg transition-colors ${room.enabled ? 'text-green-600 bg-green-50' : 'text-gray-400 bg-gray-100'}`}>
                      {room.enabled ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                    </button>
                    <button onClick={() => removeRoomLink(index)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:sticky lg:top-4">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Eye className="w-5 h-5" />
              Preview
            </h2>
            <div className="p-6 bg-gray-900 rounded-xl">
              <p className="text-white/60 text-xs mb-3">{heroLabel} links on hero banner:</p>
              <div className="flex flex-wrap gap-2">
                {roomLinks.filter(r => r.enabled).map((room) => (
                  <span key={room.id} className="flex items-center gap-2 px-4 py-2 bg-white/20 hover:bg-white/30 text-white rounded-full text-sm font-medium cursor-pointer transition-colors">
                    {room.icon} {room.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Popular Filters Tab (tiles only) */}
      {activeTab === 'filters' && activeGroup === 'tiles' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold">Popular Filters</h2>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={filtersEnabled} onChange={(e) => setFiltersEnabled(e.target.checked)} className="rounded" />
                  Enabled
                </label>
              </div>
              <button onClick={addFilter} className="flex items-center gap-1 px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors">
                <Plus className="w-4 h-4" />
                Add Filter
              </button>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
              <AlertCircle className="w-4 h-4 inline mr-2" />
              Filter format: <code className="bg-amber-100 px-1 rounded">key:value</code> e.g., <code className="bg-amber-100 px-1 rounded">category:bathroom-tiles</code>
            </div>

            <div className="space-y-3">
              {popularFilters.map((filter, index) => (
                <div key={filter.id} className="p-4 border border-gray-200 rounded-xl hover:border-gray-300 transition-all">
                  <div className="flex items-center gap-3">
                    <input type="text" value={filter.label} onChange={(e) => updateFilter(index, 'label', e.target.value)} placeholder="Display Label" className="flex-1 px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent" />
                    <input type="text" value={filter.filter} onChange={(e) => updateFilter(index, 'filter', e.target.value)} placeholder="filter:value" className="flex-1 px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-amber-500 focus:border-transparent font-mono text-sm" />
                    <button onClick={() => updateFilter(index, 'enabled', !filter.enabled)} className={`p-2 rounded-lg transition-colors ${filter.enabled ? 'text-green-600 bg-green-50' : 'text-gray-400 bg-gray-100'}`}>
                      {filter.enabled ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                    </button>
                    <button onClick={() => removeFilter(index)} className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:sticky lg:top-4">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <Eye className="w-5 h-5" />
              Preview
            </h2>
            <div className="p-6 bg-gray-50 rounded-xl border border-gray-200">
              <p className="text-gray-500 text-xs mb-3 uppercase tracking-wider">Popular:</p>
              <div className="flex flex-wrap gap-2">
                {popularFilters.filter(f => f.enabled).map((filter) => (
                  <span key={filter.id} className="px-4 py-2 bg-white border border-gray-200 hover:border-gray-900 rounded-full text-sm font-medium cursor-pointer transition-all">
                    {filter.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CollectionsPageSettings;
