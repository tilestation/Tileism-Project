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
import { ImageOff, CheckCircle2, Eraser, RefreshCw, ShieldAlert, CloudDownload } from 'lucide-react';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const LIVE_SITE_URL = 'https://www.tilestation.co.uk';

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

  if (!data) return null;

  const nameDrift = data.name_drift || 0;
  const allClean = data.missing_images_total === 0 && data.untrimmed_names === 0 && nameDrift === 0;

  if (allClean) {
    return (
      <div className="px-4 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200" data-testid="data-health-card">
        <div className="flex items-center gap-2 text-sm text-emerald-700">
          <CheckCircle2 className="w-4 h-4" />
          Catalogue data healthy — photos, clean names and storefront names all match Supplier Products.
        </div>
        {isPreviewEnv() && <LiveSyncRow onSynced={load} />}
      </div>
    );
  }

  return (
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
  );
};

export default DataHealthCard;
