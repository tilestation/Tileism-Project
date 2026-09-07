/**
 * LivePricingStatus — answers "is what I see here what the website shows?"
 * for the products selected in the Pricing hub. Compares the admin draft
 * (supplier_products) with the live tile (tiles) via /live-pricing and offers
 * a one-click "Push to website" (/push-live-pricing) when they differ.
 * Also carries the plain-English legend of which setting drives what.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../components/ui/button';
import { CheckCircle2, AlertTriangle, RefreshCw, Globe, ChevronDown, ChevronRight, HelpCircle, Upload } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const GROUP_LABEL = { price: 'Now £', sale: 'Sale / Was £', clearance: 'Clearance', labels: 'Labels', pallets: 'Pallets', delivery: 'Delivery', tiers: 'Tiers / trade' };

const money = (v) => (v === null || v === undefined || v === '' ? '—' : `£${Number(v).toFixed(2)}`);
const describe = (group, v) => {
  if (!v || Object.keys(v).length === 0) return '—';
  switch (group) {
    case 'price': return money(v.price);
    case 'sale': return v.sale_active ? `SALE · was ${money(v.was_price)}` : 'no sale';
    case 'clearance': return v.clearance ? 'CLEARANCE' : 'not clearance';
    case 'labels': return (v.labels || []).join(', ') || 'none';
    case 'pallets': return v.pallet_enabled ? `${v.pallet_only ? 'PALLET ONLY · ' : ''}full ${v.m2_per_pallet ?? '?'} @ ${money(v.pallet_price)}${v.half_pallet_price ? ` · half ${money(v.half_pallet_price)}` : ''}` : 'no pallets';
    case 'delivery': return `${v.delivery_charge_required ? `delivery ${money(v.delivery_charge)}` : 'no delivery £'}${v.parcel_delivery ? ' · parcel' : ''}`;
    case 'tiers': return v.tier_pricing_disabled ? 'tiers off' : `tiers ${(v.tier_thresholds || []).join('/') || 'default'} · trade ${v.trade_discount ?? '—'}${v.trade_discount_type === 'fixed' ? '£' : '%'}`;
    default: return '';
  }
};

export const LEGEND = [
  ['Now £', 'the price customers pay (per m² or per unit)'],
  ['Was £ + SALE', 'crossed-out price, red SALE badge and % saved'],
  ['CLEARANCE', 'flashing clearance badge, Clearance page and leaflet'],
  ['Pallets', 'Half / Full pallet chips on the product page; Pallet only hides per-m² buying'],
  ['Delivery £', 'mandatory delivery charge added at checkout; Parcel = parcel rate'],
  ['Tiers / Trade', 'quantity price breaks and the trade discount on the product page'],
  ['Cost £ & Stock', 'admin only — never shown to customers'],
];

const LivePricingStatus = ({ selectedList = [], refreshKey = 0 }) => {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [open, setOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);

  const skus = selectedList.map(p => p.sku || p.supplier_code).filter(Boolean);
  const skuKey = skus.join(',');

  const load = useCallback(async () => {
    if (!skuKey) { setReport(null); return; }
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products/live-pricing?skus=${encodeURIComponent(skuKey)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setReport(await res.json());
    } catch (err) {
      setReport({ error: err.message });
    } finally {
      setLoading(false);
    }
  }, [skuKey]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const push = async () => {
    const bad = (report?.items || []).filter(i => i.mismatches.length).map(i => i.sku);
    if (!bad.length) return;
    setPushing(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products/push-live-pricing`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skus: bad }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      toast.success(d.message || 'Website pricing re-synced');
      await load();
    } catch (err) {
      toast.error(`Push failed: ${err.message}`);
    } finally {
      setPushing(false);
    }
  };

  const items = report?.items || [];
  const mismatched = items.filter(i => i.mismatches.length);
  const notLive = items.filter(i => !i.live);
  const ok = !loading && report && !report.error && mismatched.length === 0;

  return (
    <div className="space-y-1.5" data-testid="live-pricing-status">
      <div className={`rounded-lg border px-3 py-2 text-xs flex items-center gap-2 flex-wrap ${ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : mismatched.length ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-slate-50 border-slate-200 text-slate-700'}`}>
        <Globe className="w-4 h-4 flex-shrink-0" />
        {loading && <span className="inline-flex items-center gap-1" data-testid="live-pricing-loading"><RefreshCw className="w-3 h-3 animate-spin" /> Checking what the website shows…</span>}
        {!loading && report?.error && <span>Couldn't check the website: {report.error}</span>}
        {ok && (
          <span className="inline-flex items-center gap-1 font-medium" data-testid="live-pricing-ok">
            <CheckCircle2 className="w-3.5 h-3.5" /> Website matches these settings for {items.length - notLive.length} live product{items.length - notLive.length !== 1 ? 's' : ''}
            {notLive.length > 0 && <span className="font-normal text-slate-600"> · {notLive.length} not published yet (nothing to show until you publish)</span>}
          </span>
        )}
        {!loading && mismatched.length > 0 && (
          <>
            <span className="font-semibold inline-flex items-center gap-1" data-testid="live-pricing-mismatch">
              <AlertTriangle className="w-3.5 h-3.5" /> {mismatched.length} product{mismatched.length !== 1 ? 's' : ''} show something different on the website
            </span>
            <button type="button" onClick={() => setOpen(v => !v)} className="underline decoration-dotted" data-testid="live-pricing-toggle">
              {open ? 'hide' : 'show what differs'}
            </button>
            <Button size="sm" onClick={push} disabled={pushing} className="ml-auto h-7 text-xs bg-amber-600 hover:bg-amber-700 text-white" data-testid="live-pricing-push">
              {pushing ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <Upload className="w-3 h-3 mr-1" />} Push these settings to the website
            </Button>
          </>
        )}
        {!loading && !report?.error && (
          <button type="button" onClick={() => setLegendOpen(v => !v)} className={`${mismatched.length ? '' : 'ml-auto'} inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800`} data-testid="live-pricing-legend-toggle">
            <HelpCircle className="w-3.5 h-3.5" /> what reaches the website?
          </button>
        )}
      </div>

      {open && mismatched.length > 0 && (
        <div className="border border-amber-200 rounded-lg overflow-hidden" data-testid="live-pricing-diff">
          <table className="w-full text-[11px]">
            <thead className="bg-amber-50 text-amber-900">
              <tr><th className="text-left px-2 py-1 font-medium">Product</th><th className="text-left px-2 py-1 font-medium">Setting</th><th className="text-left px-2 py-1 font-medium">Here (admin)</th><th className="text-left px-2 py-1 font-medium">Website now</th></tr>
            </thead>
            <tbody>
              {mismatched.flatMap(i => i.mismatches.map((g, idx) => (
                <tr key={`${i.sku}-${g}`} className="border-t border-amber-100" data-testid={`live-diff-${i.sku}-${g}`}>
                  <td className="px-2 py-1 font-mono text-gray-700">{idx === 0 ? i.sku : ''}</td>
                  <td className="px-2 py-1 text-gray-700">{GROUP_LABEL[g] || g}</td>
                  <td className="px-2 py-1 text-emerald-800 font-medium">{describe(g, i.admin)}</td>
                  <td className="px-2 py-1 text-rose-700">{describe(g, i.website)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}

      {legendOpen && (
        <div className="border border-slate-200 rounded-lg p-2.5 bg-white grid sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px]" data-testid="live-pricing-legend">
          {LEGEND.map(([k, v]) => (
            <div key={k} className="flex gap-1.5"><span className="font-semibold text-slate-800 whitespace-nowrap">{k}</span><span className="text-slate-600">— {v}</span></div>
          ))}
          <div className="sm:col-span-2 text-slate-500 pt-1 border-t border-slate-100 mt-1">Saves reach the website within about a minute (page cache). Only published products appear on the website.</div>
        </div>
      )}
    </div>
  );
};

export default LivePricingStatus;
