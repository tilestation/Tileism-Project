/**
 * MarginIntelligenceCard
 * ──────────────────────
 * Joins supplier cost + GSC organic traffic per-product. Surfaces:
 *   • Summary: total / with-cost / with-organic-traffic / median margin
 *   • Top 20 rev-generators (fat margin + real demand) — expand & push
 *   • Price-test candidates (high impressions, thin margin — raise £?)
 *   • Supplier league table (which supplier lines are carrying us?)
 *
 * Cached server-side for 1 hour; Refresh bypasses.
 * Collapsed by default to avoid the 3-5s cold-cache GSC hit on every
 * /admin/products load.
 */
import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import {
  Loader2, TrendingUp, RefreshCw, Eye, Award, Zap, Package2,
} from 'lucide-react';
import { normaliseImageUrl } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const token = () => localStorage.getItem('token') || localStorage.getItem('access_token') || '';
const authHeaders = () => ({ headers: { Authorization: `Bearer ${token()}` } });

const fmtMoney = (n) => n == null ? '—' : `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt = (n) => n == null ? '—' : Number(n).toLocaleString();
const fmtPct = (v) => v == null ? '—' : `${Number(v).toFixed(1)}%`;


const MarginIntelligenceCard = () => {
  const [opened, setOpened] = useState(false);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force = false) => {
    if (!opened) return;
    setLoading(!report);
    setRefreshing(force);
    try {
      const r = await axios.get(
        `${API_URL}/api/admin/seo/stealth-keywords/margin-intel`,
        { ...authHeaders(), params: { top_n: 20, refresh: force }, timeout: 60000 },
      );
      setReport(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not load margin report');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [opened, report]);

  useEffect(() => { load(false); /* eslint-disable-next-line */ }, [opened]);

  if (!opened) {
    return (
      <Card
        className="p-4 bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-200 cursor-pointer hover:border-emerald-400 transition"
        onClick={() => setOpened(true)}
        data-testid="margin-intel-collapsed"
      >
        <div className="flex items-center gap-3">
          <div className="shrink-0 w-10 h-10 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center">
            <TrendingUp className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <div className="font-semibold text-slate-900">
              Supplier Margin Intelligence
            </div>
            <div className="text-xs text-slate-600">
              Click to load · fat-margin products with strong organic demand.
              Spot rev-generators to expand · price-test candidates · supplier
              league table. Pull this before trade calls.
            </div>
          </div>
          <Button size="sm" variant="ghost" className="text-emerald-800" data-testid="margin-intel-open-btn">
            <Eye className="w-4 h-4 mr-1" /> Open
          </Button>
        </div>
      </Card>
    );
  }

  const s = report?.summary || {};
  const top = report?.top_revenue_gen || [];
  const pt = report?.price_test_candidates || [];
  const suppliers = report?.suppliers || [];

  return (
    <Card className="overflow-hidden" data-testid="margin-intel-card">
      <div className="bg-gradient-to-br from-slate-900 to-emerald-900 text-white px-6 py-5">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-widest text-emerald-300 font-semibold flex items-center gap-1.5">
              <TrendingUp className="w-3 h-3" /> Supplier Margin Intelligence
            </div>
            <h3 className="text-xl font-bold mt-1 flex items-center gap-2">
              <Award className="w-5 h-5 text-emerald-300" />
              Margin × organic demand · which products to push
            </h3>
            <p className="text-sm text-emerald-200/80 mt-1 max-w-2xl">
              Joins cost_price + retail + supplier + live GSC organic signal.
              Score = margin% × log(1 + impressions_this_week). Sweet-spot
              products land at the top: real margin AND real search volume.
            </p>
          </div>
          <Button
            size="sm" variant="ghost"
            onClick={() => load(true)} disabled={refreshing}
            className="text-white hover:bg-white/10"
            data-testid="margin-intel-refresh-btn"
          >
            {refreshing ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
            Refresh
          </Button>
        </div>

        {report && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-4 text-xs" data-testid="margin-intel-summary">
            <MiniStat label="Products" value={fmtInt(s.total_products)} hint="active in catalogue" />
            <MiniStat label="With cost data" value={fmtInt(s.with_cost_data)} hint="cost_price populated" highlight />
            <MiniStat label="With organic" value={fmtInt(s.with_organic_traffic)} hint="GSC impressions this week" />
            <MiniStat label="Median margin" value={fmtPct(s.median_margin_pct)} hint="catalogue-wide baseline" />
          </div>
        )}
      </div>

      <div className="p-5 space-y-6">
        {loading && !report && (
          <div className="text-center py-8 text-slate-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin inline mr-1.5" />
            Computing margins across the catalogue…
          </div>
        )}

        {!loading && report && !s.gsc_connected && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            GSC isn't connected — report still shows margins, but organic demand columns will be zero.
            Connect GSC on /admin/seo to unlock the full ranking.
          </div>
        )}

        {/* Top rev-generators */}
        <Section title="Top rev-generators" icon={Award} testid="margin-intel-top"
          blurb="Highest score = margin × log(1 + impressions). These are the products you should expand the range on + push on trade calls.">
          {top.length === 0 ? (
            <Empty>No qualifying products yet — add cost_price to your catalogue.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[11px] text-slate-500 uppercase">
                  <tr>
                    <th className="text-left py-2 pr-2">Rank</th>
                    <th className="text-left pr-2">Product</th>
                    <th className="text-left">Supplier</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Cost</th>
                    <th className="text-right">Margin</th>
                    <th className="text-right">Impr./wk</th>
                    <th className="text-right pr-2">Δ</th>
                    <th className="text-right pr-2">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {top.map((r, i) => (
                    <tr key={r.product_id} className="border-t hover:bg-slate-50" data-testid={`margin-intel-top-row-${i}`}>
                      <td className="py-2 pr-2 text-xs text-slate-500 font-mono">#{i + 1}</td>
                      <td className="pr-2">
                        <div className="flex items-center gap-2 min-w-0">
                          {r.image_url && (
                            <img src={normaliseImageUrl(r.image_url)} alt="" className="w-8 h-8 rounded object-cover border shrink-0" loading="lazy" />
                          )}
                          <div className="min-w-0">
                            <div className="font-medium truncate max-w-[220px]">{r.name}</div>
                            <div className="text-[10px] text-slate-500 truncate max-w-[220px]">{r.collection || '—'}</div>
                          </div>
                        </div>
                      </td>
                      <td className="text-xs text-slate-600 truncate max-w-[140px]">{r.supplier_name}</td>
                      <td className="text-right font-mono">{fmtMoney(r.price)}</td>
                      <td className="text-right font-mono text-slate-600">{fmtMoney(r.cost_price)}</td>
                      <td className="text-right font-mono">
                        <MarginChip pct={r.margin_pct} />
                      </td>
                      <td className="text-right font-mono">{fmtInt(r.impressions_this_week)}</td>
                      <td className="text-right font-mono pr-2">
                        <DeltaBadge pct={r.impressions_delta_pct} />
                      </td>
                      <td className="text-right pr-2 font-mono font-semibold text-emerald-900">{r.score}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        {/* Price-test candidates */}
        <Section title="Price-test candidates" icon={Zap} testid="margin-intel-price-test"
          blurb="High organic demand + thin margin. You're leaving money on the table — test a 5-10% price lift next quarter.">
          {pt.length === 0 ? (
            <Empty>No high-volume low-margin products right now — healthy catalogue.</Empty>
          ) : (
            <div className="flex flex-wrap gap-2">
              {pt.map((r) => (
                <div key={r.product_id}
                     className="rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs flex items-center gap-2"
                     data-testid={`margin-intel-pt-${r.product_id}`}>
                  <span className="font-medium">{r.name}</span>
                  <span className="text-amber-800 font-mono">{fmtPct(r.margin_pct)} margin</span>
                  <span className="text-slate-500">·</span>
                  <span className="font-mono">{fmtInt(r.impressions_this_week)} impr/wk</span>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Supplier league */}
        <Section title="Supplier league table" icon={Package2} testid="margin-intel-suppliers"
          blurb="Which of your suppliers drive the most margin-adjusted organic traffic? Your next trade call priority list.">
          {suppliers.length === 0 ? (
            <Empty>No supplier data.</Empty>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-[11px] text-slate-500 uppercase">
                <tr>
                  <th className="text-left py-2">Supplier</th>
                  <th className="text-right">Products</th>
                  <th className="text-right">Avg margin</th>
                  <th className="text-right">Impr./wk</th>
                  <th className="text-right pr-2">Total score</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.slice(0, 10).map((s_, i) => (
                  <tr key={s_.supplier} className="border-t" data-testid={`margin-intel-supplier-row-${i}`}>
                    <td className="py-2 font-medium">{s_.supplier}</td>
                    <td className="text-right font-mono">{fmtInt(s_.product_count)}</td>
                    <td className="text-right font-mono"><MarginChip pct={s_.avg_margin_pct} /></td>
                    <td className="text-right font-mono">{fmtInt(s_.impressions_this_week)}</td>
                    <td className="text-right font-mono font-semibold text-emerald-900 pr-2">{s_.score_sum}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        {report?.generated_at && (
          <div className="text-[10px] text-slate-400 italic">
            generated {new Date(report.generated_at).toLocaleString('en-GB')} · 1h cache · click Refresh to recompute
          </div>
        )}
      </div>
    </Card>
  );
};


const MiniStat = ({ label, value, hint, highlight }) => (
  <div className={`rounded p-2 border ${highlight ? 'bg-emerald-500/15 border-emerald-300/40' : 'bg-white/10 border-white/20'}`}>
    <div className="text-[10px] uppercase tracking-wide text-emerald-200/70">{label}</div>
    <div className="text-lg font-bold font-mono mt-0.5">{value}</div>
    {hint && <div className="text-[10px] text-emerald-200/60 mt-0.5">{hint}</div>}
  </div>
);


const Section = ({ title, icon: Icon, blurb, children, testid }) => (
  <div data-testid={testid}>
    <h4 className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
      <Icon className="w-4 h-4 text-slate-500" /> {title}
    </h4>
    {blurb && <div className="text-[11px] text-slate-500 mt-0.5 mb-2">{blurb}</div>}
    {children}
  </div>
);


const Empty = ({ children }) => (
  <div className="text-[12px] text-slate-500 italic py-2">{children}</div>
);


const MarginChip = ({ pct }) => {
  if (pct == null) return <span className="text-slate-400">—</span>;
  let tone = 'bg-slate-100 text-slate-700';
  if (pct >= 55) tone = 'bg-emerald-100 text-emerald-900';
  else if (pct >= 35) tone = 'bg-sky-100 text-sky-900';
  else if (pct >= 15) tone = 'bg-amber-100 text-amber-900';
  else tone = 'bg-rose-100 text-rose-900';
  return <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-semibold ${tone}`}>{pct.toFixed(1)}%</span>;
};


const DeltaBadge = ({ pct }) => {
  if (pct == null || pct === 0) return <span className="text-slate-400 text-xs">flat</span>;
  if (pct > 0) return <span className="text-emerald-700 font-semibold text-xs">↑ {Math.round(pct)}%</span>;
  return <span className="text-rose-700 font-semibold text-xs">↓ {Math.abs(Math.round(pct))}%</span>;
};


export default MarginIntelligenceCard;
