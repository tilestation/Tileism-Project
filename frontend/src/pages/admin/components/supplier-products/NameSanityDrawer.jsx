/**
 * NameSanityDrawer — slide-in drawer merged into the Supplier Products page.
 *
 * Wraps the existing /api/product-name-sanity/{report,apply,apply-suggested}
 * endpoints so admins can spot & one-click-fix garbled product names WITHOUT
 * leaving the Supplier Products screen.
 *
 * Props:
 *   open              — boolean, controls visibility
 *   onClose()         — callback to close the drawer
 *   defaultSupplier   — optional supplier slug to pre-filter (matches the
 *                       currently-selected supplier chip on the parent page)
 *   onRenamed()       — optional callback fired after a rename so the parent
 *                       page can refresh its product list
 */
import React, { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import {
  ShieldCheck, AlertTriangle, RefreshCw, Save, X, Zap, Filter, Search, Wand2,
} from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';

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

const NameSanityDrawer = ({ open, onClose, defaultSupplier = '', onRenamed, selectedSkus = null, knownSuppliers = [] }) => {
  const [report, setReport] = useState({ rows: [], total_scanned: 0, total_flagged: 0, issue_counts: {}, supplier_counts: {} });
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [rowSaving, setRowSaving] = useState({});
  const [suggestedEdits, setSuggestedEdits] = useState({});
  const [supplierFilter, setSupplierFilter] = useState(defaultSupplier || '');
  const [issueFilter, setIssueFilter] = useState('');
  const [limit, setLimit] = useState(200);
  const [searchQuery, setSearchQuery] = useState('');

  const scoped = Array.isArray(selectedSkus) && selectedSkus.length > 0;

  const authHeaders = () => {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const loadReport = useCallback(async () => {
    setLoading(true);
    try {
      let res;
      if (scoped) {
        // Selection mode — POST the SKU list and get back rows for exactly those products.
        res = await fetch(`${API_URL}/api/product-name-sanity/report-for-selection`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ skus: selectedSkus, include_clean: true }),
        });
      } else {
        // Global scan mode. If a supplier is chosen we include clean rows too,
        // so admins can rename ANY product in that supplier (not only flagged).
        const params = new URLSearchParams();
        if (supplierFilter) {
          params.set('supplier', supplierFilter);
          params.set('include_clean', 'true');
        }
        if (issueFilter) params.set('issue', issueFilter);
        params.set('limit', String(limit));
        res = await fetch(`${API_URL}/api/product-name-sanity/report?${params}`, { headers: authHeaders() });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setReport(data);
      setSuggestedEdits({});
    } catch (err) {
      toast.error(`Failed to load report: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [supplierFilter, issueFilter, limit, scoped, selectedSkus]);

  // Re-fetch when drawer opens
  useEffect(() => {
    if (open) loadReport();
  }, [open, loadReport]);

  // Reflect parent supplier changes while drawer is open
  useEffect(() => {
    if (open && defaultSupplier !== undefined) {
      setSupplierFilter(defaultSupplier || '');
    }
  }, [defaultSupplier, open]);

  const applyOne = async (row, override) => {
    const newName = (override ?? suggestedEdits[row.sku] ?? row.suggested_name).trim();
    if (!newName || newName === row.product_name) {
      toast.info('Nothing to change');
      return;
    }
    setRowSaving(prev => ({ ...prev, [row.sku]: true }));
    try {
      const res = await fetch(`${API_URL}/api/product-name-sanity/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ items: [{ sku: row.sku, supplier: row.supplier, new_name: newName }] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.failed?.length) throw new Error(data.failed[0].reason || 'unknown');
      toast.success(`Renamed ${row.sku} → "${newName}"`);
      setReport(prev => ({ ...prev, rows: prev.rows.filter(r => r.sku !== row.sku), total_flagged: prev.total_flagged - 1 }));
      onRenamed?.();
    } catch (err) {
      toast.error(`Failed to rename ${row.sku}: ${err.message}`);
    } finally {
      setRowSaving(prev => { const next = { ...prev }; delete next[row.sku]; return next; });
    }
  };

  const applyAllSuggested = async () => {
    const count = report.rows.filter(r => r.issues.length > 0).length;
    if (count === 0) { toast.info('No rows to fix'); return; }
    if (!window.confirm(`Auto-apply the suggested name to ALL ${count} flagged product${count === 1 ? '' : 's'} shown?\n\nEach product's suggested name will REPLACE its current name in the database. This is logged.`)) return;
    setRunning(true);
    try {
      if (scoped) {
        // In selection mode we don't have a "auto-fix by filter" endpoint — apply row-by-row via /apply.
        const items = report.rows
          .filter(r => r.issues.length > 0 && r.suggested_name && r.suggested_name !== r.product_name)
          .map(r => ({ sku: r.sku, supplier: r.supplier, new_name: r.suggested_name }));
        if (items.length === 0) { toast.info('Nothing to auto-fix'); setRunning(false); return; }
        const res = await fetch(`${API_URL}/api/product-name-sanity/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ items }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        toast.success(`Auto-fixed ${data.updated} product name${data.updated === 1 ? '' : 's'} (${data.failed?.length || 0} failed)`);
      } else {
        const params = new URLSearchParams();
        if (supplierFilter) params.set('supplier', supplierFilter);
        if (issueFilter) params.append('only_issues', issueFilter);
        params.set('limit', String(count));
        const res = await fetch(`${API_URL}/api/product-name-sanity/apply-suggested?${params}`, {
          method: 'POST',
          headers: authHeaders(),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        toast.success(`Auto-fixed ${data.updated} product name${data.updated === 1 ? '' : 's'} (${data.skipped} skipped)`);
      }
      onRenamed?.();
      loadReport();
    } catch (err) {
      toast.error(`Auto-fix failed: ${err.message}`);
    } finally {
      setRunning(false);
    }
  };

  const suppliers = knownSuppliers && knownSuppliers.length > 0
    ? knownSuppliers
    : Object.keys(report.supplier_counts || {}).sort();

  // Apply local search filter (name / sku / range / supplier) on top of the fetched rows.
  const q = searchQuery.trim().toLowerCase();
  const visibleRows = q
    ? report.rows.filter((r) => {
        const hay = `${r.product_name || ''} ${r.sku || ''} ${r.range_name || ''} ${r.supplier || ''}`.toLowerCase();
        return hay.includes(q);
      })
    : report.rows;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[80] flex" data-testid="name-sanity-drawer">
      {/* Backdrop */}
      <div
        className="flex-1 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        data-testid="name-sanity-backdrop"
      />
      {/* Drawer panel */}
      <div className="w-full max-w-6xl h-full bg-gray-50 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-gray-200 bg-white">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-5 h-5 text-emerald-600" />
            <div>
              <h2 className="text-base font-bold text-gray-900">
                Product Name Sanity
                {scoped && (
                  <span
                    className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 text-[11px] font-medium align-middle"
                    data-testid="pns-selection-badge"
                  >
                    <AlertTriangle className="w-3 h-3" />
                    {selectedSkus.length} selected
                  </span>
                )}
              </h2>
              <p className="text-[11px] text-gray-500">
                {scoped
                  ? 'Reviewing ONLY the products you selected on Supplier Products — fix names and close to return.'
                  : 'Spot garbled or truncated names — fix inline without leaving Supplier Products.'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={loadReport} disabled={loading} data-testid="pns-refresh">
              <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Rescan
            </Button>
            <Button variant="ghost" size="sm" onClick={onClose} data-testid="pns-close">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Stats + Filter bar */}
        <div className="px-5 py-3 space-y-3 border-b border-gray-200 bg-white">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <div className="bg-slate-50 border border-slate-200 rounded p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-gray-400">Scanned</div>
              <div className="text-lg font-bold text-gray-800" data-testid="pns-stat-scanned">{report.total_scanned}</div>
            </div>
            <div className="bg-red-50 border border-red-200 rounded p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-red-500">Flagged</div>
              <div className="text-lg font-bold text-red-700" data-testid="pns-stat-flagged">{report.total_flagged}</div>
            </div>
            {Object.entries(report.issue_counts).slice(0, 3).map(([k, v]) => (
              <div key={k} className="bg-slate-50 border border-slate-200 rounded p-2.5">
                <div className="text-[10px] uppercase tracking-wider text-gray-400">{ISSUE_META[k]?.label || k}</div>
                <div className="text-lg font-bold text-gray-800">{v}</div>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Filter className="w-4 h-4 text-gray-400" />
            <span className="text-xs text-gray-500 font-medium">Filter:</span>
            <select
              className="h-8 text-xs border border-gray-300 rounded px-2 min-w-[180px] disabled:bg-gray-100 disabled:text-gray-400"
              value={supplierFilter}
              onChange={(e) => setSupplierFilter(e.target.value)}
              data-testid="pns-filter-supplier"
              disabled={scoped}
            >
              <option value="">All suppliers</option>
              {suppliers.map((s) => {
                // Support both plain strings and { name, count } objects.
                const name = typeof s === 'string' ? s : s.name || s.id;
                const cnt = typeof s === 'string'
                  ? report.supplier_counts?.[s]
                  : (s.count ?? report.supplier_counts?.[name]);
                return (
                  <option key={name} value={name}>
                    {name}{cnt ? ` (${cnt})` : ''}
                  </option>
                );
              })}
            </select>
            <select
              className="h-8 text-xs border border-gray-300 rounded px-2 min-w-[180px] disabled:bg-gray-100 disabled:text-gray-400"
              value={issueFilter}
              onChange={(e) => setIssueFilter(e.target.value)}
              data-testid="pns-filter-issue"
              disabled={scoped}
            >
              <option value="">All issues</option>
              {Object.keys(ISSUE_META).map(k => (
                <option key={k} value={k}>
                  {ISSUE_META[k].label} {report.issue_counts[k] ? `(${report.issue_counts[k]})` : ''}
                </option>
              ))}
            </select>
            <select
              className="h-8 text-xs border border-gray-300 rounded px-2 disabled:bg-gray-100 disabled:text-gray-400"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              data-testid="pns-filter-limit"
              disabled={scoped}
            >
              {[100, 200, 500, 1000, 5000].map(n => <option key={n} value={n}>Limit {n}</option>)}
            </select>
            <Button
              size="sm"
              onClick={loadReport}
              disabled={loading || scoped}
              className="bg-slate-700 hover:bg-slate-800 text-white h-8 disabled:bg-gray-300"
              data-testid="pns-apply-filter"
            >
              <Search className="w-3.5 h-3.5 mr-1" /> Apply
            </Button>

            {/* Search box — client-side filter across name / SKU / series / supplier. */}
            <div className="relative flex-1 min-w-[220px] max-w-[360px]">
              <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
              <Input
                type="text"
                placeholder="Search name, SKU, series…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 text-xs pl-7 pr-7"
                data-testid="pns-search"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  data-testid="pns-search-clear"
                  title="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="ml-auto">
              <Button
                onClick={applyAllSuggested}
                disabled={running || report.rows.length === 0}
                className="bg-emerald-600 hover:bg-emerald-700 text-white h-8"
                data-testid="pns-auto-fix-all"
              >
                {running ? <RefreshCw className="w-4 h-4 mr-1.5 animate-spin" /> : <Zap className="w-4 h-4 mr-1.5" />}
                Auto-fix all {(() => {
                  const flaggedCount = report.rows.filter(r => r.issues.length > 0).length;
                  return flaggedCount ? `(${flaggedCount})` : '';
                })()}
              </Button>
            </div>
          </div>
        </div>

        {/* Table body (scrollable) */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="text-center py-16 text-gray-400 text-sm">
              <RefreshCw className="w-6 h-6 mx-auto animate-spin mb-2" />Scanning…
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="bg-white border border-emerald-200 rounded-lg p-8 text-center">
              <ShieldCheck className="w-10 h-10 mx-auto text-emerald-500 mb-2" />
              <p className="text-lg font-medium text-emerald-700">
                {searchQuery ? `No products match "${searchQuery}"` : 'Zero problems detected in this filter'}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {searchQuery ? 'Clear the search or refine your query.' : 'Change filters above or hit Rescan to run again.'}
              </p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 border-b border-gray-200 sticky top-0">
                  <tr className="text-left text-gray-500">
                    <th className="px-3 py-2 font-medium w-24">SKU</th>
                    <th className="px-3 py-2 font-medium">Current name</th>
                    <th className="px-3 py-2 font-medium w-56">Issues</th>
                    <th className="px-3 py-2 font-medium w-48">Fields</th>
                    <th className="px-3 py-2 font-medium">Suggested (editable)</th>
                    <th className="px-3 py-2 font-medium text-right w-40">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {visibleRows.map(row => {
                    const busy = !!rowSaving[row.sku];
                    const currentEdit = suggestedEdits[row.sku] ?? row.suggested_name;
                    const willChange = currentEdit && currentEdit !== row.product_name;
                    return (
                      <tr key={row.sku} className={busy ? 'opacity-50' : ''} data-testid={`pns-row-${row.sku}`}>
                        <td className="px-3 py-2 font-mono text-[11px] text-slate-600 align-top">
                          <div>{row.sku}</div>
                          <div className="text-[10px] text-gray-400">{row.supplier}</div>
                        </td>
                        <td className="px-3 py-2 text-slate-800 align-top">
                          {row.product_name || <span className="text-gray-300">— empty —</span>}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <div className="flex flex-wrap gap-1">
                            {row.issues.length === 0 ? (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-700" data-testid="pns-issue-clean">
                                Clean
                              </span>
                            ) : row.issues.map(i => (
                              <span
                                key={i}
                                className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${ISSUE_META[i]?.color || 'bg-gray-100 text-gray-600'}`}
                                data-testid={`pns-issue-${i}`}
                              >
                                {ISSUE_META[i]?.label || i}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-[10px] text-gray-500 font-mono align-top">
                          {row.color   && <div>color: <span className="text-slate-700">{row.color}</span></div>}
                          {row.size    && <div>size: <span className="text-slate-700">{row.size}</span></div>}
                          {row.finish  && <div>finish: <span className="text-slate-700">{row.finish}</span></div>}
                          {!row.color && !row.size && !row.finish && <div className="text-gray-300">no attributes</div>}
                        </td>
                        <td className="px-3 py-2 align-top">
                          <Input
                            value={currentEdit}
                            onChange={(e) => setSuggestedEdits(prev => ({ ...prev, [row.sku]: e.target.value }))}
                            className="h-8 text-xs"
                            data-testid={`pns-suggest-${row.sku}`}
                          />
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap align-top">
                          <Button
                            size="sm"
                            onClick={() => applyOne(row)}
                            disabled={busy || !willChange}
                            className="h-7 text-[11px] bg-emerald-600 hover:bg-emerald-700 text-white mr-1"
                            data-testid={`pns-apply-${row.sku}`}
                          >
                            {busy ? <RefreshCw className="w-3 h-3 animate-spin" /> : <><Save className="w-3 h-3 mr-1" />Apply</>}
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
        </div>

        {/* Footer hint */}
        <div className="text-[11px] text-gray-500 flex items-center gap-2 justify-center py-2 border-t border-gray-200 bg-white">
          <Wand2 className="w-3 h-3" />
          Suggested names are built from <code>product_name + color + size + finish</code>. Edit inline before Apply.
        </div>
      </div>
    </div>
  );
};

export default NameSanityDrawer;
