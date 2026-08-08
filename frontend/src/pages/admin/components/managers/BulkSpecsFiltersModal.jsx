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
import React, { useState, useMemo } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Badge } from '../../../../components/ui/badge';
import { Sliders, Filter, Layers, Save, RefreshCw, X, Sparkles, Eye, Undo2 } from 'lucide-react';

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

  const themeBtn = themeBtnCls[themeColor] || themeBtnCls.orange;

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

    if (Object.keys(updates).length === 0 && (!subCategoryTags || subCategoryTags.length === 0)) {
      toast.error('Nothing to save — tick a Sub-Category, or tick a Filter/Spec row and type a value');
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
      // Success — show a 15-second undo toast so a mistyped change can be reversed.
      toast.success(
        `Applied ${checkedCount} field${checkedCount !== 1 ? 's' : ''} to ${selectedProducts.length} product${selectedProducts.length !== 1 ? 's' : ''}`,
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
                            {r.label}
                            <code className="text-[10px] font-mono text-gray-400">{r.key}</code>
                            {r.array_field && <Badge variant="outline" className="text-[9px] py-0 px-1">Array append</Badge>}
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
                            <Input
                              type={r.type === 'number' ? 'number' : 'text'}
                              value={values[r.key] ?? ''}
                              onChange={(e) => { setVal(r.key, e.target.value); if (!checked[r.key] && e.target.value !== '') toggle(r.key); }}
                              placeholder={r.hint || 'e.g. Grey, 60x60, Matt'}
                              className="h-8 text-xs"
                              data-testid={`bulk-field-input-${r.key}`}
                            />
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
            {checkedCount} field{checkedCount !== 1 ? 's' : ''} to apply
            {checkedCount > 0 && (
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
              disabled={saving || checkedCount === 0 || !selectedProducts?.length}
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
