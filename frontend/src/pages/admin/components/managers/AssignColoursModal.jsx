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
  Palette, Plus, X, Save, RefreshCw, ArrowRight, CheckCircle, AlertCircle, GripVertical, Tags, Layers, Sliders, LayoutGrid, FlaskConical,
} from 'lucide-react';
import { getSeriesName } from '../../lib/series';
import { SubCategoriesTab } from './SubCategoriesTab';
import { CustomSpecsTab } from './CustomSpecsTab';
import { SamplesTab } from './SamplesTab';
import { ShopTabsPanel } from './ShopTabsAssignModal';
import { PerBoxAutoFill } from './PerBoxAutoFill';

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

// Plural array field per attribute — where multi-values are stored
const ARRAY_FIELD_MAP = { color: 'colors', finish: 'finishes', size: 'sizes', material: 'materials', made_in: 'made_in_countries' };
export const arrayFieldFor = (attr) => attr.arrayField || ARRAY_FIELD_MAP[attr.key] || `${attr.key}s`;

// Numeric single-value fields — Replace mode only, stored as numbers
const NUMERIC_ATTRS = new Set(['tiles_per_box', 'sqm_per_box']);

// Special Order — flag + customer-facing note (e.g. "2-3 weeks delivery").
// Bucket name = the note text; saving sets special_order=true + the note,
// Remove mode clears both. Shown to customers on the product detail page.
const SPECIAL_ORDER_ATTR = { key: 'special_order_note', label: 'Special Order' };

// Sub-Category buckets — per-product assignment (unlike the Sub-Categories tab
// which tags the WHOLE selection). Default mode is Add so existing tags stay.
const SUBCAT_BUCKET_ATTR = { key: 'category', label: 'Sub-Category', arrayField: 'sub_categories' };

// Shared with ManagerPageShell's series completeness badges
export const computeCompleteness = (products, attributes) => {
  const rows = attributes.map(a => {
    const filled = products.filter(p => {
      const arr = p[arrayFieldFor(a)];
      if (Array.isArray(arr) && arr.length > 0) return true;
      const v = p[a.key] ?? (p.attributes ? p.attributes[a.key] : undefined);
      return v !== undefined && v !== null && String(v).trim() !== '';
    }).length;
    return { ...a, filled };
  });
  const total = products.length * rows.length;
  const done = rows.reduce((s, r) => s + r.filled, 0);
  return { rows, pct: total ? Math.round((done / total) * 100) : 0 };
};

const AssignColoursModal = ({ open, onOpenChange, selectedList = [], onSuccess, attributeOptions = [], subTabs = [], onCreateSubTab }) => {
  // The attribute being bucketed — Colour by default, switchable to any
  // Configure-defined filter/spec field (Finish, Size, Material, Thickness…)
  const [attr, setAttr] = useState(COLOUR_ATTR);
  const allAttributes = useMemo(() => {
    const extras = (attributeOptions || []).filter(a => a.key && !['color', 'special_order_note', 'category'].includes(a.key));
    return [COLOUR_ATTR, ...extras, SUBCAT_BUCKET_ATTR, SPECIAL_ORDER_ATTR];
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
    if (attr.key.startsWith('__')) { setSuggestions([]); return; }
    // Sub-Category buckets: seed suggestions with the Manager's existing tags
    const seed = attr.key === 'category'
      ? (subTabs || []).filter(t => t.key && t.key !== 'all').map(t => t.label || t.key)
      : [];
    fetch(`${API_URL}/api/attribute-values?fields=${encodeURIComponent(attr.key)}`)
      .then(res => (res.ok ? res.json() : null))
      .then(d => {
        const fetched = d?.values?.[attr.key] || [];
        const seen = new Set();
        const merged = [...seed, ...fetched].filter(v => {
          const k = String(v).toLowerCase();
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        setSuggestions(merged.slice(0, 30));
      })
      .catch(() => setSuggestions(seed.slice(0, 30)));
  }, [open, attr, subTabs]);

  // Save mode: 'replace' (one value per product) | 'add' (append multi-value)
  // | 'remove' (strip the bucket's value from the products in it)
  const [saveMode, setSaveMode] = useState('replace');
  const isMulti = saveMode !== 'replace';

  const switchAttribute = (a) => {
    if (a.key === attr.key) return;
    setAttr(a);
    setBuckets([]);   // buckets are per-attribute
    setNewColour('');
    // Sub-Category buckets default to Add — products keep their other tags
    setSaveMode(a.key === 'category' ? 'add' : 'replace');
  };

  // Delete a saved-value chip (also hides it from in-use suggestions)
  const deleteSavedValue = (value) => {
    setSuggestions(prev => prev.filter(s => s !== value));
    fetch(`${API_URL}/api/attribute-values/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field: attr.key, value }),
    }).then(() => toast.success(`Removed saved value "${value}"`)).catch(() => {});
  };

  // ---- Storefront variant label (Colour tab) — per-series Colour/Design/… selector ----
  const [seriesLabels, setSeriesLabels] = useState({});
  const seriesList = useMemo(() => {
    const s = new Set();
    selectedList.forEach(p => { const n = getSeriesName(p); if (n) s.add(n); });
    return [...s].slice(0, 20);
  }, [selectedList]);

  useEffect(() => {
    if (!open || seriesList.length === 0) return;
    Promise.all(seriesList.map(sn =>
      fetch(`${API_URL}/api/website-admin/collection-settings/${encodeURIComponent(sn)}`)
        .then(r => (r.ok ? r.json() : null))
        .then(d => [sn, d?.settings?.variant_label || ''])
        .catch(() => [sn, ''])
    )).then(pairs => setSeriesLabels(Object.fromEntries(pairs)));
  }, [open, seriesList]);

  const setVariantLabel = async (sn, value) => {
    setSeriesLabels(prev => ({ ...prev, [sn]: value }));
    try {
      const token = localStorage.getItem('token');
      const res = await fetch(`${API_URL}/api/website-admin/collections/${encodeURIComponent(sn)}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant_label: value || null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`"${sn}" storefront label → ${value || 'Auto'}`);
    } catch {
      toast.error(`Failed to update label for "${sn}"`);
    }
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
  // Drag a whole size-group header — carries every SKU in the group
  const handleGroupDragStart = (e, skus) => {
    e.dataTransfer.setData('text/skus', skus.join(','));
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleDragOver = (e, bucketIdx) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverBucket(bucketIdx);
  };
  const handleDrop = (e, bucketIdx) => {
    e.preventDefault();
    const multi = e.dataTransfer.getData('text/skus');
    const skus = multi ? multi.split(',').filter(Boolean) : [e.dataTransfer.getData('text/sku')].filter(Boolean);
    if (skus.length === 0) return;
    if (bucketIdx === 'pool') {
      // Drop into unassigned pool — remove from any bucket
      setBuckets(prev => prev.map(b => {
        const next = new Set(b.skus);
        skus.forEach(sku => next.delete(sku));
        return { ...b, skus: next };
      }));
    } else {
      setBuckets(prev => prev.map((b, i) => {
        const nextSkus = new Set(b.skus);
        if (i === bucketIdx) skus.forEach(sku => nextSkus.add(sku));
        else if (!isMulti) skus.forEach(sku => nextSkus.delete(sku));
        return { ...b, skus: nextSkus };
      }));
      if (skus.length > 1) toast.success(`${skus.length} products dropped into "${buckets[bucketIdx]?.name}"`);
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

  // Pool shown on the left: in add/remove modes products never leave the pool
  const poolProducts = isMulti ? selectedList : unassignedProducts;

  // ---- Group-by-size: assign a whole size group to a bucket in one click ----
  const [groupBySize, setGroupBySize] = useState(true);
  const sizeOf = (p) => {
    const raw = p.size || (p.attributes && p.attributes.size) || '';
    const s = String(raw).trim();
    if (s) return s;
    // fall back to a size pattern in the product name, e.g. 600x1200mm / 60x120cm
    const nm = String(p.product_name || p.display_name || p.name || '');
    const m = nm.match(/\d{2,4}\s*x\s*\d{2,4}(?:\s*x\s*\d{1,3})?\s*(?:mm|cm)?/i);
    return m ? m[0].replace(/\s+/g, '') : 'No size';
  };
  const sizeGroups = useMemo(() => {
    const map = new Map();
    poolProducts.forEach(p => {
      const key = sizeOf(p);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
  }, [poolProducts]);
  const showSizeGroups = groupBySize && sizeGroups.length > 1;

  // One-click: move/add every product of one size into the chosen bucket
  const assignGroupToBucket = (groupProducts, bucketName) => {
    const target = buckets.find(b => b.name === bucketName);
    const skus = groupProducts.map(p => p.sku || p.supplier_code).filter(s => s && !(target && target.skus.has(s)));
    if (skus.length === 0) return;
    setBuckets(prev => prev.map(b => {
      if (b.name === bucketName) return { ...b, skus: new Set([...b.skus, ...skus]) };
      if (!isMulti) {
        const next = new Set(b.skus);
        skus.forEach(sku => next.delete(sku));
        return { ...b, skus: next };
      }
      return b;
    }));
    toast.success(`${isMulti ? 'Added' : 'Moved'} ${skus.length} product(s) to "${bucketName}"`);
  };

  const addBucket = (presetName) => {
    const name = (presetName ?? newColour).trim();
    if (!name) return;
    if (buckets.some(b => b.name.toLowerCase() === name.toLowerCase())) {
      toast.error(`Bucket "${name}" already exists`);
      return;
    }
    setBuckets(prev => [...prev, { name, skus: new Set() }]);
    if (presetName === undefined) setNewColour('');
    // Persist immediately so the value survives even if this session is cancelled
    if (!suggestions.some(s => s.toLowerCase() === name.toLowerCase())) {
      setSuggestions(prev => [name, ...prev]);
      fetch(`${API_URL}/api/attribute-values/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field: attr.key, values: [name] }),
      }).catch(() => {});
    }
  };

  const removeBucket = (idx) => {
    setBuckets(prev => prev.filter((_, i) => i !== idx));
  };

  const moveSkuToBucket = (sku, bucketIdx) => {
    setBuckets(prev => prev.map((b, i) => {
      const nextSkus = new Set(b.skus);
      if (i === bucketIdx) nextSkus.add(sku);
      else if (!isMulti) nextSkus.delete(sku);
      return { ...b, skus: nextSkus };
    }));
  };

  // One-click: move every pool product into the chosen bucket
  const assignAllToBucket = (bucketName) => {
    const target = buckets.find(b => b.name === bucketName);
    const source = isMulti ? selectedList : unassignedProducts;
    const skus = source.map(p => p.sku || p.supplier_code).filter(s => s && !(target && target.skus.has(s)));
    if (skus.length === 0) return;
    setBuckets(prev => prev.map(b =>
      b.name === bucketName ? { ...b, skus: new Set([...b.skus, ...skus]) } : b
    ));
    toast.success(`${isMulti ? 'Added' : 'Moved'} ${skus.length} product(s) to "${bucketName}"`);
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
        const rawVal = bucket.name;
        const numVal = NUMERIC_ATTRS.has(attr.key) && !isNaN(Number(rawVal)) ? Number(rawVal) : rawVal;
        const updates = attr.key === 'special_order_note'
          ? (saveMode === 'remove'
              ? { special_order_note: '', special_order: false }
              : { special_order_note: rawVal, special_order: true })
          : saveMode === 'replace'
          ? { [attr.key]: numVal, ...(attr.arrayField ? { [attr.arrayField]: [rawVal] } : {}) }
          : { [arrayFieldFor(attr)]: [rawVal] };
        const requestMode = attr.key === 'special_order_note' ? 'replace' : (saveMode === 'add' ? 'append' : saveMode);
        for (const [ids, idField] of [[idsSku, 'sku'], [idsSupplierCode, 'supplier_code']]) {
          if (ids.length === 0) continue;
          const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              product_ids: ids,
              id_field: idField,
              updates,
              mode: requestMode,
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
        const verb = saveMode === 'add' ? 'Added' : saveMode === 'remove' ? 'Removed' : 'Assigned';
        const prep = saveMode === 'remove' ? 'from' : saveMode === 'add' ? 'on' : 'to';
        toast.success(`${verb} ${attr.label.toLowerCase()} value(s) ${prep} ${totalUpdated} product(s) — keep assigning or close when done`);
      }
      // Stay open with buckets + selection intact — user closes when done
      if (onSuccess) onSuccess({ updated: totalUpdated, failures: allVerFailures });
    } catch (err) {
      console.error('[Assign Attributes] Save failed', err);
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Completeness meter — how many of the selection have each attribute filled
  // (Special Order is optional, so it never counts against completeness)
  const completeness = useMemo(
    () => computeCompleteness(selectedList, allAttributes.filter(a => a.key !== 'special_order_note')),
    [selectedList, allAttributes]
  );

  const productName = (p) => (p.product_name || p.display_name || p.our_product_name || p.name || p.sku || p.supplier_code);

  const renderPoolRow = (p) => {
    const sku = p.sku || p.supplier_code;
    const memberships = isMulti ? buckets.filter(b => b.skus.has(sku)).map(b => b.name) : [];
    const curArr = Array.isArray(p[arrayFieldFor(attr)]) && p[arrayFieldFor(attr)].length > 0 ? p[arrayFieldFor(attr)] : null;
    const cur = curArr ? curArr.join(', ') : (p[attr.key] || null);
    return (
      <li
        key={sku || p._id}
        draggable
        onDragStart={(e) => handleDragStart(e, sku)}
        className="text-xs bg-gray-50 rounded px-2 py-1.5 flex items-center gap-2 cursor-grab active:cursor-grabbing hover:bg-gray-100 active:opacity-50"
      >
        <GripVertical className="w-3 h-3 text-gray-400 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-gray-800 break-words leading-snug" title={productName(p)}>{productName(p)}</div>
          <div className="text-[10px] text-gray-500 break-words">
            {p.supplier} · {sku}
            {cur && <span className="ml-1 text-orange-600">(current: {cur})</span>}
            {memberships.length > 0 && (
              <span className={`ml-1 font-medium ${saveMode === 'remove' ? 'text-red-600' : 'text-emerald-700'}`}>
                [{saveMode === 'remove' ? 'remove' : 'in'}: {memberships.join(', ')}]
              </span>
            )}
          </div>
        </div>
        {buckets.length > 0 && (
          <select
            className="text-[10px] border border-gray-300 rounded px-1 py-0.5 max-w-[95px] flex-shrink-0"
            value=""
            onChange={(e) => { if (e.target.value !== '') moveSkuToBucket(sku, Number(e.target.value)); }}
            data-testid={`move-to-bucket-${sku}`}
          >
            <option value="">{isMulti ? (saveMode === 'remove' ? 'Strip via…' : 'Add to…') : 'Move to…'}</option>
            {buckets.map((b, i) => (
              <option key={i} value={i} disabled={isMulti && b.skus.has(sku)}>{b.name.length > 40 ? `${b.name.slice(0, 40)}…` : b.name}</option>
            ))}
          </select>
        )}
      </li>
    );
  };

  // Special tabs merged in from the old Specs / Filters modal
  const isSpecial = attr.key.startsWith('__');
  const taggableSubTabs = (subTabs || []).filter(t => t.key && t.key !== 'all');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto" data-testid="assign-colours-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Palette className="w-5 h-5 text-orange-600" />
            Attribute Studio — {selectedList.length} product(s)
          </DialogTitle>
          <p className="text-xs text-gray-500">
            {attr.key === '__subcats'
              ? 'Add or remove sub-category tags across the whole selection — with 100% verification and Undo.'
              : attr.key === '__shoptabs'
                ? 'Tick every website tab these products should appear under — multiple tabs are fine. Amber − means only some of the selection is there now.'
                : attr.key === '__custom'
                ? 'Add your own spec fields (saved for reuse) and rename field labels across the selection.'
                : attr.key === '__samples'
                ? 'Turn the "Order a Sample" button off (or back on) for the selected products on the website.'
                : `Create a bucket per ${attr.label.toLowerCase()}, then move SKUs into the matching bucket. Each bucket becomes a separate save with 100% verification. ${saveMode === 'add' ? 'Multi-value mode: products can sit in several buckets and each save ADDS the value.' : saveMode === 'remove' ? 'Remove mode: each bucket STRIPS that value from the products you put in it.' : 'Products can only be in one bucket at a time.'}`}
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
            {taggableSubTabs.length > 0 && (
              <button
                type="button"
                onClick={() => switchAttribute({ key: '__subcats', label: 'Sub-Categories' })}
                className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-all inline-flex items-center gap-1 ${
                  attr.key === '__subcats' ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                }`}
                data-testid="assign-attr-__subcats"
              >
                <Layers className="w-3 h-3" /> Sub-Categories
              </button>
            )}
            <button
              type="button"
              onClick={() => switchAttribute({ key: '__shoptabs', label: 'Shop Tabs' })}
              className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-all inline-flex items-center gap-1 ${
                attr.key === '__shoptabs' ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
              }`}
              data-testid="assign-attr-__shoptabs"
            >
              <LayoutGrid className="w-3 h-3" /> Shop Tabs
            </button>
            <button
              type="button"
              onClick={() => switchAttribute({ key: '__custom', label: 'Custom Specs' })}
              className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-all inline-flex items-center gap-1 ${
                attr.key === '__custom' ? 'bg-violet-600 text-white' : 'bg-violet-50 text-violet-700 hover:bg-violet-100'
              }`}
              data-testid="assign-attr-__custom"
            >
              <Sliders className="w-3 h-3" /> Custom Specs
            </button>
            <button
              type="button"
              onClick={() => switchAttribute({ key: '__samples', label: 'Samples' })}
              className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-all inline-flex items-center gap-1 ${
                attr.key === '__samples' ? 'bg-rose-600 text-white' : 'bg-rose-50 text-rose-700 hover:bg-rose-100'
              }`}
              data-testid="assign-attr-__samples"
            >
              <FlaskConical className="w-3 h-3" /> Samples
            </button>
          </div>
        )}

        {/* Completeness meter — live gaps overview, click a chip to jump to that attribute */}
        {selectedList.length > 0 && (
          <div className="rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2" data-testid="studio-progress-bar">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[10px] uppercase tracking-wide font-semibold text-gray-500">Completeness</span>
              <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    completeness.pct === 100 ? 'bg-emerald-500' : completeness.pct >= 50 ? 'bg-amber-400' : 'bg-red-400'
                  }`}
                  style={{ width: `${completeness.pct}%` }}
                />
              </div>
              <span className="text-[11px] font-semibold text-gray-600" data-testid="studio-progress-pct">{completeness.pct}%</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {completeness.rows.map(r => {
                const full = r.filled === selectedList.length;
                const empty = r.filled === 0;
                return (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => switchAttribute(r)}
                    title={full ? `Every selected product has a ${r.label.toLowerCase()}` : `${selectedList.length - r.filled} product(s) missing ${r.label.toLowerCase()} — click to fill`}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-medium transition-colors ${
                      full
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
                        : empty
                          ? 'bg-red-50 border-red-200 text-red-600 hover:bg-red-100'
                          : 'bg-amber-50 border-amber-300 text-amber-700 hover:bg-amber-100'
                    }`}
                    data-testid={`progress-chip-${r.key}`}
                  >
                    {full && <CheckCircle className="w-2.5 h-2.5" />}
                    {r.label} {r.filled}/{selectedList.length}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {attr.key === '__subcats' && (
          <SubCategoriesTab
            selectedList={selectedList}
            subTabs={taggableSubTabs}
            onSuccess={onSuccess}
            onCreateTag={onCreateSubTab}
            onSwitchToBuckets={() => switchAttribute(SUBCAT_BUCKET_ATTR)}
          />
        )}
        {attr.key === '__samples' && (
          <SamplesTab selectedList={selectedList} onSuccess={onSuccess} />
        )}
        {attr.key === '__shoptabs' && (
          <ShopTabsPanel selectedProducts={selectedList} onSaved={onSuccess} embedded />
        )}
        {attr.key === '__custom' && (
          <CustomSpecsTab selectedList={selectedList} attributeOptions={allAttributes} onSuccess={onSuccess} />
        )}

        {!isSpecial && (
        <>
        {/* Storefront variant label — Colour tab only, saved per series instantly */}
        {attr.key === 'color' && seriesList.length > 0 && (
          <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 px-3 py-2" data-testid="variant-label-panel">
            <div className="flex items-center gap-2 mb-1.5">
              <Tags className="w-3.5 h-3.5 text-indigo-600" />
              <span className="text-xs font-semibold text-indigo-900">Storefront variant label</span>
              <span className="text-[10px] text-indigo-500">how the selector row is titled on Collection &amp; Product pages — Auto detects colour vs design names. Saves instantly.</span>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {seriesList.length > 1 && (
                <label className="flex items-center gap-1.5 text-xs text-indigo-800 font-semibold border-r border-indigo-200 pr-4">
                  Set all {seriesList.length} series to
                  <select
                    value=""
                    onChange={(e) => { const v = e.target.value; if (v !== '__none') seriesList.forEach(sn => setVariantLabel(sn, v)); }}
                    className="h-6 text-[11px] border border-indigo-300 rounded px-1 bg-white text-gray-700 font-normal"
                    data-testid="variant-label-all"
                  >
                    <option value="__none">choose…</option>
                    <option value="">Auto</option>
                    {['Colour', 'Design', 'Pattern', 'Style', 'Range'].map(o => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                </label>
              )}
              {seriesList.map(sn => (
                <label key={sn} className="flex items-center gap-1.5 text-xs text-gray-700">
                  <span className="font-medium truncate max-w-[180px]" title={sn}>{sn}</span>
                  <select
                    value={seriesLabels[sn] || ''}
                    onChange={(e) => setVariantLabel(sn, e.target.value)}
                    className="h-6 text-[11px] border border-indigo-200 rounded px-1 bg-white text-gray-700"
                    data-testid={`variant-label-${sn}`}
                  >
                    <option value="">Auto</option>
                    {['Colour', 'Design', 'Pattern', 'Style', 'Range'].map(o => (
                      <option key={o} value={o}>{o}</option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Save mode: Replace (single) vs Add (multi-value) vs Remove (strip value) */}
        <div className="flex items-center gap-2 pt-1">
          <span className="text-[10px] uppercase tracking-wide text-gray-400">Save as:</span>
          <div className="inline-flex rounded-full border border-gray-200 overflow-hidden text-[11px] font-medium">
            <button
              type="button"
              onClick={() => setSaveMode('replace')}
              className={`px-2.5 py-1 transition-colors ${saveMode === 'replace' ? 'bg-orange-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
              data-testid="mode-replace-btn"
            >
              Replace value
            </button>
            {!NUMERIC_ATTRS.has(attr.key) && (
            <>
            {attr.key !== 'special_order_note' && (
            <button
              type="button"
              onClick={() => setSaveMode('add')}
              className={`px-2.5 py-1 transition-colors ${saveMode === 'add' ? 'bg-emerald-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
              data-testid="mode-add-btn"
            >
              + Add (multi-value)
            </button>
            )}
            <button
              type="button"
              onClick={() => setSaveMode('remove')}
              className={`px-2.5 py-1 transition-colors ${saveMode === 'remove' ? 'bg-red-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
              data-testid="mode-remove-btn"
            >
              − Remove value
            </button>
            </>
            )}
          </div>
          <span className="text-[10px] text-gray-400">
            {attr.key === 'special_order_note'
              ? saveMode === 'remove'
                ? 'Each bucket CLEARS the Special Order flag + note from the products you put in it'
                : 'Marks products as Special Order — the note is shown to customers on the product page (e.g. 2-3 weeks delivery)'
              : NUMERIC_ATTRS.has(attr.key)
              ? `Numeric field — one ${attr.label.toLowerCase()} per product, shown on the Product detail page${attr.key === 'tiles_per_box' ? '. M² per box auto-calculates from tile size when you save' : ''}`
              : saveMode === 'add'
              ? `Products can sit in several buckets — each bucket ADDS a ${attr.label.toLowerCase()} without replacing existing ones`
              : saveMode === 'remove'
                ? `Each bucket STRIPS that ${attr.label.toLowerCase()} from the products you put in it — existing other values stay`
                : `One ${attr.label.toLowerCase()} per product — saving replaces the old value`}
          </span>
        </div>

        {/* Per-box auto-fill — computes the value from tile size, one click to save */}
        {NUMERIC_ATTRS.has(attr.key) && (
          <PerBoxAutoFill attr={attr} selectedList={selectedList} onSuccess={onSuccess} />
        )}

        {/* Add-a-bucket bar */}
        <div className="flex items-center gap-2 py-2">
          <Input
            placeholder={attr.key === 'special_order_note' ? 'Type the customer note (e.g. Special order — 2-3 weeks delivery)' : `Type a ${attr.label.toLowerCase()} ${NUMERIC_ATTRS.has(attr.key) ? 'number' : 'name'} (e.g. ${attr.key === 'color' ? 'Grey, White, Beige…' : attr.key === 'size' ? '30x60cm, 60x60cm…' : attr.key === 'finish' ? 'Matt, Polished…' : attr.key === 'tiles_per_box' ? '4, 6, 8…' : attr.key === 'sqm_per_box' ? '1.08, 1.44…' : 'value…'})`}
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
                <span
                  key={s}
                  className="group/chip inline-flex items-center rounded-full bg-orange-50 border border-orange-200 text-orange-800 text-[11px] hover:bg-orange-100 transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => addBucket(s)}
                    className="pl-2 pr-1 py-0.5"
                    data-testid={`bucket-suggestion-${i}`}
                  >
                    + {flagFor(attr.key, s)} {s}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); deleteSavedValue(s); }}
                    className="pr-1.5 pl-0.5 py-0.5 text-orange-300 hover:text-red-600 opacity-0 group-hover/chip:opacity-100 transition-opacity"
                    title={`Delete saved value "${s}"`}
                    data-testid={`delete-suggestion-${i}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
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
              <h4 className="font-semibold text-sm text-gray-700">{isMulti ? 'All products' : 'Unassigned'}</h4>
              <div className="flex items-center gap-1.5">
                {sizeGroups.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setGroupBySize(v => !v)}
                    className={`h-6 px-2 text-[11px] rounded border font-medium inline-flex items-center gap-1 transition-colors ${
                      groupBySize ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
                    }`}
                    title="Group products by size — assign a whole size to a bucket in one click"
                    data-testid="group-by-size-toggle"
                  >
                    <Layers className="w-3 h-3" /> By size
                  </button>
                )}
                {poolProducts.length > 0 && buckets.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) assignAllToBucket(e.target.value); }}
                    className="h-6 text-[11px] border border-orange-300 rounded px-1 bg-orange-50 text-orange-800 font-medium max-w-[130px]"
                    title={isMulti ? 'Add every product to one bucket in one go' : 'Move every unassigned product into one bucket in one go'}
                    data-testid="assign-all-select"
                  >
                    <option value="">{isMulti ? 'Add all to…' : 'Assign all to…'}</option>
                    {buckets.map(b => (
                      <option key={b.name} value={b.name}>{b.name}</option>
                    ))}
                  </select>
                )}
                <Badge variant="outline" className="text-xs">{poolProducts.length}</Badge>
              </div>
            </div>
            {poolProducts.length === 0 ? (
              <p className="text-xs text-gray-400 text-center py-4">
                <CheckCircle className="w-5 h-5 mx-auto mb-1 text-emerald-500" />
                All selected products are in a bucket
              </p>
            ) : showSizeGroups ? (
              <div className="space-y-3">
                {sizeGroups.map(([size, items]) => {
                  const groupSkus = items.map(p => p.sku || p.supplier_code).filter(Boolean);
                  return (
                    <div key={size} data-testid={`size-group-${size}`}>
                      <div
                        draggable
                        onDragStart={(e) => handleGroupDragStart(e, groupSkus)}
                        className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-indigo-50 border border-indigo-100 mb-1 cursor-grab active:cursor-grabbing"
                        title="Drag this whole size group into a bucket — or use the dropdown"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <GripVertical className="w-3 h-3 text-indigo-300 flex-shrink-0" />
                          <span className="text-[11px] font-bold text-indigo-900 truncate">{size}</span>
                          <Badge variant="outline" className="text-[10px] bg-white">{items.length}</Badge>
                        </div>
                        {buckets.length > 0 && (
                          <select
                            className="h-5 text-[10px] border border-indigo-300 rounded px-1 bg-white text-indigo-800 font-medium max-w-[120px] flex-shrink-0"
                            value=""
                            onChange={(e) => { if (e.target.value) assignGroupToBucket(items, e.target.value); }}
                            data-testid={`assign-group-${size}`}
                          >
                            <option value="">{isMulti ? 'Add group to…' : 'Move group to…'}</option>
                            {buckets.map(b => (
                              <option key={b.name} value={b.name}>{b.name.length > 35 ? `${b.name.slice(0, 35)}…` : b.name}</option>
                            ))}
                          </select>
                        )}
                      </div>
                      <ul className="space-y-1 pl-2">
                        {items.map(renderPoolRow)}
                      </ul>
                    </div>
                  );
                })}
              </div>
            ) : (
              <ul className="space-y-1">
                {poolProducts.map(renderPoolRow)}
              </ul>
            )}
            <p className="text-[10px] text-gray-400 text-center mt-2 italic">
              💡 Drag products {showSizeGroups ? '— or a whole size group —' : ''} right → into a {attr.label.toLowerCase()} bucket
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
                            <span className="break-words leading-snug text-gray-800 flex-1 min-w-0" title={productName(p)}>{productName(p)}</span>
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
        </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving} data-testid="studio-close-btn">
            {isSpecial ? 'Close' : 'Cancel'}
          </Button>
          {!isSpecial && (
          <Button
            onClick={handleSave}
            disabled={saving || buckets.every(b => b.skus.size === 0)}
            className="bg-orange-600 hover:bg-orange-700 text-white"
            data-testid="assign-colours-save"
          >
            {saving ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
            Save {buckets.reduce((sum, b) => sum + b.skus.size, 0)} product(s)
          </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default AssignColoursModal;
