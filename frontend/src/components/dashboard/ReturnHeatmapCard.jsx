import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Card, CardContent } from '../ui/card';
import { RotateCcw, AlertTriangle, Package, Truck, Loader2 } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

/**
 * Return Heatmap — shows the products and suppliers driving returns over a
 * trailing window. Aggregates both:
 *   1. New per-line returns inside invoices (Return checkbox shipped Feb 26)
 *   2. Full refunds processed via the Refund page
 * The 30-day window is intentional — long enough to be statistically real,
 * short enough that a fix lands and the chart visibly cools off.
 */
const WINDOWS = [
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
];

const fmtGBP = (n) => `£${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

const ReturnHeatmapCard = () => {
  const { token, user } = useAuth();
  const isAdminish = ['super_admin', 'admin', 'manager'].includes(user?.role);

  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token || !isAdminish) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    axios
      .get(`${API}/analytics/return-heatmap`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { days, limit_products: 6, limit_suppliers: 4 },
      })
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((e) => { if (!cancelled) setError(e?.response?.data?.detail || 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, isAdminish, days]);

  if (!isAdminish) return null;

  const totals = data?.totals || { events: 0, units: 0, value: 0 };
  const products = data?.top_products || [];
  const suppliers = data?.top_suppliers || [];
  // For the mini bars: scale to the worst-offender so the eye reads relative pain.
  const maxProductValue = products.reduce((m, p) => Math.max(m, p.value_returned || 0), 0) || 1;
  const maxSupplierValue = suppliers.reduce((m, s) => Math.max(m, s.value_returned || 0), 0) || 1;

  // Subtle palette: pain scales red → amber → slate (low return). Pure data
  // colour, not a status — so we don't compete with the OFF AIR / DOWN reds.
  const rowAccent = (value) => {
    if (value <= 0 || maxProductValue === 0) return 'bg-slate-400';
    const ratio = value / maxProductValue;
    if (ratio > 0.66) return 'bg-rose-500';
    if (ratio > 0.33) return 'bg-amber-500';
    return 'bg-slate-400';
  };

  return (
    <Card
      className="bg-gradient-to-br from-rose-50/40 via-white to-amber-50/30 border-rose-100 hover:shadow-md transition-shadow"
      data-testid="dashboard-return-heatmap-card"
    >
      <CardContent className="p-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-md bg-rose-600/10 flex items-center justify-center">
              <RotateCcw className="w-4.5 h-4.5 text-rose-700" />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-rose-900/60 font-semibold">
                Return heatmap
              </p>
              <h3 className="text-base font-semibold text-foreground leading-tight">
                What's driving refunds
              </h3>
            </div>
          </div>
          {/* Window selector */}
          <div className="flex items-center gap-1 bg-white border rounded-md p-0.5 shadow-sm">
            {WINDOWS.map((w) => (
              <button
                key={w.value}
                type="button"
                onClick={() => setDays(w.value)}
                className={`text-xs px-2 py-1 rounded font-medium transition-colors ${
                  days === w.value
                    ? 'bg-rose-600 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
                data-testid={`return-heatmap-window-${w.value}`}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>

        {/* Totals strip */}
        <div className="grid grid-cols-3 gap-2 mb-4">
          <div className="bg-white border rounded-md px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">Returns</p>
            <p className="text-lg font-bold text-rose-700" data-testid="return-heatmap-total-events">
              {totals.events.toLocaleString('en-GB')}
            </p>
          </div>
          <div className="bg-white border rounded-md px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">Units</p>
            <p className="text-lg font-bold text-foreground">
              {Number(totals.units || 0).toLocaleString('en-GB', { maximumFractionDigits: 1 })}
            </p>
          </div>
          <div className="bg-white border rounded-md px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">Value</p>
            <p className="text-lg font-bold text-foreground">{fmtGBP(totals.value)}</p>
          </div>
        </div>

        {/* Loading / error / empty states */}
        {loading && (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Aggregating returns…
          </div>
        )}
        {!loading && error && (
          <div className="flex items-center gap-2 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded p-3">
            <AlertTriangle className="w-4 h-4" /> {String(error)}
          </div>
        )}
        {!loading && !error && totals.events === 0 && (
          <div className="text-center py-6 text-sm text-muted-foreground bg-emerald-50/40 border border-emerald-100 rounded-md">
            <p className="text-emerald-700 font-medium">🎉 No returns in the last {days} days.</p>
            <p className="text-xs text-emerald-700/70 mt-1">Customers are keeping what they buy.</p>
          </div>
        )}

        {/* Two-column body when we have data */}
        {!loading && !error && totals.events > 0 && (
          <div className="grid md:grid-cols-2 gap-4">
            {/* PRODUCTS */}
            <div>
              <div className="flex items-center gap-1.5 mb-2 text-xs uppercase tracking-wider text-slate-600 font-semibold">
                <Package className="w-3.5 h-3.5" /> Top products
              </div>
              <div className="space-y-1.5" data-testid="return-heatmap-products">
                {products.map((p) => {
                  const widthPct = Math.max(8, Math.round((p.value_returned / maxProductValue) * 100));
                  return (
                    <div
                      key={`${p.sku || p.product_name}`}
                      className="relative bg-white border rounded-md px-2.5 py-2 overflow-hidden"
                      data-testid={`return-heatmap-product-${p.sku || p.product_name}`}
                    >
                      {/* Background bar */}
                      <div
                        className={`absolute inset-y-0 left-0 ${rowAccent(p.value_returned)} opacity-15`}
                        style={{ width: `${widthPct}%` }}
                      />
                      <div className="relative flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground truncate" title={p.product_name}>
                            {p.product_name}
                          </p>
                          <p className="text-[10px] text-slate-500 font-mono truncate">
                            {p.sku || '—'} · {p.supplier_name}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-bold text-foreground">{fmtGBP(p.value_returned)}</p>
                          <p className="text-[10px] text-slate-500">
                            {p.units_returned}u
                            {p.return_rate_pct !== null && p.return_rate_pct !== undefined && (
                              <span className={`ml-1 font-semibold ${p.return_rate_pct >= 10 ? 'text-rose-600' : p.return_rate_pct >= 3 ? 'text-amber-600' : 'text-slate-500'}`}>
                                · {p.return_rate_pct}%
                              </span>
                            )}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* SUPPLIERS */}
            <div>
              <div className="flex items-center gap-1.5 mb-2 text-xs uppercase tracking-wider text-slate-600 font-semibold">
                <Truck className="w-3.5 h-3.5" /> Top suppliers
              </div>
              <div className="space-y-1.5" data-testid="return-heatmap-suppliers">
                {suppliers.map((s) => {
                  const widthPct = Math.max(8, Math.round((s.value_returned / maxSupplierValue) * 100));
                  return (
                    <div
                      key={s.supplier_name}
                      className="relative bg-white border rounded-md px-2.5 py-2 overflow-hidden"
                      data-testid={`return-heatmap-supplier-${s.supplier_name}`}
                    >
                      <div
                        className="absolute inset-y-0 left-0 bg-rose-500 opacity-15"
                        style={{ width: `${widthPct}%` }}
                      />
                      <div className="relative flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-foreground truncate" title={s.supplier_name}>
                          {s.supplier_name}
                        </p>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-bold text-foreground">{fmtGBP(s.value_returned)}</p>
                          <p className="text-[10px] text-slate-500">{s.events} event{s.events === 1 ? '' : 's'}</p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Helper note */}
        {!loading && !error && totals.events > 0 && (
          <p className="text-[10px] text-slate-400 mt-3 leading-snug">
            Includes per-line returns inside invoices and standalone refunds. Return %
            is units returned ÷ units sold in the same window.
          </p>
        )}
      </CardContent>
    </Card>
  );
};

export default ReturnHeatmapCard;
