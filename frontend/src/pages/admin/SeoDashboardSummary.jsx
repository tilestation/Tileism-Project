/**
 * SeoDashboardSummary
 * ───────────────────
 * The 30-second CEO pulse-check at the top of /admin/seo. Composes
 * the snapshot endpoint into 6 hero tiles + an alerts banner.
 *
 * Layout (desktop):
 *   ┌────────────────────────────────────────────────────────┐
 *   │  [⚠ alerts banner — only when actions exist]            │
 *   │  ┌──────────┬──────────┬──────────┬──────────┐         │
 *   │  │ stealth  │ top kw   │ top prod │ auto-prom│         │
 *   │  │ clicks Δ │ winner   │ winner   │ this wk  │         │
 *   │  ├──────────┼──────────┼──────────┼──────────┤         │
 *   │  │ margin   │ health   │                                │
 *   │  └──────────┴──────────┘                                │
 *   └────────────────────────────────────────────────────────┘
 *
 * Mobile collapses to a single column.
 *
 * NO admin actions on this card — it's a READ-ONLY pulse. Each tile
 * has a deep-link button to the relevant detail card if you want to
 * drill in.
 */
import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import {
  Loader2, RefreshCw, TrendingUp, TrendingDown, Trophy, Award,
  Sparkles, Activity, AlertCircle, CheckCircle2, Zap, Package, Target,
} from 'lucide-react';
import { normaliseImageUrl } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const token = () => localStorage.getItem('token') || localStorage.getItem('access_token') || '';
const authHeaders = () => ({ headers: { Authorization: `Bearer ${token()}` } });

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());
const fmtPct = (v) => v == null ? '—' : `${Number(v).toFixed(1)}%`;
const fmtMoney = (n) => n == null ? '—' : `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;


const SeoDashboardSummary = () => {
  const [snap, setSnap] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force = false) => {
    setRefreshing(force);
    try {
      const r = await axios.get(
        `${API_URL}/api/admin/seo/stealth-keywords/dashboard/snapshot`,
        { ...authHeaders(), timeout: 30000 },
      );
      setSnap(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not load dashboard');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  if (loading) {
    return (
      <Card className="p-5 flex items-center gap-2 text-slate-500" data-testid="seo-dashboard-loading">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading dashboard…
      </Card>
    );
  }
  if (!snap) return null;

  const h = snap.headline || {};
  const alerts = snap.alerts || [];

  return (
    <Card className="overflow-hidden" data-testid="seo-dashboard-summary">
      <div className="bg-gradient-to-br from-slate-900 via-violet-950 to-fuchsia-950 text-white px-6 py-5">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-fuchsia-300 font-semibold">
              SEO command pulse · this week
            </div>
            <h2 className="text-2xl font-bold mt-1">
              {h.gsc_connected
                ? <>Stealth campaign · <span className="font-mono text-fuchsia-300">{fmt(h.stealth_clicks_this_week)}</span> clicks</>
                : <>Connect Google Search Console to begin</>}
            </h2>
            {h.gsc_connected && h.window_start && (
              <div className="text-xs text-fuchsia-200/70 mt-1 font-mono">
                {h.window_start} → {h.window_end} · {fmt(h.total_clicks_this_week)} total clicks · {fmt(h.total_impressions_this_week)} impressions
              </div>
            )}
          </div>
          <Button
            size="sm" variant="ghost"
            onClick={() => load(true)} disabled={refreshing}
            className="text-white hover:bg-white/10"
            data-testid="seo-dashboard-refresh-btn"
          >
            {refreshing ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
            Refresh
          </Button>
        </div>
      </div>

      {/* Alerts banner */}
      {alerts.length > 0 && (
        <div className="border-b" data-testid="seo-dashboard-alerts">
          {alerts.map((a, i) => <AlertBar key={i} alert={a} index={i} />)}
        </div>
      )}

      {/* Hero tiles grid */}
      <div className="p-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3" data-testid="seo-dashboard-tiles">
        <DeltaTile
          label="Stealth clicks WoW"
          value={fmt(h.stealth_clicks_this_week)}
          delta={h.stealth_clicks_delta_pct}
          icon={Zap}
          tone="fuchsia"
          testid="tile-stealth-clicks"
          subtext={h.gsc_connected ? 'vs last 7 days' : 'GSC not connected'}
        />
        <KeywordTile kw={snap.top_keyword} />
        <ProductTile p={snap.top_product} />
        <MarginTile margin={snap.margin} />
        <AutoPromoteTile auto={snap.auto_promote} />
        <HealthTile health={snap.health} />
      </div>

      {snap.generated_at && (
        <div className="px-5 pb-3 text-[10px] text-slate-400 italic">
          generated {new Date(snap.generated_at).toLocaleString('en-GB')} · components cached up to 1h
        </div>
      )}
    </Card>
  );
};


// ─── Sub-components ──────────────────────────────────────────────────

const AlertBar = ({ alert, index }) => {
  const tone = {
    critical: 'bg-rose-50 border-rose-200 text-rose-900',
    warning: 'bg-amber-50 border-amber-200 text-amber-900',
    info: 'bg-sky-50 border-sky-200 text-sky-900',
  }[alert.severity] || 'bg-slate-50 border-slate-200 text-slate-900';
  const Icon = alert.severity === 'critical' ? AlertCircle
             : alert.severity === 'warning' ? AlertCircle
             : Sparkles;
  return (
    <div
      className={`flex items-center gap-3 px-5 py-2.5 text-sm border-b last:border-b-0 ${tone}`}
      data-testid={`seo-dashboard-alert-${index}`}
    >
      <Icon className="w-4 h-4 shrink-0" />
      <div className="flex-1">{alert.message}</div>
      {alert.cta_label && alert.cta_link && (
        <a
          href={alert.cta_link}
          className="text-xs font-semibold underline decoration-dotted underline-offset-2 hover:opacity-70 shrink-0"
          data-testid={`seo-dashboard-alert-cta-${index}`}
        >
          {alert.cta_label} →
        </a>
      )}
    </div>
  );
};


const DeltaTile = ({ label, value, delta, icon: Icon, tone, subtext, testid }) => {
  const tones = {
    fuchsia: 'border-fuchsia-200 bg-fuchsia-50',
    emerald: 'border-emerald-200 bg-emerald-50',
    sky: 'border-sky-200 bg-sky-50',
    amber: 'border-amber-200 bg-amber-50',
  };
  return (
    <div className={`rounded-lg border-2 p-3 ${tones[tone]}`} data-testid={testid}>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide font-semibold text-slate-700">
        {Icon && <Icon className="w-3.5 h-3.5" />}
        {label}
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        <div className="text-2xl font-bold font-mono text-slate-900">{value}</div>
        {delta != null && delta !== 0 && (
          <span className={`text-xs font-mono font-bold ${delta > 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
            {delta > 0 ? '↑' : '↓'} {Math.abs(delta)}%
          </span>
        )}
        {delta === 0 && <span className="text-xs text-slate-500">flat</span>}
      </div>
      {subtext && <div className="text-[10px] text-slate-600 mt-1">{subtext}</div>}
    </div>
  );
};


const KeywordTile = ({ kw }) => {
  if (!kw) {
    return (
      <EmptyTile label="Top keyword" icon={Trophy}
        message="No tracked keyword has driven clicks yet" />
    );
  }
  const bandColour = {
    winner: 'text-emerald-700',
    ok: 'text-sky-700',
    slow: 'text-amber-700',
    quiet: 'text-slate-500',
  }[kw.roi_band] || 'text-slate-700';
  return (
    <div className="rounded-lg border-2 border-emerald-200 bg-emerald-50 p-3" data-testid="tile-top-keyword">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide font-semibold text-slate-700">
        <Trophy className="w-3.5 h-3.5" /> Top winning keyword
      </div>
      <div className="mt-1">
        <div className="font-mono font-bold text-slate-900 text-base truncate" title={kw.keyword}>
          {kw.keyword}
        </div>
        <div className="text-[10px] text-slate-600 truncate">
          {kw.scope === 'city_page' ? '🏘 ' : '📦 '}{kw.target_label}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        <Sparkline values={kw.spark || []} />
        <div className="text-right ml-auto">
          <div className="text-lg font-bold font-mono text-slate-900">{fmt(kw.clicks_total)}</div>
          <div className={`text-[10px] uppercase tracking-wide font-bold ${bandColour}`}>
            {kw.roi_score?.toFixed(2)}× {kw.roi_band}
          </div>
        </div>
      </div>
    </div>
  );
};


const ProductTile = ({ p }) => {
  if (!p) {
    return (
      <EmptyTile label="Top revenue-gen product" icon={Award}
        message="No product has both margin AND organic demand yet" />
    );
  }
  return (
    <div className="rounded-lg border-2 border-violet-200 bg-violet-50 p-3" data-testid="tile-top-product">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide font-semibold text-slate-700">
        <Award className="w-3.5 h-3.5" /> Top rev-gen product
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        {p.image_url && (
          <img src={normaliseImageUrl(p.image_url)} alt="" className="w-12 h-12 rounded object-cover border border-violet-200 shrink-0" loading="lazy" />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-slate-900 text-sm truncate" title={p.name}>{p.name}</div>
          <div className="text-[10px] text-slate-600 truncate">
            {p.supplier_name ? p.supplier_name + ' · ' : ''}{fmtMoney(p.price)}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px]">
            <span className="font-mono font-bold text-emerald-700">{fmtPct(p.margin_pct)}</span>
            <span className="text-slate-500">×</span>
            <span className="font-mono font-bold text-slate-700">{fmt(p.impressions_this_week)} impr</span>
          </div>
        </div>
      </div>
    </div>
  );
};


const MarginTile = ({ margin }) => {
  const m = margin || {};
  const totalProducts = m.total_products || 0;
  const withOrganic = m.with_organic_traffic || 0;
  const ratio = totalProducts > 0 ? Math.round((withOrganic / totalProducts) * 100) : 0;
  return (
    <div className="rounded-lg border-2 border-sky-200 bg-sky-50 p-3" data-testid="tile-margin">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide font-semibold text-slate-700">
        <Package className="w-3.5 h-3.5" /> Catalogue health
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        <div className="text-2xl font-bold font-mono text-slate-900">{fmtPct(m.median_margin_pct)}</div>
        <div className="text-xs text-slate-500">median margin</div>
      </div>
      <div className="text-[11px] text-slate-700 mt-1">
        <span className="font-mono font-bold">{fmt(withOrganic)}</span> / {fmt(totalProducts)} products with organic traffic <span className="text-slate-400">({ratio}%)</span>
      </div>
    </div>
  );
};


const AutoPromoteTile = ({ auto }) => {
  const a = auto || {};
  const count = a.count_this_week || 0;
  return (
    <div className="rounded-lg border-2 border-amber-200 bg-amber-50 p-3" data-testid="tile-auto-promote">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide font-semibold text-slate-700">
        <Target className="w-3.5 h-3.5" /> Auto-promotions this week
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        <div className="text-2xl font-bold font-mono text-slate-900">{fmt(count)}</div>
        {count > 0 && <div className="text-xs text-emerald-700 font-semibold">live ✨</div>}
      </div>
      {(a.recent || []).length > 0 && (
        <ul className="text-[10px] text-slate-600 mt-1 space-y-0.5">
          {a.recent.slice(0, 2).map((r, i) => (
            <li key={i} className="truncate" title={`${r.query} → ${r.target}`}>
              <span className="font-mono">{r.query}</span> → {r.target}
            </li>
          ))}
        </ul>
      )}
      {count === 0 && (
        <div className="text-[10px] text-slate-500 italic mt-1">enable auto-promote to start growing</div>
      )}
    </div>
  );
};


const HealthTile = ({ health }) => {
  if (!health) {
    return (
      <EmptyTile label="System health" icon={Activity}
        message="Health monitor data unavailable" />
    );
  }
  const map = {
    all_green: { tone: 'border-emerald-200 bg-emerald-50', icon: CheckCircle2, colour: 'text-emerald-700', text: 'all green' },
    warning: { tone: 'border-amber-200 bg-amber-50', icon: AlertCircle, colour: 'text-amber-700', text: 'warning' },
    critical: { tone: 'border-rose-200 bg-rose-50', icon: AlertCircle, colour: 'text-rose-700', text: 'critical' },
  };
  const m = map[health.status] || map.warning;
  const Icon = m.icon;
  return (
    <div className={`rounded-lg border-2 p-3 ${m.tone}`} data-testid="tile-health">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide font-semibold text-slate-700">
        <Icon className="w-3.5 h-3.5" /> System health
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        <div className={`text-2xl font-bold font-mono ${m.colour}`}>
          {health.ok_count}/{health.total_count}
        </div>
        <div className={`text-xs uppercase font-bold ${m.colour}`}>{m.text}</div>
      </div>
      {(health.first_failures || []).length > 0 && (
        <div className="text-[10px] text-rose-700 mt-1 truncate">
          failing: {health.first_failures.join(', ')}
        </div>
      )}
    </div>
  );
};


const EmptyTile = ({ label, icon: Icon, message }) => (
  <div className="rounded-lg border-2 border-slate-200 bg-slate-50 p-3 opacity-70" data-testid="tile-empty">
    <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide font-semibold text-slate-500">
      {Icon && <Icon className="w-3.5 h-3.5" />}
      {label}
    </div>
    <div className="text-xs text-slate-500 italic mt-2">{message}</div>
  </div>
);


const Sparkline = ({ values = [], width = 80, height = 24 }) => {
  if (!values.length) return <span className="text-[10px] text-slate-300">—</span>;
  const max = Math.max(1, ...values);
  const stepX = width / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * stepX;
    const y = height - (v / max) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const total = values.reduce((a, b) => a + b, 0);
  const colour = total > 0 ? '#059669' : '#94a3b8';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img">
      <polyline points={pts} fill="none" stroke={colour} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
};


export default SeoDashboardSummary;
