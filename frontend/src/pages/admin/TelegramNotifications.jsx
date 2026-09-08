/**
 * Telegram Notifications admin — super_admin paste-and-go config.
 *
 * Setup story:
 *   1. Open Telegram on phone → search @BotFather → /newbot → save token
 *   2. Send any message to your new bot from the chat that should receive alerts
 *   3. Visit https://api.telegram.org/bot<TOKEN>/getUpdates → grab "chat":{"id":...}
 *   4. Paste both into this page → Save → click Send test
 */
import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { toast } from 'sonner';
import {
  Send, Save, Loader2, CheckCircle2, AlertCircle, Bell, ExternalLink, KeyRound,
  Search, Plus, Users, Mail, BellOff, VolumeX, Volume2,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const EVENT_LABELS = {
  visitor_landed:  ['New visitor lands on website', 'Fires once per IP per hour. Can be very noisy on launch day — leave OFF unless you want every visitor logged.'],
  new_order:       ['New order placed', 'Fires when checkout completes successfully (online or counter).'],
  new_inquiry:     ['New contact form / inquiry', 'Customer-facing forms that land in the Inbox.'],
  abandoned_basket:['Abandoned basket above threshold', 'High-value baskets only (set the £ threshold below).'],
  failed_payment:  ['Failed payment', 'Stripe rejection or 3DS timeout — useful to spot card-testing attacks.'],
  customer_error:  ['Customer hit an error on the website', 'Fires when a customer sees a red error toast, an API 5xx, or the page crashes — so you can call them before they bounce.'],
  basket_add:      ['Item added to basket', 'Fires every time a customer increases their basket count. Real buying signal — but can be noisy if you have lots of traffic.'],
  hot_session:     ['🔥 Hot session (high buying intent)', 'Fires once per session when a visitor views ≥3 product pages AND stays >2 min. Filters out drive-by visits — only genuine buying intent. Default ON.'],
  new_customer:    ['New customer / Trade account', 'Fires when someone signs up — both retail customers and Trade accounts. Default ON.'],
  extension_report:['🧩 Verona extension report received', 'Fires the moment someone presses "Send report to Tile Station" in the Verona Chrome extension — engine / server / page checks and the last problem, so nobody has to chase. Default ON.'],
  trade_login:     ['🔑 Trade customer signed in', 'Fires when a trade account signs in on the website — business, trade ref, spend, credit and device — so you can see who is engaging. One ping per trader per hour. Default ON.'],
};

export default function TelegramNotifications({ onConfigChange } = {}) {
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingOrder, setTestingOrder] = useState(false);
  const [testingFailed, setTestingFailed] = useState(false);
  const [testingRecovery, setTestingRecovery] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState(null); // null | {found:[...], instructions}
  const auth = { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } };

  const fetchCfg = useCallback(async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API_URL}/api/notifications/telegram/config`, auth);
      setCfg(r.data || null);
      if (typeof onConfigChange === 'function') onConfigChange(r.data || null);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Could not load config');
    } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { fetchCfg(); }, [fetchCfg]);

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        enabled: cfg.enabled,
        bot_token: cfg.bot_token || '',
        chat_ids: (cfg.chat_ids || []).filter(Boolean),
        events: cfg.events,
        abandoned_basket_threshold_gbp: parseInt(cfg.abandoned_basket_threshold_gbp || 100, 10),
      };
      await axios.put(`${API_URL}/api/notifications/telegram/config`, payload, auth);
      toast.success('Saved');
      await fetchCfg();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Save failed');
    } finally { setSaving(false); }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const r = await axios.post(`${API_URL}/api/notifications/telegram/test`, {}, auth);
      const sent = r.data?.sent || 0;
      const errors = r.data?.errors || [];
      if (sent > 0 && errors.length === 0) {
        toast.success(`Test sent to ${sent} chat(s) — check your Telegram`);
      } else if (sent > 0) {
        toast.warning(`Sent to ${sent}, errors on ${errors.length}: ${errors[0]}`);
      } else {
        toast.error(`Failed: ${errors[0] || 'unknown error'}`);
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Test failed');
    } finally { setTesting(false); }
  };

  const sendTestNewOrder = async () => {
    setTestingOrder(true);
    try {
      const r = await axios.post(`${API_URL}/api/notifications/telegram/test-new-order`, {}, auth);
      const result = r.data?.result || {};
      if (result.skipped) {
        toast(`Skipped: ${result.skipped}`);
      } else if (result.sent > 0) {
        toast.success(`🛒 Mock new-order sent to ${result.sent} chat(s) — check Telegram`);
      } else {
        toast.error('No chats received the notification.');
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Test failed');
    } finally { setTestingOrder(false); }
  };

  const sendTestFailedPayment = async () => {
    setTestingFailed(true);
    try {
      const r = await axios.post(`${API_URL}/api/notifications/telegram/test-failed-payment`, {}, auth);
      const result = r.data?.result || {};
      if (result.skipped) {
        toast(`Skipped: ${result.skipped}`);
      } else if (result.sent > 0) {
        toast.success(`🚨 Mock failed-payment sent to ${result.sent} chat(s) — check Telegram`);
      } else {
        toast.error('No chats received the notification.');
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Test failed');
    } finally { setTestingFailed(false); }
  };

  const sendTestRecoveryEmail = async () => {
    const to = window.prompt('Send the recovery email preview to which address?');
    if (!to) return;
    setTestingRecovery(true);
    try {
      await axios.post(
        `${API_URL}/api/notifications/telegram/test-recovery-email`,
        { to },
        auth,
      );
      toast.success(`📧 Recovery preview email sent to ${to} — check inbox`);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Send failed');
    } finally { setTestingRecovery(false); }
  };

  const discoverChats = async () => {
    setDiscovering(true);
    setDiscovered(null);
    try {
      const r = await axios.get(`${API_URL}/api/notifications/telegram/chat-ids/discover`, auth);
      setDiscovered(r.data || { found: [] });
      const n = r.data?.found?.length || 0;
      if (n === 0) {
        toast.info('No chats found yet — message your bot first, then click again.');
      } else {
        toast.success(`Found ${n} chat${n > 1 ? 's' : ''} — pick which one(s) to alert`);
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Auto-detect failed');
    } finally { setDiscovering(false); }
  };

  const addChatId = (id) => {
    const current = cfg.chat_ids || [];
    if (current.includes(String(id))) return;
    setCfg({ ...cfg, chat_ids: [...current, String(id)] });
    toast.success('Chat added — click Save to confirm.');
  };

  if (loading || !cfg) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <Card className="p-8 flex items-center justify-center text-gray-400">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
        </Card>
      </div>
    );
  }

  const updateEvent = (key, value) => {
    setCfg({ ...cfg, events: { ...cfg.events, [key]: value } });
  };
  const updateChatIds = (str) => {
    setCfg({ ...cfg, chat_ids: str.split(/[\s,]+/).map(s => s.trim()).filter(Boolean) });
  };

  // 22 Jun 2026 — 3-way per-event mode helpers
  // ─────────────────────────────────────────
  // The owner wanted a third option for noisy events like
  // "visitor_landed": don't bombard with sound/banner, but still
  // record the message so they can scroll back through the chat when
  // they manually open Telegram.
  //
  // Telegram's Bot API has `disable_notification=true` exactly for
  // this purpose. We model the three states on the config doc as:
  //   Off    →  events[key]=false (nothing sent at all)
  //   Silent →  events[key]=true  AND key ∈ silent_events
  //   Loud   →  events[key]=true  AND key ∉ silent_events
  // Backwards-compatible: any pre-existing config has no
  // silent_events array, so every "on" event reads as Loud as before.
  const getEventMode = (key) => {
    if (!cfg.events?.[key]) return 'off';
    return (cfg.silent_events || []).includes(key) ? 'silent' : 'loud';
  };
  const setEventMode = (key, mode) => {
    const currentSilent = new Set(cfg.silent_events || []);
    if (mode === 'off') {
      currentSilent.delete(key);
      setCfg({
        ...cfg,
        events: { ...cfg.events, [key]: false },
        silent_events: [...currentSilent],
      });
    } else if (mode === 'silent') {
      currentSilent.add(key);
      setCfg({
        ...cfg,
        events: { ...cfg.events, [key]: true },
        silent_events: [...currentSilent],
      });
    } else { // 'loud'
      currentSilent.delete(key);
      setCfg({
        ...cfg,
        events: { ...cfg.events, [key]: true },
        silent_events: [...currentSilent],
      });
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-4" data-testid="telegram-notifications">
      {/* Channel switcher tabs — mirrors the strip on the Email
          Notifications page so admins can flip between channels
          without leaving the area. */}
      <div
        className="inline-flex p-1 bg-muted/40 rounded-lg gap-1"
        role="tablist"
        data-testid="notification-channel-tabs"
      >
        <Link
          to="/admin/notifications"
          role="tab"
          aria-selected="false"
          className="px-4 py-1.5 text-sm font-medium rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors flex items-center gap-2"
          data-testid="notification-tab-email"
        >
          <Mail className="h-4 w-4" /> Email
        </Link>
        <button
          type="button"
          role="tab"
          aria-selected="true"
          className="px-4 py-1.5 text-sm font-semibold rounded-md bg-background shadow-sm flex items-center gap-2"
          data-testid="notification-tab-telegram-active"
        >
          <Send className="h-4 w-4" /> Telegram
        </button>
      </div>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Bell className="w-6 h-6 text-blue-600" /> Telegram Notifications
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Get instant alerts on your phone + Windows when key events happen on the website.
          </p>
        </div>
        <Button
          onClick={() => setCfg({ ...cfg, enabled: !cfg.enabled })}
          variant={cfg.enabled ? 'default' : 'outline'}
          size="sm"
          className={cfg.enabled ? 'bg-emerald-600 hover:bg-emerald-700' : ''}
          data-testid="toggle-telegram-master"
        >
          {cfg.enabled ? <CheckCircle2 className="w-4 h-4 mr-1" /> : <AlertCircle className="w-4 h-4 mr-1" />}
          {cfg.enabled ? 'Enabled' : 'Disabled'}
        </Button>
      </div>

      {/* Setup wizard */}
      <Card className="p-4 bg-blue-50 border-blue-200">
        <h3 className="text-sm font-semibold text-blue-900 flex items-center gap-1.5 mb-2">
          <KeyRound className="w-4 h-4" /> 5-minute setup
        </h3>
        <ol className="text-xs text-blue-900 space-y-1.5 list-decimal pl-5">
          <li>Open Telegram on your phone → search <b>@BotFather</b> → send <code className="bg-blue-100 px-1 rounded">/newbot</code> → name it (e.g. "Tile Station Alerts").</li>
          <li>BotFather sends back a <b>token</b> like <code className="bg-blue-100 px-1 rounded">7891234567:AAH…</code> — paste it below and click <b>Save</b>.</li>
          <li>In Telegram, open the bot you just created and tap <b>Start</b> (or send "hi"). Do this from every chat / group that should receive alerts.</li>
          <li>Click the <b>Auto-detect chat ID</b> button below — it'll list every chat that has messaged the bot. Click <b>Add</b> on the ones you want.</li>
          <li>Click <b>Save</b> then <b>Send test</b>. If you see "✅ Test message" in Telegram, you're done.</li>
          <li>Install Telegram on Windows (<a href="https://desktop.telegram.org" target="_blank" rel="noreferrer" className="underline">desktop.telegram.org</a>) so you get alerts on both devices.</li>
        </ol>
      </Card>

      <Card className="p-4 space-y-4">
        <div>
          <label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Bot token</label>
          <Input
            type="password"
            value={cfg.bot_token || ''}
            onChange={(e) => setCfg({ ...cfg, bot_token: e.target.value })}
            placeholder="7891234567:AAH..."
            className="mt-1 font-mono text-sm"
            data-testid="telegram-bot-token"
          />
          {cfg.bot_token_masked && (
            <p className="text-[10px] text-gray-500 mt-1 font-mono">Saved: {cfg.bot_token_masked}</p>
          )}
        </div>
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
              Chat IDs <span className="font-normal text-gray-400">(comma or space separated for multiple)</span>
            </label>
            <Button
              type="button"
              onClick={discoverChats}
              disabled={discovering || !cfg.bot_token}
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              data-testid="telegram-auto-detect"
              title={!cfg.bot_token ? 'Save the bot token first' : 'Read recent messages your bot received'}
            >
              {discovering
                ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                : <Search className="w-3.5 h-3.5 mr-1" />}
              Auto-detect chat ID
            </Button>
          </div>
          <Input
            value={(cfg.chat_ids || []).join(', ')}
            onChange={(e) => updateChatIds(e.target.value)}
            placeholder="-100123456789, 987654321"
            className="font-mono text-sm"
            data-testid="telegram-chat-ids"
          />
          <p className="text-[10px] text-gray-500 mt-1">
            <b>Easiest path:</b> open Telegram on your phone → search the bot you just created → tap <b>Start</b> or send "hi" →
            click <b>Auto-detect</b> above. Or paste a chat ID manually (group chats start with <code>-100…</code>).
          </p>

          {discovered && (
            <div
              className="mt-3 border border-gray-200 rounded-lg overflow-hidden"
              data-testid="telegram-discovered-chats"
            >
              {discovered.found?.length > 0 ? (
                <ul className="divide-y divide-gray-100">
                  {discovered.found.map(chat => {
                    const already = chat.already_added || (cfg.chat_ids || []).map(String).includes(chat.id);
                    return (
                      <li key={chat.id} className="px-3 py-2 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate flex items-center gap-1.5">
                            {chat.type === 'private'
                              ? <Bell className="w-3.5 h-3.5 text-blue-500" />
                              : <Users className="w-3.5 h-3.5 text-emerald-500" />}
                            {chat.name}
                          </p>
                          <p className="text-[11px] text-gray-500 font-mono">
                            {chat.id} · {chat.type}
                          </p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant={already ? 'ghost' : 'default'}
                          disabled={already}
                          onClick={() => addChatId(chat.id)}
                          className="h-7 text-xs"
                          data-testid={`telegram-add-chat-${chat.id}`}
                        >
                          {already
                            ? <><CheckCircle2 className="w-3.5 h-3.5 mr-1 text-emerald-500" /> Added</>
                            : <><Plus className="w-3.5 h-3.5 mr-1" /> Add</>}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="px-3 py-3 text-xs text-amber-800 bg-amber-50">
                  {discovered.instructions
                    || 'No chats found — send any message to your bot from Telegram, then click Auto-detect again.'}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
          <Button
            onClick={sendTest}
            disabled={testing || !cfg.bot_token || !(cfg.chat_ids || []).length}
            variant="outline"
            data-testid="telegram-test"
          >
            {testing ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
            Send test
          </Button>
          <Button
            onClick={sendTestNewOrder}
            disabled={testingOrder || !cfg.enabled || !cfg.bot_token || !(cfg.chat_ids || []).length || !((cfg.events || {}).new_order)}
            variant="outline"
            data-testid="telegram-test-new-order"
            title="Fires a sample 🛒 New order ping through the same code path real orders use. Verifies the wire-up end-to-end without creating a live order."
          >
            {testingOrder ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            🛒 Test new order
          </Button>
          <Button
            onClick={sendTestFailedPayment}
            disabled={testingFailed || !cfg.enabled || !cfg.bot_token || !(cfg.chat_ids || []).length || !((cfg.events || {}).failed_payment)}
            variant="outline"
            data-testid="telegram-test-failed-payment"
            title="Fires a sample 🚨 Payment failed ping through the same code path real card declines use. Verifies the wire-up without creating a live failed transaction."
          >
            {testingFailed ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            🚨 Test failed payment
          </Button>
          <Button
            onClick={sendTestRecoveryEmail}
            disabled={testingRecovery}
            variant="outline"
            data-testid="telegram-test-recovery-email"
            title="Sends the 'your payment didn't go through' recovery email to an address you choose, so you can preview the wording and CTA before it goes to live customers."
          >
            {testingRecovery ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            📧 Preview recovery email
          </Button>
          <Button onClick={save} disabled={saving} data-testid="telegram-save">
            {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
            Save
          </Button>
        </div>
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-900">Which events trigger a notification?</h3>
          {/* Legend for the 3-way mode buttons. Mirrors the column
              widths below so the icons are self-explanatory at a glance. */}
          <div className="flex items-center gap-3 text-[11px] text-gray-500">
            <span className="flex items-center gap-1"><BellOff className="w-3 h-3" /> Off</span>
            <span className="flex items-center gap-1"><VolumeX className="w-3 h-3" /> Silent log</span>
            <span className="flex items-center gap-1"><Volume2 className="w-3 h-3" /> Loud ping</span>
          </div>
        </div>
        {Object.entries(EVENT_LABELS).map(([key, [label, hint]]) => {
          const mode = getEventMode(key);
          return (
            <div key={key} className="flex items-start justify-between gap-3 py-2 border-b border-gray-100 last:border-0">
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900">{label}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">{hint}</p>
              </div>
              <EventModeToggle
                mode={mode}
                onChange={(m) => setEventMode(key, m)}
                testIdBase={`telegram-event-${key}`}
              />
            </div>
          );
        })}
        {cfg.events?.abandoned_basket && (
          <div className="pt-2">
            <label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
              Abandoned basket threshold (£)
            </label>
            <Input
              type="number"
              min={0}
              value={cfg.abandoned_basket_threshold_gbp || 100}
              onChange={(e) => setCfg({ ...cfg, abandoned_basket_threshold_gbp: e.target.value })}
              className="mt-1 max-w-[120px]"
              data-testid="telegram-abandoned-threshold"
            />
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * EventModeToggle — 3-way segmented control for a Telegram event's
 * delivery mode.
 *
 *   Off    →  no message sent at all (the event toggle is off)
 *   Silent →  message is sent but with Telegram's
 *             `disable_notification=true` flag, so it appears in the
 *             chat history without a sound, vibration, or
 *             lock-screen banner. Designed for the owner's exact
 *             ask: "I want to stay quiet but still see the event
 *             when I open Telegram manually."
 *   Loud   →  normal alert with sound, banner, the lot.
 *
 * Hoisted out of the parent component so the row's DOM identity is
 * stable across renders of the events list (avoids React's
 * no-unstable-nested-components rule and is faster too).
 */
function EventModeToggle({ mode, onChange, testIdBase }) {
  const options = [
    { value: 'off',    Icon: BellOff,  label: 'Off',    title: 'No message sent' },
    { value: 'silent', Icon: VolumeX,  label: 'Silent', title: 'Log to chat without a sound — visible when you manually open Telegram' },
    { value: 'loud',   Icon: Volume2,  label: 'Loud',   title: 'Normal alert with sound + banner' },
  ];
  return (
    <div
      className="inline-flex rounded-md border border-gray-200 bg-gray-50 p-0.5"
      role="radiogroup"
      data-testid={testIdBase}
    >
      {options.map(({ value, Icon, label, title }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            title={title}
            onClick={() => onChange(value)}
            className={
              'px-2 py-1 text-[11px] font-medium rounded-[5px] flex items-center gap-1 transition-colors ' +
              (active
                ? value === 'silent'
                  ? 'bg-amber-500 text-white shadow-sm'
                  : value === 'loud'
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'bg-gray-700 text-white shadow-sm'
                : 'text-gray-600 hover:text-gray-900')
            }
            data-testid={`${testIdBase}-${value}`}
          >
            <Icon className="w-3 h-3" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
