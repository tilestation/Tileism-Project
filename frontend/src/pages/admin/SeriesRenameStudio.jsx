/**
 * SeriesRenameStudio — bulk-rename every product inside one series.
 * Modes: Standardise (Series+Colour+Size+Finish), Find & Replace, Manual.
 * Nothing saves until "Apply" — preview shows Current → New side by side.
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Layers, Search, RefreshCw, Save, Wand2, Replace, Pencil, ArrowRight, X, RotateCcw, ArrowDownWideNarrow,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const authHeaders = () => {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
};

const healthBadge = (h) => {
  if (h == null) return null;
  if (h >= 90) return { label: 'Tidy', cls: 'bg-emerald-100 text-emerald-700' };
  if (h >= 60) return { label: 'OK', cls: 'bg-amber-100 text-amber-700' };
  return { label: 'Messy', cls: 'bg-red-100 text-red-600' };
};

const MODES = [
  { id: 'standardise', label: 'Standardise', icon: Wand2, hint: 'Rebuild every name as Series + Colour + Size + Finish' },
  { id: 'replace', label: 'Find & Replace', icon: Replace, hint: 'Swap one word/phrase across the whole series' },
  { id: 'manual', label: 'Manual', icon: Pencil, hint: 'Type each new name yourself' },
];

const SeriesRenameStudio = () => {
  const [seriesQuery, setSeriesQuery] = useState('');
  const [seriesList, setSeriesList] = useState([]);
  const [loadingSeries, setLoadingSeries] = useState(false);
  const [selected, setSelected] = useState(null);          // { name, count }
  const [rows, setRows] = useState([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [mode, setMode] = useState('standardise');
  const [inc, setInc] = useState({ color: true, size: true, finish: true });
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [edits, setEdits] = useState({});                  // { sku: manual override }
  const [deselected, setDeselected] = useState(new Set()); // skus excluded from apply
  const [applying, setApplying] = useState(false);
  const [sortBy, setSortBy] = useState('biggest'); // 'biggest' | 'messiest'

  const loadSeries = useCallback(async () => {
    setLoadingSeries(true);
    try {
      const res = await fetch(`${API_URL}/api/product-name-sanity/series-list`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSeriesList(data.series || []);
    } catch (err) {
      toast.error(`Failed to load series list: ${err.message}`);
    } finally {
      setLoadingSeries(false);
    }
  }, []);

  useEffect(() => { loadSeries(); }, [loadSeries]);

  const loadProducts = useCallback(async (seriesName) => {
    setLoadingRows(true);
    setEdits({});
    setDeselected(new Set());
    try {
      const res = await fetch(`${API_URL}/api/product-name-sanity/series-products?series=${encodeURIComponent(seriesName)}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(data.rows || []);
    } catch (err) {
      toast.error(`Failed to load products: ${err.message}`);
    } finally {
      setLoadingRows(false);
    }
  }, []);

  const pickSeries = (s) => {
    setSelected(s);
    loadProducts(s.name);
  };

  const filteredSeries = useMemo(() => {
    const q = seriesQuery.trim().toLowerCase();
    const arr = q ? seriesList.filter(s => s.name.toLowerCase().includes(q)) : [...seriesList];
    if (sortBy === 'messiest') arr.sort((a, b) => (a.health ?? 100) - (b.health ?? 100) || b.count - a.count);
    return arr;
  }, [seriesList, seriesQuery, sortBy]);

  const computeNewName = useCallback((row) => {
    if (edits[row.sku] !== undefined) return edits[row.sku];
    if (mode === 'standardise') {
      const parts = [selected?.name || ''];
      if (inc.color && row.parts?.color) parts.push(row.parts.color);
      if (inc.size && row.parts?.size) parts.push(row.parts.size);
      if (inc.finish && row.parts?.finish) parts.push(row.parts.finish);
      return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    }
    if (mode === 'replace') {
      if (!findText.trim()) return row.product_name;
      try {
        return row.product_name.replace(new RegExp(escapeRegExp(findText.trim()), 'gi'), replaceText);
      } catch {
        return row.product_name;
      }
    }
    return row.product_name;
  }, [edits, mode, inc, findText, replaceText, selected]);

  const preview = useMemo(() => rows.map(row => {
    const newName = computeNewName(row);
    const changed = newName.trim().length >= 3 && newName.trim() !== row.product_name;
    return { ...row, newName, changed, included: !deselected.has(row.sku) };
  }), [rows, computeNewName, deselected]);

  const toApply = preview.filter(r => r.changed && r.included);
  const allIncluded = preview.length > 0 && preview.every(r => r.included);

  const duplicateNames = useMemo(() => {
    const seen = {};
    preview.filter(r => r.included).forEach(r => {
      const key = r.newName.trim().toLowerCase();
      if (key) seen[key] = (seen[key] || 0) + 1;
    });
    return Object.entries(seen).filter(([, n]) => n > 1).reduce((acc, [, n]) => acc + n, 0);
  }, [preview]);

  const toggleRow = (sku) => {
    setDeselected(prev => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku); else next.add(sku);
      return next;
    });
  };

  const toggleAll = () => {
    setDeselected(allIncluded ? new Set(rows.map(r => r.sku)) : new Set());
  };

  const applyAll = async () => {
    if (toApply.length === 0) { toast.info('No name changes to apply'); return; }
    const dupWarning = duplicateNames > 0 ? `\n\n⚠️ WARNING: ${duplicateNames} products would end up with IDENTICAL names. Re-tick a pattern part or edit them manually first if that's not intended.` : '';
    if (!window.confirm(`Rename ${toApply.length} product${toApply.length === 1 ? '' : 's'} in "${selected.name}"?\n\nNew names replace the current ones and sync to the website + EPOS.${dupWarning}`)) return;
    setApplying(true);
    try {
      const items = toApply.map(r => ({ sku: r.sku, supplier: r.supplier, new_name: r.newName.trim() }));
      const res = await fetch(`${API_URL}/api/product-name-sanity/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      toast.success(`Renamed ${data.updated} product${data.updated === 1 ? '' : 's'}${data.failed?.length ? ` — ${data.failed.length} failed` : ''}`);
      loadProducts(selected.name);
    } catch (err) {
      toast.error(`Bulk rename failed: ${err.message}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4" data-testid="series-rename-studio">
      {/* Series picker */}
      <div className="bg-white border border-gray-200 rounded-lg p-3 h-fit lg:sticky lg:top-4">
        <div className="flex items-center gap-2 mb-2">
          <Layers className="w-4 h-4 text-indigo-600" />
          <span className="text-sm font-semibold text-gray-800">Pick a series</span>
          <div className="ml-auto flex items-center">
            <Button
              variant="ghost" size="sm"
              className={`h-7 px-1.5 text-[10px] ${sortBy === 'messiest' ? 'text-red-600 bg-red-50' : 'text-gray-400'}`}
              onClick={() => setSortBy(prev => prev === 'messiest' ? 'biggest' : 'messiest')}
              title={sortBy === 'messiest' ? 'Sorting messiest first — click for biggest first' : 'Sort messiest first'}
              data-testid="srs-sort-messiest"
            >
              <ArrowDownWideNarrow className="w-3.5 h-3.5 mr-0.5" /> {sortBy === 'messiest' ? 'Messiest' : 'Biggest'}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={loadSeries} disabled={loadingSeries} data-testid="srs-refresh-series">
              <RefreshCw className={`w-3.5 h-3.5 ${loadingSeries ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
        <div className="relative mb-2">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={seriesQuery}
            onChange={(e) => setSeriesQuery(e.target.value)}
            placeholder="Search series…"
            className="h-8 text-xs pl-8"
            data-testid="srs-series-search"
          />
        </div>
        <div className="max-h-[420px] overflow-y-auto space-y-0.5" data-testid="srs-series-list">
          {loadingSeries ? (
            <div className="text-center py-8 text-gray-400 text-xs"><RefreshCw className="w-4 h-4 mx-auto animate-spin mb-1" />Loading…</div>
          ) : filteredSeries.length === 0 ? (
            <div className="text-center py-6 text-gray-400 text-xs">No series found</div>
          ) : filteredSeries.map(s => {
            const hb = healthBadge(s.health);
            return (
            <button
              key={s.name}
              onClick={() => pickSeries(s)}
              className={`w-full text-left px-2.5 py-1.5 rounded text-xs flex items-center justify-between gap-1.5 transition-colors ${selected?.name === s.name ? 'bg-indigo-600 text-white' : 'hover:bg-indigo-50 text-gray-700'}`}
              data-testid={`srs-series-item-${s.name}`}
            >
              <span className="truncate">{s.name}</span>
              <span className="flex items-center gap-1 flex-shrink-0">
                {hb && (
                  <span
                    className={`text-[9px] px-1 py-0.5 rounded font-semibold leading-none ${hb.cls}`}
                    title={`${s.health}% of names are tidy (start with the series, proper case, no garbage/duplicates)`}
                    data-testid={`srs-health-${s.name}`}
                  >
                    {s.health}%
                  </span>
                )}
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${selected?.name === s.name ? 'bg-indigo-500 text-indigo-100' : 'bg-gray-100 text-gray-500'}`}>{s.count}</span>
              </span>
            </button>
            );
          })}
        </div>
      </div>

      {/* Rename workspace */}
      <div className="space-y-3 min-w-0">
        {!selected ? (
          <div className="bg-white border border-dashed border-gray-300 rounded-lg p-12 text-center text-gray-400">
            <Layers className="w-10 h-10 mx-auto mb-2 text-gray-300" />
            <p className="text-sm">Pick a series on the left to load its products for bulk renaming.</p>
          </div>
        ) : (
          <>
            {/* Mode bar */}
            <div className="bg-white border border-gray-200 rounded-lg p-3 space-y-3">
              <div className="flex items-center gap-2 flex-wrap">
                {MODES.map(m => (
                  <button
                    key={m.id}
                    onClick={() => { setMode(m.id); setEdits({}); }}
                    title={m.hint}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${mode === m.id ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                    data-testid={`srs-mode-${m.id}`}
                  >
                    <m.icon className="w-3.5 h-3.5" /> {m.label}
                  </button>
                ))}
                <div className="ml-auto flex items-center gap-2">
                  {duplicateNames > 0 && (
                    <span className="text-[11px] px-2 py-1 rounded bg-red-50 text-red-600 border border-red-200 font-medium" data-testid="srs-duplicate-warning">
                      ⚠ {duplicateNames} would share identical names
                    </span>
                  )}
                  <span className="text-xs text-gray-500" data-testid="srs-changed-count">
                    <b className={toApply.length ? 'text-amber-600' : 'text-gray-400'}>{toApply.length}</b> of {rows.length} will change
                  </span>
                  <Button
                    onClick={applyAll}
                    disabled={applying || toApply.length === 0}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white h-8"
                    data-testid="srs-apply-all"
                  >
                    {applying ? <RefreshCw className="w-4 h-4 mr-1.5 animate-spin" /> : <Save className="w-4 h-4 mr-1.5" />}
                    Apply {toApply.length ? `(${toApply.length})` : ''}
                  </Button>
                </div>
              </div>

              {mode === 'standardise' && (
                <div className="flex items-center gap-3 flex-wrap text-xs text-gray-600">
                  <span className="font-medium">Pattern: <span className="text-indigo-700">{selected.name}</span></span>
                  {['color', 'size', 'finish'].map(k => (
                    <label key={k} className="flex items-center gap-1.5 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={inc[k]}
                        onChange={() => setInc(prev => ({ ...prev, [k]: !prev[k] }))}
                        className="accent-indigo-600"
                        data-testid={`srs-toggle-${k}`}
                      />
                      + {k.charAt(0).toUpperCase() + k.slice(1)}
                    </label>
                  ))}
                  <span className="text-gray-400">Colour/size/finish read from each product's current name first, attributes as fallback.</span>
                </div>
              )}

              {mode === 'replace' && (
                <div className="flex items-center gap-2 flex-wrap">
                  <Input value={findText} onChange={(e) => setFindText(e.target.value)} placeholder="Find text… (e.g. Blanco)" className="h-8 text-xs w-48" data-testid="srs-find-input" />
                  <ArrowRight className="w-4 h-4 text-gray-400" />
                  <Input value={replaceText} onChange={(e) => setReplaceText(e.target.value)} placeholder="Replace with… (e.g. Bianco)" className="h-8 text-xs w-48" data-testid="srs-replace-input" />
                  <span className="text-[11px] text-gray-400">Case-insensitive, replaces every occurrence in each name.</span>
                </div>
              )}

              {mode === 'manual' && (
                <p className="text-xs text-gray-500">Type directly into the New Name column below. Only edited rows are applied.</p>
              )}
            </div>

            {/* Preview table */}
            {loadingRows ? (
              <div className="text-center py-16 text-gray-400 text-sm bg-white border border-gray-200 rounded-lg">
                <RefreshCw className="w-6 h-6 mx-auto animate-spin mb-2" />Loading {selected.name}…
              </div>
            ) : (
              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 border-b border-gray-200">
                    <tr className="text-left text-gray-500">
                      <th className="px-3 py-2 w-8">
                        <input type="checkbox" checked={allIncluded} onChange={toggleAll} className="accent-indigo-600" data-testid="srs-select-all" />
                      </th>
                      <th className="px-3 py-2 font-medium w-24">SKU</th>
                      <th className="px-3 py-2 font-medium text-sky-700">Supplier calls it</th>
                      <th className="px-3 py-2 font-medium">Our current name</th>
                      <th className="px-3 py-2 w-6"></th>
                      <th className="px-3 py-2 font-medium min-w-[320px]">New name</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {preview.map(row => (
                      <tr key={row.sku} className={row.changed && row.included ? 'bg-amber-50/60' : ''} data-testid={`srs-row-${row.sku}`}>
                        <td className="px-3 py-2">
                          <input type="checkbox" checked={row.included} onChange={() => toggleRow(row.sku)} className="accent-indigo-600" data-testid={`srs-check-${row.sku}`} />
                        </td>
                        <td className="px-3 py-2 font-mono text-[11px] text-slate-600">
                          <div>{row.sku}</div>
                          <div className="text-[10px] text-gray-400">{row.supplier}</div>
                        </td>
                        <td className="px-3 py-2 text-sky-800/70 italic" data-testid={`srs-suppliername-${row.sku}`}>
                          {row.supplier_name
                            ? (row.supplier_name === row.product_name
                                ? <span className="not-italic text-gray-300" title="Supplier name is identical to our current name">same as ours</span>
                                : row.supplier_name)
                            : <span className="not-italic text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-slate-700">{row.product_name || <span className="text-gray-300">— empty —</span>}</td>
                        <td className="px-2 py-2 text-gray-300"><ArrowRight className="w-3.5 h-3.5" /></td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <Input
                              value={row.newName}
                              title={row.newName}
                              onChange={(e) => setEdits(prev => ({ ...prev, [row.sku]: e.target.value }))}
                              className={`h-9 text-sm ${row.changed ? 'border-amber-400 bg-white font-medium text-amber-900' : ''}`}
                              data-testid={`srs-newname-${row.sku}`}
                            />
                            {edits[row.sku] !== undefined && (
                              <Button
                                size="sm" variant="ghost"
                                onClick={() => setEdits(prev => { const n = { ...prev }; delete n[row.sku]; return n; })}
                                className="h-8 w-8 p-0 flex-shrink-0" title="Reset manual edit"
                                data-testid={`srs-reset-${row.sku}`}
                              >
                                <RotateCcw className="w-3 h-3 text-gray-400" />
                              </Button>
                            )}
                            {row.changed ? (
                              <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">changes</span>
                            ) : (
                              <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-400">same</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.length === 0 && (
                  <div className="text-center py-10 text-gray-400 text-xs flex items-center justify-center gap-1">
                    <X className="w-3.5 h-3.5" /> No products found in this series.
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default SeriesRenameStudio;
