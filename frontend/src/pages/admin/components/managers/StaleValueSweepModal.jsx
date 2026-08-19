/**
 * StaleValueSweepModal — one-click catalogue repair.
 * Scans for products whose finish/size/colour/material/made-in LIST disagrees
 * with the saved value, or whose website price differs from the admin List £,
 * then repairs everything (scalar wins, List £ wins) across all collections.
 */
import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';
import { Wrench, RefreshCw, CheckCircle, AlertTriangle } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const TYPE_LABELS = {
  array_mismatch: (f) => `${cap(f)} list disagrees with the saved ${f.replace('_', ' ')}`,
  missing_scalar: (f) => `${cap(f)} list set but no primary ${f.replace('_', ' ')}`,
  price_mismatch: () => 'Website price differs from List £',
};
const cap = (s) => s.replace('_', ' ').replace(/^./, c => c.toUpperCase());

export const StaleValueSweepModal = ({ open, onOpenChange, onSuccess }) => {
  const [scan, setScan] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [lastResult, setLastResult] = useState(null);

  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products/stale-value-scan`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setScan(await res.json());
    } catch (e) {
      toast.error(`Scan failed: ${e.message}`);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    if (open) { setLastResult(null); runScan(); }
  }, [open, runScan]);

  const runRepair = async () => {
    setRepairing(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products/stale-value-sweep`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setLastResult(d);
      toast.success(`Repaired ${d.fixed_products} product(s) across the whole catalogue`);
      onSuccess && onSuccess();
      runScan();
    } catch (e) {
      toast.error(`Repair failed: ${e.message}`);
    } finally {
      setRepairing(false);
    }
  };

  const issueCount = scan?.products_with_issues || 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto" data-testid="stale-sweep-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="w-5 h-5 text-amber-600" />
            Stale Value Sweep
          </DialogTitle>
          <p className="text-xs text-gray-500">
            Finds products whose finish/size/colour/material/made-in list disagrees with the saved value
            (leftovers from older saves), or whose website price differs from your List £ — and repairs the
            whole catalogue in one click. The saved value and your List £ always win.
          </p>
        </DialogHeader>

        {scanning ? (
          <p className="text-sm text-gray-400 text-center py-10">
            <RefreshCw className="w-5 h-5 mx-auto mb-2 animate-spin" /> Scanning the catalogue…
          </p>
        ) : !scan ? null : issueCount === 0 ? (
          <div className="text-center py-10" data-testid="sweep-clean">
            <CheckCircle className="w-10 h-10 mx-auto mb-2 text-emerald-500" />
            <p className="text-sm font-semibold text-gray-800">Catalogue is clean</p>
            <p className="text-xs text-gray-500">No stale lists or price mismatches found.</p>
            {lastResult && (
              <p className="text-xs text-emerald-600 mt-2">
                Just repaired {lastResult.fixed_products} product(s) — {lastResult.fixes.array_mismatch} stale lists,{' '}
                {lastResult.fixes.missing_scalar} missing primaries, {lastResult.fixes.price_mismatch} price mismatches.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2 flex items-center gap-2" data-testid="sweep-summary">
              <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
              <span className="text-sm text-amber-900 font-semibold">{issueCount} product(s) need repair</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(scan.summary).map(([key, count]) => {
                const [type, field] = key.split(':');
                const label = TYPE_LABELS[type] ? TYPE_LABELS[type](field) : key;
                return (
                  <Badge key={key} variant="outline" className="text-[11px] bg-white" data-testid={`sweep-badge-${key}`}>
                    {label}: <b className="ml-1">{count}</b>
                  </Badge>
                );
              })}
            </div>
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              <div className="px-3 py-1.5 bg-gray-50 border-b text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                Examples ({Math.min(scan.examples.length, issueCount)} of {issueCount})
              </div>
              <ul className="divide-y max-h-64 overflow-y-auto">
                {scan.examples.map((ex, i) => (
                  <li key={`${ex.sku}-${i}`} className="px-3 py-1.5 text-xs" data-testid={`sweep-example-${i}`}>
                    <span className="font-medium text-gray-800">{ex.name || ex.sku}</span>
                    <span className="text-gray-400 ml-1">{ex.supplier} · {ex.sku}</span>
                    <div className="text-[11px] text-gray-500">
                      {ex.issues.map((iss, j) => (
                        <div key={j}>
                          {iss.type === 'price_mismatch'
                            ? <>price £{iss.stale[0]} → <b className="text-emerald-700">£{iss.keep}</b> (List £)</>
                            : iss.type === 'missing_scalar'
                              ? <>{iss.field}: empty → <b className="text-emerald-700">{iss.keep}</b></>
                              : <>{iss.field} list [{iss.stale.join(', ')}] → <b className="text-emerald-700">[{iss.keep}]</b></>}
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={runScan} disabled={scanning || repairing} data-testid="sweep-rescan-btn">
            <RefreshCw className={`w-4 h-4 mr-1 ${scanning ? 'animate-spin' : ''}`} /> Re-scan
          </Button>
          <Button
            size="sm"
            onClick={runRepair}
            disabled={scanning || repairing || issueCount === 0}
            className="bg-amber-600 hover:bg-amber-700 text-white"
            data-testid="sweep-repair-btn"
          >
            {repairing ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Wrench className="w-4 h-4 mr-1" />}
            Repair {issueCount > 0 ? `all ${issueCount}` : ''} product(s)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default StaleValueSweepModal;
