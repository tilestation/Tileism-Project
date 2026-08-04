/**
 * ManagerConfigModal — per-Manager settings panel. Three tabs:
 *   1. Filters (facets)  — {key, label, field, array_field?}
 *   2. Sub-Categories    — {key, label, keywords[]}
 *   3. Spec Fields       — {key, label, type, options?, hint?}
 *
 * Each Manager has its OWN config row in `manager_definitions` — so adding a
 * "Warranty" filter to Bathroom does NOT show up in Tiles or Materials.
 *
 * All 3 tabs use the same table-editor UX:
 *   - Add row → new blank row appended
 *   - Edit inline
 *   - Remove → red × icon per row
 *   - "Save all" writes the whole array via PATCH /api/manager-definitions/:slug
 *
 * Built-ins (tiles/materials/…) also get a "Reset to defaults" button so admins
 * can undo their experimentation without losing the hardcoded baseline.
 */

import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Badge } from '../../../../components/ui/badge';
import {
  Settings, Filter, Layers, Wrench, Plus, X, Save, RefreshCw, RotateCcw, AlertCircle, Info,
} from 'lucide-react';

const KEBAB = (s) => (s || '').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const FIELD_TYPE_OPTIONS = ['text', 'number', 'select', 'textarea'];

const ManagerConfigModal = ({ open, onOpenChange, slug, config, onSave, themeColor = 'orange' }) => {
  const [tab, setTab] = useState('filters');
  const [facets, setFacets] = useState([]);
  const [subTabs, setSubTabs] = useState([]);
  const [specs, setSpecs] = useState([]);
  const [dirty, setDirty] = useState({ facets: false, subTabs: false, specs: false });
  const [saving, setSaving] = useState(false);

  // Reset local state when config arrives
  useEffect(() => {
    if (!config) return;
    setFacets(Array.isArray(config.filter_facets) ? config.filter_facets.map(f => ({ ...f })) : []);
    setSubTabs(Array.isArray(config.sub_tabs) ? config.sub_tabs.map(t => ({ ...t, keywords: [...(t.keywords || [])] })) : []);
    setSpecs(Array.isArray(config.spec_fields) ? config.spec_fields.map(s => ({ ...s })) : []);
    setDirty({ facets: false, subTabs: false, specs: false });
  }, [config, open]);

  const themeBtn = {
    orange: 'bg-orange-600 hover:bg-orange-700 text-white',
    blue:   'bg-blue-600   hover:bg-blue-700   text-white',
    amber:  'bg-amber-600  hover:bg-amber-700  text-white',
    cyan:   'bg-cyan-600   hover:bg-cyan-700   text-white',
    red:    'bg-red-600    hover:bg-red-700    text-white',
    slate:  'bg-slate-700  hover:bg-slate-800  text-white',
    purple: 'bg-purple-600 hover:bg-purple-700 text-white',
  }[themeColor] || 'bg-orange-600 hover:bg-orange-700 text-white';

  // ---- Handlers ----
  const addFacet = () => { setFacets(prev => [...prev, { key: '', label: '', field: '', array_field: '' }]); setDirty(d => ({ ...d, facets: true })); };
  const updFacet = (i, patch) => { setFacets(prev => prev.map((f, j) => j === i ? { ...f, ...patch } : f)); setDirty(d => ({ ...d, facets: true })); };
  const rmFacet  = (i) => { setFacets(prev => prev.filter((_, j) => j !== i)); setDirty(d => ({ ...d, facets: true })); };

  const addSubTab = () => { setSubTabs(prev => [...prev, { key: '', label: '', keywords: [] }]); setDirty(d => ({ ...d, subTabs: true })); };
  const updSubTab = (i, patch) => { setSubTabs(prev => prev.map((t, j) => j === i ? { ...t, ...patch } : t)); setDirty(d => ({ ...d, subTabs: true })); };
  const rmSubTab  = (i) => { setSubTabs(prev => prev.filter((_, j) => j !== i)); setDirty(d => ({ ...d, subTabs: true })); };

  const addSpec = () => { setSpecs(prev => [...prev, { key: '', label: '', type: 'text' }]); setDirty(d => ({ ...d, specs: true })); };
  const updSpec = (i, patch) => { setSpecs(prev => prev.map((s, j) => j === i ? { ...s, ...patch } : s)); setDirty(d => ({ ...d, specs: true })); };
  const rmSpec  = (i) => { setSpecs(prev => prev.filter((_, j) => j !== i)); setDirty(d => ({ ...d, specs: true })); };

  // Auto-generate `key` from `label` if the user only typed a label
  const normaliseFacet   = (f) => ({ ...f, key: f.key?.trim() || KEBAB(f.label), label: (f.label || '').trim(), field: (f.field || KEBAB(f.label)).trim(), array_field: (f.array_field || '').trim() || null });
  const normaliseSubTab  = (t) => ({ ...t, key: t.key?.trim() || KEBAB(t.label), label: (t.label || '').trim(), keywords: (t.keywords || []).map(k => k.trim()).filter(Boolean) });
  const normaliseSpec    = (s) => ({ ...s, key: s.key?.trim() || KEBAB(s.label), label: (s.label || '').trim(), type: s.type || 'text', options: (s.type === 'select' ? (s.options || []).map(o => o.trim()).filter(Boolean) : null), hint: (s.hint || '').trim() || null });

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      const patch = {};
      if (dirty.facets)  patch.filter_facets = facets.map(normaliseFacet).filter(f => f.label && f.field);
      if (dirty.subTabs) patch.sub_tabs      = subTabs.map(normaliseSubTab).filter(t => t.label);
      if (dirty.specs)   patch.spec_fields   = specs.map(normaliseSpec).filter(s => s.label);
      if (Object.keys(patch).length === 0) { toast.info('No changes to save'); onOpenChange(false); return; }
      await onSave(patch);
      toast.success('Manager config updated');
      onOpenChange(false);
    } catch (err) {
      // onSave already toasted
    } finally {
      setSaving(false);
    }
  };

  const resetTab = () => {
    if (!window.confirm('Reset this tab to its saved values? Your unsaved edits will be discarded.')) return;
    if (tab === 'filters')  { setFacets(Array.isArray(config?.filter_facets) ? config.filter_facets.map(f => ({ ...f })) : []); setDirty(d => ({ ...d, facets: false })); }
    if (tab === 'subTabs')  { setSubTabs(Array.isArray(config?.sub_tabs) ? config.sub_tabs.map(t => ({ ...t, keywords: [...(t.keywords || [])] })) : []); setDirty(d => ({ ...d, subTabs: false })); }
    if (tab === 'specs')    { setSpecs(Array.isArray(config?.spec_fields) ? config.spec_fields.map(s => ({ ...s })) : []); setDirty(d => ({ ...d, specs: false })); }
  };

  const anyDirty = dirty.facets || dirty.subTabs || dirty.specs;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto" data-testid="manager-config-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-slate-700" />
            Configure Manager — {config?.name || slug}
          </DialogTitle>
          <DialogDescription className="text-xs text-gray-500">
            Filters, sub-tabs and spec fields — <b>scoped to {config?.name || slug} only</b>. Changes here do not affect other Managers.
          </DialogDescription>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-gray-200">
          {[
            { key: 'filters', label: 'Filters',        icon: Filter,  count: facets.length,  dirty: dirty.facets },
            { key: 'subTabs', label: 'Sub-Categories', icon: Layers,  count: subTabs.length, dirty: dirty.subTabs },
            { key: 'specs',   label: 'Spec Fields',    icon: Wrench,  count: specs.length,   dirty: dirty.specs },
          ].map(t => {
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex-1 px-3 py-2 text-sm font-medium border-b-2 flex items-center justify-center gap-1.5 ${
                  tab === t.key ? 'border-slate-800 text-slate-900' : 'border-transparent text-gray-500 hover:text-gray-800'
                }`}
                data-testid={`config-tab-${t.key}`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
                <Badge variant="outline" className="text-[10px] py-0 px-1.5">{t.count}</Badge>
                {t.dirty && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" title="Unsaved changes"></span>}
              </button>
            );
          })}
        </div>

        <div className="mt-3 space-y-2">
          {/* Info banner per tab */}
          <div className="bg-blue-50 border border-blue-100 text-blue-800 text-[11px] p-2 rounded flex items-start gap-1.5">
            <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>
              {tab === 'filters' && `Facets shown as drop-downs on the left of the product table. Each maps to a product field (e.g. label "Colour" → field "color").`}
              {tab === 'subTabs' && `Tabs shown above the product table. Each has keywords used to auto-match products (matched against product name + sub_categories).`}
              {tab === 'specs'   && `Fields shown on the Edit form. Set the type (text / number / select / textarea) and an optional hint.`}
            </span>
          </div>

          {/* FILTERS TAB */}
          {tab === 'filters' && (
            <>
              {facets.length === 0 && (
                <div className="text-center text-xs text-gray-400 py-8 border border-dashed border-gray-200 rounded">
                  No filters yet. Add one to give shoppers a way to narrow down.
                </div>
              )}
              {facets.map((f, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 items-center border border-gray-200 rounded p-2" data-testid={`config-facet-row-${i}`}>
                  <Input placeholder="Label (e.g. Warranty)" value={f.label || ''} onChange={(e) => updFacet(i, { label: e.target.value })} data-testid={`config-facet-label-${i}`} />
                  <Input placeholder="Field (e.g. warranty)"  value={f.field || ''} onChange={(e) => updFacet(i, { field: e.target.value })} data-testid={`config-facet-field-${i}`} />
                  <Input placeholder="Key (auto)"             value={f.key || ''}   onChange={(e) => updFacet(i, { key: e.target.value })} />
                  <Input placeholder="Array field (optional, e.g. colors)" value={f.array_field || ''} onChange={(e) => updFacet(i, { array_field: e.target.value })} />
                  <button onClick={() => rmFacet(i)} className="text-red-500 hover:text-red-700" data-testid={`config-facet-remove-${i}`}><X className="w-4 h-4" /></button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addFacet} className="w-full" data-testid="config-add-facet">
                <Plus className="w-3.5 h-3.5 mr-1" /> Add Filter
              </Button>
            </>
          )}

          {/* SUB-TABS TAB */}
          {tab === 'subTabs' && (
            <>
              {subTabs.length === 0 && (
                <div className="text-center text-xs text-gray-400 py-8 border border-dashed border-gray-200 rounded">
                  No sub-tabs yet. Add one to group products (e.g. Adhesives / Grouts / Sealants).
                </div>
              )}
              {subTabs.map((t, i) => (
                <div key={i} className="grid grid-cols-[1fr_1fr_2fr_auto] gap-2 items-center border border-gray-200 rounded p-2" data-testid={`config-subtab-row-${i}`}>
                  <Input placeholder="Label (e.g. Sealants)"  value={t.label || ''} onChange={(e) => updSubTab(i, { label: e.target.value })} data-testid={`config-subtab-label-${i}`} />
                  <Input placeholder="Key (auto)"              value={t.key || ''}   onChange={(e) => updSubTab(i, { key: e.target.value })} />
                  <Input placeholder="Keywords (comma-separated: sealant, silicone)" value={(t.keywords || []).join(', ')} onChange={(e) => updSubTab(i, { keywords: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} data-testid={`config-subtab-keywords-${i}`} />
                  <button onClick={() => rmSubTab(i)} className="text-red-500 hover:text-red-700" data-testid={`config-subtab-remove-${i}`}><X className="w-4 h-4" /></button>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addSubTab} className="w-full" data-testid="config-add-subtab">
                <Plus className="w-3.5 h-3.5 mr-1" /> Add Sub-Tab
              </Button>
            </>
          )}

          {/* SPEC FIELDS TAB */}
          {tab === 'specs' && (
            <>
              {specs.length === 0 && (
                <div className="text-center text-xs text-gray-400 py-8 border border-dashed border-gray-200 rounded">
                  No spec fields yet. Add one to appear on the product Edit form.
                </div>
              )}
              {specs.map((s, i) => (
                <div key={i} className="border border-gray-200 rounded p-2" data-testid={`config-spec-row-${i}`}>
                  <div className="grid grid-cols-[1fr_1fr_120px_auto] gap-2 items-center">
                    <Input placeholder="Label (e.g. Warranty)" value={s.label || ''} onChange={(e) => updSpec(i, { label: e.target.value })} data-testid={`config-spec-label-${i}`} />
                    <Input placeholder="Key (auto)"            value={s.key || ''}   onChange={(e) => updSpec(i, { key: e.target.value })} />
                    <select
                      value={s.type || 'text'}
                      onChange={(e) => updSpec(i, { type: e.target.value })}
                      className="border border-gray-200 rounded px-2 py-1.5 text-sm bg-white"
                      data-testid={`config-spec-type-${i}`}
                    >
                      {FIELD_TYPE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                    <button onClick={() => rmSpec(i)} className="text-red-500 hover:text-red-700" data-testid={`config-spec-remove-${i}`}><X className="w-4 h-4" /></button>
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-2">
                    <Input placeholder="Hint (optional)" value={s.hint || ''} onChange={(e) => updSpec(i, { hint: e.target.value })} className="text-xs" />
                    {s.type === 'select' && (
                      <Input placeholder="Options (comma-separated)" value={(s.options || []).join(', ')} onChange={(e) => updSpec(i, { options: e.target.value.split(',').map(o => o.trim()).filter(Boolean) })} className="text-xs" />
                    )}
                  </div>
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addSpec} className="w-full" data-testid="config-add-spec">
                <Plus className="w-3.5 h-3.5 mr-1" /> Add Spec Field
              </Button>
            </>
          )}
        </div>

        <div className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded p-2 mt-2">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>Changes here are scoped to <b>{config?.name || slug}</b> only. Other Managers keep their own configuration untouched.</span>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={resetTab} disabled={saving} data-testid="config-reset-tab">
            <RotateCcw className="w-3.5 h-3.5 mr-1" /> Undo changes on this tab
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSaveAll} disabled={saving || !anyDirty} className={themeBtn} data-testid="config-save-all">
            {saving ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
            Save all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ManagerConfigModal;
