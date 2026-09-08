export const fmtGBP = (n) => `£${(Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const fmtDate = (v, withTime = false) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('en-GB', withTime
    ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
};

export const daysSince = (v) => {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
};

export const CHANNEL_LABEL = {
  online: 'Online (own device)',
  in_store: 'In store',
  staff_created: 'Staff created',
  unknown: 'Unknown (pre-tracking)',
};

export const CHANNEL_CLASS = {
  online: 'bg-sky-50 text-sky-700 border-sky-200',
  in_store: 'bg-violet-50 text-violet-700 border-violet-200',
  staff_created: 'bg-amber-50 text-amber-700 border-amber-200',
  unknown: 'bg-gray-50 text-gray-500 border-gray-200',
};

export const LOGIN_STATUS_LABEL = {
  never: 'No login yet',
  link_sent: 'Link sent · not activated',
  ready: 'Has password · no sign-in tracked yet',
  active: 'Signed in online',
};

export const LOGIN_STATUS_CLASS = {
  never: 'bg-rose-50 text-rose-700 border-rose-200',
  link_sent: 'bg-amber-50 text-amber-700 border-amber-200',
  ready: 'bg-sky-50 text-sky-700 border-sky-200',
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

export const loginStatusOf = (account) => {
  if (account?.login_status) return account.login_status;
  if (account?.last_login_at || account?.password_set_at) return 'active';
  const staffCreated = channelOf(account) === 'staff_created';
  if (!staffCreated && account?.has_password !== false) return 'ready';
  return account?.login_link_sent_at ? 'link_sent' : 'never';
};

export const seenBucket = (lastLoginAt) => {
  const d = daysSince(lastLoginAt);
  if (d == null) return null;
  if (d < 1) return { key: 'today', label: 'Seen today', cls: 'bg-emerald-600 text-white border-emerald-600' };
  if (d <= 7) return { key: 'week', label: 'Seen this week', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
  if (d <= 30) return { key: 'month', label: 'Seen this month', cls: 'bg-gray-100 text-gray-600 border-gray-200' };
  return null;
};

export const channelOf = (account) =>
  account?.registration_channel || account?.registration_source?.channel || 'unknown';
