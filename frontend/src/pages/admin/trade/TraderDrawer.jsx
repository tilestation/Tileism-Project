import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ShoppingBag, Store, Coins, LogIn, MessageCircle, Beaker, FileText, KeyRound, UserPlus, Mail,
  RotateCcw, Sparkles, Pencil, Save, Send, StickyNote,
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '../../../components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../../components/ui/tabs';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';
import { api } from '../../../lib/api';
import { useAuth } from '../../../contexts/AuthContext';
import { fmtGBP, fmtDate, daysSince } from './tradeFormat';
import { ChannelBadge, LoginStatusBadge, SeenBadge } from './TradeBadges';
import { TradeLedgerTable } from './TradeLedgerTable';
import { CreditAdjustDialog } from './CreditAdjustDialog';
import { CreditExpiryControls } from './CreditExpiryControls';
import { LoginCheckPanel } from './LoginCheckPanel';

const KIND_ICON = {
  online_order: ShoppingBag, in_store_invoice: Store, refund: RotateCcw, credit: Coins, login: LogIn,
  whatsapp: MessageCircle, sample_order: Beaker, quote: FileText, login_link: KeyRound, password_set: KeyRound,
  registered: UserPlus, credit_expiry_reminder: Mail, dormant_nudge: Sparkles, credit_adjusted: Coins,
  credit_expired: Coins, credit_expiry_set: Coins, trade_rep_assigned: Pencil, first_login_welcome: Mail,
};
const KIND_CLASS = {
  online_order: 'bg-sky-100 text-sky-700', in_store_invoice: 'bg-violet-100 text-violet-700', refund: 'bg-rose-100 text-rose-700',
  credit: 'bg-emerald-100 text-emerald-700', login: 'bg-gray-100 text-gray-600', whatsapp: 'bg-green-100 text-green-700',
  sample_order: 'bg-teal-100 text-teal-700', quote: 'bg-indigo-100 text-indigo-700', registered: 'bg-amber-100 text-amber-700',
};
const FILTERS = [
  ['all', 'Everything'], ['purchases', 'Purchases'], ['credit', 'Credit'], ['contact', 'Emails & WhatsApp'], ['access', 'Logins & access'],
];
const FILTER_KINDS = {
  purchases: ['online_order', 'in_store_invoice', 'refund', 'sample_order', 'quote'],
  credit: ['credit', 'credit_adjusted', 'credit_expired', 'credit_expiry_set', 'credit_expiry_reminder'],
  contact: ['whatsapp', 'credit_expiry_reminder', 'dormant_nudge', 'login_link', 'first_login_welcome'],
  access: ['login', 'login_link', 'password_set', 'registered', 'first_login_welcome'],
};

const Stat = ({ label, value, sub, testId }) => (
  <div className="rounded-lg border bg-white p-3" data-testid={testId}>
    <p className="text-[11px] uppercase tracking-wide text-gray-500">{label}</p>
    <p className="text-lg font-semibold text-gray-900 leading-tight">{value}</p>
    {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
  </div>
);

const Timeline = ({ events }) => {
  const [filter, setFilter] = useState('all');
  const shown = filter === 'all' ? events : events.filter((e) => FILTER_KINDS[filter]?.includes(e.kind));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map(([k, label]) => (
          <button key={k} type="button" onClick={() => setFilter(k)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${filter === k ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
            data-testid={`timeline-filter-${k}`}>{label}</button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-gray-400 py-8 text-center" data-testid="timeline-empty">Nothing here yet.</p>
      ) : (
        <ol className="relative border-l border-gray-200 ml-3 space-y-4" data-testid="trader-timeline">
          {shown.map((e, i) => {
            const Icon = KIND_ICON[e.kind] || Coins;
            return (
              <li key={`${e.kind}-${e.at}-${i}`} className="ml-5">
                <span className={`absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-white ${KIND_CLASS[e.kind] || 'bg-gray-100 text-gray-600'}`}>
                  <Icon className="h-3 w-3" />
                </span>
                <div className="flex items-baseline justify-between gap-3">
                  <p className="text-sm font-medium text-gray-900">{e.title}</p>
                  <time className="text-xs text-gray-400 whitespace-nowrap">{fmtDate(e.at, true)}</time>
                </div>
                {e.detail && <p className="text-xs text-gray-500 mt-0.5 break-words">{e.detail}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};

const NotesPanel = ({ trader, onSaved }) => {
  const [notes, setNotes] = useState(trader.internal_notes || '');
  const [rep, setRep] = useState(trader.trade_rep || '');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.setTraderNotes(trader.id, { internal_notes: notes, trade_rep: rep });
      toast.success('Saved');
      onSaved?.();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Could not save');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs font-medium text-gray-600">Trade rep (who owns this relationship)</label>
        <Input value={rep} onChange={(e) => setRep(e.target.value)} placeholder="e.g. Sydenham — Aisha" data-testid="trader-rep-input" />
      </div>
      <div>
        <label className="text-xs font-medium text-gray-600">Internal notes (never shown to the trader)</label>
        <Textarea rows={6} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Jobs coming up, preferred products, who to call…" data-testid="trader-notes-input" />
      </div>
      <Button size="sm" onClick={save} disabled={saving} data-testid="trader-notes-save"><Save className="h-3.5 w-3.5 mr-1" />{saving ? 'Saving…' : 'Save notes'}</Button>
    </div>
  );
};

export const TraderDrawer = ({ traderId, open, onOpenChange, onChanged }) => {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const [data, setData] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [loading, setLoading] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    if (!traderId) return;
    setLoading(true);
    try {
      const [t, l] = await Promise.all([api.getTraderTimeline(traderId), api.getTraderLedger(traderId)]);
      setData(t.data);
      setLedger(l.data);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Could not load trader');
    } finally {
      setLoading(false);
    }
  }, [traderId]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const refresh = () => { load(); onChanged?.(); };
  const trader = data?.trader;

  const act = async (key, fn, ok) => {
    setBusy(key);
    try {
      const { data: d } = await fn();
      toast.success(typeof ok === 'function' ? ok(d) : ok);
      refresh();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  const lastPurchase = data?.events?.find((e) => e.kind === 'online_order' || e.kind === 'in_store_invoice')?.at;
  const purchaseDays = daysSince(lastPurchase);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto" data-testid="trader-drawer">
        {!trader ? (
          <>
            <SheetHeader className="sr-only"><SheetTitle>Trader</SheetTitle><SheetDescription>Loading trader details</SheetDescription></SheetHeader>
            <div className="py-20 text-center text-gray-400 text-sm">{loading ? 'Loading trader…' : 'No trader selected'}</div>
          </>
        ) : (
          <>
            <SheetHeader className="text-left">
              <div className="flex flex-wrap items-center gap-2">
                <SheetTitle className="text-xl" data-testid="trader-drawer-title">{trader.business_name || trader.name}</SheetTitle>
                {trader.trade_account_number && <span className="text-xs font-mono font-semibold bg-gray-100 border px-2 py-0.5 rounded">#{trader.trade_account_number}</span>}
                <ChannelBadge account={{ ...trader, id: trader.id }} showDetail />
                <LoginStatusBadge account={trader} />
                <SeenBadge account={{ ...trader, logins_30d: data.events?.filter((e) => e.kind === 'login' && daysSince(e.at) <= 30).length }} />
              </div>
              <SheetDescription className="text-sm">
                {trader.name} · {trader.email} · {trader.phone || 'no phone'}
                {trader.trade_rep && <span className="ml-2 text-gray-500">· Rep: {trader.trade_rep}</span>}
              </SheetDescription>
            </SheetHeader>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-4">
              <Stat label="Credit balance" value={fmtGBP(trader.credit_balance)} sub={trader.credit_expires_at ? `expires ${fmtDate(trader.credit_expires_at)}` : 'no expiry'} testId="trader-stat-balance" />
              <Stat label="Total spend" value={fmtGBP(trader.total_spent)} sub={`${trader.order_count || 0} online orders`} testId="trader-stat-spend" />
              <Stat label="Last purchase" value={lastPurchase ? fmtDate(lastPurchase) : '—'} sub={purchaseDays != null ? `${purchaseDays} days ago` : 'never'} testId="trader-stat-purchase" />
              <Stat label="Last sign-in" value={trader.last_login_at ? fmtDate(trader.last_login_at) : trader.login_status === 'ready' ? 'Not tracked yet' : 'Never'} sub={trader.login_link_sent_at ? `link sent ${fmtDate(trader.login_link_sent_at)}` : trader.login_status === 'ready' ? 'has own password' : ''} testId="trader-stat-login" />
            </div>

            <div className="flex flex-wrap gap-2 mt-4">
              <Button size="sm" variant="outline" disabled={busy === 'link'} onClick={() => act('link', () => api.sendTradeLoginLink(trader.id), (d) => d.email_sent ? 'Login link emailed' : `Link created — email not sent (${d.email_error || 'email unavailable'})`)} data-testid="drawer-send-login-link">
                <KeyRound className="h-3.5 w-3.5 mr-1" /> Send login link
              </Button>
              <Button size="sm" variant="outline" disabled={busy === 'nudge'} onClick={() => act('nudge', () => api.sendDormantNudge([trader.id]), (d) => d.sent ? 'Win-back email sent' : `Not sent: ${d.failed?.[0]?.error || 'email failed'}`)} data-testid="drawer-send-nudge">
                <Send className="h-3.5 w-3.5 mr-1" /> Win-back email
              </Button>
              {trader.phone && (
                <a className="inline-flex items-center h-8 px-3 rounded-md border text-sm text-green-700 border-green-200 hover:bg-green-50" href={`https://wa.me/${trader.phone.replace(/\D/g, '').replace(/^0/, '44')}`} target="_blank" rel="noopener noreferrer" data-testid="drawer-whatsapp">
                  <MessageCircle className="h-3.5 w-3.5 mr-1" /> WhatsApp
                </a>
              )}
              {isSuperAdmin && (
                <Button size="sm" onClick={() => setAdjustOpen(true)} data-testid="drawer-adjust-credit">
                  <Coins className="h-3.5 w-3.5 mr-1" /> Adjust credit
                </Button>
              )}
            </div>

            <Tabs defaultValue="timeline" className="mt-5">
              <TabsList className="grid grid-cols-4 w-full">
                <TabsTrigger value="timeline" data-testid="drawer-tab-timeline">Timeline</TabsTrigger>
                <TabsTrigger value="ledger" data-testid="drawer-tab-ledger">Credit ledger</TabsTrigger>
                <TabsTrigger value="login" data-testid="drawer-tab-login"><KeyRound className="h-3.5 w-3.5 mr-1" />Login check</TabsTrigger>
                <TabsTrigger value="notes" data-testid="drawer-tab-notes"><StickyNote className="h-3.5 w-3.5 mr-1" />Notes</TabsTrigger>
              </TabsList>
              <TabsContent value="timeline" className="mt-4">
                <Timeline events={data.events || []} />
              </TabsContent>
              <TabsContent value="login" className="mt-4">
                <LoginCheckPanel traderId={trader.id} busy={busy}
                  onSendLink={() => act('link', () => api.sendTradeLoginLink(trader.id), (d) => d.email_sent ? 'Login link emailed' : `Link created — email not sent (${d.email_error || 'email unavailable'})`)} />
              </TabsContent>
              <TabsContent value="ledger" className="mt-4 space-y-4">
                {ledger && (
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
                    {[['Earned', ledger.totals.earned, 'text-emerald-700'], ['Redeemed', ledger.totals.redeemed, 'text-gray-700'], ['Clawed back', ledger.totals.clawed_back, 'text-rose-700'], ['Expired', ledger.totals.expired, 'text-amber-700'], ['Balance', ledger.totals.account_balance, 'text-gray-900']].map(([l, v, c]) => (
                      <div key={l} className="rounded-md border bg-gray-50 p-2">
                        <p className="text-[10px] uppercase text-gray-500">{l}</p>
                        <p className={`text-sm font-semibold ${c}`}>{fmtGBP(v)}</p>
                      </div>
                    ))}
                  </div>
                )}
                {ledger && Math.abs((ledger.totals.ledger_balance || 0) - (ledger.totals.account_balance || 0)) > 0.009 && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1" data-testid="ledger-mismatch">
                    Ledger total {fmtGBP(ledger.totals.ledger_balance)} differs from account balance {fmtGBP(ledger.totals.account_balance)} — legacy movements may predate the ledger. Use an adjustment to reconcile.
                  </p>
                )}
                <CreditExpiryControls trader={trader} isSuperAdmin={isSuperAdmin} onChanged={refresh} />
                <TradeLedgerTable rows={ledger?.rows || []} />
              </TabsContent>
              <TabsContent value="notes" className="mt-4">
                <NotesPanel trader={trader} onSaved={refresh} />
              </TabsContent>
            </Tabs>

            <CreditAdjustDialog open={adjustOpen} onOpenChange={setAdjustOpen} trader={trader} onDone={refresh} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
};
