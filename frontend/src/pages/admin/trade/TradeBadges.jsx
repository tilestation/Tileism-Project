import React from 'react';
import { Flame } from 'lucide-react';
import { CHANNEL_LABEL, CHANNEL_CLASS, LOGIN_STATUS_LABEL, LOGIN_STATUS_CLASS, channelOf, loginStatusOf, seenBucket, fmtDate } from './tradeFormat';

export const ChannelBadge = ({ account, showDetail = false }) => {
  const ch = channelOf(account);
  const src = account?.registration_source || {};
  const detail = [src.showroom_name, src.staff_name && `by ${src.staff_name}`, src.device].filter(Boolean).join(' · ');
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${CHANNEL_CLASS[ch] || CHANNEL_CLASS.unknown}`}
      title={detail || CHANNEL_LABEL[ch]}
      data-testid={`channel-badge-${account?.id}`}
    >
      {CHANNEL_LABEL[ch] || ch}
      {showDetail && detail ? <span className="opacity-70">· {detail}</span> : null}
    </span>
  );
};

export const LoginStatusBadge = ({ account }) => {
  const st = loginStatusOf(account);
  return (
    <span
      className={`inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full border ${LOGIN_STATUS_CLASS[st]}`}
      data-testid={`login-status-badge-${account?.id}`}
    >
      {LOGIN_STATUS_LABEL[st]}
    </span>
  );
};

export const SeenBadge = ({ account }) => {
  const b = seenBucket(account?.last_login_at);
  if (!b) return null;
  const n = Number(account?.logins_30d) || 0;
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${b.cls}`}
      title={`Last sign-in ${fmtDate(account.last_login_at, true)}${n ? ` · ${n} sign-in${n === 1 ? '' : 's'} in the last 30 days` : ''}`}
      data-testid={`seen-badge-${account?.id}`}
      data-seen={b.key}
    >
      {b.key === 'today' && <Flame className="h-3 w-3" />}
      {b.label}{n > 1 ? ` · ${n}×` : ''}
    </span>
  );
};
