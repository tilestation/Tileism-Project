import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Coins, Search, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { api } from '../../../lib/api';
import { TradeLedgerTable } from './TradeLedgerTable';
import { TraderDrawer } from './TraderDrawer';
import { fmtGBP } from './tradeFormat';

const TradeCreditEmails = React.lazy(() => import('../TradeCreditEmails'));

export const TradeCreditTab = ({ onOpenTrader }) => {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [drawerId, setDrawerId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.getCreditMovements(days, 400);
      setRows(data.rows || []);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Could not load credit movements');
    } finally {
      setLoading(false);
    }
  }, [days]);
  useEffect(() => { load(); }, [load]);

  const open = (id) => { if (!id) return; if (onOpenTrader) onOpenTrader(id); else setDrawerId(id); };
  const needle = q.trim().toLowerCase();
  const shown = needle ? rows.filter((r) => [r.business_name, r.trade_account_number, r.reference, r.description, r.label].some((v) => String(v || '').toLowerCase().includes(needle))) : rows;
  const inflow = shown.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  const outflow = shown.filter((r) => r.amount < 0).reduce((s, r) => s - r.amount, 0);

  return (
    <div className="space-y-6" data-testid="trade-credit-tab">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="text-base flex items-center gap-2"><Coins className="h-4 w-4" />All credit movements</CardTitle>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Trader, T-number, invoice, order…" className="pl-8 h-8 w-64 text-sm" data-testid="credit-search" />
              </div>
              {[30, 90, 365].map((d) => (
                <button key={d} type="button" onClick={() => setDays(d)} className={`text-xs px-2.5 py-1 rounded-full border ${days === d ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600'}`} data-testid={`credit-range-${d}`}>{d === 365 ? '12m' : `${d}d`}</button>
              ))}
              <Button size="sm" variant="ghost" onClick={load}><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></Button>
            </div>
          </div>
          <p className="text-xs text-gray-500">
            {shown.length} movement(s) · in <span className="text-emerald-700 font-medium">{fmtGBP(inflow)}</span> · out <span className="text-rose-700 font-medium">{fmtGBP(outflow)}</span>.
            Refunds claw back credit automatically (online and in store); manual adjustments and expiries are listed here too. Click a trader to open their full ledger and adjust.
          </p>
        </CardHeader>
        <CardContent>
          {loading && rows.length === 0 ? <p className="text-sm text-gray-400 py-6 text-center">Loading…</p> : (
            <TradeLedgerTable rows={shown} showTrader onOpenTrader={open} />
          )}
        </CardContent>
      </Card>

      <React.Suspense fallback={<div className="text-sm text-gray-400 py-6 text-center">Loading weekly credit emails…</div>}>
        <TradeCreditEmails />
      </React.Suspense>

      {!onOpenTrader && <TraderDrawer traderId={drawerId} open={!!drawerId} onOpenChange={(o) => !o && setDrawerId(null)} onChanged={load} />}
    </div>
  );
};
