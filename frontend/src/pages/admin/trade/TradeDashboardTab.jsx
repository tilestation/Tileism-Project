import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Users, UserPlus, KeyRound, MoonStar, PoundSterling, Store, Globe, Coins, CalendarClock, Send, Trophy, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { api } from '../../../lib/api';
import { useAuth } from '../../../contexts/AuthContext';
import { fmtGBP, fmtDate, daysSince } from './tradeFormat';
import { TraderDrawer } from './TraderDrawer';

const TONE = {
  gray: 'bg-gray-100 text-gray-700', blue: 'bg-blue-100 text-blue-700', emerald: 'bg-emerald-100 text-emerald-700',
  rose: 'bg-rose-100 text-rose-700', amber: 'bg-amber-100 text-amber-700', sky: 'bg-sky-100 text-sky-700', violet: 'bg-violet-100 text-violet-700',
};

const Kpi = ({ icon: Icon, label, value, sub, tone = 'gray', onClick, testId }) => (
  <button type="button" onClick={onClick} disabled={!onClick}
    className={`text-left rounded-xl border bg-white p-4 transition-shadow ${onClick ? 'hover:shadow-md cursor-pointer' : 'cursor-default'}`} data-testid={testId}>
    <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-gray-500">
      <span className={`p-1.5 rounded-md ${TONE[tone] || TONE.gray}`}><Icon className="h-3.5 w-3.5" /></span>{label}
    </div>
    <p className="text-2xl font-bold mt-2 text-gray-900">{value}</p>
    {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
  </button>
);

const TraderList = ({ title, icon: Icon, rows, empty, onOpen, renderMeta, actions, testId }) => (
  <Card data-testid={testId}>
    <CardHeader className="pb-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <CardTitle className="text-base flex items-center gap-2"><Icon className="h-4 w-4" />{title} <span className="text-sm font-normal text-gray-400">({rows.length})</span></CardTitle>
        {actions}
      </div>
    </CardHeader>
    <CardContent>
      {rows.length === 0 ? <p className="text-sm text-gray-400 py-4">{empty}</p> : (
        <ul className="divide-y max-h-80 overflow-y-auto">
          {rows.map((t) => (
            <li key={t.id} className="py-2 flex items-center justify-between gap-3">
              <button type="button" onClick={() => onOpen(t.id)} className="text-left min-w-0" data-testid={`open-trader-${t.id}`}>
                <p className="text-sm font-medium truncate">{t.business_name || t.name} <span className="text-xs font-mono text-gray-400">#{t.trade_account_number}</span></p>
                <p className="text-xs text-gray-500 truncate">{renderMeta(t)}</p>
              </button>
              <span className="text-sm font-semibold text-gray-700 whitespace-nowrap">{fmtGBP(t.credit_balance)}</span>
            </li>
          ))}
        </ul>
      )}
    </CardContent>
  </Card>
);

export const TradeDashboardTab = ({ onOpenTrader }) => {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [drawerId, setDrawerId] = useState(null);
  const [busy, setBusy] = useState(null);
  const [bulkExpiry, setBulkExpiry] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: d } = await api.getTradeHubSummary(days);
      setData(d);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Could not load trade dashboard');
    } finally {
      setLoading(false);
    }
  }, [days]);
  useEffect(() => { load(); }, [load]);

  const open = (id) => { if (onOpenTrader) onOpenTrader(id); else setDrawerId(id); };

  const bulk = async (key, fn, ok) => {
    setBusy(key);
    try {
      const { data: d } = await fn();
      toast.success(typeof ok === 'function' ? ok(d) : ok);
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <div className="py-16 text-center text-gray-400" data-testid="trade-dashboard-loading">Loading trade dashboard…</div>;
  if (!data) return null;
  const k = data.kpis;
  const ch = data.channels || {};

  return (
    <div className="space-y-6" data-testid="trade-dashboard">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-gray-500">Everything your tradesmen are doing — online and in every showroom.</p>
        <div className="flex items-center gap-1 text-xs">
          {[30, 90, 365].map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} className={`px-2.5 py-1 rounded-full border ${days === d ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600'}`} data-testid={`range-${d}`}>{d === 365 ? '12 months' : `${d} days`}</button>
          ))}
          <Button size="sm" variant="ghost" onClick={load} title="Refresh"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi icon={Users} label="Trade accounts" value={k.total_traders} sub={`${k.active_traders} active`} tone="blue" testId="kpi-total" />
        <Kpi icon={UserPlus} label="New this month" value={k.new_this_month} sub={`Online ${ch.online || 0} · In store ${(ch.in_store || 0) + (ch.staff_created || 0)} · Untracked ${ch.unknown || 0}`} tone="emerald" testId="kpi-new" />
        <Kpi icon={KeyRound} label="No login yet" value={k.never_logged_in} sub={`${k.link_sent_not_activated} link sent, not activated · ${k.login_ready ?? 0} have a password, no sign-in tracked yet`} tone="rose" testId="kpi-never" />
        <Kpi icon={MoonStar} label="Dormant (60d+)" value={k.dormant} sub={`${k.never_purchased} never purchased`} tone="amber" testId="kpi-dormant" />
        <Kpi icon={Globe} label={`Online revenue (${days}d)`} value={fmtGBP(k.online_revenue)} sub={`${k.online_orders} orders · ${fmtGBP(k.online_revenue_90d)} in 90d`} tone="sky" testId="kpi-online-rev" />
        <Kpi icon={Store} label={`In-store revenue (${days}d)`} value={fmtGBP(k.in_store_revenue)} sub={`${k.in_store_invoices} invoices · ${fmtGBP(k.in_store_revenue_90d)} in 90d`} tone="violet" testId="kpi-store-rev" />
        <Kpi icon={Coins} label="Credit liability" value={fmtGBP(k.credit_liability)} sub={`Earned ${fmtGBP(k.credit_earned)} · Used ${fmtGBP(k.credit_redeemed)} · Clawed ${fmtGBP(k.credit_clawed_back)}`} tone="emerald" testId="kpi-liability" />
        <Kpi icon={CalendarClock} label="Credit expiring ≤30d" value={k.expiring_credit_count} sub={`${fmtGBP(k.expiring_credit_total)} at stake`} tone="amber" testId="kpi-expiring" />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <TraderList title="No login yet — send login links" icon={KeyRound} rows={data.never_logged_in} testId="list-never-logged-in"
          empty={`Every trade account has a usable login. Sign-ins have only been tracked since ${fmtDate(data.login_tracking_since)} — traders who registered before then show as "Has password" until they next sign in.`} onOpen={open}
          renderMeta={(t) => `${t.email || 'no email'} · ${t.has_password === false ? 'no password on record' : 'staff-created, password never chosen'} · ${t.login_link_sent_at ? `link sent ${fmtDate(t.login_link_sent_at)}` : 'no link sent yet'}`}
          actions={<Button size="sm" disabled={busy === 'links' || !data.never_logged_in.length}
            onClick={() => { if (window.confirm(`Email set-password links to ${data.never_logged_in.length} trader(s)?`)) bulk('links', () => api.bulkSendTradeLoginLinks(data.never_logged_in.map((t) => t.id)), (d) => `Sent ${d.sent} · failed ${d.failed.length}`); }}
            data-testid="bulk-send-login-links"><Send className="h-3.5 w-3.5 mr-1" />Send to all</Button>} />

        <TraderList title="Dormant — no purchase for 60+ days" icon={MoonStar} rows={data.dormant} testId="list-dormant"
          empty="No dormant traders in the last 60 days." onOpen={open}
          renderMeta={(t) => `Last purchase ${fmtDate(t.last_purchase_at)} (${daysSince(t.last_purchase_at)}d) · ${t.last_nudge_at ? `nudged ${fmtDate(t.last_nudge_at)}` : 'never nudged'}`}
          actions={<div className="flex items-center gap-2">
            {isSuperAdmin && <>
              <Input type="date" value={bulkExpiry} onChange={(e) => setBulkExpiry(e.target.value)} className="h-8 w-40 text-xs" data-testid="dormant-expiry-date" />
              <Button size="sm" variant="outline" disabled={busy === 'expiry' || !bulkExpiry || !data.dormant.length}
                onClick={() => bulk('expiry', () => api.bulkSetTraderCreditExpiry(data.dormant.filter((t) => t.credit_balance > 0).map((t) => t.id), bulkExpiry), (d) => `Expiry set on ${d.updated} account(s) — reminders go out automatically`)}
                data-testid="dormant-set-expiry"><CalendarClock className="h-3.5 w-3.5 mr-1" />Set credit expiry</Button>
            </>}
            <Button size="sm" disabled={busy === 'nudge' || !data.dormant.length}
              onClick={() => { if (window.confirm(`Send the win-back email to ${data.dormant.length} dormant trader(s)?`)) bulk('nudge', () => api.sendDormantNudge(data.dormant.map((t) => t.id)), (d) => `Sent ${d.sent} · failed ${d.failed.length}`); }}
              data-testid="dormant-nudge-all"><Send className="h-3.5 w-3.5 mr-1" />Win-back all</Button>
          </div>} />

        <TraderList title="Credit expiring within 30 days" icon={CalendarClock} rows={data.expiring} testId="list-expiring"
          empty="No credit due to expire in the next 30 days." onOpen={open}
          renderMeta={(t) => `Expires ${fmtDate(t.credit_expires_at)} · reminders 30/7 days automatic`} />

        <Card data-testid="list-top-traders">
          <CardHeader className="pb-2"><CardTitle className="text-base flex items-center gap-2"><Trophy className="h-4 w-4" />Top traders — last 90 days</CardTitle></CardHeader>
          <CardContent>
            {data.top_traders.length === 0 ? <p className="text-sm text-gray-400 py-4">No trade purchases in the last 90 days.</p> : (
              <ol className="divide-y">
                {data.top_traders.map((t, i) => (
                  <li key={t.id} className="py-2 flex items-center gap-3">
                    <span className="w-6 text-center text-xs font-bold text-gray-400">{i + 1}</span>
                    <button type="button" onClick={() => open(t.id)} className="flex-1 text-left min-w-0" data-testid={`open-trader-${t.id}`}>
                      <p className="text-sm font-medium truncate">{t.business_name} <span className="text-xs font-mono text-gray-400">#{t.trade_account_number}</span></p>
                      <p className="text-xs text-gray-500">credit {fmtGBP(t.credit_balance)}</p>
                    </button>
                    <span className="text-sm font-semibold flex items-center gap-1"><PoundSterling className="h-3.5 w-3.5 text-gray-400" />{fmtGBP(t.spend_90d).replace('£', '')}</span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      {!onOpenTrader && <TraderDrawer traderId={drawerId} open={!!drawerId} onOpenChange={(o) => !o && setDrawerId(null)} onChanged={load} />}
    </div>
  );
};
