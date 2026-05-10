/**
 * Admin · Trade Credit Emails
 * ───────────────────────────
 * One screen to manage the WEEKLY "you've got £X in trade credit waiting"
 * email — the engagement nudge that's separate from the monthly statement.
 *
 * Capabilities:
 *   • Live preview the rendered email (with current admin custom-intro)
 *   • See how many traders would receive it right now + total credit £
 *   • Send it now to ALL eligible (with confirm + force re-run)
 *   • Send it to ONE specific trader on demand
 *   • Edit the weekly cadence (weekday/hour) + custom intro paragraph
 *   • Toggle the schedule on/off
 *   • View last-run status (when, by whom, sent count, errors)
 *
 * Backend contract: /api/admin/trade-credit/weekly/* — see
 * routes/trade_credit_statements.py.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import {
  Mail, Send, RefreshCw, Eye, Users, AlertCircle, CheckCircle2,
  PoundSterling, Clock, Save, Calendar, Sparkles,
} from 'lucide-react';

const API = process.env.REACT_APP_BACKEND_URL;
const tokenHdr = () => {
  const t = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
  return t ? { Authorization: `Bearer ${t}` } : {};
};

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const fmtMoney = (n) => `£${(Number(n) || 0).toFixed(2)}`;

const fmtDateTime = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return iso; }
};

export default function TradeCreditEmails() {
  // Settings (cadence, custom intro, last run)
  const [settings, setSettings] = useState(null);
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);

  // Eligible traders snapshot
  const [eligible, setEligible] = useState({ count: 0, total_credit: 0, traders: [] });
  const [loadingEligible, setLoadingEligible] = useState(true);

  // Live preview HTML
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewSubject, setPreviewSubject] = useState('');
  const [previewEmail, setPreviewEmail] = useState('');
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Send-one form
  const [sendOneEmail, setSendOneEmail] = useState('');
  const [sendingOne, setSendingOne] = useState(false);

  // Send-all dialog
  const [confirmingSendAll, setConfirmingSendAll] = useState(false);
  const [sendingAll, setSendingAll] = useState(false);

  // Per-trader inclusion: a Set of UNCHECKED emails. We track exclusions
  // (rather than inclusions) so newly-added eligible traders are opted-in
  // by default — safer behaviour for a re-engagement email.
  const [excluded, setExcluded] = useState(() => new Set());

  // Local edits
  const [draftIntro, setDraftIntro] = useState('');
  const [draftEnabled, setDraftEnabled] = useState(true);
  const [draftWeekday, setDraftWeekday] = useState(0);
  const [draftHour, setDraftHour] = useState(10);

  const fetchSettings = useCallback(async () => {
    setLoadingSettings(true);
    try {
      const r = await axios.get(`${API}/api/admin/trade-credit/weekly/settings`, { headers: tokenHdr() });
      setSettings(r.data);
      setDraftIntro(r.data.custom_intro || '');
      setDraftEnabled(r.data.enabled !== false);
      setDraftWeekday(Number.isInteger(r.data.weekday) ? r.data.weekday : 0);
      setDraftHour(Number.isInteger(r.data.hour_utc) ? r.data.hour_utc : 10);
    } catch (e) {
      toast.error(`Failed to load settings: ${e?.response?.data?.detail || e.message}`);
    } finally { setLoadingSettings(false); }
  }, []);

  const fetchEligible = useCallback(async () => {
    setLoadingEligible(true);
    try {
      const r = await axios.get(`${API}/api/admin/trade-credit/weekly/eligible`, { headers: tokenHdr() });
      setEligible(r.data);
    } catch (e) {
      toast.error(`Failed to load eligible traders: ${e?.response?.data?.detail || e.message}`);
    } finally { setLoadingEligible(false); }
  }, []);

  const fetchPreview = useCallback(async (email = '') => {
    setLoadingPreview(true);
    try {
      const url = email
        ? `${API}/api/admin/trade-credit/weekly/preview?email=${encodeURIComponent(email)}`
        : `${API}/api/admin/trade-credit/weekly/preview`;
      const r = await axios.get(url, { headers: tokenHdr() });
      setPreviewHtml(r.data.html);
      setPreviewSubject(r.data.subject);
    } catch (e) {
      toast.error(`Preview failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setLoadingPreview(false); }
  }, []);

  useEffect(() => {
    fetchSettings();
    fetchEligible();
    fetchPreview();
  }, [fetchSettings, fetchEligible, fetchPreview]);

  const dirty = useMemo(() => {
    if (!settings) return false;
    return (
      (draftIntro || '') !== (settings.custom_intro || '')
      || draftEnabled !== (settings.enabled !== false)
      || draftWeekday !== (Number.isInteger(settings.weekday) ? settings.weekday : 0)
      || draftHour !== (Number.isInteger(settings.hour_utc) ? settings.hour_utc : 10)
    );
  }, [settings, draftIntro, draftEnabled, draftWeekday, draftHour]);

  const saveSettings = async () => {
    setSavingSettings(true);
    try {
      await axios.put(`${API}/api/admin/trade-credit/weekly/settings`, {
        enabled: draftEnabled,
        weekday: draftWeekday,
        hour_utc: draftHour,
        custom_intro: draftIntro,
      }, { headers: tokenHdr() });
      toast.success('Settings saved — preview refreshing');
      await fetchSettings();
      await fetchPreview(previewEmail);
    } catch (e) {
      toast.error(`Save failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setSavingSettings(false); }
  };

  const sendOne = async () => {
    if (!sendOneEmail.trim()) { toast.error('Enter a trader email'); return; }
    setSendingOne(true);
    try {
      const r = await axios.post(`${API}/api/admin/trade-credit/weekly/send-one`, {
        email: sendOneEmail.trim(),
      }, { headers: tokenHdr() });
      toast.success(`Sent! ${r.data.customer_email} — balance ${fmtMoney(r.data.credit_balance)}`);
      setSendOneEmail('');
    } catch (e) {
      toast.error(`Send failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setSendingOne(false); }
  };

  const doSendAll = async (force = false) => {
    setSendingAll(true);
    try {
      const r = await axios.post(`${API}/api/admin/trade-credit/weekly/send-now`, {
        force,
        dry_run: false,
        exclude_emails: Array.from(excluded),
      }, { headers: tokenHdr() });
      const exMsg = r.data.excluded ? ` · skipped ${r.data.excluded}` : '';
      toast.success(`Sent ${r.data.sent}/${r.data.eligible}${exMsg} · failed ${r.data.failed}`);
      setConfirmingSendAll(false);
      await fetchSettings();
    } catch (e) {
      const detail = e?.response?.data?.detail || e.message;
      if (e?.response?.status === 409) {
        // Already sent this week — offer force option
        if (window.confirm(`${detail}\n\nRe-send anyway?`)) {
          await doSendAll(true);
          return;
        }
      } else {
        toast.error(`Send failed: ${detail}`);
      }
    } finally { setSendingAll(false); }
  };

  const lastResult = settings?.last_result;

  // Selection helpers
  const toggleExclude = (email) => {
    setExcluded(prev => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  };
  const selectAll = () => setExcluded(new Set());
  const selectNone = () => setExcluded(new Set(eligible.traders.map(t => t.email)));
  const selectedCount = Math.max(0, eligible.count - excluded.size);
  const selectedTotal = eligible.traders
    .filter(t => !excluded.has(t.email))
    .reduce((s, t) => s + (Number(t.credit_balance) || 0), 0);

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6" data-testid="trade-credit-emails-page">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Mail className="w-6 h-6 text-amber-500" />
            Weekly Trade Credit Email
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            "You've got £X in trade credit waiting" — the weekly nudge that drives traders back into the shop.
          </p>
        </div>
        <Button variant="outline" onClick={() => { fetchSettings(); fetchEligible(); fetchPreview(previewEmail); }} data-testid="refresh-btn">
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh
        </Button>
      </div>

      {/* Top row — eligible + last run + status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-wide">
            <Users className="w-4 h-4" /> Eligible right now
          </div>
          <div className="text-3xl font-bold mt-2 tabular-nums" data-testid="eligible-count">
            {loadingEligible ? '…' : eligible.count}
          </div>
          <div className="text-xs text-gray-500">traders with credit balance</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-wide">
            <PoundSterling className="w-4 h-4" /> Total trade credit
          </div>
          <div className="text-3xl font-bold mt-2 tabular-nums text-emerald-700">
            {loadingEligible ? '…' : fmtMoney(eligible.total_credit)}
          </div>
          <div className="text-xs text-gray-500">sitting unredeemed</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-wide">
            <Clock className="w-4 h-4" /> Last batch sent
          </div>
          <div className="text-base font-semibold mt-2">
            {loadingSettings ? '…' : fmtDateTime(settings?.last_run_at)}
          </div>
          {lastResult ? (
            <div className="text-xs text-gray-500 mt-1" data-testid="last-result">
              {lastResult.sent}/{lastResult.eligible} sent
              {lastResult.failed > 0 && <span className="text-red-600"> · {lastResult.failed} failed</span>}
            </div>
          ) : (
            <div className="text-xs text-gray-400 mt-1">Never</div>
          )}
        </Card>
      </div>

      {/* Action row — Send Now + Send to One */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card className="p-5">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Send className="w-5 h-5 text-amber-500" /> Send weekly batch now
          </h2>
          <p className="text-sm text-gray-600 mt-1">
            Dispatches the email to <strong>{selectedCount}</strong> selected
            trader{selectedCount === 1 ? '' : 's'}{excluded.size > 0 ? ` (${excluded.size} excluded)` : ''}.
          </p>
          {!confirmingSendAll ? (
            <Button
              className="mt-3 w-full bg-amber-500 hover:bg-amber-600 text-white"
              onClick={() => setConfirmingSendAll(true)}
              disabled={selectedCount === 0 || !settings?.enabled}
              data-testid="send-all-init-btn"
            >
              <Send className="w-4 h-4 mr-2" />
              {selectedCount === 0
                ? 'No traders selected'
                : `Send to ${selectedCount} selected trader${selectedCount === 1 ? '' : 's'}`}
            </Button>
          ) : (
            <div className="mt-3 p-3 border-2 border-amber-300 rounded-lg bg-amber-50">
              <p className="text-sm font-semibold text-amber-900">
                Confirm — {selectedCount} traders will receive this email ({fmtMoney(selectedTotal)} total credit).
                {excluded.size > 0 && <span className="block mt-1 text-xs font-normal text-amber-700">
                  {excluded.size} trader{excluded.size === 1 ? '' : 's'} excluded by you.
                </span>}
              </p>
              <div className="flex gap-2 mt-3">
                <Button
                  className="flex-1 bg-amber-600 hover:bg-amber-700 text-white"
                  onClick={() => doSendAll(false)}
                  disabled={sendingAll}
                  data-testid="send-all-confirm-btn"
                >
                  {sendingAll ? 'Sending…' : 'Yes, send now'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setConfirmingSendAll(false)}
                  disabled={sendingAll}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Mail className="w-5 h-5 text-blue-500" /> Send to one trader
          </h2>
          <p className="text-sm text-gray-600 mt-1">
            On-demand send. Useful when a trader's on the phone asking about their balance.
          </p>
          <div className="flex gap-2 mt-3">
            <Input
              type="email"
              value={sendOneEmail}
              onChange={(e) => setSendOneEmail(e.target.value)}
              placeholder="trader@example.com"
              data-testid="send-one-input"
            />
            <Button
              onClick={sendOne}
              disabled={sendingOne || !sendOneEmail.trim()}
              data-testid="send-one-btn"
            >
              {sendingOne ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </Card>
      </div>

      {/* Cadence + content settings */}
      <Card className="p-5">
        <div className="flex items-start justify-between mb-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Calendar className="w-5 h-5 text-emerald-500" /> Cadence & content
          </h2>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">Schedule {draftEnabled ? 'on' : 'off'}</span>
            <Switch
              checked={draftEnabled}
              onCheckedChange={setDraftEnabled}
              data-testid="enabled-switch"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">Send weekday</label>
            <div className="flex gap-1 mt-2 flex-wrap">
              {WEEKDAYS.map((d, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setDraftWeekday(i)}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
                    draftWeekday === i
                      ? 'bg-amber-500 text-white border-amber-500'
                      : 'bg-white text-gray-700 border-gray-300 hover:border-amber-300'
                  }`}
                  data-testid={`weekday-${d.toLowerCase()}`}
                >{d}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-bold text-gray-500 uppercase tracking-wide">Send time (UTC)</label>
            <select
              value={draftHour}
              onChange={(e) => setDraftHour(Number(e.target.value))}
              className="w-full mt-2 px-3 py-2 border border-gray-300 rounded-lg text-sm"
              data-testid="hour-select"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00 UTC
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-5">
          <label className="text-xs font-bold text-gray-500 uppercase tracking-wide flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-amber-500" />
            Custom intro paragraph (optional)
          </label>
          <p className="text-xs text-gray-500 mt-1 mb-2">
            Replaces the default reminder copy. Use it for "this week's pick", a seasonal offer, or a personal note from you.
            Leave blank to use the default friendly copy.
          </p>
          <Textarea
            value={draftIntro}
            onChange={(e) => setDraftIntro(e.target.value)}
            rows={4}
            maxLength={600}
            placeholder="e.g. This week we've got 70% off Plus39 — would be a great time to redeem your credit while stock lasts."
            data-testid="custom-intro-textarea"
          />
          <div className="text-xs text-gray-400 mt-1 text-right">{draftIntro.length}/600</div>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          {dirty && (
            <Button variant="outline" onClick={() => fetchSettings()} disabled={savingSettings}>
              Discard changes
            </Button>
          )}
          <Button
            onClick={saveSettings}
            disabled={!dirty || savingSettings}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
            data-testid="save-settings-btn"
          >
            <Save className="w-4 h-4 mr-2" /> {savingSettings ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      </Card>

      {/* Live preview */}
      <Card className="p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Eye className="w-5 h-5 text-purple-500" /> Live preview
          </h2>
          <div className="flex gap-2 items-center">
            <Input
              type="email"
              value={previewEmail}
              onChange={(e) => setPreviewEmail(e.target.value)}
              placeholder="Real trader email (optional)"
              className="w-72"
              data-testid="preview-email-input"
            />
            <Button
              variant="outline"
              onClick={() => fetchPreview(previewEmail)}
              disabled={loadingPreview}
              data-testid="preview-refresh-btn"
            >
              <Eye className="w-4 h-4 mr-2" /> Render
            </Button>
          </div>
        </div>
        {previewSubject && (
          <div className="mb-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wide mr-2">Subject:</span>
            <span className="text-sm font-medium" data-testid="preview-subject">{previewSubject}</span>
          </div>
        )}
        <div className="border border-gray-200 rounded-lg overflow-hidden bg-gray-50">
          {previewHtml ? (
            <iframe
              title="Email preview"
              srcDoc={previewHtml}
              className="w-full"
              style={{ height: 720, border: 0, background: 'white' }}
              data-testid="preview-iframe"
            />
          ) : (
            <div className="p-12 text-center text-gray-400">
              {loadingPreview ? 'Rendering…' : 'No preview yet'}
            </div>
          )}
        </div>
      </Card>

      {/* Eligible traders list */}
      <Card className="p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Users className="w-5 h-5 text-indigo-500" /> Eligible traders
            {eligible.count > 0 && (
              <span className="text-sm font-normal text-gray-500">
                · {selectedCount} of {eligible.count} selected · {fmtMoney(selectedTotal)} total
              </span>
            )}
          </h2>
          {eligible.traders.length > 0 && (
            <div className="flex gap-2 items-center text-xs">
              <button onClick={selectAll} className="px-3 py-1 rounded-full border border-gray-300 hover:border-amber-400 text-gray-700" data-testid="select-all-btn">
                Select all
              </button>
              <button onClick={selectNone} className="px-3 py-1 rounded-full border border-gray-300 hover:border-amber-400 text-gray-700" data-testid="select-none-btn">
                Select none
              </button>
            </div>
          )}
        </div>
        {eligible.traders.length === 0 ? (
          <p className="text-sm text-gray-500">No traders currently have a positive credit balance.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="eligible-traders-table">
              <thead>
                <tr className="text-left border-b border-gray-200">
                  <th className="py-2 px-2 w-10">
                    <input
                      type="checkbox"
                      checked={excluded.size === 0 && eligible.traders.length > 0}
                      onChange={(e) => (e.target.checked ? selectAll() : selectNone())}
                      className="w-4 h-4 accent-amber-500 cursor-pointer"
                      title="Select / deselect all"
                      data-testid="select-all-checkbox"
                    />
                  </th>
                  <th className="py-2 px-2 font-medium text-gray-500">Email</th>
                  <th className="py-2 px-2 font-medium text-gray-500">Name</th>
                  <th className="py-2 px-2 font-medium text-gray-500">Business</th>
                  <th className="py-2 px-2 font-medium text-gray-500 text-right">Balance</th>
                  <th className="py-2 px-2 font-medium text-gray-500"></th>
                </tr>
              </thead>
              <tbody>
                {eligible.traders.map((t) => {
                  const isIncluded = !excluded.has(t.email);
                  return (
                    <tr
                      key={t.email}
                      className={`border-b border-gray-100 hover:bg-gray-50 ${isIncluded ? '' : 'opacity-50'}`}
                    >
                      <td className="py-2 px-2">
                        <input
                          type="checkbox"
                          checked={isIncluded}
                          onChange={() => toggleExclude(t.email)}
                          className="w-4 h-4 accent-amber-500 cursor-pointer"
                          data-testid={`include-checkbox-${t.email}`}
                          aria-label={`Include ${t.email} in batch`}
                        />
                      </td>
                      <td className="py-2 px-2 font-mono text-xs">{t.email}</td>
                      <td className="py-2 px-2">{t.name || '—'}</td>
                      <td className="py-2 px-2 text-gray-600">{t.business_name || '—'}</td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums font-semibold text-emerald-700">{fmtMoney(t.credit_balance)}</td>
                      <td className="py-2 px-2 text-right">
                        <button
                          onClick={() => { setPreviewEmail(t.email); fetchPreview(t.email); }}
                          className="text-xs text-blue-600 hover:underline"
                        >Preview</button>
                        <span className="text-gray-300 mx-2">·</span>
                        <button
                          onClick={() => { setSendOneEmail(t.email); }}
                          className="text-xs text-amber-600 hover:underline"
                        >Send</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Errors panel from last run */}
      {lastResult?.errors?.length > 0 && (
        <Card className="p-5 border-l-4 border-red-500 bg-red-50">
          <h2 className="text-lg font-semibold flex items-center gap-2 text-red-700">
            <AlertCircle className="w-5 h-5" /> Last run errors ({lastResult.errors.length})
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {lastResult.errors.map((er, i) => (
              <li key={i} className="text-red-700">
                <span className="font-mono text-xs">{er.email}</span> — {er.error}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Success indicator */}
      {!loadingSettings && lastResult?.sent > 0 && lastResult?.failed === 0 && (
        <div className="flex items-center gap-2 text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">
          <CheckCircle2 className="w-4 h-4" />
          Last batch went out cleanly — {lastResult.sent} traders contacted.
        </div>
      )}
    </div>
  );
}
