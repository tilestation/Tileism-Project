/**
 * CustomManager — thin wrapper around ManagerPageShell.
 *
 * Reads a `manager_definitions` doc from the API and hands its metadata
 * (name, theme, sub_categories, keywords, field_definitions) to the shared
 * shell. Adds two custom-only pieces:
 *   1. Delete-manager button in the header
 *   2. Sub-category chips banner at the top of the body
 *
 * URL: /admin/custom-manager/:slug
 * Everything else — filters, sub-tabs, spec fields, presets, CSV import,
 * bulk actions, draft recovery, edit modal — lives inside ManagerPageShell.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft, RefreshCw, AlertCircle, Sparkles, Trash2, Plus,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../components/ui/dialog';

import ManagerTabsBar from './components/managers/ManagerTabsBar';
import CustomManagerBuilder from './components/managers/CustomManagerBuilder';
import ManagerPageShell from './components/ManagerPageShell';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Classification: a product belongs to a custom Manager if any of its sub_categories
// (or product_group) matches any of the definition's keywords (case-insensitive contains).
function matchesDefinition(p, def) {
  if (!def) return false;
  const group = String(p.product_group || '').toLowerCase();
  if (def.product_group && group === String(def.product_group).toLowerCase()) return true;
  if (def.product_group && group === def.slug.toLowerCase()) return true;
  if (!Array.isArray(def.sub_categories) || def.sub_categories.length === 0) return false;
  const subCats = (Array.isArray(p.sub_categories) ? p.sub_categories : []).map(s => String(s).toLowerCase());
  const nameLc = String(p.our_product_name || p.product_name || p.name || '').toLowerCase();
  return def.sub_categories.some(keyword => {
    const k = String(keyword).toLowerCase();
    return subCats.some(sc => sc.includes(k)) || nameLc.includes(k);
  });
}

const CustomManager = () => {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [definition, setDefinition] = useState(null);
  const [defLoading, setDefLoading] = useState(true);
  const [defError, setDefError] = useState(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const fetchDefinition = useCallback(async () => {
    setDefLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/manager-definitions/${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error(res.status === 404 ? 'This custom Manager doesn\'t exist' : `HTTP ${res.status}`);
      const def = await res.json();
      setDefinition(def);
      setDefError(null);
    } catch (err) {
      setDefError(err.message);
    } finally {
      setDefLoading(false);
    }
  }, [slug]);

  useEffect(() => { fetchDefinition(); }, [fetchDefinition]);

  const handleDeleteManager = async () => {
    if (!definition) return;
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/manager-definitions/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`Deleted Manager "${definition.name}"`);
      navigate('/admin/supplier-products');
    } catch (err) {
      toast.error(`Delete failed: ${err.message}`);
    }
  };

  // ---- Predicate + config derived from the definition ----
  const isMatch = useCallback((p) => matchesDefinition(p, definition), [definition]);
  const fallbackEditFields = useMemo(() => (
    definition?.field_definitions?.length ? definition.field_definitions : [
      { key: 'color',       label: 'Colour',      type: 'text' },
      { key: 'size',        label: 'Size',        type: 'text' },
      { key: 'material',    label: 'Material',    type: 'text' },
      { key: 'finish',      label: 'Finish',      type: 'text' },
      { key: 'suitability', label: 'Suitability', type: 'text' },
    ]
  ), [definition]);

  // ---- Loading / error states ----
  if (defLoading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <ManagerTabsBar active={`custom:${slug}`} onNewCustom={() => setBuilderOpen(true)} />
        <div className="max-w-7xl mx-auto px-4 py-12 text-center">
          <RefreshCw className="w-6 h-6 mx-auto animate-spin text-gray-400" />
          <p className="mt-2 text-sm text-gray-500">Loading Manager…</p>
        </div>
      </div>
    );
  }

  if (defError || !definition) {
    return (
      <div className="min-h-screen bg-gray-50">
        <ManagerTabsBar active={`custom:${slug}`} onNewCustom={() => setBuilderOpen(true)} />
        <div className="max-w-md mx-auto mt-16 bg-white border border-red-200 rounded-lg p-8 text-center">
          <AlertCircle className="w-8 h-8 mx-auto text-red-500 mb-2" />
          <p className="text-lg font-semibold text-red-700">{defError || 'Manager not found'}</p>
          <p className="text-xs text-gray-500 mt-1">Slug: <code>{slug}</code></p>
          <div className="mt-4 flex gap-2 justify-center">
            <Link to="/admin/supplier-products">
              <Button variant="outline"><ArrowLeft className="w-4 h-4 mr-1" /> Back to Products</Button>
            </Link>
            <Button onClick={() => setBuilderOpen(true)} className="bg-purple-600 text-white">
              <Plus className="w-4 h-4 mr-1" /> Create a new one
            </Button>
          </div>
        </div>
        <CustomManagerBuilder open={builderOpen} onOpenChange={setBuilderOpen} />
      </div>
    );
  }

  // ---- Slots injected into the shell ----
  const themeKey = definition.theme || 'slate';
  const bulkTheme = themeKey === 'purple' ? 'orange' : themeKey;  // ManagerBulkBar doesn't know purple

  const extraHeaderActions = (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => setConfirmDelete(true)}
      className="text-red-500 hover:text-red-700"
      data-testid="custom-manager-delete-btn"
      title="Delete this custom Manager"
    >
      <Trash2 className="w-4 h-4" />
    </Button>
  );

  const topBanner = definition.sub_categories?.length > 0 ? (
    <div className="bg-white border border-gray-200 rounded-lg p-2 flex items-center gap-2 flex-wrap" data-testid="custom-manager-sub-categories">
      <span className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">
        Auto-included when sub-category matches
      </span>
      {definition.sub_categories.map(sc => (
        <Badge key={sc} variant="outline" className="text-[10px]">{sc}</Badge>
      ))}
    </div>
  ) : null;

  return (
    <>
      <ManagerPageShell
        categoryKey={slug}
        tabsBarActive={`custom:${slug}`}
        title={definition.name}
        subtitle={definition.description || 'Custom Manager'}
        icon={Sparkles}
        theme={themeKey}
        bulkBarTheme={bulkTheme}
        facetCategory="custom"
        isMatch={isMatch}
        subTabs={[]}
        columns={[
          { key: 'color', label: 'Colour', render: (p) => p.color || (Array.isArray(p.colors) && p.colors[0]) || '—' },
          { key: 'supplier', label: 'Supplier' },
          {
            key: 'sub_categories',
            label: 'Sub-cat',
            render: (p) => {
              const subCats = (p.sub_categories || []).slice(0, 2);
              return subCats.length > 0
                ? (<div className="flex flex-wrap gap-0.5">{subCats.map((sc, i) => <Badge key={i} variant="outline" className="text-[10px] py-0 px-1">{sc}</Badge>)}</div>)
                : '—';
            },
          },
        ]}
        editFields={fallbackEditFields}
        presetCategory={definition.product_group || slug}
        bannerBullets={[
          `Search or filter across ${definition.name.toLowerCase()} products.`,
          'Click Edit on a row to update fields you defined in Configure.',
          'Use + Add New for a brand-new product (opens the Wizard).',
          'Tick multiple rows to open the Bulk bar (pricing, images, AI, publish, delete).',
        ]}
        extraHeaderActions={extraHeaderActions}
        topBanner={topBanner}
      />

      {/* Delete confirm dialog */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-red-600 flex items-center gap-2">
              <Trash2 className="w-5 h-5" /> Delete &ldquo;{definition.name}&rdquo;?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-700">
            This removes the Manager tab. Products already tagged with this category stay in the database — you can re-classify them anytime.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button className="bg-red-600 hover:bg-red-700 text-white" onClick={handleDeleteManager} data-testid="custom-manager-confirm-delete">
              <Trash2 className="w-4 h-4 mr-1" /> Delete Manager
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default CustomManager;
