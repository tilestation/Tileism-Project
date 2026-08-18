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

import React, { useState, useMemo, useEffect } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Badge } from '../../../../components/ui/badge';
import {
  Palette, Plus, X, Save, RefreshCw, ArrowRight, CheckCircle, AlertCircle, GripVertical,
} from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const COLOUR_ATTR = { key: 'color', label: 'Colour', arrayField: 'colors' };

// Countries → flag emoji for the "Made In" attribute
const COUNTRY_FLAGS = {
  italy: '🇮🇹', spain: '🇪🇸', portugal: '🇵🇹', turkey: '🇹🇷', india: '🇮🇳', china: '🇨🇳',
  poland: '🇵🇱', germany: '🇩🇪', uk: '🇬🇧', 'united kingdom': '🇬🇧', france: '🇫🇷',
  belgium: '🇧🇪', brazil: '🇧🇷', morocco: '🇲🇦', egypt: '🇪🇬', iran: '🇮🇷',
  indonesia: '🇮🇩', vietnam: '🇻🇳', mexico: '🇲🇽', usa: '🇺🇸',
};
const flagFor = (attrKey, name) =>
  attrKey === 'made_in' ? (COUNTRY_FLAGS[String(name || '').toLowerCase()] || '') : '';

const AssignColoursModal = ({ open, onOpenChange, selectedList = [], onSuccess, attributeOptions = [] }) => {
  // The attribute being bucketed — Colour by default, switchable to any
  // Configure-defined filter/spec field (Finish, Size, Material, Thickness…)
  const [attr, setAttr] = useState(COLOUR_ATTR);
  const allAttributes = useMemo(() => {
    const extras = (attributeOptions || []).filter(a => a.key && a.key !== 'color');
    return [COLOUR_ATTR, ...extras];
  }, [attributeOptions]);

  // Buckets: { colourName: Set<productKey> }
  const [buckets, setBuckets] = useState([]);      // [{name: 'Grey', skus: Set<sku>}, ...]
  const [newColour, setNewColour] = useState('');
  const [saving, setSaving] = useState(false);

  // Fresh start on every open — Colour selected, no leftover buckets
  useEffect(() => {
    if (open) {
      setAttr(COLOUR_ATTR);
      setBuckets([]);
      setNewColour('');
    }
  }, [open]);

  // Saved/previously-used values for the current attribute — one-click bucket creation
  const [suggestions, setSuggestions] = useState([]);
  useEffect(() => {
    if (!open || !attr?.key) return;
    fetch(`${API_URL}/api/attribute-values?fields=${encodeURIComponent(attr.key)}`)
      .then(res => (res.ok ? res.json() : null))
      .then(d => setSuggestions((d?.values?.[attr.key] || []).slice(0, 30)))
      .catch(() => setSuggestions([]));
  }, [open, attr]);

  const switchAttribute = (a) => {
    if (a.key === attr.key) return;
    setAttr(a);
    setBuckets([]);   // buckets are per-attribute
    setNewColour('');
  };

  const productLookup = useMemo(() => {
    const m = new Map();
    selectedList.forEach(p => m.set(p.sku || p.supplier_code || '', p));
    return m;
  }, [selectedList]);

  // Drag & drop state — the currently-being-dragged SKU (via HTML5 dataTransfer)
  // and the bucket index that's currently a drop target (for visual feedback).
  const [dragOverBucket, setDragOverBucket] = useState(null);   // null | number | 'pool'
  const handleDragStart = (e, sku) => {
    e.dataTransfer.setData('text/sku', sku);
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleDragOver = (e, bucketIdx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverBucket(bucketIdx);
  };
  const handleDrop = (e, bucketIdx) => {
    e.preventDefault();
    const sku = e.dataTransfer.getData('text/sku');
    if (!sku) return;
    if (bucketIdx === 'pool') {
      // Drop into unassigned pool — remove from any bucket
      setBuckets(prev => prev.map(b => {
        const next = new Set(b.skus);
        next.delete(sku);
        return { ...b, skus: next };
      }));
    } else {
      moveSkuToBucket(sku, bucketIdx);
    }
    setDragOverBucket(null);
  };

  const assignedSkus = useMemo(() => {
    const s = new Set();
    buckets.forEach(b => b.skus.forEach(sku => s.add(sku)));
    return s;
  }, [buckets]);

  const unassignedProducts = useMemo(
    () => selectedList.filter(p => !assignedSkus.has(p.sku || p.supplier_code)),
    [selectedList, assignedSkus]
  );

  const addBucket = (presetName) => {
    const name = (presetName ?? newColour).trim();
    if (!name) return;
    if (buckets.some(b => b.name.toLowerCase() === name.toLowerCase())) {
      toast.error(`Bucket "${name}" already exists`);
      return;
    }
    setBuckets(prev => [...prev, { name, skus: new Set() }]);
    if (presetName === undefined) setNewColour('');
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

  // One-click: move every unassigned product into the chosen bucket
  const assignAllToBucket = (bucketName) => {
    const skus = unassignedProducts.map(p => p.sku || p.supplier_code).filter(Boolean);
    if (skus.length === 0) return;
    setBuckets(prev => prev.map(b =>
      b.name === bucketName ? { ...b, skus: new Set([...b.skus, ...skus]) } : b
    ));
    toast.success(`Moved ${skus.length} product(s) to "${bucketName}"`);
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
      toast.error(`No ${attr.label.toLowerCase()}s assigned yet — add a bucket and drag SKUs in.`);
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
        const updates = { [attr.key]: bucket.name };
        if (attr.arrayField) updates[attr.arrayField] = [bucket.name];
        for (const [ids, idField] of [[idsSku, 'sku'], [idsSupplierCode, 'supplier_code']]) {
          if (ids.length === 0) continue;
          const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              product_ids: ids,
              id_field: idField,
              updates,
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
      // Remember the used values so they appear as one-click chips next time
      fetch(`${API_URL}/api/attribute-values/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: attr.key, values: nonEmpty.map(b => b.name) }),
      }).catch(() => {});
      if (allVerFailures.length > 0) {
        toast.warning(
          `Saved ${totalUpdated} products, but ${allVerFailures.length} verification failure(s) — check console`,
          { duration: 12000 }
        );
        console.warn('[Assign Attributes] Verification failures:', allVerFailures);
      } else {
        toast.success(`Assigned ${attr.label.toLowerCase()} to ${totalUpdated} product(s) across ${nonEmpty.length} bucket(s)`);
      }
      onOpenChange(false);
      if (onSuccess) onSuccess({ updated: totalUpdated, failures: allVerFailures });
      setBuckets([]);
    } catch (err) {
      console.error('[Assign Attributes] Save failed', err);
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
            Assign {attr.label} to {selectedList.length} product(s)
          </DialogTitle>
          <p className="text-xs text-gray-500">
            Create a bucket per {attr.label.toLowerCase()}, then move SKUs into the matching bucket. Each bucket becomes a separate save with 100% verification. Products can only be in one bucket at a time.
          </p>
        </DialogHeader>

        {/* Attribute switcher — Colour + every Configure-defined filter/spec field */}
        {allAttributes.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5" data-testid="assign-attribute-switcher">
            <span className="text-[10px] uppercase tracking-wide text-gray-400 mr-1">Assign by:</span>
            {allAttributes.map(a => (
              <button
                key={a.key}
                type="button"
                onClick={() => switchAttribute(a)}
                className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-all ${
                  attr.key === a.key
                    ? 'bg-orange-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
                data-testid={`assign-attr-${a.key}`}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}

        {/* Add-a-bucket bar */}
        <div className="flex items-center gap-2 py-2">
          <Input
            placeholder={`Type a ${attr.label.toLowerCase()} name (e.g. ${attr.key === 'color' ? 'Grey, White, Beige…' : attr.key === 'size' ? '30x60cm, 60x60cm…' : attr.key === 'finish' ? 'Matt, Polished…' : 'value…'})`}
            value={newColour}
            onChange={(e) => setNewColour(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addBucket(); } }}
            className="flex-1"
            data-testid="new-colour-input"
          />
          <Button onClick={() => addBucket()} className="bg-orange-600 hover:bg-orange-700 text-white" data-testid="add-bucket-btn">
            <Plus className="w-4 h-4 mr-1" /> Add Bucket
          </Button>
        </div>

        {/* Saved / previously-used values — one click creates the bucket */}
        {suggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 -mt-1 mb-1" data-testid="bucket-suggestions">
            <span className="text-[10px] text-gray-400 mr-1">Saved values:</span>
            {suggestions
              .filter(s => !buckets.some(b => b.name.toLowerCase() === s.toLowerCase()))
              .slice(0, 14)
              .map((s, i) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => addBucket(s)}
                  className="px-2 py-0.5 rounded-full bg-orange-50 border border-orange-200 text-orange-800 text-[11px] hover:bg-orange-100 transition-colors"
                  data-testid={`bucket-suggestion-${i}`}
                >
                  + {flagFor(attr.key, s)} {s}
                </button>
              ))}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Left: unassigned pool */}
          <div
            className={`border rounded-lg p-3 max-h-[60vh] overflow-y-auto transition ${
              dragOverBucket === 'pool' ? 'border-orange-400 bg-orange-50/60' : 'border-gray-200'
            }`}
            onDragOver={(e) => handleDragOver(e, 'pool')}
            onDrop={(e) => handleDrop(e, 'pool')}
            onDragLeave={() => setDragOverBucket(null)}
          >
            <div className="flex items-center justify-between mb-2 gap-2">
              <h4 className="font-semibold text-sm text-gray-700">Unassigned</h4>
              <div className="flex items-center gap-1.5">
                {unassignedProducts.length > 0 && buckets.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) assignAllToBucket(e.target.value); }}
                    className="h-6 text-[11px] border border-orange-300 rounded px-1 bg-orange-50 text-orange-800 font-medium max-w-[130px]"
                    title="Move every unassigned product into one bucket in one go"
                    data-testid="assign-all-select"
                  >
                    <option value="">Assign all to…</option>
                    {buckets.map(b => (
                      <option key={b.name} value={b.name}>{b.name}</option>
                    ))}
                  </select>
                )}
                <Badge variant="outline" className="text-xs">{unassignedProducts.length}</Badge>
              </div>
            </div>
            {unassignedProducts.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-4">
                <CheckCircle className="w-5 h-5 mx-auto mb-1 text-emerald-500" />
                All selected products are in a bucket
              </p>
            ) : (
              <ul className="space-y-1">
                {unassignedProducts.map(p => {
                  const sku = p.sku || p.supplier_code;
                  return (
                    <li
                      key={sku || p._id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, sku)}
                      className="text-xs bg-gray-50 rounded px-2 py-1.5 flex items-center gap-2 cursor-grab active:cursor-grabbing hover:bg-gray-100 active:opacity-50"
                    >
                      <GripVertical className="w-3 h-3 text-gray-400 flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-gray-800 truncate" title={productName(p)}>{productName(p)}</div>
                        <div className="text-[10px] text-gray-500 truncate">
                          {p.supplier} · {sku}
                          {p[attr.key] && <span className="ml-1 text-orange-600">(current: {Array.isArray(p[attr.key]) ? p[attr.key].join(', ') : p[attr.key]})</span>}
                        </div>
                      </div>
                      {buckets.length > 0 && (
                        <select
                          className="text-[10px] border border-gray-300 rounded px-1 py-0.5"
                          value=""
                          onChange={(e) => { if (e.target.value !== '') moveSkuToBucket(sku, Number(e.target.value)); }}
                          data-testid={`move-to-bucket-${sku}`}
                        >
                          <option value="">Move to…</option>
                          {buckets.map((b, i) => (
                            <option key={i} value={i}>{b.name}</option>
                          ))}
                        </select>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-[10px] text-gray-400 text-center mt-2 italic">
              💡 Drag products right → into a {attr.label.toLowerCase()} bucket
            </p>
          </div>

          {/* Right: colour buckets */}
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {buckets.length === 0 ? (
              <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
                <Palette className="w-8 h-8 mx-auto text-gray-400 mb-2" />
                <p className="text-sm text-gray-500">No {attr.label.toLowerCase()} buckets yet</p>
                <p className="text-xs text-gray-400 mt-1">Type a {attr.label.toLowerCase()} above or click a saved value</p>
              </div>
            ) : (
              buckets.map((bucket, bi) => (
                <div
                  key={bi}
                  className={`border rounded-lg transition ${
                    dragOverBucket === bi ? 'border-orange-500 ring-2 ring-orange-200 bg-orange-100/70' : 'border-orange-200 bg-orange-50/40'
                  }`}
                  data-testid={`bucket-${bucket.name}`}
                  onDragOver={(e) => handleDragOver(e, bi)}
                  onDrop={(e) => handleDrop(e, bi)}
                  onDragLeave={() => setDragOverBucket(null)}
                >
                  <div className="flex items-center justify-between px-3 py-2 border-b border-orange-200">
                    <div className="flex items-center gap-2">
                      <ArrowRight className="w-3.5 h-3.5 text-orange-600" />
                      <span className="font-semibold text-sm text-orange-900">{flagFor(attr.key, bucket.name)} {bucket.name}</span>
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
                    <p className="text-[11px] text-gray-400 text-center py-3">
                      {dragOverBucket === bi ? '✨ Release to drop into this bucket' : 'Drag products here from the left'}
                    </p>
                  ) : (
                    <ul className="p-2 space-y-1">
                      {[...bucket.skus].map(sku => {
                        const p = productLookup.get(sku);
                        if (!p) return null;
                        return (
                          <li
                            key={sku}
                            draggable
                            onDragStart={(e) => handleDragStart(e, sku)}
                            className="text-xs bg-white rounded px-2 py-1 flex items-center gap-2 border border-orange-100 cursor-grab active:cursor-grabbing active:opacity-50"
                          >
                            <GripVertical className="w-3 h-3 text-gray-300 flex-shrink-0" />
                            <span className="truncate text-gray-800 flex-1" title={productName(p)}>{productName(p)}</span>
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
