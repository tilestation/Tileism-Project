/**
 * AssignColoursModal — dedicated "split selected products into colour buckets" modal.
 *
 * Directly addresses the bug that started this session: user selects 14 products,
 * assigns 7 to Grey and 7 to White in one save. This modal makes that trivial —
 * type or select colour names, drag/click SKUs into each bucket, click Save.
 *
 * Under the hood: one bulk-update-unified call per bucket, each writing both the
 * scalar `color` field AND the `colors` array so the storefront picks up correctly.
 * Full 100% verification runs on each save; failures surface in a warning toast.
 */

import React, { useState, useMemo } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Badge } from '../../../../components/ui/badge';
import {
  Palette, Plus, X, Save, RefreshCw, ArrowRight, CheckCircle, AlertCircle,
} from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const AssignColoursModal = ({ open, onOpenChange, selectedList = [], onSuccess }) => {
  // Buckets: { colourName: Set<productKey> }
  const [buckets, setBuckets] = useState([]);      // [{name: 'Grey', skus: Set<sku>}, ...]
  const [newColour, setNewColour] = useState('');
  const [saving, setSaving] = useState(false);

  const productLookup = useMemo(() => {
    const m = new Map();
    selectedList.forEach(p => m.set(p.sku || p.supplier_code || '', p));
    return m;
  }, [selectedList]);

  const assignedSkus = useMemo(() => {
    const s = new Set();
    buckets.forEach(b => b.skus.forEach(sku => s.add(sku)));
    return s;
  }, [buckets]);

  const unassignedProducts = useMemo(
    () => selectedList.filter(p => !assignedSkus.has(p.sku || p.supplier_code)),
    [selectedList, assignedSkus]
  );

  const addBucket = () => {
    const name = newColour.trim();
    if (!name) return;
    if (buckets.some(b => b.name.toLowerCase() === name.toLowerCase())) {
      toast.error(`Bucket "${name}" already exists`);
      return;
    }
    setBuckets(prev => [...prev, { name, skus: new Set() }]);
    setNewColour('');
  };

  const removeBucket = (idx) => {
    setBuckets(prev => prev.filter((_, i) => i !== idx));
  };

  const moveSkuToBucket = (sku, bucketIdx) => {
    setBuckets(prev => prev.map((b, i) => {
      const nextSkus = new Set(b.skus);
      if (i === bucketIdx) nextSkus.add(sku);
      else nextSkus.delete(sku);
      return { ...b, skus: nextSkus };
    }));
  };

  const removeSkuFromBucket = (sku, bucketIdx) => {
    setBuckets(prev => prev.map((b, i) => {
      if (i !== bucketIdx) return b;
      const nextSkus = new Set(b.skus);
      nextSkus.delete(sku);
      return { ...b, skus: nextSkus };
    }));
  };

  const handleSave = async () => {
    const nonEmpty = buckets.filter(b => b.skus.size > 0);
    if (nonEmpty.length === 0) {
      toast.error('No colours assigned yet — add a bucket and drag SKUs in.');
      return;
    }
    setSaving(true);
    try {
      let totalUpdated = 0;
      const allVerFailures = [];
      // One bulk-update-unified call per bucket. Verification runs on each.
      for (const bucket of nonEmpty) {
        const idsSku = [];
        const idsSupplierCode = [];
        bucket.skus.forEach(sku => {
          const p = productLookup.get(sku);
          if (!p) return;
          if (p.sku) idsSku.push(p.sku);
          else if (p.supplier_code) idsSupplierCode.push(p.supplier_code);
        });
        for (const [ids, idField] of [[idsSku, 'sku'], [idsSupplierCode, 'supplier_code']]) {
          if (ids.length === 0) continue;
          const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              product_ids: ids,
              id_field: idField,
              updates: { color: bucket.name, colors: [bucket.name] },
              mode: 'replace',
            }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status} on bucket "${bucket.name}"`);
          const data = await res.json();
          totalUpdated += data.updated_count || 0;
          if (Array.isArray(data.verification_failures) && data.verification_failures.length > 0) {
            allVerFailures.push(...data.verification_failures.map(f => ({ ...f, bucket: bucket.name })));
          }
        }
      }
      if (allVerFailures.length > 0) {
        toast.warning(
          `Saved ${totalUpdated} products, but ${allVerFailures.length} verification failure(s) — check console`,
          { duration: 12000 }
        );
        console.warn('[Assign Colours] Verification failures:', allVerFailures);
      } else {
        toast.success(`Assigned colours to ${totalUpdated} product(s) across ${nonEmpty.length} colour bucket(s)`);
      }
      onOpenChange(false);
      if (onSuccess) onSuccess({ updated: totalUpdated, failures: allVerFailures });
      setBuckets([]);
    } catch (err) {
      console.error('[Assign Colours] Save failed', err);
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const productName = (p) => (p.our_product_name || p.product_name || p.name || p.sku || p.supplier_code);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto" data-testid="assign-colours-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Palette className="w-5 h-5 text-orange-600" />
            Assign Colours to {selectedList.length} product(s)
          </DialogTitle>
          <p className="text-xs text-gray-500">
            Create a bucket per colour, then move SKUs into the matching bucket. Each bucket becomes a separate save with 100% verification. Products can only be in one bucket at a time.
          </p>
        </DialogHeader>

        {/* Add-a-bucket bar */}
        <div className="flex items-center gap-2 py-2">
          <Input
            placeholder="Type a colour name (e.g. Grey, White, Beige…)"
            value={newColour}
            onChange={(e) => setNewColour(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addBucket(); } }}
            className="flex-1"
            data-testid="new-colour-input"
          />
          <Button onClick={addBucket} className="bg-orange-600 hover:bg-orange-700 text-white" data-testid="add-bucket-btn">
            <Plus className="w-4 h-4 mr-1" /> Add Bucket
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Left: unassigned pool */}
          <div className="border border-gray-200 rounded-lg p-3 max-h-[60vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-2">
              <h4 className="font-semibold text-sm text-gray-700">Unassigned</h4>
              <Badge variant="outline" className="text-xs">{unassignedProducts.length}</Badge>
            </div>
            {unassignedProducts.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-4">
                <CheckCircle className="w-5 h-5 mx-auto mb-1 text-emerald-500" />
                All selected products are in a bucket
              </p>
            ) : (
              <ul className="space-y-1">
                {unassignedProducts.map(p => (
                  <li key={p.sku || p.supplier_code || p._id} className="text-xs bg-gray-50 rounded px-2 py-1.5 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-gray-800 truncate" title={productName(p)}>{productName(p)}</div>
                      <div className="text-[10px] text-gray-500 truncate">
                        {p.supplier} · {p.sku || p.supplier_code}
                        {p.color && <span className="ml-1 text-orange-600">(current: {p.color})</span>}
                      </div>
                    </div>
                    {buckets.length > 0 && (
                      <select
                        className="text-[10px] border border-gray-300 rounded px-1 py-0.5"
                        value=""
                        onChange={(e) => { if (e.target.value !== '') moveSkuToBucket(p.sku || p.supplier_code, Number(e.target.value)); }}
                        data-testid={`move-to-bucket-${p.sku || p.supplier_code}`}
                      >
                        <option value="">Move to…</option>
                        {buckets.map((b, i) => (
                          <option key={i} value={i}>{b.name}</option>
                        ))}
                      </select>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Right: colour buckets */}
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {buckets.length === 0 ? (
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                <Palette className="w-8 h-8 mx-auto text-gray-400 mb-2" />
                <p className="text-sm text-gray-500">No colour buckets yet</p>
                <p className="text-xs text-gray-400 mt-1">Type a colour above and click "Add Bucket"</p>
              </div>
            ) : (
              buckets.map((bucket, bi) => (
                <div key={bi} className="border border-orange-200 rounded-lg bg-orange-50/40" data-testid={`bucket-${bucket.name}`}>
                  <div className="flex items-center justify-between px-3 py-2 border-b border-orange-200">
                    <div className="flex items-center gap-2">
                      <ArrowRight className="w-3.5 h-3.5 text-orange-600" />
                      <span className="font-semibold text-sm text-orange-900">{bucket.name}</span>
                      <Badge variant="outline" className="text-[10px] bg-white">{bucket.skus.size}</Badge>
                    </div>
                    <button
                      onClick={() => removeBucket(bi)}
                      className="text-orange-400 hover:text-red-500"
                      title="Remove bucket"
                      data-testid={`remove-bucket-${bucket.name}`}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  {bucket.skus.size === 0 ? (
                    <p className="text-[11px] text-gray-400 text-center py-3">Move products here from the left</p>
                  ) : (
                    <ul className="p-2 space-y-1">
                      {[...bucket.skus].map(sku => {
                        const p = productLookup.get(sku);
                        if (!p) return null;
                        return (
                          <li key={sku} className="text-xs bg-white rounded px-2 py-1 flex items-center justify-between gap-2 border border-orange-100">
                            <span className="truncate text-gray-800" title={productName(p)}>{productName(p)}</span>
                            <button
                              onClick={() => removeSkuFromBucket(sku, bi)}
                              className="text-gray-400 hover:text-red-500 flex-shrink-0"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {unassignedProducts.length > 0 && buckets.length > 0 && (
          <div className="text-[11px] text-amber-600 flex items-center gap-1 mt-1">
            <AlertCircle className="w-3 h-3" />
            {unassignedProducts.length} product(s) still unassigned — they won't be updated
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button
            onClick={handleSave}
            disabled={saving || buckets.every(b => b.skus.size === 0)}
            className="bg-orange-600 hover:bg-orange-700 text-white"
            data-testid="assign-colours-save"
          >
            {saving ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
            Save {buckets.reduce((sum, b) => sum + b.skus.size, 0)} product(s)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default AssignColoursModal;
