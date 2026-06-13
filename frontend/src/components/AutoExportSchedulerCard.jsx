/**
 * AutoExportSchedulerCard — reusable settings card that lets a super-
 * admin configure the "Send to accountant on the 1st of each month"
 * pipeline for either:
 *   • Invoices (company-wide — `kind="invoices"` + `scope="all"`)
 *   • Petty cash (per-showroom — `kind="petty_cash"` + `scope=showroomId`
 *     or sentinel `"all_showrooms"`)
 *
 * Mounts in two places (13 Jun 2026):
 *   1. /admin/invoice-history  — once, kind="invoices"
 *   2. /admin/cash-counter      — once per active showroom, kind="petty_cash"
 *
 * The component is self-contained: it owns its own fetch/save/run-now
 * state, only requires `kind` + `scope` + `title` + `description` from
 * the parent. The backend persists schedules in `db.auto_export_schedules`
 * keyed by (kind, scope), so re-mounting the card later still loads the
 * same row.
 */
import React, { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { CalendarClock, Send, Trash2, Save, MailCheck, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';

const API = process.env.REACT_APP_BACKEND_URL;

const formatRelativeDate = (iso) => {
  if (!iso) return 'Never';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

const nextSendDate = (dayOfMonth) => {
  // Next occurrence of `dayOfMonth` in the future (this month if it's
  // still ahead, otherwise next month).
  const today = new Date();
  const day = Math.min(Math.max(dayOfMonth || 1, 1), 28);
  let candidate = new Date(today.getFullYear(), today.getMonth(), day);
  if (candidate <= today) {
    candidate = new Date(today.getFullYear(), today.getMonth() + 1, day);
  }
  return candidate.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
};

const STATUS_BADGE = {
  ok:      { label: 'Sent OK',  cls: 'bg-emerald-100 text-emerald-800 border-emerald-300', Icon: CheckCircle2 },
  partial: { label: 'Partial',  cls: 'bg-amber-100 text-amber-800 border-amber-300',       Icon: AlertTriangle },
  failed:  { label: 'Failed',   cls: 'bg-rose-100 text-rose-800 border-rose-300',          Icon: AlertTriangle },
};

export default function AutoExportSchedulerCard({
  kind,
  scope = 'all',
  title,
  description,
  testIdPrefix = 'auto-export',
}) {
  const [schedule, setSchedule] = useState(null);
  const [recipients, setRecipients] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [runningNow, setRunningNow] = useState(false);

  const authHeader = () => {
    const t = localStorage.getItem('token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  const findExisting = useCallback((list) => {
    if (!Array.isArray(list)) return null;
    return list.find((s) => s.kind === kind && s.scope === scope) || null;
  }, [kind, scope]);

  const fetchSchedule = useCallback(async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API}/api/auto-exports`, { headers: authHeader() });
      const existing = findExisting(r.data);
      setSchedule(existing);
      if (existing) {
        setRecipients(existing.recipient_emails.join(', '));
        setEnabled(existing.enabled);
        setDayOfMonth(existing.day_of_month);
        setSubject(existing.subject || '');
        setMessage(existing.message || '');
      } else {
        setRecipients('');
        setEnabled(false);
        setDayOfMonth(1);
        setSubject('');
        setMessage('');
      }
    } catch (e) {
      // 403 means viewer isn't super_admin — fail quietly, card just renders empty.
      if (e?.response?.status !== 403) {
        toast.error(`Couldn't load auto-export schedule: ${e?.response?.data?.detail || e.message}`);
      }
    } finally {
      setLoading(false);
    }
  }, [findExisting]);

  useEffect(() => { fetchSchedule(); }, [fetchSchedule]);

  const parseRecipients = () => recipients
    .split(/[,\s;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const handleSave = async () => {
    const list = parseRecipients();
    if (list.length === 0) {
      toast.error('Add at least one recipient email.');
      return;
    }
    if (list.length > 5) {
      toast.error('Maximum 5 recipients per schedule.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        recipient_emails: list,
        enabled,
        day_of_month: dayOfMonth,
        scope: kind === 'petty_cash' ? scope : undefined,
        subject: subject.trim() || null,
        message: message.trim() || null,
      };
      const r = await axios.put(
        `${API}/api/auto-exports/${kind}`,
        body,
        { headers: authHeader() },
      );
      setSchedule(r.data);
      toast.success(
        enabled
          ? `Saved. Next send: ${nextSendDate(dayOfMonth)}.`
          : 'Saved (disabled — will not auto-send).',
      );
    } catch (e) {
      toast.error(`Save failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleRunNow = async () => {
    if (!schedule?.id) {
      toast.error('Save the schedule first, then try Send Now.');
      return;
    }
    setRunningNow(true);
    try {
      const r = await axios.post(
        `${API}/api/auto-exports/${schedule.id}/run-now`,
        {},
        { headers: authHeader() },
      );
      toast.success(r.data?.message || 'Queued.');
      // Re-fetch a few seconds later so the "Last sent" row updates.
      setTimeout(fetchSchedule, 4000);
    } catch (e) {
      toast.error(`Run now failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setRunningNow(false);
    }
  };

  const handleDelete = async () => {
    if (!schedule?.id) return;
    if (!window.confirm('Remove this auto-export schedule?')) return;
    try {
      await axios.delete(`${API}/api/auto-exports/${schedule.id}`, { headers: authHeader() });
      toast.success('Schedule removed.');
      await fetchSchedule();
    } catch (e) {
      toast.error(`Delete failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const status = schedule?.last_sent_status;
  const statusMeta = status && STATUS_BADGE[status];
  const StatusIcon = statusMeta?.Icon;

  return (
    <div
      className="rounded-lg border border-border bg-card p-4 space-y-3"
      data-testid={`${testIdPrefix}-card`}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 p-2">
          <CalendarClock className="w-5 h-5" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-bold leading-tight">{title}</h3>
          {description && (
            <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">{enabled ? 'On' : 'Off'}</span>
          <Switch
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={loading || saving}
            data-testid={`${testIdPrefix}-enabled-switch`}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="sm:col-span-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Accountant email(s) — comma separated, max 5
          </label>
          <Input
            type="text"
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder="accountant@example.com, owner@tilestation.co.uk"
            className="mt-1"
            disabled={loading || saving}
            data-testid={`${testIdPrefix}-recipients`}
          />
        </div>
        <div>
          <label className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            Day of month
          </label>
          <div className="mt-1 flex items-center gap-2">
            <Input
              type="number"
              min={1}
              max={28}
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(Math.max(1, Math.min(28, Number(e.target.value) || 1)))}
              disabled={loading || saving}
              className="w-20"
              data-testid={`${testIdPrefix}-day-of-month`}
            />
            <span className="text-xs text-muted-foreground">
              Next: {enabled ? nextSendDate(dayOfMonth) : '—'}
            </span>
          </div>
        </div>
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground select-none">
          Customise subject &amp; message (optional)
        </summary>
        <div className="mt-2 space-y-2">
          <Input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject (leave blank for an auto-generated one)"
            maxLength={200}
            disabled={loading || saving}
            data-testid={`${testIdPrefix}-subject`}
          />
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Message body (leave blank for the default note)"
            rows={3}
            maxLength={2000}
            disabled={loading || saving}
            data-testid={`${testIdPrefix}-message`}
          />
        </div>
      </details>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t">
        <div className="text-xs space-y-0.5">
          <div>
            <span className="text-muted-foreground">Last sent: </span>
            <span className="font-medium">{formatRelativeDate(schedule?.last_sent_at)}</span>
            {statusMeta && (
              <span
                className={`ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-bold ${statusMeta.cls}`}
                data-testid={`${testIdPrefix}-last-status`}
              >
                {StatusIcon && <StatusIcon className="w-3 h-3" />}
                {statusMeta.label}
              </span>
            )}
          </div>
          {schedule?.last_sent_note && (
            <div className="text-muted-foreground">{schedule.last_sent_note}</div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {schedule?.id && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRunNow}
              disabled={runningNow || saving}
              data-testid={`${testIdPrefix}-run-now`}
              className="border-indigo-300 text-indigo-700 hover:bg-indigo-50"
            >
              <Send className="w-3.5 h-3.5 mr-1.5" />
              {runningNow ? 'Sending…' : 'Send last month now'}
            </Button>
          )}
          {schedule?.id && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              disabled={saving || runningNow}
              data-testid={`${testIdPrefix}-delete`}
              className="text-rose-700 hover:bg-rose-50"
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              Remove
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={loading || saving}
            data-testid={`${testIdPrefix}-save`}
            className="bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            <Save className="w-3.5 h-3.5 mr-1.5" />
            {saving ? 'Saving…' : (schedule?.id ? 'Update schedule' : 'Save schedule')}
          </Button>
        </div>
      </div>

      {enabled && schedule?.id && !schedule?.last_sent_at && (
        <div className="text-[11px] text-muted-foreground flex items-center gap-1">
          <MailCheck className="w-3 h-3" />
          First auto-send will arrive on {nextSendDate(dayOfMonth)} — use &laquo;Send last month now&raquo; to verify it works before then.
        </div>
      )}
    </div>
  );
}
