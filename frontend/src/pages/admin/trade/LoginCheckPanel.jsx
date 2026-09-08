import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, KeyRound, RefreshCw } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { api } from '../../../lib/api';
import { fmtDate } from './tradeFormat';

const LEVEL = {
  green: { cls: 'bg-emerald-50 border-emerald-200 text-emerald-900', Icon: CheckCircle2, icon: 'text-emerald-600' },
  amber: { cls: 'bg-amber-50 border-amber-200 text-amber-900', Icon: AlertTriangle, icon: 'text-amber-600' },
  red: { cls: 'bg-rose-50 border-rose-200 text-rose-900', Icon: XCircle, icon: 'text-rose-600' },
};

const Row = ({ label, ok, value, testId }) => (
  <div className="flex items-start justify-between gap-3 py-2 border-b last:border-0" data-testid={testId}>
    <span className="text-sm text-gray-600">{label}</span>
    <span className="text-sm font-medium text-right flex items-center gap-1.5">
      {ok === true && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
      {ok === false && <XCircle className="h-4 w-4 text-rose-600" />}
      {value}
    </span>
  </div>
);

export const LoginCheckPanel = ({ traderId, onSendLink, busy }) => {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data: d } = await api.getTraderLoginCheck(traderId);
      setData(d);
    } catch (e) {
      setError(e.response?.data?.detail || 'Could not run the login check');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { if (traderId) load(); }, [traderId]);

  if (loading && !data) return <p className="text-sm text-gray-400 py-6 text-center" data-testid="login-check-loading">Checking this account's login…</p>;
  if (error) return <p className="text-sm text-rose-600 py-6 text-center" data-testid="login-check-error">{error}</p>;
  if (!data) return null;

  const lv = LEVEL[data.verdict?.level] || LEVEL.amber;
  const needsLink = !data.has_password || !data.password_format_ok || (data.staff_created && !data.last_login_at && !data.password_set_at);

  return (
    <div className="space-y-4" data-testid="login-check-panel">
      <div className={`rounded-lg border p-3 flex gap-3 ${lv.cls}`} data-testid={`login-check-verdict-${data.verdict?.level}`}>
        <lv.Icon className={`h-5 w-5 shrink-0 mt-0.5 ${lv.icon}`} />
        <div>
          <p className="text-sm font-semibold" data-testid="login-check-headline">{data.verdict?.headline}</p>
          <p className="text-xs mt-1 opacity-90">{data.verdict?.advice}</p>
        </div>
      </div>

      <div className="rounded-lg border bg-white px-3">
        <Row label="Email used to sign in" value={data.email || '—'} testId="login-check-email" />
        <Row label="Password on record" ok={data.has_password} value={data.has_password ? 'Yes (encrypted — cannot be viewed)' : 'None'} testId="login-check-password" />
        {!data.password_format_ok && <Row label="Password format" ok={false} value="Unreadable — needs reset" testId="login-check-format" />}
        <Row label="How the account was created" value={data.staff_created ? 'By staff (random password until link used)' : data.registration_channel === 'unknown' ? 'Registered themselves (before channel tracking)' : `Registered themselves · ${data.registration_channel.replace('_', ' ')}`} testId="login-check-channel" />
        <Row label="Registered" value={fmtDate(data.registered_at, true)} testId="login-check-registered" />
        <Row label="Password set via link" value={data.password_set_at ? fmtDate(data.password_set_at, true) : 'Never'} testId="login-check-set-at" />
        <Row label="Last sign-in" value={data.last_login_at ? fmtDate(data.last_login_at, true) : `None tracked (tracking began ${fmtDate(data.login_tracking_since)})`} testId="login-check-last-login" />
        <Row label="Online orders on this account" value={data.online_orders} testId="login-check-orders" />
        <Row label="Login link" value={data.login_link_sent_at ? `Sent ${fmtDate(data.login_link_sent_at, true)}${data.active_links ? ' · still valid' : ' · expired/used'}` : 'Never sent'} testId="login-check-link" />
        <Row label="Staff account with same email" ok={!data.staff_account_same_email} value={data.staff_account_same_email ? 'Yes — Forgot password from the admin page would reset the staff login instead' : 'No'} testId="login-check-staff" />
      </div>

      {data.duplicates?.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3" data-testid="login-check-duplicates">
          <p className="text-sm font-semibold text-amber-900">{data.duplicates.length} other account(s) share this email</p>
          <ul className="mt-2 space-y-1">
            {data.duplicates.map((d) => (
              <li key={d.id} className="text-xs text-amber-900 flex flex-wrap gap-x-2">
                <span className="font-mono">{d.email}</span>
                <span>{d.is_trade ? `trade #${d.trade_account_number || '—'}` : 'retail'}</span>
                <span>{d.has_password ? 'has password' : 'no password'}</span>
                <span>created {fmtDate(d.created_at)}</span>
                {d.last_login_at && <span>last sign-in {fmtDate(d.last_login_at)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.recent_logins?.length > 0 && (
        <div data-testid="login-check-recent">
          <p className="text-xs font-medium text-gray-600 mb-1">Recent sign-ins</p>
          <ul className="text-xs text-gray-600 space-y-0.5">
            {data.recent_logins.map((l) => <li key={l.id || l.at}>{fmtDate(l.at, true)} · {l.device || 'unknown device'} · {l.ip || '—'}</li>)}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant={needsLink ? 'default' : 'outline'} disabled={busy === 'link'} onClick={onSendLink} data-testid="login-check-send-link">
          <KeyRound className="h-3.5 w-3.5 mr-1" /> {needsLink ? 'Send set-password link' : 'Send reset link (only if they forgot it)'}
        </Button>
        <Button size="sm" variant="ghost" onClick={load} disabled={loading} data-testid="login-check-refresh">
          <RefreshCw className={`h-3.5 w-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} /> Re-check
        </Button>
      </div>
    </div>
  );
};
