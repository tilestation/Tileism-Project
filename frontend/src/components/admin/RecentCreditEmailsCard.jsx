import React, { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Mail, RefreshCw, CheckCircle2, AlertCircle, Send, Loader2, ChevronDown, ChevronUp, ClipboardCopy, Check, Store, Globe, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog';

const API_URL = process.env.REACT_APP_BACKEND_URL;

/**
 * Recent Credit-Earned Emails — visibility log + one-click re-send for the
 * "You just earned £X credit at {showroom}" trade re-engagement email.
 *
 * Renders on /admin/sales-hub above the regular hub cards. Reads from
 * `GET /api/invoices/credit-emails/recent` and re-fires via
 * `POST /api/invoices/{id}/credit-emails/resend`.
 *
 * 24 Feb 2026 — added collapsed-by-default state (the list was growing
 * and pushing EPOS tabs off-screen) + per-row showroom-source badge +
 * click-trader-name → tiny earn/redeem breakdown popup.
 */
function relativeTime(iso) {
  if (!iso) return '';
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '';
  const seconds = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Tiny pill showing where a credit transaction came from — in-store
// shows the showroom name; online shows a globe + "Online". Falls back
// to a dash so legacy data doesn't render an empty pill.
function SourceBadge({ channel, showroomName }) {
  if (channel === 'online') {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-sky-50 text-sky-800 border border-sky-200 font-medium">
        <Globe className="h-2.5 w-2.5" />
        Online
      </span>
    );
  }
  if (!showroomName) {
    return <span className="text-[11px] text-muted-foreground">—</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-emerald-50 text-emerald-800 border border-emerald-200 font-medium" title={`In-store at ${showroomName}`}>
      <Store className="h-2.5 w-2.5" />
      {showroomName}
    </span>
  );
}

export default function RecentCreditEmailsCard() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ sent_count: 0, failed_count: 0, total: 0 });
  const [resendingId, setResendingId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [copiedId, setCopiedId] = useState(null);

  // Collapsed by default. The list grew large enough to push EPOS tabs
  // off-screen on small monitors. Persist preference to localStorage so
  // an admin who likes it open isn't forced to re-expand every visit.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const saved = localStorage.getItem('credit-emails-card-collapsed');
      return saved === null ? true : saved === '1';
    } catch { return true; }
  });
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem('credit-emails-card-collapsed', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  // Trade-credit history modal — opens when a trader name is clicked.
  const [historyTrader, setHistoryTrader] = useState(null); // { trade_account_number, name }
  const [historyData, setHistoryData] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const openTraderHistory = async (tradeAccountNumber, displayName) => {
    if (!tradeAccountNumber) return;
    setHistoryTrader({ trade_account_number: tradeAccountNumber, name: displayName });
    setHistoryData(null);
    setHistoryLoading(true);
    try {
      const token = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
      const res = await axios.get(
        `${API_URL}/api/invoices/credit-history/${encodeURIComponent(tradeAccountNumber)}?limit=50`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      );
      setHistoryData(res.data);
    } catch (err) {
      toast.error('Could not load credit history');
      setHistoryTrader(null);
    } finally {
      setHistoryLoading(false);
    }
  };

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
      const res = await axios.get(`${API_URL}/api/invoices/credit-emails/recent?limit=20`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      setRows(res.data?.rows || []);
      setStats({
        sent_count: res.data?.sent_count || 0,
        failed_count: res.data?.failed_count || 0,
        total: res.data?.total || 0,
      });
    } catch (err) {
      toast.error('Could not load credit-email history');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleResend = async (invoiceId, invoiceNo) => {
    if (!window.confirm(`Re-send the credit-earned email for invoice ${invoiceNo}?`)) return;
    try {
      setResendingId(invoiceId);
      const token = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
      const res = await axios.post(
        `${API_URL}/api/invoices/${invoiceId}/credit-emails/resend`,
        {},
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      );
      if (res.data?.ok) {
        toast.success(`Email re-sent to ${res.data.customer_email}`);
      } else {
        toast.error(`Re-send failed: ${res.data?.error || 'unknown error'}`);
      }
      await load();
    } catch (err) {
      const detail = err.response?.data?.detail || err.message;
      toast.error(`Re-send failed: ${detail}`);
    } finally {
      setResendingId(null);
    }
  };

  // Copy an itemised plain-text breakdown of a single invoice so admins can
  // paste it into a reply/WhatsApp when a trader queries their statement.
  // Matches the monospace layout used on the EPOS TradeCustomerChip so the
  // two surfaces feel identical.
  const handleCopyBreakdown = async (row) => {
    const breakdown = Array.isArray(row?.trade_credit_breakdown) ? row.trade_credit_breakdown : [];
    if (breakdown.length === 0) return;
    const biz = row.trade_business_name || row.customer_name || 'Trade customer';
    const tRef = row.trade_account_number ? ` (${row.trade_account_number})` : '';
    const header = `Credit-back breakdown — ${biz}${tRef} · ${row.invoice_no || ''}`;
    const separator = '─'.repeat(Math.min(56, header.length + 2));
    const nameCol = 28;
    const calcCol = 18;
    const lines = breakdown.map((r) => {
      const name = (r.product_name || r.sku || 'Unnamed line').toString();
      const rate = Number(r.rate) || 0;
      const net = Number(r.net) || 0;
      const credit = Number(r.credit) || 0;
      const rateTxt = `${rate.toFixed(rate % 1 === 0 ? 0 : 1)}% × £${net.toFixed(2)}`;
      const namePart =
        name.length > nameCol ? `${name.slice(0, nameCol - 1)}…` : name.padEnd(nameCol);
      return `${namePart}  ${rateTxt.padEnd(calcCol)} £${credit.toFixed(2)}`;
    });
    const total = Number(row.trade_credit_earned || 0).toFixed(2);
    const totalLine = `${'Total credit'.padEnd(nameCol)}  ${' '.padEnd(calcCol)} £${total}`;
    const plain = [header, separator, ...lines, separator, totalLine].join('\n');

    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(plain);
      } else {
        const ta = document.createElement('textarea');
        ta.value = plain;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedId(row.id);
      toast.success('Breakdown copied — ready to paste', { duration: 2200 });
      setTimeout(() => setCopiedId((cur) => (cur === row.id ? null : cur)), 1800);
    } catch {
      toast.error('Could not copy — please try again');
    }
  };

  if (!loading && rows.length === 0) return null;

  return (
    <div
      className="rounded-lg border border-emerald-200 bg-white shadow-sm"
      data-testid="credit-emails-card"
    >
      <div className="flex items-center justify-between p-4 border-b border-gray-100 flex-wrap gap-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex items-center gap-2 text-left flex-1 min-w-0 group"
          aria-expanded={!collapsed}
          aria-controls="credit-emails-body"
          data-testid="credit-emails-toggle"
        >
          <div className="w-8 h-8 rounded-md bg-emerald-100 flex items-center justify-center shrink-0">
            <Mail className="w-4 h-4 text-emerald-700" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-gray-900 text-sm flex items-center gap-1.5">
              Trade Credit Emails — recent dispatches
              {collapsed ? (
                <ChevronDown className="w-4 h-4 text-gray-400 group-hover:text-gray-600 transition-colors" />
              ) : (
                <ChevronUp className="w-4 h-4 text-gray-400 group-hover:text-gray-600 transition-colors" />
              )}
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {stats.total > 0 ? (
                <>
                  Last {stats.total}:{' '}
                  <span className="text-emerald-700 font-medium">{stats.sent_count} sent</span>
                  {stats.failed_count > 0 && (
                    <>
                      {' · '}
                      <span className="text-rose-700 font-medium">{stats.failed_count} failed</span>
                    </>
                  )}
                  {collapsed && ' · click to expand'}
                </>
              ) : (
                'No emails dispatched yet'
              )}
            </p>
          </div>
        </button>
        {!collapsed && (
          <Button
            variant="outline"
            size="sm"
            onClick={load}
            disabled={loading}
            data-testid="credit-emails-refresh"
          >
            {loading ? (
              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3 mr-1" />
            )}
            Refresh
          </Button>
        )}
      </div>

      {!collapsed && (
      <div id="credit-emails-body" className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
            <tr>
              <th className="text-left py-2 px-4 font-semibold">Invoice</th>
              <th className="text-left py-2 px-4 font-semibold">Trader</th>
              <th className="text-left py-2 px-4 font-semibold">Source</th>
              <th className="text-right py-2 px-4 font-semibold">Credit</th>
              <th className="text-left py-2 px-4 font-semibold">Email</th>
              <th className="text-left py-2 px-4 font-semibold">When</th>
              <th className="text-right py-2 px-4 font-semibold">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const sent = r.credit_email_sent;
              const breakdown = Array.isArray(r.trade_credit_breakdown) ? r.trade_credit_breakdown : [];
              const hasBreakdown = breakdown.length > 0;
              const isExpanded = expandedId === r.id;
              const isCopied = copiedId === r.id;
              return (
                <React.Fragment key={r.id}>
                  <tr
                    className="border-t border-gray-100 hover:bg-gray-50/60"
                    data-testid={`credit-email-row-${r.id}`}
                  >
                    <td className="py-2 px-4 font-mono text-xs text-gray-900">
                      {r.invoice_no}
                    </td>
                    <td className="py-2 px-4">
                      <div className="text-xs">
                        {r.trade_account_number ? (
                          <button
                            type="button"
                            onClick={() => openTraderHistory(r.trade_account_number, r.trade_business_name || r.customer_name)}
                            className="font-medium text-gray-900 hover:text-emerald-700 hover:underline focus:outline-none focus:underline text-left"
                            title="View credit history for this trader"
                            data-testid={`credit-email-trader-${r.id}`}
                          >
                            {r.trade_business_name || r.customer_name || '—'}
                          </button>
                        ) : (
                          <div className="font-medium text-gray-900">
                            {r.trade_business_name || r.customer_name || '—'}
                          </div>
                        )}
                        <div className="text-gray-500 truncate max-w-[200px]">
                          {r.customer_email}
                        </div>
                        {r.trade_account_number && (
                          <div className="text-amber-700 font-mono text-[10px] mt-0.5">
                            {r.trade_account_number}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="py-2 px-4">
                      <SourceBadge channel={r.channel || 'in_store'} showroomName={r.showroom_name} />
                    </td>
                    <td className="py-2 px-4 text-right tabular-nums">
                      <span className="font-semibold text-emerald-700">
                        £{Number(r.trade_credit_earned || 0).toFixed(2)}
                      </span>
                      {r.trade_credit_rate ? (
                        <div className="text-[10px] text-gray-500">
                          @ {Number(r.trade_credit_rate).toFixed(1)}%
                        </div>
                      ) : null}
                      {hasBreakdown && (
                        <button
                          type="button"
                          onClick={() => setExpandedId(isExpanded ? null : r.id)}
                          className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-700 hover:text-emerald-900 hover:underline"
                          data-testid={`credit-email-preview-toggle-${r.id}`}
                          aria-expanded={isExpanded}
                        >
                          {isExpanded ? 'Hide' : 'Preview'}{' '}
                          {isExpanded ? (
                            <ChevronUp className="w-2.5 h-2.5" />
                          ) : (
                            <ChevronDown className="w-2.5 h-2.5" />
                          )}
                        </button>
                      )}
                    </td>
                    <td className="py-2 px-4">
                      {sent ? (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 px-2 py-1 rounded">
                          <CheckCircle2 className="w-3 h-3" /> Sent
                        </span>
                      ) : (
                        <div>
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-rose-700 bg-rose-50 px-2 py-1 rounded">
                            <AlertCircle className="w-3 h-3" /> Failed
                          </span>
                          {r.credit_email_error && (
                            <div
                              className="text-[10px] text-rose-600/80 mt-1 truncate max-w-[180px]"
                              title={r.credit_email_error}
                            >
                              {r.credit_email_error}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-4 text-xs text-gray-600 whitespace-nowrap">
                      {relativeTime(r.credit_email_at)}
                    </td>
                    <td className="py-2 px-4 text-right">
                      {!sent && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleResend(r.id, r.invoice_no)}
                          disabled={resendingId === r.id}
                          className="text-xs h-7 border-rose-200 text-rose-700 hover:bg-rose-50"
                          data-testid={`credit-email-resend-${r.id}`}
                        >
                          {resendingId === r.id ? (
                            <>
                              <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Sending…
                            </>
                          ) : (
                            <>
                              <Send className="w-3 h-3 mr-1" /> Re-send
                            </>
                          )}
                        </Button>
                      )}
                    </td>
                  </tr>
                  {isExpanded && hasBreakdown && (
                    <tr
                      className="bg-emerald-50/30 border-t border-emerald-100"
                      data-testid={`credit-email-breakdown-${r.id}`}
                    >
                      <td colSpan={7} className="py-3 px-4">
                        <div className="max-w-2xl rounded-md border border-emerald-200 bg-white overflow-hidden">
                          <div className="flex items-center justify-between gap-2 px-3 py-2 bg-emerald-50 border-b border-emerald-100">
                            <div>
                              <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-800">
                                What the trader received
                              </p>
                              <p className="text-[11px] text-emerald-700/80 mt-0.5">
                                Per-product credit breakdown — mirrors the email body sent to {r.customer_email}.
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleCopyBreakdown(r)}
                              className={`inline-flex items-center gap-1 text-[10.5px] font-semibold px-2 py-1 rounded border transition-colors ${
                                isCopied
                                  ? 'text-emerald-900 bg-emerald-100 border-emerald-300'
                                  : 'text-emerald-800 bg-white border-emerald-200 hover:bg-emerald-50'
                              }`}
                              data-testid={`credit-email-copy-${r.id}`}
                              title="Copy breakdown as plain text"
                            >
                              {isCopied ? (
                                <>
                                  <Check className="w-3 h-3" />
                                  Copied
                                </>
                              ) : (
                                <>
                                  <ClipboardCopy className="w-3 h-3" />
                                  Copy
                                </>
                              )}
                            </button>
                          </div>
                          <table className="w-full text-[12px]">
                            <tbody>
                              {breakdown.map((b, idx) => {
                                const name = (b.product_name || b.sku || 'Unnamed line').toString();
                                const truncated = name.length > 44 ? `${name.slice(0, 42)}…` : name;
                                const rate = Number(b.rate) || 0;
                                const net = Number(b.net) || 0;
                                const credit = Number(b.credit) || 0;
                                return (
                                  <tr
                                    key={`${b.sku || b.product_id || idx}-${idx}`}
                                    className="border-b border-emerald-50 last:border-b-0"
                                    data-testid={`credit-email-breakdown-row-${r.id}-${idx}`}
                                  >
                                    <td className="px-3 py-1.5 text-gray-900" title={name}>
                                      {truncated}
                                    </td>
                                    <td className="px-3 py-1.5 text-gray-600 tabular-nums whitespace-nowrap text-right">
                                      {rate.toFixed(rate % 1 === 0 ? 0 : 1)}% × £{net.toFixed(2)}
                                    </td>
                                    <td className="px-3 py-1.5 text-right font-semibold text-emerald-800 tabular-nums whitespace-nowrap">
                                      £{credit.toFixed(2)}
                                    </td>
                                  </tr>
                                );
                              })}
                              <tr className="bg-emerald-50">
                                <td className="px-3 py-1.5 font-bold text-emerald-900" colSpan={2}>
                                  Total credit earned
                                </td>
                                <td className="px-3 py-1.5 text-right font-bold text-emerald-900 tabular-nums">
                                  £{Number(r.trade_credit_earned || 0).toFixed(2)}
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      {/* Trader credit-history breakdown — opens when a trader name is
          clicked in the table above. Shows lifetime totals, per-store
          breakdown, and the latest 50 transactions with source. */}
      <Dialog open={!!historyTrader} onOpenChange={(open) => !open && setHistoryTrader(null)}>
        <DialogContent className="sm:max-w-2xl" data-testid="credit-history-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-emerald-700">
              <Mail className="h-5 w-5" />
              Credit history — {historyTrader?.name || '—'}
            </DialogTitle>
            <DialogDescription>
              {historyData?.customer?.trade_account_number ? (
                <>Trade account <code className="font-mono text-amber-700">{historyData.customer.trade_account_number}</code>
                {historyData?.customer?.credit_balance != null && (
                  <> · Current balance <strong className="text-emerald-700">£{Number(historyData.customer.credit_balance).toFixed(2)}</strong></>
                )}</>
              ) : 'Loading…'}
            </DialogDescription>
          </DialogHeader>

          {historyLoading && (
            <div className="py-10 flex items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Loading history…
            </div>
          )}

          {!historyLoading && historyData && (
            <div className="space-y-4">
              {/* Lifetime tiles */}
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="bg-emerald-50 border border-emerald-200 rounded p-2">
                  <div className="text-emerald-700 font-semibold uppercase text-[10px]">Lifetime Earned</div>
                  <div className="text-lg font-bold text-emerald-900 tabular-nums">£{Number(historyData.lifetime_earned || 0).toFixed(2)}</div>
                </div>
                <div className="bg-amber-50 border border-amber-200 rounded p-2">
                  <div className="text-amber-700 font-semibold uppercase text-[10px]">Lifetime Redeemed</div>
                  <div className="text-lg font-bold text-amber-900 tabular-nums">£{Number(historyData.lifetime_redeemed || 0).toFixed(2)}</div>
                </div>
                <div className="bg-sky-50 border border-sky-200 rounded p-2">
                  <div className="text-sky-700 font-semibold uppercase text-[10px]">Current Balance</div>
                  <div className="text-lg font-bold text-sky-900 tabular-nums">£{Number(historyData.customer?.credit_balance || 0).toFixed(2)}</div>
                </div>
              </div>

              {/* Per-store breakdown */}
              {Array.isArray(historyData.by_showroom) && historyData.by_showroom.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-gray-700 mb-1.5">By store / channel</div>
                  <div className="bg-gray-50 border border-gray-200 rounded overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-100 text-gray-600 uppercase text-[10px]">
                        <tr>
                          <th className="text-left px-2 py-1">Source</th>
                          <th className="text-right px-2 py-1">Earned</th>
                          <th className="text-right px-2 py-1">Redeemed</th>
                          <th className="text-right px-2 py-1">Net</th>
                          <th className="text-right px-2 py-1">Txns</th>
                        </tr>
                      </thead>
                      <tbody>
                        {historyData.by_showroom.map((row, i) => (
                          <tr key={i} className="border-t border-gray-200">
                            <td className="px-2 py-1.5">
                              <SourceBadge channel={row.channel} showroomName={row.showroom_name} />
                            </td>
                            <td className="text-right px-2 py-1.5 text-emerald-700 font-semibold tabular-nums">£{Number(row.earned || 0).toFixed(2)}</td>
                            <td className="text-right px-2 py-1.5 text-amber-700 font-semibold tabular-nums">£{Number(row.redeemed || 0).toFixed(2)}</td>
                            <td className="text-right px-2 py-1.5 font-semibold tabular-nums">£{Number(row.net || 0).toFixed(2)}</td>
                            <td className="text-right px-2 py-1.5 text-gray-600 tabular-nums">{row.transaction_count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Last 50 transactions */}
              <div>
                <div className="text-xs font-semibold text-gray-700 mb-1.5">
                  Latest transactions ({historyData.transactions?.length || 0})
                </div>
                <div className="max-h-72 overflow-y-auto bg-white border border-gray-200 rounded">
                  {(!historyData.transactions || historyData.transactions.length === 0) && (
                    <div className="text-xs text-muted-foreground italic px-3 py-4 text-center">
                      No transactions on record.
                    </div>
                  )}
                  {(historyData.transactions || []).map((t) => {
                    const isEarn = (t.amount || 0) > 0;
                    return (
                      <div key={t.id} className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-100 last:border-b-0 text-xs">
                        <span className="font-mono text-gray-500 text-[10px] min-w-[80px]">
                          {t.created_at ? new Date(t.created_at).toLocaleDateString('en-GB') : '—'}
                        </span>
                        <span className={`px-1.5 py-0.5 rounded font-semibold text-[10px] ${isEarn ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>
                          {isEarn ? '+' : '−'}£{Math.abs(t.amount || 0).toFixed(2)}
                        </span>
                        <SourceBadge channel={t.channel || 'in_store'} showroomName={t.showroom_name} />
                        <span className="text-gray-600 truncate flex-1" title={t.description}>
                          {t.description || t.type}
                        </span>
                        {t.invoice_no && (
                          <span className="font-mono text-amber-700 text-[10px]">{t.invoice_no}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={() => setHistoryTrader(null)} data-testid="credit-history-close">
                  <X className="w-3.5 h-3.5 mr-1" /> Close
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
