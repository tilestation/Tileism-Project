import React, { useState } from 'react';
import { toast } from 'sonner';
import { CalendarClock, Send, AlertTriangle } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { api } from '../../../lib/api';
import { fmtDate, fmtGBP } from './tradeFormat';

export const CreditExpiryControls = ({ trader, isSuperAdmin, onChanged }) => {
  const [date, setDate] = useState(trader?.credit_expires_at || '');
  const [busy, setBusy] = useState(null);
  const balance = Number(trader?.credit_balance) || 0;

  const run = async (key, fn, ok) => {
    setBusy(key);
    try {
      const { data } = await fn();
      toast.success(typeof ok === 'function' ? ok(data) : ok);
      onChanged?.();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border bg-white p-4 space-y-3" data-testid="credit-expiry-controls">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-800">
        <CalendarClock className="h-4 w-4" /> Credit expiry
        {trader?.credit_expires_at
          ? <span className="ml-auto text-xs font-normal text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">expires {fmtDate(trader.credit_expires_at)}</span>
          : <span className="ml-auto text-xs font-normal text-gray-400">no expiry set</span>}
      </div>
      <p className="text-xs text-gray-500">
        Set a date and the trader gets a reminder 30 and 7 days before; on the day their balance ({fmtGBP(balance)}) is written off to the ledger automatically.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" data-testid="credit-expiry-date" />
        <Button size="sm" disabled={busy === 'set' || !date} onClick={() => run('set', () => api.setTraderCreditExpiry(trader.id, date), 'Expiry date saved')} data-testid="credit-expiry-save">
          Save date
        </Button>
        {trader?.credit_expires_at && (
          <Button size="sm" variant="ghost" disabled={busy === 'clear'} onClick={() => run('clear', () => api.setTraderCreditExpiry(trader.id, null), 'Expiry cleared')} data-testid="credit-expiry-clear">
            Clear
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={busy === 'remind' || !trader?.credit_expires_at || balance <= 0}
          onClick={() => run('remind', () => api.remindTraderCreditExpiry(trader.id), (d) => d.success ? 'Reminder emailed' : `Reminder not sent: ${d.error || 'email failed'}`)}
          data-testid="credit-expiry-remind">
          <Send className="h-3.5 w-3.5 mr-1" /> Email reminder now
        </Button>
        {isSuperAdmin && balance > 0 && (
          <Button size="sm" variant="destructive" disabled={busy === 'expire'}
            onClick={() => { if (window.confirm(`Write off ${fmtGBP(balance)} of credit for ${trader.business_name || trader.name} now?`)) run('expire', () => api.expireTraderCreditNow(trader.id), (d) => `Expired ${fmtGBP(d.expired)}`); }}
            data-testid="credit-expire-now">
            <AlertTriangle className="h-3.5 w-3.5 mr-1" /> Expire now
          </Button>
        )}
      </div>
    </div>
  );
};
