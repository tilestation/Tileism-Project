/**
 * LargeFormatSweepModal — catalogue-wide Large Format check.
 * Scans EVERY product in the Manager (not just the selection) with the
 * 60x60+ rule (any dimension above 60cm, 60x60 itself excluded), then
 * one click assigns the Large Format shop tab to qualifying tiles and
 * strips it from wrongly-tagged smaller ones.
 */
import React, { useState, useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Maximize2, Plus, Minus, CheckCircle, Loader2 } from 'lucide-react';
import { fetchShopTabDestinations } from '../../lib/shopTabDestinations';
import { isLargeFormat } from './ShopTabsAssignModal';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const Row = ({ p }) => (
  <div className="flex items-center gap-2 px-2.5 py-1 text-[12px]">
    <span className="font-mono text-gray-400 w-24 truncate flex-shrink-0">{p.sku || p.supplier_code}</span>
    <span className="text-gray-800 truncate flex-1">{p.our_product_name || p.product_name || p.name}</span>
    <span className="text-gray-500 flex-shrink-0">{p.size || (Array.isArray(p.sizes) ? p.sizes[0] : '') || '—'}</span>
  </div>
);

const LargeFormatSweepModal = ({ open, onOpenChange, products = [], onSuccess }) => {
  const [lfTab, setLfTab] = useState(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    if (!open) return;
    setDone(null);
    setLoading(true);
    fetchShopTabDestinations(true)
      .then(pages => {
        for (const page of pages || []) {
          for (const tab of page.tabs || []) {
            if (!tab.assignable || !tab.category_name) continue;
            const label = `${tab.label || ''} ${tab.category_slug || ''}`.toLowerCase();
            if (label.includes('large') && label.includes('format')) { setLfTab(tab); return; }
          }
        }
        setLfTab(null);
      })
      .finally(() => setLoading(false));
  }, [open]);

  const scan = useMemo(() => {
    if (!lfTab) return { toAdd: [], toRemove: [], large: 0 };
    const needle = lfTab.category_name.toLowerCase();
    const hasTag = (p) => (Array.isArray(p.sub_categories) ? p.sub_categories : []).some(c => String(c).toLowerCase().includes(needle));
    const large = products.filter(isLargeFormat);
    return {
      large: large.length,
      toAdd: large.filter(p => !hasTag(p)),
      toRemove: products.filter(p => !isLargeFormat(p) && hasTag(p)),
    };
  }, [lfTab, products]);

  const apply = async () => {
    if (!lfTab) return;
    setApplying(true);
    try {
      const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, (i + 1) * n));
      let updated = 0;
      for (const [list, key] of [[scan.toAdd, 'add_categories'], [scan.toRemove, 'remove_categories']]) {
        for (const batch of chunk(list, 400)) {
          const res = await fetch(`${API_URL}/api/supplier-sync/products/assign-shop-tabs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              skus: batch.filter(p => p.sku).map(p => p.sku),
              supplier_codes: batch.filter(p => !p.sku && p.supplier_code).map(p => p.supplier_code),
              [key]: [lfTab.category_name],
              [key === 'add_categories' ? 'remove_categories' : 'add_categories']: [],
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          updated += data.updated || 0;
        }
      }
      setDone({ added: scan.toAdd.length, removed: scan.toRemove.length });
      toast.success(`Large Format sweep done — added ${scan.toAdd.length}, removed ${scan.toRemove.length}`);
      if (onSuccess) onSuccess();
    } catch (err) {
      toast.error(`Sweep failed: ${err.message}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto" data-testid="large-format-sweep-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Maximize2 className="w-5 h-5 text-indigo-600" />
            Large Format Sweep — whole catalogue
          </DialogTitle>
          <DialogDescription>
            Checks every product in this Manager against the 60x60+ rule (any side above 60cm counts, 60x60 itself doesn't) and fixes the Large Format tab in one go.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-gray-400" /></div>
        ) : !lfTab ? (
          <div className="py-6 text-center text-sm text-gray-500" data-testid="lf-sweep-no-tab">
            No "Large Format" shop tab found — create one first via Shop Tabs → + New tab.
          </div>
        ) : done ? (
          <div className="py-6 text-center" data-testid="lf-sweep-done">
            <CheckCircle className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
            <p className="text-sm text-gray-700">Sweep complete — <b>{done.added}</b> added to {lfTab.label}, <b>{done.removed}</b> wrongly-tagged removed.</p>
          </div>
        ) : (
          <>
            <div className="text-sm text-gray-600" data-testid="lf-sweep-summary">
              Scanned <b>{products.length}</b> products — <b>{scan.large}</b> are Large Format.
              {scan.toAdd.length === 0 && scan.toRemove.length === 0 && <span className="text-emerald-600 font-medium"> Everything is already tagged correctly. ✓</span>}
            </div>
            {scan.toAdd.length > 0 && (
              <div className="rounded-lg border border-emerald-200 overflow-hidden">
                <div className="px-3 py-1.5 bg-emerald-50 text-emerald-800 text-xs font-semibold flex items-center gap-1.5">
                  <Plus className="w-3.5 h-3.5" /> {scan.toAdd.length} to ADD to {lfTab.label}
                </div>
                <div className="max-h-[22vh] overflow-y-auto divide-y divide-gray-50" data-testid="lf-sweep-add-list">
                  {scan.toAdd.slice(0, 200).map(p => <Row key={p.sku || p.supplier_code} p={p} />)}
                </div>
              </div>
            )}
            {scan.toRemove.length > 0 && (
              <div className="rounded-lg border border-red-200 overflow-hidden">
                <div className="px-3 py-1.5 bg-red-50 text-red-700 text-xs font-semibold flex items-center gap-1.5">
                  <Minus className="w-3.5 h-3.5" /> {scan.toRemove.length} wrongly tagged (60x60 and below) to REMOVE
                </div>
                <div className="max-h-[22vh] overflow-y-auto divide-y divide-gray-50" data-testid="lf-sweep-remove-list">
                  {scan.toRemove.slice(0, 200).map(p => <Row key={p.sku || p.supplier_code} p={p} />)}
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} data-testid="lf-sweep-cancel">Close</Button>
              {(scan.toAdd.length > 0 || scan.toRemove.length > 0) && (
                <Button size="sm" onClick={apply} disabled={applying} className="bg-indigo-600 hover:bg-indigo-700 text-white" data-testid="lf-sweep-apply">
                  {applying ? 'Fixing…' : `Fix all (+${scan.toAdd.length} · −${scan.toRemove.length})`}
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default LargeFormatSweepModal;
