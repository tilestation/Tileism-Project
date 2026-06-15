/**
 * My HR — staff self-service portal (13 Jun 2026).
 *
 * Mounted at `/staff/my-hr`. Lets every employee with a linked HR
 * record see + manage:
 *   • Their own profile (limited self-edit: contact / address only)
 *   • Holiday balance + request leave
 *   • Their own documents (only those marked visible_to_employee)
 *   • Their week's timesheet + clock in/out buttons
 *
 * All API endpoints used here either filter to the caller's own record
 * server-side (e.g. /me) or require the employee's user_id to match.
 */
import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import {
  User, CalendarDays, FileText, Clock, Play, Square, Download, Send,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../components/ui/dialog';

const API = process.env.REACT_APP_BACKEND_URL;

const LEAVE_TYPES = ['holiday', 'sick', 'unpaid', 'compassionate', 'maternity', 'paternity', 'other'];

export default function MyHR() {
  const [profile, setProfile] = useState(null);
  const [balance, setBalance] = useState(null);
  const [myRequests, setMyRequests] = useState([]);
  const [docs, setDocs] = useState([]);
  const [week, setWeek] = useState(null);
  const [currentClock, setCurrentClock] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const [profileEdit, setProfileEdit] = useState(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaveForm, setLeaveForm] = useState({
    type: 'holiday', start_date: '', end_date: '', reason: '',
  });

  const authHeader = () => {
    const t = localStorage.getItem('token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [me, bal, reqs, mydocs, mywk, curClock] = await Promise.all([
        axios.get(`${API}/api/hr/employees/me`, { headers: authHeader() }),
        axios.get(`${API}/api/hr/leave/balance/me`, { headers: authHeader() }),
        axios.get(`${API}/api/hr/leave/requests/my`, { headers: authHeader() }),
        axios.get(`${API}/api/hr/documents/me`, { headers: authHeader() }),
        axios.get(`${API}/api/hr/time/my-week`, { headers: authHeader() }),
        axios.get(`${API}/api/hr/time/current`, { headers: authHeader() }).catch(() => ({ data: null })),
      ]);
      setProfile(me.data);
      setBalance(bal.data);
      setMyRequests(reqs.data || []);
      setDocs(mydocs.data || []);
      setWeek(mywk.data);
      setCurrentClock(curClock.data);
      setError(null);
    } catch (e) {
      if (e?.response?.status === 404) {
        setError('No HR record linked to your account yet. Ask HR to set one up.');
      } else {
        setError(e?.response?.data?.detail || e.message);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleClockIn = async () => {
    try {
      await axios.post(`${API}/api/hr/time/clock-in`, {}, { headers: authHeader() });
      toast.success('Clocked in.');
      await fetchAll();
    } catch (e) {
      toast.error(`Clock-in failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const handleClockOut = async () => {
    try {
      await axios.post(`${API}/api/hr/time/clock-out`, { break_minutes: 0 }, { headers: authHeader() });
      toast.success('Clocked out.');
      await fetchAll();
    } catch (e) {
      toast.error(`Clock-out failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const handleSaveProfile = async () => {
    try {
      await axios.patch(`${API}/api/hr/employees/me`, {
        preferred_name: profileEdit.preferred_name,
        personal_email: profileEdit.personal_email,
        personal_phone: profileEdit.personal_phone,
        home_address: profileEdit.home_address,
        emergency_contact: profileEdit.emergency_contact,
      }, { headers: authHeader() });
      toast.success('Profile updated.');
      setProfileEdit(null);
      await fetchAll();
    } catch (e) {
      toast.error(`Update failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const handleSubmitLeave = async () => {
    if (!leaveForm.start_date || !leaveForm.end_date) {
      toast.error('Pick start + end dates.'); return;
    }
    try {
      await axios.post(`${API}/api/hr/leave/requests`, leaveForm, { headers: authHeader() });
      toast.success('Request submitted — manager will be notified.');
      setLeaveOpen(false);
      setLeaveForm({ type: 'holiday', start_date: '', end_date: '', reason: '' });
      await fetchAll();
    } catch (e) {
      toast.error(`Submission failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const handleCancelRequest = async (id) => {
    if (!window.confirm('Cancel this leave request?')) return;
    try {
      await axios.post(`${API}/api/hr/leave/requests/${id}/cancel`, {}, { headers: authHeader() });
      toast.success('Cancelled.');
      await fetchAll();
    } catch (e) {
      toast.error(`Cancel failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const handleDownloadDoc = async (id, name) => {
    try {
      const r = await axios.get(`${API}/api/hr/documents/${id}/download`, {
        headers: authHeader(), responseType: 'blob',
      });
      const url = window.URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url; a.download = name || 'document';
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(`Download failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-muted-foreground">Loading…</div>;
  }
  if (error) {
    return (
      <div className="p-8 max-w-md mx-auto text-center" data-testid="my-hr-error">
        <h1 className="text-2xl font-bold mb-2">My HR</h1>
        <p className="text-sm text-muted-foreground">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto p-4" data-testid="my-hr-page">
      <header>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Hi, {profile?.preferred_name || profile?.first_name} 👋</h1>
        <p className="text-sm text-muted-foreground">{profile?.job_title} · {profile?.employee_number}</p>
      </header>

      {/* Clock + balance + week summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <SummaryCard
          icon={<Clock className="w-5 h-5 text-emerald-600" />}
          label="Clock"
          value={currentClock ? 'Clocked in' : 'Clocked out'}
          subtitle={currentClock ? `Since ${new Date(currentClock.clock_in_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : 'Hit the button to start'}
          action={
            currentClock ? (
              <Button onClick={handleClockOut} className="bg-rose-600 hover:bg-rose-700 text-white" size="sm" data-testid="my-hr-clock-out">
                <Square className="w-3.5 h-3.5 mr-1.5" /> Clock out
              </Button>
            ) : (
              <Button onClick={handleClockIn} className="bg-emerald-600 hover:bg-emerald-700 text-white" size="sm" data-testid="my-hr-clock-in">
                <Play className="w-3.5 h-3.5 mr-1.5" /> Clock in
              </Button>
            )
          }
        />
        <SummaryCard
          icon={<CalendarDays className="w-5 h-5 text-indigo-600" />}
          label="Holiday balance"
          value={`${balance?.remaining_days ?? '—'} days left`}
          subtitle={`${balance?.used_days ?? 0} used · ${balance?.pending_days ?? 0} pending · ${balance?.entitlement_days ?? '—'} entitlement`}
          action={
            <Button onClick={() => setLeaveOpen(true)} className="bg-indigo-600 hover:bg-indigo-700 text-white" size="sm" data-testid="my-hr-request-leave">
              <Send className="w-3.5 h-3.5 mr-1.5" /> Request leave
            </Button>
          }
        />
        <SummaryCard
          icon={<Clock className="w-5 h-5 text-amber-600" />}
          label="This week"
          value={`${week?.total_hours ?? 0} hours`}
          subtitle={`${week?.entries?.length || 0} entries · Mon-Sun`}
        />
      </div>

      {/* My leave requests */}
      <section className="rounded-lg border bg-card p-4">
        <h2 className="text-sm font-bold mb-3">My leave requests</h2>
        {myRequests.length === 0 ? (
          <p className="text-xs text-muted-foreground">No requests yet.</p>
        ) : (
          <div className="space-y-1.5" data-testid="my-hr-leave-requests">
            {myRequests.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 text-xs px-3 py-2 rounded bg-muted/20 border">
                <span>
                  <strong className="uppercase">{r.type}</strong> · {r.start_date} → {r.end_date} · {r.working_days}d
                  {r.reason && <span className="ml-2 italic text-muted-foreground">&ldquo;{r.reason}&rdquo;</span>}
                </span>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${
                    r.status === 'approved' ? 'bg-emerald-100 text-emerald-800' :
                    r.status === 'pending'  ? 'bg-amber-100 text-amber-800' :
                    r.status === 'rejected' ? 'bg-rose-100 text-rose-800' :
                    'bg-slate-200 text-slate-700'
                  }`}>{r.status}</span>
                  {(r.status === 'pending' || r.status === 'approved') && (
                    <Button size="sm" variant="ghost" className="text-rose-700 text-[10px] h-auto px-1 py-0.5" onClick={() => handleCancelRequest(r.id)}>Cancel</Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* My documents */}
      <section className="rounded-lg border bg-card p-4">
        <h2 className="text-sm font-bold mb-3 flex items-center gap-2">
          <FileText className="w-4 h-4" /> My documents
        </h2>
        {docs.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing here yet. HR will upload contracts + onboarding docs as they go.</p>
        ) : (
          <div className="space-y-1.5" data-testid="my-hr-docs">
            {docs.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded bg-muted/20 border text-xs">
                <span>
                  <strong>{d.title}</strong>
                  <span className="ml-2 text-muted-foreground uppercase">{d.category.replace(/_/g, ' ')}</span>
                </span>
                <Button size="sm" variant="outline" onClick={() => handleDownloadDoc(d.id, d.file_name)}>
                  <Download className="w-3 h-3 mr-1" /> Download
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Profile card */}
      <section className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold flex items-center gap-2"><User className="w-4 h-4" /> My profile</h2>
          <Button size="sm" variant="outline" onClick={() => setProfileEdit({ ...profile })} data-testid="my-hr-edit-profile">
            Edit contact info
          </Button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          <Field label="Full name" v={`${profile?.first_name || ''} ${profile?.last_name || ''}`} />
          <Field label="Preferred name" v={profile?.preferred_name} />
          <Field label="Email" v={profile?.personal_email} />
          <Field label="Phone" v={profile?.personal_phone} />
          <Field label="Start date" v={profile?.start_date} />
          <Field label="Contract" v={profile?.contract_type?.replace(/_/g, ' ')} />
          <Field label="Job title" v={profile?.job_title} />
          <Field label="NI number" v={profile?.ni_number || '—'} />
          <Field label="Bank account" v={profile?.bank?.has_bank_details ? `${profile.bank.account_number || ''}` : '— not on file'} />
        </div>
      </section>

      {/* ── Leave request dialog ────────────────────────────────── */}
      <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <DialogContent className="max-w-md" data-testid="my-hr-leave-dialog">
          <DialogHeader>
            <DialogTitle>Request leave</DialogTitle>
            <DialogDescription>
              Your manager gets a notification. Bank holidays and weekends are auto-excluded from the working-days count.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <select
              value={leaveForm.type}
              onChange={(e) => setLeaveForm({ ...leaveForm, type: e.target.value })}
              className="h-9 w-full px-3 rounded-md border bg-background text-sm"
              data-testid="my-hr-leave-type"
            >
              {LEAVE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <Input type="date" value={leaveForm.start_date}
              onChange={(e) => setLeaveForm({ ...leaveForm, start_date: e.target.value })}
              data-testid="my-hr-leave-start" />
            <Input type="date" value={leaveForm.end_date}
              onChange={(e) => setLeaveForm({ ...leaveForm, end_date: e.target.value })}
              data-testid="my-hr-leave-end" />
            <Input value={leaveForm.reason}
              onChange={(e) => setLeaveForm({ ...leaveForm, reason: e.target.value })}
              placeholder="Reason (optional but helpful)"
              maxLength={500} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLeaveOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmitLeave} className="bg-indigo-600 hover:bg-indigo-700 text-white" data-testid="my-hr-leave-submit">
              Submit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Profile edit dialog ─────────────────────────────────── */}
      <Dialog open={!!profileEdit} onOpenChange={(o) => !o && setProfileEdit(null)}>
        <DialogContent className="max-w-md" data-testid="my-hr-profile-dialog">
          <DialogHeader>
            <DialogTitle>Edit my contact info</DialogTitle>
            <DialogDescription>
              For role, pay or start-date changes — ask HR.
            </DialogDescription>
          </DialogHeader>
          {profileEdit && (
            <div className="space-y-2">
              <Input placeholder="Preferred name" value={profileEdit.preferred_name || ''}
                onChange={(e) => setProfileEdit({ ...profileEdit, preferred_name: e.target.value })} />
              <Input placeholder="Personal email" type="email" value={profileEdit.personal_email || ''}
                onChange={(e) => setProfileEdit({ ...profileEdit, personal_email: e.target.value })} />
              <Input placeholder="Personal phone" value={profileEdit.personal_phone || ''}
                onChange={(e) => setProfileEdit({ ...profileEdit, personal_phone: e.target.value })} />
              <div className="text-[10px] uppercase font-bold text-muted-foreground mt-2">Home address</div>
              <Input placeholder="Line 1" value={profileEdit.home_address?.line1 || ''}
                onChange={(e) => setProfileEdit({ ...profileEdit, home_address: { ...(profileEdit.home_address || {}), line1: e.target.value } })} />
              <Input placeholder="Line 2" value={profileEdit.home_address?.line2 || ''}
                onChange={(e) => setProfileEdit({ ...profileEdit, home_address: { ...(profileEdit.home_address || {}), line2: e.target.value } })} />
              <div className="grid grid-cols-2 gap-2">
                <Input placeholder="City" value={profileEdit.home_address?.city || ''}
                  onChange={(e) => setProfileEdit({ ...profileEdit, home_address: { ...(profileEdit.home_address || {}), city: e.target.value } })} />
                <Input placeholder="Postcode" value={profileEdit.home_address?.postcode || ''}
                  onChange={(e) => setProfileEdit({ ...profileEdit, home_address: { ...(profileEdit.home_address || {}), postcode: e.target.value } })} />
              </div>
              <div className="text-[10px] uppercase font-bold text-muted-foreground mt-2">Emergency contact</div>
              <Input placeholder="Name" value={profileEdit.emergency_contact?.name || ''}
                onChange={(e) => setProfileEdit({ ...profileEdit, emergency_contact: { ...(profileEdit.emergency_contact || {}), name: e.target.value } })} />
              <Input placeholder="Relationship" value={profileEdit.emergency_contact?.relationship || ''}
                onChange={(e) => setProfileEdit({ ...profileEdit, emergency_contact: { ...(profileEdit.emergency_contact || {}), relationship: e.target.value } })} />
              <Input placeholder="Phone" value={profileEdit.emergency_contact?.phone || ''}
                onChange={(e) => setProfileEdit({ ...profileEdit, emergency_contact: { ...(profileEdit.emergency_contact || {}), phone: e.target.value } })} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setProfileEdit(null)}>Cancel</Button>
            <Button onClick={handleSaveProfile} className="bg-indigo-600 hover:bg-indigo-700 text-white">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SummaryCard({ icon, label, value, subtitle, action }) {
  return (
    <div className="rounded-lg border bg-card p-4 flex flex-col">
      <div className="flex items-center gap-2 mb-1">{icon}<span className="text-xs text-muted-foreground uppercase tracking-wider">{label}</span></div>
      <div className="text-xl font-bold">{value}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5 flex-1">{subtitle}</div>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

function Field({ label, v }) {
  return (
    <div>
      <div className="text-[10px] uppercase font-bold text-muted-foreground">{label}</div>
      <div>{v || <span className="text-muted-foreground">—</span>}</div>
    </div>
  );
}
