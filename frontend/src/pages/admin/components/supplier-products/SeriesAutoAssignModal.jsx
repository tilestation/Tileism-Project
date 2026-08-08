/**
 * SeriesAutoAssignModal — one-click "group these products into series" tool.
 *
 * Workflow:
 *  1. Modal opens, calls GET /api/admin/series/auto-suggest?supplier=...
 *  2. Backend returns proposed buckets ({series, product_count, samples, skus})
 *  3. Admin can edit each series name inline (or tick/untick the whole bucket)
 *  4. Admin hits "Apply" → POST /api/admin/series/bulk-assign with the picked
 *     buckets. The parent then re-fetches products so the display groups by
 *     the new series names.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, X, Save, Layers, Sparkles, Wrench } from 'lucide-react';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const SeriesAutoAssignModal = ({ open, onClose, supplier = '', onApplied }) => {
  const [buckets, setBuckets] = useState([]);         // [{ series, product_count, samples, skus }]
  const [edits, setEdits] = useState({});             // { originalSeries: newName }
  const [checked, setChecked] = useState(() => new Set()); // originalSeries names that will be applied
  const [scanned, setScanned] = useState(0);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [healing, setHealing] = useState(false);
  const [onlyMissing, setOnlyMissing] = useState(true);

  const authHeaders = () => {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  const runSuggest = useCallback(async () => {
    setLoading(true);
    setBuckets([]);
    setEdits({});
    setChecked(new Set());
    try {
      const params = new URLSearchParams();
      if (supplier) params.set('supplier', supplier);
      params.set('only_missing', String(onlyMissing));
      const res = await fetch(`${API_URL}/api/admin/series/auto-suggest?${params}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setBuckets(data.buckets || []);
      setScanned(data.total_scanned || 0);
      // Auto-select every bucket that has 2+ products (single-product buckets
      // often mean noise — leave them for the admin to opt-in explicitly).
      setChecked(new Set((data.buckets || []).filter((b) => b.product_count >= 2).map((b) => b.series)));
    } catch (err) {
      toast.error(`Auto-suggest failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, [supplier, onlyMissing]);

  useEffect(() => {
    if (open) runSuggest();
  }, [open, runSuggest]);

  const toggleBucket = (series) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(series)) next.delete(series); else next.add(series);
      return next;
    });
  };

  const toggleAll = () => {
    if (checked.size === buckets.length) setChecked(new Set());
    else setChecked(new Set(buckets.map((b) => b.series)));
  };

  const applyPicks = async () => {
    const selectedBuckets = buckets.filter((b) => checked.has(b.series));
    const totalRows = selectedBuckets.reduce((s, b) => s + b.product_count, 0);
    if (totalRows === 0) { toast.info('Select at least one bucket to apply'); return; }
    if (!window.confirm(`Apply the ${selectedBuckets.length} selected series group(s) to ${totalRows} product(s)?\n\nEach affected row's range_name will be set. This is logged and can be re-run if needed.`)) return;
    setApplying(true);
    try {
      const items = [];
      for (const b of selectedBuckets) {
        const finalName = (edits[b.series] ?? b.series).trim() || b.series;
        for (const sku of b.skus) if (sku) items.push({ sku, series: finalName });
      }
      const res = await fetch(`${API_URL}/api/admin/series/bulk-assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ items, supplier: supplier || null }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      toast.success(`Assigned ${data.updated} product${data.updated === 1 ? '' : 's'} into ${selectedBuckets.length} series${selectedBuckets.length === 1 ? '' : 'es'}${data.failed?.length ? ` (${data.failed.length} skipped)` : ''}`, { duration: 6000 });
      onApplied?.();
      onClose();
    } catch (err) {
      toast.error(`Apply failed: ${err.message}`);
    } finally {
      setApplying(false);
    }
  };

  const healDrift = async () => {
    const scope = supplier ? `in ${supplier}` : 'across every supplier';
    if (!window.confirm(`Scan the DB for legacy junk in the "unique_name" field ${scope} — anything that looks like a full product name (has " - ", is > 60 chars, or has dimension tokens like 60x60cm / 15kg / 1L) gets replaced with a clean parsed series name.\n\nThis is idempotent and safe to re-run.`)) return;
    setHealing(true);
    try {
      const params = new URLSearchParams();
      if (supplier) params.set('supplier', supplier);
      const res = await fetch(`${API_URL}/api/admin/series/heal-drift?${params}`, {
        method: 'POST',
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      toast.success(`Healed ${data.healed} product${data.healed === 1 ? '' : 's'} across ${Object.keys(data.per_supplier || {}).length} supplier${Object.keys(data.per_supplier || {}).length === 1 ? '' : 's'} (scanned ${data.scanned})`, { duration: 6000 });
      onApplied?.();
      runSuggest();
    } catch (err) {
      toast.error(`Heal failed: ${err.message}`);
    } finally {
      setHealing(false);
    }
  };

  if (!open) return null;

  const totalPicked = buckets.filter((b) => checked.has(b.series)).reduce((s, b) => s + b.product_count, 0);

  return (
    <div
      className="fixed inset-0 z-[85] flex items-start justify-center bg-black/40 backdrop-blur-sm pt-12 px-4"
      onClick={onClose}
      data-testid="series-auto-modal"
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-200 bg-gradient-to-r from-purple-50 to-indigo-50">
          <Sparkles className="w-5 h-5 text-purple-600" />
          <div className="flex-1">
            <h2 className="text-base font-bold text-slate-900">Auto-Assign Series</h2>
            <p className="text-[11px] text-slate-500">
              Parses <code>product_name</code>{supplier ? ` for ${supplier}` : ' across every supplier'} and proposes series buckets. Tick, edit inline, then Apply.
            </p>
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer" title="If ticked, products that already have a range_name set are left alone">
            <input
              type="checkbox"
              checked={onlyMissing}
              onChange={(e) => setOnlyMissing(e.target.checked)}
              data-testid="series-only-missing"
            />
            Skip already-assigned
          </label>
          <Button variant="outline" size="sm" onClick={runSuggest} disabled={loading} data-testid="series-rescan">
            <RefreshCw className={`w-4 h-4 mr-1 ${loading ? 'animate-spin' : ''}`} /> Rescan
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={healDrift}
            disabled={healing || loading}
            className="border-amber-500 text-amber-700 hover:bg-amber-50"
            data-testid="series-heal-btn"
            title="Scrub legacy junk in unique_name fields — replaces any value that looks like a full product name with a clean parsed series across every product"
          >
            {healing ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Wrench className="w-4 h-4 mr-1" />}
            Heal drift
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}><X className="w-4 h-4" /></Button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="text-center py-16 text-gray-400 text-sm">
              <RefreshCw className="w-6 h-6 mx-auto animate-spin mb-2" /> Detecting series…
            </div>
          ) : buckets.length === 0 ? (
            <div className="text-center py-16 text-gray-400 text-sm">
              <Layers className="w-6 h-6 mx-auto mb-2 text-gray-300" />
              No series could be detected. Either every product already has a series or names are too short to parse.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3 text-xs text-gray-500">
                <span>Scanned {scanned} products → detected {buckets.length} series bucket{buckets.length === 1 ? '' : 's'}</span>
                <button type="button" onClick={toggleAll} className="text-indigo-600 hover:text-indigo-800 underline" data-testid="series-toggle-all">
                  {checked.size === buckets.length ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <div className="space-y-2">
                {buckets.map((b) => {
                  const isChecked = checked.has(b.series);
                  return (
                    <div
                      key={b.series}
                      className={`border rounded-lg p-3 flex items-start gap-3 transition-colors ${isChecked ? 'border-purple-300 bg-purple-50' : 'border-gray-200 bg-white hover:bg-slate-50'}`}
                      data-testid={`series-bucket-${b.series}`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleBucket(b.series)}
                        className="mt-1 cursor-pointer"
                        data-testid={`series-bucket-check-${b.series}`}
                      />
                      <div className="flex-1 min-w-0">
                        <Input
                          value={edits[b.series] ?? b.series}
                          onChange={(e) => setEdits((prev) => ({ ...prev, [b.series]: e.target.value }))}
                          className="h-8 text-sm font-semibold"
                          data-testid={`series-edit-${b.series}`}
                        />
                        <div className="text-[11px] text-gray-500 mt-1">
                          <span className="font-medium text-slate-600">{b.product_count} product{b.product_count === 1 ? '' : 's'}</span>
                          {' · '}
                          <span className="italic">{b.samples.slice(0, 2).join(' • ')}{b.samples.length > 2 ? ` +${b.product_count - 2} more` : ''}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-200 bg-slate-50 px-5 py-3 flex items-center justify-between">
          <span className="text-xs text-slate-500">
            {totalPicked > 0
              ? `${totalPicked} product${totalPicked === 1 ? '' : 's'} across ${checked.size} bucket${checked.size === 1 ? '' : 's'} will be updated`
              : 'Tick a bucket to enable Apply'}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button
              onClick={applyPicks}
              disabled={applying || totalPicked === 0}
              className="bg-purple-600 hover:bg-purple-700 text-white"
              data-testid="series-apply-btn"
            >
              {applying ? <RefreshCw className="w-4 h-4 mr-1.5 animate-spin" /> : <Save className="w-4 h-4 mr-1.5" />}
              Apply {totalPicked ? `(${totalPicked})` : ''}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SeriesAutoAssignModal;
