import React, { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import { Target, TrendingUp, TrendingDown, RefreshCw, Flag, Calendar } from 'lucide-react';
import { toast } from 'sonner';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
const ENDPOINT = '/admin/mission';

const STATUS_TONE = {
  past: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  current: 'bg-amber-100 text-amber-800 border-amber-300 ring-2 ring-amber-300',
  future: 'bg-slate-50 text-slate-500 border-slate-200',
};

function num(v, fallback = '—') {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'number') return v.toLocaleString('en-GB');
  return v;
}

function delta(v, formatter = num, positiveBad = false) {
  if (v === null || v === undefined) return null;
  const isUp = v > 0;
  const tone = positiveBad
    ? (isUp ? 'text-rose-600' : 'text-emerald-600')
    : (isUp ? 'text-emerald-600' : 'text-rose-600');
  const Icon = isUp ? TrendingUp : TrendingDown;
  const sign = v > 0 ? '+' : '';
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${tone}`}>
      <Icon className="w-3 h-3" />
      {sign}{formatter(v)}
    </span>
  );
}

export default function MissionTopps() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const authHeaders = useCallback(() => ({
    Authorization: `Bearer ${localStorage.getItem('token') || ''}`,
  }), []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get(`${API}${ENDPOINT}/status`, { headers: authHeaders() });
      setData(res.data);
    } catch (e) {
      toast.error('Failed to load mission status');
    } finally { setLoading(false); }
  }, [authHeaders]);

  useEffect(() => { load(); }, [load]);

  const runSnapshot = async () => {
    setBusy(true);
    try {
      const { data: res } = await axios.post(`${API}${ENDPOINT}/snapshot`, {}, {
        headers: authHeaders(), timeout: 120000,
      });
      toast.success('Snapshot captured');
      await load();
    } catch (e) {
      toast.error(`Snapshot failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setBusy(false); }
  };

  const latest = data?.latest_snapshot;
  const our = latest?.our || {};
  const competitors = latest?.competitors || [];
  const primary = competitors.find(c => c.is_primary) || competitors[0] || {};
  const gap = latest?.gap_to_primary || {};
  const delta_lw = latest?.delta_vs_last_week || {};
  const milestones = data?.milestones || [];
  const currentMonth = data?.current_month || 1;

  return (
    <div className="space-y-6" data-testid="mission-topps-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Target className="w-6 h-6 text-amber-600" />
            Mission: Narrow the Gap to Topps Tiles
          </h1>
          <p className="text-sm text-slate-600 mt-1 max-w-2xl">
            12-month roadmap. Tracks our Domain Rating, organic traffic, referring
            domains, and keyword overlap vs Topps Tiles every Monday. Telegram pings
            you only when the gap <em>widens</em>.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={load} variant="outline" data-testid="mission-refresh-btn">
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </Button>
          <Button onClick={runSnapshot} disabled={busy} data-testid="mission-snapshot-btn">
            {busy ? 'Capturing…' : 'Capture snapshot now'}
          </Button>
        </div>
      </div>

      {/* Headline gap card */}
      <Card className="p-5 bg-gradient-to-br from-amber-50 to-orange-50 border-amber-200" data-testid="mission-headline-card">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <Metric
            label="Our DR (Ahrefs)"
            value={our.dr ?? '—'}
            delta={delta(delta_lw.dr, num)}
            testid="mission-our-dr"
          />
          <Metric
            label={`${primary.label || 'Topps'} DR`}
            value={primary.dr ?? '—'}
            extra={gap.dr_gap !== undefined ? `gap: ${gap.dr_gap}` : null}
            testid="mission-primary-dr"
          />
          <Metric
            label="Our organic traffic / mo"
            value={num(our.organic_traffic)}
            delta={delta(delta_lw.organic_traffic, num)}
            testid="mission-our-traffic"
          />
          <Metric
            label={`Gap vs ${primary.label || 'Topps'}`}
            value={gap.traffic_ratio ? `1/${gap.traffic_ratio}×` : '—'}
            extra={gap.traffic_gap !== undefined ? `${num(gap.traffic_gap)} visits behind` : null}
            testid="mission-traffic-ratio"
          />
        </div>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-6 pt-4 border-t border-amber-200">
          <Metric
            label="Our referring domains"
            value={num(our.refdomains)}
            delta={delta(delta_lw.refdomains, num)}
            testid="mission-our-refdomains"
          />
          <Metric
            label={`${primary.label || 'Topps'} ref. domains`}
            value={num(primary.refdomains)}
            extra={gap.refdomains_gap !== undefined ? `gap: ${num(gap.refdomains_gap)}` : null}
            testid="mission-primary-refdomains"
          />
          <Metric
            label="Our keywords ranking"
            value={num(our.organic_keywords)}
            delta={delta(delta_lw.organic_keywords, num)}
            testid="mission-our-keywords"
          />
        </div>
        {!latest && (
          <p className="mt-4 text-sm text-slate-600">
            No snapshot yet — click <em>Capture snapshot now</em> to start tracking the gap.
          </p>
        )}
      </Card>

      {/* Competitor table */}
      <Card className="p-4" data-testid="mission-competitors-card">
        <h2 className="text-lg font-medium mb-3 flex items-center gap-2">
          <Flag className="w-5 h-5 text-rose-600" /> Competitor snapshot
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-slate-500">
                <th className="py-2 pr-3">Domain</th>
                <th className="py-2 pr-3">DR</th>
                <th className="py-2 pr-3">Organic visits / mo</th>
                <th className="py-2 pr-3">Ref. domains</th>
                <th className="py-2 pr-3">Keywords</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b bg-amber-50/40">
                <td className="py-2 pr-3 font-medium">{`tilestation.co.uk (us)`}</td>
                <td className="py-2 pr-3">{our.dr ?? '—'}</td>
                <td className="py-2 pr-3">{num(our.organic_traffic)}</td>
                <td className="py-2 pr-3">{num(our.refdomains)}</td>
                <td className="py-2 pr-3">{num(our.organic_keywords)}</td>
              </tr>
              {competitors.map(c => (
                <tr key={c.domain} className="border-b">
                  <td className="py-2 pr-3 flex items-center gap-2">
                    {c.label}
                    {c.is_primary && <Badge variant="outline" className="text-xs">primary</Badge>}
                  </td>
                  <td className="py-2 pr-3">{c.dr ?? '—'}</td>
                  <td className="py-2 pr-3">{num(c.organic_traffic)}</td>
                  <td className="py-2 pr-3">{num(c.refdomains)}</td>
                  <td className="py-2 pr-3">{num(c.organic_keywords)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Milestones */}
      <Card className="p-4" data-testid="mission-milestones-card">
        <h2 className="text-lg font-medium mb-3 flex items-center gap-2">
          <Calendar className="w-5 h-5 text-slate-600" />
          12-month milestones — currently month <span className="text-amber-700">{currentMonth}</span> of 12
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {milestones.map(m => (
            <div
              key={m.month}
              className={`border rounded p-3 ${STATUS_TONE[m.status] || ''}`}
              data-testid={`mission-milestone-${m.month}`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-semibold">Month {m.month}</span>
                <Badge variant="outline" className="text-xs uppercase">{m.status}</Badge>
              </div>
              <div className="text-sm font-medium mb-1">{m.label}</div>
              <p className="text-xs text-slate-600 leading-snug">{m.summary}</p>
              <ul className="mt-2 space-y-0.5 text-xs">
                {Object.entries(m.metrics || {}).map(([k, v]) => (
                  <li key={k}><span className="text-slate-500">{k}:</span> <span className="font-mono">{String(v)}</span></li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>

      {/* History note */}
      {data?.history?.length > 0 && (
        <Card className="p-4" data-testid="mission-history-card">
          <h2 className="text-lg font-medium mb-2">History — {data.history.length} snapshots</h2>
          <p className="text-xs text-slate-500 mb-3">
            Captured every Monday 06:30 BST. Showing latest 10.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-slate-500">
                  <th className="py-1 pr-2">Date</th>
                  <th className="py-1 pr-2">Our DR</th>
                  <th className="py-1 pr-2">Our visits</th>
                  <th className="py-1 pr-2">DR gap</th>
                  <th className="py-1 pr-2">Traffic gap</th>
                </tr>
              </thead>
              <tbody>
                {data.history.slice(-10).reverse().map((h, idx) => (
                  <tr key={idx} className="border-b">
                    <td className="py-1 pr-2">{h.captured_at ? new Date(h.captured_at).toLocaleDateString('en-GB') : '—'}</td>
                    <td className="py-1 pr-2">{h.our?.dr ?? '—'}</td>
                    <td className="py-1 pr-2">{num(h.our?.organic_traffic)}</td>
                    <td className="py-1 pr-2">{h.gap_to_primary?.dr_gap ?? '—'}</td>
                    <td className="py-1 pr-2">{num(h.gap_to_primary?.traffic_gap)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function Metric({ label, value, delta: deltaNode, extra, testid }) {
  return (
    <div data-testid={testid}>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-2">
        {extra && <span>{extra}</span>}
        {deltaNode}
      </div>
    </div>
  );
}
