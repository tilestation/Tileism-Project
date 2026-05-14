/**
 * SchemaDriftBanner (May 14, 2026)
 *
 * Thin single-line banner that pings `/api/__version__` every 5 min,
 * shows the local backend's git SHA + a green dot when the schema
 * fingerprint matches the recorded prod baseline, and turns RED with
 * the list of flipped endpoints the moment any drift is detected.
 *
 * Renders below the OutageBanner on every admin page. Dismissable only
 * by clicking through to the version-drift admin view (so drift can
 * never be silently ignored).
 */
import React, { useEffect, useState, useCallback } from 'react';
import { CheckCircle2, AlertTriangle, RefreshCw, X } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const REFRESH_MS = 5 * 60 * 1000; // 5 minutes
const STORAGE_KEY = 'schemaDriftDismissedFp';

const fmtAgo = (iso) => {
  if (!iso) return '';
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
};

const SchemaDriftBanner = () => {
  const [state, setState] = useState({
    loading: true,
    error: null,
    local: null,         // local backend version payload
    baseline: null,      // recorded prod baseline (from schema_baselines collection)
    flipped: [],
  });
  const [tick, setTick] = useState(0);

  const fetchState = useCallback(async () => {
    try {
      // Local backend's current fingerprint
      const localRes = await fetch(`${API_URL}/api/__version__`);
      const local = localRes.ok ? await localRes.json() : null;

      // Look up the prod baseline via the uptime monitor's exposed state.
      // (Uptime monitor writes the prod fingerprint to `schema_baselines`
      // and surfaces it in the same response when present.)
      let baseline = null;
      try {
        const upRes = await fetch(`${API_URL}/api/admin/uptime-monitor`, {
          credentials: 'include',
        });
        if (upRes.ok) {
          // Best-effort — the endpoint may not yet include baseline data
          // but we don't fail the banner if it doesn't.
          const upJson = await upRes.json();
          baseline = upJson?.schema_baseline || null;
        }
      } catch (_) { /* ignore — baseline is optional */ }

      // Compute the per-endpoint flips when both sides are present
      const flipped = [];
      if (baseline?.per_endpoint && local?.schema_endpoints) {
        for (const [cid, info] of Object.entries(local.schema_endpoints)) {
          const oldFp = baseline.per_endpoint?.[cid]?.fp;
          const newFp = info?.fp;
          if (oldFp && newFp && oldFp !== newFp) flipped.push(cid);
        }
      }

      setState({
        loading: false,
        error: null,
        local,
        baseline,
        flipped,
      });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: e?.message || 'fetch failed' }));
    }
  }, []);

  useEffect(() => {
    fetchState();
    const id = setInterval(() => { fetchState(); setTick((t) => t + 1); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchState]);

  // Refresh the "Xm ago" string every 30s without re-fetching
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  if (state.loading || state.error || !state.local) return null;

  const localFp = state.local.schema_fingerprint;
  const baselineFp = state.baseline?.fingerprint;
  const hasBaseline = !!baselineFp;
  const isDrift = hasBaseline && localFp !== baselineFp && state.flipped.length > 0;
  const lastChecked = state.local?.computed_at;

  // Dismiss is per-fingerprint, so a new drift always shows
  const dismissedFp = (typeof window !== 'undefined') ? localStorage.getItem(STORAGE_KEY) : null;
  if (!isDrift && dismissedFp === localFp) return null;

  if (!hasBaseline) {
    return (
      <div
        className="px-4 py-1.5 text-xs flex items-center gap-2 bg-slate-50 border-b border-slate-200 text-slate-600"
        data-testid="schema-drift-banner-pending"
      >
        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
        <span>schema fingerprint: <code className="font-mono text-[11px]">{localFp}</code></span>
        <span className="text-slate-400">·</span>
        <span>baseline not yet recorded — first prod check pending</span>
      </div>
    );
  }

  if (isDrift) {
    return (
      <div
        className="px-4 py-2 text-sm flex items-center gap-3 bg-red-50 border-b border-red-300 text-red-900"
        data-testid="schema-drift-banner-drift"
      >
        <AlertTriangle className="w-4 h-4 text-red-700 flex-shrink-0" />
        <span className="font-semibold">API contract drift detected:</span>
        <span>
          {state.flipped.length === 1
            ? `1 endpoint flipped (${state.flipped[0]})`
            : `${state.flipped.length} endpoints flipped: ${state.flipped.join(', ')}`}
        </span>
        <span className="text-red-700 hidden sm:inline">·</span>
        <code className="font-mono text-[11px] text-red-700 hidden sm:inline">{baselineFp} → {localFp}</code>
        <a
          href="/admin/uptime"
          className="ml-auto px-3 py-1 rounded-full bg-red-700 text-white text-xs font-semibold hover:bg-red-800"
          data-testid="schema-drift-banner-details-link"
        >
          Investigate
        </a>
      </div>
    );
  }

  return (
    <div
      className="px-4 py-1 text-xs flex items-center gap-2 bg-emerald-50 border-b border-emerald-200 text-emerald-900"
      data-testid="schema-drift-banner-match"
    >
      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700 flex-shrink-0" />
      <span><strong>prod ↔ preview API contract match</strong></span>
      <span className="text-emerald-700">·</span>
      <code className="font-mono text-[11px]">{localFp}</code>
      <span className="text-emerald-700">·</span>
      <span>last checked {fmtAgo(lastChecked) || 'just now'}</span>
      <button
        type="button"
        onClick={() => { try { localStorage.setItem(STORAGE_KEY, localFp); } catch (_) {} fetchState(); }}
        className="ml-auto p-1 rounded hover:bg-emerald-100"
        title="Hide until next drift"
        data-testid="schema-drift-banner-dismiss"
        aria-label="Dismiss"
      >
        <X className="w-3 h-3" />
      </button>
      {/* Trigger re-render so fmtAgo updates */}
      <span className="hidden">{tick}</span>
    </div>
  );
};

export default SchemaDriftBanner;
