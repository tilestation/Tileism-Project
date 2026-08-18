/**
 * BulkSpecsFiltersModal — bulk-set Configure-driven fields on selected products.
 *
 * Reads the current Manager's `config` (filter_facets + sub_tabs + spec_fields)
 * and dynamically renders a form field per row. The admin ticks which fields
 * to write; empty rows are ignored. Save calls /api/supplier-sync/products/
 * bulk-update-unified with the checked fields as `updates`.
 *
 * This is the "any Configure field → immediately available in Action Bar"
 * promise: if you add a filter/spec/sub-tab via Configure, it lands here
 * without needing a code change.
 */
import React, { useState, useMemo, useEffect } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Badge } from '../../../../components/ui/badge';
import { Sliders, Filter, Layers, Save, RefreshCw, X, Sparkles, Eye, Undo2, PenLine, Plus } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Which config keys drive which "source" section
const SECTIONS = [
  { source: 'filter_facets', icon: Filter,  label: 'Filters',        color: 'text-blue-600'  },
  { source: 'spec_fields',   icon: Sliders, label: 'Spec Fields',    color: 'text-orange-600' },
  { source: 'sub_tabs',      icon: Layers,  label: 'Sub-Categories', color: 'text-emerald-600' },
];

const themeBtnCls = {
  orange:'bg-orange-600 hover:bg-orange-700',
  blue:  'bg-blue-600   hover:bg-blue-700',
  amber: 'bg-amber-600  hover:bg-amber-700',
  cyan:  'bg-cyan-600   hover:bg-cyan-700',
  red:   'bg-red-600    hover:bg-red-700',
  slate: 'bg-slate-700  hover:bg-slate-800',
  emerald:'bg-emerald-600 hover:bg-emerald-700',
  purple:'bg-purple-600 hover:bg-purple-700',
};

/**
 * Normalize a config row into a single editable "field" descriptor.
 * Different sections use different property names; this smooths that over.
 */
const normalizeRows = (config) => {
  if (!config) return [];
  const rows = [];
  for (const section of SECTIONS) {
    const items = Array.isArray(config[section.source]) ? config[section.source] : [];
    for (const item of items) {
      // Filter facets use `field` as the writable key; specs use `key`; sub_tabs use `key` but represent membership.
      const key = section.source === 'filter_facets' ? (item.field || item.key) : item.key;
      if (!key) continue;
      rows.push({
        source: section.source,
        section: section.label,
        icon: section.icon,
        color: section.color,
        key,
        label: item.label || key,
        type: item.type || 'text',
        options: Array.isArray(item.options) ? item.options : (Array.isArray(item.keywords) ? item.keywords : null),
        array_field: section.source === 'filter_facets' ? item.array_field : null,
        hint: item.hint || null,
      });
    }
  }
  return rows;
};

const BulkSpecsFiltersModal = ({ open, onOpenChange, config, selectedProducts, categoryLabel, themeColor = 'orange', onSuccess }) => {
  const rows = useMemo(() => normalizeRows(config), [config]);
  const [checked, setChecked] = useState({});   // { key: true }
  const [values, setValues]   = useState({});   // { key: value }
  const [saving, setSaving]   = useState(false);
  // Label renames — applied to every selected product as field_label_overrides
  const [labelOverrides, setLabelOverrides] = useState({});
  const [editingLabelKey, setEditingLabelKey] = useState(null);
  // Ad-hoc custom fields — appended to each product's custom_specs
  const [customFields, setCustomFields] = useState([]); // [{label, value}]

  const themeBtn = themeBtnCls[themeColor] || themeBtnCls.orange;

  // Saved / previously-used values per field — "pick instead of type"
  const [suggestions, setSuggestions] = useState({});
  useEffect(() => {
    if (!open || rows.length === 0) return;
    const keys = rows
      .filter(r => r.source !== 'sub_tabs' && !(r.type === 'select' && r.options))
      .map(r => r.key);
    if (keys.length === 0) return;
    fetch(`${API_URL}/api/attribute-values?fields=${encodeURIComponent(keys.join(','))}`)
      .then(res => (res.ok ? res.json() : null))
      .then(d => setSuggestions(d?.values || {}))
      .catch(() => setSuggestions({}));
  }, [open, rows]);

  const toggle = (key) => setChecked(prev => ({ ...prev, [key]: !prev[key] }));
  const setVal = (key, v) => setValues(prev => ({ ...prev, [key]: v }));

  // Sub-category rows count as "ready to apply" the moment they're ticked
  // (the tick itself is the intent — no value needed). Filter/spec rows
  // still need a typed value.
  const isReadyToApply = (r) => {
    if (!checked[r.key]) return false;
    if (r.source === 'sub_tabs') return true;
    const v = values[r.key];
    return v !== undefined && v !== '';
  };
  const checkedCount = rows.filter(isReadyToApply).length;

  // Cleaned custom fields ready to persist (same key derivation as Quick Edit)
  const cleanedCustom = useMemo(() => (customFields || [])
    .map(cs => ({
      key: (cs.label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
      label: (cs.label || '').trim(),
      value: cs.value ?? '',
    }))
    .filter(cs => cs.label && cs.value !== ''), [customFields]);
  const overridesCount = Object.keys(labelOverrides).length;
  const extraWritesCount = cleanedCustom.length + (overridesCount > 0 ? 1 : 0);

  // Compute the intended writes as a plain object so both the preview row
  // and the save handler share one truth. Returns { updates, subCategoryTags }.
  const computePendingWrites = () => {
    const updates = {};
    const subCategoryTags = [];
    for (const r of rows) {
      if (!checked[r.key]) continue;
      if (r.source === 'sub_tabs') {
        subCategoryTags.push(r.key);
        continue;
      }
      const v = values[r.key];
      if (v === undefined || v === '') continue;
      if (r.array_field) {
        updates[r.array_field] = updates[r.array_field] || [];
        updates[r.array_field].push(v);
        continue;
      }
      updates[r.key] = r.type === 'number' ? Number(v) : v;
    }
    return { updates, subCategoryTags };
  };

  // Build a per-SKU snapshot of the fields we are about to change so Undo
  // can restore each product exactly. Called BEFORE the API request fires.
  const buildSnapshot = (skus, writes) => {
    const perSku = {};
    const bySku = {};
    (selectedProducts || []).forEach(p => { const k = p.sku || p.supplier_code; if (k) bySku[k] = p; });
    for (const sku of skus) {
      const p = bySku[sku] || {};
      const before = {};
      for (const k of Object.keys(writes.updates)) {
        before[k] = p[k] ?? (Array.isArray(p[k]) ? [] : null);
      }
      // Sub-category tags: snapshot the whole current array so undo can restore it verbatim
      if (writes.subCategoryTags.length > 0) {
        before.sub_categories = Array.isArray(p.sub_categories) ? [...p.sub_categories] : [];
      }
      // Label renames + custom fields: snapshot current values so undo restores verbatim
      if (overridesCount > 0) {
        before.field_label_overrides = { ...(p.field_label_overrides || {}) };
      }
      if (cleanedCustom.length > 0) {
        before.custom_specs = Array.isArray(p.custom_specs) ? p.custom_specs.map(cs => ({ ...cs })) : [];
      }
      perSku[sku] = before;
    }
    return perSku;
  };

  // Rewind a completed bulk-apply by pushing each SKU's snapshot back through
  // bulk-update-unified with mode:replace. One request per SKU because each
  // row's target values are different.
  const runUndo = async (snapshot) => {
    if (!snapshot || Object.keys(snapshot).length === 0) return;
    const skus = Object.keys(snapshot);
    let ok = 0; let failed = 0;
    for (const sku of skus) {
      try {
        const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_ids: [sku],
            updates: snapshot[sku],
            mode: 'replace',
            update_mode: 'replace',
            id_field: 'sku',
          }),
        });
        if (res.ok) ok++; else failed++;
      } catch { failed++; }
    }
    if (failed === 0) toast.success(`Undo complete — ${ok} product${ok !== 1 ? 's' : ''} reverted`);
    else toast.warning(`Undo finished with ${failed} failure${failed !== 1 ? 's' : ''} (${ok} reverted)`);
    onSuccess && onSuccess();
  };

  const handleSave = async () => {
    const { updates, subCategoryTags } = computePendingWrites();

    if (Object.keys(updates).length === 0 && (!subCategoryTags || subCategoryTags.length === 0) && extraWritesCount === 0) {
      toast.error('Nothing to save — tick a field, add a custom field, or rename a label');
      return;
    }
    if (!selectedProducts || selectedProducts.length === 0) {
      toast.error('No products selected');
      return;
    }

    setSaving(true);
    try {
      const skus = selectedProducts.map(p => p.sku || p.supplier_code).filter(Boolean);
      // Build snapshot BEFORE we mutate anything so Undo can rewind cleanly.
      const snapshot = buildSnapshot(skus, { updates, subCategoryTags });
      // Main updates
      if (Object.keys(updates).length > 0) {
        const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_ids: skus,
            updates,
            mode: 'append',
            update_mode: 'replace',
            id_field: 'sku',
          }),
        });
        if (!res.ok) throw new Error(`Bulk update HTTP ${res.status}`);
      }
      // Sub-category tags (each tag applied as a sub_categories append)
      if (subCategoryTags && subCategoryTags.length > 0) {
        const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_ids: skus,
            updates: { sub_categories: subCategoryTags },
            mode: 'append',
            update_mode: 'replace',
            id_field: 'sku',
          }),
        });
        if (!res.ok) throw new Error(`Sub-category tag HTTP ${res.status}`);
      }
      // Label renames + custom fields — merged per product (each product keeps
      // its own existing overrides/custom specs; new ones win on key clash).
      if (extraWritesCount > 0) {
        for (const p of selectedProducts) {
          const sku = p.sku || p.supplier_code;
          if (!sku) continue;
          const per = {};
          if (overridesCount > 0) {
            per.field_label_overrides = { ...(p.field_label_overrides || {}), ...labelOverrides };
          }
          if (cleanedCustom.length > 0) {
            const existing = Array.isArray(p.custom_specs) ? p.custom_specs : [];
            const newKeys = new Set(cleanedCustom.map(c => c.key));
            per.custom_specs = [...existing.filter(cs => !newKeys.has(cs.key)), ...cleanedCustom];
          }
          const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              product_ids: [sku],
              updates: per,
              mode: 'replace',
              update_mode: 'replace',
              id_field: p.sku ? 'sku' : 'supplier_code',
            }),
          });
          if (!res.ok) throw new Error(`Custom fields HTTP ${res.status}`);
        }
      }
      // Success — show a 15-second undo toast so a mistyped change can be reversed.
      // Also remember every typed value so it appears as a one-click chip next time.
      for (const r of rows) {
        if (!checked[r.key] || r.source === 'sub_tabs') continue;
        const v = values[r.key];
        if (v === undefined || v === '' || r.type === 'number') continue;
        fetch(`${API_URL}/api/attribute-values/save`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field: r.key, values: [String(v)] }),
        }).catch((e) => console.warn('attribute-values/save failed', e));
      }
      const appliedTotal = checkedCount + extraWritesCount;
      toast.success(
        `Applied ${appliedTotal} field${appliedTotal !== 1 ? 's' : ''} to ${selectedProducts.length} product${selectedProducts.length !== 1 ? 's' : ''}`,
        {
          duration: 15000,
          action: {
            label: 'Undo',
            onClick: () => runUndo(snapshot),
          },
        }
      );
      onSuccess && onSuccess();
      setChecked({});
      setValues({});
      setLabelOverrides({});
      setCustomFields([]);
      onOpenChange(false);
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const groupedRows = useMemo(() => {
    const groups = {};
    for (const r of rows) {
      groups[r.section] = groups[r.section] || [];
      groups[r.section].push(r);
    }
    return groups;
  }, [rows]);

  // Build a lightweight preview of what ONE selected product will look like
  // after Apply. Uses the first selected product as the demo row and folds
  // in the ticked fields so the admin can eyeball the change before commit.
  const previewLines = useMemo(() => {
    if (checkedCount === 0) return [];
    const demo = (selectedProducts && selectedProducts[0]) || null;
    if (!demo) return [];
    const { updates, subCategoryTags } = computePendingWrites();
    const lines = [];
    const fmt = (v) => {
      if (v === undefined || v === null || v === '') return <span className="text-gray-400">—</span>;
      if (Array.isArray(v)) return v.length === 0 ? <span className="text-gray-400">— (empty)</span> : v.join(', ');
      return String(v);
    };
    // Scalar / array_field writes
    for (const [k, v] of Object.entries(updates)) {
      lines.push({
        key: k,
        before: fmt(demo[k]),
        after: fmt(v),
        isTag: false,
      });
    }
    // Sub-category tag appends: show current + newly added tags together
    if (subCategoryTags.length > 0) {
      const current = Array.isArray(demo.sub_categories) ? demo.sub_categories : [];
      const merged = Array.from(new Set([...current, ...subCategoryTags]));
      lines.push({
        key: 'sub_categories',
        before: fmt(current),
        after: (
          <span>
            {merged.map((t, i) => (
              <span
                key={t}
                className={`inline-block px-1.5 py-0.5 rounded mr-1 text-[10px] ${subCategoryTags.includes(t) && !current.includes(t) ? 'bg-emerald-100 text-emerald-800 font-semibold' : 'bg-gray-100 text-gray-700'}`}
              >
                {t}{subCategoryTags.includes(t) && !current.includes(t) ? ' ✚' : ''}
              </span>
            ))}
          </span>
        ),
        isTag: true,
      });
    }
    return lines;
  }, [checked, values, selectedProducts, checkedCount]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-slate-700" />
            Bulk edit Categories, Specs &amp; Filters — {categoryLabel}
          </DialogTitle>
          <DialogDescription className="text-xs text-gray-500">
            Applied to <b>{selectedProducts?.length || 0}</b> selected product{selectedProducts?.length !== 1 ? 's' : ''}.
            {' '}
            <b className="text-blue-700">Filters</b> &amp; <b className="text-orange-700">Spec Fields</b>: tick + type a value (e.g. Colour → &quot;Grey&quot;).
            {' '}
            <b className="text-emerald-700">Sub-Categories</b>: just tick to add that tag — no typing needed.
            {' '}
            All fields come from your <b>Configure</b> setup — anything you add there appears here next time.
          </DialogDescription>
        </DialogHeader>

        {rows.length === 0 ? (
          <div className="text-center py-8 text-sm text-gray-500">
            <p className="mb-1">No fields configured yet.</p>
            <p className="text-xs">Open <b>Configure</b> at the top of the page to add Filters, Sub-Tabs, or Spec Fields — they&apos;ll show up here.</p>
          </div>
        ) : (
          <div className="space-y-4" data-testid="bulk-specs-form">
            {Object.entries(groupedRows).map(([sectionLabel, sectionRows]) => {
              const Icon = sectionRows[0].icon;
              return (
                <div key={sectionLabel} className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className={`px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-2 text-xs font-semibold ${sectionRows[0].color}`}>
                    <Icon className="w-3.5 h-3.5" />
                    {sectionLabel}
                    <Badge variant="outline" className="ml-auto text-[10px]">{sectionRows.length}</Badge>
                  </div>
                  <div className="divide-y divide-gray-100">
                    {sectionRows.map(r => (
                      <div key={`${r.source}-${r.key}`} className="flex items-start gap-2 p-2 hover:bg-slate-50/50" data-testid={`bulk-field-${r.key}`}>
                        <input
                          type="checkbox"
                          checked={!!checked[r.key]}
                          onChange={() => toggle(r.key)}
                          className="mt-1.5 w-4 h-4 rounded border-gray-300"
                          data-testid={`bulk-field-check-${r.key}`}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium text-gray-800 flex items-center gap-2">
                            {r.source === 'sub_tabs' ? (
                              <span>{labelOverrides[r.key] ?? r.label}</span>
                            ) : editingLabelKey === r.key ? (
                              <input
                                autoFocus
                                type="text"
                                value={labelOverrides[r.key] ?? r.label}
                                onChange={(e) => setLabelOverrides(prev => ({ ...prev, [r.key]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditingLabelKey(null); }}
                                className="text-xs font-medium border border-blue-300 rounded px-1 py-0.5 w-40"
                                data-testid={`bulk-field-label-input-${r.key}`}
                              />
                            ) : (
                              <button
                                type="button"
                                onClick={() => setEditingLabelKey(r.key)}
                                className="text-left hover:text-blue-700 hover:underline inline-flex items-center gap-1"
                                title="Click to rename this field label on all selected products"
                                data-testid={`bulk-field-label-${r.key}`}
                              >
                                <span>{labelOverrides[r.key] ?? r.label}</span>
                                <PenLine className="w-2.5 h-2.5 text-gray-400" />
                              </button>
                            )}
                            <code className="text-[10px] font-mono text-gray-400">{r.key}</code>
                            {r.array_field && <Badge variant="outline" className="text-[9px] py-0 px-1">Array append</Badge>}
                            {labelOverrides[r.key] !== undefined && labelOverrides[r.key] !== r.label && (
                              <button
                                type="button"
                                onClick={() => setLabelOverrides(prev => { const n = { ...prev }; delete n[r.key]; return n; })}
                                className="text-[9px] text-blue-500 hover:text-blue-700 hover:underline"
                                title="Reset to default label"
                                data-testid={`bulk-field-label-reset-${r.key}`}
                              >
                                reset
                              </button>
                            )}
                          </div>
                          {r.hint && <div className="text-[10px] text-gray-400">{r.hint}</div>}
                        </div>
                        <div className="w-56 flex-shrink-0">
                          {r.source === 'sub_tabs' ? (
                            <div className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1.5 leading-tight">
                              {checked[r.key]
                                ? <span>Will add <code className="font-mono">{r.key}</code> tag to each product</span>
                                : <span className="text-gray-400">Tick to add this sub-category tag</span>
                              }
                            </div>
                          ) : r.type === 'select' && r.options ? (
                            <select
                              value={values[r.key] ?? ''}
                              onChange={(e) => { setVal(r.key, e.target.value); if (!checked[r.key]) toggle(r.key); }}
                              className="w-full h-8 text-xs border border-gray-300 rounded px-2"
                              data-testid={`bulk-field-input-${r.key}`}
                            >
                              <option value="">— select value —</option>
                              {r.options.map(o => <option key={o} value={o}>{o}</option>)}
                            </select>
                          ) : (
                            <>
                              <Input
                                type={r.type === 'number' ? 'number' : 'text'}
                                value={values[r.key] ?? ''}
                                onChange={(e) => { setVal(r.key, e.target.value); if (!checked[r.key] && e.target.value !== '') toggle(r.key); }}
                                placeholder={r.hint || 'e.g. Grey, 60x60, Matt'}
                                className="h-8 text-xs"
                                data-testid={`bulk-field-input-${r.key}`}
                              />
                              {(suggestions[r.key] || []).length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-1" data-testid={`bulk-field-suggestions-${r.key}`}>
                                  {(suggestions[r.key] || []).slice(0, 6).map((s, i) => (
                                    <button
                                      key={s}
                                      type="button"
                                      onClick={() => { setVal(r.key, s); if (!checked[r.key]) toggle(r.key); }}
                                      className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                                        values[r.key] === s
                                          ? 'bg-slate-700 border-slate-700 text-white'
                                          : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                                      }`}
                                      title={s}
                                      data-testid={`value-chip-${r.key}-${i}`}
                                    >
                                      {s.length > 26 ? s.slice(0, 24) + '…' : s}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Ad-hoc custom fields — appended to every selected product's specs */}
        <div className="border border-dashed border-blue-200 rounded-lg overflow-hidden" data-testid="bulk-custom-fields">
          <div className="px-3 py-2 bg-blue-50/60 border-b border-blue-100 flex items-center gap-2 text-xs font-semibold text-blue-700">
            <Plus className="w-3.5 h-3.5" />
            Custom Fields
            <span className="font-normal text-[10px] text-blue-500">added to all {selectedProducts?.length || 0} selected products (e.g. Bottle Volume, Dilution Ratio)</span>
            {cleanedCustom.length > 0 && <Badge variant="outline" className="ml-auto text-[10px]">{cleanedCustom.length}</Badge>}
          </div>
          <div className="p-2 space-y-2">
            {customFields.map((cf, idx) => (
              <div key={idx} className="flex items-center gap-2" data-testid={`bulk-custom-field-row-${idx}`}>
                <Input
                  type="text"
                  value={cf.label}
                  onChange={(e) => setCustomFields(prev => prev.map((r, i) => i === idx ? { ...r, label: e.target.value } : r))}
                  placeholder="Field name (e.g. Bottle Volume)"
                  className="h-8 text-xs flex-1"
                  data-testid={`bulk-custom-field-label-${idx}`}
                />
                <Input
                  type="text"
                  value={cf.value}
                  onChange={(e) => setCustomFields(prev => prev.map((r, i) => i === idx ? { ...r, value: e.target.value } : r))}
                  placeholder="Value (e.g. 1L)"
                  className="h-8 text-xs w-56"
                  data-testid={`bulk-custom-field-value-${idx}`}
                />
                <button
                  type="button"
                  onClick={() => setCustomFields(prev => prev.filter((_, i) => i !== idx))}
                  className="p-1 text-rose-500 hover:bg-rose-50 rounded"
                  title="Remove this field"
                  data-testid={`bulk-custom-field-remove-${idx}`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setCustomFields(prev => [...prev, { label: '', value: '' }])}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-700 text-[11px] font-semibold"
              data-testid="bulk-add-custom-field-btn"
            >
              <Plus className="w-3 h-3" /> Add custom field
            </button>
            <span className="ml-2 text-[10px] text-slate-400">
              Rename any label above by clicking it — renames apply to all selected products.
            </span>
          </div>
        </div>

        {previewLines.length > 0 && selectedProducts && selectedProducts[0] && (
          <div className="mt-3 border-2 border-dashed border-slate-300 rounded-lg overflow-hidden" data-testid="bulk-specs-preview">
            <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-2 text-xs font-semibold text-slate-700">
              <Eye className="w-3.5 h-3.5" />
              Preview — how <b className="text-slate-900">{selectedProducts[0].product_name || selectedProducts[0].our_product_name || selectedProducts[0].name || selectedProducts[0].sku}</b> will look after Apply
              <Badge variant="outline" className="ml-auto text-[10px]">
                +{selectedProducts.length - 1} more product{selectedProducts.length - 1 !== 1 ? 's' : ''} will change the same way
              </Badge>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-white border-b border-gray-100 text-[10px] uppercase tracking-wider text-gray-500">
                  <th className="text-left px-3 py-1.5 font-medium w-1/4">Field</th>
                  <th className="text-left px-3 py-1.5 font-medium w-1/3">Before</th>
                  <th className="text-left px-3 py-1.5 font-medium">After</th>
                </tr>
              </thead>
              <tbody>
                {previewLines.map((line) => (
                  <tr key={line.key} className="border-b border-gray-100 last:border-0" data-testid={`preview-row-${line.key}`}>
                    <td className="px-3 py-1.5 font-mono text-[10px] text-gray-500">{line.key}</td>
                    <td className="px-3 py-1.5 text-gray-600">{line.before}</td>
                    <td className={`px-3 py-1.5 ${line.isTag ? '' : 'text-emerald-700 font-medium'}`}>{line.after}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <DialogFooter className="flex items-center justify-between border-t border-gray-100 pt-3 mt-2">
          <div className="text-xs text-gray-500 flex items-center gap-1">
            <Sparkles className="w-3.5 h-3.5" />
            {checkedCount + extraWritesCount} field{(checkedCount + extraWritesCount) !== 1 ? 's' : ''} to apply
            {(checkedCount + extraWritesCount) > 0 && (
              <span className="ml-2 text-slate-500 inline-flex items-center gap-1">
                <Undo2 className="w-3 h-3" />
                <span>Undo available for 15s after Apply</span>
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
              <X className="w-3.5 h-3.5 mr-1" /> Cancel
            </Button>
            <Button
              size="sm"
              className={`${themeBtn} text-white`}
              onClick={handleSave}
              disabled={saving || (checkedCount === 0 && extraWritesCount === 0) || !selectedProducts?.length}
              data-testid="bulk-specs-save"
            >
              {saving ? <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1" />}
              Apply to {selectedProducts?.length || 0}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default BulkSpecsFiltersModal;
