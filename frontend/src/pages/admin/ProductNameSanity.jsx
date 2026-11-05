/**
 * ProductNameSanity — admin page that scans supplier_products for suspicious
 * product_name values and offers one-click auto-fixes.
 *
 * Route: /admin/product-name-sanity (link in Admin sidebar).
 *
 * UX:
 *   1. Header stats: total flagged / scanned / per-issue counts.
 *   2. Filter bar: supplier + issue-type + limit.
 *   3. Bulk "Auto-fix all with suggested names" — one click, background operation.
 *   4. Table row per flagged product: current name, issue badges, per-row
 *      Suggested cell (inline editable) + Apply / Skip.
 */
import React, { useState, useCallback, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ShieldCheck, AlertTriangle, RefreshCw, Save, X, ArrowLeft, Filter, Search, Wand2, Layers, CaseLower,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import { smartCase } from '../../utils/nameCase';
import SeriesRenameStudio from './SeriesRenameStudio';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const ISSUE_META = {
  too_short:       { label: 'Too short',      color: 'bg-red-100 text-red-700' },
  contains_none:   { label: 'Contains None',  color: 'bg-red-100 text-red-700' },
  just_sku:        { label: 'Just SKU',       color: 'bg-orange-100 text-orange-700' },
  single_word:     { label: 'Single word',    color: 'bg-amber-100 text-amber-700' },
  missing_color:   { label: 'Missing colour', color: 'bg-blue-100 text-blue-700' },
  missing_size:    { label: 'Missing size',   color: 'bg-blue-100 text-blue-700' },
  duplicate_name:  { label: 'Duplicate',      color: 'bg-purple-100 text-purple-700' },
  has_placeholder: { label: 'Placeholder',    color: 'bg-red-100 text-red-700' },
};

const ProductNameSanity = () => {
  const [report, setReport] = useState({ rows: [], total_scanned: 0, total_flagged: 0, issue_counts: {}, supplier_counts: {} });
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [rowSaving, setRowSaving] = useState({});
  const [suggestedEdits, setSuggestedEdits] = useState({});   // { sku: 'new name typed by admin' }
  const [supplierEdits, setSupplierEdits] = useState({});     // { sku: 'new supplier name typed by admin' }
  const [supplierFilter, setSupplierFilter] = useState('');
  const [issueFilter, setIssueFilter] = useState('');
  const [limit, setLimit] = useState(200);
  const [activeTab, setActiveTab] = useState('flagged');

  const authHeaders = () => {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const loadReport = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (supplierFilter) params.set('supplier', supplierFilter);
      if (issueFilter) params.set('issue', issueFilter);
      params.set('limit', String(limit));
      const res = await fetch(`${API_URL}/api/product-name-sanity/report?${params}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setReport(data);
      setSuggestedEdits({});   // reset unsaved edits
      setSupplierEdits({});
    } catch (err) {
      toast.error(`Failed to load report: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [supplierFilter, issueFilter, limit]);

  useEffect(() => { loadReport(); /* eslint-disable-next-line */ }, []);

  const applyOne = async (row, override) => {
    const newName = (override ?? suggestedEdits[row.sku] ?? row.product_name).trim();
    const newSupplierName = (supplierEdits[row.sku] ?? row.supplier_name ?? '').trim();
    const nameChanged = newName && newName !== row.product_name;
    const supplierChanged = newSupplierName && newSupplierName !== (row.supplier_name || '');
    if (!nameChanged && !supplierChanged) {
      toast.info('Nothing to change');
      return;
    }
    setRowSaving(prev => ({ ...prev, [row.sku]: true }));
    try {
      const res = await fetch(`${API_URL}/api/product-name-sanity/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ items: [{
          sku: row.sku,
          supplier: row.supplier,
          new_name: nameChanged ? newName : row.product_name,
          new_supplier_name: supplierChanged ? newSupplierName : undefined,
        }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.failed?.length) throw new Error(data.failed[0].reason || 'unknown');
      toast.success(`Saved ${row.sku}`);
      // Remove the row locally without a full refetch (feels snappier)
      setReport(prev => ({ ...prev, rows: prev.rows.filter(r => r.sku !== row.sku), total_flagged: prev.total_flagged - 1 }));
    } catch (err) {
      toast.error(`Failed to save ${row.sku}: ${err.message}`);
    } finally {
      setRowSaving(prev => { const next = { ...prev }; delete next[row.sku]; return next; });
    }
  };

  // Rows whose edit box differs from the current name — savable in one click.
  const editedItems = report.rows
    .map(row => {
      const edit = suggestedEdits[row.sku];
      const supplierEdit = supplierEdits[row.sku];
      const newName = edit !== undefined ? edit.trim() : row.product_name;
      const newSupplierName = supplierEdit !== undefined ? supplierEdit.trim() : (row.supplier_name || '');
      const nameChanged = edit !== undefined && newName && newName.length >= 3 && newName !== row.product_name;
      const supplierChanged = supplierEdit !== undefined && newSupplierName && newSupplierName !== (row.supplier_name || '');
      if (!nameChanged && !supplierChanged) return null;
      return {
        sku: row.sku,
        supplier: row.supplier,
        new_name: nameChanged ? newName : row.product_name,
        new_supplier_name: supplierChanged ? newSupplierName : undefined,
      };
    })
    .filter(Boolean);

  const saveAllEdited = async () => {
    if (editedItems.length === 0) { toast.info('No edited names to save'); return; }
    setRunning(true);
    try {
      const res = await fetch(`${API_URL}/api/product-name-sanity/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ items: editedItems }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const failedSkus = new Set((data.failed || []).map(f => f.sku));
      const savedSkus = new Set(editedItems.map(i => i.sku).filter(s => !failedSkus.has(s)));
      toast.success(`Saved ${data.updated} name${data.updated === 1 ? '' : 's'}${failedSkus.size ? ` — ${failedSkus.size} failed` : ''}`);
      setReport(prev => ({ ...prev, rows: prev.rows.filter(r => !savedSkus.has(r.sku)), total_flagged: prev.total_flagged - savedSkus.size }));
      setSuggestedEdits(prev => { const next = { ...prev }; savedSkus.forEach(s => delete next[s]); return next; });
      setSupplierEdits(prev => { const next = { ...prev }; savedSkus.forEach(s => delete next[s]); return next; });
    } catch (err) {
      toast.error(`Bulk save failed: ${err.message}`);
    } finally {
      setRunning(false);
    }
  };

  const suppliers = Object.keys(report.supplier_counts || {}).sort();

  const caseFixableCount = report.rows.filter((r) => {
    const cur = suggestedEdits[r.sku] ?? r.product_name;
    return cur && smartCase(cur) !== cur;
  }).length;

  const fixCaseAll = () => {
    setSuggestedEdits((prev) => {
      const next = { ...prev };
      report.rows.forEach((r) => {
        const cur = next[r.sku] ?? r.product_name;
        const fixed = smartCase(cur);
        if (cur && fixed !== cur) next[r.sku] = fixed;
      });
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      {/* Header */}
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link to="/admin/supplier-products" className="text-gray-500 hover:text-gray-900" data-testid="pns-back">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <ShieldCheck className="w-6 h-6 text-emerald-600" />
            <div>
              <h1 className="text-xl font-bold text-gray-900">Product Name Sanity</h1>
              <p className="text-xs text-gray-500">Spot garbled, truncated, or missing-attribute product names — and fix them one click at a time.</p>
            </div>
          </div>
          {activeTab === 'flagged' && (
            <Button variant="outline" size="sm" onClick={loadReport} disabled={loading} data-testid="pns-refresh">
              <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Rescan
            </Button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('flagged')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'flagged' ? 'bg-slate-800 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}
            data-testid="pns-tab-flagged"
          >
            <AlertTriangle className="w-4 h-4" /> Flagged Names
          </button>
          <button
            onClick={() => setActiveTab('series')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === 'series' ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}
            data-testid="pns-tab-series"
          >
            <Layers className="w-4 h-4" /> Series Rename
          </button>
        </div>

        {activeTab === 'series' ? <SeriesRenameStudio /> : (
        <>
        {/* Stats strip */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <div className="bg-white border border-gray-200 rounded p-3">
            <div className="text-[10px] uppercase tracking-wider text-gray-400">Scanned</div>
            <div className="text-lg font-bold text-gray-800" data-testid="pns-stat-scanned">{report.total_scanned}</div>
          </div>
          <div className="bg-white border border-red-200 rounded p-3">
            <div className="text-[10px] uppercase tracking-wider text-red-500">Flagged</div>
            <div className="text-lg font-bold text-red-700" data-testid="pns-stat-flagged">{report.total_flagged}</div>
          </div>
          {Object.entries(report.issue_counts).slice(0, 3).map(([k, v]) => (
            <div key={k} className="bg-white border border-gray-200 rounded p-3">
              <div className="text-[10px] uppercase tracking-wider text-gray-400">{ISSUE_META[k]?.label || k}</div>
              <div className="text-lg font-bold text-gray-800">{v}</div>
            </div>
          ))}
        </div>

        {/* Filter bar */}
        <div className="bg-white border border-gray-200 rounded-lg p-3 flex items-center gap-2 flex-wrap">
          <Filter className="w-4 h-4 text-gray-400" />
          <span className="text-xs text-gray-500 font-medium">Filter:</span>
          <select
            className="h-8 text-xs border border-gray-300 rounded px-2 min-w-[180px]"
            value={supplierFilter}
            onChange={(e) => setSupplierFilter(e.target.value)}
            data-testid="pns-filter-supplier"
          >
            <option value="">All suppliers</option>
            {suppliers.map(s => <option key={s} value={s}>{s} ({report.supplier_counts[s]})</option>)}
          </select>
          <select
            className="h-8 text-xs border border-gray-300 rounded px-2 min-w-[180px]"
            value={issueFilter}
            onChange={(e) => setIssueFilter(e.target.value)}
            data-testid="pns-filter-issue"
          >
            <option value="">All issues</option>
            {Object.keys(ISSUE_META).map(k => <option key={k} value={k}>{ISSUE_META[k].label} {report.issue_counts[k] ? `(${report.issue_counts[k]})` : ''}</option>)}
          </select>
          <select
            className="h-8 text-xs border border-gray-300 rounded px-2"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            data-testid="pns-filter-limit"
          >
            {[100, 200, 500, 1000, 5000].map(n => <option key={n} value={n}>Limit {n}</option>)}
          </select>
          <Button size="sm" onClick={loadReport} disabled={loading} className="bg-slate-700 hover:bg-slate-800 text-white h-8" data-testid="pns-apply-filter">
            <Search className="w-3.5 h-3.5 mr-1" /> Apply
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              onClick={fixCaseAll}
              disabled={running || caseFixableCount === 0}
              className="border-amber-500 text-amber-700 hover:bg-amber-50 disabled:opacity-50"
              data-testid="pns-fix-case-all"
              title="Convert SHOUTING CAPS names to Title Case in the New Name boxes below (10MM stays 10mm) — review then hit Save all edited"
            >
              <CaseLower className="w-4 h-4 mr-1.5" />
              Fix ALL-CAPS {caseFixableCount ? `(${caseFixableCount})` : ''}
            </Button>
            <Button
              onClick={saveAllEdited}
              disabled={running || editedItems.length === 0}
              className="bg-blue-600 hover:bg-blue-700 text-white"
              data-testid="pns-save-all-edited"
              title="Save every name you've edited in the list below"
            >
              {running ? <RefreshCw className="w-4 h-4 mr-1.5 animate-spin" /> : <Save className="w-4 h-4 mr-1.5" />}
              Save all edited {editedItems.length ? `(${editedItems.length})` : ''}
            </Button>
          </div>
        </div>

        {/* Table */}
        {loading ? (
          <div className="text-center py-16 text-gray-400 text-sm"><RefreshCw className="w-6 h-6 mx-auto animate-spin mb-2" />Scanning…</div>
        ) : report.rows.length === 0 ? (
          <div className="bg-white border border-emerald-200 rounded-lg p-8 text-center">
            <ShieldCheck className="w-10 h-10 mx-auto text-emerald-500 mb-2" />
            <p className="text-lg font-medium text-emerald-700">Zero problems detected in this filter 🎉</p>
            <p className="text-xs text-gray-500 mt-1">Change filters above or hit Rescan to run again.</p>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-gray-200">
                <tr className="text-left text-gray-500">
                  <th className="px-3 py-2 font-medium w-24">SKU</th>
                  <th className="px-3 py-2 font-medium">Current name</th>
                  <th className="px-3 py-2 font-medium text-sky-700 min-w-[220px]">Supplier name</th>
                  <th className="px-3 py-2 font-medium w-56">Issues</th>
                  <th className="px-3 py-2 font-medium w-48">Fields</th>
                  <th className="px-3 py-2 font-medium min-w-[320px]">New name (edit &amp; save)</th>
                  <th className="px-3 py-2 font-medium text-right w-40">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {report.rows.map(row => {
                  const busy = !!rowSaving[row.sku];
                  const currentEdit = suggestedEdits[row.sku] ?? row.product_name;
                  const currentSupplierEdit = supplierEdits[row.sku] ?? row.supplier_name ?? '';
                  const nameWillChange = currentEdit && currentEdit !== row.product_name;
                  // Clearing the field entirely isn't a save-able change — saving
                  // an empty supplier name is ignored by the backend, so keep the
                  // Save button's enabled state in sync with that.
                  const supplierWillChange = currentSupplierEdit.trim() !== '' && currentSupplierEdit !== (row.supplier_name || '');
                  const willChange = nameWillChange || supplierWillChange;
                  return (
                    <tr key={row.sku} className={busy ? 'opacity-50' : ''} data-testid={`pns-row-${row.sku}`}>
                      <td className="px-3 py-2 font-mono text-[11px] text-slate-600">
                        <div>{row.sku}</div>
                        <div className="text-[10px] text-gray-400">{row.supplier}</div>
                      </td>
                      <td className="px-3 py-2 text-slate-800">{row.product_name || <span className="text-gray-300">— empty —</span>}</td>
                      <td className="px-3 py-2 min-w-[220px]" data-testid={`pns-suppliername-${row.sku}`}>
                        <Input
                          value={currentSupplierEdit}
                          onChange={(e) => setSupplierEdits(prev => ({ ...prev, [row.sku]: e.target.value }))}
                          placeholder="Supplier name…"
                          className="h-8 text-xs"
                          data-testid={`pns-supplier-input-${row.sku}`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {row.issues.map(i => (
                            <span key={i} className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${ISSUE_META[i]?.color || 'bg-gray-100 text-gray-600'}`} data-testid={`pns-issue-${i}`}>
                              {ISSUE_META[i]?.label || i}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-[10px] text-gray-500 font-mono">
                        {row.color   && <div>color: <span className="text-slate-700">{row.color}</span></div>}
                        {row.size    && <div>size: <span className="text-slate-700">{row.size}</span></div>}
                        {row.finish  && <div>finish: <span className="text-slate-700">{row.finish}</span></div>}
                        {!row.color && !row.size && !row.finish && <div className="text-gray-300">no attributes</div>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          <Input
                            value={currentEdit}
                            onChange={(e) => setSuggestedEdits(prev => ({ ...prev, [row.sku]: e.target.value }))}
                            className="h-9 text-sm"
                            data-testid={`pns-suggest-${row.sku}`}
                          />
                          {currentEdit && smartCase(currentEdit) !== currentEdit && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setSuggestedEdits(prev => ({ ...prev, [row.sku]: smartCase(currentEdit) }))}
                              className="h-8 px-2 flex-shrink-0 border-amber-300"
                              title={`Fix case: ${smartCase(currentEdit)}`}
                              data-testid={`pns-fix-case-${row.sku}`}
                            >
                              <CaseLower className="w-3.5 h-3.5 text-amber-600" />
                            </Button>
                          )}
                          {row.suggested_name && row.suggested_name !== currentEdit && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setSuggestedEdits(prev => ({ ...prev, [row.sku]: row.suggested_name }))}
                              className="h-8 px-2 flex-shrink-0"
                              title={`Use suggestion: ${row.suggested_name}`}
                              data-testid={`pns-use-suggestion-${row.sku}`}
                            >
                              <Wand2 className="w-3 h-3 text-violet-500" />
                            </Button>
                          )}
                        </div>
                        {row.suggested_name && row.suggested_name !== currentEdit && (
                          <div className="mt-0.5 text-[10px] text-gray-400 truncate max-w-[300px]" title={row.suggested_name}>
                            suggestion: {row.suggested_name}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <Button
                          size="sm"
                          onClick={() => applyOne(row)}
                          disabled={busy || !willChange}
                          className="h-7 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white mr-1"
                          data-testid={`pns-apply-${row.sku}`}
                        >
                          {busy ? <RefreshCw className="w-3 h-3 animate-spin" /> : <><Save className="w-3 h-3 mr-1" />Save</>}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setReport(prev => ({ ...prev, rows: prev.rows.filter(r => r.sku !== row.sku), total_flagged: prev.total_flagged - 1 }))}
                          disabled={busy}
                          className="h-7 text-[11px]"
                          data-testid={`pns-skip-${row.sku}`}
                          title="Hide from this session (does NOT edit the DB)"
                        >
                          <X className="w-3 h-3 mr-1" /> Skip
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Hint footer */}
        <div className="text-[11px] text-gray-500 flex items-center gap-2 justify-center">
          <Wand2 className="w-3 h-3" />
          Edit any name directly and click <b>Save</b> — nothing changes until you save. The <Wand2 className="w-3 h-3 inline text-violet-500" /> button loads the auto-suggestion (built from <code>product_name + color + size + finish</code>) if you want it.
        </div>
        </>
        )}
      </div>
    </div>
  );
};

export default ProductNameSanity;
