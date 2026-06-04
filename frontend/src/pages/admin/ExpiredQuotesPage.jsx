/**
 * ExpiredQuotesPage — admin-only win-back tool.
 *
 * Per user choice 2c (3 Jun 2026): admin picks the discount %
 * per code when sending the recovery email. Each quote gets a
 * one-off `WB{percent}-{quotenum}-{hex}` code locked to the
 * customer's email address.
 *
 * Backend: routes/quote_recovery.py
 *   - GET  /api/quote-recovery/expired-quotes
 *   - POST /api/quote-recovery/send-recovery
 */
import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import {
  Mail, Send, Clock, PoundSterling, Tag, RefreshCw,
  CheckCircle2, AlertTriangle, X,
} from 'lucide-react';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
const tokenHdr = () => {
  const t = localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
};

const PERCENT_OPTIONS = [5, 7, 10, 12, 15, 20, 25, 30];

export default function ExpiredQuotesPage() {
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [percent, setPercent] = useState(10);
  const [expiresDays, setExpiresDays] = useState(14);
  const [customMessage, setCustomMessage] = useState('');
  const [sending, setSending] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API}/quote-recovery/expired-quotes`, { headers: tokenHdr() });
      setQuotes(r.data?.quotes || []);
    } catch (e) {
      toast.error(`Couldn't load expired quotes: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const selected = useMemo(
    () => quotes.find((q) => q.id === selectedId) || null,
    [quotes, selectedId],
  );

  const sendRecovery = async () => {
    if (!selected) return;
    if (!selected.customer_email) {
      toast.error('This quote has no customer email — add one on the quote first.');
      return;
    }
    setSending(true);
    try {
      const r = await axios.post(
        `${API}/quote-recovery/send-recovery`,
        {
          quote_id: selected.id,
          percent_off: percent,
          expires_days: expiresDays,
          custom_message: customMessage || undefined,
        },
        { headers: tokenHdr() },
      );
      if (r.data?.ok) {
        toast.success(`Sent ${percent}% off code ${r.data.code} to ${r.data.customer_email}`, { duration: 5000 });
      } else {
        toast.warning(`Code ${r.data?.code} minted, but email send failed: ${r.data?.email_send_error}`, { duration: 6000 });
      }
      setSelectedId(null);
      setCustomMessage('');
      await refresh();
    } catch (e) {
      toast.error(`Recovery failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return <div className="p-6 text-center text-muted-foreground" data-testid="expired-quotes-loading">Loading expired quotes…</div>;
  }

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-4" data-testid="expired-quotes-page">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-extrabold flex items-center gap-2">
            <Clock className="w-6 h-6 text-amber-500" /> Expired Quotes — Win Back
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Quotes older than 30 days that haven't been converted. Click <strong>Send Recovery</strong>
            to mint a one-off discount code (you pick the %) and email it to the customer.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={refresh} variant="outline" size="sm" data-testid="expired-quotes-refresh">
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refresh
          </Button>
          <div className="text-sm text-muted-foreground">
            <span className="font-bold text-amber-500" data-testid="expired-quotes-count">{quotes.length}</span> expired
          </div>
        </div>
      </div>

      {quotes.length === 0 ? (
        <Card className="p-8 text-center" data-testid="expired-quotes-empty">
          <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-2" />
          <div className="font-bold">No expired quotes!</div>
          <p className="text-sm text-muted-foreground mt-1">
            Every quote in the last 30 days has been converted or is still active.
          </p>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="expired-quotes-table">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left p-2">Quote #</th>
                <th className="text-left p-2">Customer</th>
                <th className="text-left p-2">Email</th>
                <th className="text-left p-2">Showroom</th>
                <th className="text-left p-2">Rep</th>
                <th className="text-right p-2">Value</th>
                <th className="text-right p-2">Age</th>
                <th className="text-right p-2">Recoveries</th>
                <th className="p-2"> </th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((q) => {
                const total = q.grand_total || q.total || 0;
                const recCount = (q.recovery_attempts || []).length;
                const hasEmail = !!q.customer_email;
                return (
                  <tr
                    key={q.id}
                    data-testid={`expired-quote-row-${q.id}`}
                    className="border-t border-border/40 hover:bg-muted/20"
                  >
                    <td className="p-2 font-mono text-xs">{q.quote_number || q.id.slice(0, 8)}</td>
                    <td className="p-2 font-semibold">{q.customer_name || '—'}</td>
                    <td className="p-2 text-xs">
                      {hasEmail ? q.customer_email : (
                        <span className="text-amber-500 inline-flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" /> no email
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-xs">{q.showroom_name || '—'}</td>
                    <td className="p-2 text-xs">{q.sales_person || '—'}</td>
                    <td className="p-2 text-right font-bold tabular-nums">£{Number(total).toLocaleString('en-GB', { minimumFractionDigits: 2 })}</td>
                    <td className="p-2 text-right tabular-nums text-amber-500">{q.age_days != null ? `${q.age_days}d` : '—'}</td>
                    <td className="p-2 text-right">
                      {recCount > 0 ? (
                        <span className="px-1.5 py-0.5 bg-emerald-500/10 border border-emerald-500/40 rounded text-[10px] font-bold text-emerald-400">
                          {recCount} sent
                        </span>
                      ) : '—'}
                    </td>
                    <td className="p-2">
                      <Button
                        size="sm"
                        onClick={() => { setSelectedId(q.id); }}
                        disabled={!hasEmail}
                        data-testid={`expired-quote-send-${q.id}`}
                      >
                        <Mail className="w-3 h-3 mr-1" /> Send Recovery
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {/* Send-recovery modal */}
      {selected && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          data-testid="recovery-modal"
          role="dialog"
          aria-modal="true"
        >
          <Card className="max-w-lg w-full p-5 relative">
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              aria-label="Close recovery modal"
              data-testid="recovery-modal-close"
              className="absolute top-3 right-3 p-1 rounded hover:bg-muted"
            >
              <X className="w-4 h-4" />
            </button>
            <h2 className="text-xl font-extrabold flex items-center gap-2">
              <Tag className="w-5 h-5 text-amber-500" />
              Win back quote {selected.quote_number || selected.id.slice(0, 8)}
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Sending to <strong className="text-foreground">{selected.customer_email}</strong>
              {selected.customer_name && <> · {selected.customer_name}</>}
            </p>
            <div className="grid grid-cols-2 gap-3 mt-4">
              <div className="space-y-1">
                <label htmlFor="recovery-percent" className="text-xs text-muted-foreground font-semibold">Discount %</label>
                <select
                  id="recovery-percent"
                  value={percent}
                  onChange={(e) => setPercent(Number(e.target.value))}
                  data-testid="recovery-percent"
                  className="w-full bg-background border border-input rounded px-2 py-2 text-sm font-bold"
                >
                  {PERCENT_OPTIONS.map((p) => (
                    <option key={p} value={p}>{p}% off</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="recovery-expires" className="text-xs text-muted-foreground font-semibold">Valid for (days)</label>
                <Input
                  id="recovery-expires"
                  type="number"
                  min="1"
                  max="90"
                  value={expiresDays}
                  onChange={(e) => setExpiresDays(Number(e.target.value))}
                  data-testid="recovery-expires"
                />
              </div>
            </div>
            <div className="mt-3 space-y-1">
              <label htmlFor="recovery-message" className="text-xs text-muted-foreground font-semibold">Custom message (optional)</label>
              <textarea
                id="recovery-message"
                value={customMessage}
                onChange={(e) => setCustomMessage(e.target.value.slice(0, 500))}
                placeholder="e.g. Stock is back in! Pop by Tonbridge any day this week to see the samples in person."
                rows={3}
                maxLength={500}
                data-testid="recovery-message"
                className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm"
              />
              <div className="text-[10px] text-muted-foreground text-right">{customMessage.length}/500</div>
            </div>
            <div className="mt-4 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg text-sm">
              <div className="flex items-center gap-1.5 text-emerald-600 font-bold text-xs uppercase tracking-wider">
                <PoundSterling className="w-3.5 h-3.5" /> Saves customer
              </div>
              <div className="text-lg font-extrabold text-emerald-600 mt-0.5 tabular-nums">
                £{(((selected.grand_total || selected.total || 0) * percent) / 100).toFixed(2)}
              </div>
              <div className="text-[10px] text-muted-foreground">
                on quote totaling £{Number(selected.grand_total || selected.total || 0).toLocaleString('en-GB', { minimumFractionDigits: 2 })}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-4">
              <Button variant="outline" onClick={() => setSelectedId(null)} data-testid="recovery-cancel">
                Cancel
              </Button>
              <Button
                onClick={sendRecovery}
                disabled={sending}
                data-testid="recovery-send"
              >
                <Send className="w-3.5 h-3.5 mr-1.5" />
                {sending ? 'Sending…' : `Mint ${percent}% code & send`}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
