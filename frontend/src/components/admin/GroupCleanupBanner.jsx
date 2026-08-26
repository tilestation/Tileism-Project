import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, ArrowRight, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const GROUP_LABELS = {
  tiles: 'Tiles',
  flooring: 'Flooring',
  materials: 'Materials',
  'underfloor-heating': 'Underfloor Heating',
  bathroom: 'Bathroom',
  'tools-accessories': 'Tools & Accessories',
};

export const GroupCleanupBanner = ({ onApplied }) => {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(new Set());
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/group-cleanup/mismatches`);
      if (!res.ok) return;
      const d = await res.json();
      setData(d);
      setChecked(new Set((d.items || []).map(i => i.sku)));
    } catch { /* silent — banner simply won't show */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!data || data.total === 0) return null;
  const items = data.items || [];

  const toggle = (sku) => setChecked(prev => {
    const next = new Set(prev);
    if (next.has(sku)) next.delete(sku); else next.add(sku);
    return next;
  });

  const apply = async () => {
    const selected = items.filter(i => checked.has(i.sku));
    if (!selected.length) return;
    setApplying(true);
    try {
      const res = await fetch(`${API_URL}/api/group-cleanup/reassign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: selected.map(i => ({ sku: i.sku, target_group: i.suggested_group })) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`${selected.length} product${selected.length !== 1 ? 's' : ''} moved to the right category`);
      setOpen(false);
      await load();
      if (onApplied) onApplied();
    } catch (e) {
      toast.error(`Re-assign failed: ${e.message}`);
    } finally {
      setApplying(false);
    }
  };

  const sections = {};
  items.forEach(i => {
    if (!sections[i.suggested_group]) sections[i.suggested_group] = [];
    sections[i.suggested_group].push(i);
  });

  return (
    <>
      <div
        data-testid="group-cleanup-banner"
        className="bg-amber-50 border border-amber-300 rounded-lg p-3 flex items-center gap-3 cursor-pointer hover:bg-amber-100 transition-colors"
        onClick={() => setOpen(true)}
      >
        <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0" />
        <div className="flex-1 text-sm text-amber-900">
          <span className="font-semibold">{data.total} product{data.total !== 1 ? 's' : ''}</span>
          {' '}look{data.total === 1 ? 's' : ''} like {data.total === 1 ? "it's" : "they're"} in the wrong category
          <span className="hidden sm:inline text-amber-700 ml-2 text-xs">Detected automatically from product names — review & fix in one sweep</span>
        </div>
        <span data-testid="group-cleanup-review-btn" className="text-xs font-semibold text-amber-800 underline underline-offset-2 whitespace-nowrap">
          Review & re-assign
        </span>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="group-cleanup-dialog" className="max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              Category clean-up — {data.total} suspected mismatch{data.total !== 1 ? 'es' : ''}
            </DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-4 pr-1">
            {Object.entries(sections).map(([grp, rows]) => (
              <div key={grp}>
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">
                  Move to {GROUP_LABELS[grp] || grp} <span className="text-gray-400 normal-case font-normal">({rows.length})</span>
                </div>
                <div className="border rounded-lg divide-y">
                  {rows.map(i => (
                    <label
                      key={i.sku}
                      data-testid={`group-cleanup-item-${i.sku}`}
                      className="flex items-center gap-3 p-2 hover:bg-gray-50 cursor-pointer"
                    >
                      <Checkbox checked={checked.has(i.sku)} onCheckedChange={() => toggle(i.sku)} />
                      {i.image
                        ? <img src={i.image} alt="" className="w-9 h-9 rounded object-cover flex-shrink-0" />
                        : <div className="w-9 h-9 rounded bg-gray-100 flex-shrink-0" />}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{i.name}</div>
                        <div className="text-[11px] text-gray-500 truncate">{i.sku} · {i.reason}</div>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs whitespace-nowrap">
                        <span className="px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200">
                          {GROUP_LABELS[i.current_group] || i.current_group}
                        </span>
                        <ArrowRight className="w-3 h-3 text-gray-400" />
                        <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                          {GROUP_LABELS[i.suggested_group] || i.suggested_group}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between pt-3 border-t">
            <button
              type="button"
              data-testid="group-cleanup-toggle-all"
              className="text-xs text-gray-500 underline underline-offset-2"
              onClick={() => setChecked(checked.size === items.length ? new Set() : new Set(items.map(i => i.sku)))}
            >
              {checked.size === items.length ? 'Deselect all' : 'Select all'}
            </button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setOpen(false)} data-testid="group-cleanup-cancel-btn">Cancel</Button>
              <Button
                size="sm"
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                disabled={applying || checked.size === 0}
                onClick={apply}
                data-testid="group-cleanup-apply-btn"
              >
                {applying && <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1.5" />}
                Re-assign {checked.size} product{checked.size !== 1 ? 's' : ''}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default GroupCleanupBanner;
