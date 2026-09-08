import React from 'react';
import { fmtGBP, fmtDate } from './tradeFormat';

const CHANNEL = { online: 'Online', in_store: 'In store', manual: 'Adjustment' };

export const TradeLedgerTable = ({ rows = [], compact = false, showTrader = false, onOpenTrader }) => {
  if (!rows.length) {
    return <p className="text-sm text-gray-400 py-6 text-center" data-testid="ledger-empty">No credit movements yet.</p>;
  }
  return (
    <div className="overflow-x-auto" data-testid="trade-ledger-table">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b">
            <th className="py-2 pr-3">Date</th>
            {showTrader && <th className="py-2 pr-3">Trader</th>}
            <th className="py-2 pr-3">Movement</th>
            <th className="py-2 pr-3">Ref</th>
            {!compact && <th className="py-2 pr-3">Detail</th>}
            <th className="py-2 pr-3 text-right">Amount</th>
            {!showTrader && <th className="py-2 text-right">Balance</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b last:border-0 hover:bg-gray-50" data-testid={`ledger-row-${r.id}`}>
              <td className="py-2 pr-3 whitespace-nowrap text-gray-600">{fmtDate(r.created_at, true)}</td>
              {showTrader && (
                <td className="py-2 pr-3">
                  <button type="button" className="text-left hover:underline" onClick={() => onOpenTrader?.(r.customer_id)}>
                    <span className="font-medium">{r.business_name || '—'}</span>
                    {r.trade_account_number && <span className="ml-1 text-xs font-mono text-gray-500">#{r.trade_account_number}</span>}
                  </button>
                </td>
              )}
              <td className="py-2 pr-3">
                <span className="font-medium">{r.label}</span>
                <span className={`ml-2 text-[10px] uppercase px-1.5 py-0.5 rounded border ${r.channel === 'online' ? 'bg-sky-50 text-sky-700 border-sky-200' : r.channel === 'manual' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-violet-50 text-violet-700 border-violet-200'}`}>
                  {CHANNEL[r.channel] || r.channel}
                </span>
              </td>
              <td className="py-2 pr-3 font-mono text-xs text-gray-600">{r.reference || '—'}</td>
              {!compact && <td className="py-2 pr-3 text-gray-500 max-w-md truncate" title={r.description}>{r.description}{r.actor ? ` · ${r.actor}` : ''}</td>}
              <td className={`py-2 pr-3 text-right font-semibold whitespace-nowrap ${r.amount >= 0 ? 'text-emerald-700' : 'text-rose-700'}`}>
                {r.amount >= 0 ? '+' : '−'}{fmtGBP(Math.abs(r.amount))}
              </td>
              {!showTrader && <td className="py-2 text-right text-gray-700 whitespace-nowrap">{fmtGBP(r.running_balance)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
