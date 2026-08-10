/**
 * StorefrontPanel — "everything customers see on this category's shop page"
 * in one dialog, opened from the Storefront button on each Manager page.
 *   1 · Shop Page Tabs  — the tab strip on the category's storefront page
 *   2 · Page Banner     — the hero image at the top of that page
 * Backed by the same APIs the old Navigation & Structure page used
 * (/api/website-admin/navigation/{menu_type} and /page-banners) so data
 * stays fully compatible between old and new locations.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { Store, LayoutGrid, Image as ImageIcon, FolderOpen } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '../../../../components/ui/dialog';
import NavLinksEditor from './NavLinksEditor';
import BannerEditorCard from './BannerEditorCard';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// group slug → backend navigation menu_type (tiles uses the legacy 'shop' key)
const menuTypeFor = (slug) => (!slug || slug === 'tiles' ? 'shop' : `shop_${slug}`);

const StorefrontPanel = ({ open, onOpenChange, managerTitle, defaultGroupSlug = null }) => {
  const [groups, setGroups] = useState([]);
  const [groupSlug, setGroupSlug] = useState(defaultGroupSlug || '');
  const [tabs, setTabs] = useState([]);
  const [tabsLoading, setTabsLoading] = useState(false);
  const [tabsSaving, setTabsSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setGroupSlug(defaultGroupSlug || '');
    (async () => {
      try {
        const token = localStorage.getItem('token');
        const res = await fetch(`${API_URL}/api/website-admin/category-groups`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) setGroups(await res.json());
      } catch { /* silent */ }
    })();
  }, [open, defaultGroupSlug]);

  const loadTabs = useCallback(async (slug) => {
    if (!slug) { setTabs([]); return; }
    setTabsLoading(true);
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/navigation/${menuTypeFor(slug)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        const items = Array.isArray(data) ? data : (data.items || []);
        setTabs(items.map(it => ({ ...it, url: it.link_url || it.url })));
      } else {
        setTabs([]);
      }
    } catch { setTabs([]); }
    finally { setTabsLoading(false); }
  }, []);

  useEffect(() => { if (open) loadTabs(groupSlug); }, [open, groupSlug, loadTabs]);

  const saveTabs = async () => {
    if (!groupSlug) return;
    setTabsSaving(true);
    try {
      const token = localStorage.getItem('token');
      const formatted = tabs.map((item, index) => ({
        id: item.id || Date.now().toString() + index,
        label: item.label,
        link_url: item.url || item.link_url,
        display_order: index,
        is_active: item.is_active !== false,
        highlight: item.highlight || false,
        highlight_color: item.highlight_color || null,
      }));
      const res = await fetch(`${API_URL}/api/website-admin/navigation/${menuTypeFor(groupSlug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(formatted),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Save failed'); return; }
      toast.success('Shop tabs saved — live on the website now');
    } catch { toast.error('Save failed'); }
    finally { setTabsSaving(false); }
  };

  const groupName = groups.find(g => g.slug === groupSlug)?.name || groupSlug;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="storefront-panel">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Store className="w-5 h-5 text-emerald-600" />
            Storefront — {managerTitle}
          </DialogTitle>
          <DialogDescription>
            Everything customers see on this category's shop page — its tabs and its banner — managed right here.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Group picker — auto-selected for built-in Managers, manual for others */}
          <div className="flex items-center gap-3 p-3 rounded-lg bg-emerald-50 border border-emerald-100">
            <FolderOpen className="w-4 h-4 text-emerald-600 flex-shrink-0" />
            <span className="text-sm font-medium text-gray-700 flex-shrink-0">Shop page:</span>
            <select
              value={groupSlug}
              onChange={(e) => setGroupSlug(e.target.value)}
              className="h-8 text-sm border border-gray-300 rounded px-2 bg-white"
              data-testid="storefront-group-select"
            >
              <option value="">— choose a shop page —</option>
              {groups.map(g => <option key={g.slug} value={g.slug}>{g.name}</option>)}
            </select>
            {groupSlug && (
              <a
                href={`https://www.tilestation.co.uk/tiles?group=${groupSlug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto text-xs text-emerald-700 hover:underline flex-shrink-0"
                data-testid="storefront-view-live-link"
              >
                View live page ↗
              </a>
            )}
          </div>

          {!groupSlug ? (
            <p className="text-sm text-gray-500 text-center py-6">
              This Manager isn't linked to a shop page yet — pick one above to edit its tabs and banner.
            </p>
          ) : (
            <>
              {/* 1 · Shop Page Tabs */}
              <div className="border border-blue-100 rounded-lg overflow-hidden" data-testid="storefront-shop-tabs-section">
                <div className="px-3 py-2 bg-blue-50 border-b border-blue-100 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[11px] font-bold flex items-center justify-center flex-shrink-0">1</span>
                  <LayoutGrid className="w-4 h-4 text-blue-600" />
                  <span className="text-sm font-medium text-blue-900">Shop Page Tabs</span>
                  <span className="text-[11px] text-blue-500">— the tab strip customers see across the top of the {groupName} page</span>
                </div>
                <div className="p-3 bg-white">
                  {tabsLoading ? (
                    <p className="text-sm text-gray-400 py-3 text-center">Loading tabs…</p>
                  ) : (
                    <NavLinksEditor items={tabs} onChange={setTabs} onSave={saveTabs} saving={tabsSaving} noun="tab" testPrefix="storefront-tab" />
                  )}
                </div>
              </div>

              {/* 2 · Page Banner */}
              <div className="border border-purple-100 rounded-lg overflow-hidden" data-testid="storefront-banner-section">
                <div className="px-3 py-2 bg-purple-50 border-b border-purple-100 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-purple-600 text-white text-[11px] font-bold flex items-center justify-center flex-shrink-0">2</span>
                  <ImageIcon className="w-4 h-4 text-purple-600" />
                  <span className="text-sm font-medium text-purple-900">Page Banner</span>
                  <span className="text-[11px] text-purple-500">— the hero image at the top of the {groupName} page</span>
                </div>
                <div className="p-3 bg-white">
                  <BannerEditorCard key={groupSlug} scope={groupSlug} pageLabel={`the ${groupName} page`} testPrefix="storefront-banner" />
                </div>
              </div>

              <p className="text-[11px] text-gray-400 px-1">
                Global things (top menu, product labels, default banner) live under the <b>🌐 Website</b> tab in the workspace bar above.
              </p>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default StorefrontPanel;
