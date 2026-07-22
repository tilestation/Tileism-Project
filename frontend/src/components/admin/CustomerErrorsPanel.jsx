/**
 * Customer Errors Panel — embedded in Live Visitors. Shows the last 24h of
 * red toasts / API failures / JS crashes that real customers hit on the
 * storefront, with breadcrumb trails so you can call them before they bounce.
 */
import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  AlertTriangle, RefreshCw, Trash2, ChevronDown, ChevronUp, Loader2,
  Mail, Globe, Clock, Bug,
} from 'lucide-react';
import { Button } from '../ui/button';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const REFRESH_MS = 30_000;

function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

const TYPE_STYLES = {
  toast:     { bg: 'bg-amber-50',  text: 'text-amber-800',  border: 'border-amber-200',  label: 'Toast' },
  api:       { bg: 'bg-rose-50',   text: 'text-rose-800',   border: 'border-rose-200',   label: 'API' },
  network:   { bg: 'bg-orange-50', text: 'text-orange-800', border: 'border-orange-200', label: 'Network' },
  js:        { bg: 'bg-red-50',    text: 'text-red-800',    border: 'border-red-200',    label: 'JS crash' },
  unhandled: { bg: 'bg-purple-50', text: 'text-purple-800', border: 'border-purple-200', label: 'Promise' },
};

/** user_tier badge — lets admins spot at a glance whether a crash cost
 * a paying trade customer (£££ priority) or an anonymous browser. */
const TIER_STYLES = {
  trade:  { bg: 'bg-emerald-50', text: 'text-emerald-800', border: 'border-emerald-200', label: 'Trade' },
  retail: { bg: 'bg-sky-50',     text: 'text-sky-800',     border: 'border-sky-200',     label: 'Retail' },
  admin:  { bg: 'bg-slate-100',  text: 'text-slate-700',   border: 'border-slate-300',   label: 'Admin' },
  guest:  { bg: 'bg-gray-50',    text: 'text-gray-600',    border: 'border-gray-200',    label: 'Guest' },
};

function ErrorRow({ row }) {
  const [open, setOpen] = useState(false);
  const style = TYPE_STYLES[row.error_type] || TYPE_STYLES.toast;
  const tierStyle = TIER_STYLES[row.user_tier] || TIER_STYLES.guest;
  return (
    <div
      className="border-b border-gray-100 last:border-0"
      data-testid={`customer-error-row-${row.session_id}-${row.created_at}`}
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors flex items-start gap-3"
      >
        <span className={`flex-shrink-0 inline-flex items-center text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${style.bg} ${style.text} ${style.border}`}>
          {style.label}{row.status_code ? ` ${row.status_code}` : ''}
        </span>
        {/* Tier pill — trade & retail crashes are money-losing, admin is */}
        {/* our own noise, guest is anonymous browsers. */}
        <span
          className={`flex-shrink-0 inline-flex items-center text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded border ${tierStyle.bg} ${tierStyle.text} ${tierStyle.border}`}
          data-testid={`customer-error-tier-${row.user_tier || 'guest'}`}
          title={`Viewer tier: ${tierStyle.label}`}
        >
          {tierStyle.label}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-900 font-medium truncate" title={row.message}>
            {row.message}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5 text-[11px] text-gray-500">
            {row.page_url ? (
              <a
                href={row.page_url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-blue-700 hover:text-blue-900 hover:underline font-medium"
                title="Open this page in a new tab to reproduce the error"
              >
                <Globe className="w-3 h-3" /> {row.page_url}
              </a>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Globe className="w-3 h-3" /> —
              </span>
            )}
            {row.customer_email && (
              <span className="inline-flex items-center gap-1 text-blue-700 font-medium">
                <Mail className="w-3 h-3" /> {row.customer_email}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3 h-3" /> {timeAgo(row.created_at)}
            </span>
          </div>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-gray-400 mt-0.5" /> : <ChevronDown className="w-4 h-4 text-gray-400 mt-0.5" />}
      </button>
      {open && (
        <div className="px-4 pb-3 pt-1 bg-gray-50 text-xs text-gray-700 space-y-2 border-t border-gray-100">
          {row.page_url && (
            <div>
              <a
                href={row.page_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-md transition-colors"
                data-testid={`customer-error-open-page-${row.session_id}`}
              >
                <Globe className="w-3.5 h-3.5" />
                Reproduce on this page
              </a>
            </div>
          )}
          {String(row.message || '').trim().toLowerCase().startsWith('script error') && (
            <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded p-2 text-[11px]">
              <b>Note:</b> Browsers redact the actual error message to literally "Script error." when
              a cross-origin script fails — typically a customer's <b>browser extension, ad-blocker
              or page translator</b>. This is almost never our code crashing. Click "Reproduce on
              this page" to verify.
            </div>
          )}
          {row.api_endpoint && (
            <div><b>Endpoint:</b> <code className="bg-white px-1.5 py-0.5 rounded border border-gray-200 font-mono break-all">{row.api_endpoint}</code></div>
          )}
          <div>
            <b>Last actions before error:</b>
            {row.breadcrumbs?.length ? (
              <ol className="mt-1 space-y-0.5 list-decimal list-inside">
                {row.breadcrumbs.map((b, i) => (
                  <li key={i}>
                    <span className="font-mono text-[10px] uppercase text-gray-500 mr-1.5">{b.t}</span>
                    {b.v}
                  </li>
                ))}
              </ol>
            ) : <span className="text-gray-400 ml-1">No breadcrumbs captured</span>}
          </div>
          {row.stack && (
            <details>
              <summary className="cursor-pointer text-gray-600">Stack trace</summary>
              <pre className="mt-1 p-2 bg-white rounded border border-gray-200 text-[10px] font-mono overflow-x-auto max-h-40">{row.stack}</pre>
            </details>
          )}
          <div className="text-[10px] text-gray-400 pt-1">
            Session <code>{row.session_id}</code> · UA: {row.user_agent?.slice(0, 80) || '—'}
          </div>
        </div>
      )}
    </div>
  );
}

export default function CustomerErrorsPanel() {
  const [rows, setRows] = useState([]);
  const [total24h, setTotal24h] = useState(0);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const fetchRows = useCallback(async () => {
    try {
      const r = await axios.get(`${API_URL}/api/client-errors/recent?hours=24&limit=50`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      setRows(r.data?.errors || []);
      setTotal24h(r.data?.total_24h || 0);
    } catch (e) {
      // Silent — panel just shows empty if it can't load.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRows();
    const id = setInterval(fetchRows, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchRows]);

  const clearAll = async () => {
    if (!window.confirm('Wipe all customer-error logs? This cannot be undone.')) return;
    setClearing(true);
    try {
      await axios.delete(`${API_URL}/api/client-errors/clear`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      toast.success('Cleared');
      await fetchRows();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to clear');
    } finally {
      setClearing(false);
    }
  };

  const headerCount = total24h;
  const headerColor = headerCount === 0
    ? 'bg-emerald-100 text-emerald-700 border-emerald-200'
    : headerCount < 5
      ? 'bg-amber-100 text-amber-800 border-amber-200'
      : 'bg-rose-100 text-rose-800 border-rose-200';

  return (
    <div
      className="bg-white border border-gray-200 rounded-xl overflow-hidden"
      data-testid="customer-errors-panel"
    >
      <div className="px-5 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setCollapsed(c => !c)}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <Bug className="w-4 h-4 text-rose-500" />
          <h3 className="text-sm font-semibold text-gray-900">
            Customer issues right now
          </h3>
          <span className={`inline-flex items-center text-[11px] font-bold px-2 py-0.5 rounded-full border ${headerColor}`}>
            {headerCount} in 24h
          </span>
          {collapsed ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronUp className="w-4 h-4 text-gray-400" />}
        </button>
        <div className="flex items-center gap-1">
          <Button
            onClick={fetchRows}
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            data-testid="customer-errors-refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            onClick={clearAll}
            disabled={clearing || rows.length === 0}
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-rose-600 hover:text-rose-700 hover:bg-rose-50"
            data-testid="customer-errors-clear"
            title="Clear feed (super_admin only)"
          >
            {clearing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
          </Button>
        </div>
      </div>
      {!collapsed && (
        <div data-testid="customer-errors-list">
          {loading && rows.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-gray-400">
              <Loader2 className="w-4 h-4 animate-spin inline mr-1.5" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="px-5 py-8 text-center">
              <AlertTriangle className="w-5 h-5 text-emerald-500 inline mr-1.5" />
              <span className="text-sm text-gray-500">No customer errors in the last 24h. </span>
            </div>
          ) : (
            rows.map((row, idx) => (
              <ErrorRow key={`${row.session_id}-${row.created_at}-${idx}`} row={row} />
            ))
          )}
        </div>
      )}
      <div className="px-4 py-2 bg-gray-50 border-t border-gray-100 text-[10px] text-gray-400">
        Auto-refresh every 30s · Daily digest emails admins at 09:00 UTC ·
        Telegram alerts fire instantly when the <code>customer_error</code> toggle is on.
      </div>
    </div>
  );
}
