import React, { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { ShieldCheck, RefreshCw, Search, Trash2, Wrench, AlertTriangle, Megaphone, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
const ENDPOINT = '/admin/seo-autopilot-v2';

const ISSUE_LABELS = {
  not_found: 'Pages returning 404',
  server_error: 'Pages returning 5xx',
  redirect_from_canonical: 'Pages redirecting from canonical',
  missing_title: 'Pages with missing <title>',
  fallback_title: 'Pages with brand-only fallback title',
  duplicate_title: 'Pages sharing a duplicate title',
  missing_description: 'Pages missing meta description',
  short_description: 'Pages with short meta description',
  missing_canonical: 'Pages missing canonical tag',
  missing_h1: 'Pages missing <h1>',
  multiple_h1: 'Pages with multiple <h1>',
  thin_content: 'Thin-content pages (<200 chars visible)',
  missing_jsonld: 'Pages missing JSON-LD schema',
  network_error: 'Pages that timed out',
  html_parse_error: 'Pages with malformed HTML',
};

const GSC_BUCKET_LABELS = {
  indexed: 'Indexed (healthy)',
  soft_404: 'Soft 404',
  page_with_redirect: 'Page with redirect',
  crawled_not_indexed: 'Crawled - currently not indexed',
  discovered_not_indexed: 'Discovered - currently not indexed',
  not_found: 'Not found (404)',
  alternate_canonical: 'Alternate page with proper canonical',
  duplicate_no_canonical: 'Duplicate without user-selected canonical',
  excluded_noindex: 'Excluded by noindex',
  blocked_403: 'Blocked: forbidden (403)',
  blocked_robots: 'Blocked by robots.txt',
  fetch_error: 'Fetch error',
  unknown: 'Unclassified',
};

const BUCKET_TONE = {
  indexed: 'bg-emerald-100 text-emerald-700',
  alternate_canonical: 'bg-slate-100 text-slate-700',
  excluded_noindex: 'bg-slate-100 text-slate-700',
  blocked_403: 'bg-slate-100 text-slate-700',
  blocked_robots: 'bg-slate-100 text-slate-700',
  soft_404: 'bg-orange-100 text-orange-700',
  page_with_redirect: 'bg-amber-100 text-amber-700',
  crawled_not_indexed: 'bg-amber-100 text-amber-700',
  discovered_not_indexed: 'bg-amber-100 text-amber-700',
  duplicate_no_canonical: 'bg-rose-100 text-rose-700',
  not_found: 'bg-rose-100 text-rose-700',
  fetch_error: 'bg-rose-100 text-rose-700',
  unknown: 'bg-slate-100 text-slate-700',
};

export default function SeoAutopilotV2() {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // 'crawl' | 'gsc' | 'autofix' | 'fullcycle' | null
  // 15 May 2026 — re-crawl request state
  const [recrawl, setRecrawl] = useState({ requesting: false, last: null });

  const authHeaders = useCallback(() => ({
    Authorization: `Bearer ${localStorage.getItem('token') || ''}`,
  }), []);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get(`${API}${ENDPOINT}/dashboard`, { headers: authHeaders() });
      setDashboard(data);
      // Fetch the last recrawl summary too — independent so its failure
      // doesn't block the dashboard.
      try {
        const last = await axios.get(`${API}/admin/seo/last-recrawl`, { headers: authHeaders() });
        setRecrawl((s) => ({ ...s, last: last.data && Object.keys(last.data).length ? last.data : null }));
      } catch (_) { /* ignore */ }
    } catch (e) {
      toast.error('Failed to load autopilot dashboard');
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  const requestRecrawl = async () => {
    if (!window.confirm('Trigger fresh Ahrefs site audit + Google sitemap re-submit + IndexNow ping?')) return;
    setRecrawl((s) => ({ ...s, requesting: true }));
    try {
      const { data } = await axios.post(`${API}/admin/seo/request-recrawl`, {}, {
        headers: authHeaders(),
        timeout: 60000,
      });
      setRecrawl({ requesting: false, last: data });
      const parts = [];
      if (data?.ahrefs?.ok) parts.push('Ahrefs crawl queued');
      else parts.push(`Ahrefs: ${data?.ahrefs?.reason || 'skipped'}`);
      if (data?.gsc?.ok) parts.push('GSC sitemap re-submitted');
      else parts.push(`GSC: ${data?.gsc?.reason || 'skipped'}`);
      if (data?.indexnow?.ok) parts.push('IndexNow ping sent');
      else parts.push(`IndexNow: ${data?.indexnow?.reason || 'skipped'}`);
      if (data?.overall_ok) toast.success(parts.join(' · '));
      else toast.warning(parts.join(' · '));
    } catch (e) {
      setRecrawl((s) => ({ ...s, requesting: false }));
      toast.error(`Re-crawl failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const trigger = async (path, label) => {
    setBusy(label);
    try {
      const { data } = await axios.post(`${API}${ENDPOINT}${path}`, {}, {
        headers: authHeaders(),
        timeout: 300000,
      });
      toast.success(`${label} complete`);
      await loadDashboard();
      return data;
    } catch (e) {
      toast.error(`${label} failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setBusy(null);
    }
  };

  const snap = dashboard?.latest_self_crawl;
  const gscBuckets = dashboard?.gsc_buckets || [];
  const recentActions = dashboard?.recent_actions || [];

  return (
    <div className="space-y-6" data-testid="seo-autopilot-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-emerald-600" />
            SEO Autopilot
          </h1>
          <p className="text-sm text-slate-600 mt-1 max-w-2xl">
            Audits every URL in your sitemap weekly, polls Google Search Console for indexing
            issues, and auto-fixes what's safe to auto-fix (404s → 301 redirects). Telegram
            pings only when something gets <em>worse</em>.
          </p>
        </div>
        <Button
          onClick={loadDashboard}
          variant="outline"
          data-testid="autopilot-refresh-btn"
        >
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh
        </Button>
      </div>

      {/* Trigger buttons */}
      <Card className="p-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            onClick={() => trigger('/run/self-crawl', 'Self-crawl')}
            disabled={!!busy}
            data-testid="autopilot-run-self-crawl-btn"
          >
            <Search className="w-4 h-4 mr-2" />
            {busy === 'Self-crawl' ? 'Crawling…' : 'Run self-crawl now'}
          </Button>
          <Button
            onClick={() => trigger('/run/gsc-scan', 'GSC scan')}
            disabled={!!busy}
            variant="outline"
            data-testid="autopilot-run-gsc-scan-btn"
          >
            {busy === 'GSC scan' ? 'Scanning…' : 'Run GSC indexing scan'}
          </Button>
          <Button
            onClick={() => trigger('/run/auto-fix', 'Auto-fix')}
            disabled={!!busy}
            variant="outline"
            data-testid="autopilot-run-autofix-btn"
          >
            <Wrench className="w-4 h-4 mr-2" />
            {busy === 'Auto-fix' ? 'Fixing…' : 'Apply auto-fixes'}
          </Button>
          <Button
            onClick={() => trigger('/run/full-cycle', 'Full cycle')}
            disabled={!!busy}
            variant="default"
            className="bg-emerald-600 hover:bg-emerald-700"
            data-testid="autopilot-run-full-btn"
          >
            {busy === 'Full cycle' ? 'Running full cycle…' : 'Run FULL cycle'}
          </Button>
        </div>
      </Card>

      {/* 15 May 2026 — Re-crawl request card. Most SEO fixes don't show
          up in Ahrefs / GSC for days (weekly crawl cycles). This button
          tells every crawler "hey, look again" so we validate the fix
          in hours instead. */}
      <Card className="p-4" data-testid="recrawl-card">
        <div className="flex items-start gap-4 flex-wrap">
          <div className="flex-1 min-w-[280px]">
            <h3 className="font-semibold flex items-center gap-2">
              <Megaphone className="w-4 h-4 text-purple-600" />
              Request fresh re-crawl
            </h3>
            <p className="text-xs text-slate-600 mt-1 max-w-xl">
              Pings <strong>Ahrefs</strong> to trigger a new Site Audit,
              re-submits the sitemap to <strong>Google Search Console</strong>,
              and pings <strong>IndexNow</strong> (Bing/Yandex/DuckDuckGo).
              Use this after a deploy that fixes a batch of SEO issues so
              you validate the fix in <em>hours</em> instead of waiting for
              the weekly crawl cycle.
            </p>
            {recrawl.last?.requested_at && (
              <p className="text-xs text-slate-500 mt-2">
                Last requested: {new Date(recrawl.last.requested_at).toLocaleString('en-GB')}
                {' · '}
                Ahrefs: {recrawl.last.ahrefs?.ok ? '✅' : '❌'} {recrawl.last.ahrefs?.reason || ''}
                {' · '}
                GSC: {recrawl.last.gsc?.ok ? '✅' : '❌'} {recrawl.last.gsc?.reason || ''}
                {' · '}
                IndexNow: {recrawl.last.indexnow?.ok ? '✅' : '❌'} {recrawl.last.indexnow?.reason || ''}
              </p>
            )}
          </div>
          <Button
            onClick={requestRecrawl}
            disabled={recrawl.requesting}
            className="bg-purple-600 hover:bg-purple-700 text-white"
            data-testid="recrawl-request-btn"
          >
            {recrawl.requesting ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Requesting…
              </>
            ) : (
              <>
                <Megaphone className="w-4 h-4 mr-2" /> Request re-crawl now
              </>
            )}
          </Button>
        </div>
      </Card>

      {/* Latest self-crawl snapshot */}
      <Card className="p-4" data-testid="autopilot-self-crawl-card">
        <h2 className="text-lg font-medium mb-3">Latest self-crawl</h2>
        {loading ? <p className="text-sm text-slate-500">Loading…</p> :
         !snap ? <p className="text-sm text-slate-500">No crawl yet — click <em>Run self-crawl now</em> above.</p> : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3 text-sm">
              <Badge variant="outline" data-testid="autopilot-urls-crawled">
                {snap.urls_crawled} URLs crawled
              </Badge>
              <Badge variant="outline" data-testid="autopilot-urls-with-issues">
                {snap.urls_with_issues} with issues
              </Badge>
              <Badge variant="outline">
                Took {Math.round((snap.duration_s || 0) * 1000)}ms
              </Badge>
              <span className="text-slate-500">
                Last run: {snap.finished_at ? new Date(snap.finished_at).toLocaleString('en-GB') : '—'}
              </span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {Object.entries(snap.issue_counts || {})
                .filter(([, n]) => n > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([kind, n]) => (
                  <div key={kind} className="flex justify-between items-center text-sm px-3 py-2 rounded bg-slate-50">
                    <span>{ISSUE_LABELS[kind] || kind}</span>
                    <Badge className="bg-amber-100 text-amber-700">{n}</Badge>
                  </div>
                ))}
            </div>
            {(snap.duplicate_titles_preview || []).length > 0 && (
              <div className="mt-3">
                <h3 className="font-medium text-sm mb-2 flex items-center gap-1.5">
                  <AlertTriangle className="w-4 h-4 text-amber-600" />
                  Duplicate titles
                </h3>
                <ul className="space-y-2 text-xs">
                  {snap.duplicate_titles_preview.map((d) => (
                    <li key={d.title} className="border rounded p-2">
                      <div className="font-mono text-slate-700">"{d.title}"</div>
                      <div className="text-slate-500 mt-1">Used by {d.n} URLs (showing first {d.urls.length})</div>
                      <ul className="mt-1 ml-3 list-disc text-slate-600">
                        {d.urls.map(u => <li key={u}>{u}</li>)}
                      </ul>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* GSC indexing breakdown */}
      <Card className="p-4" data-testid="autopilot-gsc-card">
        <h2 className="text-lg font-medium mb-3">GSC indexing breakdown</h2>
        {gscBuckets.length === 0 ? (
          <p className="text-sm text-slate-500">No GSC scan yet — click <em>Run GSC indexing scan</em>.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {gscBuckets.map(b => (
              <div key={b.bucket} className={`flex justify-between items-center text-sm px-3 py-2 rounded ${BUCKET_TONE[b.bucket] || 'bg-slate-100'}`}>
                <span>{GSC_BUCKET_LABELS[b.bucket] || b.bucket}</span>
                <Badge className="bg-white">{b.count}</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Recent autopilot actions */}
      <Card className="p-4" data-testid="autopilot-actions-card">
        <h2 className="text-lg font-medium mb-3">Recent autopilot actions ({recentActions.length})</h2>
        {recentActions.length === 0 ? (
          <p className="text-sm text-slate-500">No recent autopilot activity yet.</p>
        ) : (
          <div className="space-y-1 text-xs">
            {recentActions.slice(0, 25).map((a, idx) => (
              <div key={idx} className="border-b py-1.5 flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-emerald-700">{a.action_type}</span>
                {a.from_path && <span className="text-slate-700">{a.from_path} →</span>}
                {a.to_path && <span className="text-blue-700">{a.to_path}</span>}
                {a.slug && <span className="text-slate-600">slug={a.slug}</span>}
                {a.urls_crawled !== undefined && <span className="text-slate-600">crawled={a.urls_crawled}</span>}
                {a.urls_with_issues !== undefined && <span className="text-slate-600">issues={a.urls_with_issues}</span>}
                <span className="text-slate-400 ml-auto">{a.ts ? new Date(a.ts).toLocaleString('en-GB') : ''}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Active redirects */}
      <Card className="p-4" data-testid="autopilot-redirects-card">
        <h2 className="text-lg font-medium mb-3 flex items-center gap-2">
          Active dynamic 301 redirects
          <Badge variant="outline">{dashboard?.active_redirects || 0}</Badge>
        </h2>
        <p className="text-xs text-slate-500">
          These are auto-generated 301s that the Express SSR layer picks up every 5 minutes —
          no redeploy needed. To revert one, hit the bin icon (one-click delete).
        </p>
        <RedirectList authHeaders={authHeaders} onChange={loadDashboard} />
      </Card>
    </div>
  );
}

function RedirectList({ authHeaders, onChange }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get(`${API}${ENDPOINT}/redirects`, { headers: authHeaders() });
      setRows(data.redirects || []);
    } catch (e) {
      toast.error('Failed to load redirects');
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  useEffect(() => { load(); }, [load]);

  const del = async (from) => {
    if (!window.confirm(`Delete redirect for ${from}?`)) return;
    try {
      await axios.delete(`${API}${ENDPOINT}/redirects${from}`, { headers: authHeaders() });
      toast.success('Redirect removed');
      await load();
      onChange?.();
    } catch (e) {
      toast.error('Delete failed');
    }
  };

  if (loading) return <p className="text-sm text-slate-500 mt-2">Loading…</p>;
  if (!rows.length) return <p className="text-sm text-slate-500 mt-2">No active dynamic redirects.</p>;
  return (
    <div className="mt-3 space-y-1 text-xs max-h-80 overflow-y-auto">
      {rows.map(r => (
        <div key={r.from} className="border-b py-1.5 flex items-center gap-2">
          <span className="font-mono text-slate-700">{r.from}</span>
          <span className="text-slate-400">→</span>
          <span className="font-mono text-blue-700">{r.to}</span>
          <Badge variant="outline" className="ml-2">{r.reason}</Badge>
          <button
            onClick={() => del(r.from)}
            className="ml-auto text-rose-600 hover:text-rose-800"
            data-testid={`autopilot-delete-redirect-${r.from.replace(/[^a-z0-9]/gi, '-')}`}
            title="Remove redirect"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
