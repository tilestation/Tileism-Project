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
  ShieldCheck, AlertTriangle, RefreshCw, Save, X, Filter, Search, Wand2, Send, MapPin, Trash2, Ghost, Layers, Copy,
} from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import SeriesRenameStudio from '../../SeriesRenameStudio';

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
  const [locateSku, setLocateSku] = useState('');
  const [locateResult, setLocateResult] = useState(null); // { sku, locations: [...] }
  const [locating, setLocating] = useState(false);
  const [purging, setPurging] = useState({}); // { collection: bool }
  const [sweepRunning, setSweepRunning] = useState(false);
  const [sweepResult, setSweepResult] = useState(null); // { total_ghosts, per_collection, rows }
  const [sweepSelected, setSweepSelected] = useState(() => new Set()); // Set of `${col}|${sku}`
  const [sweepPurging, setSweepPurging] = useState(false);
  const [ghostEdits, setGhostEdits] = useState({});   // { `${col}|${sku}`: 'new name typed by admin' }
  const [ghostSaving, setGhostSaving] = useState(false);
  const [ghostAdopting, setGhostAdopting] = useState(false);
  const [view, setView] = useState('flagged');

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
    const newName = (override ?? suggestedEdits[row.sku] ?? row.product_name).trim();
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

  // Rows whose edit box differs from the current name — savable in one click.
  const editedItems = report.rows
    .map(row => {
      const edit = suggestedEdits[row.sku];
      if (edit === undefined) return null;
      const newName = edit.trim();
      if (!newName || newName.length < 3 || newName === row.product_name) return null;
      return { sku: row.sku, supplier: row.supplier, new_name: newName };
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
      onRenamed?.();
    } catch (err) {
      toast.error(`Bulk save failed: ${err.message}`);
    } finally {
      setRunning(false);
    }
  };

  const syncToEposAndWebsite = async () => {
    const scope = supplierFilter
      ? `every product in ${supplierFilter}`
      : 'EVERY supplier product in the database';
    if (!window.confirm(`Push each supplier product's current name to the Website (tiles) and EPOS (products) collections for ${scope}?\n\nThis is a one-way sync — supplier_products.product_name wins over what's currently in EPOS/tiles. Only rows where the name has drifted will be updated. This is logged.`)) return;
    setRunning(true);
    try {
      const params = new URLSearchParams();
      if (supplierFilter) params.set('supplier', supplierFilter);
      const res = await fetch(`${API_URL}/api/product-name-sanity/sync-to-epos-website?${params}`, {
        method: 'POST',
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      toast.success(
        `Backfill synced ${data.tiles_updated} website row${data.tiles_updated === 1 ? '' : 's'} + ${data.products_updated} EPOS product${data.products_updated === 1 ? '' : 's'} (scanned ${data.scanned})`,
        { duration: 6000 }
      );
      onRenamed?.();
    } catch (err) {
      toast.error(`Sync failed: ${err.message}`);
    } finally {
      setRunning(false);
    }
  };

  const locateSkuAcrossCollections = async () => {
    const sku = locateSku.trim();
    if (!sku) { toast.info('Type a SKU to locate'); return; }
    setLocating(true);
    setLocateResult(null);
    try {
      const res = await fetch(`${API_URL}/api/product-name-sanity/locate?sku=${encodeURIComponent(sku)}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setLocateResult(data);
      if (data.found === 0) toast.info(`No matches for "${sku}" in supplier_products, products, or tiles.`);
    } catch (err) {
      toast.error(`Locate failed: ${err.message}`);
    } finally {
      setLocating(false);
    }
  };

  const purgeFromCollection = async (sku, collection) => {
    if (!window.confirm(`Delete every row where sku="${sku}" from the "${collection}" collection?\n\nThis is IRREVERSIBLE. Use this only for ghost EPOS/website records that don't have a matching Supplier Product. This is logged.`)) return;
    setPurging((p) => ({ ...p, [collection]: true }));
    try {
      const res = await fetch(`${API_URL}/api/product-name-sanity/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ sku, collections: [collection] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const removed = data.deleted?.[collection] ?? 0;
      toast.success(`Deleted ${removed} row${removed === 1 ? '' : 's'} from ${collection}`);
      // Re-run locate so the panel refreshes.
      await locateSkuAcrossCollections();
      onRenamed?.();
    } catch (err) {
      toast.error(`Purge failed: ${err.message}`);
    } finally {
      setPurging((p) => ({ ...p, [collection]: false }));
    }
  };

  const runGhostSweep = async () => {
    setSweepRunning(true);
    setSweepResult(null);
    setSweepSelected(new Set());
    try {
      const res = await fetch(`${API_URL}/api/product-name-sanity/ghost-sweep?limit=2000`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSweepResult(data);
      toast.success(
        `Ghost sweep found ${data.total_ghosts} orphan${data.total_ghosts === 1 ? '' : 's'} — ${data.per_collection?.products || 0} products / ${data.per_collection?.tiles || 0} tiles / ${data.per_collection?.sync_staging || 0} staging`,
        { duration: 6000 }
      );
    } catch (err) {
      toast.error(`Ghost sweep failed: ${err.message}`);
    } finally {
      setSweepRunning(false);
    }
  };

  const toggleSweepRow = (col, sku) => {
    const k = `${col}|${sku}`;
    setSweepSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  const toggleSweepAll = () => {
    if (!sweepResult) return;
    if (sweepSelected.size === sweepResult.rows.length) {
      setSweepSelected(new Set());
    } else {
      setSweepSelected(new Set(sweepResult.rows.map((r) => `${r.collection}|${r.sku}`)));
    }
  };

  const bulkPurgeGhosts = async () => {
    if (sweepSelected.size === 0) { toast.info('Select at least one ghost row to purge'); return; }
    if (!window.confirm(`Permanently delete ${sweepSelected.size} ghost row${sweepSelected.size === 1 ? '' : 's'} from EPOS/Website/staging?\n\nThis is IRREVERSIBLE. Each row will be removed from the collection shown. supplier_products is untouched. This is logged.`)) return;
    const items = Array.from(sweepSelected).map((k) => {
      const [collection, ...rest] = k.split('|');
      return { collection, sku: rest.join('|') };
    });
    setSweepPurging(true);
    try {
      const res = await fetch(`${API_URL}/api/product-name-sanity/ghost-sweep/purge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const totalDeleted = Object.values(data.deleted || {}).reduce((a, b) => a + b, 0);
      toast.success(
        `Purged ${totalDeleted} ghost row${totalDeleted === 1 ? '' : 's'} — ${data.deleted?.products || 0} products / ${data.deleted?.tiles || 0} tiles / ${data.deleted?.sync_staging || 0} staging`,
        { duration: 6000 }
      );
      onRenamed?.();
      // Refresh the sweep after purge
      await runGhostSweep();
    } catch (err) {
      toast.error(`Bulk purge failed: ${err.message}`);
    } finally {
      setSweepPurging(false);
    }
  };

  const adoptSelectedGhosts = async () => {
    if (sweepSelected.size === 0) { toast.info('Select at least one ghost row to adopt'); return; }
    if (!window.confirm(`Adopt ${sweepSelected.size} ghost row${sweepSelected.size === 1 ? '' : 's'} into Supplier Products?\n\nEach becomes a proper managed product (name, price, images and categories are copied). SKUs already in Supplier Products are skipped. This is logged.`)) return;
    const items = Array.from(sweepSelected).map((k) => {
      const [collection, ...rest] = k.split('|');
      return { collection, sku: rest.join('|') };
    });
    setGhostAdopting(true);
    try {
      const res = await fetch(`${API_URL}/api/product-name-sanity/ghost-sweep/adopt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      toast.success(
        `Adopted ${data.adopted} product${data.adopted === 1 ? '' : 's'} into Supplier Products${data.skipped?.length ? ` — ${data.skipped.length} skipped` : ''}`,
        { duration: 6000 }
      );
      onRenamed?.();
      // Refresh the sweep — adopted rows are no longer ghosts
      await runGhostSweep();
    } catch (err) {
      toast.error(`Adopt failed: ${err.message}`);
    } finally {
      setGhostAdopting(false);
    }
  };

  // Ghost rows whose edit box differs from the stored name — savable in one click.
  const editedGhostItems = (sweepResult?.rows || [])
    .map((r) => {
      const k = `${r.collection}|${r.sku}`;
      const edit = ghostEdits[k];
      if (edit === undefined) return null;
      const newName = edit.trim();
      const current = (r.name || r.product_name || '').trim();
      if (!newName || newName.length < 3 || newName === current) return null;
      return { sku: r.sku, collection: r.collection, new_name: newName };
    })
    .filter(Boolean);

  const saveEditedGhosts = async () => {
    if (editedGhostItems.length === 0) { toast.info('No edited ghost names to save'); return; }
    setGhostSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/product-name-sanity/ghost-sweep/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ items: editedGhostItems }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const failedSkus = new Set((data.failed || []).map(f => f.sku));
      toast.success(`Fixed ${data.updated} ghost name${data.updated === 1 ? '' : 's'}${failedSkus.size ? ` — ${failedSkus.size} failed` : ''}`);
      // Update the sweep rows in place (they stay ghosts — just correctly named now)
      setSweepResult(prev => ({
        ...prev,
        rows: prev.rows.map(r => {
          const item = editedGhostItems.find(i => i.sku === r.sku && i.collection === r.collection);
          if (!item || failedSkus.has(r.sku)) return r;
          return { ...r, name: item.new_name, product_name: item.new_name };
        }),
      }));
      setGhostEdits(prev => {
        const next = { ...prev };
        editedGhostItems.forEach(i => { if (!failedSkus.has(i.sku)) delete next[`${i.collection}|${i.sku}`]; });
        return next;
      });
      onRenamed?.();
    } catch (err) {
      toast.error(`Ghost rename failed: ${err.message}`);
    } finally {
      setGhostSaving(false);
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
            {view === 'flagged' && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={syncToEposAndWebsite}
                  disabled={running || loading || scoped}
                  className="border-indigo-500 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                  data-testid="pns-sync-epos-website"
                  title={scoped
                    ? 'Disabled — clear the selection first, then choose a supplier to sync it, or leave supplier blank for a full DB sync'
                    : (supplierFilter
                        ? `Push every ${supplierFilter} product name from Supplier Products into EPOS + Website (backfill)`
                        : 'Push every supplier product name into EPOS + Website (backfill across all suppliers)')}
                >
                  {running ? <RefreshCw className="w-4 h-4 mr-1.5 animate-spin" /> : <Send className="w-4 h-4 mr-1.5" />}
                  Sync to EPOS &amp; Website
                </Button>
                <Button variant="outline" size="sm" onClick={loadReport} disabled={loading} data-testid="pns-refresh">
                  <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Rescan
                </Button>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={onClose} data-testid="pns-close">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* View tabs */}
        <div className="flex items-center gap-2 px-5 py-2 border-b border-gray-200 bg-white">
          <button
            onClick={() => setView('flagged')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors ${view === 'flagged' ? 'bg-slate-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            data-testid="pns-drawer-tab-flagged"
          >
            <AlertTriangle className="w-3.5 h-3.5" /> Flagged Names
          </button>
          <button
            onClick={() => setView('series')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition-colors ${view === 'series' ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            data-testid="pns-drawer-tab-series"
          >
            <Layers className="w-3.5 h-3.5" /> Series Rename
            <span className="text-[9px] px-1 py-0.5 rounded bg-amber-400 text-amber-900 font-bold leading-none">NEW</span>
          </button>
          {view === 'series' && (
            <span className="text-[11px] text-gray-400 ml-2">Rename every product in a series at once — Standardise, Find &amp; Replace, or Manual.</span>
          )}
        </div>

        {view === 'series' ? (
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <SeriesRenameStudio />
          </div>
        ) : (
        <>
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

            <div className="ml-auto flex items-center gap-2">
              <Button
                onClick={saveAllEdited}
                disabled={running || editedItems.length === 0}
                className="bg-blue-600 hover:bg-blue-700 text-white h-8"
                data-testid="pns-save-all-edited"
                title="Save every name you've edited in the list below"
              >
                {running ? <RefreshCw className="w-4 h-4 mr-1.5 animate-spin" /> : <Save className="w-4 h-4 mr-1.5" />}
                Save all edited {editedItems.length ? `(${editedItems.length})` : ''}
              </Button>
            </div>
          </div>

          {/* Locate SKU helper — pinpoint ghost EPOS / Website records that don't
              have a matching Supplier Product row (like duplicate/wrong-name entries). */}
          <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-2.5 flex items-center gap-2 flex-wrap" data-testid="pns-locate-panel">
            <MapPin className="w-4 h-4 text-indigo-600 shrink-0" />
            <span className="text-xs font-medium text-indigo-800 shrink-0">Trace ghost SKU:</span>
            <Input
              type="text"
              placeholder="e.g. ULT-PSS-1 or ult-pss (partial)"
              value={locateSku}
              onChange={(e) => setLocateSku(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') locateSkuAcrossCollections(); }}
              className="h-8 text-xs w-64 bg-white"
              data-testid="pns-locate-input"
            />
            <Button
              size="sm"
              onClick={locateSkuAcrossCollections}
              disabled={locating || !locateSku.trim()}
              className="bg-indigo-600 hover:bg-indigo-700 text-white h-8"
              data-testid="pns-locate-btn"
            >
              {locating ? <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Search className="w-3.5 h-3.5 mr-1" />}
              Locate
            </Button>

            {/* Divider */}
            <span className="text-indigo-300">|</span>

            {/* Bulk Ghost Sweep — scans EVERY orphan across products/tiles/sync_staging */}
            <Button
              size="sm"
              onClick={runGhostSweep}
              disabled={sweepRunning}
              className="bg-rose-600 hover:bg-rose-700 text-white h-8"
              data-testid="pns-ghost-sweep-btn"
              title="Scan products, tiles, and sync_staging for rows whose SKU has NO matching Supplier Product. Then bulk-purge in one click."
            >
              {sweepRunning ? <RefreshCw className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Ghost className="w-3.5 h-3.5 mr-1" />}
              Sweep all ghosts
            </Button>
            {locateResult && (
              <span className="text-[11px] text-indigo-700">
                {locateResult.found === 0
                  ? `No matches for "${locateResult.sku}"`
                  : `Found in ${locateResult.found} record${locateResult.found === 1 ? '' : 's'}`}
              </span>
            )}
            {locateResult && (
              <button
                type="button"
                onClick={() => { setLocateSku(''); setLocateResult(null); }}
                className="text-[11px] text-indigo-500 hover:text-indigo-800 underline"
                data-testid="pns-locate-clear"
              >
                clear
              </button>
            )}
          </div>

          {locateResult && locateResult.found > 0 && (
            <div className="bg-white border border-indigo-200 rounded-lg overflow-hidden" data-testid="pns-locate-results">
              <table className="w-full text-xs">
                <thead className="bg-indigo-50 border-b border-indigo-200">
                  <tr className="text-left text-indigo-800">
                    <th className="px-3 py-2 font-medium w-32">Collection</th>
                    <th className="px-3 py-2 font-medium">Name / product_name</th>
                    <th className="px-3 py-2 font-medium">Supplier</th>
                    <th className="px-3 py-2 font-medium text-right w-40">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {locateResult.locations.map((loc, idx) => (
                    <tr key={`${loc.collection}-${loc.id}-${idx}`} data-testid={`pns-locate-row-${loc.collection}`}>
                      <td className="px-3 py-2 font-mono text-[11px] text-indigo-700">
                        {loc.collection}
                        {loc.collection === 'supplier_products' && (
                          <div className="text-[10px] text-emerald-600">source of truth</div>
                        )}
                        {loc.collection === 'products' && (
                          <div className="text-[10px] text-orange-600">EPOS + main products</div>
                        )}
                        {loc.collection === 'tiles' && (
                          <div className="text-[10px] text-blue-600">Website storefront</div>
                        )}
                        {loc.collection === 'sync_staging' && (
                          <div className="text-[10px] text-purple-600">CSV import staging</div>
                        )}
                        {loc.collection === 'custom_mappings' && (
                          <div className="text-[10px] text-pink-600">Name override rule</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-slate-800">{loc.product_name || loc.name || <span className="text-gray-300">—</span>}</div>
                        {loc.supplier_product_name && loc.supplier_product_name !== loc.name && (
                          <div className="text-[10px] text-gray-500">supplier: {loc.supplier_product_name}</div>
                        )}
                        <div className="text-[10px] text-gray-400 font-mono">id: {loc.id}</div>
                      </td>
                      <td className="px-3 py-2 text-slate-600">{loc.supplier || <span className="text-gray-300">—</span>}</td>
                      <td className="px-3 py-2 text-right">
                        {loc.collection === 'supplier_products' ? (
                          <span className="text-[10px] text-gray-400 italic">delete via Supplier Products</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => purgeFromCollection(locateResult.sku, loc.collection)}
                            disabled={!!purging[loc.collection]}
                            className="h-7 text-[11px] border-red-500 text-red-700 hover:bg-red-50"
                            data-testid={`pns-purge-${loc.collection}`}
                          >
                            {purging[loc.collection]
                              ? <RefreshCw className="w-3 h-3 animate-spin" />
                              : <><Trash2 className="w-3 h-3 mr-1" />Delete from {loc.collection}</>}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Ghost Sweep results — bulk orphan cleanup across products/tiles/sync_staging */}
          {sweepResult && (
            <div className="bg-white border-2 border-rose-200 rounded-lg overflow-hidden" data-testid="pns-ghost-sweep-results">
              <div className="bg-rose-50 border-b border-rose-200 px-3 py-2 flex items-center gap-3 flex-wrap">
                <Ghost className="w-4 h-4 text-rose-600" />
                <span className="text-xs font-semibold text-rose-800">
                  Ghost sweep — {sweepResult.total_ghosts} orphan row{sweepResult.total_ghosts === 1 ? '' : 's'} across{' '}
                  {(sweepResult.per_collection?.products || 0)} products •{' '}
                  {(sweepResult.per_collection?.tiles || 0)} tiles •{' '}
                  {(sweepResult.per_collection?.sync_staging || 0)} sync_staging
                </span>
                <span className="text-[10px] text-rose-600">
                  (compared against {sweepResult.supplier_skus_seen} live Supplier SKUs)
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={toggleSweepAll}
                    disabled={sweepResult.rows.length === 0}
                    className="h-7 text-[11px]"
                    data-testid="pns-ghost-toggle-all"
                  >
                    {sweepSelected.size === sweepResult.rows.length && sweepResult.rows.length > 0 ? 'Deselect all' : `Select all ${sweepResult.rows.length}`}
                  </Button>
                  <Button
                    size="sm"
                    onClick={saveEditedGhosts}
                    disabled={ghostSaving || editedGhostItems.length === 0}
                    className="bg-blue-600 hover:bg-blue-700 text-white h-7 text-[11px]"
                    data-testid="pns-ghost-save-edited"
                    title="Save every ghost name you've edited below (fixes the record without deleting it)"
                  >
                    {ghostSaving ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <Save className="w-3 h-3 mr-1" />}
                    Save edited ({editedGhostItems.length})
                  </Button>
                  <Button
                    size="sm"
                    onClick={adoptSelectedGhosts}
                    disabled={ghostAdopting || sweepSelected.size === 0}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white h-7 text-[11px]"
                    data-testid="pns-ghost-adopt-selected"
                    title="Copy the selected ghost rows into Supplier Products so they become proper managed products"
                  >
                    {ghostAdopting ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <ShieldCheck className="w-3 h-3 mr-1" />}
                    Adopt selected ({sweepSelected.size})
                  </Button>
                  <Button
                    size="sm"
                    onClick={bulkPurgeGhosts}
                    disabled={sweepPurging || sweepSelected.size === 0}
                    className="bg-red-600 hover:bg-red-700 text-white h-7 text-[11px]"
                    data-testid="pns-ghost-bulk-purge"
                  >
                    {sweepPurging ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <Trash2 className="w-3 h-3 mr-1" />}
                    Purge selected ({sweepSelected.size})
                  </Button>
                  <button
                    type="button"
                    onClick={() => { setSweepResult(null); setSweepSelected(new Set()); }}
                    className="text-[11px] text-rose-500 hover:text-rose-800 underline"
                    data-testid="pns-ghost-clear"
                  >
                    dismiss
                  </button>
                </div>
              </div>
              {sweepResult.rows.length === 0 ? (
                <div className="p-6 text-center text-sm text-emerald-600" data-testid="pns-ghost-empty">
                  <ShieldCheck className="w-8 h-8 mx-auto mb-1" />
                  No ghost rows detected — every EPOS / Website / staging record maps to a live Supplier Product. Nice.
                </div>
              ) : (
                <div className="max-h-[400px] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 border-b border-gray-200 sticky top-0">
                      <tr className="text-left text-gray-500">
                        <th className="px-2 py-2 font-medium w-8">
                          <input
                            type="checkbox"
                            checked={sweepSelected.size === sweepResult.rows.length && sweepResult.rows.length > 0}
                            onChange={toggleSweepAll}
                            className="cursor-pointer"
                            data-testid="pns-ghost-header-check"
                          />
                        </th>
                        <th className="px-2 py-2 font-medium w-32">Collection</th>
                        <th className="px-2 py-2 font-medium w-32">SKU</th>
                        <th className="px-2 py-2 font-medium">Name in that collection (edit &amp; save)</th>
                        <th className="px-2 py-2 font-medium w-32">Supplier tag</th>
                        <th className="px-2 py-2 font-medium w-32">Updated</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {sweepResult.rows.map((r, idx) => {
                        const k = `${r.collection}|${r.sku}`;
                        const checked = sweepSelected.has(k);
                        return (
                          <tr key={`${k}-${idx}`} className={checked ? 'bg-rose-50' : ''} data-testid={`pns-ghost-row-${r.sku}`}>
                            <td className="px-2 py-1.5">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleSweepRow(r.collection, r.sku)}
                                className="cursor-pointer"
                                data-testid={`pns-ghost-check-${r.sku}`}
                              />
                            </td>
                            <td className="px-2 py-1.5 font-mono text-[11px]">
                              {r.collection === 'products' && <span className="text-orange-700">products</span>}
                              {r.collection === 'tiles' && <span className="text-blue-700">tiles</span>}
                              {r.collection === 'sync_staging' && <span className="text-purple-700">sync_staging</span>}
                            </td>
                            <td className="px-2 py-1.5 font-mono text-[11px] text-slate-700">{r.sku}</td>
                            <td className="px-2 py-1.5 text-slate-800">
                              <Input
                                value={ghostEdits[k] ?? (r.name || r.product_name || '')}
                                onChange={(e) => setGhostEdits(prev => ({ ...prev, [k]: e.target.value }))}
                                placeholder="— empty —"
                                className="h-7 text-xs"
                                data-testid={`pns-ghost-name-${r.sku}`}
                              />
                              {ghostEdits[k] !== undefined && ghostEdits[k].trim() !== (r.name || r.product_name || '').trim() && (
                                <div className="text-[10px] text-blue-600 mt-0.5" data-testid={`pns-ghost-edited-${r.sku}`}>
                                  edited — was: {(r.name || r.product_name) || '—'}
                                </div>
                              )}
                              {r.supplier_product_name && r.supplier_product_name !== r.name && (
                                <div className="text-[10px] text-gray-500">supplier: {r.supplier_product_name}</div>
                              )}
                            </td>
                            <td className="px-2 py-1.5 text-slate-600 text-[11px]">{r.supplier || <span className="text-gray-300">—</span>}</td>
                            <td className="px-2 py-1.5 text-[10px] text-gray-500">{(r.updated_at || '').slice(0, 10)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
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
                    <th className="px-3 py-2 font-medium text-sky-700">Supplier name</th>
                    <th className="px-3 py-2 font-medium w-56">Issues</th>
                    <th className="px-3 py-2 font-medium w-48">Fields</th>
                    <th className="px-3 py-2 font-medium min-w-[320px]">New name (edit &amp; save)</th>
                    <th className="px-3 py-2 font-medium text-right w-40">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {visibleRows.map(row => {
                    const busy = !!rowSaving[row.sku];
                    const currentEdit = suggestedEdits[row.sku] ?? row.product_name;
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
                        <td className="px-3 py-2 align-top" data-testid={`pns-suppliername-${row.sku}`}>
                          {row.supplier_name && row.supplier_name !== row.product_name ? (
                            <div className="flex items-start gap-1.5">
                              <span className="text-sky-800/70 italic">{row.supplier_name}</span>
                              <button
                                onClick={() => setSuggestedEdits(prev => ({ ...prev, [row.sku]: row.supplier_name }))}
                                className="flex-shrink-0 mt-0.5 text-sky-500 hover:text-sky-700"
                                title="Copy supplier name into New Name so you can edit it"
                                data-testid={`pns-use-supplier-${row.sku}`}
                              >
                                <Copy className="w-3 h-3" />
                              </button>
                            </div>
                          ) : row.supplier_name ? (
                            <span className="text-gray-300">same as ours</span>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
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
                          <div className="flex items-center gap-1">
                            <Input
                              value={currentEdit}
                              onChange={(e) => setSuggestedEdits(prev => ({ ...prev, [row.sku]: e.target.value }))}
                              className="h-9 text-sm"
                              data-testid={`pns-suggest-${row.sku}`}
                            />
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
                        <td className="px-3 py-2 text-right whitespace-nowrap align-top">
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
        </div>

        {/* Footer hint */}
        <div className="text-[11px] text-gray-500 flex items-center gap-2 justify-center py-2 border-t border-gray-200 bg-white">
          <Wand2 className="w-3 h-3" />
          Edit any name directly and click <b>Save</b> — nothing changes until you save. The <Wand2 className="w-3 h-3 inline text-violet-500" /> button loads the auto-suggestion (built from <code>product_name + color + size + finish</code>) if you want it.
        </div>
        </>
        )}
      </div>
    </div>
  );
};

export default NameSanityDrawer;
