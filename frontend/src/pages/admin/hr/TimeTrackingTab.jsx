/**
 * HR Time Tracking tab — QR code management, currently-clocked-in
 * staff, and an admin's view of a single employee's weekly timesheet.
 */
import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { QrCode, RotateCw, Copy, Printer, Plus, ExternalLink } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../../components/ui/dialog';

const API = process.env.REACT_APP_BACKEND_URL;

export default function TimeTrackingTab() {
  const [showrooms, setShowrooms] = useState([]);
  const [qrs, setQrs] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [pickedEmployee, setPickedEmployee] = useState('');
  const [range, setRange] = useState(() => {
    const today = new Date();
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay() + 1);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    return {
      from: weekStart.toISOString().slice(0, 10),
      to: weekEnd.toISOString().slice(0, 10),
    };
  });
  const [sheet, setSheet] = useState(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualForm, setManualForm] = useState({
    employee_id: '', showroom_id: '', clock_in_at: '', clock_out_at: '',
    break_minutes: 0, notes: '',
  });

  const authHeader = () => {
    const t = localStorage.getItem('token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  useEffect(() => {
    (async () => {
      const [sr, qr, emp] = await Promise.all([
        axios.get(`${API}/api/showrooms`, { headers: authHeader() }).catch(() => ({ data: [] })),
        axios.get(`${API}/api/hr/time/qr/active`, { headers: authHeader() }).catch(() => ({ data: [] })),
        axios.get(`${API}/api/hr/employees`, { headers: authHeader() }).catch(() => ({ data: [] })),
      ]);
      setShowrooms(sr.data || []);
      setQrs(qr.data || []);
      setEmployees(emp.data || []);
      if (emp.data?.[0]) setPickedEmployee(emp.data[0].id);
    })();
  }, []);

  const fetchSheet = useCallback(async () => {
    if (!pickedEmployee) return;
    try {
      const r = await axios.get(`${API}/api/hr/time/employee/${pickedEmployee}`, {
        headers: authHeader(),
        params: { from_date: range.from, to_date: range.to },
      });
      setSheet(r.data);
    } catch (e) {
      toast.error(`Timesheet: ${e?.response?.data?.detail || e.message}`);
    }
  }, [pickedEmployee, range]);

  useEffect(() => { fetchSheet(); }, [fetchSheet]);

  const rotateQR = async (showroomId, showroomName) => {
    if (!window.confirm(`Generate a NEW QR for ${showroomName}? The old printed QR will stop working immediately.`)) return;
    try {
      const r = await axios.post(`${API}/api/hr/time/qr/${showroomId}/rotate`, {}, { headers: authHeader() });
      toast.success(`New QR for ${showroomName} — re-print and post at the door.`);
      // Refresh
      const qr = await axios.get(`${API}/api/hr/time/qr/active`, { headers: authHeader() });
      setQrs(qr.data || []);
      // Open print window with QR
      printQRCard(r.data);
    } catch (e) {
      toast.error(`Rotate failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const copyClockUrl = (token) => {
    const url = `${window.location.origin}/clock?token=${token}`;
    navigator.clipboard.writeText(url);
    toast.success('Clock-in URL copied.');
  };

  const handleManualEntry = async () => {
    try {
      await axios.post(`${API}/api/hr/time/manual-entry`, {
        ...manualForm,
        clock_in_at: new Date(manualForm.clock_in_at).toISOString(),
        clock_out_at: new Date(manualForm.clock_out_at).toISOString(),
      }, { headers: authHeader() });
      toast.success('Manual entry added.');
      setManualOpen(false);
      setManualForm({ employee_id: '', showroom_id: '', clock_in_at: '', clock_out_at: '', break_minutes: 0, notes: '' });
      await fetchSheet();
    } catch (e) {
      toast.error(`Manual entry failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const minToHours = (m) => `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;

  return (
    <div className="space-y-6" data-testid="hr-time-tab">
      {/* QR codes per showroom */}
      <section className="rounded-lg border bg-card p-4">
        <h2 className="text-sm font-bold mb-3 flex items-center gap-2">
          <QrCode className="w-4 h-4 text-indigo-600" />
          Door QR codes — one per showroom
        </h2>
        <p className="text-xs text-muted-foreground mb-3">
          Each showroom has a printed QR at the door. Staff scan it to clock in/out — guarantees they&rsquo;re physically on-site.
          Rotate the QR whenever an employee leaves or the printed sticker is damaged.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {showrooms.map((s) => {
            const qr = qrs.find((q) => q.showroom_id === s.id);
            return (
              <div key={s.id} className="rounded-md border bg-muted/20 p-3" data-testid={`hr-qr-${s.id}`}>
                <div className="font-bold text-sm">{s.name}</div>
                <div className="text-[10px] text-muted-foreground mt-0.5">
                  {qr ? `Generated ${new Date(qr.generated_at).toLocaleDateString('en-GB')}` : 'No QR yet'}
                </div>
                <div className="flex flex-col gap-1 mt-2">
                  {qr && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => copyClockUrl(qr.qr_secret)}>
                        <Copy className="w-3 h-3 mr-1" /> Copy URL
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => printQRCard(qr)}>
                        <Printer className="w-3 h-3 mr-1" /> Print
                      </Button>
                    </>
                  )}
                  <Button size="sm" onClick={() => rotateQR(s.id, s.name)} className="bg-indigo-600 hover:bg-indigo-700 text-white" data-testid={`hr-qr-rotate-${s.id}`}>
                    <RotateCw className="w-3 h-3 mr-1" /> {qr ? 'Rotate' : 'Generate'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Timesheet viewer */}
      <section className="rounded-lg border bg-card p-4">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
          <h2 className="text-sm font-bold">Timesheet</h2>
          <Button size="sm" variant="outline" onClick={() => setManualOpen(true)} data-testid="hr-add-manual-entry">
            <Plus className="w-3.5 h-3.5 mr-1" /> Add manual entry
          </Button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-3">
          <select
            value={pickedEmployee}
            onChange={(e) => setPickedEmployee(e.target.value)}
            className="h-9 px-3 rounded-md border bg-background text-sm"
            data-testid="hr-time-employee-select"
          >
            <option value="">Pick employee…</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>
            ))}
          </select>
          <Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          <Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
        </div>
        {sheet && (
          <div data-testid="hr-time-sheet">
            <div className="text-xs text-muted-foreground mb-2">
              {sheet.from_date} → {sheet.to_date} · <strong className="text-foreground">{sheet.total_hours} h</strong> ({sheet.entries.length} entries)
            </div>
            {sheet.entries.length === 0 ? (
              <div className="text-xs text-muted-foreground p-4 text-center">No clock entries in this range.</div>
            ) : (
              <div className="border rounded-md divide-y">
                {sheet.entries.map((e) => {
                  const ci = new Date(e.clock_in_at);
                  const co = e.clock_out_at ? new Date(e.clock_out_at) : null;
                  return (
                    <div key={e.id} className="px-3 py-2 text-xs flex flex-wrap items-center gap-3">
                      <span className="font-mono">{ci.toLocaleDateString('en-GB')}</span>
                      <span>{ci.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} → {co ? co.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'open'}</span>
                      <span className="text-muted-foreground">{e.duration_minutes !== null ? minToHours(e.duration_minutes) : '—'}</span>
                      <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-muted">{e.method}</span>
                      {e.break_minutes > 0 && <span className="text-muted-foreground">break: {e.break_minutes} min</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Manual entry dialog */}
      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add manual time entry</DialogTitle>
            <DialogDescription>
              For when staff forgot to clock in. The entry is tagged as a manager override in the audit trail.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <select
              value={manualForm.employee_id}
              onChange={(e) => setManualForm({ ...manualForm, employee_id: e.target.value })}
              className="h-9 w-full px-3 rounded-md border bg-background text-sm"
            >
              <option value="">Employee…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.first_name} {e.last_name}</option>
              ))}
            </select>
            <select
              value={manualForm.showroom_id}
              onChange={(e) => setManualForm({ ...manualForm, showroom_id: e.target.value })}
              className="h-9 w-full px-3 rounded-md border bg-background text-sm"
            >
              <option value="">Showroom (optional)…</option>
              {showrooms.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <Input type="datetime-local" value={manualForm.clock_in_at}
              onChange={(e) => setManualForm({ ...manualForm, clock_in_at: e.target.value })} placeholder="Clock in" />
            <Input type="datetime-local" value={manualForm.clock_out_at}
              onChange={(e) => setManualForm({ ...manualForm, clock_out_at: e.target.value })} placeholder="Clock out" />
            <Input type="number" value={manualForm.break_minutes}
              onChange={(e) => setManualForm({ ...manualForm, break_minutes: Number(e.target.value) || 0 })}
              placeholder="Break minutes" />
            <Input value={manualForm.notes} onChange={(e) => setManualForm({ ...manualForm, notes: e.target.value })} placeholder="Optional note" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManualOpen(false)}>Cancel</Button>
            <Button onClick={handleManualEntry} className="bg-indigo-600 hover:bg-indigo-700 text-white">Save entry</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Open a print-friendly window with a big QR code rendered from a
 * free QR API (api.qrserver.com — no signup, no rate-limit for
 * single-shot prints). The URL inside the QR resolves to /clock with
 * the secret as `?token=` so when a staff phone scans it, our mobile
 * clock screen opens already authenticated for that showroom.
 */
function printQRCard(qr) {
  const url = `${window.location.origin}/clock?token=${qr.qr_secret}`;
  const qrApi = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(url)}`;
  const w = window.open('', '_blank');
  if (!w) {
    alert('Pop-up blocked — allow pop-ups to print the QR.');
    return;
  }
  w.document.write(`<!doctype html>
<html><head><title>Clock-in QR — ${qr.showroom_name}</title>
<style>
  body { font-family: system-ui, sans-serif; text-align: center; padding: 40px; }
  h1 { margin-bottom: 4px; font-size: 36px; }
  p  { color: #555; }
  img { margin: 28px auto; display: block; border: 4px solid #111; padding: 12px; background: #fff; }
  .small { font-size: 11px; color: #888; word-break: break-all; max-width: 400px; margin: 0 auto; }
</style></head>
<body>
  <h1>${qr.showroom_name}</h1>
  <p><strong>Scan to clock in / out</strong></p>
  <img src="${qrApi}" alt="QR code" />
  <p>Open the camera. Tap the link. Done.</p>
  <p class="small">${url}</p>
  <script>window.onload = () => setTimeout(() => window.print(), 800);</script>
</body></html>`);
  w.document.close();
}
