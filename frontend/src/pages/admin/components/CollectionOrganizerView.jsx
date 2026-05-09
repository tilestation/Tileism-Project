import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Loader2, ChevronDown, ChevronRight, GripVertical, X, Check,
  Package, Layers, Search, Image, FolderOpen, ArrowRight,
  CheckSquare, Square, FolderPlus
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { toast } from 'sonner';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { normaliseImageUrl } from '../../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Color map for group icons
const GROUP_COLORS = {
  'tiles': { bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', accent: '#3B82F6' },
  'flooring': { bg: 'bg-violet-50', text: 'text-violet-700', border: 'border-violet-200', accent: '#8B5CF6' },
  'underfloor-heating': { bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', accent: '#EF4444' },
  'materials': { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', accent: '#10B981' },
  'tools': { bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', accent: '#F59E0B' },
  'accessories': { bg: 'bg-pink-50', text: 'text-pink-700', border: 'border-pink-200', accent: '#EC4899' },
};

const getGroupColor = (slug) => GROUP_COLORS[slug] || { bg: 'bg-gray-50', text: 'text-gray-700', border: 'border-gray-200', accent: '#6B7280' };

export default function CollectionOrganizerView() {
  const [suppliers, setSuppliers] = useState([]);
  const [selectedSupplier, setSelectedSupplier] = useState('');
  const [series, setSeries] = useState([]);
  const [categoryTree, setCategoryTree] = useState([]);
  const [loading, setLoading] = useState(true);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [assigning, setAssigning] = useState(null);
  const [seriesSearch, setSeriesSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState({});
  const [selectedSeries, setSelectedSeries] = useState(new Set());
  const [selectedTargets, setSelectedTargets] = useState(new Set());
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [targetDropdownOpen, setTargetDropdownOpen] = useState(false);
  const [relevantGroups, setRelevantGroups] = useState([]);
  const [ungroupedCount, setUngroupedCount] = useState(0);

  // Load suppliers + category tree on mount
  useEffect(() => {
    const load = async () => {
      try {
        const token = localStorage.getItem('token');
        const headers = { 'Authorization': `Bearer ${token}` };
        const [suppRes, catRes] = await Promise.all([
          fetch(`${API_URL}/api/website-admin/collection-organizer/suppliers`, { headers }),
          fetch(`${API_URL}/api/website-admin/collection-organizer/category-tree`, { headers }),
        ]);
        if (suppRes.ok) {
          const d = await suppRes.json();
          setSuppliers(d.suppliers || []);
        }
        if (catRes.ok) {
          const d = await catRes.json();
          setCategoryTree(d.groups || []);
          // Expand all groups by default
          const expanded = {};
          (d.groups || []).forEach(g => { expanded[g.slug] = true; });
          setExpandedGroups(expanded);
        }
      } catch (e) {
        toast.error('Failed to load data');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Load series when supplier changes
  useEffect(() => {
    if (!selectedSupplier) {
      setSeries([]);
      return;
    }
    const loadSeries = async () => {
      setSeriesLoading(true);
      try {
        const token = localStorage.getItem('token');
        const res = await fetch(
          `${API_URL}/api/website-admin/collection-organizer/series?supplier=${encodeURIComponent(selectedSupplier)}`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        if (res.ok) {
          const d = await res.json();
          setSeries(d.series || []);
          setRelevantGroups(d.relevant_groups || []);
          setUngroupedCount(d.ungrouped_count || 0);
        }
      } catch {
        toast.error('Failed to load series');
      } finally {
        setSeriesLoading(false);
      }
    };
    loadSeries();
  }, [selectedSupplier]);

  const filteredSeries = useMemo(() => {
    if (!seriesSearch.trim()) return series;
    const q = seriesSearch.toLowerCase();
    return series.filter(s => (s.name || '').toLowerCase().includes(q) ||
      (s.product_names || []).some(pn => (pn || '').toLowerCase().includes(q)));
  }, [series, seriesSearch]);

  // Build a map: categorySlug -> [series names assigned to it]
  const assignmentMap = useMemo(() => {
    const map = {};
    for (const s of series) {
      for (const sc of (s.sub_categories || [])) {
        if (!map[sc]) map[sc] = [];
        map[sc].push(s);
      }
      // Also map to main_category group level if no sub_categories
      for (const mc of (s.main_categories || [])) {
        const key = `__group__${mc}`;
        if (!map[key]) map[key] = [];
        map[key].push(s);
      }
    }
    return map;
  }, [series]);

  const handleDragEnd = useCallback(async (result) => {
    if (!result.destination || !selectedSupplier) return;
    const destId = result.destination.droppableId;
    if (destId === 'series-source') return;

    // Parse destination: "group_slug::category_name" or "group_slug::__group__"
    const [groupSlug, catName] = destId.split('::');
    const group = categoryTree.find(g => g.slug === groupSlug);
    if (!group) return;

    const seriesName = result.draggableId;
    const isGroupLevel = catName === '__group__';
    const subCategories = isGroupLevel ? [] : [catName];

    setAssigning(seriesName);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/collection-organizer/assign`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier: selectedSupplier,
          series: seriesName,
          group_slug: groupSlug,
          main_category: group.name,
          sub_categories: subCategories,
        }),
      });
      if (res.ok) {
        const d = await res.json();
        toast.success(d.message);
        // Refresh series data
        const seriesRes = await fetch(
          `${API_URL}/api/website-admin/collection-organizer/series?supplier=${encodeURIComponent(selectedSupplier)}`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        if (seriesRes.ok) {
          const sd = await seriesRes.json();
          setSeries(sd.series || []);
        }
      } else {
        const err = await res.json();
        toast.error(err.detail || 'Failed to assign');
      }
    } catch {
      toast.error('Failed to assign series');
    } finally {
      setAssigning(null);
    }
  }, [selectedSupplier, categoryTree]);

  const handleUnassign = useCallback(async (seriesName, mainCategory, subCategory) => {
    if (!selectedSupplier) return;
    setAssigning(seriesName);
    try {
      const token = localStorage.getItem('token');
      const body = {
        supplier: selectedSupplier,
        series: seriesName,
        main_category: mainCategory,
      };
      if (subCategory) {
        body.sub_categories = [subCategory];
      }
      const res = await fetch(`${API_URL}/api/website-admin/collection-organizer/unassign`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const d = await res.json();
        toast.success(d.message);
        // Refresh
        const seriesRes = await fetch(
          `${API_URL}/api/website-admin/collection-organizer/series?supplier=${encodeURIComponent(selectedSupplier)}`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        if (seriesRes.ok) {
          const sd = await seriesRes.json();
          setSeries(sd.series || []);
        }
      } else {
        toast.error('Failed to unassign');
      }
    } catch {
      toast.error('Failed to unassign');
    } finally {
      setAssigning(null);
    }
  }, [selectedSupplier]);

  // ---- Click-to-Assign (bypasses DnD) ----
  const [assignMenuOpen, setAssignMenuOpen] = useState(null); // series name or null
  const assignMenuRef = useRef(null);

  const handleClickAssign = useCallback(async (seriesName, groupSlug, groupName, subCategories) => {
    if (!selectedSupplier) return;
    setAssigning(seriesName);
    setAssignMenuOpen(null);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/collection-organizer/assign`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier: selectedSupplier,
          series: seriesName,
          group_slug: groupSlug,
          main_category: groupName,
          sub_categories: subCategories,
        }),
      });
      if (res.ok) {
        const d = await res.json();
        toast.success(d.message);
        const seriesRes = await fetch(
          `${API_URL}/api/website-admin/collection-organizer/series?supplier=${encodeURIComponent(selectedSupplier)}`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        if (seriesRes.ok) {
          const sd = await seriesRes.json();
          setSeries(sd.series || []);
        }
      } else {
        const err = await res.json().catch(() => ({}));
        toast.error(err.detail || 'Failed to assign');
      }
    } catch {
      toast.error('Failed to assign series');
    } finally {
      setAssigning(null);
    }
  }, [selectedSupplier]);

  // Close assign menu on outside click
  useEffect(() => {
    const handler = (e) => {
      if (assignMenuRef.current && !assignMenuRef.current.contains(e.target)) {
        setAssignMenuOpen(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ---- Bulk Selection ----
  const toggleSeriesSelect = (name) => {
    setSelectedSeries(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectAllSeries = () => {
    if (selectedSeries.size === filteredSeries.length) {
      setSelectedSeries(new Set());
    } else {
      setSelectedSeries(new Set(filteredSeries.map(s => s.name)));
    }
  };

  // Clear selection when supplier changes
  useEffect(() => { setSelectedSeries(new Set()); setSelectedTargets(new Set()); }, [selectedSupplier]);

  // Filter category tree to show relevant groups for the selected supplier
  const filteredCategoryTree = useMemo(() => {
    // If no supplier selected or no relevant groups data, show all
    if (!selectedSupplier || relevantGroups.length === 0) return categoryTree;
    // Show groups that match the supplier's product_group values, plus any with assigned series
    return categoryTree.filter(group => {
      // Always show if supplier has products in this group
      if (relevantGroups.includes(group.slug)) return true;
      // Also show if any of the supplier's series are assigned to categories in this group
      const hasAssigned = series.some(s =>
        (s.main_categories || []).includes(group.name)
      );
      return hasAssigned;
    });
  }, [categoryTree, relevantGroups, selectedSupplier, series]);

  // Build flat list of targets for the bulk dropdown
  const bulkTargetOptions = useMemo(() => {
    const opts = [];
    for (const group of filteredCategoryTree) {
      if (group.categories && group.categories.length > 0) {
        for (const cat of group.categories) {
          opts.push({ groupSlug: group.slug, groupName: group.name, categoryName: cat.name, label: `${group.name} > ${cat.name}` });
        }
      } else {
        opts.push({ groupSlug: group.slug, groupName: group.name, categoryName: '', label: group.name });
      }
    }
    return opts;
  }, [filteredCategoryTree]);

  const handleBulkAssign = useCallback(async () => {
    if (selectedSeries.size === 0 || selectedTargets.size === 0 || !selectedSupplier) return;

    // Build targets array from selected target keys
    const targets = [];
    for (const key of selectedTargets) {
      const opt = bulkTargetOptions.find(o => `${o.groupSlug}::${o.categoryName}` === key);
      if (opt) {
        targets.push({
          group_slug: opt.groupSlug,
          main_category: opt.groupName,
          sub_categories: opt.categoryName ? [opt.categoryName] : [],
        });
      }
    }
    if (targets.length === 0) { toast.error('Select at least one target category'); return; }

    setBulkAssigning(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/collection-organizer/bulk-assign`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          supplier: selectedSupplier,
          series_names: Array.from(selectedSeries),
          targets,
        }),
      });
      if (res.ok) {
        const d = await res.json();
        toast.success(d.message);
        setSelectedSeries(new Set());
        setSelectedTargets(new Set());
        setTargetDropdownOpen(false);
        // Refresh
        const seriesRes = await fetch(
          `${API_URL}/api/website-admin/collection-organizer/series?supplier=${encodeURIComponent(selectedSupplier)}`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        if (seriesRes.ok) {
          const sd = await seriesRes.json();
          setSeries(sd.series || []);
        }
      } else {
        const err = await res.json();
        toast.error(err.detail || 'Bulk assign failed');
      }
    } catch {
      toast.error('Bulk assign failed');
    } finally {
      setBulkAssigning(false);
    }
  }, [selectedSeries, selectedTargets, selectedSupplier, bulkTargetOptions]);

  const toggleGroup = (slug) => {
    setExpandedGroups(prev => ({ ...prev, [slug]: !prev[slug] }));
  };

  if (loading) {
    return <div className="flex items-center justify-center h-[50vh]"><Loader2 className="w-8 h-8 animate-spin text-gray-400" /></div>;
  }

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="bg-gray-50 flex flex-col" style={{ height: 'calc(100vh - 140px)' }} data-testid="collection-organizer">
        {/* Supplier selector */}
        <div className="bg-white border-b px-5 py-3 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-gray-500" />
            <span className="text-sm font-medium text-gray-700">Supplier:</span>
          </div>
          <select
            value={selectedSupplier}
            onChange={(e) => setSelectedSupplier(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm bg-white min-w-[200px] focus:ring-2 focus:ring-indigo-200 focus:border-indigo-400 outline-none"
            data-testid="supplier-select"
          >
            <option value="">Select a supplier...</option>
            {suppliers.map(s => (
              <option key={s.name} value={s.name}>
                {s.name} ({s.total_products} products, {s.series_count} series)
              </option>
            ))}
          </select>
          {selectedSupplier && (
            <div className="flex items-center gap-2 ml-auto">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
                <Input
                  value={seriesSearch}
                  onChange={(e) => setSeriesSearch(e.target.value)}
                  placeholder="Filter series..."
                  className="pl-8 h-8 text-sm w-48 bg-gray-50"
                  data-testid="series-search"
                />
              </div>
              <span className="text-xs text-gray-400">
                {filteredSeries.length} series
              </span>
            </div>
          )}
        </div>

        {/* Main content: series left, categories right */}
        {!selectedSupplier ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center py-16">
              <FolderOpen className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500 font-medium">Select a supplier to get started</p>
              <p className="text-gray-400 text-sm mt-1">Choose a supplier from the dropdown to see their collections</p>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex min-h-0 overflow-hidden">
            {/* LEFT: Series cards (draggable) */}
            <div className="w-80 flex-shrink-0 border-r bg-white flex flex-col">
              <div className="px-4 py-3 border-b bg-gray-50/50">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold text-gray-900 text-sm">Collections (Series)</h3>
                    <p className="text-xs text-gray-400 mt-0.5">Drag or select to assign</p>
                  </div>
                  {filteredSeries.length > 0 && (
                    <button
                      onClick={selectAllSeries}
                      className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 transition-colors"
                      data-testid="select-all-series"
                    >
                      {selectedSeries.size === filteredSeries.length
                        ? <><CheckSquare className="w-3.5 h-3.5 text-indigo-500" /> Deselect</>
                        : <><Square className="w-3.5 h-3.5" /> All</>}
                    </button>
                  )}
                </div>
              </div>
              <Droppable droppableId="series-source">
                {(provided) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className="flex-1 overflow-auto p-2 space-y-1"
                  >
                    {seriesLoading ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                      </div>
                    ) : filteredSeries.length === 0 ? (
                      <div className="text-center py-12 text-gray-400 text-xs px-4">
                        {series.length === 0
                          ? ungroupedCount > 0
                            ? `This supplier has ${ungroupedCount} products without series names. Assign series names in the Products editor first.`
                            : 'This supplier has no series data.'
                          : 'No series match your search.'}
                      </div>
                    ) : (
                      <>
                      {ungroupedCount > 0 && (
                        <div className="mx-1 mb-1 p-2 rounded-md bg-amber-50 border border-amber-200 text-[10px] text-amber-700">
                          {ungroupedCount} product{ungroupedCount !== 1 ? 's' : ''} without series names (not shown)
                        </div>
                      )}
                      {filteredSeries.map((s, index) => {
                        const isSelected = selectedSeries.has(s.name);
                        const safeName = s.name || `ungrouped-${index}`;
                        const safeSlug = safeName.toLowerCase().replace(/\s+/g, '-');
                        return (
                        <Draggable key={safeName} draggableId={safeName} index={index}>
                          {(provided, snapshot) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              {...provided.dragHandleProps}
                              className={`rounded-lg border transition-all ${
                                snapshot.isDragging
                                  ? 'bg-indigo-50 border-indigo-300 shadow-xl ring-2 ring-indigo-200'
                                  : isSelected
                                    ? 'bg-indigo-50/40 border-indigo-200'
                                    : 'bg-white border-gray-200 hover:border-gray-300 hover:shadow-sm'
                              } ${assigning === s.name ? 'opacity-50' : ''}`}
                              data-testid={`series-card-${safeSlug}`}
                            >
                              <div className="flex items-start gap-2 px-3 py-2.5">
                                {/* Checkbox */}
                                <button
                                  onClick={(e) => { e.stopPropagation(); toggleSeriesSelect(s.name); }}
                                  className="flex-shrink-0 mt-0.5"
                                  data-testid={`select-series-${safeSlug}`}
                                >
                                  {isSelected
                                    ? <CheckSquare className="w-4 h-4 text-indigo-500" />
                                    : <Square className="w-4 h-4 text-gray-300 hover:text-gray-400" />}
                                </button>
                                <GripVertical className="w-3.5 h-3.5 text-gray-300 mt-0.5 flex-shrink-0" />
                                {s.sample_image ? (
                                  <img src={normaliseImageUrl(s.sample_image)} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
                                ) : (
                                  <div className="w-8 h-8 rounded bg-gray-100 flex items-center justify-center flex-shrink-0">
                                    <Image className="w-4 h-4 text-gray-300" />
                                  </div>
                                )}
                                <div className="flex-1 min-w-0">
                                  <span className="font-medium text-gray-800 text-xs block truncate">{s.name || 'Ungrouped'}</span>
                                  <span className="text-[10px] text-gray-400">{s.count} product{s.count !== 1 ? 's' : ''}</span>
                                  {/* Show product names */}
                                  {s.product_names && s.product_names.length > 0 && (
                                    <div className="mt-0.5 space-y-0">
                                      {s.product_names.map((pn, i) => (
                                        <span key={i} className="text-[10px] text-gray-500 block truncate">{pn}</span>
                                      ))}
                                      {s.count > s.product_names.length && (
                                        <span className="text-[10px] text-gray-300">+{s.count - s.product_names.length} more</span>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </div>
                              {/* Show current assignments as tiny badges */}
                              {s.sub_categories && s.sub_categories.length > 0 && (
                                <div className="px-3 pb-2 flex flex-wrap gap-1">
                                  {s.sub_categories.map(sc => (
                                    <span
                                      key={sc}
                                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200"
                                    >
                                      {sc}
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          e.preventDefault();
                                          handleUnassign(s.name, s.main_categories?.[0], sc);
                                        }}
                                        className="hover:text-red-500 transition-colors"
                                        data-testid={`unassign-${s.name.toLowerCase().replace(/\s+/g, '-')}-${sc.toLowerCase().replace(/\s+/g, '-')}`}
                                      >
                                        <X className="w-2.5 h-2.5" />
                                      </button>
                                    </span>
                                  ))}
                                </div>
                              )}
                              {s.main_categories && s.main_categories.length > 0 && (!s.sub_categories || s.sub_categories.length === 0) && (
                                <div className="px-3 pb-2">
                                  <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                                    {s.main_categories[0]}
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        e.preventDefault();
                                        handleUnassign(s.name, s.main_categories[0]);
                                      }}
                                      className="hover:text-red-500 transition-colors"
                                    >
                                      <X className="w-2.5 h-2.5" />
                                    </button>
                                  </span>
                                </div>
                              )}
                              {/* Click-to-assign button */}
                              <div className="px-3 pb-2 relative">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    e.preventDefault();
                                    setAssignMenuOpen(prev => prev === s.name ? null : s.name);
                                  }}
                                  className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-indigo-50 text-indigo-600 border border-indigo-200 hover:bg-indigo-100 transition-colors"
                                  data-testid={`assign-btn-${safeSlug}`}
                                >
                                  <FolderPlus className="w-3 h-3" /> Assign to...
                                </button>
                                {assignMenuOpen === s.name && (
                                  <div
                                    ref={assignMenuRef}
                                    className="absolute left-3 top-full z-50 mt-1 w-64 bg-white rounded-lg shadow-xl border border-gray-200 max-h-72 overflow-auto"
                                    data-testid={`assign-menu-${safeSlug}`}
                                  >
                                    {categoryTree.map(group => (
                                      <div key={group.slug}>
                                        <div className="px-3 py-1.5 text-[10px] font-bold text-gray-400 uppercase tracking-wide bg-gray-50 sticky top-0">
                                          {group.name}
                                        </div>
                                        {(group.categories || []).map(cat => {
                                          const alreadyAssigned = (s.sub_categories || []).includes(cat.name);
                                          return (
                                            <button
                                              key={cat.id || cat.slug}
                                              disabled={alreadyAssigned || assigning === s.name}
                                              onMouseDown={(e) => {
                                                e.stopPropagation();
                                                e.preventDefault();
                                                handleClickAssign(s.name, group.slug, group.name, [cat.name]);
                                              }}
                                              className={`w-full text-left px-4 py-1.5 text-xs transition-colors ${
                                                alreadyAssigned
                                                  ? 'text-green-600 bg-green-50 cursor-default'
                                                  : 'text-gray-700 hover:bg-indigo-50 hover:text-indigo-700'
                                              }`}
                                              data-testid={`assign-${safeSlug}-to-${cat.slug}`}
                                            >
                                              {alreadyAssigned ? '✓ ' : ''}{cat.name}
                                            </button>
                                          );
                                        })}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </Draggable>
                      );
                      })}
                      </>
                    )}
                    {provided.placeholder}
                  </div>
                )}
              </Droppable>
            </div>

            {/* RIGHT: Category tree drop zones */}
            <div className="flex-1 p-4 space-y-3 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
              {filteredCategoryTree.length === 0 ? (
                <div className="text-center py-16 text-gray-400">
                  <p>No relevant categories found for this supplier.</p>
                  <p className="text-sm mt-1">Assign products to a group first, or check Website Settings.</p>
                </div>
              ) : (
                filteredCategoryTree.map(group => (
                  <CategoryGroupDropZone
                    key={group.slug}
                    group={group}
                    expanded={expandedGroups[group.slug] !== false}
                    onToggle={() => toggleGroup(group.slug)}
                    assignmentMap={assignmentMap}
                    selectedSupplier={selectedSupplier}
                    onUnassign={handleUnassign}
                    assigning={assigning}
                  />
                ))
              )}
            </div>
          </div>
        )}

        {/* ========== BULK ASSIGN BAR (bottom) ========== */}
        {selectedSeries.size > 0 && selectedSupplier && (
          <div className="fixed bottom-0 left-0 right-0 md:right-64 bg-gray-900 text-white px-5 py-3 flex items-center justify-between shadow-2xl z-50 border-t border-gray-700" data-testid="bulk-assign-bar">
            <div className="flex items-center gap-3">
              <CheckSquare className="w-4 h-4 text-indigo-400" />
              <span className="text-sm font-medium">{selectedSeries.size} collection{selectedSeries.size !== 1 ? 's' : ''} selected</span>
              <button onClick={() => setSelectedSeries(new Set())} className="text-xs text-gray-400 hover:text-white underline" data-testid="clear-selection">Clear</button>
            </div>
            <div className="flex items-center gap-3">
              {/* Multi-select category picker */}
              <div className="relative">
                <button
                  onClick={() => setTargetDropdownOpen(prev => !prev)}
                  className="bg-gray-800 text-white border border-gray-600 rounded-lg px-3 py-1.5 text-sm min-w-[220px] flex items-center justify-between gap-2 hover:border-gray-400 transition-colors"
                  data-testid="bulk-target-select"
                >
                  <span className="truncate">
                    {selectedTargets.size === 0 ? 'Select categories...' : `${selectedTargets.size} categor${selectedTargets.size === 1 ? 'y' : 'ies'} selected`}
                  </span>
                  <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${targetDropdownOpen ? 'rotate-180' : ''}`} />
                </button>
                {targetDropdownOpen && (
                  <div className="absolute bottom-full mb-1 right-0 w-72 max-h-64 overflow-auto bg-gray-800 border border-gray-600 rounded-lg shadow-2xl" data-testid="target-dropdown">
                    {filteredCategoryTree.map(group => (
                      <div key={group.slug}>
                        <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400 bg-gray-750 border-b border-gray-700 sticky top-0 bg-gray-800">
                          {group.name}
                        </div>
                        {group.categories && group.categories.length > 0 ? (
                          group.categories.map(cat => {
                            const key = `${group.slug}::${cat.name}`;
                            const isChecked = selectedTargets.has(key);
                            return (
                              <button
                                key={key}
                                onClick={() => {
                                  setSelectedTargets(prev => {
                                    const next = new Set(prev);
                                    if (next.has(key)) next.delete(key);
                                    else next.add(key);
                                    return next;
                                  });
                                }}
                                className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-700 transition-colors ${isChecked ? 'text-indigo-300' : 'text-gray-300'}`}
                                data-testid={`target-option-${group.slug}-${cat.name.toLowerCase().replace(/\s+/g, '-')}`}
                              >
                                {isChecked
                                  ? <CheckSquare className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />
                                  : <Square className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />}
                                <span className="truncate">{cat.name}</span>
                              </button>
                            );
                          })
                        ) : (
                          <button
                            onClick={() => {
                              const key = `${group.slug}::`;
                              setSelectedTargets(prev => {
                                const next = new Set(prev);
                                if (next.has(key)) next.delete(key);
                                else next.add(key);
                                return next;
                              });
                            }}
                            className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-700 transition-colors ${selectedTargets.has(`${group.slug}::`) ? 'text-indigo-300' : 'text-gray-300'}`}
                          >
                            {selectedTargets.has(`${group.slug}::`)
                              ? <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
                              : <Square className="w-3.5 h-3.5 text-gray-500" />}
                            <span>{group.name} (group level)</span>
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <Button
                size="sm"
                onClick={handleBulkAssign}
                disabled={selectedTargets.size === 0 || bulkAssigning}
                className="bg-indigo-600 hover:bg-indigo-700 text-white h-8 px-4"
                data-testid="bulk-assign-btn"
              >
                {bulkAssigning ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Check className="w-3.5 h-3.5 mr-1.5" />}
                Assign {selectedSeries.size} to {selectedTargets.size || '...'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </DragDropContext>
  );
}

// ============ CATEGORY GROUP DROP ZONE ============
function CategoryGroupDropZone({ group, expanded, onToggle, assignmentMap, selectedSupplier, onUnassign, assigning }) {
  const colors = getGroupColor(group.slug);
  const hasCategories = group.categories && group.categories.length > 0;

  return (
    <div className={`rounded-xl border ${colors.border} overflow-hidden`} data-testid={`group-zone-${group.slug}`}>
      {/* Group header */}
      <button
        onClick={onToggle}
        className={`w-full flex items-center justify-between px-4 py-3 transition-colors ${colors.bg} hover:opacity-90`}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="w-3 h-3 rounded-full flex-shrink-0"
            style={{ backgroundColor: group.color || colors.accent }}
          />
          <span className={`font-semibold text-sm ${colors.text}`}>{group.name}</span>
          <span className="text-xs text-gray-400 bg-white/60 px-2 py-0.5 rounded-full">
            {group.categories?.length || 0} categories
          </span>
        </div>
        {expanded ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
      </button>

      {expanded && (
        <div className="bg-white">
          {/* Group-level drop zone (if no sub-categories, drop directly to group) */}
          {!hasCategories && (
            <Droppable droppableId={`${group.slug}::__group__`}>
              {(provided, snapshot) => (
                <div
                  ref={provided.innerRef}
                  {...provided.droppableProps}
                  className={`p-3 min-h-[80px] transition-colors ${
                    snapshot.isDraggingOver ? 'bg-indigo-50' : ''
                  }`}
                >
                  <AssignedSeriesList
                    items={assignmentMap[`__group__${group.name}`] || []}
                    groupName={group.name}
                    onUnassign={onUnassign}
                    assigning={assigning}
                  />
                  {!(assignmentMap[`__group__${group.name}`]?.length) && !snapshot.isDraggingOver && (
                    <div className="flex items-center justify-center py-4 text-gray-300 text-xs">
                      <ArrowRight className="w-3 h-3 mr-1" /> Drop collections here
                    </div>
                  )}
                  {snapshot.isDraggingOver && (
                    <div className="flex items-center justify-center py-3 text-indigo-500 text-xs font-medium animate-pulse">
                      Release to assign to {group.name}
                    </div>
                  )}
                  {provided.placeholder}
                </div>
              )}
            </Droppable>
          )}

          {/* Category sub-rows as individual drop zones */}
          {hasCategories && (
            <div className="divide-y divide-gray-100">
              {group.categories.map(cat => (
                <CategoryDropZone
                  key={cat.id || cat.slug}
                  category={cat}
                  groupSlug={group.slug}
                  groupName={group.name}
                  assignedSeries={assignmentMap[cat.name] || []}
                  onUnassign={onUnassign}
                  assigning={assigning}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============ INDIVIDUAL CATEGORY DROP ZONE ============
function CategoryDropZone({ category, groupSlug, groupName, assignedSeries, onUnassign, assigning }) {
  return (
    <Droppable droppableId={`${groupSlug}::${category.name}`}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.droppableProps}
          className={`flex items-start gap-3 px-4 py-2.5 min-h-[48px] transition-colors ${
            snapshot.isDraggingOver ? 'bg-indigo-50/70' : 'hover:bg-gray-50/50'
          }`}
          data-testid={`category-zone-${category.slug}`}
        >
          {/* Category label */}
          <div className="w-36 flex-shrink-0 pt-0.5">
            <span className="text-sm font-medium text-gray-700">{category.name}</span>
          </div>

          {/* Drop area with assigned series */}
          <div className="flex-1 min-h-[32px] flex items-center flex-wrap gap-1.5">
            {assignedSeries.map(s => (
              <span
                key={s.name}
                className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 ${
                  assigning === s.name ? 'opacity-50' : ''
                }`}
                data-testid={`assigned-${s.name.toLowerCase().replace(/\s+/g, '-')}-in-${category.slug}`}
              >
                <Layers className="w-3 h-3" />
                {s.name}
                <span className="text-[10px] text-emerald-500">({s.count})</span>
                <button
                  onClick={() => onUnassign(s.name, groupName, category.name)}
                  className="p-0.5 rounded hover:bg-red-100 hover:text-red-500 transition-colors"
                  title={`Remove ${s.name} from ${category.name}`}
                  data-testid={`remove-${s.name.toLowerCase().replace(/\s+/g, '-')}-from-${category.slug}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
            {assignedSeries.length === 0 && !snapshot.isDraggingOver && (
              <span className="text-xs text-gray-300 italic">Drop collections here</span>
            )}
            {snapshot.isDraggingOver && (
              <span className="text-xs text-indigo-500 font-medium animate-pulse">
                Release to assign to {category.name}
              </span>
            )}
            {provided.placeholder}
          </div>
        </div>
      )}
    </Droppable>
  );
}

// ============ ASSIGNED SERIES LIST (for group-level) ============
function AssignedSeriesList({ items, groupName, onUnassign, assigning }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {items.map(s => (
        <span
          key={s.name}
          className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md bg-blue-50 text-blue-700 border border-blue-200 ${
            assigning === s.name ? 'opacity-50' : ''
          }`}
        >
          <Layers className="w-3 h-3" />
          {s.name}
          <span className="text-[10px] text-blue-500">({s.count})</span>
          <button
            onClick={() => onUnassign(s.name, groupName)}
            className="p-0.5 rounded hover:bg-red-100 hover:text-red-500 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
