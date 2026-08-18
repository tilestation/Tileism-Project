/**
 * CustomSpecsTab — merged from BulkSpecsFiltersModal into Attribute Studio.
 * Ad-hoc label/value spec fields (saved for future reuse) + field label renames,
 * applied to all selected products with a 15-second Undo.
 */
import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Plus, X, RefreshCw, Save, PenLine } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const keyFor = (label) => (label || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const postBulk = async (body) => {
  const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const savePreset = (field, values) => fetch(`${API_URL}/api/attribute-values/save`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ field, values }),
}).catch(() => {});

export const CustomSpecsTab = ({ selectedList = [], attributeOptions = [], onSuccess }) => {
  const [rows, setRows] = useState([{ label: '', value: '' }]);
  const [saving, setSaving] = useState(false);
  const [labelOverrides, setLabelOverrides] = useState({});
  const [editingKey, setEditingKey] = useState(null);
  const [savedLabels, setSavedLabels] = useState([]);
  const [valueSuggestions, setValueSuggestions] = useState({});

  useEffect(() => {
    fetch(`${API_URL}/api/attribute-values?fields=custom_spec_label`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => setSavedLabels(d?.values?.custom_spec_label || []))
      .catch(() => {});
  }, []);

  const loadValues = (label) => {
    const k = keyFor(label);
    if (!k) return;
    fetch(`${API_URL}/api/attribute-values?fields=${encodeURIComponent(`custom_spec:${k}`)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const fresh = d?.values?.[`custom_spec:${k}`] || [];
        setValueSuggestions(prev => ({ ...prev, [k]: [...new Set([...fresh, ...(prev[k] || [])])] }));
      })
      .catch(() => {});
  };

  const setRow = (idx, patch) => setRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const addRowFromLabel = (label) => {
    loadValues(label);
    setRows(prev => {
      const blank = prev.findIndex(r => !r.label && !r.value);
      if (blank >= 0) return prev.map((r, i) => (i === blank ? { ...r, label } : r));
      return [...prev, { label, value: '' }];
    });
  };

  const cleaned = rows
    .map(r => ({ key: keyFor(r.label), label: (r.label || '').trim(), value: r.value ?? '' }))
    .filter(r => r.label && r.value !== '');
  const overridesCount = Object.keys(labelOverrides).length;

  const runUndo = async (snapshot) => {
    let ok = 0, fail = 0;
    for (const [id, snap] of Object.entries(snapshot)) {
      try {
        await postBulk({ product_ids: [id], id_field: snap.idField, updates: snap.before, mode: 'replace', update_mode: 'replace' });
        ok++;
      } catch { fail++; }
    }
    if (fail === 0) toast.success(`Undo complete — ${ok} product(s) reverted`);
    else toast.warning(`Undo: ${ok} reverted, ${fail} failed`);
    onSuccess && onSuccess();
  };

  const handleApply = async () => {
    if (cleaned.length === 0 && overridesCount === 0) {
      toast.error('Add a custom field or rename a label first');
      return;
    }
    setSaving(true);
    try {
      const snapshot = {};
      let ok = 0;
      for (const p of selectedList) {
        const id = p.sku || p.supplier_code;
        if (!id) continue;
        const idField = p.sku ? 'sku' : 'supplier_code';
        const before = {};
        const per = {};
        if (overridesCount > 0) {
          before.field_label_overrides = { ...(p.field_label_overrides || {}) };
          per.field_label_overrides = { ...(p.field_label_overrides || {}), ...labelOverrides };
        }
        if (cleaned.length > 0) {
          const existing = Array.isArray(p.custom_specs) ? p.custom_specs : [];
          before.custom_specs = existing.map(cs => ({ ...cs }));
          const newKeys = new Set(cleaned.map(c => c.key));
          per.custom_specs = [...existing.filter(cs => !newKeys.has(cs.key)), ...cleaned];
        }
        snapshot[id] = { idField, before };
        await postBulk({ product_ids: [id], id_field: idField, updates: per, mode: 'replace', update_mode: 'replace' });
        ok++;
      }
      // Remember labels + values for future one-click reuse
      if (cleaned.length > 0) {
        savePreset('custom_spec_label', cleaned.map(c => c.label));
        cleaned.forEach(c => savePreset(`custom_spec:${c.key}`, [String(c.value)]));
        setSavedLabels(prev => [...new Set([...cleaned.map(c => c.label), ...prev])]);
        cleaned.forEach(c => setValueSuggestions(prev => ({ ...prev, [c.key]: [...new Set([String(c.value), ...(prev[c.key] || [])])] })));
      }
      toast.success(`Applied to ${ok} product(s)`, {
        duration: 15000,
        action: { label: 'Undo', onClick: () => runUndo(snapshot) },
      });
      setRows([{ label: '', value: '' }]);
      setLabelOverrides({});
      onSuccess && onSuccess();
    } catch (err) {
      toast.error(`Apply failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="custom-specs-tab">
      {/* Custom fields */}
      <div className="border border-dashed border-violet-200 rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-violet-50/60 border-b border-violet-100 text-xs font-semibold text-violet-700 flex items-center gap-2">
          <Plus className="w-3.5 h-3.5" />
          Custom Fields
          <span className="font-normal text-[10px] text-violet-500">added to all {selectedList.length} selected (e.g. Frost Proof → Yes). Saved for future reuse.</span>
        </div>
        <div className="p-2 space-y-2">
          {savedLabels.length > 0 && (
            <div className="flex flex-wrap items-center gap-1" data-testid="custom-label-suggestions">
              <span className="text-[10px] text-gray-400 mr-1">Saved fields:</span>
              {savedLabels.slice(0, 12).map((l, i) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => addRowFromLabel(l)}
                  className="px-2 py-0.5 rounded-full bg-violet-50 border border-violet-200 text-violet-800 text-[11px] hover:bg-violet-100 transition-colors"
                  data-testid={`custom-label-chip-${i}`}
                >
                  + {l}
                </button>
              ))}
            </div>
          )}
          {rows.map((cf, idx) => {
            const k = keyFor(cf.label);
            const vals = valueSuggestions[k] || [];
            return (
              <div key={idx} className="space-y-1" data-testid={`custom-field-row-${idx}`}>
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    value={cf.label}
                    onChange={(e) => setRow(idx, { label: e.target.value })}
                    onBlur={() => cf.label && loadValues(cf.label)}
                    placeholder="Field name (e.g. Frost Proof)"
                    className="h-8 text-xs flex-1"
                    data-testid={`custom-field-label-${idx}`}
                  />
                  <Input
                    type="text"
                    value={cf.value}
                    onChange={(e) => setRow(idx, { value: e.target.value })}
                    placeholder="Value (e.g. Yes)"
                    className="h-8 text-xs w-56"
                    data-testid={`custom-field-value-${idx}`}
                  />
                  <button
                    type="button"
                    onClick={() => setRows(prev => (prev.length === 1 ? [{ label: '', value: '' }] : prev.filter((_, i) => i !== idx)))}
                    className="p-1 text-rose-500 hover:bg-rose-50 rounded"
                    data-testid={`custom-field-remove-${idx}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
                {vals.length > 0 && (
                  <div className="flex flex-wrap gap-1 pl-1">
                    {vals.slice(0, 8).map((v, vi) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() => setRow(idx, { value: v })}
                        className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                          cf.value === v ? 'bg-violet-700 border-violet-700 text-white' : 'bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100'
                        }`}
                        data-testid={`custom-value-chip-${idx}-${vi}`}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setRows(prev => [...prev, { label: '', value: '' }])}
            className="text-xs text-violet-600 hover:text-violet-800 inline-flex items-center gap-1"
            data-testid="custom-field-add-row"
          >
            <Plus className="w-3 h-3" /> Add another field
          </button>
        </div>
      </div>

      {/* Label renames */}
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700 flex items-center gap-2">
          <PenLine className="w-3.5 h-3.5" />
          Rename Field Labels
          <span className="font-normal text-[10px] text-slate-400">how the field is titled on the product page — click a label to rename</span>
        </div>
        <div className="p-2 flex flex-wrap gap-2">
          {attributeOptions.map(a => (
            <div key={a.key} className="inline-flex items-center gap-1 text-xs" data-testid={`rename-field-${a.key}`}>
              {editingKey === a.key ? (
                <input
                  autoFocus
                  type="text"
                  value={labelOverrides[a.key] ?? a.label}
                  onChange={(e) => setLabelOverrides(prev => ({ ...prev, [a.key]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') setEditingKey(null); }}
                  onBlur={() => setEditingKey(null)}
                  className="text-xs border border-blue-300 rounded px-1.5 py-1 w-32"
                  data-testid={`rename-input-${a.key}`}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setEditingKey(a.key)}
                  className={`px-2 py-1 rounded border text-xs inline-flex items-center gap-1 transition-colors ${
                    labelOverrides[a.key] !== undefined && labelOverrides[a.key] !== a.label
                      ? 'bg-blue-50 border-blue-300 text-blue-800'
                      : 'bg-white border-gray-200 text-gray-600 hover:border-blue-300'
                  }`}
                  data-testid={`rename-btn-${a.key}`}
                >
                  {labelOverrides[a.key] ?? a.label}
                  <PenLine className="w-2.5 h-2.5 text-gray-400" />
                </button>
              )}
              {labelOverrides[a.key] !== undefined && labelOverrides[a.key] !== a.label && (
                <button
                  type="button"
                  onClick={() => setLabelOverrides(prev => { const n = { ...prev }; delete n[a.key]; return n; })}
                  className="text-[9px] text-blue-500 hover:underline"
                  data-testid={`rename-reset-${a.key}`}
                >
                  reset
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-gray-100">
        <span className="text-xs text-gray-500">
          {cleaned.length > 0 && <span className="text-violet-700 font-medium">{cleaned.length} custom field(s)</span>}
          {cleaned.length > 0 && overridesCount > 0 && ' · '}
          {overridesCount > 0 && <span className="text-blue-700 font-medium">{overridesCount} label rename(s)</span>}
          {cleaned.length === 0 && overridesCount === 0 && 'Nothing to apply yet'}
        </span>
        <Button
          onClick={handleApply}
          disabled={saving || (cleaned.length === 0 && overridesCount === 0)}
          className="bg-violet-600 hover:bg-violet-700 text-white"
          data-testid="custom-specs-apply-btn"
        >
          {saving ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
          Apply to {selectedList.length} product(s)
        </Button>
      </div>
    </div>
  );
};

export default CustomSpecsTab;
