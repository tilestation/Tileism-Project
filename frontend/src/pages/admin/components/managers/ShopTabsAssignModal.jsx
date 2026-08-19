/**
 * ShopTabsPanel + ShopTabsAssignModal — "where should these products appear?"
 * Lists every shop page's tabs as tick-boxes. Ticking a tab adds the
 * underlying website category to the selected products' sub_categories
 * (the exact field the storefront tab URLs filter by), so products show
 * under that tab immediately. Multiple tabs per product fully supported.
 * Also supports creating a brand-new tab on the spot ("+ New tab").
 * The panel is exported standalone so Attribute Studio can embed it as a tab.
 */
import React, { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { LayoutGrid, Check, Minus, Store, Plus, Maximize2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { fetchShopTabDestinations, clearShopTabDestinationsCache } from '../../lib/shopTabDestinations';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// ---- Large Format detection ----
// Rule (user-defined): any tile with a dimension ABOVE 60cm is large format.
// 60x60 is NOT large; 80x80, 60x120, 45x90 etc. ARE. Handles cm + mm sizes.
const parseSizesCm = (p) => {
  const out = [];
  const push = (w, h) => {
    if (!w || !h) return;
    if (w > 200 || h > 200) { w /= 10; h /= 10; } // mm → cm
    out.push({ w, h });
  };
  if (Number(p.tile_width) && Number(p.tile_height)) push(Number(p.tile_width), Number(p.tile_height));
  const candidates = [p.size, ...(Array.isArray(p.sizes) ? p.sizes : []), p.our_product_name || p.product_name || p.name];
  candidates.filter(Boolean).forEach(s => {
    const m = String(s).match(/(\d+(?:\.\d+)?)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
    if (m) push(parseFloat(m[1]), parseFloat(m[2]));
  });
  return out;
};
// A tile counts as Large Format when its longest side is ABOVE 60cm AND the
// short side is at least 10cm (filters out trims/strips like 2440x12mm).
export const isLargeFormat = (p) => parseSizesCm(p).some(d => Math.max(d.w, d.h) > 60 && Math.min(d.w, d.h) >= 10);

export const ShopTabsPanel = ({ selectedProducts = [], onSaved, onDone, embedded = false }) => {
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [desired, setDesired] = useState({}); // category_name -> true (add) | false (remove)
  const [newTabFor, setNewTabFor] = useState(null); // group_slug of open "+ New tab" form
  const [newTabLabel, setNewTabLabel] = useState('');
  const [creatingTab, setCreatingTab] = useState(false);

  useEffect(() => {
    setDesired({});
    setNewTabFor(null);
    setNewTabLabel('');
    setLoading(true);
    fetchShopTabDestinations(true)
      .then(setPages)
      .finally(() => setLoading(false));
  }, []);

  // category_name -> 'all' | 'some' | 'none' based on the current selection
  const initialState = useMemo(() => {
    const state = {};
    const lists = selectedProducts.map(p =>
      (Array.isArray(p.sub_categories) ? p.sub_categories : []).map(c => String(c).toLowerCase())
    );
    pages.forEach(page => page.tabs.forEach(tab => {
      if (!tab.assignable || !tab.category_name) return;
      const needle = tab.category_name.toLowerCase();
      const count = lists.filter(l => l.includes(needle)).length;
      state[tab.category_name] = count === 0 ? 'none' : (count === lists.length ? 'all' : 'some');
    }));
    return state;
  }, [pages, selectedProducts]);

  const displayState = (catName) => {
    if (catName in desired) return desired[catName] ? 'all' : 'none';
    return initialState[catName] || 'none';
  };

  const toggle = (catName) => {
    const current = displayState(catName);
    setDesired(prev => ({ ...prev, [catName]: current !== 'all' }));
  };

  const { adds, removes } = useMemo(() => {
    // Send exactly what the user toggled — $addToSet/$pull are idempotent,
    // so this stays correct even if the pre-loaded tick states were stale.
    const adds = [];
    const removes = [];
    Object.entries(desired).forEach(([cat, want]) => {
      if (want) adds.push(cat); else removes.push(cat);
    });
    return { adds, removes };
  }, [desired]);

  const createTab = async (groupSlug) => {
    const label = newTabLabel.trim();
    if (!label) { toast.error('Type a name for the new tab first'); return; }
    setCreatingTab(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/shop-tab-destinations/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_slug: groupSlug, label }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Failed to create tab'); return; }
      const data = await res.json();
      clearShopTabDestinationsCache();
      const fresh = await fetchShopTabDestinations(true);
      setPages(fresh);
      // Auto-tick the brand-new tab for the current selection
      if (data.tab?.category_name) {
        setDesired(prev => ({ ...prev, [data.tab.category_name]: true }));
      }
      setNewTabFor(null);
      setNewTabLabel('');
      toast.success(`Tab "${data.tab?.label || label}" created — ticked for your selection`);
    } catch { toast.error('Failed to create tab'); }
    finally { setCreatingTab(false); }
  };

  // ---- Large Format auto-assign ----
  // Finds the "Large Format" tab, detects which selected products are above
  // 60x60, and assigns ONLY those (plus un-assigns wrongly-tagged small ones).
  const largeFormatTab = useMemo(() => {
    for (const page of pages) {
      for (const tab of page.tabs || []) {
        if (!tab.assignable || !tab.category_name) continue;
        const label = `${tab.label || ''} ${tab.category_slug || ''}`.toLowerCase();
        if (label.includes('large') && label.includes('format')) return tab;
      }
    }
    return null;
  }, [pages]);

  const lfSplit = useMemo(() => {
    if (!largeFormatTab) return null;
    const needle = largeFormatTab.category_name.toLowerCase();
    const hasTag = (p) => (Array.isArray(p.sub_categories) ? p.sub_categories : []).some(c => String(c).toLowerCase().includes(needle));
    const large = selectedProducts.filter(isLargeFormat);
    const toAdd = large.filter(p => !hasTag(p));
    const toRemove = selectedProducts.filter(p => !isLargeFormat(p) && hasTag(p));
    return { large, toAdd, toRemove };
  }, [largeFormatTab, selectedProducts]);

  const [lfSaving, setLfSaving] = useState(false);
  const autoAssignLargeFormat = async () => {
    if (!largeFormatTab || !lfSplit) return;
    setLfSaving(true);
    try {
      let updated = 0;
      for (const [list, key] of [[lfSplit.toAdd, 'add_categories'], [lfSplit.toRemove, 'remove_categories']]) {
        if (list.length === 0) continue;
        const res = await fetch(`${API_URL}/api/supplier-sync/products/assign-shop-tabs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            skus: list.filter(p => p.sku).map(p => p.sku),
            supplier_codes: list.filter(p => !p.sku && p.supplier_code).map(p => p.supplier_code),
            [key]: [largeFormatTab.category_name],
            [key === 'add_categories' ? 'remove_categories' : 'add_categories']: [],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        updated += data.updated || 0;
      }
      toast.success(`Large Format sorted — added ${lfSplit.toAdd.length}, removed ${lfSplit.toRemove.length} (sizes above 60x60 only)`);
      onSaved?.();
    } catch (err) {
      toast.error(`Large Format auto-assign failed: ${err.message}`);
    } finally {
      setLfSaving(false);
    }
  };

  const apply = async () => {
    if (adds.length === 0 && removes.length === 0) { toast.info('No changes to apply'); return; }
    setSaving(true);
    try {
      const skus = selectedProducts.filter(p => p.sku).map(p => p.sku);
      const supplierCodes = selectedProducts.filter(p => !p.sku && p.supplier_code).map(p => p.supplier_code);
      const res = await fetch(`${API_URL}/api/supplier-sync/products/assign-shop-tabs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus, supplier_codes: supplierCodes, add_categories: adds, remove_categories: removes }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); toast.error(err.detail || 'Failed to update shop tabs'); return; }
      const data = await res.json();
      toast.success(`${data.updated} product(s) updated — live on the website now`);
      setDesired({});
      onSaved?.();
      onDone?.();
    } catch { toast.error('Failed to update shop tabs'); }
    finally { setSaving(false); }
  };

  const CheckBox = ({ state }) => (
    <span className={`w-[18px] h-[18px] rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
      state === 'all' ? 'bg-emerald-600 border-emerald-600 text-white'
        : state === 'some' ? 'bg-amber-400 border-amber-400 text-white'
        : 'bg-white border-gray-300'
    }`}>
      {state === 'all' && <Check className="w-3 h-3" />}
      {state === 'some' && <Minus className="w-3 h-3" />}
    </span>
  );

  return (
    <div data-testid="shop-tabs-panel">
      {loading ? (
        <p className="text-sm text-gray-400 py-8 text-center">Loading shop pages…</p>
      ) : (
        <div className="space-y-4 py-1">
          {/* Large Format smart assign — detects sizes above 60x60 in the selection */}
          {largeFormatTab && lfSplit && (lfSplit.large.length > 0 || lfSplit.toRemove.length > 0) && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2.5 flex items-center gap-2.5" data-testid="large-format-banner">
              <Maximize2 className="w-4 h-4 text-indigo-600 flex-shrink-0" />
              <div className="text-xs text-indigo-900 flex-1">
                {lfSplit.large.length > 0
                  ? <><b>{lfSplit.large.length} of {selectedProducts.length}</b> selected are Large Format (above 60x60 — e.g. 80x80, 60x120).</>
                  : <>None of the selection is above 60x60,</>}
                {(lfSplit.toAdd.length > 0 || lfSplit.toRemove.length > 0)
                  ? <> One click {lfSplit.toAdd.length > 0 ? <>assigns only those to the <b>{largeFormatTab.label}</b> tab</> : <>fixes the <b>{largeFormatTab.label}</b> tab</>}{lfSplit.toRemove.length > 0 ? ` — removing ${lfSplit.toRemove.length} wrongly-tagged smaller tile(s) (60x60 and below)` : ''}.</>
                  : <> All correctly tagged already.</>}
              </div>
              {(lfSplit.toAdd.length > 0 || lfSplit.toRemove.length > 0) && (
                <Button
                  size="sm"
                  onClick={autoAssignLargeFormat}
                  disabled={lfSaving}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white h-8 flex-shrink-0"
                  data-testid="large-format-auto-btn"
                >
                  {lfSaving ? 'Assigning…' : `Auto-assign (${lfSplit.toAdd.length > 0 ? `+${lfSplit.toAdd.length}` : ''}${lfSplit.toAdd.length > 0 && lfSplit.toRemove.length > 0 ? ' · ' : ''}${lfSplit.toRemove.length > 0 ? `−${lfSplit.toRemove.length}` : ''})`}
                </Button>
              )}
            </div>
          )}
          {pages.map(page => (
            <div key={page.group_slug} className="border border-gray-200 rounded-lg overflow-hidden" data-testid={`shop-tabs-page-${page.group_slug}`}>
              <div className="px-3 py-2 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
                <Store className="w-3.5 h-3.5 text-gray-500" />
                <span className="text-sm font-semibold text-gray-800">{page.group_name} page</span>
                <button
                  type="button"
                  onClick={() => { setNewTabFor(newTabFor === page.group_slug ? null : page.group_slug); setNewTabLabel(''); }}
                  className="ml-auto text-[11px] font-medium text-emerald-600 hover:text-emerald-800 flex items-center gap-0.5"
                  data-testid={`shop-tabs-new-tab-btn-${page.group_slug}`}
                >
                  <Plus className="w-3 h-3" /> New tab
                </button>
              </div>
              {newTabFor === page.group_slug && (
                <div className="px-3 py-2 bg-emerald-50/60 border-b border-emerald-100 flex items-center gap-2" data-testid={`shop-tabs-new-tab-form-${page.group_slug}`}>
                  <input
                    type="text"
                    value={newTabLabel}
                    onChange={(e) => setNewTabLabel(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && createTab(page.group_slug)}
                    placeholder="New tab name, e.g. Cleaning & Maintenance"
                    className="flex-1 h-8 text-sm border border-emerald-300 rounded px-2 bg-white"
                    autoFocus
                    data-testid={`shop-tabs-new-tab-input-${page.group_slug}`}
                  />
                  <Button size="sm" onClick={() => createTab(page.group_slug)} disabled={creatingTab} className="bg-emerald-600 hover:bg-emerald-700 text-white h-8" data-testid={`shop-tabs-new-tab-create-${page.group_slug}`}>
                    {creatingTab ? 'Creating…' : 'Create'}
                  </Button>
                </div>
              )}
              <div className="divide-y">
                {page.tabs.map((tab, i) => tab.assignable ? (
                  <button
                    key={`${page.group_slug}-${i}`}
                    type="button"
                    onClick={() => toggle(tab.category_name)}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-emerald-50/50 transition-colors"
                    data-testid={`shop-tab-option-${page.group_slug}-${tab.category_slug}`}
                  >
                    <CheckBox state={displayState(tab.category_name)} />
                    <span className="text-sm font-medium text-gray-800">{tab.label}</span>
                    <span className="text-[11px] text-gray-400 ml-auto font-mono">{tab.url}</span>
                  </button>
                ) : (
                  <div key={`${page.group_slug}-${i}`} className="flex items-center gap-2.5 px-3 py-2 opacity-50" title="Products appear here automatically when they're in this Manager">
                    <span className="w-[18px] h-[18px] rounded border border-dashed border-gray-300 flex-shrink-0" />
                    <span className="text-sm text-gray-500">{tab.label}</span>
                    <span className="text-[10px] text-gray-400 ml-auto italic">automatic — shows everything in this Manager</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {pages.length === 0 && <p className="text-sm text-gray-400 py-6 text-center">No shop tabs found — add some via the Storefront button first.</p>}
        </div>
      )}

      <div className="flex items-center justify-between pt-3 border-t">
        <div className="text-xs text-gray-500" data-testid="shop-tabs-change-summary">
          {adds.length > 0 && <span className="text-emerald-600 font-medium">+{adds.length} destination{adds.length > 1 ? 's' : ''}</span>}
          {adds.length > 0 && removes.length > 0 && <span> · </span>}
          {removes.length > 0 && <span className="text-red-500 font-medium">−{removes.length} removed</span>}
          {adds.length === 0 && removes.length === 0 && <span>No changes yet — tick or untick a tab</span>}
        </div>
        <div className="flex gap-2">
          {!embedded && (
            <Button variant="outline" size="sm" onClick={() => onDone?.()} data-testid="shop-tabs-cancel-btn">Cancel</Button>
          )}
          <Button size="sm" onClick={apply} disabled={saving || (adds.length === 0 && removes.length === 0)} className="bg-emerald-600 hover:bg-emerald-700 text-white" data-testid="shop-tabs-apply-btn">
            {saving ? 'Applying…' : `Apply to ${selectedProducts.length} product(s)`}
          </Button>
        </div>
      </div>
    </div>
  );
};

const ShopTabsAssignModal = ({ open, onOpenChange, selectedProducts = [], onSaved }) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="shop-tabs-assign-modal">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <LayoutGrid className="w-5 h-5 text-emerald-600" />
          Shop Tabs — where should these appear?
        </DialogTitle>
        <DialogDescription>
          {selectedProducts.length} product(s) selected. Tick every tab they should show under — multiple tabs are fine.
          <span className="inline-flex items-center gap-1 ml-1 text-amber-600"><Minus className="w-3 h-3 bg-amber-400 text-white rounded-sm" /> = only some of your selection is there now.</span>
        </DialogDescription>
      </DialogHeader>
      {open && (
        <ShopTabsPanel
          selectedProducts={selectedProducts}
          onSaved={onSaved}
          onDone={() => onOpenChange(false)}
        />
      )}
    </DialogContent>
  </Dialog>
);

export default ShopTabsAssignModal;
