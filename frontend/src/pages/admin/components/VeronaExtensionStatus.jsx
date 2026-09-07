/**
 * VeronaExtensionStatus — Sync Hub → Verona: when data last arrived from the
 * Chrome extension and the latest self-check report the extension posted
 * (v6.1 "Send report to Tile Station"), so support can see exactly what the
 * owner's browser saw without a screenshot.
 */
import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, Bug, RefreshCw } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const ago = (iso) => {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
};

const Flag = ({ ok, label }) => (
  <span className={`inline-flex items-center gap-1 ${ok ? 'text-emerald-700' : 'text-rose-700 font-semibold'}`}>
    {ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}{label}
  </span>
);

const VeronaExtensionStatus = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/verona/last-receive`);
      setData(await res.json());
    } catch (e) {
      setData({ error: e.message });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  if (!data) return null;
  const r = data.last_report;
  return (
    <div className="mt-3 pt-3 border-t border-blue-200 text-xs text-blue-900 space-y-1.5" data-testid="verona-extension-status">
      <div className="flex items-center gap-3 flex-wrap">
        <span data-testid="verona-last-data">Last products received: <b>{ago(data.last_data?.at)}</b>{data.last_data?.source ? ` (${data.last_data.source.replace('browser_extension_', '')})` : ''}</span>
        <span data-testid="verona-last-ping">Last contact: <b>{ago(data.last_ping?.at)}</b></span>
        <span>Awaiting review: <b>{data.staged_count ?? 0}</b></span>
        <button type="button" onClick={load} className="ml-auto inline-flex items-center gap-1 text-blue-700 hover:text-blue-900" data-testid="verona-status-refresh">
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> refresh
        </button>
      </div>
      {r ? (
        <div className="bg-white/70 border border-blue-200 rounded-md px-3 py-2 space-y-1" data-testid="verona-last-report">
          <div className="flex items-center gap-2 flex-wrap">
            <Bug className="w-3.5 h-3.5 text-blue-700" />
            <b>Latest self-check from the extension</b>
            <span className="text-blue-700">v{r.version} · {ago(r.at)} · ref {r.id}</span>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Flag ok={r.worker_ok} label="engine" />
            <Flag ok={r.server_ok} label="server" />
            <Flag ok={!r.page_cloudflare && !r.page_not_verona && (r.page_products ?? 0) > 0} label={r.page_cloudflare ? 'page: Cloudflare check' : r.page_not_verona ? 'page: not on Verona' : `page: ${r.page_products ?? 0} products found`} />
            <span>engine state: <b>{r.job_status || 'idle'}</b>{r.job_synced != null ? ` (${r.job_synced} sent, ${r.job_failed || 0} failed)` : ''}</span>
            {r.error_count > 0 && <span className="text-rose-700">{r.error_count} problems logged</span>}
          </div>
          {r.job_last_status && <div className="text-blue-800">Engine: {r.job_last_status}</div>}
          {r.last_error && <div className="text-rose-800 break-words">Last problem: <b>{r.last_error.context}</b> — {r.last_error.detail}</div>}
          {r.page_url && <div className="text-blue-600 truncate">Page: {r.page_url}</div>}
        </div>
      ) : (
        <div className="text-blue-700">No self-check report yet — in the extension popup (v6.1) press <b>Send report to Tile Station</b> and it appears here.</div>
      )}
    </div>
  );
};

export default VeronaExtensionStatus;
