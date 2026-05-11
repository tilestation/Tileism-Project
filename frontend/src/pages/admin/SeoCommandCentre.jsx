/**
 * SEO Command Centre — /admin/seo
 *
 * Surfaces live Ahrefs data (Domain Rating, organic keywords, traffic,
 * competitor cards, gap analysis) for tilestation.co.uk.
 *
 * Data flow: Mongo `ahrefs_snapshots` cache → instant render. Manual
 * Refresh button calls /api/admin/seo/refresh which pulls live from
 * Ahrefs API (~5-10 second round-trip, ~50-100 quota units).
 *
 * Anchor for upcoming features (Local 3-Pack monitor, Rank Tracker
 * dashboard, AI city landing pages, content briefs, GSC data, GBP API).
 */
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
  Loader2, RefreshCw, TrendingUp, ExternalLink, Shield,
  Globe, Search, Trophy, Target, Map, Sparkles, CheckCircle, Eye,
  Building2, Calculator, Bot,
} from 'lucide-react';
import GscConnectCard from './GscConnectCard';
import GscAnalyticsPanel from './GscAnalyticsPanel';
import GscSitemapCard from './GscSitemapCard';
import SeoHealthStatusBoard from './SeoHealthStatusBoard';
import EditorialAutopilotCard from './EditorialAutopilotCard';
import StealthKeywordsCard from './StealthKeywordsCard';
import StealthPerformanceCard from './StealthPerformanceCard';
import StealthAttributionCard from './StealthAttributionCard';
import SeoDashboardSummary from './SeoDashboardSummary';
import SeoSelfAuditCard from './SeoSelfAuditCard';
import LifetimeSavingsCard from './LifetimeSavingsCard';
import WebPushAdminCard from './WebPushAdminCard';
import GoogleShoppingFeedCard from './GoogleShoppingFeedCard';
import { useNavigate } from 'react-router-dom';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const token = () => localStorage.getItem('token') || localStorage.getItem('access_token') || '';

const fmt = (n) => {
  if (n == null || n === '') return '—';
  if (typeof n !== 'number') return String(n);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
};

const SeoCommandCentre = () => {
  const [snapshot, setSnapshot] = useState(null);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [gscConnected, setGscConnected] = useState(false);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [snap, hp] = await Promise.all([
        axios.get(`${API_URL}/api/admin/seo/snapshot`, { headers: { Authorization: `Bearer ${token()}` } }),
        axios.get(`${API_URL}/api/admin/seo/health`, { headers: { Authorization: `Bearer ${token()}` } }),
      ]);
      setSnapshot(snap.data);
      setHealth(hp.data);
    } catch (e) {
      // Don't toast on AHREFS_API_KEY-not-set — that's a config state, not a failure.
      // Detect it via the error string and let the UI render the friendly empty state.
      const detail = e?.response?.data?.detail || '';
      if (!String(detail).toLowerCase().includes('ahrefs')) {
        toast.error(detail || 'Could not load SEO data');
      }
    } finally {
      setLoading(false);
    }
  };

  // Heuristic: if the snapshot has zero competitors and the health endpoint
  // returns errors mentioning AHREFS, the user just hasn't configured Ahrefs.
  // Show a single friendly setup CTA instead of red error toasts everywhere.
  const ahrefsConfigured = !!(
    snapshot && snapshot.your_site && snapshot.your_site.domain_rating
    && Object.keys(snapshot.your_site.domain_rating || {}).length > 0
  );

  useEffect(() => { fetchAll(); }, []);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await axios.post(`${API_URL}/api/admin/seo/refresh`, {}, {
        headers: { Authorization: `Bearer ${token()}` }, timeout: 180000,
      });
      const r = res.data;
      if (r.ok) {
        toast.success(`Refreshed · ${r.competitors_count} competitors${(r.errors?.length || 0) > 0 ? ` · ${r.errors.length} non-blocking errors` : ''}`);
      } else {
        toast.warning(`Partial refresh — ${r.errors?.length || 0} errors`);
      }
      fetchAll();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const your = snapshot?.your_domain || {};
  const competitors = (snapshot?.competitors?.competitors || []);
  const lastAt = snapshot?.last_snapshotted;
  const usage = health?.data?.limits_and_usage;

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center text-gray-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading SEO Command Centre…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50" data-testid="seo-command-centre">
      {/* Header */}
      <div className="bg-gradient-to-br from-slate-900 to-indigo-950 text-white">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-widest text-indigo-300 font-semibold">SEO Command Centre · Powered by Ahrefs</div>
              <h1 className="text-3xl font-bold mt-1 flex items-center gap-2">
                <Trophy className="w-7 h-7 text-yellow-300" /> tilestation.co.uk
              </h1>
              {lastAt && (
                <div className="text-xs text-indigo-200/70 mt-1 font-mono">
                  Last refresh: {new Date(lastAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={refresh}
                disabled={refreshing}
                className="bg-yellow-300 text-slate-900 hover:bg-yellow-200"
                data-testid="seo-refresh-btn"
              >
                {refreshing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RefreshCw className="w-4 h-4 mr-2" />}
                Refresh from Ahrefs
              </Button>
            </div>
          </div>
          {usage && (
            <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <Stat label="Plan" value={usage.subscription} accent="indigo" />
              <Stat label="Quota used" value={`${fmt(usage.units_usage_workspace)} / ${fmt(usage.units_limit_workspace)}`} accent="indigo" />
              <Stat label="Quota resets" value={new Date(usage.usage_reset_date).toLocaleDateString('en-GB')} accent="indigo" />
              <Stat label="Key valid until" value={new Date(usage.api_key_expiration_date).toLocaleDateString('en-GB')} accent="indigo" />
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b bg-white sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 flex gap-1 overflow-x-auto">
          {[
            { id: 'overview', label: 'Overview', icon: TrendingUp },
            { id: 'keywords', label: 'Your keywords', icon: Search },
            { id: 'competitors', label: 'Competitors', icon: Shield },
            { id: 'gap', label: 'Keyword gap', icon: Target },
            { id: 'pages', label: 'Top pages', icon: Globe },
            { id: 'city-pages', label: 'City landing pages', icon: Map },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`px-4 py-3 text-sm font-medium whitespace-nowrap flex items-center gap-1.5 border-b-2 transition ${
                activeTab === t.id
                  ? 'text-indigo-700 border-indigo-600'
                  : 'text-gray-500 border-transparent hover:text-gray-800'
              }`}
              data-testid={`seo-tab-${t.id}`}
            >
              <t.icon className="w-4 h-4" /> {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        <SeoSelfAuditCard />
        <SeoDashboardSummary />
        <LifetimeSavingsCard />
        <SeoHealthStatusBoard />
        <EditorialAutopilotCard />
        <StealthKeywordsCard />
        <StealthPerformanceCard />
        <StealthAttributionCard />
        <WebPushAdminCard />
        <GoogleShoppingFeedCard />
        <GscConnectCard onConnectionChange={setGscConnected} />
        {!ahrefsConfigured && (
          <div className="rounded-lg border-2 border-blue-200 bg-blue-50 p-4 flex items-start gap-3" data-testid="seo-ahrefs-not-configured">
            <span className="inline-flex shrink-0 w-9 h-9 rounded-full bg-blue-100 text-blue-700 items-center justify-center text-lg font-bold">i</span>
            <div className="flex-1">
              <div className="font-semibold text-slate-900">Competitor monitoring is paused — Ahrefs not configured</div>
              <div className="text-sm text-slate-600 mt-1">
                Domain Rating, organic-keyword tracking and competitor benchmarking need an Ahrefs API key. Everything else on this page (GSC analytics, city pages, AI autopilot) works without it.
              </div>
              <div className="text-xs text-slate-500 mt-2">
                If you have an Ahrefs subscription, set <code className="px-1 py-0.5 rounded bg-white border border-slate-200">AHREFS_API_KEY</code> on Railway and refresh.
              </div>
            </div>
          </div>
        )}
        <SeoToolsRow />
        <GscAnalyticsPanel connected={gscConnected} />
        <GscSitemapCard connected={gscConnected} />
        {activeTab === 'overview' && <OverviewTab your={your} competitors={competitors} ahrefsConfigured={ahrefsConfigured} />}
        {activeTab === 'keywords' && <KeywordsTab keywords={your.organic_keywords || []} ahrefsConfigured={ahrefsConfigured} />}
        {activeTab === 'competitors' && <CompetitorsTab cards={competitors} your={your} ahrefsConfigured={ahrefsConfigured} />}
        {activeTab === 'gap' && <GapTab competitors={competitors} ahrefsConfigured={ahrefsConfigured} />}
        {activeTab === 'pages' && <TopPagesTab pages={your.top_pages || []} ahrefsConfigured={ahrefsConfigured} />}
        {activeTab === 'city-pages' && <CityPagesTab />}
      </div>
    </div>
  );
};


const Stat = ({ label, value, accent = 'gray' }) => {
  const cls = accent === 'indigo' ? 'bg-white/10 border-white/20 text-white' : 'bg-white border-gray-200';
  return (
    <div className={`rounded border ${cls} p-2`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-sm font-semibold mt-0.5 truncate font-mono">{value || '—'}</div>
    </div>
  );
};


// Quick-access tiles for sibling SEO tools (GBP, Ads-savings calculator)
// surfaced inline in the SEO Command Centre so admins don't have to
// remember separate URLs.
const SeoToolsRow = () => {
  const navigate = useNavigate();
  const tiles = [
    {
      id: 'gbp',
      title: 'Google Business Profile',
      desc: 'Reviews, ratings, calls & profile views',
      icon: Building2,
      to: '/admin/gbp',
      color: 'from-blue-500 to-blue-600',
    },
    {
      id: 'ads-savings',
      title: 'SEO ↔ Ads money-saver',
      desc: 'See what SEO is saving vs Google Ads',
      icon: Calculator,
      to: '/admin/ads-savings',
      color: 'from-emerald-500 to-emerald-600',
    },
    {
      id: 'seo-autopilot',
      title: 'SEO Autopilot',
      desc: '8 autonomous SEO jobs · zero manual review',
      icon: Bot,
      to: '/admin/seo-autopilot',
      color: 'from-purple-500 to-purple-600',
    },
  ];
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {tiles.map((t) => (
        <button
          key={t.id}
          onClick={() => navigate(t.to)}
          data-testid={`seo-tool-tile-${t.id}`}
          className="text-left bg-white border border-slate-200 rounded-xl p-4 hover:border-slate-300 hover:shadow-md transition-all group"
        >
          <div className="flex items-start gap-3">
            <div className={`p-2 rounded-lg bg-gradient-to-br ${t.color} text-white group-hover:scale-105 transition-transform`}>
              <t.icon className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <p className="font-semibold text-slate-900 group-hover:text-slate-700">{t.title}</p>
              <p className="text-xs text-slate-500 mt-0.5">{t.desc}</p>
            </div>
            <ExternalLink className="w-4 h-4 text-slate-400 group-hover:text-slate-600" />
          </div>
        </button>
      ))}
    </div>
  );
};

const Big = ({ label, value, sub, color = 'slate' }) => (
  <Card className={`p-5 border-l-4 border-${color}-500`}>
    <div className="text-xs uppercase tracking-wide text-gray-500 font-semibold">{label}</div>
    <div className="text-3xl font-bold mt-1 font-mono">{value}</div>
    {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
  </Card>
);


const OverviewTab = ({ your, competitors }) => {
  const dr = (your.domain_rating || {}).domain_rating;
  const rank = (your.domain_rating || {}).ahrefs_rank;
  const m = your.metrics || {};
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4" data-testid="seo-overview-stats">
        <Big label="Domain Rating" value={dr != null ? Math.round(dr) : '—'} sub="0-100, Ahrefs proprietary" color="indigo" />
        <Big label="Ahrefs Rank" value={rank != null ? `#${fmt(rank)}` : '—'} sub="Lower = stronger globally" color="violet" />
        <Big label="Organic keywords" value={fmt(m.org_keywords)} sub="Ranking in Google UK" color="emerald" />
        <Big label="Organic traffic / mo" value={fmt(m.org_traffic)} sub="Estimated UK monthly clicks" color="rose" />
      </div>

      {(dr === 0 || dr == null) && (
        <Card className="p-5 bg-amber-50 border-amber-300">
          <div className="flex items-start gap-3">
            <div className="text-2xl">⏳</div>
            <div>
              <h3 className="font-bold text-amber-900">Ahrefs is still crawling your site</h3>
              <p className="text-sm text-amber-800/90 mt-1">
                Your Ahrefs project was just created. Domain Rating, organic keywords, and backlink data
                typically populate within <strong>24-48 hours</strong> after project creation.
                Competitor data below is already live so you can start gap-analysis immediately.
                Click <strong>Refresh from Ahrefs</strong> tomorrow to pull fresh numbers.
              </p>
            </div>
          </div>
        </Card>
      )}

      <Card className="p-5">
        <h3 className="font-bold mb-3 flex items-center gap-2 text-slate-800"><Shield className="w-4 h-4" /> How you stack up</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-gray-500 uppercase">
              <tr><th className="text-left py-2">Domain</th><th className="text-right">DR</th><th className="text-right">Org. KW</th><th className="text-right">Org. traffic</th></tr>
            </thead>
            <tbody>
              <tr className="border-t bg-yellow-50/50 font-semibold">
                <td className="py-2">tilestation.co.uk <span className="text-[10px] bg-yellow-200 text-yellow-900 px-1.5 py-0.5 rounded ml-1">YOU</span></td>
                <td className="text-right font-mono">{dr != null ? Math.round(dr) : '—'}</td>
                <td className="text-right font-mono">{fmt(m.org_keywords)}</td>
                <td className="text-right font-mono">{fmt(m.org_traffic)}</td>
              </tr>
              {competitors.map((c) => {
                const cm = c.metrics || {};
                const cdr = (c.domain_rating || {}).domain_rating;
                return (
                  <tr key={c.domain} className="border-t hover:bg-gray-50">
                    <td className="py-2">{c.domain}</td>
                    <td className="text-right font-mono">{cdr != null ? Math.round(cdr) : '—'}</td>
                    <td className="text-right font-mono">{fmt(cm.org_keywords)}</td>
                    <td className="text-right font-mono">{fmt(cm.org_traffic)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};


const KeywordsTab = ({ keywords }) => {
  if (!keywords.length) {
    return (
      <Card className="p-10 text-center text-gray-500">
        <Search className="w-10 h-10 text-gray-300 mx-auto mb-2" />
        No organic keyword data yet. Ahrefs is still crawling your domain — typically populates within 24-48h after project creation.
      </Card>
    );
  }
  return (
    <Card className="p-5">
      <h3 className="font-bold mb-3">Keywords you currently rank for · top {keywords.length}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase">
            <tr>
              <th className="text-left py-2">Keyword</th>
              <th className="text-right">Position</th>
              <th className="text-right">Volume</th>
              <th className="text-right">KD</th>
              <th className="text-right">CPC</th>
              <th className="text-left">URL</th>
            </tr>
          </thead>
          <tbody>
            {keywords.map((k, i) => (
              <tr key={i} className="border-t hover:bg-gray-50" data-testid={`seo-kw-row-${i}`}>
                <td className="py-2 font-medium">{k.keyword}</td>
                <td className="text-right font-mono">
                  <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${
                    k.best_position <= 3 ? 'bg-emerald-100 text-emerald-900'
                    : k.best_position <= 10 ? 'bg-yellow-100 text-yellow-900'
                    : 'bg-gray-100 text-gray-700'
                  }`}>#{k.best_position}</span>
                </td>
                <td className="text-right font-mono">{fmt(k.volume)}</td>
                <td className="text-right font-mono">{k.keyword_difficulty ?? '—'}</td>
                <td className="text-right font-mono">{k.cpc != null ? `£${k.cpc.toFixed(2)}` : '—'}</td>
                <td className="text-left text-xs text-gray-500">
                  {k.best_position_url && (
                    <a href={k.best_position_url} target="_blank" rel="noopener noreferrer" className="hover:underline truncate inline-block max-w-[260px]">
                      {(k.best_position_url || '').replace(/^https?:\/\//, '')} <ExternalLink className="w-3 h-3 inline" />
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
};


const CompetitorsTab = ({ cards, your }) => (
  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="seo-competitors-grid">
    {cards.map((c) => {
      const m = c.metrics || {};
      const dr = (c.domain_rating || {}).domain_rating;
      const yourDr = (your?.domain_rating || {}).domain_rating || 0;
      const drGap = dr != null ? Math.round(dr - yourDr) : null;
      return (
        <Card key={c.domain} className="p-5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-bold truncate">{c.domain}</h3>
              <a
                href={`https://${c.domain}`} target="_blank" rel="noopener noreferrer"
                className="text-xs text-indigo-700 hover:underline"
              >
                Visit site <ExternalLink className="w-3 h-3 inline" />
              </a>
            </div>
            {drGap != null && drGap > 0 && (
              <span className="text-[10px] font-bold uppercase bg-rose-100 text-rose-900 px-2 py-0.5 rounded">
                +{drGap} DR ahead
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 mt-4">
            <Mini label="Domain Rating" value={dr != null ? Math.round(dr) : '—'} />
            <Mini label="Organic KW" value={fmt(m.org_keywords)} />
            <Mini label="Organic traffic" value={fmt(m.org_traffic)} />
            <Mini label="Paid KW" value={fmt(m.paid_keywords)} />
          </div>
        </Card>
      );
    })}
  </div>
);


const Mini = ({ label, value }) => (
  <div className="bg-gray-50 rounded p-2 border border-gray-200">
    <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div>
    <div className="text-base font-bold mt-0.5 font-mono">{value}</div>
  </div>
);


const GapTab = ({ competitors }) => {
  const [selected, setSelected] = useState(competitors[0]?.domain || '');
  const [gap, setGap] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    if (!selected) return;
    setLoading(true);
    try {
      const res = await axios.get(`${API_URL}/api/admin/seo/keyword-gap`, {
        params: { competitor: selected, limit: 200 },
        headers: { Authorization: `Bearer ${token()}` }, timeout: 60000,
      });
      setGap(res.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Gap analysis failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="p-5">
      <h3 className="font-bold mb-1 flex items-center gap-2"><Target className="w-4 h-4" /> Keyword gap analysis</h3>
      <p className="text-sm text-gray-500 mb-4">
        Find keywords your competitor ranks for that you don't. The fastest path to ranking growth.
      </p>
      <div className="flex flex-wrap gap-2 items-end mb-4">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          className="border rounded px-3 py-2 text-sm"
          data-testid="seo-gap-select"
        >
          {competitors.map((c) => (
            <option key={c.domain} value={c.domain}>{c.domain}</option>
          ))}
        </select>
        <Button onClick={run} disabled={!selected || loading} data-testid="seo-gap-run">
          {loading ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Target className="w-4 h-4 mr-1" />}
          Run gap analysis
        </Button>
      </div>

      {gap && (
        <div data-testid="seo-gap-results">
          <div className="text-sm text-gray-700 mb-3">
            <strong>{(gap.gap_keywords || []).length}</strong> keywords <strong>{gap.competitor}</strong> ranks for that
            you don't (top-20 cutoff). Total competitor keywords analysed: {fmt(gap.competitor_total)}.
          </div>
          {(gap.gap_keywords || []).length === 0 ? (
            <div className="py-10 text-center text-gray-500">No gap keywords found in this slice. Try a different competitor or increase the limit.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-500 uppercase">
                  <tr>
                    <th className="text-left py-2">Keyword</th>
                    <th className="text-right">Their position</th>
                    <th className="text-right">Volume</th>
                    <th className="text-right">KD</th>
                    <th className="text-right">CPC</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {gap.gap_keywords.slice(0, 100).map((k, i) => (
                    <tr key={i} className="border-t hover:bg-gray-50 group">
                      <td className="py-2 font-medium">{k.keyword}</td>
                      <td className="text-right font-mono">#{k.best_position}</td>
                      <td className="text-right font-mono">{fmt(k.volume)}</td>
                      <td className="text-right font-mono">{k.keyword_difficulty ?? '—'}</td>
                      <td className="text-right font-mono">{k.cpc != null ? `£${k.cpc.toFixed(2)}` : '—'}</td>
                      <td className="text-right">
                        <a
                          href={`/admin/marketing?tab=seo-drafts&target=${encodeURIComponent(k.keyword)}`}
                          className="opacity-0 group-hover:opacity-100 transition px-2 py-0.5 rounded text-[11px] font-semibold bg-indigo-100 text-indigo-900 hover:bg-indigo-200 whitespace-nowrap"
                          title="Open SEO Drafts queue with this keyword pre-targeted"
                          data-testid={`seo-gap-todraft-${i}`}
                        >
                          → Create draft
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
};


const TopPagesTab = ({ pages }) => {
  if (!pages.length) {
    return (
      <Card className="p-10 text-center text-gray-500">
        <Globe className="w-10 h-10 text-gray-300 mx-auto mb-2" />
        No top-pages data yet. Ahrefs typically populates this within 24-48h of project creation.
      </Card>
    );
  }
  return (
    <Card className="p-5">
      <h3 className="font-bold mb-3">Top organic pages · {pages.length}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 uppercase">
            <tr>
              <th className="text-left py-2">URL</th>
              <th className="text-right">Traffic / mo</th>
              <th className="text-right">Keywords</th>
              <th className="text-left">Top keyword</th>
              <th className="text-right">Top KW pos</th>
            </tr>
          </thead>
          <tbody>
            {pages.map((p, i) => (
              <tr key={i} className="border-t hover:bg-gray-50">
                <td className="py-2 truncate max-w-[300px]">
                  <a href={p.url} target="_blank" rel="noopener noreferrer" className="text-indigo-700 hover:underline">
                    {(p.url || '').replace(/^https?:\/\//, '')} <ExternalLink className="w-3 h-3 inline" />
                  </a>
                </td>
                <td className="text-right font-mono">{fmt(p.sum_traffic)}</td>
                <td className="text-right font-mono">{fmt(p.keywords)}</td>
                <td className="text-left">{p.top_keyword || '—'}</td>
                <td className="text-right font-mono">{p.top_keyword_best_position ? `#${p.top_keyword_best_position}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
};


/* ───────────────── CITY PAGES TAB ────────────────── */
const CityPagesTab = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [seeding, setSeeding] = useState(false);
  const [busy, setBusy] = useState(null); // slug currently being generated
  const [batching, setBatching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [batchResult, setBatchResult] = useState(null);
  const [autogen, setAutogen] = useState(null);
  const [autogenSaving, setAutogenSaving] = useState(false);
  const [autogenRunning, setAutogenRunning] = useState(false);
  const [rescoring, setRescoring] = useState(false);
  const [sendingDigest, setSendingDigest] = useState(false);
  const [abStats, setAbStats] = useState([]);
  const [abAutopromote, setAbAutopromote] = useState(null);
  const [abAutopromoteSaving, setAbAutopromoteSaving] = useState(false);
  const [abAutopromoteRunning, setAbAutopromoteRunning] = useState(false);

  const fetchAll = async (status = statusFilter) => {
    setLoading(true);
    try {
      const r = await axios.get(`${API_URL}/api/admin/seo/city-pages`, {
        params: { status, limit: 200 },
        headers: { Authorization: `Bearer ${token()}` },
      });
      setData(r.data);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not load city pages');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchAll(statusFilter); /* eslint-disable-next-line */ }, [statusFilter]);
  useEffect(() => { fetchAutogen(); fetchAbStats(); fetchAbAutopromote(); /* eslint-disable-next-line */ }, []);

  const seed = async () => {
    if (!window.confirm('Seed the queue with all 33 towns × 5 intents = 165 landing pages? Idempotent — won\'t duplicate existing rows.')) return;
    setSeeding(true);
    try {
      const r = await axios.post(`${API_URL}/api/admin/seo/city-pages/seed`, {}, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      toast.success(`Seeded ${r.data.created} new pages (${r.data.skipped} already existed)`);
      fetchAll(statusFilter);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Seed failed');
    } finally {
      setSeeding(false);
    }
  };

  const generate = async (slug) => {
    setBusy(slug);
    try {
      await axios.post(`${API_URL}/api/admin/seo/city-pages/generate`, { slug }, {
        headers: { Authorization: `Bearer ${token()}` }, timeout: 120000,
      });
      toast.success(`AI copy generated for ${slug}`);
      fetchAll(statusFilter);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Generation failed');
    } finally {
      setBusy(null);
    }
  };

  const generateBatch = async (limit) => {
    if (!window.confirm(
      `Generate AI copy for the next ${limit} pending pages? ` +
      `This will use ${limit} LLM calls (a few pence each) and may take ${Math.ceil(limit * 8 / 60)}+ minutes.`
    )) return;
    setBatching(true);
    setBatchResult(null);
    try {
      const r = await axios.post(
        `${API_URL}/api/admin/seo/city-pages/generate-batch`,
        { limit, only_pending: true },
        { headers: { Authorization: `Bearer ${token()}` }, timeout: 600000 }
      );
      setBatchResult(r.data);
      toast.success(`Generated ${r.data.succeeded}/${r.data.attempted} pages` +
        (r.data.failed ? ` — ${r.data.failed} failed` : ''));
      fetchAll(statusFilter);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Batch generation failed');
    } finally {
      setBatching(false);
    }
  };

  const refreshPending = async () => {
    if (!window.confirm(
      'Reset all pending and generated pages so they\'ll be regenerated with the latest prompt?\n\n' +
      'Approved pages will NOT be touched.'
    )) return;
    setRefreshing(true);
    try {
      const r = await axios.post(`${API_URL}/api/admin/seo/city-pages/refresh-pending`, {}, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      toast.success(`Reset ${r.data.reset} pages — ready for fresh generation`);
      fetchAll(statusFilter);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const fetchAutogen = async () => {
    try {
      const r = await axios.get(`${API_URL}/api/admin/seo/city-pages/autogen`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      setAutogen(r.data);
    } catch {
      // soft-fail — auto-gen panel just won't render
    }
  };

  const saveAutogen = async (patch) => {
    setAutogenSaving(true);
    try {
      const r = await axios.put(`${API_URL}/api/admin/seo/city-pages/autogen`, patch, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      setAutogen({ ...autogen, ...r.data });
      toast.success('Auto-gen settings saved');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not save auto-gen settings');
    } finally {
      setAutogenSaving(false);
    }
  };

  const runAutogenNow = async () => {
    if (!window.confirm(`Run the daily auto-generator now? It will draft up to ${autogen?.daily_count || 5} pages immediately.`)) return;
    setAutogenRunning(true);
    try {
      const r = await axios.post(`${API_URL}/api/admin/seo/city-pages/autogen/run-now`, {}, {
        headers: { Authorization: `Bearer ${token()}` }, timeout: 600000,
      });
      if (r.data.skipped) {
        toast(r.data.reason === 'queue_empty' ? 'Queue is empty — nothing to generate' : `Skipped: ${r.data.reason}`);
      } else if (r.data.queue_empty) {
        toast.success('Queue empty — drain notification email sent');
      } else {
        const aa = r.data.auto_approved || 0;
        toast.success(
          `Auto-gen ran: ${r.data.succeeded || 0} ok, ${r.data.failed || 0} failed` +
          (aa ? `, ${aa} auto-approved` : '')
        );
      }
      fetchAutogen();
      fetchAll(statusFilter);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Run failed');
    } finally {
      setAutogenRunning(false);
    }
  };

  const rescoreGenerated = async () => {
    setRescoring(true);
    try {
      const r = await axios.post(`${API_URL}/api/admin/seo/city-pages/rescore`, {}, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      toast.success(`Scored ${r.data.scored} generated pages`);
      fetchAll(statusFilter);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Rescore failed');
    } finally {
      setRescoring(false);
    }
  };

  const sendQualityDigest = async () => {
    if (!window.confirm(
      'Send the SEO quality digest email to all admins now?\n\n' +
      'It bundles last 7 days of auto-approved pages, manual approvals, and low-confidence drafts.'
    )) return;
    setSendingDigest(true);
    try {
      const r = await axios.post(
        `${API_URL}/api/admin/seo/city-pages/quality-digest/send-now`, {},
        { headers: { Authorization: `Bearer ${token()}` }, timeout: 60000 }
      );
      if (r.data.skipped) {
        toast(`Skipped: ${r.data.reason}`);
      } else if (r.data.ok && r.data.recipients) {
        toast.success(
          `Digest sent to ${r.data.recipients} admin${r.data.recipients === 1 ? '' : 's'}` +
          ` · ${r.data.auto_approved_count || 0} auto, ${r.data.low_conf_count || 0} pending`
        );
      } else {
        toast.error(r.data.error || 'Send failed');
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Send failed');
    } finally {
      setSendingDigest(false);
    }
  };

  const fetchAbStats = async () => {
    try {
      const r = await axios.get(`${API_URL}/api/admin/seo/city-pages/ab-stats`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      setAbStats(r.data.rows || []);
    } catch {
      // soft-fail
    }
  };

  const fetchAbAutopromote = async () => {
    try {
      const r = await axios.get(`${API_URL}/api/admin/seo/city-pages/ab-autopromote`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      setAbAutopromote(r.data);
    } catch { /* soft-fail */ }
  };

  const saveAbAutopromote = async (patch) => {
    setAbAutopromoteSaving(true);
    try {
      const r = await axios.put(`${API_URL}/api/admin/seo/city-pages/ab-autopromote`, patch, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      setAbAutopromote(r.data);
      toast.success('Auto-promote settings saved');
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not save settings');
    } finally {
      setAbAutopromoteSaving(false);
    }
  };

  const runAbAutopromoteNow = async () => {
    if (!window.confirm('Run the A/B winner auto-promoter now?\n\nIt will check every running A/B test and promote winners that meet the threshold.')) return;
    setAbAutopromoteRunning(true);
    try {
      const r = await axios.post(`${API_URL}/api/admin/seo/city-pages/ab-autopromote/run-now`, {}, {
        headers: { Authorization: `Bearer ${token()}` }, timeout: 60000,
      });
      if (r.data.skipped) {
        toast(`Skipped: ${r.data.reason}`);
      } else {
        toast.success(`Auto-promoted ${r.data.promoted} of ${r.data.candidates} A/B tests`);
        fetchAll(statusFilter);
        fetchAbStats();
        fetchAbAutopromote();
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Run failed');
    } finally {
      setAbAutopromoteRunning(false);
    }
  };

  const generateVariantB = async (slug) => {
    if (!window.confirm(
      `Generate a Variant B for ${slug}? It uses a different angle (design-ideas / project planning) ` +
      `so Google sees two competing pages for the same query. Resets impression+click counters.`
    )) return;
    setBusy(slug);
    try {
      await axios.post(`${API_URL}/api/admin/seo/city-pages/generate-variant-b`, { slug }, {
        headers: { Authorization: `Bearer ${token()}` }, timeout: 120000,
      });
      toast.success(`Variant B generated for ${slug}`);
      fetchAll(statusFilter);
      fetchAbStats();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Variant B generation failed');
    } finally {
      setBusy(null);
    }
  };

  const promoteVariant = async (slug, winner) => {
    const label = winner.toUpperCase();
    if (!window.confirm(
      `Promote Variant ${label} as the winner for ${slug}?\n\n` +
      (winner === 'b'
        ? 'Variant B will replace the current public copy. Variant A is discarded.'
        : 'Variant A stays. Variant B is discarded.') +
      '\n\nThis ends the A/B test.'
    )) return;
    try {
      await axios.post(`${API_URL}/api/admin/seo/city-pages/promote-variant`, { slug, winner }, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      toast.success(`Promoted variant ${label} for ${slug}`);
      fetchAll(statusFilter);
      fetchAbStats();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Promote failed');
    }
  };

  const approve = async (slug) => {
    setBusy(slug);
    try {
      await axios.post(`${API_URL}/api/admin/seo/city-pages/approve`, { slug }, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      toast.success(`${slug} now live at /tiles/${slug}`);
      fetchAll(statusFilter);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Approve failed');
    } finally {
      setBusy(null);
    }
  };

  const counts = data?.counts || { pending: 0, generated: 0, approved: 0, skipped: 0 };
  const rows = data?.rows || [];

  return (
    <div className="space-y-5" data-testid="seo-city-pages-tab">
      <Card className="p-5 bg-gradient-to-br from-emerald-50 to-teal-50 border-emerald-200">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-emerald-950 flex items-center gap-2">
              <Map className="w-5 h-5" /> AI city/town landing pages
            </h3>
            <p className="text-sm text-emerald-900/80 mt-1 max-w-2xl">
              Auto-generates SEO landing pages for every Kent + South-East UK town × 5 intents.
              Pages stage to <strong>generated</strong>, you review &amp; approve, then they go live at <code className="bg-white/60 px-1.5 rounded text-xs">/tiles/&lt;slug&gt;</code>.
              Realistic: 40-80 indexable pages within 30 days.
            </p>
          </div>
          <Button onClick={seed} disabled={seeding} className="bg-emerald-600 hover:bg-emerald-700 text-white" data-testid="seo-city-pages-seed">
            {seeding ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Sparkles className="w-4 h-4 mr-1" />}
            Seed all towns
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-emerald-200/60">
          <span className="text-xs font-semibold text-emerald-900/70 mr-1">Batch generate:</span>
          {[5, 10, 20].map((n) => (
            <Button
              key={n}
              onClick={() => generateBatch(n)}
              disabled={batching || refreshing || counts.pending === 0}
              size="sm"
              variant="outline"
              className="border-emerald-300 text-emerald-900 hover:bg-emerald-100"
              data-testid={`city-pages-batch-${n}`}
            >
              {batching ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Sparkles className="w-3.5 h-3.5 mr-1" />}
              Next {n}
            </Button>
          ))}
          <span className="mx-2 h-5 w-px bg-emerald-300/60" aria-hidden />
          <Button
            onClick={refreshPending}
            disabled={batching || refreshing}
            size="sm"
            variant="ghost"
            className="text-emerald-900/80 hover:bg-emerald-100"
            data-testid="city-pages-refresh-pending"
            title="Wipe AI copy on pending+generated pages so they re-run with the latest prompt. Approved pages untouched."
          >
            {refreshing ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : null}
            Reset pending pages
          </Button>
          {batchResult && (
            <span className="text-xs text-emerald-900/80 ml-auto" data-testid="city-pages-batch-result">
              Last batch: {batchResult.succeeded}/{batchResult.attempted} ok
              {batchResult.failed ? `, ${batchResult.failed} failed` : ''}
            </span>
          )}
        </div>
        {autogen && (
          <div
            className="mt-3 pt-3 border-t border-emerald-200/60 flex flex-wrap items-center gap-3 text-xs"
            data-testid="city-pages-autogen-panel"
          >
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!autogen.enabled}
                onChange={(e) => saveAutogen({ enabled: e.target.checked })}
                disabled={autogenSaving}
                className="h-4 w-4 accent-emerald-600"
                data-testid="city-pages-autogen-enabled"
              />
              <span className="font-semibold text-emerald-900/90">Daily auto-generator</span>
            </label>
            <span className="text-emerald-900/70">Drafts</span>
            <select
              value={autogen.daily_count}
              onChange={(e) => saveAutogen({ daily_count: parseInt(e.target.value, 10) })}
              disabled={autogenSaving || !autogen.enabled}
              className="border border-emerald-300 rounded px-1.5 py-0.5 text-xs bg-white text-emerald-900 disabled:opacity-50"
              data-testid="city-pages-autogen-count"
            >
              {[3, 5, 10, 15, 20].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span className="text-emerald-900/70">pages a day at</span>
            <select
              value={autogen.hour_utc}
              onChange={(e) => saveAutogen({ hour_utc: parseInt(e.target.value, 10) })}
              disabled={autogenSaving || !autogen.enabled}
              className="border border-emerald-300 rounded px-1.5 py-0.5 text-xs bg-white text-emerald-900 disabled:opacity-50"
              data-testid="city-pages-autogen-hour"
            >
              {Array.from({ length: 24 }, (_, h) => h).map((h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00 UTC</option>
              ))}
            </select>
            <span className="text-emerald-900/60">
              · {autogen.pending_count} pending
              {autogen.last_run_message ? ` · last run: ${autogen.last_run_message}` : ''}
              {autogen.drain_email_sent ? ' · drain email sent ✓' : ''}
            </span>
            <Button
              onClick={runAutogenNow}
              disabled={autogenRunning || !autogen.enabled}
              size="sm"
              variant="ghost"
              className="ml-auto h-7 px-2 text-emerald-900 hover:bg-emerald-100"
              data-testid="city-pages-autogen-run-now"
            >
              {autogenRunning ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
              Run now
            </Button>
          </div>
        )}
        {autogen && (
          <div
            className="mt-2 flex flex-wrap items-center gap-3 text-xs pl-6"
            data-testid="city-pages-autoapprove-panel"
          >
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!autogen.auto_approve_enabled}
                onChange={(e) => saveAutogen({ auto_approve_enabled: e.target.checked })}
                disabled={autogenSaving || !autogen.enabled}
                className="h-4 w-4 accent-emerald-600"
                data-testid="city-pages-autoapprove-enabled"
              />
              <span className="font-semibold text-emerald-900/90">Auto-approve when score ≥</span>
            </label>
            <select
              value={autogen.auto_approve_threshold}
              onChange={(e) => saveAutogen({ auto_approve_threshold: parseInt(e.target.value, 10) })}
              disabled={autogenSaving || !autogen.enabled || !autogen.auto_approve_enabled}
              className="border border-emerald-300 rounded px-1.5 py-0.5 text-xs bg-white text-emerald-900 disabled:opacity-50"
              data-testid="city-pages-autoapprove-threshold"
            >
              {[70, 75, 80, 85, 90, 95, 100].map((n) => <option key={n} value={n}>{n}%</option>)}
            </select>
            <span className="text-emerald-900/60 italic">
              Deterministic checklist: real address · phone · postcode · town mentions · word count · no placeholders.
              Low-confidence pages stay in “generated” for manual review.
            </span>
            <Button
              onClick={rescoreGenerated}
              disabled={rescoring}
              size="sm"
              variant="ghost"
              className="ml-auto h-7 px-2 text-emerald-900 hover:bg-emerald-100"
              data-testid="city-pages-rescore"
              title="Re-run the confidence checklist against every generated page (without re-calling the LLM)."
            >
              {rescoring ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
              Rescore
            </Button>
            <Button
              onClick={sendQualityDigest}
              disabled={sendingDigest}
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-emerald-900 hover:bg-emerald-100"
              data-testid="city-pages-quality-digest"
              title="Send the weekly SEO quality digest email right now (auto-approved + manual + low-confidence breakdown)."
            >
              {sendingDigest ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
              ✉ Send digest
            </Button>
          </div>
        )}
        <div className="flex flex-wrap gap-2 mt-4">
          {['pending', 'generated', 'approved', 'skipped'].map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${
                statusFilter === s ? 'bg-emerald-600 text-white border-emerald-600'
                : 'bg-white text-emerald-900 border-emerald-200 hover:border-emerald-400'
              }`}
              data-testid={`seo-city-filter-${s}`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)} ({counts[s] || 0})
            </button>
          ))}
        </div>
      </Card>

      {abStats.length > 0 && (
        <Card className="p-4 bg-indigo-50/40 border-indigo-200" data-testid="city-pages-ab-stats-card">
          <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
            <h4 className="text-sm font-bold text-indigo-950 flex items-center gap-2">
              🧪 Live A/B tests
              <span className="text-[10px] font-normal text-indigo-700/70 ml-1">
                {abStats.length} page{abStats.length === 1 ? '' : 's'} testing two variants
              </span>
            </h4>
            {abAutopromote && (
              <div className="flex flex-wrap items-center gap-2 text-[11px]" data-testid="ab-autopromote-panel">
                <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={!!abAutopromote.enabled}
                    onChange={(e) => saveAbAutopromote({ enabled: e.target.checked })}
                    disabled={abAutopromoteSaving}
                    className="h-3.5 w-3.5 accent-indigo-600"
                    data-testid="ab-autopromote-enabled"
                  />
                  <span className="font-semibold text-indigo-900/90">Auto-promote winners</span>
                </label>
                <span className="text-indigo-900/70">when both variants ≥</span>
                <select
                  value={abAutopromote.min_impressions}
                  onChange={(e) => saveAbAutopromote({ min_impressions: parseInt(e.target.value, 10) })}
                  disabled={abAutopromoteSaving || !abAutopromote.enabled}
                  className="border border-indigo-300 rounded px-1 py-0 text-[11px] bg-white text-indigo-900 disabled:opacity-50"
                  data-testid="ab-autopromote-impressions"
                >
                  {[100, 200, 500, 1000, 2000].map((n) => <option key={n} value={n}>{n} imp</option>)}
                </select>
                <span className="text-indigo-900/70">and</span>
                <select
                  value={abAutopromote.min_days}
                  onChange={(e) => saveAbAutopromote({ min_days: parseInt(e.target.value, 10) })}
                  disabled={abAutopromoteSaving || !abAutopromote.enabled}
                  className="border border-indigo-300 rounded px-1 py-0 text-[11px] bg-white text-indigo-900 disabled:opacity-50"
                  data-testid="ab-autopromote-days"
                >
                  {[7, 14, 21, 30].map((n) => <option key={n} value={n}>{n} days</option>)}
                </select>
                {abAutopromote.last_run_message ? (
                  <span className="text-indigo-900/60 italic">· last: {abAutopromote.last_run_message}</span>
                ) : null}
                <Button
                  onClick={runAbAutopromoteNow}
                  disabled={abAutopromoteRunning}
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-indigo-900 hover:bg-indigo-100 text-[11px]"
                  data-testid="ab-autopromote-run-now"
                >
                  {abAutopromoteRunning ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                  Run now
                </Button>
              </div>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase text-indigo-800/70">
                <tr>
                  <th className="text-left py-1 pr-2">Page</th>
                  <th className="text-right pr-2">A · imp</th>
                  <th className="text-right pr-2">A · CTR</th>
                  <th className="text-right pr-2">B · imp</th>
                  <th className="text-right pr-2">B · CTR</th>
                  <th className="text-right">Promote</th>
                </tr>
              </thead>
              <tbody>
                {abStats.map((row) => {
                  const a = row.variant_a;
                  const b = row.variant_b;
                  const totalImp = (a.impressions || 0) + (b.impressions || 0);
                  const aBetter = (a.ctr || 0) > (b.ctr || 0);
                  return (
                    <tr key={row.slug} className="border-t border-indigo-200/40" data-testid={`ab-row-${row.slug}`}>
                      <td className="py-1.5 pr-2">
                        <a href={row.url} target="_blank" rel="noopener noreferrer" className="text-indigo-800 hover:underline font-medium">
                          {row.town} · {row.intent_phrase}
                        </a>
                        <span className="text-[10px] text-gray-500 ml-2">{totalImp} total imp</span>
                      </td>
                      <td className={`text-right pr-2 font-mono ${aBetter && totalImp > 0 ? 'font-bold text-emerald-700' : ''}`}>{a.impressions}</td>
                      <td className={`text-right pr-2 font-mono ${aBetter && totalImp > 0 ? 'font-bold text-emerald-700' : ''}`}>
                        {a.ctr === null ? '—' : `${a.ctr}%`}
                      </td>
                      <td className={`text-right pr-2 font-mono ${!aBetter && totalImp > 0 ? 'font-bold text-emerald-700' : ''}`}>{b.impressions}</td>
                      <td className={`text-right pr-2 font-mono ${!aBetter && totalImp > 0 ? 'font-bold text-emerald-700' : ''}`}>
                        {b.ctr === null ? '—' : `${b.ctr}%`}
                      </td>
                      <td className="text-right space-x-1">
                        <button
                          onClick={() => promoteVariant(row.slug, 'a')}
                          className="text-[11px] px-1.5 py-0.5 rounded bg-white border border-indigo-300 text-indigo-900 hover:bg-indigo-100"
                          data-testid={`ab-promote-a-${row.slug}`}
                        >
                          Pick A
                        </button>
                        <button
                          onClick={() => promoteVariant(row.slug, 'b')}
                          className="text-[11px] px-1.5 py-0.5 rounded bg-white border border-indigo-300 text-indigo-900 hover:bg-indigo-100"
                          data-testid={`ab-promote-b-${row.slug}`}
                        >
                          Pick B
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {loading && !data && (
        <div className="text-center py-10 text-gray-500"><Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…</div>
      )}

      {data && rows.length === 0 && (
        <Card className="p-10 text-center text-gray-500" data-testid="seo-city-pages-empty">
          No {statusFilter} pages. {statusFilter === 'pending' && 'Click "Seed all towns" to populate the queue.'}
        </Card>
      )}

      {rows.length > 0 && (
        <Card className="p-3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-gray-500 uppercase">
                <tr>
                  <th className="text-left py-2 px-2">Town</th>
                  <th className="text-left">Intent</th>
                  <th className="text-left">URL</th>
                  <th className="text-left">Status</th>
                  <th className="text-right pr-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.slug} className="border-t hover:bg-gray-50" data-testid={`city-row-${r.slug}`}>
                    <td className="py-2 px-2 font-medium">
                      {r.town}
                      <span className="text-[10px] ml-1 bg-gray-100 text-gray-600 rounded px-1">T{r.tier}</span>
                    </td>
                    <td className="text-gray-700">{r.intent_phrase}</td>
                    <td>
                      <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-indigo-700 hover:underline text-xs font-mono">
                        {r.url}
                      </a>
                    </td>
                    <td>
                      <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${
                        r.status === 'pending' ? 'bg-amber-100 text-amber-900'
                        : r.status === 'generated' ? 'bg-blue-100 text-blue-900'
                        : r.status === 'approved' ? 'bg-emerald-100 text-emerald-900'
                        : 'bg-gray-200 text-gray-700'
                      }`}>{r.status}</span>
                      {typeof r.confidence_score === 'number' && (
                        <span
                          className={`ml-1.5 text-[11px] px-1.5 py-0.5 rounded font-mono ${
                            r.confidence_score >= 90 ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                            : r.confidence_score >= 75 ? 'bg-amber-50 text-amber-800 border border-amber-200'
                            : 'bg-rose-50 text-rose-800 border border-rose-200'
                          }`}
                          title={
                            Array.isArray(r.confidence_failed) && r.confidence_failed.length
                              ? `Failed checks: ${r.confidence_failed.join(', ')}`
                              : 'All confidence checks passed'
                          }
                          data-testid={`city-score-${r.slug}`}
                        >
                          {r.confidence_score}%
                        </span>
                      )}
                    </td>
                    <td className="text-right pr-2">
                      {r.status === 'pending' && (
                        <button
                          onClick={() => generate(r.slug)}
                          disabled={busy === r.slug}
                          className="text-xs px-2 py-1 rounded bg-violet-100 text-violet-900 hover:bg-violet-200 disabled:opacity-50"
                          data-testid={`city-generate-${r.slug}`}
                        >
                          {busy === r.slug ? <Loader2 className="w-3 h-3 animate-spin inline mr-1" /> : <Sparkles className="w-3 h-3 inline mr-1" />}
                          Generate
                        </button>
                      )}
                      {r.status === 'generated' && (
                        <>
                          <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200 mr-1 inline-block">
                            <Eye className="w-3 h-3 inline mr-1" /> Preview
                          </a>
                          <button
                            onClick={() => approve(r.slug)}
                            disabled={busy === r.slug}
                            className="text-xs px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700"
                            data-testid={`city-approve-${r.slug}`}
                          >
                            <CheckCircle className="w-3 h-3 inline mr-1" /> Approve &amp; publish
                          </button>
                        </>
                      )}
                      {r.status === 'approved' && (
                        <>
                          <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-900 hover:bg-emerald-200 inline-block mr-1">
                            View live
                          </a>
                          {!r.variant_b && (
                            <button
                              onClick={() => generateVariantB(r.slug)}
                              disabled={busy === r.slug}
                              className="text-xs px-2 py-1 rounded bg-indigo-100 text-indigo-900 hover:bg-indigo-200 disabled:opacity-50"
                              data-testid={`city-generate-b-${r.slug}`}
                              title="Generate a Variant B with a different angle so the two pages can A/B test on Google."
                            >
                              {busy === r.slug ? <Loader2 className="w-3 h-3 animate-spin inline mr-1" /> : <Sparkles className="w-3 h-3 inline mr-1" />}
                              Generate B
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
};


export default SeoCommandCentre;
