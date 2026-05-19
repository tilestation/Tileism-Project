import React, { useEffect, useState, useCallback } from 'react';
import { PoundSterling, RefreshCw, Calendar, ChevronRight, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../ui/dialog';
import { api } from '../../lib/api';

/**
 * OutstandingBalancesWidget
 * ─────────────────────────
 * Lives at the top of the EPOS section. Shows the 5 oldest deposit-order
 * invoices that still have an outstanding balance > £0.01, plus a
 * one-tap "Take Payment" button that opens the same quick-pay dialog as
 * Invoice History (server-stamped today's date — see addInvoicePayment).
 *
 * Why here (not in the sidebar): per user request 24 Feb 2026 —
 * outstanding balances are a sales/EPOS concern, not a navigation item.
 */
const formatGBP = (n) => `£${(Number(n) || 0).toFixed(2)}`;

export const OutstandingBalancesWidget = () => {
  const [data, setData] = useState({ count: 0, total_outstanding: 0, invoices: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Quick-pay dialog state
  const [payInvoice, setPayInvoice] = useState(null);
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('Cash');
  const [payNote, setPayNote] = useState('');
  const [paySaving, setPaySaving] = useState(false);

  const fetchBalances = useCallback(async (silent = false) => {
    try {
      if (!silent) setRefreshing(true);
      const res = await api.getOutstandingBalances(5);
      setData(res.data || { count: 0, total_outstanding: 0, invoices: [] });
    } catch (err) {
      // Permission denied / network error — fall back to empty silently
      console.warn('[OutstandingBalances] fetch failed:', err?.message);
      setData({ count: 0, total_outstanding: 0, invoices: [] });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchBalances(); }, [fetchBalances]);

  const openPayDialog = (inv) => {
    setPayInvoice(inv);
    setPayAmount(inv.amount_outstanding.toFixed(2));
    setPayMethod('Cash');
    setPayNote('');
  };

  const closePayDialog = () => {
    if (paySaving) return;
    setPayInvoice(null);
    setPayAmount('');
    setPayMethod('Cash');
    setPayNote('');
  };

  const submitPay = async () => {
    if (!payInvoice) return;
    const amount = parseFloat(payAmount);
    if (!amount || amount <= 0) {
      toast.error('Enter an amount greater than zero');
      return;
    }
    if (!payMethod) {
      toast.error('Choose a payment method');
      return;
    }
    try {
      setPaySaving(true);
      const res = await api.addInvoicePayment(payInvoice.id, {
        amount, method: payMethod, note: payNote || '',
      });
      const { amount_outstanding = 0 } = res.data || {};
      toast.success(
        amount_outstanding <= 0.01
          ? `Payment £${amount.toFixed(2)} taken — ${payInvoice.invoice_no} fully paid ✓`
          : `Payment £${amount.toFixed(2)} taken — £${amount_outstanding.toFixed(2)} still outstanding`,
      );
      await fetchBalances(true);
      closePayDialog();
    } catch (err) {
      const msg = err.response?.data?.detail || 'Failed to record payment';
      toast.error(msg);
    } finally {
      setPaySaving(false);
    }
  };

  if (loading) {
    return (
      <div className="px-6 py-2 bg-muted/30 border-b text-xs text-muted-foreground" data-testid="outstanding-balances-loading">
        Loading outstanding balances…
      </div>
    );
  }

  if (data.count === 0) {
    return null;
  }

  const visible = expanded ? data.invoices : data.invoices.slice(0, 1);

  return (
    <>
      <div
        className="bg-emerald-50/70 border-b border-emerald-200 px-6 py-2.5"
        data-testid="outstanding-balances-widget"
      >
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
          <div className="flex items-center gap-2 text-sm">
            <PoundSterling className="h-4 w-4 text-emerald-700 shrink-0" />
            <span className="font-semibold text-emerald-900">
              {data.count} outstanding balance{data.count === 1 ? '' : 's'}
            </span>
            <span className="text-emerald-800">
              · <span className="font-mono tabular-nums">{formatGBP(data.total_outstanding)}</span> awaiting
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpanded((v) => !v)}
              className="h-7 px-2 text-xs text-emerald-800 hover:text-emerald-900 hover:bg-emerald-100"
              data-testid="outstanding-balances-toggle"
            >
              {expanded ? 'Collapse' : `Show ${Math.min(5, data.count)} oldest`}
              <ChevronRight className={`h-3 w-3 ml-0.5 transition-transform ${expanded ? 'rotate-90' : ''}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fetchBalances()}
              disabled={refreshing}
              className="h-7 px-2 text-xs text-emerald-800 hover:bg-emerald-100"
              data-testid="outstanding-balances-refresh"
            >
              <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        {expanded && (
          <div className="mt-2 border-t border-emerald-200 pt-2 space-y-1.5" data-testid="outstanding-balances-list">
            {visible.map((inv) => (
              <div
                key={inv.id}
                className="flex flex-wrap items-center gap-2 text-xs"
                data-testid={`outstanding-row-${inv.invoice_no}`}
              >
                <span className="font-mono font-semibold text-emerald-900 min-w-[110px]">{inv.invoice_no}</span>
                <span className="text-emerald-800 min-w-[140px] truncate">
                  {inv.customer_name || <em className="text-muted-foreground">No customer</em>}
                </span>
                <span className="text-emerald-700 inline-flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {inv.date}
                  {inv.days_old > 30 && (
                    <span className="ml-1 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-semibold">
                      <AlertCircle className="h-2.5 w-2.5" />
                      {inv.days_old}d
                    </span>
                  )}
                </span>
                <span className="ml-auto font-mono font-bold text-emerald-900 tabular-nums">
                  {formatGBP(inv.amount_outstanding)}
                </span>
                <Button
                  size="sm"
                  onClick={() => openPayDialog(inv)}
                  className="h-7 px-2 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                  data-testid={`outstanding-pay-${inv.invoice_no}`}
                >
                  Take Payment
                </Button>
              </div>
            ))}
            {data.count > 5 && (
              <p className="text-[11px] text-emerald-700 italic pt-1">
                Showing 5 oldest of {data.count}. Open Invoice History to see them all.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Quick-pay dialog (server stamps today's date) */}
      <Dialog open={!!payInvoice} onOpenChange={(open) => !open && closePayDialog()}>
        <DialogContent className="sm:max-w-md" data-testid="outstanding-pay-dialog">
          <DialogHeader>
            <DialogTitle className="text-emerald-700 flex items-center gap-2">
              <PoundSterling className="h-5 w-5" />
              Take Balance Payment
            </DialogTitle>
            <DialogDescription>
              Record a payment against invoice <strong>{payInvoice?.invoice_no}</strong>
              {payInvoice?.customer_name ? <> for <strong>{payInvoice.customer_name}</strong></> : null}.
              <br />
              Outstanding balance: <strong className="text-amber-700">{formatGBP(payInvoice?.amount_outstanding)}</strong>
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div>
              <label className="text-sm font-medium block mb-1">Amount (£)</label>
              <Input
                type="number"
                step="0.01"
                min="0.01"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
                data-testid="outstanding-pay-amount-input"
                disabled={paySaving}
                autoFocus
              />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Payment method</label>
              <select
                value={payMethod}
                onChange={(e) => setPayMethod(e.target.value)}
                className="w-full px-3 py-2 rounded border border-input bg-background text-sm"
                data-testid="outstanding-pay-method-select"
                disabled={paySaving}
              >
                <option value="Cash">Cash</option>
                <option value="Card">Card</option>
                <option value="Bank Transfer">Bank Transfer</option>
                <option value="Klarna">Klarna</option>
                <option value="Cheque">Cheque</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Note (optional)</label>
              <Input
                type="text"
                value={payNote}
                onChange={(e) => setPayNote(e.target.value)}
                placeholder="e.g. Collected by Bob, ref #1234"
                maxLength={120}
                data-testid="outstanding-pay-note-input"
                disabled={paySaving}
              />
            </div>
            <div className="rounded bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-900">
              <Calendar className="h-3 w-3 inline mr-1" />
              This payment will be recorded as taken on <strong>{new Date().toLocaleDateString('en-GB')}</strong>.
              Revenue will land on today's sales report.
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closePayDialog} disabled={paySaving} data-testid="outstanding-pay-cancel">
              Cancel
            </Button>
            <Button
              onClick={submitPay}
              disabled={paySaving || !parseFloat(payAmount) || !payMethod}
              className="bg-emerald-600 hover:bg-emerald-700 text-white"
              data-testid="outstanding-pay-submit"
            >
              {paySaving ? 'Recording…' : `Take ${formatGBP(parseFloat(payAmount) || 0)}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default OutstandingBalancesWidget;
