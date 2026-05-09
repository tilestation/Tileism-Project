import React, { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, ChevronRight, ChevronDown, GripVertical, Save, X, Image, Eye, EyeOff, RefreshCw, Layers, FolderOpen, Grid3X3, Flame, Package, Wrench, Puzzle, Monitor, ExternalLink } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import { Badge } from '../../components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../../components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { toast } from 'sonner';
import { normaliseImageUrl } from '../../utils/safeStr';

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

const WebsiteCategoriesManager = () => {
  const [activeTab, setActiveTab] = useState('groups');
  const [categoryGroups, setCategoryGroups] = useState([]);
  const [categories, setCategories] = useState([]);
  const [categoriesByGroup, setCategoriesByGroup] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  
  // Category form state
  const [showCategoryForm, setShowCategoryForm] = useState(false);
  const [editingCategory, setEditingCategory] = useState(null);
  const [categoryForm, setCategoryForm] = useState({
    name: '', slug: '', description: '', parent_id: null, group_slug: 'tiles',
    image_url: '', display_order: 0, is_active: true, show_on_homepage: false,
    seo_title: '', seo_description: ''
  });

  // Group form state
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [editingGroup, setEditingGroup] = useState(null);
  const [groupForm, setGroupForm] = useState({
    name: '', slug: '', description: '', icon: 'FolderOpen', color: '#3B82F6', display_order: 0, is_active: true
  });

  const [expandedGroups, setExpandedGroups] = useState({});

  useEffect(() => {
    fetchAllData();
  }, []);

  const fetchAllData = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const [groupsRes, catsRes, byGroupRes] = await Promise.all([
        fetch(`${API_URL}/api/website-admin/category-groups`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/api/website-admin/categories`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${API_URL}/api/website-admin/categories/by-group`, { headers: { Authorization: `Bearer ${token}` } })
      ]);
      
      if (groupsRes.ok) setCategoryGroups(await groupsRes.json());
      if (catsRes.ok) setCategories(await catsRes.json());
      if (byGroupRes.ok) {
        const data = await byGroupRes.json();
        setCategoriesByGroup(data);
        // Expand all groups by default
        const expanded = {};
        data.forEach(g => { expanded[g.slug] = true; });
        setExpandedGroups(expanded);
      }
    } catch (e) {
      toast.error('Failed to load data');
    } finally {
      setLoading(false);
    }
  };

  // Seed default groups
  const seedDefaultGroups = async () => {
    try {
      const res = await fetch(`${API_URL}/api/website-admin/category-groups/seed-defaults`, { method: 'POST' });
      const data = await res.json();
      if (data.skipped) {
        toast.info('Category groups already exist');
      } else {
        toast.success(`Created ${data.groups_created} category groups`);
        fetchAllData();
      }
    } catch (e) {
      toast.error('Failed to seed defaults');
    }
  };

  // Sync from products
  const handleSyncFromProducts = async () => {
    setSyncing(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/categories/sync-from-products`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message);
        fetchAllData();
      }
    } catch (e) {
      toast.error('Failed to sync');
    } finally {
      setSyncing(false);
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
        resetGroupForm();
        fetchAllData();
      } else {
        const err = await res.json();
        toast.error(err.detail || 'Failed to save group');
      }
    } catch (e) {
      toast.error('Failed to save group');
    }
  };

  const handleDeleteGroup = async (groupId) => {
    if (!window.confirm('Delete this category group? Categories in this group will become ungrouped.')) return;
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/category-groups/${groupId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        toast.success('Group deleted');
        fetchAllData();
      }
    } catch (e) {
      toast.error('Failed to delete group');
    }
  };

  const openEditGroup = (group) => {
    setEditingGroup(group);
    setGroupForm({
      name: group.name,
      slug: group.slug,
      description: group.description || '',
      icon: group.icon || 'FolderOpen',
      color: group.color || '#3B82F6',
      display_order: group.display_order || 0,
      is_active: group.is_active !== false
    });
    setShowGroupDialog(true);
  };

  const resetGroupForm = () => {
    setGroupForm({ name: '', slug: '', description: '', icon: 'FolderOpen', color: '#3B82F6', display_order: 0, is_active: true });
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
        setShowCategoryForm(false);
        setEditingCategory(null);
        resetCategoryForm();
        fetchAllData();
      } else {
        const err = await res.json();
        toast.error(err.detail || 'Failed to save category');
      }
    } catch (e) {
      toast.error('Failed to save category');
    }
  };

  const handleDeleteCategory = async (categoryId) => {
    if (!window.confirm('Delete this category?')) return;
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/categories/${categoryId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        toast.success('Category deleted');
        fetchAllData();
      }
    } catch (e) {
      toast.error('Failed to delete category');
    }
  };

  const openEditCategory = (category) => {
    setEditingCategory(category);
    setCategoryForm({
      name: category.name,
      slug: category.slug,
      description: category.description || '',
      parent_id: category.parent_id || null,
      group_slug: category.group_slug || 'tiles',
      image_url: category.image_url || '',
      display_order: category.display_order || 0,
      is_active: category.is_active !== false,
      show_on_homepage: category.show_on_homepage || false,
      seo_title: category.seo_title || '',
      seo_description: category.seo_description || ''
    });
    setShowCategoryForm(true);
  };

  const resetCategoryForm = () => {
    setCategoryForm({
      name: '', slug: '', description: '', parent_id: null, group_slug: 'tiles',
      image_url: '', display_order: 0, is_active: true, show_on_homepage: false,
      seo_title: '', seo_description: ''
    });
  };

  // Quick move category to another group
  const handleMoveToGroup = async (categoryId, newGroupSlug) => {
    try {
      const token = localStorage.getItem('token');
      // Find the category
      const category = categories.find(c => c.id === categoryId);
      if (!category) return;
      
      const res = await fetch(`${API_URL}/api/website-admin/categories/${categoryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          ...category,
          group_slug: newGroupSlug
        })
      });
      
      if (res.ok) {
        toast.success(`Moved "${category.name}" to ${newGroupSlug || 'ungrouped'}`);
        fetchAllData();
      } else {
        toast.error('Failed to move category');
      }
    } catch (e) {
      toast.error('Failed to move category');
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
    { value: 'FolderOpen', label: 'Folder (General)' },
    { value: 'Layers', label: 'Layers' },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Layers className="w-6 h-6" />
            Categories
          </h1>
          <p className="text-gray-500 text-sm">Organize products into groups and categories</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={seedDefaultGroups}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Seed Defaults
          </Button>
          <Button variant="outline" onClick={handleSyncFromProducts} disabled={syncing}>
            <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync from Products'}
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="groups" className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4" />
            Category Groups ({categoryGroups.length})
          </TabsTrigger>
          <TabsTrigger value="all" className="flex items-center gap-2">
            <Layers className="w-4 h-4" />
            All Categories ({categories.length})
          </TabsTrigger>
          <TabsTrigger value="preview" className="flex items-center gap-2">
            <Eye className="w-4 h-4" />
            Preview
          </TabsTrigger>
        </TabsList>

        {/* Groups Tab - Shows categories organized by groups */}
        <TabsContent value="groups">
          <div className="flex justify-end mb-4">
            <Button onClick={() => { resetGroupForm(); setEditingGroup(null); setShowGroupDialog(true); }}>
              <Plus className="w-4 h-4 mr-2" />
              Add Group
            </Button>
          </div>

          <div className="space-y-4">
            {categoriesByGroup.map((group) => {
              const IconComponent = GroupIcons[group.icon] || FolderOpen;
              const isExpanded = expandedGroups[group.slug];
              
              return (
                <Card key={group.id || group.slug} className="overflow-hidden">
                  <div 
                    className="flex items-center justify-between p-4 cursor-pointer hover:bg-gray-50"
                    onClick={() => toggleGroup(group.slug)}
                  >
                    <div className="flex items-center gap-3">
                      {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
                      <div 
                        className="p-2 rounded-lg" 
                        style={{ backgroundColor: group.color ? `${group.color}20` : '#f3f4f6' }}
                      >
                        <IconComponent className="w-5 h-5" style={{ color: group.color || '#6b7280' }} />
                      </div>
                      <div>
                        <h3 className="font-semibold">{group.name}</h3>
                        <p className="text-sm text-gray-500">{group.description}</p>
                      </div>
                      <Badge variant="secondary" className="ml-2">
                        {group.categories?.length || 0} categories
                      </Badge>
                    </div>
                    
                    {group.id !== 'ungrouped' && (
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <Button 
                          variant="outline" 
                          size="sm"
                          onClick={() => {
                            resetCategoryForm();
                            setCategoryForm(prev => ({ ...prev, group_slug: group.slug }));
                            setEditingCategory(null);
                            setShowCategoryForm(true);
                          }}
                        >
                          <Plus className="w-4 h-4 mr-1" />
                          Add Category
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEditGroup(group)}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDeleteGroup(group.id)}>
                          <Trash2 className="w-4 h-4 text-red-500" />
                        </Button>
                      </div>
                    )}
                    
                    {/* Special buttons for Ungrouped section */}
                    {group.id === 'ungrouped' && group.categories?.length > 0 && (
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        <Select
                          onValueChange={async (groupSlug) => {
                            if (!window.confirm(`Move all ${group.categories.length} categories to "${groupSlug}"?`)) return;
                            for (const cat of group.categories) {
                              await handleMoveToGroup(cat.id, groupSlug);
                            }
                          }}
                        >
                          <SelectTrigger className="w-40 h-8">
                            <span className="text-sm">Move All To...</span>
                          </SelectTrigger>
                          <SelectContent>
                            {categoryGroups.map(g => (
                              <SelectItem key={g.slug} value={g.slug}>{g.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                  
                  {isExpanded && (
                    <CardContent className="pt-0 pb-4">
                      {group.categories?.length > 0 ? (
                        <div className="space-y-2 ml-8">
                          {group.categories.map((cat) => (
                            <div 
                              key={cat.id} 
                              className="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100"
                            >
                              <div className="flex items-center gap-3">
                                <GripVertical className="w-4 h-4 text-gray-400" />
                                {cat.image_url ? (
                                  <img src={normaliseImageUrl(cat.image_url)} alt={cat.name} className="w-10 h-10 rounded object-cover" />
                                ) : (
                                  <div className="w-10 h-10 bg-gray-200 rounded flex items-center justify-center">
                                    <Image className="w-5 h-5 text-gray-400" />
                                  </div>
                                )}
                                <div>
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium">{cat.name}</span>
                                    {cat.is_active ? (
                                      <Badge variant="outline" className="text-xs">Active</Badge>
                                    ) : (
                                      <Badge variant="secondary" className="text-xs">Inactive</Badge>
                                    )}
                                    {cat.show_on_homepage && (
                                      <Badge className="text-xs">Homepage</Badge>
                                    )}
                                  </div>
                                  <p className="text-xs text-gray-500">
                                    {cat.product_count || 0} products • /{cat.slug}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {/* Move to Group dropdown - especially useful for ungrouped */}
                                <Select
                                  value={cat.group_slug || ''}
                                  onValueChange={(value) => handleMoveToGroup(cat.id, value)}
                                >
                                  <SelectTrigger className="w-32 h-8 text-xs">
                                    <SelectValue placeholder="Move to..." />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {categoryGroups.map(g => (
                                      <SelectItem key={g.slug} value={g.slug} className="text-xs">
                                        {g.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <Button variant="ghost" size="sm" onClick={() => openEditCategory(cat)}>
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
                        <p className="text-gray-400 text-sm ml-8">No categories in this group</p>
                      )}
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>
        </TabsContent>

        {/* All Categories Tab - Flat list */}
        <TabsContent value="all">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between py-4">
              <CardTitle className="text-lg">All Categories</CardTitle>
              <Button size="sm" onClick={() => { resetCategoryForm(); setEditingCategory(null); setShowCategoryForm(true); }}>
                <Plus className="w-4 h-4 mr-2" />
                Add Category
              </Button>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {categories.map((cat) => (
                  <div 
                    key={cat.id} 
                    className="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-3">
                      <GripVertical className="w-4 h-4 text-gray-400" />
                      {cat.image_url ? (
                        <img src={normaliseImageUrl(cat.image_url)} alt={cat.name} className="w-10 h-10 rounded object-cover" />
                      ) : (
                        <div className="w-10 h-10 bg-gray-100 rounded flex items-center justify-center">
                          <Image className="w-5 h-5 text-gray-400" />
                        </div>
                      )}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{cat.name}</span>
                          <Badge variant="outline" className="text-xs">{cat.group_slug || 'ungrouped'}</Badge>
                          {cat.is_active ? (
                            <Eye className="w-4 h-4 text-green-500" />
                          ) : (
                            <EyeOff className="w-4 h-4 text-gray-400" />
                          )}
                        </div>
                        <p className="text-xs text-gray-500">{cat.product_count || 0} products</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" onClick={() => openEditCategory(cat)}>
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleDeleteCategory(cat.id)}>
                        <Trash2 className="w-4 h-4 text-red-500" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Preview Tab */}
        <TabsContent value="preview">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Homepage Category Cards Preview */}
            <Card>
              <CardHeader className="py-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Monitor className="w-5 h-5" />
                  Homepage Categories
                </CardTitle>
                <p className="text-sm text-gray-500">Categories shown on the homepage</p>
              </CardHeader>
              <CardContent>
                <div className="bg-gray-50 rounded-lg p-4">
                  <h3 className="font-semibold text-center mb-4 text-lg">Shop by Category</h3>
                  <div className="grid grid-cols-3 gap-3">
                    {categories.filter(c => c.show_on_homepage && c.is_active).slice(0, 6).map((cat) => (
                      <div key={cat.id} className="bg-white rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                        <div className="aspect-square bg-gray-100 relative">
                          {cat.image_url ? (
                            <img src={normaliseImageUrl(cat.image_url)} alt={cat.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Image className="w-8 h-8 text-gray-300" />
                            </div>
                          )}
                        </div>
                        <div className="p-2 text-center">
                          <p className="font-medium text-sm truncate">{cat.name}</p>
                          <p className="text-xs text-gray-500">{cat.product_count || 0} products</p>
                        </div>
                      </div>
                    ))}
                    {categories.filter(c => c.show_on_homepage && c.is_active).length === 0 && (
                      <div className="col-span-3 text-center py-8 text-gray-400">
                        <p>No categories marked for homepage display</p>
                        <p className="text-xs mt-1">Enable "Show on Homepage" for categories to appear here</p>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Navigation Menu Preview */}
            <Card>
              <CardHeader className="py-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Eye className="w-5 h-5" />
                  Shop Navigation
                </CardTitle>
                <p className="text-sm text-gray-500">How categories appear in shop navigation</p>
              </CardHeader>
              <CardContent>
                <div className="bg-gray-900 rounded-lg overflow-hidden">
                  {/* Header */}
                  <div className="text-white p-3 text-center font-semibold border-b border-gray-800">
                    TILE STATION
                  </div>
                  
                  {/* Navigation */}
                  <div className="flex flex-wrap justify-center gap-1 p-3 bg-gray-800">
                    <span className="px-3 py-1.5 text-white text-sm rounded hover:bg-gray-700 cursor-pointer">
                      ALL
                    </span>
                    {categories.filter(c => c.is_active).slice(0, 6).map((cat) => (
                      <span 
                        key={cat.id} 
                        className="px-3 py-1.5 text-gray-300 text-sm rounded hover:bg-gray-700 hover:text-white cursor-pointer transition-colors"
                      >
                        {cat.name.toUpperCase()}
                      </span>
                    ))}
                    {categories.filter(c => c.is_active).length > 6 && (
                      <span className="px-3 py-1.5 text-gray-400 text-sm">
                        +{categories.filter(c => c.is_active).length - 6} more
                      </span>
                    )}
                  </div>
                </div>
                
                <div className="mt-4 p-3 bg-gray-50 rounded-lg">
                  <h4 className="font-medium text-sm mb-2">Category Groups Navigation</h4>
                  <div className="flex flex-wrap gap-2">
                    {categoriesByGroup.filter(g => g.id !== 'ungrouped' && g.categories?.length > 0).map((group) => {
                      const IconComponent = GroupIcons[group.icon] || FolderOpen;
                      return (
                        <div 
                          key={group.id}
                          className="flex items-center gap-2 px-3 py-2 bg-white rounded-lg border hover:border-gray-400 transition-colors cursor-pointer"
                          style={{ borderLeftColor: group.color, borderLeftWidth: '3px' }}
                        >
                          <IconComponent className="w-4 h-4" style={{ color: group.color }} />
                          <span className="text-sm font-medium">{group.name}</span>
                          <Badge variant="secondary" className="text-xs">{group.categories?.length || 0}</Badge>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Category Statistics */}
          <Card className="mt-6">
            <CardHeader className="py-4">
              <CardTitle className="text-lg">Category Statistics</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <div className="text-center p-4 bg-blue-50 rounded-lg">
                  <div className="text-3xl font-bold text-blue-600">{categoryGroups.length}</div>
                  <div className="text-sm text-gray-600">Groups</div>
                </div>
                <div className="text-center p-4 bg-green-50 rounded-lg">
                  <div className="text-3xl font-bold text-green-600">{categories.length}</div>
                  <div className="text-sm text-gray-600">Categories</div>
                </div>
                <div className="text-center p-4 bg-purple-50 rounded-lg">
                  <div className="text-3xl font-bold text-purple-600">{categories.filter(c => c.is_active).length}</div>
                  <div className="text-sm text-gray-600">Active</div>
                </div>
                <div className="text-center p-4 bg-orange-50 rounded-lg">
                  <div className="text-3xl font-bold text-orange-600">{categories.filter(c => c.show_on_homepage).length}</div>
                  <div className="text-sm text-gray-600">On Homepage</div>
                </div>
                <div className="text-center p-4 bg-indigo-50 rounded-lg">
                  <div className="text-3xl font-bold text-indigo-600">
                    {categories.reduce((acc, c) => acc + (c.product_count || 0), 0)}
                  </div>
                  <div className="text-sm text-gray-600">Total Products</div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Category List Preview */}
          <Card className="mt-6">
            <CardHeader className="py-4">
              <CardTitle className="text-lg">Category Listing Preview</CardTitle>
              <p className="text-sm text-gray-500">How categories might appear on a dedicated categories page</p>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {categories.filter(c => c.is_active).map((cat) => (
                  <div key={cat.id} className="group relative bg-white rounded-lg overflow-hidden border hover:shadow-lg transition-all cursor-pointer">
                    <div className="aspect-[4/3] bg-gray-100 relative overflow-hidden">
                      {cat.image_url ? (
                        <img src={normaliseImageUrl(cat.image_url)} alt={cat.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-gray-100 to-gray-200">
                          <Image className="w-12 h-12 text-gray-300" />
                        </div>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
                      <div className="absolute bottom-0 left-0 right-0 p-3">
                        <h3 className="font-semibold text-white">{cat.name}</h3>
                        <p className="text-white/80 text-sm">{cat.product_count || 0} products</p>
                      </div>
                    </div>
                    <div className="absolute top-2 right-2 flex gap-1">
                      {cat.show_on_homepage && (
                        <Badge className="bg-blue-500 text-xs">Featured</Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Group Dialog */}
      <Dialog open={showGroupDialog} onOpenChange={setShowGroupDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingGroup ? 'Edit Category Group' : 'Create Category Group'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Name</Label>
                <Input 
                  value={groupForm.name}
                  onChange={(e) => setGroupForm({ 
                    ...groupForm, 
                    name: e.target.value,
                    slug: editingGroup ? groupForm.slug : generateSlug(e.target.value)
                  })}
                  placeholder="e.g., Underfloor Heating"
                />
              </div>
              <div>
                <Label>Slug</Label>
                <Input 
                  value={groupForm.slug}
                  onChange={(e) => setGroupForm({ ...groupForm, slug: e.target.value })}
                />
              </div>
            </div>
            
            <div>
              <Label>Description</Label>
              <Input 
                value={groupForm.description}
                onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
                placeholder="Brief description of this category group"
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Icon</Label>
                <Select value={groupForm.icon} onValueChange={(v) => setGroupForm({ ...groupForm, icon: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {iconOptions.map(opt => {
                      const Icon = GroupIcons[opt.value] || FolderOpen;
                      return (
                        <SelectItem key={opt.value} value={opt.value}>
                          <div className="flex items-center gap-2">
                            <Icon className="w-4 h-4" />
                            {opt.label}
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Color</Label>
                <div className="flex gap-2">
                  <Input 
                    type="color"
                    value={groupForm.color}
                    onChange={(e) => setGroupForm({ ...groupForm, color: e.target.value })}
                    className="w-14 h-10 p-1"
                  />
                  <Input 
                    value={groupForm.color}
                    onChange={(e) => setGroupForm({ ...groupForm, color: e.target.value })}
                    placeholder="#3B82F6"
                    className="flex-1"
                  />
                </div>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
              <Switch 
                checked={groupForm.is_active}
                onCheckedChange={(checked) => setGroupForm({ ...groupForm, is_active: checked })}
              />
              <Label>Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGroupDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveGroup}><Save className="w-4 h-4 mr-2" />Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Category Dialog */}
      <Dialog open={showCategoryForm} onOpenChange={setShowCategoryForm}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingCategory ? 'Edit Category' : 'Create Category'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Name</Label>
                <Input 
                  value={categoryForm.name}
                  onChange={(e) => setCategoryForm({ 
                    ...categoryForm, 
                    name: e.target.value,
                    slug: editingCategory ? categoryForm.slug : generateSlug(e.target.value)
                  })}
                  placeholder="e.g., Floor Tiles"
                />
              </div>
              <div>
                <Label>Slug</Label>
                <Input 
                  value={categoryForm.slug}
                  onChange={(e) => setCategoryForm({ ...categoryForm, slug: e.target.value })}
                />
              </div>
            </div>
            
            <div>
              <Label>Category Group</Label>
              <Select 
                value={categoryForm.group_slug || 'tiles'} 
                onValueChange={(v) => setCategoryForm({ ...categoryForm, group_slug: v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {categoryGroups.map(group => (
                    <SelectItem key={group.slug} value={group.slug}>{group.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <div>
              <Label>Description</Label>
              <Textarea 
                value={categoryForm.description}
                onChange={(e) => setCategoryForm({ ...categoryForm, description: e.target.value })}
                placeholder="Category description"
                rows={2}
              />
            </div>
            
            <div>
              <Label>Image URL</Label>
              <Input 
                value={categoryForm.image_url}
                onChange={(e) => setCategoryForm({ ...categoryForm, image_url: e.target.value })}
                placeholder="https://..."
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>SEO Title</Label>
                <Input 
                  value={categoryForm.seo_title}
                  onChange={(e) => setCategoryForm({ ...categoryForm, seo_title: e.target.value })}
                />
              </div>
              <div>
                <Label>Display Order</Label>
                <Input 
                  type="number"
                  value={categoryForm.display_order}
                  onChange={(e) => setCategoryForm({ ...categoryForm, display_order: parseInt(e.target.value) || 0 })}
                />
              </div>
            </div>
            
            <div>
              <Label>SEO Description</Label>
              <Textarea 
                value={categoryForm.seo_description}
                onChange={(e) => setCategoryForm({ ...categoryForm, seo_description: e.target.value })}
                rows={2}
              />
            </div>
            
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <Switch 
                  checked={categoryForm.is_active}
                  onCheckedChange={(checked) => setCategoryForm({ ...categoryForm, is_active: checked })}
                />
                <Label>Active</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch 
                  checked={categoryForm.show_on_homepage}
                  onCheckedChange={(checked) => setCategoryForm({ ...categoryForm, show_on_homepage: checked })}
                />
                <Label>Show on Homepage</Label>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCategoryForm(false)}>Cancel</Button>
            <Button onClick={handleSaveCategory}><Save className="w-4 h-4 mr-2" />Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default WebsiteCategoriesManager;
