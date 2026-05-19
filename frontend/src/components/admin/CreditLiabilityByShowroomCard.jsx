import React, { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { Loader2, RefreshCw, TrendingUp, AlertCircle, Store } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

/**
 * CreditLiabilityByShowroomCard
 * ─────────────────────────────
 * Reports → Sales widget added 24 Feb 2026.
 *
 * For each showroom shows: lifetime credit earned (issued), lifetime
 * redeemed (spent back), outstanding liability, and earn/redeem ratio.
 *
 * The earn/redeem ratio tells the operator whether a showroom is
 * generating credit liability faster than customers come back to
 * redeem it. Ratios < 0.5 are flagged amber ("dead inventory of
 * someone else's money"); > 1.0 (redeemed more than ever earned
 * there) is shown green ("net credit sink — customers travel here").
 *
 * Reads from `GET /api/invoices/credit-liability/by-showroom`. The
 * endpoint back-fills showroom_name from the linked invoice for any
 * legacy `credit_transactions` rows missing the field, so totals
 * are accurate even before 24 Feb 2026's stamping change reaches prod.
 */
const formatGBP = (n) => `£${(Number(n) || 0).toFixed(2)}`;

function RatioPill({ ratio }) {
  if (ratio == null) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-gray-100 text-gray-600 font-semibold">
        n/a
      </span>
    );
  }
  // Use a 3-tier band: <0.5 red (poor turnover), 0.5–1.0 amber, >1.0 green
  if (ratio < 0.5) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-rose-50 text-rose-700 border border-rose-200 font-semibold"
        title="Less than half of credit issued has been redeemed — slow turnover."
      >
        <AlertCircle className="h-2.5 w-2.5" />
        {ratio.toFixed(2)}
      </span>
    );
  }
  if (ratio < 1.0) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-amber-50 text-amber-700 border border-amber-200 font-semibold"
        title="Below 1.0 — most credit issued here has not been recycled yet."
      >
        {ratio.toFixed(2)}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold"
      title="Above 1.0 — customers redeem more credit here than they earn (net credit sink, healthy footfall)."
    >
      <TrendingUp className="h-2.5 w-2.5" />
      {ratio.toFixed(2)}
    </span>
  );
}

export const CreditLiabilityByShowroomCard = () => {
  const [data, setData] = useState({ rows: [], total_liability: 0, showroom_count: 0 });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const token = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
      const res = await axios.get(`${API_URL}/api/invoices/credit-liability/by-showroom`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      setData(res.data || { rows: [], total_liability: 0, showroom_count: 0 });
    } catch (e) {
      console.warn('[CreditLiability] load failed:', e?.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Max earn value drives the bar widths — earned is the largest
  // axis-positive value (redeemed/liability stack visually next to it).
  const maxEarned = Math.max(1, ...data.rows.map((r) => r.lifetime_earned || 0));

  return (
    <div className="bg-white border border-gray-200 rounded-lg" data-testid="credit-liability-card">
      <div className="flex items-center justify-between p-4 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-md bg-amber-100 flex items-center justify-center">
            <Store className="w-4 h-4 text-amber-700" />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 text-sm">Credit Liability by Showroom</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {data.showroom_count > 0 ? (
                <>
                  <span className="font-medium text-amber-700">{formatGBP(data.total_liability)}</span>
                  {' '}outstanding across {data.showroom_count} showroom{data.showroom_count === 1 ? '' : 's'}
                </>
              ) : 'No trade credit on file yet'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={refreshing}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
          data-testid="credit-liability-refresh"
        >
          {refreshing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Refresh
        </button>
      </div>

      {loading && (
        <div className="py-10 flex items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          Loading liability data…
        </div>
      )}

      {!loading && data.rows.length === 0 && (
        <div className="py-8 text-center text-sm text-muted-foreground italic">
          No credit transactions found.
        </div>
      )}

      {!loading && data.rows.length > 0 && (
        <div className="p-4 space-y-3" data-testid="credit-liability-rows">
          {data.rows.map((r) => {
            const widthPct = Math.max(4, ((r.lifetime_earned || 0) / maxEarned) * 100);
            const redeemedPct = r.lifetime_earned > 0
              ? Math.min(100, ((r.lifetime_redeemed || 0) / r.lifetime_earned) * 100)
              : 0;
            return (
              <div key={r.showroom_name} data-testid={`credit-liability-row-${r.showroom_name}`}>
                <div className="flex items-center justify-between mb-1 text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-semibold text-gray-900 truncate">{r.showroom_name}</span>
                    <RatioPill ratio={r.earn_redeem_ratio} />
                    <span className="text-gray-500 hidden sm:inline">
                      · {r.active_traders} trader{r.active_traders === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="text-right shrink-0 font-mono tabular-nums">
                    <span className="text-amber-700 font-bold">{formatGBP(r.liability)}</span>
                    <span className="text-gray-400 text-[10px] ml-1">liability</span>
                  </div>
                </div>
                {/* Visual: bar showing total earned, with redeemed portion overlaid */}
                <div className="relative h-3 bg-gray-100 rounded overflow-hidden" title={`Earned ${formatGBP(r.lifetime_earned)} · Redeemed ${formatGBP(r.lifetime_redeemed)}`}>
                  <div
                    className="absolute inset-y-0 left-0 bg-emerald-200"
                    style={{ width: `${widthPct}%` }}
                  />
                  <div
                    className="absolute inset-y-0 left-0 bg-emerald-600"
                    style={{ width: `${widthPct * (redeemedPct / 100)}%` }}
                  />
                </div>
                <div className="flex justify-between mt-0.5 text-[10px] text-gray-500 font-mono tabular-nums">
                  <span>Earned {formatGBP(r.lifetime_earned)}</span>
                  <span>Redeemed {formatGBP(r.lifetime_redeemed)}</span>
                </div>
              </div>
            );
          })}
          {/* Legend */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 border-t border-gray-100 text-[10px] text-gray-500">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-3 h-2 rounded-sm bg-emerald-200" /> Earned
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-3 h-2 rounded-sm bg-emerald-600" /> Redeemed
            </span>
            <span className="ml-auto italic">
              Ratio &lt; 0.5 = slow turnover · &gt; 1.0 = customers travel here to redeem
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default CreditLiabilityByShowroomCard;
