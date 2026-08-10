import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { 
  Menu, Grid3X3, Layers, Filter, Plus, Edit2, Trash2, Save, X, Grid, 
  ChevronDown, ChevronRight, GripVertical, Eye, EyeOff, RefreshCw,
  ExternalLink, Settings, FolderOpen, Flame, Package, Wrench, Puzzle,
  CheckSquare, Sliders, ToggleLeft, Monitor, Home, Link2, ArrowUp, ArrowDown,
  Upload, Loader2, Image as ImageIcon, Tag, Star, Palette, MapPin, Truck, 
  Heart, ShieldCheck, Clock, CreditCard, Gift, Sparkles, Award, Zap,
  CheckCircle, AlertTriangle
} from 'lucide-react';

// Available icons for feature cards
const featureIconOptions = [
  { value: 'Star', label: 'Star', icon: Star },
  { value: 'Palette', label: 'Palette/Design', icon: Palette },
  { value: 'Package', label: 'Package/Samples', icon: Package },
  { value: 'MapPin', label: 'Location/Showrooms', icon: MapPin },
  { value: 'Truck', label: 'Delivery', icon: Truck },
  { value: 'Heart', label: 'Heart/Love', icon: Heart },
  { value: 'ShieldCheck', label: 'Quality/Trust', icon: ShieldCheck },
  { value: 'Clock', label: 'Time/Hours', icon: Clock },
  { value: 'CreditCard', label: 'Payment', icon: CreditCard },
  { value: 'Gift', label: 'Gift/Offers', icon: Gift },
  { value: 'Sparkles', label: 'Special', icon: Sparkles },
  { value: 'Award', label: 'Award/Quality', icon: Award },
  { value: 'Zap', label: 'Fast/Quick', icon: Zap },
];
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import { Badge } from '../../components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '../../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Checkbox } from '../../components/ui/checkbox';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Icon mapping for category groups
const GroupIcons = {
  'Grid3X3': Grid3X3,
  'Flame': Flame,
  'Package': Package,
  'Wrench': Wrench,
  'Puzzle': Puzzle,
  'FolderOpen': FolderOpen,
  'Layers': Layers,
};

const NavigationStructureManager = () => {
  // Get initial tab from URL parameter or default to 'navigation'
  const getInitialTab = () => {
    const params = new URLSearchParams(window.location.search);
    const tabParam = params.get('tab');
    const validTabs = ['navigation', 'shop-tabs', 'categories', 'filters', 'labels', 'features', 'specifications', 'homepage'];
    return validTabs.includes(tabParam) ? tabParam : 'navigation';
  };
  
  const [activeTab, setActiveTab] = useState(getInitialTab);
  const [loading, setLoading] = useState(true);
  
  // Update URL when tab changes
  const handleTabChange = (newTab) => {
    setActiveTab(newTab);
    const url = new URL(window.location);
    url.searchParams.set('tab', newTab);
    window.history.replaceState({}, '', url);
  };
  
  // Product Group Context Selector - for filtering Filters/Categories/Specs by product group
  // Default to 'tiles' (All Tiles) instead of 'all'
  const [selectedProductGroup, setSelectedProductGroup] = useState('tiles');
  
  // Navigation data
  const [mainNavItems, setMainNavItems] = useState([]);
  const [shopTabs, setShopTabs] = useState([]);
  const [shopTabsByGroup, setShopTabsByGroup] = useState({});
  const [loadingShopTabs, setLoadingShopTabs] = useState(false);
  const initialLoadDone = React.useRef(false);
  
  // Categories data
  const [categoryGroups, setCategoryGroups] = useState([]);
  const [categories, setCategories] = useState([]);
  const [categoriesByGroup, setCategoriesByGroup] = useState([]);
  const [expandedGroups, setExpandedGroups] = useState({});
  
  // Filters data
  const [filters, setFilters] = useState([]);
  const [filterGroups, setFilterGroups] = useState([]);
  const [pageSettings, setPageSettings] = useState([]);
  
  // Page Banners data
  const [pageBanners, setPageBanners] = useState([]);
  const [showBannerDialog, setShowBannerDialog] = useState(false);
  const [editingBanner, setEditingBanner] = useState(null);
  const [bannerForm, setBannerForm] = useState({
    title: '', subtitle: '', image: '', overlay: 'rgba(0,0,0,0.3)',
    category_slug: '', group_slug: '', is_default: false, is_active: true
  });
  const [uploadingBannerImage, setUploadingBannerImage] = useState(false);
  
  // Labels state
  const [availableLabels, setAvailableLabels] = useState({ predefined: [], custom: [] });
  const [showLabelDialog, setShowLabelDialog] = useState(false);
  const [newLabelForm, setNewLabelForm] = useState({ value: '', label: '', color: 'gray', description: '' });
  
  // Feature Cards state
  const [featureCards, setFeatureCards] = useState([]);
  const [showFeatureDialog, setShowFeatureDialog] = useState(false);
  const [editingFeature, setEditingFeature] = useState(null);
  const [featureForm, setFeatureForm] = useState({ icon: 'Star', title: '', description: '', link: '/shop', is_active: true });
  
  // Specifications state
  const [specificationGroups, setSpecificationGroups] = useState([]);
  const [specificationTypes, setSpecificationTypes] = useState([]);
  const [specsByGroup, setSpecsByGroup] = useState([]);
  const [expandedSpecGroups, setExpandedSpecGroups] = useState({});
  const [showSpecDialog, setShowSpecDialog] = useState(false);
  const [showSpecGroupDialog, setShowSpecGroupDialog] = useState(false);
  const [editingSpec, setEditingSpec] = useState(null);
  const [editingSpecGroup, setEditingSpecGroup] = useState(null);
  const [specForm, setSpecForm] = useState({ name: '', slug: '', description: '', group_slug: 'general', field_name: '', display_order: 0, is_active: true, auto_populate: true, values: [] });
  const [specGroupForm, setSpecGroupForm] = useState({ name: '', slug: '', description: '', icon: 'Layers', color: '#6b7280', display_order: 0, is_active: true });
  const [newSpecValue, setNewSpecValue] = useState('');
  
  // Homepage content states
  const [heroSlides, setHeroSlides] = useState([]);
  const [benefitsBar, setBenefitsBar] = useState([]);
  const [showHeroSlideDialog, setShowHeroSlideDialog] = useState(false);
  const [showBenefitDialog, setShowBenefitDialog] = useState(false);
  const [editingHeroSlide, setEditingHeroSlide] = useState(null);
  const [editingBenefit, setEditingBenefit] = useState(null);
  const [heroSlideForm, setHeroSlideForm] = useState({ image: '', badge: '', title: '', subtitle: '', cta: 'Shop Now', link: '/tiles', display_order: 0, is_active: true });
  const [benefitForm, setBenefitForm] = useState({ text: '', link: '/shop', display_order: 0, is_active: true });
  
  // Filter-Specification Sync Status
  const [filterSpecSyncStatus, setFilterSpecSyncStatus] = useState({ all_in_sync: true, shared_attributes: [] });
  const [syncingFilterSpecs, setSyncingFilterSpecs] = useState(false);
  
  // Dialog states
  const [showNavDialog, setShowNavDialog] = useState(false);
  const [showCategoryDialog, setShowCategoryDialog] = useState(false);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [showFilterDialog, setShowFilterDialog] = useState(false);
  
  // Product Image Selector state
  const [showProductImageSelector, setShowProductImageSelector] = useState(false);
  const [productImageSelectorIndex, setProductImageSelectorIndex] = useState(null); // Which filter value index we're selecting for
  const [productSearchQuery, setProductSearchQuery] = useState('');
  const [productSearchResults, setProductSearchResults] = useState([]);
  const [productSearchLoading, setProductSearchLoading] = useState(false);
  
  const [editingNav, setEditingNav] = useState(null);
  const [editingCategory, setEditingCategory] = useState(null);
  const [editingGroup, setEditingGroup] = useState(null);
  const [editingFilter, setEditingFilter] = useState(null);
  
  // Form states
  const [navForm, setNavForm] = useState({ label: '', url: '', display_order: 0, is_active: true });
  const [categoryForm, setCategoryForm] = useState({
    name: '', slug: '', description: '', group_slug: 'tiles', image_url: '',
    display_order: 0, is_active: true, show_on_homepage: false
  });
  const [groupForm, setGroupForm] = useState({
    name: '', slug: '', description: '', icon: 'FolderOpen', color: '#3B82F6',
    display_order: 0, is_active: true
  });
  const [filterForm, setFilterForm] = useState({
    name: '', slug: '', input_type: 'checkbox', description: '', values: [],
    is_active: true, auto_populate: false, auto_populate_field: '',
    auto_populate_categories: [], auto_populate_groups: [],
    // Visibility flags for unified system
    show_in_bulk_editor: true,
    show_in_shop_filter: true,
    show_in_product_detail: true,
    allow_new_values_in_bulk_editor: false
  });

  useEffect(() => {
    fetchAllData();
  }, []);

  // Get the backend menu_type key for a product group
  const getShopMenuType = (groupSlug) => {
    if (!groupSlug || groupSlug === 'all' || groupSlug === 'tiles') return 'shop';
    return `shop_${groupSlug}`;
  };

  // Load shop tabs for the selected product group (skip initial mount, fetchAllData handles that)
  useEffect(() => {
    if (!initialLoadDone.current) return;
    const menuType = getShopMenuType(selectedProductGroup);
    // Check cache first
    if (shopTabsByGroup[menuType] !== undefined) {
      setShopTabs(shopTabsByGroup[menuType]);
      return;
    }
    // Fetch from backend
    const fetchGroupTabs = async () => {
      setLoadingShopTabs(true);
      try {
        const token = localStorage.getItem('token');
        const res = await fetch(`${API_URL}/api/website-admin/navigation/${menuType}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          const items = Array.isArray(data) ? data : (data.items || []);
          const mapped = items.map(item => ({ ...item, url: item.link_url || item.url }));
          setShopTabs(mapped);
          setShopTabsByGroup(prev => ({ ...prev, [menuType]: mapped }));
        } else {
          setShopTabs([]);
          setShopTabsByGroup(prev => ({ ...prev, [menuType]: [] }));
        }
      } catch (e) {
        console.error('Failed to load shop tabs for group:', menuType, e);
        setShopTabs([]);
      } finally {
        setLoadingShopTabs(false);
      }
    };
    fetchGroupTabs();
  }, [selectedProductGroup]);

  const fetchAllData = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const headers = { Authorization: `Bearer ${token}` };
      
      const [navRes, shopRes, catGroupsRes, catsRes, catsByGroupRes, filtersRes, filterGroupsRes, pageSettingsRes, bannersRes, labelsRes, featuresRes, specsRes, specGroupsRes, heroSlidesRes, benefitsRes, syncStatusRes] = await Promise.all([
        fetch(`${API_URL}/api/website-admin/navigation/main`, { headers }),
        fetch(`${API_URL}/api/website-admin/navigation/shop`, { headers }),
        fetch(`${API_URL}/api/website-admin/category-groups`, { headers }),
        fetch(`${API_URL}/api/website-admin/categories`, { headers }),
        fetch(`${API_URL}/api/website-admin/categories/by-group`, { headers }),
        fetch(`${API_URL}/api/filters/types`),
        fetch(`${API_URL}/api/filters/groups`),
        fetch(`${API_URL}/api/filters/page-settings`),
        fetch(`${API_URL}/api/website-admin/page-banners`, { headers }),
        fetch(`${API_URL}/api/tiles/labels/available`),
        fetch(`${API_URL}/api/website-admin/feature-cards`, { headers }),
        fetch(`${API_URL}/api/specifications/types/by-group`),
        fetch(`${API_URL}/api/specifications/groups`),
        fetch(`${API_URL}/api/website-admin/hero-slides`, { headers }),
        fetch(`${API_URL}/api/website-admin/benefits-bar`, { headers }),
        fetch(`${API_URL}/api/filters/sync-status`)
      ]);
      
      if (navRes.ok) {
        const data = await navRes.json();
        // Handle both array response and object with items
        const items = Array.isArray(data) ? data : (data.items || []);
        setMainNavItems(items.map(item => ({
          ...item,
          url: item.link_url || item.url
        })));
      }
      if (shopRes.ok) {
        const data = await shopRes.json();
        const items = Array.isArray(data) ? data : (data.items || []);
        const mapped = items.map(item => ({ ...item, url: item.link_url || item.url }));
        // Store in cache for the default 'shop' (All Tiles) type
        setShopTabsByGroup(prev => ({ ...prev, shop: mapped }));
        // Set as current tabs (initial load always starts with default group)
        setShopTabs(mapped);
        initialLoadDone.current = true;
      }
      if (catGroupsRes.ok) setCategoryGroups(await catGroupsRes.json());
      if (catsRes.ok) setCategories(await catsRes.json());
      if (catsByGroupRes.ok) {
        const data = await catsByGroupRes.json();
        setCategoriesByGroup(data);
        const expanded = {};
        data.forEach(g => { expanded[g.slug] = true; });
        setExpandedGroups(expanded);
      }
      if (filtersRes.ok) setFilters(await filtersRes.json());
      if (filterGroupsRes.ok) setFilterGroups(await filterGroupsRes.json());
      if (pageSettingsRes.ok) setPageSettings(await pageSettingsRes.json());
      if (bannersRes.ok) setPageBanners(await bannersRes.json());
      if (labelsRes.ok) setAvailableLabels(await labelsRes.json());
      if (featuresRes.ok) setFeatureCards(await featuresRes.json());
      if (specsRes.ok) {
        const data = await specsRes.json();
        setSpecsByGroup(data);
        const expanded = {};
        data.forEach(g => { expanded[g.slug] = true; });
        setExpandedSpecGroups(expanded);
      }
      if (specGroupsRes.ok) setSpecificationGroups(await specGroupsRes.json());
      if (heroSlidesRes.ok) setHeroSlides(await heroSlidesRes.json());
      if (benefitsRes.ok) setBenefitsBar(await benefitsRes.json());
      if (syncStatusRes.ok) setFilterSpecSyncStatus(await syncStatusRes.json());
      
    } catch (e) {
      console.error('Failed to load data:', e);
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  // Navigation handlers
  const handleSaveNav = async (menuType) => {
    try {
      const token = localStorage.getItem('token');
      // For shop tabs, use the group-specific menu type
      const actualMenuType = menuType === 'shop' ? getShopMenuType(selectedProductGroup) : menuType;
      const items = menuType === 'main' ? mainNavItems : shopTabs;
      
      // Format items for the API
      const formattedItems = items.map((item, index) => ({
        id: item.id || Date.now().toString(),
        label: item.label,
        link_url: item.url || item.link_url,
        display_order: index,
        is_active: item.is_active !== false,
        highlight: item.highlight || false,
        highlight_color: item.highlight_color || null
      }));
      
      const res = await fetch(`${API_URL}/api/website-admin/navigation/${actualMenuType}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(formattedItems)
      });
      
      if (res.ok) {
        // Update the cache for this specific group
        if (menuType === 'shop') {
          setShopTabsByGroup(prev => ({ ...prev, [actualMenuType]: shopTabs }));
        }
        toast.success('Navigation saved successfully!');
        // Don't call fetchAllData() which would reset everything - just refetch nav
        if (menuType === 'main') {
          fetchAllData();
        }
      } else {
        const error = await res.json();
        toast.error(error.detail || 'Failed to save navigation');
      }
    } catch (e) {
      console.error('Save error:', e);
      toast.error('Failed to save navigation');
    }
  };

  const addNavItem = (menuType) => {
    const newItem = { id: Date.now().toString(), label: 'New Item', url: '/', display_order: 0, is_active: true };
    if (menuType === 'main') {
      setMainNavItems([...mainNavItems, newItem]);
    } else {
      setShopTabs([...shopTabs, newItem]);
    }
  };

  const removeNavItem = (menuType, index) => {
    if (menuType === 'main') {
      setMainNavItems(mainNavItems.filter((_, i) => i !== index));
    } else {
      setShopTabs(shopTabs.filter((_, i) => i !== index));
    }
  };

  const updateNavItem = (menuType, index, field, value) => {
    if (menuType === 'main') {
      const updated = [...mainNavItems];
      updated[index] = { ...updated[index], [field]: value };
      setMainNavItems(updated);
    } else {
      const updated = [...shopTabs];
      updated[index] = { ...updated[index], [field]: value };
      setShopTabs(updated);
    }
  };

  const reorderNavItem = (menuType, index, direction) => {
    const items = menuType === 'main' ? [...mainNavItems] : [...shopTabs];
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    
    if (newIndex < 0 || newIndex >= items.length) return;
    
    // Swap items
    const [movedItem] = items.splice(index, 1);
    items.splice(newIndex, 0, movedItem);
    
    // Update display_order for all items
    const updatedItems = items.map((item, i) => ({ ...item, display_order: i }));
    
    if (menuType === 'main') {
      setMainNavItems(updatedItems);
    } else {
      setShopTabs(updatedItems);
    }
  };

  // Category handlers
  const handleSaveCategory = async () => {
    try {
      const token = localStorage.getItem('token');
      const url = editingCategory 
        ? `${API_URL}/api/website-admin/categories/${editingCategory.id}`
        : `${API_URL}/api/website-admin/categories`;
      
      const res = await fetch(url, {
        method: editingCategory ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(categoryForm)
      });
      
      if (res.ok) {
        toast.success(editingCategory ? 'Category updated' : 'Category created');
        setShowCategoryDialog(false);
        setEditingCategory(null);
        fetchAllData();
      }
    } catch (e) {
      toast.error('Failed to save category');
    }
  };

  const handleDeleteCategory = async (categoryId) => {
    if (!window.confirm('Delete this category? It will not return when you sync from products.')) return;
    try {
      const token = localStorage.getItem('token');
      await fetch(`${API_URL}/api/website-admin/categories/${categoryId}?exclude_from_sync=true`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      toast.success('Category deleted (excluded from future syncs)');
      fetchAllData();
    } catch (e) {
      toast.error('Failed to delete');
    }
  };

  const handleMoveToGroup = async (categoryId, newGroupSlug) => {
    try {
      const token = localStorage.getItem('token');
      const category = categories.find(c => c.id === categoryId);
      if (!category) return;
      
      await fetch(`${API_URL}/api/website-admin/categories/${categoryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...category, group_slug: newGroupSlug })
      });
      
      toast.success(`Moved to ${newGroupSlug}`);
      fetchAllData();
    } catch (e) {
      toast.error('Failed to move');
    }
  };

  // Group handlers
  const handleSaveGroup = async () => {
    try {
      const token = localStorage.getItem('token');
      const url = editingGroup 
        ? `${API_URL}/api/website-admin/category-groups/${editingGroup.id}`
        : `${API_URL}/api/website-admin/category-groups`;
      
      const res = await fetch(url, {
        method: editingGroup ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(groupForm)
      });
      
      if (res.ok) {
        toast.success(editingGroup ? 'Group updated' : 'Group created');
        setShowGroupDialog(false);
        setEditingGroup(null);
        fetchAllData();
      }
    } catch (e) {
      toast.error('Failed to save group');
    }
  };

  const handleDeleteGroup = async (groupId) => {
    if (!window.confirm('Delete this group? Categories will become ungrouped.')) return;
    try {
      const token = localStorage.getItem('token');
      await fetch(`${API_URL}/api/website-admin/category-groups/${groupId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      toast.success('Group deleted');
      fetchAllData();
    } catch (e) {
      toast.error('Failed to delete');
    }
  };

  // Reorder groups
  const handleReorderGroup = async (groupId, direction) => {
    const currentIndex = categoriesByGroup.findIndex(g => (g.id || g.slug) === groupId);
    if (currentIndex === -1) return;
    
    const newIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (newIndex < 0 || newIndex >= categoriesByGroup.length) return;
    
    // Create new order
    const newOrder = [...categoriesByGroup];
    const [movedItem] = newOrder.splice(currentIndex, 1);
    newOrder.splice(newIndex, 0, movedItem);
    
    // Update display_order for all groups
    const updates = newOrder.map((group, index) => ({
      id: group.id,
      slug: group.slug,
      display_order: index
    }));
    
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/category-groups/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ groups: updates })
      });
      
      if (res.ok) {
        toast.success('Groups reordered');
        fetchAllData();
      } else {
        toast.error('Failed to reorder');
      }
    } catch (e) {
      toast.error('Failed to reorder groups');
    }
  };

  // Product Image Selector - Search products
  const searchProductsForImage = async (query) => {
    if (!query || query.length < 2) {
      setProductSearchResults([]);
      return;
    }
    
    setProductSearchLoading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/supplier-products/search?q=${encodeURIComponent(query)}&limit=20`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      
      if (res.ok) {
        const data = await res.json();
        // Filter to only products with images
        const productsWithImages = (data.products || data || []).filter(p => 
          p.main_image || p.images?.length > 0 || p.lifestyle_image
        );
        setProductSearchResults(productsWithImages);
      }
    } catch (error) {
      console.error('Error searching products:', error);
    } finally {
      setProductSearchLoading(false);
    }
  };

  // Select product image for filter value
  const selectProductImage = (product, valueIndex) => {
    const imageUrl = product.main_image || product.images?.[0] || product.lifestyle_image;
    if (imageUrl) {
      const newValues = [...filterForm.values];
      newValues[valueIndex] = { ...newValues[valueIndex], image_url: imageUrl };
      setFilterForm({ ...filterForm, values: newValues });
      setShowProductImageSelector(false);
      setProductSearchQuery('');
      setProductSearchResults([]);
      toast.success(`Image selected from "${product.name || product.series_name}"`);
    }
  };

  // Filter handlers
  const handleSaveFilter = async () => {
    try {
      const url = editingFilter 
        ? `${API_URL}/api/filters/types/${editingFilter.id}`
        : `${API_URL}/api/filters/types`;
      
      // If editing, fetch the latest values from DB to avoid overwriting
      // changes made by other pages (ManageOptionsModal, etc.)
      let latestValues = filterForm.values || [];
      let removedSlugs = new Set();
      if (editingFilter) {
        try {
          const latestRes = await fetch(`${API_URL}/api/filters/types`);
          if (latestRes.ok) {
            const allFilters = await latestRes.json();
            const latestFilter = allFilters.find(f => f.id === editingFilter.id);
            if (latestFilter) {
              // Use the latest values from DB, merging any new values added in the dialog
              const latestMap = new Map((latestFilter.values || []).map(v => [v.value, v]));
              const formMap = new Map((filterForm.values || []).map(v => [v.value, v]));
              
              // Start with latest DB values
              const mergedValues = [...(latestFilter.values || [])];
              
              // Add any NEW values from the form that aren't in DB
              for (const [slug, val] of formMap) {
                if (!latestMap.has(slug)) {
                  mergedValues.push(val);
                }
              }
              
              // Detect values that were explicitly deleted in the form
              if (editingFilter.values) {
                const formSlugs = new Set(formMap.keys());
                for (const v of editingFilter.values) {
                  if (!formSlugs.has(v.value)) {
                    removedSlugs.add(v.value);
                  }
                }
              }
              
              // GROUP-SCOPED: If working on a specific group, don't remove values globally
              if (selectedProductGroup && selectedProductGroup !== 'all') {
                // Keep ALL values in the PUT (don't remove anything)
                latestValues = mergedValues;
                // Toggle-group calls will handle hiding removed values from this group AFTER the PUT
              } else {
                // ALL GROUPS: Remove values globally (original behavior)
                latestValues = mergedValues.filter(v => !removedSlugs.has(v.value));
              }
            }
          }
        } catch (e) {
          console.warn('Failed to fetch latest filter values, using form values', e);
        }
      }
      
      // If editing with "all" selected, detect which values were removed and should be excluded from sync
      let excludedValues = [];
      if (editingFilter && editingFilter.values && (!selectedProductGroup || selectedProductGroup === 'all')) {
        const currentValueSlugs = new Set(latestValues.map(v => v.value));
        const removedValues = editingFilter.values.filter(v => !currentValueSlugs.has(v.value));
        excludedValues = removedValues.map(v => v.value);
      }
      
      // Add removed values to excluded_values list
      const dataToSave = {
        ...filterForm,
        values: latestValues,
        excluded_values: [...new Set([...(filterForm.excluded_values || []), ...excludedValues])]
      };
      
      // STEP 1: Do the PUT first (saves metadata, preserves all values)
      const res = await fetch(url, {
        method: editingFilter ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dataToSave)
      });
      
      if (res.ok) {
        // STEP 2: AFTER the PUT completes, do toggle-group calls
        // This order prevents the PUT from overwriting toggle-group changes
        if (selectedProductGroup && selectedProductGroup !== 'all' && removedSlugs.size > 0 && editingFilter) {
          for (const slug of removedSlugs) {
            try {
              await fetch(`${API_URL}/api/filters/types/${editingFilter.id}/values/${encodeURIComponent(slug)}/toggle-group`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ product_group: selectedProductGroup, action: 'remove' })
              });
            } catch (e) {
              console.warn(`Failed to toggle-group for value ${slug}`, e);
            }
          }
          const groupName = categoryGroups.find(g => g.slug === selectedProductGroup)?.name || selectedProductGroup;
          toast.info(`${removedSlugs.size} value(s) hidden from ${groupName} only`);
        } else if (excludedValues.length > 0) {
          toast.info(`${excludedValues.length} removed value(s) will not return on sync`);
        }
        
        toast.success(editingFilter ? 'Filter updated' : 'Filter created');
        setShowFilterDialog(false);
        setEditingFilter(null);
        fetchAllData();
      } else {
        let errorMsg = 'Failed to save filter';
        try {
          const error = await res.json();
          errorMsg = error.detail || errorMsg;
        } catch (e) {
          errorMsg = `Failed to save filter (${res.status})`;
        }
        toast.error(errorMsg);
      }
    } catch (e) {
      console.error('Filter save error:', e);
      toast.error('Failed to save filter: ' + (e.message || 'Unknown error'));
    }
  };

  const handleDeleteFilter = async (filterId) => {
    if (selectedProductGroup && selectedProductGroup !== 'all') {
      // GROUP-SCOPED: Hide filter from this group only
      const groupName = categoryGroups.find(g => g.slug === selectedProductGroup)?.name || selectedProductGroup;
      if (!window.confirm(`Hide this filter from ${groupName}? It will remain in other groups.`)) return;
      try {
        const res = await fetch(`${API_URL}/api/filters/types/${filterId}/toggle-type-visibility`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_group: selectedProductGroup, action: 'hide' })
        });
        if (res.ok) {
          toast.success(`Filter hidden from ${groupName}`);
        } else {
          const err = await res.json();
          toast.error(err.detail || 'Failed to hide filter');
        }
        fetchAllData();
      } catch (e) {
        toast.error('Failed to hide filter');
      }
    } else {
      // ALL GROUPS: Global delete
      if (!window.confirm('You are working on ALL groups. This will PERMANENTLY DELETE this filter from every group. Continue?')) return;
      try {
        await fetch(`${API_URL}/api/filters/types/${filterId}`, { method: 'DELETE' });
        toast.success('Filter permanently deleted from all groups');
        fetchAllData();
      } catch (e) {
        toast.error('Failed to delete');
      }
    }
  };

  // Toggle filter visibility for the selected product group
  const handleToggleFilterGroupVisibility = async (filterId, filterName, isCurrentlyVisible) => {
    if (!selectedProductGroup || selectedProductGroup === 'all') return;
    const groupName = categoryGroups.find(g => g.slug === selectedProductGroup)?.name || selectedProductGroup;
    const action = isCurrentlyVisible ? 'hide' : 'show';
    try {
      const res = await fetch(`${API_URL}/api/filters/types/${filterId}/toggle-type-visibility`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_group: selectedProductGroup, action })
      });
      if (res.ok) {
        const data = await res.json();
        // Update local state immediately
        setFilters(prev => prev.map(f =>
          f.id === filterId ? { ...f, hidden_groups: data.hidden_groups } : f
        ));
        toast.success(`${filterName} ${action === 'hide' ? 'hidden from' : 'shown in'} ${groupName}`);
      } else {
        toast.error('Failed to update visibility');
      }
    } catch {
      toast.error('Network error');
    }
  };

  // Toggle spec visibility for the selected product group
  const handleToggleSpecGroupVisibility = async (specId, specName, isCurrentlyVisible) => {
    if (!selectedProductGroup || selectedProductGroup === 'all') return;
    const groupName = categoryGroups.find(g => g.slug === selectedProductGroup)?.name || selectedProductGroup;
    const action = isCurrentlyVisible ? 'hide' : 'show';
    try {
      const res = await fetch(`${API_URL}/api/specifications/types/${specId}/toggle-type-visibility`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_group: selectedProductGroup, action })
      });
      if (res.ok) {
        const data = await res.json();
        // Update specifications state (they're nested in specsByGroup)
        setSpecsByGroup(prev => prev.map(group => ({
          ...group,
          specifications: (group.specifications || []).map(s =>
            s.id === specId ? { ...s, hidden_groups: data.hidden_groups } : s
          )
        })));
        toast.success(`${specName} ${action === 'hide' ? 'hidden from' : 'shown in'} ${groupName}`);
      } else {
        toast.error('Failed to update visibility');
      }
    } catch {
      toast.error('Network error');
    }
  };

  const handleClearFilterValues = async (filterId, filterName) => {
    if (!window.confirm(`Clear all values from "${filterName}"? This will empty the filter so you can re-sync with correct restrictions.`)) return;
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/filters/types/${filterId}/clear-values`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });
      if (res.ok) {
        toast.success(`Cleared values from "${filterName}". Now sync to refill with correct restrictions.`);
        fetchAllData();
      } else {
        toast.error('Failed to clear values');
      }
    } catch (e) {
      toast.error('Failed to clear values');
    }
  };

  // Clear and Re-sync a single filter with its restrictions
  const handleClearAndResync = async (filterId, filterName) => {
    if (!window.confirm(`This will:\n1. Clear all ${filterName} values\n2. Re-sync from products with your group restrictions\n\nContinue?`)) return;
    
    const loadingToast = toast.loading(`Clearing and re-syncing ${filterName}...`);
    
    try {
      const token = localStorage.getItem('token');
      
      // Step 1: Clear values
      const clearRes = await fetch(`${API_URL}/api/filters/types/${filterId}/clear-values`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (!clearRes.ok) {
        toast.dismiss(loadingToast);
        toast.error('Failed to clear values');
        return;
      }
      
      // Step 2: Re-sync from products
      const syncRes = await fetch(`${API_URL}/api/filters/sync-values-from-products`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      
      const syncData = await syncRes.json();
      toast.dismiss(loadingToast);
      
      if (syncRes.ok) {
        const thisFilter = syncData.synced_filters?.find(f => f.filter === filterName);
        if (thisFilter) {
          toast.success(`${filterName}: Synced ${thisFilter.new_values_count} values from ${thisFilter.restrictions?.join(', ') || 'all products'}`);
        } else {
          toast.success(`${filterName} cleared. No new values found with current restrictions.`);
        }
        fetchAllData();
      } else {
        toast.error('Sync failed');
      }
    } catch (e) {
      toast.dismiss(loadingToast);
      toast.error('Failed to clear and re-sync');
    }
  };

  // Normalize all size filters (fix format inconsistencies and remove duplicates)
  const handleNormalizeSizes = async () => {
    if (!window.confirm('This will normalize all Size filters:\n\n• Fix format inconsistencies (1000X1000Mm → 1000 x 1000 mm)\n• Remove duplicates\n• Sort by dimensions\n\nContinue?')) return;
    
    const loadingToast = toast.loading('Normalizing size filters...');
    
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/filters/normalize-all-sizes`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      
      const data = await res.json();
      toast.dismiss(loadingToast);
      
      if (res.ok) {
        toast.success(`Normalized! Removed ${data.total_duplicates_removed} duplicates from ${data.results?.length || 0} filter(s)`);
        fetchAllData();
      } else {
        toast.error(data.detail || 'Normalization failed');
      }
    } catch (e) {
      toast.dismiss(loadingToast);
      toast.error('Failed to normalize sizes');
    }
  };

  const handleSeedDefaultFilters = async () => {
    try {
      const res = await fetch(`${API_URL}/api/filters/seed-defaults`, { method: 'POST' });
      const data = await res.json();
      if (data.skipped) {
        toast.info('Filters already exist');
      } else {
        toast.success('Default filters created successfully!');
      }
      fetchAllData();
    } catch (e) {
      toast.error('Failed to seed filters');
    }
  };

  // Sync categories from Supplier Products
  const handleSyncCategories = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/categories/sync-from-products`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || 'Categories synced from products!');
        fetchAllData();
      } else {
        toast.error(data.detail || 'Sync failed');
      }
    } catch (e) {
      toast.error('Failed to sync categories');
    }
  };

  // Sync filter values from product data
  const handleSyncFilterValues = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/filters/sync-values-from-products`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || `Synced ${data.total_new_values || 0} new values from products!`);
        fetchAllData();
      } else {
        toast.error(data.detail || 'Sync failed');
      }
    } catch (e) {
      toast.error('Failed to sync filter values');
    }
  };

  // URGENT: Rebuild filters from LIVE products only
  const handleRebuildFromLive = async () => {
    if (!window.confirm('⚠️ REBUILD ALL FILTERS FROM LIVE PRODUCTS ONLY\n\nThis will:\n1. Clear all current filter values\n2. Repopulate ONLY from products visible on the website\n3. Remove flooring/material values from tile filters\n\nThis cannot be undone. Continue?')) return;
    
    const loadingToast = toast.loading('Rebuilding filters from live products...');
    
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/filters/rebuild-all-from-live`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      
      const data = await res.json();
      toast.dismiss(loadingToast);
      
      if (res.ok) {
        const successful = data.results?.filter(r => r.success).length || 0;
        toast.success(`Rebuilt ${successful} filters from live products only!`);
        fetchAllData();
      } else {
        toast.error(data.detail || 'Rebuild failed');
      }
    } catch (e) {
      toast.dismiss(loadingToast);
      toast.error('Failed to rebuild filters');
    }
  };
  
  // Sync Filters with Specifications handler
  const handleSyncFilterWithSpecs = async () => {
    setSyncingFilterSpecs(true);
    const loadingToast = toast.loading('Syncing Filters with Specifications...');
    
    try {
      const res = await fetch(`${API_URL}/api/filters/sync-with-specifications`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      const data = await res.json();
      toast.dismiss(loadingToast);
      
      if (res.ok && data.success) {
        const totalAdded = (data.total_values_added_to_filters || 0) + (data.total_values_added_to_specs || 0);
        if (totalAdded > 0) {
          toast.success(`Synced! Added ${data.total_values_added_to_filters} to Filters, ${data.total_values_added_to_specs} to Specifications`);
        } else {
          toast.success('Already in sync!');
        }
        fetchAllData(); // Refresh data including sync status
      } else {
        toast.error(data.detail || 'Sync failed');
      }
    } catch (e) {
      toast.dismiss(loadingToast);
      toast.error('Failed to sync filters with specifications');
    } finally {
      setSyncingFilterSpecs(false);
    }
  };

  // Custom Label handlers
  const handleAddCustomLabel = async () => {
    if (!newLabelForm.value.trim()) {
      toast.error('Label value is required');
      return;
    }
    try {
      const res = await fetch(`${API_URL}/api/tiles/labels/custom`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newLabelForm)
      });
      if (res.ok) {
        toast.success(`Label "${newLabelForm.value}" added!`);
        setNewLabelForm({ value: '', label: '', color: 'gray', description: '' });
        setShowLabelDialog(false);
        fetchAllData();
      } else {
        toast.error('Failed to add label');
      }
    } catch (e) {
      toast.error('Failed to add label');
    }
  };

  const handleDeleteCustomLabel = async (labelValue) => {
    if (!window.confirm(`Delete custom label "${labelValue}"?`)) return;
    try {
      const res = await fetch(`${API_URL}/api/tiles/labels/custom/${encodeURIComponent(labelValue)}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        toast.success('Label deleted');
        fetchAllData();
      } else {
        toast.error('Failed to delete label');
      }
    } catch (e) {
      toast.error('Failed to delete label');
    }
  };

  // Feature Card handlers
  const handleSaveFeature = async () => {
    if (!featureForm.title.trim()) {
      toast.error('Title is required');
      return;
    }
    try {
      const token = localStorage.getItem('token');
      const url = editingFeature 
        ? `${API_URL}/api/website-admin/feature-cards/${editingFeature.id}`
        : `${API_URL}/api/website-admin/feature-cards`;
      
      const res = await fetch(url, {
        method: editingFeature ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(featureForm)
      });
      
      if (res.ok) {
        toast.success(editingFeature ? 'Feature card updated' : 'Feature card created');
        setShowFeatureDialog(false);
        setEditingFeature(null);
        setFeatureForm({ icon: 'Star', title: '', description: '', link: '/shop', is_active: true });
        fetchAllData();
      } else {
        toast.error('Failed to save feature card');
      }
    } catch (e) {
      toast.error('Failed to save feature card');
    }
  };

  const handleDeleteFeature = async (featureId) => {
    if (!window.confirm('Delete this feature card?')) return;
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/feature-cards/${featureId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        toast.success('Feature card deleted');
        fetchAllData();
      } else {
        toast.error('Failed to delete');
      }
    } catch (e) {
      toast.error('Failed to delete');
    }
  };

  const handleMoveFeature = async (index, direction) => {
    const newCards = [...featureCards];
    const newIndex = direction === 'up' ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= newCards.length) return;
    
    [newCards[index], newCards[newIndex]] = [newCards[newIndex], newCards[index]];
    
    try {
      const token = localStorage.getItem('token');
      await fetch(`${API_URL}/api/website-admin/feature-cards/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ card_ids: newCards.map(c => c.id) })
      });
      setFeatureCards(newCards);
    } catch (e) {
      toast.error('Failed to reorder');
    }
  };

  // Page Banner handlers
  const handleSaveBanner = async () => {
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/page-banners`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(bannerForm)
      });
      
      if (res.ok) {
        toast.success(editingBanner ? 'Banner updated' : 'Banner created');
        setShowBannerDialog(false);
        setEditingBanner(null);
        setBannerForm({ title: '', subtitle: '', image: '', overlay: 'rgba(0,0,0,0.3)', category_slug: '', group_slug: '', is_default: false, is_active: true });
        fetchAllData();
      }
    } catch (e) {
      toast.error('Failed to save banner');
    }
  };

  const handleDeleteBanner = async (bannerId) => {
    if (!window.confirm('Delete this banner?')) return;
    try {
      const token = localStorage.getItem('token');
      await fetch(`${API_URL}/api/website-admin/page-banners/${bannerId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      toast.success('Banner deleted');
      fetchAllData();
    } catch (e) {
      toast.error('Failed to delete');
    }
  };

  // Banner image upload handler
  const handleBannerImageUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    // Validate file type
    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!validTypes.includes(file.type)) {
      toast.error('Invalid file type. Use JPEG, PNG, WebP, or GIF.');
      return;
    }
    
    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      toast.error('Image too large. Maximum size is 10MB.');
      return;
    }
    
    setUploadingBannerImage(true);
    
    try {
      const token = localStorage.getItem('token');
      const formData = new FormData();
      formData.append('file', file);
      
      const res = await fetch(`${API_URL}/api/website-admin/upload-banner-image`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      });
      
      if (res.ok) {
        const data = await res.json();
        setBannerForm({ ...bannerForm, image: data.url });
        toast.success('Image uploaded successfully!');
      } else {
        const error = await res.json();
        toast.error(error.detail || 'Failed to upload image');
      }
    } catch (e) {
      console.error('Upload error:', e);
      toast.error('Failed to upload image');
    } finally {
      setUploadingBannerImage(false);
    }
  };

  // ============ SPECIFICATION HANDLERS ============
  
  const handleSeedSpecifications = async () => {
    try {
      const res = await fetch(`${API_URL}/api/specifications/seed-defaults`, { method: 'POST' });
      if (res.ok) {
        toast.success('Default specifications seeded');
        fetchAllData();
      } else {
        toast.error('Failed to seed specifications');
      }
    } catch (e) {
      toast.error('Failed to seed specifications');
    }
  };

  const handleSyncAllSpecs = async () => {
    try {
      const res = await fetch(`${API_URL}/api/specifications/sync-all?source=tiles`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        toast.success(`Synced specifications from products`);
        fetchAllData();
      } else {
        toast.error('Failed to sync specifications');
      }
    } catch (e) {
      toast.error('Failed to sync specifications');
    }
  };

  const handleSyncSpec = async (specId) => {
    try {
      const res = await fetch(`${API_URL}/api/specifications/types/${specId}/sync?source=tiles`, { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        toast.success(data.message);
        fetchAllData();
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Failed to sync specification');
      }
    } catch (e) {
      toast.error('Failed to sync specification');
    }
  };

  const handleSaveSpec = async () => {
    try {
      const url = editingSpec 
        ? `${API_URL}/api/specifications/types/${editingSpec.id}`
        : `${API_URL}/api/specifications/types`;
      const method = editingSpec ? 'PUT' : 'POST';
      
      let dataToSave = { ...specForm };
      let removedValues = [];
      
      // If editing, detect removed values
      if (editingSpec && editingSpec.values) {
        const currentValueSlugs = new Set((specForm.values || []).map(v => v.value));
        removedValues = editingSpec.values.filter(v => !currentValueSlugs.has(v.value));
        
        if (removedValues.length > 0 && selectedProductGroup && selectedProductGroup !== 'all') {
          // Keep all values in the PUT (backend merge will preserve them)
          // Re-add removed values so they aren't lost from other groups
          const allValues = [...(specForm.values || []), ...removedValues];
          dataToSave.values = allValues;
        }
      }
      
      // STEP 1: Do the PUT first (saves metadata, preserves all values)
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dataToSave)
      });
      
      if (res.ok) {
        // STEP 2: AFTER the PUT completes, do toggle-group calls
        // This order prevents the PUT from overwriting toggle-group changes
        if (removedValues.length > 0 && selectedProductGroup && selectedProductGroup !== 'all' && editingSpec) {
          for (const rv of removedValues) {
            try {
              await fetch(`${API_URL}/api/specifications/types/${editingSpec.id}/values/${encodeURIComponent(rv.value)}/toggle-group`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ product_group: selectedProductGroup, action: 'remove' })
              });
            } catch (e) {
              console.warn(`Failed to toggle-group for spec value ${rv.value}`, e);
            }
          }
          const groupName = categoryGroups.find(g => g.slug === selectedProductGroup)?.name || selectedProductGroup;
          toast.info(`${removedValues.length} value(s) hidden from ${groupName} only`);
        }
        
        toast.success(editingSpec ? 'Specification updated' : 'Specification created');
        setShowSpecDialog(false);
        setEditingSpec(null);
        setSpecForm({ name: '', slug: '', description: '', group_slug: 'general', field_name: '', display_order: 0, is_active: true, auto_populate: true, values: [] });
        fetchAllData();
      } else {
        const error = await res.json();
        toast.error(error.detail || 'Failed to save');
      }
    } catch (e) {
      toast.error('Failed to save specification');
    }
  };

  const handleDeleteSpec = async (specId) => {
    if (selectedProductGroup && selectedProductGroup !== 'all') {
      // GROUP-SCOPED: Hide spec from this group only
      const groupName = categoryGroups.find(g => g.slug === selectedProductGroup)?.name || selectedProductGroup;
      if (!window.confirm(`Hide this specification from ${groupName}? It will remain in other groups.`)) return;
      try {
        const res = await fetch(`${API_URL}/api/specifications/types/${specId}/toggle-type-visibility`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_group: selectedProductGroup, action: 'hide' })
        });
        if (res.ok) {
          toast.success(`Specification hidden from ${groupName}`);
        } else {
          const err = await res.json();
          toast.error(err.detail || 'Failed to hide specification');
        }
        fetchAllData();
      } catch (e) {
        toast.error('Failed to hide specification');
      }
    } else {
      // ALL GROUPS: Global delete
      if (!window.confirm('You are working on ALL groups. This will PERMANENTLY DELETE this specification from every group. Continue?')) return;
      try {
        await fetch(`${API_URL}/api/specifications/types/${specId}`, { method: 'DELETE' });
        toast.success('Specification permanently deleted from all groups');
        fetchAllData();
      } catch (e) {
        toast.error('Failed to delete');
      }
    }
  };

  const handleSaveSpecGroup = async () => {
    try {
      const url = editingSpecGroup 
        ? `${API_URL}/api/specifications/groups/${editingSpecGroup.id}`
        : `${API_URL}/api/specifications/groups`;
      const method = editingSpecGroup ? 'PUT' : 'POST';
      
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(specGroupForm)
      });
      
      if (res.ok) {
        toast.success(editingSpecGroup ? 'Group updated' : 'Group created');
        setShowSpecGroupDialog(false);
        setEditingSpecGroup(null);
        setSpecGroupForm({ name: '', slug: '', description: '', icon: 'Layers', color: '#6b7280', display_order: 0, is_active: true });
        fetchAllData();
      } else {
        const error = await res.json();
        toast.error(error.detail || 'Failed to save');
      }
    } catch (e) {
      toast.error('Failed to save group');
    }
  };

  const handleDeleteSpecGroup = async (groupId) => {
    if (!window.confirm('Delete this specification group? (Specifications will be moved to General)')) return;
    try {
      await fetch(`${API_URL}/api/specifications/groups/${groupId}`, { method: 'DELETE' });
      toast.success('Group deleted');
      fetchAllData();
    } catch (e) {
      toast.error('Failed to delete');
    }
  };

  const handleAddSpecValue = async (specId) => {
    if (!newSpecValue.trim()) return;
    try {
      const res = await fetch(`${API_URL}/api/specifications/types/${specId}/values`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: newSpecValue.trim(), label: newSpecValue.trim() })
      });
      if (res.ok) {
        toast.success('Value added');
        setNewSpecValue('');
        fetchAllData();
      } else {
        const error = await res.json();
        toast.error(error.detail || 'Failed to add value');
      }
    } catch (e) {
      toast.error('Failed to add value');
    }
  };

  const handleRemoveSpecValue = async (specId, value) => {
    try {
      if (selectedProductGroup && selectedProductGroup !== 'all') {
        // Group-scoped removal: only hide value from this product group
        const res = await fetch(`${API_URL}/api/specifications/types/${specId}/values/${encodeURIComponent(value)}/toggle-group`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_group: selectedProductGroup, action: 'remove' })
        });
        if (res.ok) {
          toast.success(`Value hidden from ${categoryGroups.find(g => g.slug === selectedProductGroup)?.name || selectedProductGroup}`);
        } else {
          const error = await res.json();
          toast.error(error.detail || 'Failed to remove value');
        }
      } else {
        // Global removal: delete value entirely (only when "All Groups" is selected)
        if (!window.confirm('You are working on ALL groups. This will permanently delete this value from every group. Continue?')) return;
        await fetch(`${API_URL}/api/specifications/types/${specId}/values/${encodeURIComponent(value)}`, { method: 'DELETE' });
        toast.success('Value permanently removed from all groups');
      }
      fetchAllData();
    } catch (e) {
      toast.error('Failed to remove value');
    }
  };

  const generateSlug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  const toggleGroup = (slug) => {
    setExpandedGroups(prev => ({ ...prev, [slug]: !prev[slug] }));
  };

  const iconOptions = [
    { value: 'Grid3X3', label: 'Grid (Tiles)' },
    { value: 'Flame', label: 'Flame (Heating)' },
    { value: 'Package', label: 'Package (Materials)' },
    { value: 'Wrench', label: 'Wrench (Tools)' },
    { value: 'Puzzle', label: 'Puzzle (Accessories)' },
    { value: 'FolderOpen', label: 'Folder' },
    { value: 'Layers', label: 'Layers' },
  ];

  const filterInputTypes = [
    { value: 'checkbox', label: 'Checkboxes', icon: CheckSquare },
    { value: 'dropdown', label: 'Dropdown', icon: ChevronDown },
    { value: 'range', label: 'Range Slider', icon: Sliders },
    { value: 'toggle', label: 'Toggle', icon: ToggleLeft }
  ];

  // Hero Slides handlers
  const handleSaveHeroSlide = async () => {
    try {
      const token = localStorage.getItem('token');
      const method = editingHeroSlide ? 'PUT' : 'POST';
      const url = editingHeroSlide 
        ? `${API_URL}/api/website-admin/hero-slides/${editingHeroSlide.id}`
        : `${API_URL}/api/website-admin/hero-slides`;
      
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(heroSlideForm)
      });
      
      if (res.ok) {
        toast.success(editingHeroSlide ? 'Hero slide updated!' : 'Hero slide created!');
        setShowHeroSlideDialog(false);
        setEditingHeroSlide(null);
        setHeroSlideForm({ image: '', badge: '', title: '', subtitle: '', cta: 'Shop Now', link: '/tiles', display_order: 0, is_active: true });
        fetchAllData();
      } else {
        toast.error('Failed to save hero slide');
      }
    } catch (e) {
      toast.error('Failed to save hero slide');
    }
  };

  const handleDeleteHeroSlide = async (slideId) => {
    if (!window.confirm('Delete this hero slide?')) return;
    try {
      const token = localStorage.getItem('token');
      await fetch(`${API_URL}/api/website-admin/hero-slides/${slideId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      toast.success('Hero slide deleted');
      fetchAllData();
    } catch (e) {
      toast.error('Failed to delete hero slide');
    }
  };

  // Benefits Bar handlers
  const handleSaveBenefit = async () => {
    try {
      const token = localStorage.getItem('token');
      const method = editingBenefit ? 'PUT' : 'POST';
      const url = editingBenefit 
        ? `${API_URL}/api/website-admin/benefits-bar/${editingBenefit.id}`
        : `${API_URL}/api/website-admin/benefits-bar`;
      
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(benefitForm)
      });
      
      if (res.ok) {
        toast.success(editingBenefit ? 'Benefit updated!' : 'Benefit created!');
        setShowBenefitDialog(false);
        setEditingBenefit(null);
        setBenefitForm({ text: '', link: '/shop', display_order: 0, is_active: true });
        fetchAllData();
      } else {
        toast.error('Failed to save benefit');
      }
    } catch (e) {
      toast.error('Failed to save benefit');
    }
  };

  const handleDeleteBenefit = async (benefitId) => {
    if (!window.confirm('Delete this benefit?')) return;
    try {
      const token = localStorage.getItem('token');
      await fetch(`${API_URL}/api/website-admin/benefits-bar/${benefitId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      toast.success('Benefit deleted');
      fetchAllData();
    } catch (e) {
      toast.error('Failed to delete benefit');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Settings className="w-6 h-6" />
            Navigation & Structure
          </h1>
          <p className="text-gray-500 text-sm">Manage menus, categories, and filters in one place</p>
        </div>
        <Button variant="outline" onClick={fetchAllData}>
          <RefreshCw className="w-4 h-4 mr-2" />
          Refresh
        </Button>
      </div>

      {/* Moved-into-Managers notice — this page keeps working during the transition */}
      <div className="mb-6 p-4 rounded-xl bg-emerald-50 border border-emerald-200" data-testid="nav-structure-moved-notice">
        <p className="text-sm font-semibold text-emerald-900 mb-1">📦 This page has moved into Managers</p>
        <p className="text-[13px] text-emerald-800 mb-2">
          Everything here is now editable from one place — the <b>Managers workspace</b>. This old page still works while you switch over.
        </p>
        <div className="flex flex-wrap gap-2 text-xs">
          <Link to="/admin/website-structure" className="px-3 py-1.5 rounded-full bg-emerald-600 text-white font-medium hover:bg-emerald-700" data-testid="moved-link-website">
            🌐 Website tab — Main Menu · Labels · Default Banner
          </Link>
          <Link to="/admin/tiles" className="px-3 py-1.5 rounded-full bg-white border border-emerald-300 text-emerald-700 font-medium hover:bg-emerald-100" data-testid="moved-link-managers">
            Each Manager → Storefront button — Shop Tabs · Page Banner
          </Link>
          <span className="px-3 py-1.5 text-emerald-600">Categories, Filters &amp; Specs were already in Managers (Configure button)</span>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="mb-6 flex flex-wrap gap-1">
          <TabsTrigger value="navigation" className="flex items-center gap-2">
            <Menu className="w-4 h-4" />
            Navigation
          </TabsTrigger>
          <TabsTrigger value="shop-tabs" className="flex items-center gap-2">
            <Grid3X3 className="w-4 h-4" />
            Shop Tabs
          </TabsTrigger>
          <TabsTrigger value="categories" className="flex items-center gap-2">
            <Layers className="w-4 h-4" />
            Categories
          </TabsTrigger>
          <TabsTrigger value="filters" className="flex items-center gap-2">
            <Filter className="w-4 h-4" />
            Filters
          </TabsTrigger>
          <TabsTrigger value="labels" className="flex items-center gap-2">
            <Tag className="w-4 h-4" />
            Labels
          </TabsTrigger>
          <TabsTrigger value="specifications" className="flex items-center gap-2">
            <Sliders className="w-4 h-4" />
            Specifications
          </TabsTrigger>
          <TabsTrigger value="page-banners" className="flex items-center gap-2">
            <ImageIcon className="w-4 h-4" />
            Page Banners
          </TabsTrigger>
        </TabsList>

        {/* Main Navigation Tab */}
        <TabsContent value="navigation">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between py-4">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Menu className="w-5 h-5" />
                  Main Navigation
                </CardTitle>
                <p className="text-sm text-gray-500">Top menu bar links visible on all pages</p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => addNavItem('main')}>
                  <Plus className="w-4 h-4 mr-1" />
                  Add Link
                </Button>
                <Button size="sm" onClick={() => handleSaveNav('main')}>
                  <Save className="w-4 h-4 mr-1" />
                  Save
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {mainNavItems.map((item, index) => (
                  <div key={item.id || index} className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg">
                    <div className="flex flex-col">
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-6 w-6 p-0"
                        onClick={() => reorderNavItem('main', index, 'up')}
                        disabled={index === 0}
                      >
                        <ArrowUp className="w-3 h-3" />
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-6 w-6 p-0"
                        onClick={() => reorderNavItem('main', index, 'down')}
                        disabled={index === mainNavItems.length - 1}
                      >
                        <ArrowDown className="w-3 h-3" />
                      </Button>
                    </div>
                    <Input 
                      value={item.label} 
                      onChange={(e) => updateNavItem('main', index, 'label', e.target.value)}
                      className="w-32"
                      placeholder="Label"
                    />
                    <Select
                      value=""
                      onValueChange={(slug) => {
                        const cat = categories.find(c => c.slug === slug);
                        if (cat) {
                          updateNavItem('main', index, 'label', cat.name.toUpperCase());
                          updateNavItem('main', index, 'url', `/tiles?category=${slug}`);
                        }
                      }}
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue placeholder="Pick category..." />
                      </SelectTrigger>
                      <SelectContent>
                        {categories.map(cat => (
                          <SelectItem key={cat.slug} value={cat.slug}>{cat.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input 
                      value={item.url || item.link_url || ''} 
                      onChange={(e) => updateNavItem('main', index, 'url', e.target.value)}
                      className="flex-1"
                      placeholder="/tiles?category=floor-tiles"
                    />
                    <Switch 
                      checked={item.is_active !== false}
                      onCheckedChange={(checked) => updateNavItem('main', index, 'is_active', checked)}
                    />
                    <Button variant="ghost" size="sm" onClick={() => removeNavItem('main', index)}>
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </div>
                ))}
                {mainNavItems.length === 0 && (
                  <p className="text-center text-gray-400 py-8">No navigation items. Click "Add Link" to create one.</p>
                )}
              </div>

              {/* Quick Add from Categories */}
              <div className="mt-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
                <p className="text-sm font-medium text-blue-800 mb-2">Quick Add Common Links:</p>
                <div className="flex flex-wrap gap-2 mb-3">
                  {[
                    { label: 'ALL TILES', url: '/tiles' },
                    { label: 'NEW COLLECTION', url: '/tiles?collection=new' },
                    { label: 'SALE', url: '/tiles?sale=true', highlight: true },
                    { label: 'POLISHED', url: '/tiles?finish=polished' },
                    { label: 'MATT', url: '/tiles?finish=matt' },
                    { label: 'OUTDOOR', url: '/tiles?usage=outdoor' },
                    { label: 'INSPIRATION & ADVICE', url: '/inspiration' },
                  ].filter(item => !mainNavItems.find(t => t.label === item.label)).map(item => (
                    <Button
                      key={item.label}
                      variant="outline"
                      size="sm"
                      className={`text-xs ${item.highlight ? 'border-red-300 text-red-700 hover:bg-red-50' : 'border-green-300 text-green-700 hover:bg-green-50'}`}
                      onClick={() => {
                        const newItem = {
                          id: Date.now().toString(),
                          label: item.label,
                          url: item.url,
                          link_url: item.url,
                          display_order: mainNavItems.length,
                          is_active: true,
                          highlight: item.highlight || false
                        };
                        setMainNavItems([...mainNavItems, newItem]);
                      }}
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      {item.label}
                    </Button>
                  ))}
                </div>
                <p className="text-sm font-medium text-blue-800 mb-2">Quick Add Groups:</p>
                <div className="flex flex-wrap gap-2 mb-3">
                  {categoryGroups.filter(g => !mainNavItems.find(t => t.url?.includes(`group=${g.slug}`) || t.link_url?.includes(`group=${g.slug}`))).map(group => {
                    const IconComponent = GroupIcons[group.icon] || FolderOpen;
                    return (
                      <Button
                        key={group.slug}
                        variant="outline"
                        size="sm"
                        className="text-xs border-purple-300 text-purple-700 hover:bg-purple-50"
                        onClick={() => {
                          const newItem = {
                            id: Date.now().toString(),
                            label: group.name.toUpperCase(),
                            url: `/tiles?group=${group.slug}`,
                            link_url: `/tiles?group=${group.slug}`,
                            display_order: mainNavItems.length,
                            is_active: true
                          };
                          setMainNavItems([...mainNavItems, newItem]);
                        }}
                      >
                        <IconComponent className="w-3 h-3 mr-1" style={{ color: group.color || '#7c3aed' }} />
                        {group.name}
                      </Button>
                    );
                  })}
                  {categoryGroups.length === 0 && (
                    <span className="text-xs text-purple-500">No groups available. Create groups in the Categories tab.</span>
                  )}
                </div>
                <p className="text-sm font-medium text-blue-800 mb-2">Quick Add Categories:</p>
                <div className="flex flex-wrap gap-2">
                  {categories.filter(c => c.is_active && !mainNavItems.find(t => t.url?.includes(c.slug) || t.link_url?.includes(c.slug))).slice(0, 10).map(cat => (
                    <Button
                      key={cat.slug}
                      variant="outline"
                      size="sm"
                      className="text-xs border-blue-300 text-blue-700 hover:bg-blue-100"
                      onClick={() => {
                        const newItem = {
                          id: Date.now().toString(),
                          label: cat.name.toUpperCase(),
                          url: `/tiles?category=${cat.slug}`,
                          link_url: `/tiles?category=${cat.slug}`,
                          display_order: mainNavItems.length,
                          is_active: true
                        };
                        setMainNavItems([...mainNavItems, newItem]);
                      }}
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      {cat.name}
                    </Button>
                  ))}
                </div>
              </div>

              {/* Preview */}
              <div className="mt-6 p-4 bg-gray-900 rounded-lg">
                <p className="text-xs text-gray-400 mb-2">Preview - Main Navigation Bar:</p>
                <div className="flex items-center gap-6 overflow-x-auto">
                  {mainNavItems.filter(t => t.is_active !== false).map((item, i) => (
                    <span 
                      key={i} 
                      className={`text-white text-sm whitespace-nowrap hover:text-gray-300 cursor-pointer transition-colors ${item.highlight ? 'text-red-400 font-semibold' : ''}`}
                    >
                      {item.label?.toUpperCase() || 'LINK'}
                    </span>
                  ))}
                  {mainNavItems.filter(t => t.is_active !== false).length === 0 && (
                    <span className="text-gray-500 text-sm">No navigation items to preview</span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="shop-tabs">
          {/* Product Group Context Selector */}
          <Card className="mb-4 bg-gradient-to-r from-slate-50 to-orange-50 border-orange-200">
            <div className="p-4 flex items-center gap-4">
              <div className="flex items-center gap-2">
                <FolderOpen className="w-5 h-5 text-orange-600" />
                <span className="font-medium text-gray-700">Working on:</span>
              </div>
              <Select value={selectedProductGroup} onValueChange={setSelectedProductGroup}>
                <SelectTrigger className="w-56 bg-white">
                  <SelectValue placeholder="Select product group..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    <div className="flex items-center gap-2">
                      <Layers className="w-4 h-4" />
                      <span>All Groups</span>
                    </div>
                  </SelectItem>
                  {categoryGroups.map(group => {
                    const IconComponent = GroupIcons[group.icon] || FolderOpen;
                    return (
                      <SelectItem key={group.slug} value={group.slug}>
                        <div className="flex items-center gap-2">
                          <IconComponent className="w-4 h-4" style={{ color: group.color || '#6b7280' }} />
                          <span>{group.name}</span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {selectedProductGroup !== 'all' && (
                <Badge className="bg-orange-100 text-orange-700 border-orange-300">
                  Showing categories for: {categoryGroups.find(g => g.slug === selectedProductGroup)?.name || selectedProductGroup}
                </Badge>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between py-4">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Grid3X3 className="w-5 h-5" />
                  Shop Page Tabs
                  {selectedProductGroup !== 'all' && selectedProductGroup !== 'tiles' && (
                    <Badge variant="outline" className="ml-2 text-orange-600 border-orange-300">
                      {categoryGroups.find(g => g.slug === selectedProductGroup)?.name || selectedProductGroup}
                    </Badge>
                  )}
                </CardTitle>
                <p className="text-sm text-gray-500">
                  {selectedProductGroup === 'all' || selectedProductGroup === 'tiles'
                    ? 'Navigation tabs on the main collections page'
                    : `Navigation tabs for the ${categoryGroups.find(g => g.slug === selectedProductGroup)?.name || selectedProductGroup} page — independent from All Tiles`}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => addNavItem('shop')}>
                  <Plus className="w-4 h-4 mr-1" />
                  Add Tab
                </Button>
                <Button size="sm" onClick={() => handleSaveNav('shop')}>
                  <Save className="w-4 h-4 mr-1" />
                  Save
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {loadingShopTabs ? (
                <div className="text-center py-8">
                  <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-gray-400 mx-auto mb-2" />
                  <p className="text-sm text-gray-400">Loading tabs...</p>
                </div>
              ) : (
              <div className="space-y-2">
                {shopTabs.map((item, index) => (
                  <div key={item.id || index} className="flex items-center gap-2 p-3 bg-gray-50 rounded-lg">
                    <div className="flex flex-col">
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-6 w-6 p-0"
                        onClick={() => reorderNavItem('shop', index, 'up')}
                        disabled={index === 0}
                      >
                        <ArrowUp className="w-3 h-3" />
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-6 w-6 p-0"
                        onClick={() => reorderNavItem('shop', index, 'down')}
                        disabled={index === shopTabs.length - 1}
                      >
                        <ArrowDown className="w-3 h-3" />
                      </Button>
                    </div>
                    <Input 
                      value={item.label} 
                      onChange={(e) => updateNavItem('shop', index, 'label', e.target.value)}
                      className="w-32"
                      placeholder="Tab Label"
                    />
                    <Select
                      value=""
                      onValueChange={(slug) => {
                        const cat = categories.find(c => c.slug === slug);
                        if (cat) {
                          updateNavItem('shop', index, 'label', cat.name.toUpperCase());
                          updateNavItem('shop', index, 'url', `/tiles?category=${slug}`);
                        }
                      }}
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue placeholder="Pick category..." />
                      </SelectTrigger>
                      <SelectContent>
                        {categories
                          .filter(cat => {
                            // Filter by selected product group
                            if (selectedProductGroup === 'all') return true;
                            return cat.group_slug === selectedProductGroup;
                          })
                          .map(cat => (
                            <SelectItem key={cat.slug} value={cat.slug}>{cat.name}</SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <Input 
                      value={item.url || item.link_url || item.filter_value || ''} 
                      onChange={(e) => updateNavItem('shop', index, 'url', e.target.value)}
                      className="flex-1"
                      placeholder="/tiles?category=floor-tiles"
                    />
                    <Switch 
                      checked={item.is_active !== false}
                      onCheckedChange={(checked) => updateNavItem('shop', index, 'is_active', checked)}
                    />
                    <Button variant="ghost" size="sm" onClick={() => removeNavItem('shop', index)}>
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </div>
                ))}
                {shopTabs.length === 0 && (
                  <div className="text-center py-8">
                    <p className="text-gray-400 mb-3">No shop tabs configured for this group.</p>
                    {selectedProductGroup !== 'all' && selectedProductGroup !== 'tiles' && shopTabsByGroup['shop']?.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-orange-300 text-orange-700 hover:bg-orange-50"
                        onClick={() => {
                          const copied = shopTabsByGroup['shop'].map(tab => ({
                            ...tab,
                            id: Date.now().toString() + Math.random().toString(36).slice(2, 6)
                          }));
                          setShopTabs(copied);
                          toast.info('Copied tabs from All Tiles. Make your changes and click Save.');
                        }}
                      >
                        Copy tabs from All Tiles as starting point
                      </Button>
                    )}
                    {(selectedProductGroup === 'all' || selectedProductGroup === 'tiles') && (
                      <p className="text-gray-400">Click "Add Tab" or use Quick Add below to create tabs.</p>
                    )}
                  </div>
                )}
              </div>
              )}

              {/* Quick Add from Categories */}
              <div className="mt-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
                <p className="text-sm font-medium text-blue-800 mb-2">Quick Add Common Tabs:</p>
                <div className="flex flex-wrap gap-2 mb-3">
                  {[
                    { label: 'ALL TILES', url: '/tiles' },
                    { label: 'POLISHED', url: '/tiles?finish=polished' },
                    { label: 'MATT', url: '/tiles?finish=matt' },
                    { label: 'PORCELAIN', url: '/tiles?material=porcelain' },
                    { label: 'CERAMIC', url: '/tiles?material=ceramic' },
                    { label: 'SALE', url: '/tiles?sale=true', highlight: true },
                  ].filter(item => !shopTabs.find(t => t.label === item.label)).map(item => (
                    <Button
                      key={item.label}
                      variant="outline"
                      size="sm"
                      className={`text-xs ${item.highlight ? 'border-red-300 text-red-700 hover:bg-red-50' : 'border-green-300 text-green-700 hover:bg-green-50'}`}
                      onClick={() => {
                        const newTab = {
                          id: Date.now().toString(),
                          label: item.label,
                          url: item.url,
                          link_url: item.url,
                          display_order: shopTabs.length,
                          is_active: true,
                          highlight: item.highlight || false
                        };
                        setShopTabs([...shopTabs, newTab]);
                      }}
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      {item.label}
                    </Button>
                  ))}
                </div>
                <p className="text-sm font-medium text-blue-800 mb-2">Quick Add Groups as Tabs:</p>
                <div className="flex flex-wrap gap-2 mb-3">
                  {categoryGroups.filter(g => !shopTabs.find(t => t.url?.includes(`group=${g.slug}`) || t.link_url?.includes(`group=${g.slug}`))).map(group => {
                    const IconComponent = GroupIcons[group.icon] || FolderOpen;
                    return (
                      <Button
                        key={group.slug}
                        variant="outline"
                        size="sm"
                        className="text-xs border-purple-300 text-purple-700 hover:bg-purple-50"
                        onClick={() => {
                          const newTab = {
                            id: Date.now().toString(),
                            label: group.name.toUpperCase(),
                            url: `/tiles?group=${group.slug}`,
                            link_url: `/tiles?group=${group.slug}`,
                            display_order: shopTabs.length,
                            is_active: true
                          };
                          setShopTabs([...shopTabs, newTab]);
                        }}
                      >
                        <IconComponent className="w-3 h-3 mr-1" style={{ color: group.color || '#7c3aed' }} />
                        {group.name}
                      </Button>
                    );
                  })}
                  {categoryGroups.length === 0 && (
                    <span className="text-xs text-purple-500">No groups available</span>
                  )}
                </div>
                <p className="text-sm font-medium text-blue-800 mb-2">Quick Add Categories as Tabs:</p>
                <div className="flex flex-wrap gap-2">
                  {categories
                    .filter(c => c.is_active && !shopTabs.find(t => t.url?.includes(c.slug) || t.link_url?.includes(c.slug)))
                    .filter(c => selectedProductGroup === 'all' || c.group_slug === selectedProductGroup)
                    .slice(0, 10)
                    .map(cat => (
                    <Button
                      key={cat.slug}
                      variant="outline"
                      size="sm"
                      className="text-xs border-blue-300 text-blue-700 hover:bg-blue-100"
                      onClick={() => {
                        const newTab = {
                          id: Date.now().toString(),
                          label: cat.name.toUpperCase(),
                          url: `/tiles?category=${cat.slug}`,
                          link_url: `/tiles?category=${cat.slug}`,
                          display_order: shopTabs.length,
                          is_active: true
                        };
                        setShopTabs([...shopTabs, newTab]);
                      }}
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      {cat.name}
                    </Button>
                  ))}
                  {categories.filter(c => c.is_active).length === 0 && (
                    <span className="text-sm text-blue-600">No active categories available</span>
                  )}
                </div>
              </div>
              
              {/* Preview */}
              <div className="mt-6 p-4 bg-gray-900 rounded-lg">
                <p className="text-xs text-gray-400 mb-2">Preview:</p>
                <div className="flex flex-wrap gap-2">
                  {shopTabs.filter(t => t.is_active !== false).map((tab, i) => (
                    <span key={i} className="px-4 py-2 text-white text-sm rounded hover:bg-gray-800 cursor-pointer transition-colors">
                      {tab.label?.toUpperCase() || 'TAB'}
                    </span>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Categories Tab */}
        <TabsContent value="categories">
          {/* Product Group Context Selector */}
          <Card className="mb-4 bg-gradient-to-r from-slate-50 to-green-50 border-green-200">
            <div className="p-4 flex items-center gap-4">
              <div className="flex items-center gap-2">
                <FolderOpen className="w-5 h-5 text-green-600" />
                <span className="font-medium text-gray-700">Working on:</span>
              </div>
              <Select value={selectedProductGroup} onValueChange={setSelectedProductGroup}>
                <SelectTrigger className="w-56 bg-white">
                  <SelectValue placeholder="Select product group..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    <div className="flex items-center gap-2">
                      <Layers className="w-4 h-4" />
                      <span>All Groups</span>
                    </div>
                  </SelectItem>
                  {categoryGroups.map(group => {
                    const IconComponent = GroupIcons[group.icon] || FolderOpen;
                    return (
                      <SelectItem key={group.slug} value={group.slug}>
                        <div className="flex items-center gap-2">
                          <IconComponent className="w-4 h-4" style={{ color: group.color || '#6b7280' }} />
                          <span>{group.name}</span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {selectedProductGroup !== 'all' && (
                <Badge className="bg-green-100 text-green-700 border-green-300">
                  Showing categories for: {categoryGroups.find(g => g.slug === selectedProductGroup)?.name || selectedProductGroup}
                </Badge>
              )}
            </div>
          </Card>

          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">
                {selectedProductGroup === 'all' 
                  ? `${categoryGroups.length} Groups` 
                  : '1 Group'
                }
              </Badge>
              <Badge variant="secondary">
                {selectedProductGroup === 'all' 
                  ? `${categories.length} Categories`
                  : `${categoriesByGroup.find(g => g.slug === selectedProductGroup)?.categories?.length || 0} Categories`
                }
              </Badge>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleSyncCategories} title="Sync categories from Supplier Products">
                <RefreshCw className="w-4 h-4 mr-1" />
                Sync from Products
              </Button>
              <Button variant="outline" size="sm" onClick={() => {
                setGroupForm({ name: '', slug: '', description: '', icon: 'FolderOpen', color: '#3B82F6', display_order: 0, is_active: true });
                setEditingGroup(null);
                setShowGroupDialog(true);
              }}>
                <Plus className="w-4 h-4 mr-1" />
                Add Group
              </Button>
              <Button size="sm" onClick={() => {
                // Auto-set group if a specific group is selected
                const defaultGroup = selectedProductGroup !== 'all' ? selectedProductGroup : 'tiles';
                setCategoryForm({ name: '', slug: '', description: '', group_slug: defaultGroup, image_url: '', display_order: 0, is_active: true, show_on_homepage: false });
                setEditingCategory(null);
                setShowCategoryDialog(true);
              }}>
                <Plus className="w-4 h-4 mr-1" />
                Add Category
              </Button>
            </div>
          </div>

          <div className="space-y-4">
            {categoriesByGroup
              .filter(group => selectedProductGroup === 'all' || group.slug === selectedProductGroup)
              .map((group) => {
              const IconComponent = GroupIcons[group.icon] || FolderOpen;
              const isExpanded = expandedGroups[group.slug];
              
              return (
                <Card key={group.id || group.slug}>
                  <div 
                    className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-50"
                    onClick={() => toggleGroup(group.slug)}
                  >
                    <div className="flex items-center gap-3">
                      {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                      <div className="p-2 rounded-lg" style={{ backgroundColor: `${group.color || '#6b7280'}20` }}>
                        <IconComponent className="w-5 h-5" style={{ color: group.color || '#6b7280' }} />
                      </div>
                      <div>
                        <h3 className="font-semibold">{group.name}</h3>
                        <p className="text-sm text-gray-500">{group.categories?.length || 0} categories</p>
                      </div>
                    </div>
                    
                    {group.id !== 'ungrouped' && (
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => handleReorderGroup(group.id || group.slug, 'up')}
                          disabled={categoriesByGroup.findIndex(g => (g.id || g.slug) === (group.id || group.slug)) === 0}
                          className="h-8 w-8 p-0"
                          title="Move up"
                        >
                          <ArrowUp className="w-4 h-4" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          onClick={() => handleReorderGroup(group.id || group.slug, 'down')}
                          disabled={categoriesByGroup.findIndex(g => (g.id || g.slug) === (group.id || group.slug)) === categoriesByGroup.length - 1}
                          className="h-8 w-8 p-0"
                          title="Move down"
                        >
                          <ArrowDown className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => {
                          setEditingGroup(group);
                          setGroupForm({ name: group.name, slug: group.slug, description: group.description || '', icon: group.icon || 'FolderOpen', color: group.color || '#3B82F6', display_order: group.display_order || 0, is_active: group.is_active !== false });
                          setShowGroupDialog(true);
                        }}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteGroup(group.id)}>
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      </div>
                    )}
                  </div>
                  
                  {isExpanded && (
                    <CardContent className="pt-0 pb-4">
                      {group.categories?.length > 0 ? (
                        <div className="space-y-2 ml-8">
                          {group.categories.map((cat) => (
                            <div key={cat.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                              <div className="flex items-center gap-3">
                                <span className="font-medium">{cat.name}</span>
                                {cat.is_active && <Badge variant="outline" className="text-xs">Active</Badge>}
                                {cat.show_on_homepage && <Badge className="text-xs">Homepage</Badge>}
                                <span className="text-xs text-gray-400">{cat.product_count || 0} products</span>
                              </div>
                              <div className="flex items-center gap-2">
                                <Select value={cat.group_slug || ''} onValueChange={(v) => handleMoveToGroup(cat.id, v)}>
                                  <SelectTrigger className="w-28 h-8 text-xs">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {categoryGroups.map(g => (
                                      <SelectItem key={g.slug} value={g.slug} className="text-xs">{g.name}</SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <Button variant="ghost" size="sm" onClick={() => {
                                  setEditingCategory(cat);
                                  setCategoryForm({ name: cat.name, slug: cat.slug, description: cat.description || '', group_slug: cat.group_slug || 'tiles', image_url: cat.image_url || '', display_order: cat.display_order || 0, is_active: cat.is_active !== false, show_on_homepage: cat.show_on_homepage || false });
                                  setShowCategoryDialog(true);
                                }}>
                                  <Edit2 className="w-4 h-4" />
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => handleDeleteCategory(cat.id)}>
                                  <Trash2 className="w-4 h-4 text-red-500" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-gray-400 text-sm ml-8">No categories</p>
                      )}
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>

          {/* Preview */}
          <div className="mt-6 p-4 bg-gray-100 rounded-lg border">
            <p className="text-xs text-gray-500 mb-3 font-medium">Preview - Homepage Category Cards:</p>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
              {categories.filter(c => c.is_active && c.show_on_homepage).slice(0, 6).map((cat, i) => (
                <div key={i} className="bg-white rounded-lg p-3 shadow-sm border text-center">
                  <div className="w-10 h-10 bg-gray-200 rounded mx-auto mb-2"></div>
                  <span className="text-xs font-medium text-gray-700">{cat.name}</span>
                </div>
              ))}
              {categories.filter(c => c.is_active && c.show_on_homepage).length === 0 && (
                <p className="text-gray-400 text-sm col-span-full">No categories marked for homepage</p>
              )}
            </div>
          </div>
        </TabsContent>

        {/* Filters Tab */}
        <TabsContent value="filters">
          {/* Product Group Context Selector */}
          <Card className="mb-4 bg-gradient-to-r from-slate-50 to-blue-50 border-blue-200">
            <div className="p-4 flex items-center gap-4">
              <div className="flex items-center gap-2">
                <FolderOpen className="w-5 h-5 text-blue-600" />
                <span className="font-medium text-gray-700">Working on:</span>
              </div>
              <Select value={selectedProductGroup} onValueChange={setSelectedProductGroup}>
                <SelectTrigger className="w-56 bg-white">
                  <SelectValue placeholder="Select product group..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    <div className="flex items-center gap-2">
                      <Layers className="w-4 h-4" />
                      <span>All Groups</span>
                    </div>
                  </SelectItem>
                  {categoryGroups.map(group => {
                    const IconComponent = GroupIcons[group.icon] || FolderOpen;
                    return (
                      <SelectItem key={group.slug} value={group.slug}>
                        <div className="flex items-center gap-2">
                          <IconComponent className="w-4 h-4" style={{ color: group.color || '#6b7280' }} />
                          <span>{group.name}</span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {selectedProductGroup !== 'all' && (
                <Badge className="bg-blue-100 text-blue-700 border-blue-300">
                  Showing filters for: {categoryGroups.find(g => g.slug === selectedProductGroup)?.name || selectedProductGroup}
                </Badge>
              )}
            </div>
          </Card>

          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center gap-2">
              <Badge variant="secondary">
                {selectedProductGroup === 'all' 
                  ? `${filters.length} Filters` 
                  : `${filters.filter(f => (f.auto_populate_groups || []).includes(selectedProductGroup) || (f.auto_populate_groups || []).length === 0).length} Filters`
                }
              </Badge>
              <Badge variant="secondary">{filterGroups.length} Filter Groups</Badge>
              {/* Filter-Specification Sync Status Indicator */}
              {filterSpecSyncStatus.all_in_sync ? (
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium border border-green-200">
                  <CheckCircle className="w-3.5 h-3.5" />
                  <span>Synced with Specifications</span>
                </div>
              ) : (
                <button
                  onClick={handleSyncFilterWithSpecs}
                  disabled={syncingFilterSpecs}
                  className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-100 text-amber-800 rounded-full text-xs font-medium border border-amber-300 hover:bg-amber-200 transition-colors cursor-pointer"
                  title={`Out of sync: ${filterSpecSyncStatus.shared_attributes?.filter(a => !a.in_sync).map(a => `${a.attribute} (${a.spec_missing_count + a.filter_missing_count} diff)`).join(', ')}`}
                >
                  {syncingFilterSpecs ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5" />
                  )}
                  <span>{syncingFilterSpecs ? 'Syncing...' : 'Sync with Specifications'}</span>
                </button>
              )}
            </div>
            <div className="flex gap-2">
              {filters.length === 0 && (
                <Button variant="outline" size="sm" onClick={handleSeedDefaultFilters}>
                  <Package className="w-4 h-4 mr-1" />
                  Seed Default Filters
                </Button>
              )}
              {filters.length > 0 && (
                <>
                  <Button variant="outline" size="sm" onClick={handleSyncFilterValues} title="Pull new values from products into auto-populate filters">
                    <RefreshCw className="w-4 h-4 mr-1" />
                    Sync from Products
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={handleRebuildFromLive} 
                    className="border-red-300 text-red-700 hover:bg-red-50"
                    title="URGENT: Rebuild ALL filter values from LIVE products only (removes flooring values from tile filters)"
                  >
                    <RefreshCw className="w-4 h-4 mr-1" />
                    Rebuild from Live Only
                  </Button>
                </>
              )}
              {filters.some(f => f.name?.toLowerCase().includes('size')) && (
                <Button variant="outline" size="sm" onClick={handleNormalizeSizes} title="Fix size format inconsistencies and remove duplicates">
                  <Sliders className="w-4 h-4 mr-1" />
                  Normalize Sizes
                </Button>
              )}
              <Button size="sm" onClick={() => {
                // Auto-set group restriction if a specific group is selected
                const autoGroups = selectedProductGroup !== 'all' ? [selectedProductGroup] : [];
                setFilterForm({ 
                  name: '', slug: '', input_type: 'checkbox', description: '', values: [], 
                  is_active: true, auto_populate: false, auto_populate_field: '', 
                  auto_populate_categories: [], auto_populate_groups: autoGroups,
                  // Default visibility flags
                  show_in_bulk_editor: true,
                  show_in_shop_filter: true,
                  show_in_product_detail: true,
                  allow_new_values_in_bulk_editor: false
                });
                setEditingFilter(null);
                setShowFilterDialog(true);
              }}>
                <Plus className="w-4 h-4 mr-1" />
                Add Filter
              </Button>
            </div>
          </div>

          {filters.length === 0 && (
            <Card className="p-8 text-center bg-gray-50">
              <Package className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-700 mb-2">No Filters Yet</h3>
              <p className="text-gray-500 mb-4">Click "Seed Default Filters" to create standard filter options (Color, Finish, Material, Size, etc.)</p>
              <Button onClick={handleSeedDefaultFilters}>
                <Package className="w-4 h-4 mr-2" />
                Seed Default Filters
              </Button>
            </Card>
          )}

          <div className="grid gap-3">
            {filters
              .filter(filter => {
                // When 'all' is selected, show everything
                if (selectedProductGroup === 'all') return true;
                // Show ALL filters (including hidden) so user can toggle visibility
                return true;
              })
              .map((filter) => {
              const TypeIcon = filterInputTypes.find(t => t.value === filter.input_type)?.icon || Filter;
              const hasGroupRestrictions = (filter.auto_populate_groups || []).length > 0;
              const hasCategoryRestrictions = (filter.auto_populate_categories || []).length > 0;
              const noRestrictions = filter.auto_populate && !hasGroupRestrictions && !hasCategoryRestrictions;
              const isHiddenFromGroup = selectedProductGroup !== 'all' && (filter.hidden_groups || []).includes(selectedProductGroup);
              
              return (
                <Card key={filter.id} className={`${noRestrictions ? 'border-yellow-300 bg-yellow-50/30' : ''} ${isHiddenFromGroup ? 'opacity-60 border-dashed' : ''}`}>
                  <div className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-gray-100 rounded-lg">
                        <TypeIcon className="w-5 h-5 text-gray-600" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold">{filter.name}</h3>
                          <Badge variant="outline" className="text-xs">{filter.input_type}</Badge>
                          {filter.auto_populate && <Badge variant="secondary" className="text-xs">Auto</Badge>}
                          {filter.is_active && <Badge className="text-xs bg-green-600">Active</Badge>}
                          {filter.values?.length > 0 && <Badge variant="outline" className="text-xs">
                            {selectedProductGroup !== 'all'
                              ? `${(filter.values || []).filter(v => { const g = v.product_groups || []; return g.length === 0 || g.includes(selectedProductGroup); }).length} values (${filter.values.length} total)`
                              : `${filter.values.length} values`
                            }
                          </Badge>}
                        </div>
                        {/* Show restrictions or warning */}
                        {filter.auto_populate && (
                          <div className="mt-1">
                            {hasGroupRestrictions && (
                              <p className="text-xs text-blue-600">
                                Groups: {filter.auto_populate_groups.join(', ')}
                              </p>
                            )}
                            {hasCategoryRestrictions && (
                              <p className="text-xs text-green-600">
                                Categories: {filter.auto_populate_categories.slice(0, 3).join(', ')}{filter.auto_populate_categories.length > 3 && ` +${filter.auto_populate_categories.length - 3}`}
                              </p>
                            )}
                            {noRestrictions && (
                              <p className="text-xs text-yellow-700 font-medium">
                                ⚠️ No restrictions - pulling from ALL products
                              </p>
                            )}
                          </div>
                        )}
                        {filter.values?.length > 0 && (
                          <p className="text-xs text-gray-500 mt-1">
                            {(filter.values || [])
                              .filter(v => {
                                if (selectedProductGroup === 'all') return true;
                                const g = v.product_groups || [];
                                return g.length === 0 || g.includes(selectedProductGroup);
                              })
                              .slice(0, 5).map(v => v.label || v.value).join(', ')}
                            {(() => {
                              const filtered = (filter.values || []).filter(v => {
                                if (selectedProductGroup === 'all') return true;
                                const g = v.product_groups || [];
                                return g.length === 0 || g.includes(selectedProductGroup);
                              });
                              return filtered.length > 5 ? ` +${filtered.length - 5} more` : '';
                            })()}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {/* Group visibility toggle */}
                      {selectedProductGroup && selectedProductGroup !== 'all' && (
                        <button
                          onClick={() => handleToggleFilterGroupVisibility(filter.id, filter.name, !isHiddenFromGroup)}
                          className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium mr-2 transition-colors ${
                            isHiddenFromGroup
                              ? 'bg-gray-100 text-gray-500 hover:bg-emerald-50 hover:text-emerald-600'
                              : 'bg-emerald-50 text-emerald-700 hover:bg-gray-100 hover:text-gray-500'
                          }`}
                          title={isHiddenFromGroup ? 'Click to show in this group' : 'Click to hide from this group'}
                          data-testid={`toggle-filter-${filter.slug}`}
                        >
                          {isHiddenFromGroup ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                          {isHiddenFromGroup ? 'Hidden' : 'Visible'}
                        </button>
                      )}
                      {filter.auto_populate && filter.values?.length > 0 && (
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="text-orange-600 hover:text-orange-700 hover:bg-orange-50"
                          title="Clear & Re-sync with current restrictions"
                          onClick={() => handleClearAndResync(filter.id, filter.name)}
                        >
                          <RefreshCw className="w-4 h-4" />
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => {
                        setEditingFilter(filter);
                        setFilterForm({
                          name: filter.name, slug: filter.slug, input_type: filter.input_type || 'checkbox',
                          description: filter.description || '', values: filter.values || [],
                          is_active: filter.is_active !== false, auto_populate: filter.auto_populate || false,
                          auto_populate_field: filter.auto_populate_field || '',
                          auto_populate_categories: filter.auto_populate_categories || [],
                          auto_populate_groups: filter.auto_populate_groups || [],
                          // Visibility flags
                          show_in_bulk_editor: filter.show_in_bulk_editor !== false,
                          show_in_shop_filter: filter.show_in_shop_filter !== false,
                          show_in_product_detail: filter.show_in_product_detail !== false,
                          allow_new_values_in_bulk_editor: filter.allow_new_values_in_bulk_editor === true
                        });
                        setShowFilterDialog(true);
                      }}>
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleDeleteFilter(filter.id)}>
                        <Trash2 className="w-4 h-4 text-red-500" />
                      </Button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          {/* Preview */}
          {filters.length > 0 && (
            <div className="mt-6 p-4 bg-gray-100 rounded-lg border">
              <p className="text-xs text-gray-500 mb-3 font-medium">Preview - Shop Filter Sidebar:</p>
              <div className="bg-white rounded-lg p-4 shadow-sm border max-w-xs">
                {filters.filter(f => f.is_active).slice(0, 4).map((filter, i) => (
                  <div key={i} className="mb-4 last:mb-0">
                    <p className="text-sm font-semibold text-gray-800 mb-2">{filter.name}</p>
                    {filter.input_type === 'checkbox' && (
                      <div className="space-y-1">
                        {(filter.values || []).slice(0, 3).map((v, j) => (
                          <div key={j} className="flex items-center gap-2">
                            <div className="w-4 h-4 border rounded"></div>
                            <span className="text-xs text-gray-600">{v.label || v.value}</span>
                          </div>
                        ))}
                        {(filter.values || []).length > 3 && (
                          <span className="text-xs text-gray-400">+{filter.values.length - 3} more</span>
                        )}
                      </div>
                    )}
                    {filter.input_type === 'toggle' && (
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-4 bg-gray-300 rounded-full"></div>
                        <span className="text-xs text-gray-600">Show only in stock</span>
                      </div>
                    )}
                    {filter.input_type === 'range' && (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1 bg-gray-300 rounded"></div>
                        <span className="text-xs text-gray-600">£0 - £200</span>
                      </div>
                    )}
                  </div>
                ))}
                {filters.filter(f => f.is_active).length > 4 && (
                  <p className="text-xs text-gray-400 mt-2">+{filters.filter(f => f.is_active).length - 4} more filters</p>
                )}
              </div>
            </div>
          )}
        </TabsContent>

        {/* Page Banners Tab */}
        <TabsContent value="page-banners">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between py-4">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <ImageIcon className="w-5 h-5" />
                  Page Banners
                </CardTitle>
                <CardDescription>Manage hero banners for category and group pages (e.g., Materials, Tiles, Flooring)</CardDescription>
              </div>
              <Button size="sm" onClick={() => {
                setEditingBanner(null);
                setBannerForm({ title: '', subtitle: '', image: '', overlay: 'rgba(0,0,0,0.3)', category_slug: '', group_slug: '', is_default: false });
                setShowBannerDialog(true);
              }}>
                <Plus className="w-4 h-4 mr-1" />
                Add Banner
              </Button>
            </CardHeader>
            <CardContent>
              {/* Default Banner */}
              {pageBanners.filter(b => b.is_default).map(banner => (
                <div key={banner.id || 'default'} className="mb-6 p-4 border-2 border-dashed border-amber-300 rounded-xl bg-amber-50/50">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs bg-amber-200 text-amber-800 font-semibold px-2 py-0.5 rounded">DEFAULT</span>
                      <span className="font-medium text-gray-700">Fallback banner for pages without a specific banner</span>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => {
                        setEditingBanner(banner);
                        setBannerForm({ title: banner.title || '', subtitle: banner.subtitle || '', image: banner.image || '', overlay: banner.overlay || 'rgba(0,0,0,0.3)', category_slug: '', group_slug: '', is_default: true });
                        setShowBannerDialog(true);
                      }}>
                        <Edit2 className="w-3.5 h-3.5 mr-1" /> Edit
                      </Button>
                    </div>
                  </div>
                  {banner.image && (
                    <div className="h-28 rounded-lg overflow-hidden relative" style={{ backgroundImage: `url(${banner.image})`, backgroundSize: 'cover', backgroundPosition: 'center' }}>
                      <div className="absolute inset-0" style={{ backgroundColor: banner.overlay || 'rgba(0,0,0,0.3)' }} />
                      <div className="absolute inset-0 flex items-center justify-center text-center px-4">
                        <div>
                          <p className="text-white text-lg font-light drop-shadow-lg">{banner.title}</p>
                          {banner.subtitle && <p className="text-white/90 text-sm drop-shadow-md mt-1">{banner.subtitle}</p>}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {/* Category/Group Specific Banners */}
              <div className="space-y-3">
                {pageBanners.filter(b => !b.is_default).length === 0 ? (
                  <p className="text-sm text-gray-400 italic py-4 text-center">No custom banners yet. Click "Add Banner" to create one for a specific category or group page.</p>
                ) : (
                  pageBanners.filter(b => !b.is_default).map(banner => (
                    <div key={banner.id} className="border rounded-xl overflow-hidden">
                      <div className="flex items-center gap-4 p-4">
                        {banner.image ? (
                          <div className="w-32 h-20 rounded-lg overflow-hidden relative flex-shrink-0" style={{ backgroundImage: `url(${banner.image})`, backgroundSize: 'cover', backgroundPosition: 'center' }}>
                            <div className="absolute inset-0" style={{ backgroundColor: banner.overlay || 'rgba(0,0,0,0.3)' }} />
                          </div>
                        ) : (
                          <div className="w-32 h-20 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                            <ImageIcon className="w-6 h-6 text-gray-400" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-gray-900">{banner.title || 'Untitled Banner'}</p>
                          {banner.subtitle && <p className="text-sm text-gray-500 truncate">{banner.subtitle}</p>}
                          <div className="flex gap-2 mt-1">
                            {banner.category_slug && (
                              <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">Category: {banner.category_slug}</span>
                            )}
                            {banner.group_slug && (
                              <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">Group: {banner.group_slug}</span>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-2 flex-shrink-0">
                          <Button variant="outline" size="sm" onClick={() => {
                            setEditingBanner(banner);
                            setBannerForm({ title: banner.title || '', subtitle: banner.subtitle || '', image: banner.image || '', overlay: banner.overlay || 'rgba(0,0,0,0.3)', category_slug: banner.category_slug || '', group_slug: banner.group_slug || '', is_default: false });
                            setShowBannerDialog(true);
                          }}>
                            <Edit2 className="w-3.5 h-3.5" />
                          </Button>
                          <Button variant="outline" size="sm" className="text-red-500 hover:text-red-700 hover:bg-red-50" onClick={() => handleDeleteBanner(banner.id)}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Labels Tab */}
        <TabsContent value="labels">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between py-4">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Tag className="w-5 h-5" />
                  Product Labels & Stamps
                </CardTitle>
                <CardDescription>Manage labels that appear on collection cards (NEW, SALE, etc.)</CardDescription>
              </div>
              <Button size="sm" onClick={() => setShowLabelDialog(true)}>
                <Plus className="w-4 h-4 mr-1" />
                Add Custom Label
              </Button>
            </CardHeader>
            <CardContent>
              {/* Predefined Labels */}
              <div className="mb-6">
                <h3 className="font-medium text-gray-700 mb-3">Predefined Labels</h3>
                <div className="grid gap-2">
                  {availableLabels.predefined?.map((label) => {
                    const colorMap = {
                      emerald: 'bg-emerald-100 text-emerald-800 border-emerald-200',
                      red: 'bg-red-100 text-red-800 border-red-200',
                      amber: 'bg-amber-100 text-amber-800 border-amber-200',
                      purple: 'bg-purple-100 text-purple-800 border-purple-200',
                      blue: 'bg-blue-100 text-blue-800 border-blue-200',
                      orange: 'bg-orange-100 text-orange-800 border-orange-200',
                      green: 'bg-green-100 text-green-800 border-green-200',
                      gray: 'bg-gray-100 text-gray-800 border-gray-200',
                    };
                    return (
                      <div key={label.value} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                        <div className="flex items-center gap-3">
                          <span className={`px-3 py-1 text-xs font-semibold border rounded ${colorMap[label.color] || colorMap.gray}`}>
                            {label.value}
                          </span>
                          <span className="text-sm text-gray-600">{label.description}</span>
                        </div>
                        <Badge variant="outline" className="text-xs">System</Badge>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Custom Labels */}
              <div>
                <h3 className="font-medium text-gray-700 mb-3">Custom Labels</h3>
                {availableLabels.custom?.length > 0 ? (
                  <div className="grid gap-2">
                    {availableLabels.custom.map((label) => (
                      <div key={label.value} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                        <div className="flex items-center gap-3">
                          <span className="px-3 py-1 text-xs font-semibold bg-gray-900 text-white rounded">
                            {label.value}
                          </span>
                          <span className="text-sm text-gray-600">{label.description || label.label}</span>
                        </div>
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteCustomLabel(label.value)}>
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-center text-gray-400 py-4">No custom labels yet. Click "Add Custom Label" to create one.</p>
                )}
              </div>

              {/* How to Use */}
              <div className="mt-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
                <h4 className="font-medium text-blue-800 mb-2">How Labels Work:</h4>
                <ul className="text-sm text-blue-700 space-y-1 list-disc list-inside">
                  <li>Labels are set on individual products in the Supplier Products page</li>
                  <li>Multiple labels can be applied to a single product</li>
                  <li>Labels appear as stamps on collection cards (up to 3 shown)</li>
                  <li>Use <strong>NEW</strong> for newly added products</li>
                  <li>Use <strong>SALE</strong> for products on promotion</li>
                  <li>Custom labels can be created for special campaigns</li>
                </ul>
              </div>

              {/* Preview - Collection Card with Labels */}
              <div className="mt-6">
                <p className="text-xs text-gray-500 mb-3 font-medium">Preview - How Labels Appear on Collection Cards:</p>
                <div className="bg-gray-100 p-6 rounded-lg">
                  <div className="max-w-[280px] mx-auto">
                    {/* Simulated Collection Card */}
                    <div className="bg-white rounded-lg shadow-md overflow-hidden">
                      {/* Image area with stamps */}
                      <div className="relative aspect-[3/4] bg-gradient-to-br from-gray-200 to-gray-300">
                        {/* Stamps in top left */}
                        <div className="absolute top-3 left-3 flex flex-col gap-1.5">
                          <span className="px-2.5 py-1 text-[10px] font-semibold tracking-wider bg-red-600 text-white shadow-md">
                            SALE
                          </span>
                          <span className="px-2.5 py-1 text-[10px] font-semibold tracking-wider bg-emerald-600 text-white shadow-md">
                            NEW
                          </span>
                          {availableLabels.custom?.[0] && (
                            <span className="px-2.5 py-1 text-[10px] font-semibold tracking-wider bg-gray-900 text-white shadow-md">
                              {availableLabels.custom[0].value}
                            </span>
                          )}
                        </div>
                        {/* Color/Size count in bottom right */}
                        <div className="absolute bottom-3 right-3 flex gap-1.5">
                          <span className="px-2 py-1 text-[10px] font-medium bg-white/90 backdrop-blur-sm text-gray-700 shadow-sm">
                            5 COLOURS
                          </span>
                          <span className="px-2 py-1 text-[10px] font-medium bg-white/90 backdrop-blur-sm text-gray-700 shadow-sm">
                            3 SIZES
                          </span>
                        </div>
                        {/* Tile pattern placeholder */}
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="grid grid-cols-2 gap-1 opacity-50">
                            {[...Array(4)].map((_, i) => (
                              <div key={i} className="w-12 h-12 bg-gray-400 rounded-sm"></div>
                            ))}
                          </div>
                        </div>
                      </div>
                      {/* Product info */}
                      <div className="p-4">
                        <h3 className="font-semibold text-gray-900">Dolomite Collection</h3>
                        <p className="text-sm text-gray-500">From £29.99/m²</p>
                        {/* Variant thumbnails */}
                        <div className="flex gap-2 mt-3">
                          {[...Array(3)].map((_, i) => (
                            <div key={i} className="w-10 h-10 bg-gray-200 rounded border border-gray-300"></div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Specifications Tab */}
        <TabsContent value="specifications">
          {/* Product Group Context Selector */}
          <Card className="mb-4 bg-gradient-to-r from-slate-50 to-purple-50 border-purple-200">
            <div className="p-4 flex items-center gap-4">
              <div className="flex items-center gap-2">
                <FolderOpen className="w-5 h-5 text-purple-600" />
                <span className="font-medium text-gray-700">Working on:</span>
              </div>
              <Select value={selectedProductGroup} onValueChange={setSelectedProductGroup}>
                <SelectTrigger className="w-56 bg-white">
                  <SelectValue placeholder="Select product group..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    <div className="flex items-center gap-2">
                      <Layers className="w-4 h-4" />
                      <span>All Groups</span>
                    </div>
                  </SelectItem>
                  {categoryGroups.map(group => {
                    const IconComponent = GroupIcons[group.icon] || FolderOpen;
                    return (
                      <SelectItem key={group.slug} value={group.slug}>
                        <div className="flex items-center gap-2">
                          <IconComponent className="w-4 h-4" style={{ color: group.color || '#6b7280' }} />
                          <span>{group.name}</span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {selectedProductGroup !== 'all' && (
                <Badge className="bg-purple-100 text-purple-700 border-purple-300">
                  Showing specifications for: {categoryGroups.find(g => g.slug === selectedProductGroup)?.name || selectedProductGroup}
                </Badge>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between py-4">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Sliders className="w-5 h-5" />
                  Product Specifications
                  {/* Filter-Specification Sync Status Indicator */}
                  {filterSpecSyncStatus.all_in_sync ? (
                    <div className="flex items-center gap-1.5 px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-xs font-medium border border-green-200 ml-2">
                      <CheckCircle className="w-3.5 h-3.5" />
                      <span>Synced with Filters</span>
                    </div>
                  ) : (
                    <button
                      onClick={handleSyncFilterWithSpecs}
                      disabled={syncingFilterSpecs}
                      className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-100 text-amber-800 rounded-full text-xs font-medium border border-amber-300 hover:bg-amber-200 transition-colors cursor-pointer ml-2"
                      title={`Out of sync: ${filterSpecSyncStatus.shared_attributes?.filter(a => !a.in_sync).map(a => `${a.attribute} (${a.spec_missing_count + a.filter_missing_count} diff)`).join(', ')}`}
                    >
                      {syncingFilterSpecs ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <AlertTriangle className="w-3.5 h-3.5" />
                      )}
                      <span>{syncingFilterSpecs ? 'Syncing...' : 'Sync with Filters'}</span>
                    </button>
                  )}
                </CardTitle>
                <CardDescription>Manage product specifications like Material, Finish, Size, Color</CardDescription>
              </div>
              <div className="flex gap-2">
                {specsByGroup.length === 0 && (
                  <Button variant="outline" size="sm" onClick={handleSeedSpecifications}>
                    <Package className="w-4 h-4 mr-1" />
                    Seed Defaults
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={handleSyncAllSpecs}>
                  <RefreshCw className="w-4 h-4 mr-1" />
                  Sync from Products
                </Button>
                <Button variant="outline" size="sm" onClick={() => {
                  setEditingSpecGroup(null);
                  setSpecGroupForm({ name: '', slug: '', description: '', icon: 'Layers', color: '#6b7280', display_order: 0, is_active: true });
                  setShowSpecGroupDialog(true);
                }}>
                  <Plus className="w-4 h-4 mr-1" />
                  Add Group
                </Button>
                <Button size="sm" onClick={() => {
                  setEditingSpec(null);
                  setSpecForm({ name: '', slug: '', description: '', group_slug: 'general', field_name: '', display_order: 0, is_active: true, auto_populate: true, values: [] });
                  setShowSpecDialog(true);
                }}>
                  <Plus className="w-4 h-4 mr-1" />
                  Add Specification
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {specsByGroup.length === 0 ? (
                <div className="text-center py-12 bg-gray-50 rounded-lg">
                  <Sliders className="w-12 h-12 mx-auto mb-4 text-gray-400" />
                  <h3 className="text-lg font-medium text-gray-700 mb-2">No Specifications Yet</h3>
                  <p className="text-gray-500 mb-4">Click "Seed Defaults" to create standard specifications (Material, Finish, Size, Color)</p>
                  <Button onClick={handleSeedSpecifications}>
                    <Package className="w-4 h-4 mr-2" />
                    Seed Default Specifications
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  {specsByGroup.map((group) => {
                    const isExpanded = expandedSpecGroups[group.slug];
                    return (
                      <Card key={group.id || group.slug}>
                        <div 
                          className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-50"
                          onClick={() => setExpandedSpecGroups(prev => ({ ...prev, [group.slug]: !prev[group.slug] }))}
                        >
                          <div className="flex items-center gap-3">
                            {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                            <div className="p-2 rounded-lg" style={{ backgroundColor: `${group.color || '#6b7280'}20` }}>
                              <Sliders className="w-5 h-5" style={{ color: group.color || '#6b7280' }} />
                            </div>
                            <div>
                              <h3 className="font-semibold">{group.name}</h3>
                              <p className="text-sm text-gray-500">{group.specifications?.length || 0} specifications</p>
                            </div>
                          </div>
                          
                          {group.id !== 'ungrouped' && (
                            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                              <Button variant="ghost" size="sm" onClick={() => {
                                setEditingSpecGroup(group);
                                setSpecGroupForm({ name: group.name, slug: group.slug, description: group.description || '', icon: group.icon || 'Layers', color: group.color || '#6b7280', display_order: group.display_order || 0, is_active: group.is_active !== false });
                                setShowSpecGroupDialog(true);
                              }}>
                                <Edit2 className="w-4 h-4" />
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => handleDeleteSpecGroup(group.id)}>
                                <Trash2 className="w-4 h-4 text-red-500" />
                              </Button>
                            </div>
                          )}
                        </div>
                        
                        {isExpanded && (
                          <CardContent className="pt-0 pb-4">
                            {group.specifications?.length > 0 ? (
                              <div className="space-y-3 ml-8">
                                {group.specifications
                                  .map((spec) => {
                                  const isSpecHiddenFromGroup = selectedProductGroup !== 'all' && (spec.hidden_groups || []).includes(selectedProductGroup);
                                  return (
                                  <div key={spec.id} className={`p-4 bg-gray-50 rounded-lg ${isSpecHiddenFromGroup ? 'opacity-60 border border-dashed border-gray-300' : ''}`}>
                                    <div className="flex items-center justify-between mb-3">
                                      <div className="flex items-center gap-3">
                                        <span className={`font-medium ${isSpecHiddenFromGroup ? 'text-gray-400' : ''}`}>{spec.name}</span>
                                        {spec.is_active && <Badge variant="outline" className="text-xs">Active</Badge>}
                                        {spec.auto_populate && <Badge className="text-xs bg-blue-100 text-blue-700">Auto-sync</Badge>}
                                        <span className="text-xs text-gray-400">Field: {spec.field_name}</span>
                                        <span className="text-xs text-gray-400">
                                          {selectedProductGroup !== 'all' 
                                            ? `${(spec.values || []).filter(v => { const g = v.product_groups || []; return g.length === 0 || g.includes(selectedProductGroup); }).length} values (${spec.values?.length || 0} total)`
                                            : `${spec.values?.length || 0} values`
                                          }
                                        </span>
                                      </div>
                                      <div className="flex items-center gap-2">
                                        {/* Group visibility toggle for specs */}
                                        {selectedProductGroup && selectedProductGroup !== 'all' && (
                                          <button
                                            onClick={() => handleToggleSpecGroupVisibility(spec.id, spec.name, !isSpecHiddenFromGroup)}
                                            className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${
                                              isSpecHiddenFromGroup
                                                ? 'bg-gray-100 text-gray-500 hover:bg-emerald-50 hover:text-emerald-600'
                                                : 'bg-emerald-50 text-emerald-700 hover:bg-gray-100 hover:text-gray-500'
                                            }`}
                                            title={isSpecHiddenFromGroup ? 'Click to show in this group' : 'Click to hide from this group'}
                                            data-testid={`toggle-spec-${spec.slug}`}
                                          >
                                            {isSpecHiddenFromGroup ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                            {isSpecHiddenFromGroup ? 'Hidden' : 'Visible'}
                                          </button>
                                        )}
                                        <Button variant="outline" size="sm" onClick={() => handleSyncSpec(spec.id)} title="Sync values from products">
                                          <RefreshCw className="w-3 h-3" />
                                        </Button>
                                        <Button variant="ghost" size="sm" onClick={() => {
                                          setEditingSpec(spec);
                                          setSpecForm({ 
                                            name: spec.name, 
                                            slug: spec.slug, 
                                            description: spec.description || '', 
                                            group_slug: spec.group_slug || 'general', 
                                            field_name: spec.field_name || '',
                                            display_order: spec.display_order || 0, 
                                            is_active: spec.is_active !== false, 
                                            auto_populate: spec.auto_populate !== false,
                                            values: spec.values || []
                                          });
                                          setShowSpecDialog(true);
                                        }}>
                                          <Edit2 className="w-4 h-4" />
                                        </Button>
                                        <Button variant="ghost" size="sm" onClick={() => handleDeleteSpec(spec.id)}>
                                          <Trash2 className="w-4 h-4 text-red-500" />
                                        </Button>
                                      </div>
                                    </div>
                                    
                                    {/* Values - filtered by selected product group */}
                                    <div className="flex flex-wrap gap-2">
                                      {(spec.values || [])
                                        .filter(val => {
                                          if (selectedProductGroup === 'all') return true;
                                          const groups = val.product_groups || [];
                                          // Empty product_groups means visible in ALL groups
                                          if (groups.length === 0) return true;
                                          return groups.includes(selectedProductGroup);
                                        })
                                        .slice(0, 15).map((val, i) => (
                                        <Badge 
                                          key={i} 
                                          variant="secondary" 
                                          className={`text-xs ${val.is_active === false ? 'opacity-50' : ''}`}
                                        >
                                          {val.label || val.value}
                                          <button 
                                            className="ml-1 hover:text-red-500" 
                                            onClick={() => handleRemoveSpecValue(spec.id, val.value)}
                                          >
                                            <X className="w-3 h-3" />
                                          </button>
                                        </Badge>
                                      ))}
                                      {(() => {
                                        const filteredCount = (spec.values || []).filter(val => {
                                          if (selectedProductGroup === 'all') return true;
                                          const groups = val.product_groups || [];
                                          if (groups.length === 0) return true;
                                          return groups.includes(selectedProductGroup);
                                        }).length;
                                        return filteredCount > 15 ? (
                                          <Badge variant="outline" className="text-xs">+{filteredCount - 15} more</Badge>
                                        ) : null;
                                      })()}
                                    </div>
                                  </div>
                                );
                                })}
                              </div>
                            ) : (
                              <p className="text-gray-400 text-sm ml-8">No specifications in this group</p>
                            )}
                          </CardContent>
                        )}
                      </Card>
                    );
                  })}
                </div>
              )}

              {/* Preview Section */}
              {specsByGroup.length > 0 && (
                <div className="mt-8">
                  <div className="flex items-center gap-2 mb-3">
                    <Eye className="w-4 h-4 text-gray-500" />
                    <p className="text-xs text-gray-500 font-medium">Live Preview - Product Specifications Display</p>
                  </div>
                  <div className="bg-gray-100 p-6 rounded-xl border-2 border-dashed border-gray-300">
                    <h3 className="text-lg font-bold text-gray-900 mb-4">Product Specifications</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      {specsByGroup.flatMap(g => g.specifications || []).filter(s => s.is_active).slice(0, 8).map((spec) => (
                        <div key={spec.id} className="bg-white rounded-lg p-4 shadow-sm">
                          <h4 className="font-semibold text-gray-700 text-sm mb-2">{spec.name}</h4>
                          <div className="flex flex-wrap gap-1">
                            {(spec.values || []).filter(v => v.is_active !== false).slice(0, 4).map((val, i) => (
                              <span key={i} className="text-xs bg-gray-100 px-2 py-1 rounded">
                                {val.label || val.value}
                              </span>
                            ))}
                            {(spec.values?.filter(v => v.is_active !== false).length || 0) > 4 && (
                              <span className="text-xs text-gray-400">+{spec.values.filter(v => v.is_active !== false).length - 4}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                    {specsByGroup.flatMap(g => g.specifications || []).filter(s => s.is_active).length === 0 && (
                      <div className="text-center py-8 text-gray-400">
                        <Sliders className="w-10 h-10 mx-auto mb-2 opacity-30" />
                        <p>Add specifications above to see the preview</p>
                      </div>
                    )}
                  </div>
                  <p className="text-xs text-gray-400 mt-2 text-center">
                    This preview shows how specifications will appear on product detail pages.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Hero Slide Dialog */}
      <Dialog open={showHeroSlideDialog} onOpenChange={setShowHeroSlideDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingHeroSlide ? 'Edit Hero Slide' : 'Add Hero Slide'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Image URL</label>
              <Input 
                value={heroSlideForm.image} 
                onChange={(e) => setHeroSlideForm({...heroSlideForm, image: e.target.value})}
                placeholder="https://images.unsplash.com/..."
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Badge Text</label>
                <Input 
                  value={heroSlideForm.badge} 
                  onChange={(e) => setHeroSlideForm({...heroSlideForm, badge: e.target.value})}
                  placeholder="UP TO 1/3 OFF"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Display Order</label>
                <Input 
                  type="number"
                  value={heroSlideForm.display_order} 
                  onChange={(e) => setHeroSlideForm({...heroSlideForm, display_order: parseInt(e.target.value) || 0})}
                />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">Title</label>
              <Input 
                value={heroSlideForm.title} 
                onChange={(e) => setHeroSlideForm({...heroSlideForm, title: e.target.value})}
                placeholder="THE SPRING COLLECTION"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Subtitle</label>
              <Input 
                value={heroSlideForm.subtitle} 
                onChange={(e) => setHeroSlideForm({...heroSlideForm, subtitle: e.target.value})}
                placeholder="Revitalise your home this spring..."
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Button Text</label>
                <Input 
                  value={heroSlideForm.cta} 
                  onChange={(e) => setHeroSlideForm({...heroSlideForm, cta: e.target.value})}
                  placeholder="Shop Now"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Button Link</label>
                <Input 
                  value={heroSlideForm.link} 
                  onChange={(e) => setHeroSlideForm({...heroSlideForm, link: e.target.value})}
                  placeholder="/tiles?sale=true"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input 
                type="checkbox"
                id="slide_active"
                checked={heroSlideForm.is_active}
                onChange={(e) => setHeroSlideForm({...heroSlideForm, is_active: e.target.checked})}
                className="w-4 h-4"
              />
              <label htmlFor="slide_active" className="text-sm">Active</label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowHeroSlideDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveHeroSlide}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Benefit Dialog */}
      <Dialog open={showBenefitDialog} onOpenChange={setShowBenefitDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingBenefit ? 'Edit Benefit' : 'Add Benefit'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Text</label>
              <Input 
                value={benefitForm.text} 
                onChange={(e) => setBenefitForm({...benefitForm, text: e.target.value})}
                placeholder="Free delivery on orders over £300"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Link</label>
              <Input 
                value={benefitForm.link} 
                onChange={(e) => setBenefitForm({...benefitForm, link: e.target.value})}
                placeholder="/shop/delivery"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Display Order</label>
                <Input 
                  type="number"
                  value={benefitForm.display_order} 
                  onChange={(e) => setBenefitForm({...benefitForm, display_order: parseInt(e.target.value) || 0})}
                />
              </div>
              <div className="flex items-center gap-2 pt-6">
                <input 
                  type="checkbox"
                  id="benefit_active"
                  checked={benefitForm.is_active}
                  onChange={(e) => setBenefitForm({...benefitForm, is_active: e.target.checked})}
                  className="w-4 h-4"
                />
                <label htmlFor="benefit_active" className="text-sm">Active</label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBenefitDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveBenefit}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Feature Card Dialog */}
      <Dialog open={showFeatureDialog} onOpenChange={setShowFeatureDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingFeature ? 'Edit Feature Card' : 'Add Feature Card'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Icon</Label>
              <div className="grid grid-cols-5 gap-2 mt-2">
                {featureIconOptions.map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={`p-3 rounded-lg border-2 transition-colors ${
                        featureForm.icon === opt.value 
                          ? 'border-blue-500 bg-blue-50' 
                          : 'border-gray-200 hover:border-gray-300'
                      }`}
                      onClick={() => setFeatureForm({ ...featureForm, icon: opt.value })}
                      title={opt.label}
                    >
                      <Icon className="w-5 h-5 mx-auto" />
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <Label>Title</Label>
              <Input 
                value={featureForm.title} 
                onChange={(e) => setFeatureForm({ ...featureForm, title: e.target.value })}
                placeholder="e.g., Free Delivery"
              />
            </div>
            <div>
              <Label>Description</Label>
              <Input 
                value={featureForm.description} 
                onChange={(e) => setFeatureForm({ ...featureForm, description: e.target.value })}
                placeholder="e.g., Free delivery on orders over £300"
              />
            </div>
            <div>
              <Label>Link (optional)</Label>
              <Input 
                value={featureForm.link} 
                onChange={(e) => setFeatureForm({ ...featureForm, link: e.target.value })}
                placeholder="/shop/delivery"
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch 
                checked={featureForm.is_active} 
                onCheckedChange={(v) => setFeatureForm({ ...featureForm, is_active: v })} 
              />
              <Label>Active (visible on website)</Label>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowFeatureDialog(false)}>Cancel</Button>
              <Button onClick={handleSaveFeature}>
                {editingFeature ? 'Update' : 'Create'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Custom Label Dialog */}
      <Dialog open={showLabelDialog} onOpenChange={setShowLabelDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Custom Label</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Label Value (shown on cards)</Label>
              <Input 
                value={newLabelForm.value} 
                onChange={(e) => setNewLabelForm({ ...newLabelForm, value: e.target.value.toUpperCase() })}
                placeholder="e.g., PREMIUM, LIMITED EDITION"
              />
            </div>
            <div>
              <Label>Display Name</Label>
              <Input 
                value={newLabelForm.label} 
                onChange={(e) => setNewLabelForm({ ...newLabelForm, label: e.target.value })}
                placeholder="e.g., Premium Quality"
              />
            </div>
            <div>
              <Label>Description (for admin reference)</Label>
              <Input 
                value={newLabelForm.description} 
                onChange={(e) => setNewLabelForm({ ...newLabelForm, description: e.target.value })}
                placeholder="e.g., High-end premium products"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowLabelDialog(false)}>Cancel</Button>
              <Button onClick={handleAddCustomLabel}>Add Label</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Category Group Dialog */}
      <Dialog open={showGroupDialog} onOpenChange={setShowGroupDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingGroup ? 'Edit Group' : 'Add Category Group'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Name</Label>
                <Input value={groupForm.name} onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value, slug: editingGroup ? groupForm.slug : generateSlug(e.target.value) })} />
              </div>
              <div>
                <Label>Slug</Label>
                <Input value={groupForm.slug} onChange={(e) => setGroupForm({ ...groupForm, slug: e.target.value })} />
              </div>
            </div>
            <div>
              <Label>Description</Label>
              <Input value={groupForm.description} onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Icon</Label>
                <Select value={groupForm.icon} onValueChange={(v) => setGroupForm({ ...groupForm, icon: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {iconOptions.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Color</Label>
                <div className="flex gap-2">
                  <Input type="color" value={groupForm.color} onChange={(e) => setGroupForm({ ...groupForm, color: e.target.value })} className="w-12 p-1" />
                  <Input value={groupForm.color} onChange={(e) => setGroupForm({ ...groupForm, color: e.target.value })} className="flex-1" />
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={groupForm.is_active} onCheckedChange={(v) => setGroupForm({ ...groupForm, is_active: v })} />
              <Label>Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGroupDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveGroup}><Save className="w-4 h-4 mr-1" />Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Category Dialog */}
      <Dialog open={showCategoryDialog} onOpenChange={setShowCategoryDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingCategory ? 'Edit Category' : 'Add Category'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Name</Label>
                <Input value={categoryForm.name} onChange={(e) => setCategoryForm({ ...categoryForm, name: e.target.value, slug: editingCategory ? categoryForm.slug : generateSlug(e.target.value) })} />
              </div>
              <div>
                <Label>Slug</Label>
                <Input value={categoryForm.slug} onChange={(e) => setCategoryForm({ ...categoryForm, slug: e.target.value })} />
              </div>
            </div>
            <div>
              <Label>Group</Label>
              <Select value={categoryForm.group_slug} onValueChange={(v) => setCategoryForm({ ...categoryForm, group_slug: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {categoryGroups.map(g => (
                    <SelectItem key={g.slug} value={g.slug}>{g.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Description</Label>
              <Textarea value={categoryForm.description} onChange={(e) => setCategoryForm({ ...categoryForm, description: e.target.value })} rows={2} />
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Switch checked={categoryForm.is_active} onCheckedChange={(v) => setCategoryForm({ ...categoryForm, is_active: v })} />
                <Label>Active</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={categoryForm.show_on_homepage} onCheckedChange={(v) => setCategoryForm({ ...categoryForm, show_on_homepage: v })} />
                <Label>Homepage</Label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCategoryDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveCategory}><Save className="w-4 h-4 mr-1" />Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Filter Dialog */}
      <Dialog open={showFilterDialog} onOpenChange={setShowFilterDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingFilter ? 'Edit Filter' : 'Add Filter'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Name</Label>
                <Input value={filterForm.name} onChange={(e) => setFilterForm({ ...filterForm, name: e.target.value, slug: editingFilter ? filterForm.slug : generateSlug(e.target.value) })} />
              </div>
              <div>
                <Label>Slug</Label>
                <Input value={filterForm.slug} onChange={(e) => setFilterForm({ ...filterForm, slug: e.target.value })} />
              </div>
            </div>
            <div>
              <Label>Input Type</Label>
              <Select value={filterForm.input_type} onValueChange={(v) => setFilterForm({ ...filterForm, input_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {filterInputTypes.map(t => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            {/* Values Editor - Only show for checkbox and select types */}
            {(filterForm.input_type === 'checkbox' || filterForm.input_type === 'select') && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Filter Values</Label>
                  <Button 
                    type="button" 
                    variant="outline" 
                    size="sm"
                    onClick={() => {
                      const newValues = [...(filterForm.values || []), { value: '', label: '' }];
                      setFilterForm({ ...filterForm, values: newValues });
                    }}
                  >
                    <Plus className="w-3 h-3 mr-1" />
                    Add Value
                  </Button>
                </div>
                <div className="space-y-2 max-h-64 overflow-y-auto border rounded-lg p-2 bg-gray-50">
                  {(filterForm.values || []).length === 0 && (
                    <p className="text-sm text-gray-400 text-center py-4">No values yet. Click "Add Value" to add options.</p>
                  )}
                  {(filterForm.values || []).map((val, idx) => (
                    <div key={idx} className="bg-white p-3 rounded border space-y-2">
                      <div className="flex items-center gap-2">
                        <Input 
                          value={val.label || val.value || ''} 
                          onChange={(e) => {
                            const newValues = [...filterForm.values];
                            newValues[idx] = { 
                              ...newValues[idx], 
                              label: e.target.value,
                              value: newValues[idx].value || generateSlug(e.target.value)
                            };
                            setFilterForm({ ...filterForm, values: newValues });
                          }}
                          placeholder="Display name (e.g., Polished)"
                          className="flex-1"
                        />
                        <Input 
                          value={val.value || ''} 
                          onChange={(e) => {
                            const newValues = [...filterForm.values];
                            newValues[idx] = { ...newValues[idx], value: e.target.value };
                            setFilterForm({ ...filterForm, values: newValues });
                          }}
                          placeholder="Value (e.g., polished)"
                          className="w-32"
                        />
                        <Button 
                          type="button" 
                          variant="ghost" 
                          size="sm"
                          onClick={() => {
                            const newValues = filterForm.values.filter((_, i) => i !== idx);
                            setFilterForm({ ...filterForm, values: newValues });
                          }}
                        >
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      </div>
                      {/* Homepage display options for this value */}
                      <div className="flex items-center gap-4 pl-1">
                        <label className="flex items-center gap-2 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            checked={val.show_on_homepage || false}
                            onChange={(e) => {
                              const newValues = [...filterForm.values];
                              newValues[idx] = { ...newValues[idx], show_on_homepage: e.target.checked };
                              setFilterForm({ ...filterForm, values: newValues });
                            }}
                            className="h-3.5 w-3.5 rounded border-gray-300 text-indigo-600"
                          />
                          <span className="text-gray-600">Show on Homepage</span>
                        </label>
                      </div>
                      
                      {/* Image selector for homepage display */}
                      {val.show_on_homepage && (
                        <div className="pl-1 pt-2 border-t border-dashed border-gray-200">
                          <div className="flex items-start gap-3">
                            {/* Image preview */}
                            {val.image_url ? (
                              <div className="relative w-20 h-20 rounded-lg overflow-hidden border-2 border-indigo-200 flex-shrink-0">
                                <img 
                                  src={val.image_url} 
                                  alt={val.label || 'Preview'} 
                                  className="w-full h-full object-cover"
                                  onError={(e) => { e.target.src = 'https://via.placeholder.com/80?text=No+Image'; }}
                                />
                                <button
                                  type="button"
                                  onClick={() => {
                                    const newValues = [...filterForm.values];
                                    newValues[idx] = { ...newValues[idx], image_url: '' };
                                    setFilterForm({ ...filterForm, values: newValues });
                                  }}
                                  className="absolute top-0.5 right-0.5 p-0.5 bg-red-500 text-white rounded-full hover:bg-red-600"
                                  title="Remove image"
                                >
                                  <X className="w-3 h-3" />
                                </button>
                              </div>
                            ) : (
                              <div className="w-20 h-20 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center bg-gray-50 flex-shrink-0">
                                <ImageIcon className="w-6 h-6 text-gray-400" />
                              </div>
                            )}
                            
                            {/* Selection buttons */}
                            <div className="flex-1 space-y-2">
                              <p className="text-xs text-gray-500">Select an image for the homepage card:</p>
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    setProductImageSelectorIndex(idx);
                                    setShowProductImageSelector(true);
                                    setProductSearchQuery(val.label || '');
                                    searchProductsForImage(val.label || '');
                                  }}
                                  className="text-xs h-7"
                                >
                                  <Package className="w-3 h-3 mr-1" />
                                  Select from Products
                                </Button>
                              </div>
                              {/* Manual URL input (collapsible) */}
                              <details className="text-xs">
                                <summary className="text-gray-400 cursor-pointer hover:text-gray-600">Or paste image URL manually</summary>
                                <Input
                                  value={val.image_url || ''}
                                  onChange={(e) => {
                                    const newValues = [...filterForm.values];
                                    newValues[idx] = { ...newValues[idx], image_url: e.target.value };
                                    setFilterForm({ ...filterForm, values: newValues });
                                  }}
                                  placeholder="https://..."
                                  className="mt-1 h-7 text-xs"
                                />
                              </details>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {filterForm.auto_populate ? 'Note: Auto-populated filters will also include values from products automatically.' : 'Add the values customers can filter by. Enable "Show on Homepage" to display in "Shop by Style" section.'}
                </p>
              </div>
            )}

            {/* Range Settings - Only show for range type */}
            {filterForm.input_type === 'range' && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Min Value</Label>
                  <Input 
                    type="number"
                    value={filterForm.min_value || 0} 
                    onChange={(e) => setFilterForm({ ...filterForm, min_value: parseInt(e.target.value) })}
                  />
                </div>
                <div>
                  <Label>Max Value</Label>
                  <Input 
                    type="number"
                    value={filterForm.max_value || 200} 
                    onChange={(e) => setFilterForm({ ...filterForm, max_value: parseInt(e.target.value) })}
                  />
                </div>
              </div>
            )}

            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Switch checked={filterForm.is_active} onCheckedChange={(v) => setFilterForm({ ...filterForm, is_active: v })} />
                <Label>Active</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={filterForm.auto_populate} onCheckedChange={(v) => setFilterForm({ ...filterForm, auto_populate: v })} />
                <Label>Auto-populate from products</Label>
              </div>
            </div>

            {/* Category/Group Restrictions for Auto-populate */}
            {filterForm.auto_populate && (
              <div className="p-4 bg-blue-50 rounded-lg border border-blue-200 space-y-4">
                <div>
                  <Label className="text-blue-800 font-medium">Restrict to Groups (Recommended)</Label>
                  <p className="text-xs text-blue-600 mb-2">Only pull values from products in these groups</p>
                  <div className="flex flex-wrap gap-2">
                    {categoryGroups.map(group => {
                      const isSelected = (filterForm.auto_populate_groups || []).includes(group.slug);
                      return (
                        <Button
                          key={group.slug}
                          type="button"
                          variant={isSelected ? "default" : "outline"}
                          size="sm"
                          className={`text-xs ${isSelected ? 'bg-blue-600' : 'border-blue-300 text-blue-700 hover:bg-blue-100'}`}
                          onClick={() => {
                            const current = filterForm.auto_populate_groups || [];
                            const updated = isSelected 
                              ? current.filter(g => g !== group.slug)
                              : [...current, group.slug];
                            setFilterForm({ ...filterForm, auto_populate_groups: updated });
                          }}
                        >
                          {isSelected && <CheckSquare className="w-3 h-3 mr-1" />}
                          {group.name}
                        </Button>
                      );
                    })}
                  </div>
                </div>

                {(filterForm.auto_populate_groups || []).length === 0 && (
                  <div className="p-3 bg-yellow-50 border border-yellow-200 rounded">
                    <p className="text-xs text-yellow-800">
                      <strong>Warning:</strong> No group selected. Filter will pull values from ALL products (including flooring, materials, etc.)
                    </p>
                  </div>
                )}

                <div>
                  <Label className="text-blue-800">Or Restrict to Specific Categories</Label>
                  <p className="text-xs text-blue-600 mb-2">Fine-grained control by category name</p>
                  <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
                    {categories.slice(0, 15).map(cat => {
                      const isSelected = (filterForm.auto_populate_categories || []).includes(cat.name);
                      return (
                        <Button
                          key={cat.slug}
                          type="button"
                          variant={isSelected ? "default" : "outline"}
                          size="sm"
                          className={`text-xs h-6 ${isSelected ? 'bg-green-600' : 'border-gray-300'}`}
                          onClick={() => {
                            const current = filterForm.auto_populate_categories || [];
                            const updated = isSelected 
                              ? current.filter(c => c !== cat.name)
                              : [...current, cat.name];
                            setFilterForm({ ...filterForm, auto_populate_categories: updated });
                          }}
                        >
                          {cat.name}
                        </Button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
          
          {/* Visibility & Integration Settings */}
          <div className="p-4 bg-gradient-to-r from-purple-50 to-indigo-50 rounded-lg border border-purple-200 space-y-3">
            <h4 className="text-sm font-medium text-purple-900 flex items-center gap-2">
              <Settings className="w-4 h-4" />
              Visibility & Integration
            </h4>
            <p className="text-xs text-purple-600 mb-2">Control where this filter appears across the system</p>
            
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center justify-between p-2 bg-white rounded border">
                <Label className="text-xs text-gray-700 cursor-pointer">Show in Shop Filters</Label>
                <input 
                  type="checkbox" 
                  checked={filterForm.show_in_shop_filter !== false}
                  onChange={(e) => setFilterForm({ ...filterForm, show_in_shop_filter: e.target.checked })}
                  className="h-4 w-4 text-purple-600 rounded border-gray-300"
                />
              </div>
              
              <div className="flex items-center justify-between p-2 bg-white rounded border">
                <Label className="text-xs text-gray-700 cursor-pointer">Show in Bulk Editor</Label>
                <input 
                  type="checkbox" 
                  checked={filterForm.show_in_bulk_editor !== false}
                  onChange={(e) => setFilterForm({ ...filterForm, show_in_bulk_editor: e.target.checked })}
                  className="h-4 w-4 text-purple-600 rounded border-gray-300"
                />
              </div>
              
              <div className="flex items-center justify-between p-2 bg-white rounded border">
                <Label className="text-xs text-gray-700 cursor-pointer">Show on Product Page</Label>
                <input 
                  type="checkbox" 
                  checked={filterForm.show_in_product_detail !== false}
                  onChange={(e) => setFilterForm({ ...filterForm, show_in_product_detail: e.target.checked })}
                  className="h-4 w-4 text-purple-600 rounded border-gray-300"
                />
              </div>
              
              <div className="flex items-center justify-between p-2 bg-white rounded border">
                <Label className="text-xs text-gray-700 cursor-pointer">Allow Adding in Bulk Editor</Label>
                <input 
                  type="checkbox" 
                  checked={filterForm.allow_new_values_in_bulk_editor === true}
                  onChange={(e) => setFilterForm({ ...filterForm, allow_new_values_in_bulk_editor: e.target.checked })}
                  className="h-4 w-4 text-purple-600 rounded border-gray-300"
                />
              </div>
            </div>
            
            <p className="text-xs text-purple-500 mt-2">
              These settings sync with the Bulk Category Editor's "Manage Options" system.
            </p>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowFilterDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveFilter}><Save className="w-4 h-4 mr-1" />Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Banner Dialog */}
      <Dialog open={showBannerDialog} onOpenChange={setShowBannerDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingBanner ? (editingBanner.is_default ? 'Edit Default Banner' : 'Edit Banner') : 'Add Banner'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Title</Label>
              <Input 
                value={bannerForm.title} 
                onChange={(e) => setBannerForm({ ...bannerForm, title: e.target.value })}
                placeholder="e.g., Wall & Floor Tiles"
              />
            </div>
            <div>
              <Label>Subtitle</Label>
              <Input 
                value={bannerForm.subtitle} 
                onChange={(e) => setBannerForm({ ...bannerForm, subtitle: e.target.value })}
                placeholder="e.g., Explore our curated collection..."
              />
            </div>
            <div>
              <Label>Background Image</Label>
              <div className="flex gap-2">
                <Input 
                  value={bannerForm.image} 
                  onChange={(e) => setBannerForm({ ...bannerForm, image: e.target.value })}
                  placeholder="https://images.unsplash.com/... or upload"
                  className="flex-1"
                />
                <div className="relative">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif"
                    onChange={handleBannerImageUpload}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                    disabled={uploadingBannerImage}
                  />
                  <Button 
                    type="button" 
                    variant="outline" 
                    disabled={uploadingBannerImage}
                    className="relative"
                  >
                    {uploadingBannerImage ? (
                      <><Loader2 className="w-4 h-4 mr-1 animate-spin" />Uploading...</>
                    ) : (
                      <><Upload className="w-4 h-4 mr-1" />Upload</>
                    )}
                  </Button>
                </div>
              </div>
              <p className="text-xs text-gray-500 mt-1">Enter a URL or upload an image (JPEG, PNG, WebP, GIF - max 10MB)</p>
            </div>
            <div>
              <Label>Overlay Color</Label>
              <Select value={bannerForm.overlay} onValueChange={(v) => setBannerForm({ ...bannerForm, overlay: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="rgba(0,0,0,0.2)">Light (20%)</SelectItem>
                  <SelectItem value="rgba(0,0,0,0.3)">Normal (30%)</SelectItem>
                  <SelectItem value="rgba(0,0,0,0.4)">Medium (40%)</SelectItem>
                  <SelectItem value="rgba(0,0,0,0.5)">Dark (50%)</SelectItem>
                  <SelectItem value="rgba(220,38,38,0.5)">Red (Sale)</SelectItem>
                  <SelectItem value="rgba(59,130,246,0.4)">Blue</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            {!bannerForm.is_default && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Target Category</Label>
                  <Select value={bannerForm.category_slug || 'none'} onValueChange={(v) => setBannerForm({ ...bannerForm, category_slug: v === 'none' ? '' : v, group_slug: '' })}>
                    <SelectTrigger><SelectValue placeholder="Select category..." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {categories.map(cat => (
                        <SelectItem key={cat.slug} value={cat.slug}>{cat.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Target Group</Label>
                  <Select value={bannerForm.group_slug || 'none'} onValueChange={(v) => setBannerForm({ ...bannerForm, group_slug: v === 'none' ? '' : v, category_slug: '' })}>
                    <SelectTrigger><SelectValue placeholder="Select group..." /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      {categoryGroups.map(g => (
                        <SelectItem key={g.slug} value={g.slug}>{g.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Preview */}
            {bannerForm.image && (
              <div 
                className="h-32 rounded-lg overflow-hidden relative"
                style={{
                  backgroundImage: `url(${bannerForm.image})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                }}
              >
                <div className="absolute inset-0" style={{ backgroundColor: bannerForm.overlay || 'rgba(0,0,0,0.3)' }} />
                <div className="absolute inset-0 flex items-center justify-center text-center px-4">
                  <div>
                    <p className="text-white text-xl font-light drop-shadow-lg">{bannerForm.title || 'Banner Title'}</p>
                    <p className="text-white/90 text-sm drop-shadow-md mt-1">{bannerForm.subtitle || 'Banner subtitle text'}</p>
                  </div>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBannerDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveBanner}><Save className="w-4 h-4 mr-1" />Save Banner</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Specification Dialog */}
      <Dialog open={showSpecDialog} onOpenChange={setShowSpecDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingSpec ? 'Edit Specification' : 'Add Specification'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Name</Label>
                <Input 
                  value={specForm.name} 
                  onChange={(e) => setSpecForm({ ...specForm, name: e.target.value, slug: editingSpec ? specForm.slug : generateSlug(e.target.value) })}
                  placeholder="e.g., Material"
                />
              </div>
              <div>
                <Label>Slug</Label>
                <Input 
                  value={specForm.slug} 
                  onChange={(e) => setSpecForm({ ...specForm, slug: e.target.value })}
                  placeholder="e.g., material"
                />
              </div>
            </div>
            <div>
              <Label>Product Field Name</Label>
              <Input 
                value={specForm.field_name} 
                onChange={(e) => setSpecForm({ ...specForm, field_name: e.target.value })}
                placeholder="e.g., material, finish, size, color"
              />
              <p className="text-xs text-gray-500 mt-1">The field in products to pull values from (e.g., material, finish)</p>
            </div>
            <div>
              <Label>Group</Label>
              <Select value={specForm.group_slug} onValueChange={(v) => setSpecForm({ ...specForm, group_slug: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="general">General</SelectItem>
                  {specificationGroups.map(g => (
                    <SelectItem key={g.slug} value={g.slug}>{g.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Description</Label>
              <Input 
                value={specForm.description} 
                onChange={(e) => setSpecForm({ ...specForm, description: e.target.value })}
                placeholder="Optional description"
              />
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Switch 
                  checked={specForm.is_active} 
                  onCheckedChange={(v) => setSpecForm({ ...specForm, is_active: v })}
                />
                <Label>Active</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch 
                  checked={specForm.auto_populate} 
                  onCheckedChange={(v) => setSpecForm({ ...specForm, auto_populate: v })}
                />
                <Label>Auto-sync from Products</Label>
              </div>
            </div>
            {/* Values Management */}
            {editingSpec && (
              <div>
                <Label className="mb-2 block">Values ({specForm.values?.length || 0})</Label>
                <div className="max-h-48 overflow-y-auto border rounded p-2 space-y-1 mb-2">
                  {(specForm.values || []).map((val, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <span className="flex-1 truncate">{val.label || val.value}</span>
                      <button
                        type="button"
                        className="text-red-400 hover:text-red-600 shrink-0"
                        onClick={() => {
                          const newVals = specForm.values.filter((_, idx) => idx !== i);
                          setSpecForm({ ...specForm, values: newVals });
                        }}
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  {(!specForm.values || specForm.values.length === 0) && (
                    <p className="text-xs text-gray-400">No values yet</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="Add new value (e.g., Limestone)"
                    data-testid="spec-new-value-input"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.target.value.trim()) {
                        e.preventDefault();
                        const val = e.target.value.trim();
                        const slug = val.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
                        const exists = (specForm.values || []).some(v => v.value === slug || v.label === val);
                        if (exists) {
                          toast.error('Value already exists');
                          return;
                        }
                        setSpecForm({
                          ...specForm,
                          values: [...(specForm.values || []), { value: slug, label: val, is_active: true }]
                        });
                        e.target.value = '';
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      const input = document.querySelector('[data-testid="spec-new-value-input"]');
                      if (input && input.value.trim()) {
                        const val = input.value.trim();
                        const slug = val.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
                        const exists = (specForm.values || []).some(v => v.value === slug || v.label === val);
                        if (exists) {
                          toast.error('Value already exists');
                          return;
                        }
                        setSpecForm({
                          ...specForm,
                          values: [...(specForm.values || []), { value: slug, label: val, is_active: true }]
                        });
                        input.value = '';
                      }
                    }}
                  >
                    Add
                  </Button>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSpecDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveSpec}><Save className="w-4 h-4 mr-1" />{editingSpec ? 'Update' : 'Create'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Specification Group Dialog */}
      <Dialog open={showSpecGroupDialog} onOpenChange={setShowSpecGroupDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingSpecGroup ? 'Edit Specification Group' : 'Add Specification Group'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Name</Label>
                <Input 
                  value={specGroupForm.name} 
                  onChange={(e) => setSpecGroupForm({ ...specGroupForm, name: e.target.value, slug: editingSpecGroup ? specGroupForm.slug : generateSlug(e.target.value) })}
                  placeholder="e.g., Physical Properties"
                />
              </div>
              <div>
                <Label>Slug</Label>
                <Input 
                  value={specGroupForm.slug} 
                  onChange={(e) => setSpecGroupForm({ ...specGroupForm, slug: e.target.value })}
                />
              </div>
            </div>
            <div>
              <Label>Description</Label>
              <Input 
                value={specGroupForm.description} 
                onChange={(e) => setSpecGroupForm({ ...specGroupForm, description: e.target.value })}
                placeholder="Optional description"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Color</Label>
                <div className="flex gap-2">
                  <Input 
                    type="color" 
                    value={specGroupForm.color} 
                    onChange={(e) => setSpecGroupForm({ ...specGroupForm, color: e.target.value })}
                    className="w-12 h-10 p-1"
                  />
                  <Input 
                    value={specGroupForm.color} 
                    onChange={(e) => setSpecGroupForm({ ...specGroupForm, color: e.target.value })}
                    className="flex-1"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2 pt-6">
                <Switch 
                  checked={specGroupForm.is_active} 
                  onCheckedChange={(v) => setSpecGroupForm({ ...specGroupForm, is_active: v })}
                />
                <Label>Active</Label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSpecGroupDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveSpecGroup}><Save className="w-4 h-4 mr-1" />{editingSpecGroup ? 'Update' : 'Create'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Product Image Selector Modal */}
      <Dialog open={showProductImageSelector} onOpenChange={setShowProductImageSelector}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="w-5 h-5" />
              Select Image from Products
            </DialogTitle>
            <DialogDescription>
              Search for a product and click to use its image for the homepage card.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
            {/* Search input */}
            <div className="flex gap-2">
              <Input
                value={productSearchQuery}
                onChange={(e) => setProductSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    searchProductsForImage(productSearchQuery);
                  }
                }}
                placeholder="Search products by name or style..."
                className="flex-1"
              />
              <Button 
                onClick={() => searchProductsForImage(productSearchQuery)}
                disabled={productSearchLoading}
              >
                {productSearchLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Search'}
              </Button>
            </div>
            
            {/* Search results */}
            <div className="flex-1 overflow-y-auto border rounded-lg">
              {productSearchLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                  <span className="ml-2 text-gray-500">Searching...</span>
                </div>
              ) : productSearchResults.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                  <ImageIcon className="w-12 h-12 mb-2" />
                  <p>Search for products to see their images</p>
                  <p className="text-sm">Try searching for "wood", "marble", "stone", etc.</p>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-3 p-3">
                  {productSearchResults.map((product, idx) => {
                    const imageUrl = product.main_image || product.images?.[0] || product.lifestyle_image;
                    return (
                      <button
                        key={product._id || product.id || idx}
                        type="button"
                        onClick={() => selectProductImage(product, productImageSelectorIndex)}
                        className="group relative aspect-square rounded-lg overflow-hidden border-2 border-transparent hover:border-indigo-500 transition-all"
                      >
                        <img 
                          src={imageUrl} 
                          alt={product.name || product.series_name}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                          onError={(e) => { e.target.src = 'https://via.placeholder.com/200?text=No+Image'; }}
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                          <div className="absolute bottom-0 left-0 right-0 p-2">
                            <p className="text-white text-xs font-medium truncate">
                              {product.name || product.series_name}
                            </p>
                            <p className="text-white/70 text-xs truncate">
                              {product.supplier_name || product.supplier}
                            </p>
                          </div>
                        </div>
                        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          <div className="bg-indigo-500 text-white text-xs px-2 py-1 rounded">
                            Select
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowProductImageSelector(false);
              setProductSearchQuery('');
              setProductSearchResults([]);
            }}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default NavigationStructureManager;
