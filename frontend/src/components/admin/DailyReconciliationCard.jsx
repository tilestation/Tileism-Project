import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { toast } from 'sonner';
import { Calendar, TrendingDown, TrendingUp, Wallet, Receipt, Loader2, Mail, Clock } from 'lucide-react';
import ReconciliationScheduleDialog from './ReconciliationScheduleDialog';

const API_URL = process.env.REACT_APP_BACKEND_URL;

/**
 * End-of-day reconciliation snapshot for the Sales hub. Splits today's
 * activity into:
 *  - Cash/card takings  (= Gross invoiced − Credit redeemed)
 *  - Credit ledger      (Earned − Redeemed = net liability change)
 *
 * The Z-read just needs to match `Net takings`. Credit movements live
 * outside the till.
 */
export default function DailyReconciliationCard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const token = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
    axios.get(`${API_URL}/api/invoices/reconciliation/daily?date=${date}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(res => { if (!cancelled) setData(res.data); })
      .catch(() => { if (!cancelled) setData(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [date]);

  const fmt = (n) => `£${(Number(n) || 0).toFixed(2)}`;

  const handleEmail = async () => {
    setEmailing(true);
    const token = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
    try {
      const res = await axios.post(
        `${API_URL}/api/invoices/reconciliation/daily/email`,
        { date },
        { headers: token ? { Authorization: `Bearer ${token}` } : {} }
      );
      toast.success(`Sent to ${res.data.email}`, { description: `${date} · Net takings ${fmt(res.data.net_takings)}` });
    } catch (err) {
      const detail = err?.response?.data?.detail || 'Could not send — try again';
      toast.error(detail);
    } finally {
      setEmailing(false);
    }
  };

  return (
    <Card className="border-gray-200" data-testid="daily-reconciliation-card">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-md bg-emerald-100 text-emerald-700 flex items-center justify-center">
              <Receipt className="w-4 h-4" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900">Today&apos;s Numbers</p>
              <p className="text-[11px] text-gray-500">
                Z-read reconciliation — match <strong>Net takings</strong> to your till + Stripe.
              </p>
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-gray-600">
            <Calendar className="w-3.5 h-3.5" />
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="border border-gray-200 rounded px-2 py-1 text-xs"
              max={new Date().toISOString().slice(0, 10)}
              data-testid="reconciliation-date-picker"
            />
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleEmail}
            disabled={emailing || loading || !data}
            className="h-7 px-2.5 text-xs gap-1.5"
            data-testid="reconciliation-email-btn"
          >
            {emailing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Mail className="w-3.5 h-3.5" />}
            Email me this
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setScheduleOpen(true)}
            className="h-7 px-2.5 text-xs gap-1.5 text-emerald-700 hover:text-emerald-800"
            data-testid="reconciliation-schedule-btn"
          >
            <Clock className="w-3.5 h-3.5" />
            Schedule
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading...
          </div>
        ) : !data ? (
          <p className="text-sm text-gray-500 py-4">Could not load reconciliation</p>
        ) : (
          <>
            {/* Takings ledger — feeds into Z-read */}
            <div className="rounded-lg border border-gray-200 bg-gray-50/60 p-3 space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-gray-500 font-semibold">Cash & card takings</p>
              <Row label="Gross invoiced" value={fmt(data.gross_invoiced)} sub={`${data.invoice_count} invoice${data.invoice_count === 1 ? '' : 's'}`} testId="recon-gross" />
              {data.credit_redeemed > 0 && (
                <Row label="Trade credit redeemed" value={`−${fmt(data.credit_redeemed)}`} sub={`${data.redemption_count} invoice${data.redemption_count === 1 ? '' : 's'} used credit`} valueClass="text-emerald-700" testId="recon-redeemed" />
              )}
              {data.refunds_today > 0 && (
                <Row label="Refunds today" value={`−${fmt(data.refunds_today)}`} sub={`${data.refund_count} refund${data.refund_count === 1 ? '' : 's'}`} valueClass="text-red-600" testId="recon-refunds" />
              )}
              <div className="border-t border-gray-200 pt-1.5 mt-1.5">
                <Row label="Net takings" value={fmt(data.net_takings)} bold valueClass="text-gray-900 text-lg" testId="recon-net" />
              </div>
            </div>

            {/* Credit ledger — separate from cash position */}
            {(data.credit_earned > 0 || data.credit_redeemed > 0) && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 space-y-1.5 mt-3">
                <p className="text-[10px] uppercase tracking-wider text-amber-700 font-semibold">Credit ledger movement</p>
                <Row icon={TrendingUp} iconClass="text-emerald-600" label="Earned today" value={`+${fmt(data.credit_earned)}`} valueClass="text-emerald-700" testId="recon-earned" />
                {data.credit_redeemed > 0 && (
                  <Row icon={TrendingDown} iconClass="text-red-500" label="Redeemed today" value={`−${fmt(data.credit_redeemed)}`} valueClass="text-red-600" testId="recon-redeemed-ledger" />
                )}
                <div className="border-t border-amber-200 pt-1.5 mt-1.5">
                  <Row
                    icon={Wallet}
                    iconClass="text-amber-700"
                    label="Net liability change"
                    value={`${data.credit_movement >= 0 ? '+' : ''}${fmt(data.credit_movement)}`}
                    bold
                    valueClass={data.credit_movement >= 0 ? 'text-amber-800' : 'text-red-700'}
                    testId="recon-movement"
                  />
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
      <ReconciliationScheduleDialog open={scheduleOpen} onOpenChange={setScheduleOpen} />
    </Card>
  );
}

function Row({ icon: Icon, iconClass, label, value, sub, bold, valueClass = 'text-gray-900', testId }) {
  return (
    <div className="flex items-baseline justify-between gap-3" data-testid={testId}>
      <span className={`flex items-center gap-1.5 text-sm ${bold ? 'font-bold text-gray-900' : 'text-gray-700'}`}>
        {Icon && <Icon className={`w-3.5 h-3.5 ${iconClass || ''}`} />}
        {label}
        {sub && <span className="text-[10px] text-gray-500 font-normal">· {sub}</span>}
      </span>
      <span className={`tabular-nums font-semibold ${valueClass}`}>{value}</span>
    </div>
  );
}
