import React, { useCallback, useEffect, useState } from 'react';
import { Radio, LogIn, ChevronDown, ChevronUp, Sparkles, Monitor, Smartphone } from 'lucide-react';
import { api } from '../../../lib/api';
import { fmtDate } from './tradeFormat';

const REFRESH_MS = 60000;

const timeOnly = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};
const minsAgo = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
const dayLabel = (date) => new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short' }).slice(0, 2);

const DayStrip = ({ days }) => {
  const max = Math.max(1, ...days.map((d) => d.sign_ins));
  return (
    <div className="flex items-end gap-1 h-12" data-testid="pulse-day-strip">
      {days.map((d, i) => {
        const isToday = i === days.length - 1;
        const h = d.sign_ins ? Math.max(4, Math.round((d.sign_ins / max) * 44)) : 2;
        return (
          <div key={d.date} className="flex flex-col items-center gap-0.5 w-5" title={`${fmtDate(d.date)} · ${d.sign_ins} sign-in${d.sign_ins === 1 ? '' : 's'} · ${d.unique_traders} trader${d.unique_traders === 1 ? '' : 's'}`} data-testid={`pulse-day-${d.date}`}>
            <div className={`w-full rounded-t ${isToday ? 'bg-emerald-500' : d.sign_ins ? 'bg-gray-400' : 'bg-gray-200'}`} style={{ height: `${h}px` }} />
            <span className={`text-[9px] leading-none ${isToday ? 'text-emerald-700 font-semibold' : 'text-gray-400'}`}>{dayLabel(d.date)}</span>
          </div>
        );
      })}
    </div>
  );
};

export const TradeLivePulse = ({ onOpenTrader }) => {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data: d } = await api.getTradeLoginActivity(14);
      setData(d);
    } catch (_) { /* keep last good data */ }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  if (!data) return <div className="rounded-xl border bg-white p-4 text-sm text-gray-400" data-testid="trade-live-pulse-loading">Loading live activity…</div>;
  const s = data.today_summary;

  return (
    <div className="rounded-xl border bg-white" data-testid="trade-live-pulse">
      <div className="grid md:grid-cols-[1.4fr_1fr_auto] gap-4 p-4">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500">
            <span className="relative flex h-2.5 w-2.5">
              {data.live.length > 0 && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />}
              <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${data.live.length ? 'bg-emerald-500' : 'bg-gray-300'}`} />
            </span>
            <Radio className="h-3.5 w-3.5" /> Live on the website now
            <span className="ml-1 text-lg font-bold text-gray-900 normal-case tracking-normal" data-testid="live-now-count">{data.live.length}</span>
          </div>
          {data.live.length === 0 ? (
            <p className="text-sm text-gray-400 mt-2" data-testid="live-now-empty">No traders browsing right now (last {data.live_window_minutes} min).</p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {data.live.map((t) => (
                <li key={t.id}>
                  <button type="button" onClick={() => onOpenTrader?.(t.id)}
                    className="flex items-center gap-1.5 text-xs bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-full pl-2 pr-2.5 py-1 hover:bg-emerald-100"
                    title={`${t.last_seen_path || 'on the website'} · ${minsAgo(t.last_seen_at)} min ago`} data-testid={`live-trader-${t.id}`}>
                    {t.device === 'mobile' ? <Smartphone className="h-3 w-3" /> : <Monitor className="h-3 w-3" />}
                    <span className="font-medium">{t.business_name}</span>
                    <span className="font-mono text-emerald-600">#{t.trade_account_number}</span>
                    <span className="text-emerald-600/70">{minsAgo(t.last_seen_at)}m</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500"><LogIn className="h-3.5 w-3.5" /> Today's sign-ins</div>
          <div className="mt-1.5 flex items-baseline gap-4">
            <div><span className="text-2xl font-bold text-gray-900" data-testid="today-signins">{s.sign_ins}</span><span className="text-xs text-gray-500 ml-1">sign-ins</span></div>
            <div><span className="text-2xl font-bold text-gray-900" data-testid="today-unique">{s.unique_traders}</span><span className="text-xs text-gray-500 ml-1">traders</span></div>
            {s.distinct_first_time > 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5" data-testid="today-first-time"><Sparkles className="h-3 w-3" />{s.distinct_first_time} first-timer{s.distinct_first_time === 1 ? '' : 's'}</span>
            )}
          </div>
          {data.today_rows.length > 0 && (
            <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1.5 text-xs text-gray-600 hover:text-gray-900 inline-flex items-center gap-1" data-testid="pulse-toggle-list">
              {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}{open ? 'Hide' : 'Show'} who signed in today
            </button>
          )}
        </div>

        <div className="flex flex-col items-end justify-between">
          <span className="text-[10px] uppercase tracking-wide text-gray-400">Last 14 days</span>
          <DayStrip days={data.days} />
        </div>
      </div>

      {open && (
        <ul className="border-t divide-y max-h-64 overflow-y-auto" data-testid="today-login-list">
          {data.today_rows.map((r) => (
            <li key={r.id} className="px-4 py-2 flex items-center gap-3 text-sm">
              <span className="font-mono text-xs text-gray-500 w-12">{timeOnly(r.at)}</span>
              <button type="button" onClick={() => onOpenTrader?.(r.customer_id)} className="font-medium text-gray-900 hover:underline text-left" data-testid={`today-login-row-${r.id}`}>{r.business_name}</button>
              <span className="font-mono text-xs text-gray-400">#{r.trade_account_number || '—'}</span>
              {r.first_time && <span className="text-[10px] uppercase font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5">first sign-in</span>}
              <span className="ml-auto text-xs text-gray-400">{r.device || ''}{r.ip ? ` · ${r.ip}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
