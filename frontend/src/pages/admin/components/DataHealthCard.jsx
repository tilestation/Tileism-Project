/**
 * DataHealthCard — admin-dashboard card for catalogue data hygiene:
 *   • products with no photos, per group, deep-linking to the matching
 *     Manager with the "no photos" filter pre-enabled (?noimages=1)
 *   • one-click "Trim stray spaces" cleanup across all name fields
 *   • Name Guard — warns when storefront names drift from Supplier Products,
 *     with one-click "Fix now" (runs the existing sync-to-epos-website repair)
 *   • Live Data Sync — PREVIEW ONLY: pull the live site's catalogue into
 *     this environment so testing always matches reality
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ImageOff, CheckCircle2, Eraser, RefreshCw, ShieldAlert, CloudDownload, AlertTriangle, Siren, Chrome } from 'lucide-react';
import { toast } from 'sonner';
import SitePricingScan from './managers/SitePricingScan';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const LIVE_SITE_URL = 'https://tile-station-production.up.railway.app';

const GROUP_ROUTES = {
  tiles: '/admin/tiles',
  materials: '/admin/materials',
  flooring: '/admin/flooring',
  bathroom: '/admin/bathroom',
  underfloor_heating: '/admin/underfloor-heating',
  'underfloor-heating': '/admin/underfloor-heating',
  tools: '/admin/tools',
};

// Live sync only ever appears on preview/local — never on the live site
const isPreviewEnv = () => {
  const h = window.location.hostname;
  return !h.includes('tilestation.co.uk');
};

const LiveSyncRow = ({ onSynced }) => {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [syncing, setSyncing] = useState(false);

  const runSync = async () => {
    if (!email || !password) { toast.error('Enter your LIVE site admin login'); return; }
    if (!window.confirm('This REPLACES the preview catalogue with a clean copy of the live site. Continue?')) return;
    setSyncing(true);
    try {
      const res = await fetch(`${API_URL}/api/live-sync/pull-from-live`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({ source_url: LIVE_SITE_URL, live_email: email, live_password: password, confirm: true }),
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.detail || `HTTP ${res.status}`);
      toast.success(`Live data pulled — ${r.total_docs} records now mirror the live site`);
      setOpen(false);
      setPassword('');
      onSynced?.();
    } catch (err) {
      toast.error(`Live sync failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="mt-2" data-testid="live-sync-row">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1.5 text-xs text-sky-700 hover:text-sky-900 font-medium"
          data-testid="live-sync-open-btn"
        >
          <CloudDownload className="w-3.5 h-3.5" />
          Pull data from live site (preview only)
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-lg bg-sky-50 border border-sky-200">
          <CloudDownload className="w-4 h-4 text-sky-600 flex-shrink-0" />
          <span className="text-xs text-sky-800 font-medium">Live admin login:</span>
          <input
            type="email"
            placeholder="live admin email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="px-2 py-1 text-xs border border-sky-300 rounded w-44"
            data-testid="live-sync-email"
          />
          <input
            type="password"
            placeholder="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="px-2 py-1 text-xs border border-sky-300 rounded w-32"
            data-testid="live-sync-password"
          />
          <button
            type="button"
            onClick={runSync}
            disabled={syncing}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-sky-600 text-white text-xs font-semibold hover:bg-sky-700 disabled:opacity-50"
            data-testid="live-sync-run-btn"
          >
            {syncing ? <RefreshCw className="w-3 h-3 animate-spin" /> : <CloudDownload className="w-3 h-3" />}
            {syncing ? 'Pulling…' : 'Pull now'}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="text-xs text-sky-500 hover:text-sky-700" data-testid="live-sync-cancel-btn">Cancel</button>
          <span className="w-full text-[10px] text-sky-600">Copies catalogue + navigation only (never orders/customers). Replaces the preview data completely.</span>
        </div>
      )}
    </div>
  );
};

const timeAgo = (iso) => {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
};

// Red alarm banner — shows when a supplier sync died mid-run or failed to log in
const SyncFailureAlert = () => {
  const [alerts, setAlerts] = useState(null);
  const [dismissing, setDismissing] = useState(false);

  const load = useCallback(() => {
    fetch(`${API_URL}/api/sync-alerts/status`)
      .then(res => (res.ok ? res.json() : null))
      .then(setAlerts)
      .catch(() => setAlerts(null));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!alerts?.has_alerts) return null;

  const dismissAll = async () => {
    setDismissing(true);
    try {
      const res = await fetch(`${API_URL}/api/sync-alerts/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Sync alerts dismissed');
      load();
    } catch (err) {
      toast.error(`Dismiss failed: ${err.message}`);
    } finally {
      setDismissing(false);
    }
  };

  return (
    <div className="rounded-xl border-2 border-red-400 bg-red-50 px-4 py-3 mb-3" data-testid="sync-failure-alert">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Siren className="w-5 h-5 text-red-600 flex-shrink-0" />
          <span className="text-sm font-bold text-red-900">
            Sync failure — supplier stock &amp; prices may be stale
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/admin/sync-hub"
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-red-600 text-white text-xs font-semibold hover:bg-red-700 transition-colors"
            data-testid="sync-alert-open-hub-btn"
          >
            Open Sync Hub →
          </Link>
          <button
            type="button"
            onClick={dismissAll}
            disabled={dismissing}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-red-300 text-red-700 text-xs font-semibold hover:bg-red-100 transition-colors disabled:opacity-50"
            data-testid="sync-alert-dismiss-btn"
          >
            {dismissing ? <RefreshCw className="w-3 h-3 animate-spin" /> : null}
            Dismiss
          </button>
        </div>
      </div>
      <div className="mt-2 space-y-1.5">
        {(alerts.failures || []).map((f) => (
          <div key={f.id} className="flex items-start gap-2 text-xs text-red-800" data-testid={`sync-failure-row-${f.supplier}`}>
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-red-500" />
            <span>
              <b>{f.supplier}</b> ({f.sync_type}) failed {timeAgo(f.occurred_at)} — <span className="font-mono">{f.error}</span>
              {f.email_sent && <span className="ml-1 text-red-500">· email sent</span>}
              {f.telegram_sent && <span className="ml-1 text-red-500">· Telegram sent</span>}
            </span>
          </div>
        ))}
        {(alerts.stuck || []).map((s) => (
          <div key={s.supplier} className="flex items-start gap-2 text-xs text-red-800" data-testid={`sync-stuck-row-${s.supplier}`}>
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-red-500" />
            <span>
              <b>{s.supplier}</b> sync looks <b>stuck</b> — running for {s.running_hours}h ({s.phase || 'unknown phase'}). It has probably died mid-run.
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

// "Last Verona sync received" — proves the Chrome extension is landing data
const VeronaArrivalRow = () => {
  const [info, setInfo] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/api/supplier-sync/verona/last-receive`)
      .then(res => (res.ok ? res.json() : null))
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  if (!info) return null;

  const d = info.last_data;
  let dot = 'bg-red-500';
  let text;
  if (!d) {
    text = 'Verona extension: no product data received yet';
  } else {
    const hrs = (Date.now() - new Date(d.at).getTime()) / 3600000;
    dot = hrs <= 48 ? 'bg-emerald-500' : hrs <= 168 ? 'bg-amber-500' : 'bg-red-500';
    text = `Verona extension: last data received ${timeAgo(d.at)} (${d.synced} product${d.synced !== 1 ? 's' : ''})`;
  }

  const pingNewer = info.last_ping && (!d || new Date(info.last_ping.at) > new Date(d.at));

  return (
    <div className="flex items-center gap-2 mt-2 px-4 py-2 rounded-xl bg-slate-50 border border-slate-200 text-xs text-slate-600" data-testid="verona-arrival-row">
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} data-testid="verona-arrival-dot" />
      <Chrome className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
      <span data-testid="verona-arrival-text">{text}</span>
      {pingNewer && (
        <span className="text-slate-400">· extension connected {timeAgo(info.last_ping.at)}</span>
      )}
      {info.staged_count > 0 && (
        <Link to="/admin/sync-hub?supplier=Verona" className="ml-auto text-sky-600 hover:text-sky-800 font-medium" data-testid="verona-arrival-review-link">
          {info.staged_count} awaiting review →
        </Link>
      )}
    </div>
  );
};

export const DataHealthCard = () => {
  const [data, setData] = useState(null);
  const [trimming, setTrimming] = useState(false);
  const [fixingNames, setFixingNames] = useState(false);

  const load = useCallback(() => {
    fetch(`${API_URL}/api/supplier-sync/products/data-health`)
      .then(res => (res.ok ? res.json() : null))
      .then(setData)
      .catch(() => setData(null));
  }, []);

  useEffect(() => { load(); }, [load]);

  const runTrim = async () => {
    setTrimming(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products/trim-names`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = await res.json();
      toast.success(
        r.total_fixed > 0
          ? `Cleaned ${r.total_fixed} record${r.total_fixed !== 1 ? 's' : ''}${r.examples?.length ? ` — e.g. ${r.examples[0]}` : ''}`
          : 'No stray spaces found — names are already clean'
      );
      load();
    } catch (err) {
      toast.error(`Cleanup failed: ${err.message}`);
    } finally {
      setTrimming(false);
    }
  };

  const fixNameDrift = async () => {
    if (!window.confirm(`Re-align ${nameDrift} storefront name${nameDrift !== 1 ? 's' : ''} to exactly match Supplier Products?`)) return;
    setFixingNames(true);
    try {
      const res = await fetch(`${API_URL}/api/product-name-sanity/sync-to-epos-website`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = await res.json();
      toast.success(`Name Guard: re-aligned ${r.tiles_updated + r.products_updated} storefront/EPOS names with Supplier Products`);
      load();
    } catch (err) {
      toast.error(`Name fix failed: ${err.message}`);
    } finally {
      setFixingNames(false);
    }
  };

  if (!data) return <SyncFailureAlert />;

  const nameDrift = data.name_drift || 0;
  const allClean = data.missing_images_total === 0 && data.untrimmed_names === 0 && nameDrift === 0;

  if (allClean) {
    return (
      <>
        <SyncFailureAlert />
        <div className="px-4 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200" data-testid="data-health-card">
          <div className="flex items-center gap-2 text-sm text-emerald-700">
            <CheckCircle2 className="w-4 h-4" />
            Catalogue data healthy — photos, clean names and storefront names all match Supplier Products.
          </div>
          {isPreviewEnv() && <LiveSyncRow onSynced={load} />}
        </div>
        <VeronaArrivalRow />
      </>
    );
  }

  return (
    <>
      <SyncFailureAlert />
    <div className="rounded-xl border border-rose-200 bg-rose-50/60 px-4 py-3" data-testid="data-health-card">
      {data.missing_images_total > 0 && (
        <>
          <div className="flex items-center gap-2 flex-wrap">
            <ImageOff className="w-4 h-4 text-rose-600 flex-shrink-0" />
            <span className="text-sm font-semibold text-rose-900" data-testid="data-health-missing-images">
              {data.missing_images_total} of {data.total_products} products have no photos
            </span>
            <span className="text-xs text-rose-500">— click a category, then use Edit to drop images in:</span>
          </div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {data.missing_images_by_group.map(({ group, count }) => {
              const route = GROUP_ROUTES[group];
              const label = `${group.replace(/[_-]/g, ' ')} · ${count}`;
              return route ? (
                <Link
                  key={group}
                  to={`${route}?noimages=1`}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-white border border-rose-300 text-rose-800 text-xs font-medium hover:bg-rose-100 transition-colors capitalize"
                  data-testid={`noimages-link-${group}`}
                >
                  <ImageOff className="w-3 h-3" />
                  {label}
                </Link>
              ) : (
                <span key={group} className="inline-flex px-2.5 py-1 rounded-full bg-white/60 border border-rose-200 text-rose-600 text-xs capitalize" title="Manage from All Products" data-testid={`noimages-chip-${group}`}>
                  {label}
                </span>
              );
            })}
          </div>
        </>
      )}
      {nameDrift > 0 && (
        <div className={`flex items-center gap-2 flex-wrap ${data.missing_images_total > 0 ? 'mt-3 pt-3 border-t border-rose-200/60' : ''}`}>
          <ShieldAlert className="w-4 h-4 text-rose-600 flex-shrink-0" />
          <span className="text-sm text-rose-900" data-testid="data-health-name-drift">
            <b>{nameDrift}</b> storefront name{nameDrift !== 1 ? 's don\u2019t' : ' doesn\u2019t'} match Supplier Products
            {data.name_drift_samples?.[0] && (
              <span className="text-xs text-rose-500"> (e.g. &quot;{data.name_drift_samples[0].storefront}&quot; should be &quot;{data.name_drift_samples[0].supplier}&quot;)</span>
            )}
          </span>
          <button
            type="button"
            onClick={fixNameDrift}
            disabled={fixingNames}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-rose-600 text-white text-xs font-semibold hover:bg-rose-700 transition-colors disabled:opacity-50"
            data-testid="fix-name-drift-btn"
          >
            {fixingNames ? <RefreshCw className="w-3 h-3 animate-spin" /> : <ShieldAlert className="w-3 h-3" />}
            {fixingNames ? 'Fixing…' : 'Fix now'}
          </button>
        </div>
      )}
      {data.untrimmed_names > 0 && (
        <div className={`flex items-center gap-2 flex-wrap ${(data.missing_images_total > 0 || nameDrift > 0) ? 'mt-3 pt-3 border-t border-rose-200/60' : ''}`}>
          <Eraser className="w-4 h-4 text-rose-600 flex-shrink-0" />
          <span className="text-sm text-rose-900" data-testid="data-health-untrimmed">
            <b>{data.untrimmed_names}</b> product name{data.untrimmed_names !== 1 ? 's have' : ' has'} stray spaces (e.g. &quot;&nbsp;Xtreme Cleaner&quot;)
          </span>
          <button
            type="button"
            onClick={runTrim}
            disabled={trimming}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-rose-600 text-white text-xs font-semibold hover:bg-rose-700 transition-colors disabled:opacity-50"
            data-testid="trim-names-btn"
          >
            {trimming ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Eraser className="w-3 h-3" />}
            {trimming ? 'Cleaning…' : 'Trim stray spaces'}
          </button>
        </div>
      )}
      {isPreviewEnv() && <LiveSyncRow onSynced={load} />}
    </div>
    <VeronaArrivalRow />
    <div className="mt-2"><SitePricingScan /></div>
    </>
  );
};

export default DataHealthCard;
