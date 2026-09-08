import React from 'react';
import { CHANNEL_LABEL, CHANNEL_CLASS, LOGIN_STATUS_LABEL, LOGIN_STATUS_CLASS, channelOf } from './tradeFormat';

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
  const st = account?.login_status || (account?.last_login_at || account?.password_set_at ? 'active' : account?.login_link_sent_at ? 'link_sent' : 'never');
  return (
    <span
      className={`inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full border ${LOGIN_STATUS_CLASS[st]}`}
      data-testid={`login-status-badge-${account?.id}`}
    >
      {LOGIN_STATUS_LABEL[st]}
    </span>
  );
};
