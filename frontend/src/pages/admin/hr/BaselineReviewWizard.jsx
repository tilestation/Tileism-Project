/**
 * Baseline Review Wizard (Feb 2026).
 *
 * Built specifically for Sponsor Licence applicants who didn't have a
 * formal monitoring system in place before. The wizard walks them
 * through every existing employee, verifying their right-to-work
 * documents *today* (honest, current-dated audit trail — never
 * backdated) so the Visa Monitoring Policy PDF can attest that the
 * audit clock has started.
 *
 * Flow:
 *   Step 1  Welcome  — explains what's about to happen + the
 *                       integrity contract (no backdating)
 *   Step 2  Roster   — checklist of every employee with a visa/RTW
 *                       doc; per-employee fields (method, share code,
 *                       visa type, valid until, notes); skip toggle
 *                       for non-sponsored workers
 *   Step 3  Confirm  — summary of what's about to be written +
 *                       overview acknowledgement checkbox + commit btn
 *   Step 4  Done     — success screen + download Policy PDF CTA
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import {
  ShieldCheck, FileDown, AlertTriangle, CheckCircle2, ArrowRight, ArrowLeft,
  Sparkles, Users, ClipboardCheck,
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';
import { Label } from '../../../components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '../../../components/ui/dialog';

const API = process.env.REACT_APP_BACKEND_URL;

const REVIEW_METHODS = [
  { value: 'share_code',          label: 'Home Office share code (gov.uk RTW)' },
  { value: 'in_person',           label: 'In-person passport / BRP inspection' },
  { value: 'passport_inspection', label: 'Passport inspection (no share code)' },
  { value: 'other',               label: 'Other (note required)' },
];

const STATUS_PILL = {
  VALID:               { cls: 'bg-emerald-100 text-emerald-900', label: 'Valid' },
  WATCH:               { cls: 'bg-amber-100 text-amber-900',     label: '≤90d' },
  EXPIRING_SOON:       { cls: 'bg-orange-100 text-orange-900',   label: '≤30d' },
  EXPIRED:             { cls: 'bg-rose-200 text-rose-900',       label: 'EXPIRED' },
  NO_EXPIRY_RECORDED:  { cls: 'bg-slate-200 text-slate-900',     label: 'No expiry' },
};

export default function BaselineReviewWizard({ open, onClose, onComplete }) {
  const [step, setStep] = useState(1);
  const [employees, setEmployees] = useState([]);
  const [entries, setEntries] = useState({}); // employee_id -> entry data
  const [skipped, setSkipped] = useState({}); // employee_id -> true
  const [overviewAck, setOverviewAck] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [completedResult, setCompletedResult] = useState(null);
  const [settingsOk, setSettingsOk] = useState(true);
  const [aoName, setAoName] = useState('');

  const authHeader = () => {
    const t = localStorage.getItem('token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [report, settings] = await Promise.all([
        axios.get(`${API}/api/hr/visa-compliance/report?include_unsponsored=true`,
          { headers: authHeader() }),
        axios.get(`${API}/api/hr/settings`, { headers: authHeader() }),
      ]);
      const emps = report.data?.employees || [];
      setEmployees(emps);
      // Seed entry state from existing visa doc metadata (saves typing)
      const seed = {};
      emps.forEach((e) => {
        const d = e.document || {};
        seed[e.employee_id] = {
          review_method: 'share_code',
          share_code: '',
          visa_type: d.visa_type || '',
          valid_until: d.expiry_date || '',
          notes: '',
        };
      });
      setEntries(seed);
      // Settings completeness
      const ao = settings.data?.authorising_officer || {};
      setAoName(ao.name || '');
      setSettingsOk(!!(settings.data?.company_name && ao.name));
    } catch (e) {
      toast.error(`Load failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setStep(1);
      setOverviewAck(false);
      setCompletedResult(null);
      setSkipped({});
      loadAll();
    }
  }, [open, loadAll]);

  const sponsoredEmployees = useMemo(
    () => employees.filter((e) => e.document?.id),
    [employees],
  );

  const includedEmployees = useMemo(
    () => sponsoredEmployees.filter((e) => !skipped[e.employee_id]),
    [sponsoredEmployees, skipped],
  );

  const handleSubmit = async () => {
    if (!overviewAck) return;
    if (includedEmployees.length === 0) {
      toast.error('Select at least one employee to review (or close and add visa docs first).');
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        overview_acknowledged: true,
        entries: includedEmployees.map((e) => ({
          employee_id: e.employee_id,
          review_method: entries[e.employee_id]?.review_method || 'share_code',
          share_code: entries[e.employee_id]?.share_code || null,
          visa_type: entries[e.employee_id]?.visa_type || null,
          valid_until: entries[e.employee_id]?.valid_until || null,
          notes: entries[e.employee_id]?.notes || null,
        })),
      };
      const r = await axios.post(`${API}/api/hr/visa-compliance/baseline`, payload,
        { headers: authHeader() });
      setCompletedResult(r.data);
      setStep(4);
      toast.success(`Baseline review complete — ${r.data?.session?.employees_reviewed} worker(s) verified.`);
      onComplete?.();
    } catch (e) {
      toast.error(`Submit failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  const downloadPolicyPdf = async () => {
    try {
      const r = await axios.get(`${API}/api/hr/visa-compliance/policy.pdf`,
        { headers: authHeader(), responseType: 'blob' });
      const url = window.URL.createObjectURL(r.data);
      const a = document.createElement('a');
      const today = new Date().toISOString().slice(0, 10);
      a.href = url; a.download = `visa_monitoring_policy_${today}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
      toast.success('Policy PDF downloaded.');
    } catch (e) {
      toast.error(`PDF failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" data-testid="baseline-wizard">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-indigo-600" />
            Baseline Right-to-Work Review
          </DialogTitle>
          <DialogDescription>
            Step {step} of 4 — verify every existing worker today so the audit clock starts cleanly.
          </DialogDescription>
        </DialogHeader>

        {/* Step bar */}
        <div className="flex items-center gap-1 text-[11px] uppercase font-bold tracking-wider">
          {['Welcome', 'Roster', 'Confirm', 'Done'].map((label, idx) => {
            const n = idx + 1;
            const active = step === n;
            const done = step > n;
            return (
              <div key={label} className={`px-2 py-1 rounded ${active ? 'bg-indigo-600 text-white' : done ? 'bg-emerald-100 text-emerald-900' : 'bg-muted text-muted-foreground'}`}>
                {n}. {label}
              </div>
            );
          })}
        </div>

        {loading ? (
          <div className="p-10 text-center text-xs text-muted-foreground">Loading employees…</div>
        ) : (
          <>
            {step === 1 && (
              <StepWelcome
                onNext={() => setStep(2)}
                onClose={onClose}
                settingsOk={settingsOk}
                aoName={aoName}
                sponsoredCount={sponsoredEmployees.length}
                allCount={employees.length}
              />
            )}
            {step === 2 && (
              <StepRoster
                employees={sponsoredEmployees}
                entries={entries}
                setEntries={setEntries}
                skipped={skipped}
                setSkipped={setSkipped}
                includedCount={includedEmployees.length}
                onBack={() => setStep(1)}
                onNext={() => setStep(3)}
              />
            )}
            {step === 3 && (
              <StepConfirm
                included={includedEmployees}
                entries={entries}
                overviewAck={overviewAck}
                setOverviewAck={setOverviewAck}
                onBack={() => setStep(2)}
                onSubmit={handleSubmit}
                submitting={submitting}
              />
            )}
            {step === 4 && (
              <StepDone
                result={completedResult}
                onDownload={downloadPolicyPdf}
                onClose={onClose}
              />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}


/* ─── Step 1: Welcome ─────────────────────────────────────────────── */
function StepWelcome({ onNext, onClose, settingsOk, aoName, sponsoredCount, allCount }) {
  return (
    <div className="space-y-4" data-testid="wiz-step-welcome">
      <div className="rounded-lg border bg-indigo-50/50 border-indigo-200 p-4 text-xs leading-relaxed">
        <p className="font-bold text-sm mb-1">What this wizard does</p>
        <p>
          You&apos;ll walk through each worker who has a visa or right-to-work document on file and
          confirm — <strong>using today&apos;s date</strong> — that you&apos;ve verified their permission to work.
          One permanent audit row is written per worker, plus a summary baseline record. From the
          moment you click <em>Commit</em>, the automated 90/60/30/7-day expiry alerts go live.
        </p>
      </div>

      <div className="rounded-lg border bg-amber-50 border-amber-300 p-4 text-xs leading-relaxed">
        <p className="font-bold text-sm mb-1 flex items-center gap-1.5">
          <AlertTriangle className="w-4 h-4 text-amber-700" />
          Integrity contract — no backdating
        </p>
        <p>
          Every audit row is stamped with the actual server time at submission. The wizard
          will <strong>not</strong> let you enter historical review dates. This is what makes the
          resulting Monitoring Policy PDF audit-safe for your Sponsor Licence application.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4 text-xs">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Active employees" value={allCount} />
          <Stat label="With visa / RTW doc" value={sponsoredCount} highlight />
          <Stat label="AO configured" value={settingsOk ? `${aoName || 'YES'}` : 'NO'} bad={!settingsOk} />
          <Stat label="Today" value={new Date().toISOString().slice(0, 10)} />
        </div>
        {!settingsOk && (
          <p className="mt-3 text-rose-700 text-[11px]">
            ⚠ HR Settings incomplete — please configure the Authorising Officer before downloading the
            policy PDF (you can still complete the baseline review now).
          </p>
        )}
        {sponsoredCount === 0 && (
          <p className="mt-3 text-amber-800 text-[11px]">
            No workers on file have a visa or right-to-work document yet. Upload at least one in the
            Documents tab before running the baseline.
          </p>
        )}
      </div>

      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onClose} data-testid="wiz-cancel">Cancel</Button>
        <Button onClick={onNext} disabled={sponsoredCount === 0}
          className="bg-indigo-600 hover:bg-indigo-700 text-white" data-testid="wiz-step1-next">
          Start review <ArrowRight className="w-4 h-4 ml-1.5" />
        </Button>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight, bad }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${highlight ? 'bg-indigo-100 border-indigo-300' : bad ? 'bg-rose-50 border-rose-300' : 'bg-muted/30'}`}>
      <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">{label}</div>
      <div className="text-base font-bold truncate">{value}</div>
    </div>
  );
}


/* ─── Step 2: Roster ──────────────────────────────────────────────── */
function StepRoster({ employees, entries, setEntries, skipped, setSkipped, includedCount, onBack, onNext }) {
  const updateEntry = (eid, field, value) => {
    setEntries((cur) => ({
      ...cur,
      [eid]: { ...(cur[eid] || {}), [field]: value },
    }));
  };

  return (
    <div className="space-y-3" data-testid="wiz-step-roster">
      <div className="rounded-md border bg-muted/30 p-3 text-xs">
        <p>
          <Users className="w-3.5 h-3.5 inline mr-1" />
          <strong>{includedCount} of {employees.length}</strong> worker(s) selected. Untick to skip a worker
          (e.g. if you can&apos;t physically verify them today — they&apos;ll need a separate re-check later).
        </p>
      </div>

      {employees.length === 0 ? (
        <div className="rounded-md border bg-muted/20 p-6 text-center text-xs text-muted-foreground">
          No employees with visa / right-to-work documents found.
        </div>
      ) : (
        <div className="space-y-2">
          {employees.map((emp) => {
            const eid = emp.employee_id;
            const entry = entries[eid] || {};
            const isSkipped = !!skipped[eid];
            const d = emp.document || {};
            const stat = STATUS_PILL[emp.status] || STATUS_PILL.NO_EXPIRY_RECORDED;
            return (
              <div key={eid} className={`rounded-md border p-3 ${isSkipped ? 'opacity-50 bg-muted/20' : 'bg-card'}`}
                data-testid={`wiz-roster-row-${emp.employee_number || eid}`}>
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={!isSkipped}
                    onChange={(e) => setSkipped({ ...skipped, [eid]: !e.target.checked })}
                    className="mt-1"
                    data-testid={`wiz-roster-check-${emp.employee_number || eid}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-sm">{emp.name}</span>
                      <span className="text-[10px] font-mono text-muted-foreground">{emp.employee_number}</span>
                      <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase rounded ${stat.cls}`}>
                        {stat.label}
                      </span>
                      {d.expiry_date && (
                        <span className="text-[11px] text-muted-foreground">
                          Doc expires: {d.expiry_date}
                        </span>
                      )}
                    </div>
                    {!isSkipped && (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 mt-2">
                        <Field label="Method">
                          <select value={entry.review_method || 'share_code'}
                            onChange={(e) => updateEntry(eid, 'review_method', e.target.value)}
                            className="h-9 w-full px-2 rounded-md border bg-background text-xs">
                            {REVIEW_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                          </select>
                        </Field>
                        {entry.review_method === 'share_code' && (
                          <Field label="Share code">
                            <Input value={entry.share_code || ''}
                              onChange={(e) => updateEntry(eid, 'share_code', e.target.value)}
                              placeholder="ABC DEF GHI"
                              className="h-9 text-xs font-mono" />
                          </Field>
                        )}
                        <Field label="Visa type">
                          <Input value={entry.visa_type || ''}
                            onChange={(e) => updateEntry(eid, 'visa_type', e.target.value)}
                            placeholder="Skilled Worker"
                            className="h-9 text-xs" />
                        </Field>
                        <Field label="Valid until">
                          <Input type="date" value={entry.valid_until || ''}
                            onChange={(e) => updateEntry(eid, 'valid_until', e.target.value)}
                            className="h-9 text-xs" />
                        </Field>
                        <div className="sm:col-span-2 lg:col-span-4">
                          <Field label="Notes (optional)">
                            <Textarea value={entry.notes || ''}
                              onChange={(e) => updateEntry(eid, 'notes', e.target.value)}
                              rows={1}
                              placeholder="e.g. Share code verified on gov.uk Right to Work service."
                              className="text-xs" />
                          </Field>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft className="w-4 h-4 mr-1.5" /> Back
        </Button>
        <Button onClick={onNext} disabled={includedCount === 0}
          className="bg-indigo-600 hover:bg-indigo-700 text-white" data-testid="wiz-step2-next">
          Review &amp; confirm ({includedCount}) <ArrowRight className="w-4 h-4 ml-1.5" />
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <Label className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground mb-0.5 block">{label}</Label>
      {children}
    </div>
  );
}


/* ─── Step 3: Confirm ─────────────────────────────────────────────── */
function StepConfirm({ included, entries, overviewAck, setOverviewAck, onBack, onSubmit, submitting }) {
  return (
    <div className="space-y-4" data-testid="wiz-step-confirm">
      <div className="rounded-lg border bg-card p-4 text-xs space-y-2">
        <p className="font-bold text-sm flex items-center gap-1.5">
          <ClipboardCheck className="w-4 h-4 text-indigo-700" />
          About to commit {included.length} permanent audit row(s)
        </p>
        <ul className="space-y-1 list-disc list-inside ml-1">
          {included.map((emp) => {
            const e = entries[emp.employee_id] || {};
            const method = REVIEW_METHODS.find((m) => m.value === e.review_method)?.label || e.review_method;
            return (
              <li key={emp.employee_id} className="text-xs">
                <strong>{emp.name}</strong> — {method}
                {e.share_code && <span className="font-mono ml-1">({e.share_code.toUpperCase()})</span>}
                {e.valid_until && <span className="text-muted-foreground"> · valid until {e.valid_until}</span>}
              </li>
            );
          })}
        </ul>
      </div>

      <MonitoringOverview />

      <label className="flex items-start gap-2 rounded-md border bg-amber-50 border-amber-300 p-3 cursor-pointer text-xs"
        data-testid="wiz-overview-ack-wrap">
        <input
          type="checkbox"
          checked={overviewAck}
          onChange={(e) => setOverviewAck(e.target.checked)}
          className="mt-0.5"
          data-testid="wiz-overview-ack"
        />
        <span>
          <strong>I confirm</strong> that I have personally verified each worker&apos;s right to work
          using the method indicated above on <strong>today&apos;s date</strong>, and I acknowledge that
          this submission creates a permanent audit row that cannot be edited or deleted.
        </span>
      </label>

      <div className="flex justify-between pt-2">
        <Button variant="outline" onClick={onBack} disabled={submitting}>
          <ArrowLeft className="w-4 h-4 mr-1.5" /> Back
        </Button>
        <Button onClick={onSubmit} disabled={!overviewAck || submitting}
          className="bg-emerald-600 hover:bg-emerald-700 text-white" data-testid="wiz-commit">
          {submitting ? 'Committing…' : 'Commit baseline review (permanent)'}
        </Button>
      </div>
    </div>
  );
}

function MonitoringOverview() {
  return (
    <details className="rounded-md border bg-muted/30 p-3 text-xs">
      <summary className="font-bold cursor-pointer">Monitoring System Overview (read before acknowledging)</summary>
      <div className="mt-2 space-y-2 leading-relaxed">
        <p>
          Once committed, the system runs the following checks once per UTC day for every
          worker who has a visa or right-to-work document with an expiry date on file:
        </p>
        <ul className="list-disc list-inside ml-2">
          <li><strong>90 days</strong> before expiry → HR admin team is e-mailed; diary entry created.</li>
          <li><strong>60 days</strong> before expiry → HR admin team re-notified; begin RTW renewal conversation.</li>
          <li><strong>30 days</strong> before expiry → HR + Authorising Officer e-mailed; in-person re-check scheduled.</li>
          <li><strong>7 days</strong> before expiry → final reminder to HR + AO; worker may be suspended if not re-verified.</li>
          <li><strong>Expired</strong> → all-hands alert; worker is suspended pending re-verification.</li>
        </ul>
        <p>
          Every alert and every human re-check is written to a permanent, append-only audit log.
          The Monitoring Policy PDF (available after this baseline) reproduces all of the above
          in a single document the Home Office can read.
        </p>
      </div>
    </details>
  );
}


/* ─── Step 4: Done ────────────────────────────────────────────────── */
function StepDone({ result, onDownload, onClose }) {
  const session = result?.session || {};
  return (
    <div className="space-y-4 text-center py-4" data-testid="wiz-step-done">
      <div className="mx-auto w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center">
        <CheckCircle2 className="w-9 h-9 text-emerald-700" />
      </div>
      <div>
        <h3 className="text-lg font-bold">Baseline complete</h3>
        <p className="text-xs text-muted-foreground mt-1">
          {session.employees_reviewed} worker(s) verified today by <strong>{session.completed_by_email}</strong>.
          The audit clock is now live — 90/60/30/7-day alerts will fire automatically.
        </p>
      </div>

      <div className="rounded-md border bg-indigo-50 border-indigo-200 p-4 text-left text-xs space-y-2 max-w-xl mx-auto">
        <p className="font-bold flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-indigo-600" />
          Next step — download your Monitoring Policy PDF
        </p>
        <p>
          This is the document you attach to your Sponsor Licence application as
          &ldquo;evidence of how you monitor the length of their visa(s)&rdquo;. It includes:
        </p>
        <ul className="list-disc list-inside ml-2">
          <li>Your company details + Authorising Officer signature line</li>
          <li>The written policy statement + monitoring methodology</li>
          <li>The baseline review attestation (this session) — today&apos;s date</li>
          <li>Current sponsored worker snapshot</li>
        </ul>
      </div>

      <div className="flex justify-center gap-3 pt-2">
        <Button variant="outline" onClick={onClose}>Close</Button>
        <Button onClick={onDownload} className="bg-indigo-600 hover:bg-indigo-700 text-white"
          data-testid="wiz-download-policy">
          <FileDown className="w-4 h-4 mr-1.5" />
          Download Monitoring Policy PDF
        </Button>
      </div>
    </div>
  );
}
