/**
 * SubCategoriesTab — merged from BulkSpecsFiltersModal into Attribute Studio.
 * Tick a tag once to ADD, twice to REMOVE, third click clears. Applies to all
 * selected products with 100% verification + a 15-second Undo.
 */
import React, { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';
import { Layers, RefreshCw, Save, Plus, Minus } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const postBulk = async (body) => {
  const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export const SubCategoriesTab = ({ selectedList = [], subTabs = [], onSuccess, onCreateTag }) => {
  const tags = useMemo(() => (subTabs || []).filter(t => t.key && t.key !== 'all'), [subTabs]);
  const [state, setState] = useState({});   // { key: 'add' | 'remove' }
  const [saving, setSaving] = useState(false);
  const [newTag, setNewTag] = useState('');
  const [creating, setCreating] = useState(false);

  const createTag = async () => {
    const label = newTag.trim();
    if (!label) return;
    if (tags.some(t => (t.label || t.key).toLowerCase() === label.toLowerCase())) {
      toast.error(`Sub-category "${label}" already exists`);
      return;
    }
    setCreating(true);
    try {
      const key = await onCreateTag(label);
      setNewTag('');
      if (key) setState(prev => ({ ...prev, [key]: 'add' }));   // pre-tick for this selection
      toast.success(`Sub-category "${label}" created — ticked to add for your selection`);
    } catch { /* saveConfig already toasts */ }
    finally { setCreating(false); }
  };

  // A product "has" a tag if any sub_categories entry contains the tag's key,
  // label or any keyword (same substring logic the Manager sub-tabs use) —
  // handles legacy variants like 'Wall Tiles' stored against the 'wall' tab.
  const matcherFor = (t) => {
    const kws = [t.key, t.label, ...(Array.isArray(t.keywords) ? t.keywords : [])]
      .filter(Boolean).map(k => String(k).toLowerCase());
    return (sc) => { const s = String(sc).toLowerCase(); return kws.some(kw => s.includes(kw)); };
  };

  const counts = useMemo(() => {
    const m = {};
    tags.forEach(t => {
      const match = matcherFor(t);
      m[t.key] = selectedList.filter(p => (p.sub_categories || []).some(match)).length;
    });
    return m;
  }, [tags, selectedList]);

  const cycle = (key) => setState(prev => {
    const next = { ...prev };
    if (!prev[key]) next[key] = 'add';
    else if (prev[key] === 'add') next[key] = 'remove';
    else delete next[key];
    return next;
  });

  const addTags = Object.keys(state).filter(k => state[k] === 'add');
  const removeTags = Object.keys(state).filter(k => state[k] === 'remove');

  const splitIds = (list) => {
    const bySku = []; const byCode = [];
    list.forEach(p => { if (p.sku) bySku.push(p.sku); else if (p.supplier_code) byCode.push(p.supplier_code); });
    return [[bySku, 'sku'], [byCode, 'supplier_code']].filter(([ids]) => ids.length > 0);
  };

  const runUndo = async (snapshot) => {
    let ok = 0, fail = 0;
    for (const [id, snap] of Object.entries(snapshot)) {
      try {
        await postBulk({ product_ids: [id], id_field: snap.idField, updates: { sub_categories: snap.sub_categories }, mode: 'replace', update_mode: 'replace' });
        ok++;
      } catch { fail++; }
    }
    if (fail === 0) toast.success(`Undo complete — ${ok} product(s) reverted`);
    else toast.warning(`Undo: ${ok} reverted, ${fail} failed`);
    onSuccess && onSuccess();
  };

  const handleApply = async () => {
    if (addTags.length === 0 && removeTags.length === 0) {
      toast.error('Tick a tag first — 1 click = add, 2 clicks = remove');
      return;
    }
    setSaving(true);
    try {
      const snapshot = {};
      selectedList.forEach(p => {
        const k = p.sku || p.supplier_code;
        if (k) snapshot[k] = { idField: p.sku ? 'sku' : 'supplier_code', sub_categories: [...(p.sub_categories || [])] };
      });
      const failures = [];
      // ADD: per tag, only products that don't already match (no duplicate variants)
      for (const key of addTags) {
        const t = tags.find(x => x.key === key);
        const match = matcherFor(t);
        const targets = selectedList.filter(p => !(p.sub_categories || []).some(match));
        const tagValue = t.label || key;   // Title-Case label matches the legacy convention
        for (const [ids, idField] of splitIds(targets)) {
          const d = await postBulk({ product_ids: ids, id_field: idField, updates: { sub_categories: [tagValue] }, mode: 'append', update_mode: 'replace' });
          failures.push(...(d.verification_failures || []));
        }
      }
      // REMOVE: pull every stored variant that matches the tag (e.g. 'Wall Tiles' for 'wall')
      if (removeTags.length > 0) {
        const removeVals = new Set(removeTags);
        removeTags.forEach(key => {
          const t = tags.find(x => x.key === key);
          const match = matcherFor(t);
          selectedList.forEach(p => (p.sub_categories || []).forEach(sc => { if (match(sc)) removeVals.add(sc); }));
        });
        for (const [ids, idField] of splitIds(selectedList)) {
          const d = await postBulk({ product_ids: ids, id_field: idField, updates: { sub_categories: [...removeVals] }, mode: 'remove', update_mode: 'replace' });
          failures.push(...(d.verification_failures || []));
        }
      }
      if (failures.length > 0) {
        toast.warning(`Applied, but ${failures.length} verification failure(s) — check console`, { duration: 12000 });
        console.warn('[Sub-Categories] verification failures:', failures);
      } else {
        toast.success(`Sub-categories updated on ${selectedList.length} product(s) — 100% verified`, {
          duration: 15000,
          action: { label: 'Undo', onClick: () => runUndo(snapshot) },
        });
      }
      setState({});
      onSuccess && onSuccess();
    } catch (err) {
      toast.error(`Apply failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (tags.length === 0 && !onCreateTag) {
    return <p className="text-sm text-gray-400 text-center py-8">No sub-categories configured for this Manager — add them via Configure.</p>;
  }

  return (
    <div className="space-y-3" data-testid="subcats-tab">
      <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 px-3 py-2 text-xs text-emerald-800 flex items-center gap-2">
        <Layers className="w-3.5 h-3.5 flex-shrink-0" />
        Click a tag once to <b>ADD</b> it to all {selectedList.length} selected, twice to <b>REMOVE</b> it, third click clears. Counts show how many already have each tag.
      </div>
      <div className="flex flex-wrap gap-2">
        {tags.map(t => {
          const st = state[t.key];
          const cls = st === 'add'
            ? 'bg-emerald-600 border-emerald-600 text-white'
            : st === 'remove'
              ? 'bg-red-600 border-red-600 text-white'
              : 'bg-white border-gray-300 text-gray-700 hover:border-emerald-400';
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => cycle(t.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-sm font-medium transition-colors ${cls}`}
              data-testid={`subcat-tag-${t.key}`}
            >
              {st === 'add' && <Plus className="w-3.5 h-3.5" />}
              {st === 'remove' && <Minus className="w-3.5 h-3.5" />}
              {t.label || t.key}
              <Badge variant="outline" className={`text-[10px] ${st ? 'bg-white/20 border-white/40 text-white' : ''}`}>
                {counts[t.key] || 0}/{selectedList.length}
              </Badge>
            </button>
          );
        })}
      </div>
      {/* Create a brand-new sub-category on the spot */}
      {onCreateTag && (
        <div className="flex items-center gap-2" data-testid="new-subcat-row">
          <input
            type="text"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); createTag(); } }}
            placeholder="New sub-category name, e.g. Outdoor, Metro, Hexagon…"
            className="flex-1 h-8 text-xs border border-emerald-200 rounded px-2 bg-white"
            data-testid="new-subcat-input"
          />
          <Button
            size="sm"
            onClick={createTag}
            disabled={creating || !newTag.trim()}
            className="bg-emerald-600 hover:bg-emerald-700 text-white h-8"
            data-testid="new-subcat-create-btn"
          >
            {creating ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5 mr-1" />}
            {creating ? '' : 'Create'}
          </Button>
        </div>
      )}
      <div className="flex items-center justify-between pt-2 border-t border-gray-100">
        <span className="text-xs text-gray-500" data-testid="subcats-pending-summary">
          {addTags.length > 0 && <span className="text-emerald-700 font-medium">+{addTags.length} to add</span>}
          {addTags.length > 0 && removeTags.length > 0 && ' · '}
          {removeTags.length > 0 && <span className="text-red-600 font-medium">−{removeTags.length} to remove</span>}
          {addTags.length === 0 && removeTags.length === 0 && 'Nothing selected yet'}
        </span>
        <Button
          onClick={handleApply}
          disabled={saving || (addTags.length === 0 && removeTags.length === 0)}
          className="bg-emerald-600 hover:bg-emerald-700 text-white"
          data-testid="subcats-apply-btn"
        >
          {saving ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
          Apply to {selectedList.length} product(s)
        </Button>
      </div>
    </div>
  );
};

export default SubCategoriesTab;
