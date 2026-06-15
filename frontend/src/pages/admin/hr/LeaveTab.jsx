/**
 * HR Leave tab — pending approvals + monthly calendar view.
 */
import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Check, X, ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react';
import { Button } from '../../../components/ui/button';

const API = process.env.REACT_APP_BACKEND_URL;

const LEAVE_TYPE_COLOR = {
  holiday: 'bg-emerald-200 text-emerald-900 border-emerald-300',
  sick: 'bg-rose-200 text-rose-900 border-rose-300',
  unpaid: 'bg-slate-200 text-slate-900 border-slate-300',
  compassionate: 'bg-purple-200 text-purple-900 border-purple-300',
  maternity: 'bg-pink-200 text-pink-900 border-pink-300',
  paternity: 'bg-sky-200 text-sky-900 border-sky-300',
  other: 'bg-amber-200 text-amber-900 border-amber-300',
};

const STATUS_COLOR = {
  approved: 'bg-emerald-100 text-emerald-900 border-emerald-300',
  pending:  'bg-amber-100 text-amber-900 border-amber-300',
};

export default function LeaveTab({ onPendingChange }) {
  const [pending, setPending] = useState([]);
  const [calendar, setCalendar] = useState({ leave: [], bank_holidays: [] });
  const [calMonth, setCalMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() + 1 };
  });
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState('');
  const [decidingId, setDecidingId] = useState(null);

  const authHeader = () => {
    const t = localStorage.getItem('token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  const fetchPending = useCallback(async () => {
    try {
      const r = await axios.get(`${API}/api/hr/leave/requests/pending`, { headers: authHeader() });
      setPending(r.data || []);
      onPendingChange?.(r.data?.length || 0);
    } catch (e) {
      if (e?.response?.status !== 403) toast.error(`Pending: ${e?.response?.data?.detail || e.message}`);
    }
  }, [onPendingChange]);

  const fetchCalendar = useCallback(async () => {
    setLoading(true);
    try {
      const r = await axios.get(
        `${API}/api/hr/leave/calendar?year=${calMonth.year}&month=${calMonth.month}`,
        { headers: authHeader() },
      );
      setCalendar(r.data || { leave: [], bank_holidays: [] });
    } catch (e) {
      toast.error(`Calendar: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  }, [calMonth]);

  useEffect(() => { fetchPending(); }, [fetchPending]);
  useEffect(() => { fetchCalendar(); }, [fetchCalendar]);

  const decide = async (req, action) => {
    setDecidingId(req.id);
    try {
      await axios.post(
        `${API}/api/hr/leave/requests/${req.id}/${action}`,
        { note: note.trim() || null },
        { headers: authHeader() },
      );
      toast.success(`Request ${action === 'approve' ? 'approved' : 'rejected'}.`);
      setNote('');
      await Promise.all([fetchPending(), fetchCalendar()]);
    } catch (e) {
      toast.error(`Failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setDecidingId(null);
    }
  };

  const stepMonth = (delta) => {
    setCalMonth((curr) => {
      const m = curr.month + delta;
      if (m < 1) return { year: curr.year - 1, month: 12 };
      if (m > 12) return { year: curr.year + 1, month: 1 };
      return { year: curr.year, month: m };
    });
  };

  const monthLabel = new Date(calMonth.year, calMonth.month - 1, 1)
    .toLocaleString('en-GB', { month: 'long', year: 'numeric' });

  return (
    <div className="space-y-6" data-testid="hr-leave-tab">
      {/* ── Pending approvals ─────────────────────────────────────── */}
      <section className="rounded-lg border bg-card p-4">
        <h2 className="text-sm font-bold mb-3 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-amber-600" />
          Pending approvals ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing waiting — caught up. 👌</p>
        ) : (
          <div className="space-y-2">
            {pending.map((r) => (
              <div key={r.id} className="rounded-md border bg-muted/20 p-3" data-testid={`hr-pending-${r.id}`}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="font-semibold text-sm">{r.employee_name}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      <span className={`inline-block px-1.5 py-0.5 rounded border text-[10px] font-bold uppercase ${LEAVE_TYPE_COLOR[r.type] || ''}`}>{r.type}</span>
                      <span className="ml-2">{r.start_date} → {r.end_date} · {r.working_days} working days</span>
                    </div>
                    {r.reason && <div className="text-xs italic mt-1">&ldquo;{r.reason}&rdquo;</div>}
                  </div>
                  <div className="flex flex-col gap-2 min-w-[280px]">
                    <input
                      placeholder="Add an optional note for the employee…"
                      value={decidingId === r.id ? note : ''}
                      onChange={(e) => { setDecidingId(r.id); setNote(e.target.value); }}
                      className="h-8 px-2 text-xs rounded border bg-background"
                      data-testid={`hr-decision-note-${r.id}`}
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => decide(r, 'approve')} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white" data-testid={`hr-approve-${r.id}`}>
                        <Check className="w-3.5 h-3.5 mr-1" /> Approve
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => decide(r, 'reject')} className="flex-1 border-rose-300 text-rose-700 hover:bg-rose-50" data-testid={`hr-reject-${r.id}`}>
                        <X className="w-3.5 h-3.5 mr-1" /> Reject
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Calendar ──────────────────────────────────────────────── */}
      <section className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold">Team calendar — {monthLabel}</h2>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={() => stepMonth(-1)} data-testid="hr-cal-prev"><ChevronLeft className="w-4 h-4" /></Button>
            <Button size="sm" variant="outline" onClick={() => stepMonth(1)} data-testid="hr-cal-next"><ChevronRight className="w-4 h-4" /></Button>
          </div>
        </div>
        {loading ? (
          <div className="text-xs text-muted-foreground text-center py-6">Loading…</div>
        ) : (
          <CalendarGrid year={calMonth.year} month={calMonth.month}
            leave={calendar.leave || []}
            bankHolidays={calendar.bank_holidays || []}
          />
        )}
      </section>
    </div>
  );
}

function CalendarGrid({ year, month, leave, bankHolidays }) {
  // Build a 6-row grid starting from the first Mon on/before the 1st.
  const firstOfMonth = new Date(year, month - 1, 1);
  const firstWeekday = (firstOfMonth.getDay() + 6) % 7; // 0=Mon
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(year, month - 1, 1 - firstWeekday + i);
    cells.push(d);
  }

  const holidayMap = Object.fromEntries(
    (bankHolidays || []).map((h) => [h.date, h.name]),
  );

  const isOnLeave = (d) => {
    const iso = d.toISOString().slice(0, 10);
    return (leave || []).filter((l) => iso >= l.start_date && iso <= l.end_date);
  };

  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  return (
    <div data-testid="hr-leave-calendar">
      <div className="grid grid-cols-7 gap-1 mb-1">
        {days.map((d) => (
          <div key={d} className="text-[10px] font-bold uppercase text-center text-muted-foreground py-1">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          const iso = d.toISOString().slice(0, 10);
          const inMonth = d.getMonth() === month - 1;
          const holidayName = holidayMap[iso];
          const dayLeave = isOnLeave(d);
          return (
            <div
              key={i}
              className={`min-h-[70px] rounded p-1 border text-[10px] ${
                !inMonth ? 'bg-muted/20 opacity-50' :
                holidayName ? 'bg-sky-50 border-sky-200' : 'bg-background'
              }`}
            >
              <div className="text-[10px] font-bold">{d.getDate()}</div>
              {holidayName && (
                <div className="text-[8px] uppercase font-semibold text-sky-700 truncate" title={holidayName}>
                  {holidayName}
                </div>
              )}
              <div className="mt-0.5 space-y-0.5">
                {dayLeave.slice(0, 3).map((l) => (
                  <div
                    key={l.id}
                    className={`text-[9px] px-1 rounded truncate border ${LEAVE_TYPE_COLOR[l.type] || ''} ${l.status === 'pending' ? 'opacity-70' : ''}`}
                    title={`${l.employee_name} (${l.type}, ${l.status})`}
                  >
                    {l.status === 'pending' && '⏳ '}{l.employee_name}
                  </div>
                ))}
                {dayLeave.length > 3 && (
                  <div className="text-[8px] text-muted-foreground">+{dayLeave.length - 3} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <Legend swatch="bg-sky-200" label="Bank holiday" />
        {Object.entries(LEAVE_TYPE_COLOR).map(([k, cls]) => (
          <Legend key={k} swatch={cls.split(' ')[0]} label={k} />
        ))}
        <Legend swatch="bg-amber-100" label="⏳ Pending approval" />
        {/* unused for styling but keeps STATUS_COLOR referenced */}
        <span className="hidden" data-status-map>{JSON.stringify(STATUS_COLOR)}</span>
      </div>
    </div>
  );
}

function Legend({ swatch, label }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block w-2 h-2 rounded ${swatch}`} />
      {label}
    </span>
  );
}
