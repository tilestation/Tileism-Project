/**
 * SitePricingScan — one click: "does the website show the same prices, sale,
 * clearance, pallets, delivery and tiers as the admin — for EVERY live product?"
 * GET  /products/live-pricing/scan   → per-group counts + the differing products
 * POST /products/live-pricing/fix-all → pushes the admin values onto every tile
 * Used on the dashboard (Data Health card) and inside the Pricing hub strip.
 */
import React, { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../components/ui/button';
import { Globe, RefreshCw, CheckCircle2, AlertTriangle, Upload, ChevronDown, ChevronRight } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const GROUP_LABEL = { price: 'Now £', sale: 'Sale / Was £', clearance: 'Clearance', labels: 'Labels', pallets: 'Pallets', delivery: 'Delivery', tiers: 'Tiers / trade' };
const money = (v) => (v === null || v === undefined || v === '' ? '—' : `£${Number(v).toFixed(2)}`);
const describe = (g, v = {}) => ({
  price: money(v.price),
  sale: v.sale_active ? `SALE · was ${money(v.was_price)}` : 'no sale',
  clearance: v.clearance ? 'CLEARANCE' : 'not clearance',
  labels: (v.labels || []).join(', ') || 'none',
  pallets: v.pallet_enabled ? `${v.pallet_only ? 'PALLET ONLY · ' : ''}full ${v.m2_per_pallet ?? '?'} @ ${money(v.pallet_price)}` : 'no pallets',
  delivery: `${v.delivery_charge_required ? `delivery ${money(v.delivery_charge)}` : 'no delivery £'}${v.parcel_delivery ? ' · parcel' : ''}`,
  tiers: v.tier_pricing_disabled ? 'tiers off' : `tiers ${(v.tier_thresholds || []).join('/') || 'default'} · trade ${v.trade_discount ?? '—'}`,
}[g] || '');

const SitePricingScan = ({ compact = false }) => {
  const [scan, setScan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [open, setOpen] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products/live-pricing/scan?limit=300`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setScan(await res.json());
    } catch (err) {
      toast.error(`Scan failed: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const fixAll = async () => {
    setFixing(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products/live-pricing/fix-all`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      toast.success(d.message);
      await run();
    } catch (err) {
      toast.error(`Fix failed: ${err.message}`);
    } finally {
      setFixing(false);
    }
  };

  const fixable = (scan?.items || []).filter(i => i.fixable).length;
  const tone = !scan ? 'bg-slate-50 border-slate-200 text-slate-700' : scan.mismatch_count === 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-amber-50 border-amber-300 text-amber-900';

  return (
    <div className={`rounded-xl border ${tone} ${compact ? 'px-3 py-2' : 'px-4 py-3'} text-xs space-y-2`} data-testid="site-pricing-scan">
      <div className="flex items-center gap-2 flex-wrap">
        <Globe className="w-4 h-4 flex-shrink-0" />
        {!scan && <span className="font-medium">Whole-website pricing check — is every live product showing what the admin says?</span>}
        {scan && scan.mismatch_count === 0 && (
          <span className="font-medium inline-flex items-center gap-1" data-testid="site-scan-ok"><CheckCircle2 className="w-3.5 h-3.5" /> Website matches admin pricing on all {scan.checked} live products</span>
        )}
        {scan && scan.mismatch_count > 0 && (
          <span className="font-semibold inline-flex items-center gap-1" data-testid="site-scan-mismatch">
            <AlertTriangle className="w-3.5 h-3.5" /> {scan.mismatch_count} of {scan.checked} live products differ on the website
          </span>
        )}
        {scan && scan.no_draft > 0 && <span className="text-slate-500">· {scan.no_draft} live with no admin draft</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={run} disabled={busy || fixing} className="h-7 text-xs bg-white" data-testid="site-scan-run">
            {busy ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <Globe className="w-3 h-3 mr-1" />} {scan ? 'Re-scan' : 'Scan whole website'}
          </Button>
          {scan && fixable > 0 && (
            <Button size="sm" onClick={fixAll} disabled={fixing || busy} className="h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white" data-testid="site-scan-fix-all">
              {fixing ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <Upload className="w-3 h-3 mr-1" />} Fix all {fixable}
            </Button>
          )}
        </div>
      </div>

      {scan && scan.mismatch_count > 0 && (
        <>
          <div className="flex items-center gap-1.5 flex-wrap" data-testid="site-scan-groups">
            {Object.entries(scan.by_group).sort((a, b) => b[1] - a[1]).map(([g, n]) => (
              <span key={g} className="px-1.5 py-0.5 rounded bg-white border border-amber-200 text-amber-900">{GROUP_LABEL[g] || g}: <b>{n}</b></span>
            ))}
            {scan.no_admin_price > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-white border border-rose-200 text-rose-800" title="These products sell on the website but have no Now £ in the admin — set a price in the manager to fix them">
                {scan.no_admin_price} with no admin price (set one in the manager)
              </span>
            )}
            <button type="button" onClick={() => setOpen(v => !v)} className="ml-auto inline-flex items-center gap-1 underline decoration-dotted" data-testid="site-scan-toggle">
              {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />} {open ? 'hide list' : 'show list'}
            </button>
          </div>
          {open && (
            <div className="max-h-64 overflow-auto border border-amber-200 rounded-lg bg-white" data-testid="site-scan-list">
              <table className="w-full text-[11px]">
                <thead className="bg-amber-50 text-amber-900 sticky top-0">
                  <tr><th className="text-left px-2 py-1 font-medium">Product</th><th className="text-left px-2 py-1 font-medium">Setting</th><th className="text-left px-2 py-1 font-medium">Admin</th><th className="text-left px-2 py-1 font-medium">Website now</th></tr>
                </thead>
                <tbody>
                  {scan.items.flatMap(i => i.mismatches.map((g, idx) => (
                    <tr key={`${i.sku}-${g}`} className="border-t border-amber-100" data-testid={`site-diff-${i.sku}-${g}`}>
                      <td className="px-2 py-1 text-gray-800">{idx === 0 ? <><span className="font-mono">{i.sku}</span> <span className="text-gray-500">{String(i.name).slice(0, 40)}</span></> : ''}</td>
                      <td className="px-2 py-1 text-gray-700">{GROUP_LABEL[g] || g}</td>
                      <td className="px-2 py-1 text-emerald-800 font-medium">{describe(g, i.admin)}</td>
                      <td className="px-2 py-1 text-rose-700">{describe(g, i.website)}</td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default SitePricingScan;
