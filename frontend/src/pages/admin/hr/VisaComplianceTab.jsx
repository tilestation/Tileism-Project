/**
 * HR Visa Compliance tab (13 Jun 2026).
 *
 * Built specifically as the Home Office sponsor-licence response page:
 * "Please provide evidence of how you monitor the length of their visa(s)."
 *
 * Three sections:
 *   1. Summary cards + the one-click "Download evidence PDF" button
 *      (the artefact you actually attach to your reply to the HO)
 *   2. Per-employee table with status badge + last review row
 *   3. Drawer per employee: full document detail, alert history,
 *      review log, plus a "Record a right-to-work re-check" form
 *      (append-only audit row).
 */
import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import {
  ShieldCheck, FileDown, AlertTriangle, CheckCircle2, Eye, History, Plus,
  Settings, ClipboardCheck, FileSignature,
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../../components/ui/dialog';
import HRSettingsDialog from './HRSettingsDialog';
import BaselineReviewWizard from './BaselineReviewWizard';

const API = process.env.REACT_APP_BACKEND_URL;

const STATUS_STYLE = {
  VALID:               { cls: 'bg-emerald-100 text-emerald-900 border-emerald-300', label: 'Valid' },
  WATCH:               { cls: 'bg-amber-100 text-amber-900 border-amber-300',       label: 'Watch (≤90d)' },
  EXPIRING_SOON:       { cls: 'bg-orange-100 text-orange-900 border-orange-300',    label: 'Expiring soon' },
  EXPIRED:             { cls: 'bg-rose-200 text-rose-900 border-rose-400',          label: 'EXPIRED' },
  NO_EXPIRY_RECORDED:  { cls: 'bg-slate-200 text-slate-900 border-slate-300',       label: 'No expiry on file' },
};

const REVIEW_METHODS = [
  { value: 'share_code',          label: 'Home Office share code (gov.uk RTW check)' },
  { value: 'in_person',           label: 'In-person passport / BRP inspection' },
  { value: 'passport_inspection', label: 'Passport inspection (without share code)' },
  { value: 'other',               label: 'Other (note required)' },
];

export default function VisaComplianceTab() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [includeUnsponsored, setIncludeUnsponsored] = useState(false);
  const [drawerEmp, setDrawerEmp] = useState(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewForm, setReviewForm] = useState({
    review_method: 'share_code',
    share_code: '', visa_type: '', valid_until: '', notes: '',
  });
  // Settings / baseline wizard / policy PDF (Feb 2026)
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [baselineStatus, setBaselineStatus] = useState(null);
  const [currentRole, setCurrentRole] = useState('');

  const authHeader = () => {
    const t = localStorage.getItem('token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  const fetchReport = useCallback(async () => {
    setLoading(true);
    try {
      const r = await axios.get(
        `${API}/api/hr/visa-compliance/report?include_unsponsored=${includeUnsponsored}`,
        { headers: authHeader() },
      );
      setReport(r.data);
    } catch (e) {
      if (e?.response?.status !== 403) toast.error(`Report: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  }, [includeUnsponsored]);

  const fetchBaselineStatus = useCallback(async () => {
    try {
      const [stat, me] = await Promise.all([
        axios.get(`${API}/api/hr/visa-compliance/baseline/status`, { headers: authHeader() }),
        axios.get(`${API}/api/auth/me`, { headers: authHeader() }).catch(() => ({ data: {} })),
      ]);
      setBaselineStatus(stat.data);
      setCurrentRole(me.data?.role || '');
    } catch { /* silently — banner just won't render */ }
  }, []);

  useEffect(() => { fetchReport(); }, [fetchReport]);
  useEffect(() => { fetchBaselineStatus(); }, [fetchBaselineStatus]);

  const downloadPdf = async () => {
    try {
      const r = await axios.get(`${API}/api/hr/visa-compliance/report.pdf`, {
        headers: authHeader(), responseType: 'blob',
      });
      const url = window.URL.createObjectURL(r.data);
      const a = document.createElement('a');
      const today = new Date().toISOString().slice(0, 10);
      a.href = url; a.download = `visa_compliance_report_${today}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
      toast.success('Evidence PDF downloaded.');
    } catch (e) {
      toast.error(`PDF failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const downloadPolicyPdf = async () => {
    try {
      const r = await axios.get(`${API}/api/hr/visa-compliance/policy.pdf`, {
        headers: authHeader(), responseType: 'blob',
      });
      const url = window.URL.createObjectURL(r.data);
      const a = document.createElement('a');
      const today = new Date().toISOString().slice(0, 10);
      a.href = url; a.download = `visa_monitoring_policy_${today}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
      toast.success('Monitoring Policy PDF downloaded.');
    } catch (e) {
      toast.error(`Policy PDF failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const handleRecordReview = async () => {
    if (!drawerEmp?.employee_id) return;
    try {
      await axios.post(
        `${API}/api/hr/visa-compliance/${drawerEmp.employee_id}/review`,
        reviewForm,
        { headers: authHeader() },
      );
      toast.success(`Re-check logged for ${drawerEmp.name}. Audit row is permanent.`);
      setReviewOpen(false);
      setReviewForm({ review_method: 'share_code', share_code: '', visa_type: '', valid_until: '', notes: '' });
      await fetchReport();
      // Re-open the drawer with refreshed data
      const fresh = report?.employees?.find((e) => e.employee_id === drawerEmp.employee_id);
      if (fresh) setDrawerEmp(fresh);
    } catch (e) {
      toast.error(`Record failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const s = report?.summary || {};
  const employees = report?.employees || [];

  return (
    <div className="space-y-4" data-testid="hr-visa-compliance-tab">
      {/* Top bar — Sponsor Licence Application toolkit */}
      <div className="rounded-lg border bg-indigo-50/50 border-indigo-200 p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            <ShieldCheck className="w-6 h-6 text-indigo-700 shrink-0 mt-0.5" />
            <div>
              <h2 className="text-sm font-bold">Sponsor Licence — visa expiry monitoring</h2>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-2xl">
                Every visa document is tracked with an expiry date. HR is auto-emailed at
                <strong className="text-foreground"> 90, 60, 30 and 7 days</strong> before each visa expires,
                plus an EXPIRED alert if anything slips past. Each alert is logged permanently.
              </p>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button variant="outline" onClick={() => setSettingsOpen(true)} data-testid="visa-open-settings">
              <Settings className="w-4 h-4 mr-1.5" />
              Settings
            </Button>
            <Button onClick={() => setWizardOpen(true)}
              className="bg-amber-600 hover:bg-amber-700 text-white" data-testid="visa-open-wizard">
              <ClipboardCheck className="w-4 h-4 mr-1.5" />
              {baselineStatus?.completed ? 'Re-run baseline review' : 'Run baseline review'}
            </Button>
            <Button onClick={downloadPolicyPdf}
              className="bg-indigo-600 hover:bg-indigo-700 text-white" data-testid="visa-download-policy-pdf">
              <FileSignature className="w-4 h-4 mr-1.5" />
              Monitoring Policy PDF
            </Button>
            <Button onClick={downloadPdf} variant="secondary" data-testid="visa-download-pdf">
              <FileDown className="w-4 h-4 mr-1.5" />
              Alert log PDF
            </Button>
          </div>
        </div>

        {/* Baseline status pill */}
        {baselineStatus && (
          <div className="mt-3 flex items-start gap-2 text-xs" data-testid="visa-baseline-banner">
            {baselineStatus.completed ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-100 text-emerald-900 border border-emerald-300 font-bold">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Baseline review completed {baselineStatus.latest?.completed_at?.slice(0, 10)} by {baselineStatus.latest?.completed_by_email}
                {' '}— {baselineStatus.latest?.employees_reviewed} worker(s) verified.
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300 font-bold">
                <AlertTriangle className="w-3.5 h-3.5" />
                Baseline review pending — click <em>Run baseline review</em> to start the audit clock honestly today.
              </span>
            )}
          </div>
        )}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
        <SummaryCell label="Monitored workers" value={s.total_sponsored ?? 0} cls="bg-card" />
        <SummaryCell label="Valid (>90d)"      value={s.valid ?? 0}           cls="bg-emerald-50 border-emerald-200" />
        <SummaryCell label="Watch (31-90d)"    value={s.watch ?? 0}           cls="bg-amber-50 border-amber-200" />
        <SummaryCell label="Expiring (≤30d)"   value={s.expiring_soon ?? 0}   cls="bg-orange-50 border-orange-200" />
        <SummaryCell label="EXPIRED"           value={s.expired ?? 0}         cls="bg-rose-100 border-rose-300" />
        <SummaryCell label="No expiry on file" value={s.no_expiry_recorded ?? 0} cls="bg-slate-100" />
        <SummaryCell label="Never reviewed"    value={s.never_reviewed ?? 0}  cls="bg-slate-100" />
      </div>

      {/* Toggle */}
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={includeUnsponsored}
          onChange={(e) => setIncludeUnsponsored(e.target.checked)}
          data-testid="visa-include-unsponsored"
        />
        <span>Include British / settled workers (no visa) for completeness checks</span>
      </label>

      {/* Per-employee table */}
      <div className="rounded-lg border bg-card">
        {loading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">Loading…</div>
        ) : employees.length === 0 ? (
          <div className="p-8 text-center text-xs text-muted-foreground">
            No sponsored workers found — upload a <strong>visa</strong> or <strong>right_to_work</strong> document for an employee in the Documents tab to start tracking.
          </div>
        ) : (
          <table className="w-full text-xs" data-testid="visa-employee-table">
            <thead>
              <tr className="bg-muted/40 text-left">
                <th className="px-3 py-2 font-bold">Employee</th>
                <th className="px-3 py-2 font-bold">Visa type</th>
                <th className="px-3 py-2 font-bold">Expiry</th>
                <th className="px-3 py-2 font-bold">Status</th>
                <th className="px-3 py-2 font-bold">Last review</th>
                <th className="px-3 py-2 font-bold">Alerts sent</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {employees.map((e) => {
                const stat = STATUS_STYLE[e.status] || STATUS_STYLE.NO_EXPIRY_RECORDED;
                const lastReview = e.last_review;
                const d = e.document || {};
                return (
                  <tr key={e.employee_id} className="hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <div className="font-semibold">{e.name}</div>
                      <div className="text-[10px] font-mono text-muted-foreground">{e.employee_number}</div>
                    </td>
                    <td className="px-3 py-2">{d.visa_type || '—'}</td>
                    <td className="px-3 py-2">
                      {d.expiry_date || '—'}
                      {e.days_until_expiry !== null && (
                        <div className={`text-[10px] ${e.days_until_expiry < 0 ? 'text-rose-700 font-bold' : e.days_until_expiry <= 30 ? 'text-orange-700' : 'text-muted-foreground'}`}>
                          {e.days_until_expiry < 0 ? `${-e.days_until_expiry}d ago` : `${e.days_until_expiry}d`}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase rounded border ${stat.cls}`}>{stat.label}</span>
                    </td>
                    <td className="px-3 py-2">
                      {lastReview ? (
                        <>
                          <div className="text-[11px]">{(lastReview.reviewed_at || '').slice(0, 10)}</div>
                          <div className="text-[10px] text-muted-foreground">{lastReview.reviewer_email}</div>
                        </>
                      ) : (
                        <span className="text-rose-700 font-bold">NEVER</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[10px] text-muted-foreground">
                      {(e.alerts_sent || []).length === 0 ? '—' : `${(e.alerts_sent || []).length} alert(s)`}
                    </td>
                    <td className="px-3 py-2">
                      <Button size="sm" variant="outline" onClick={() => setDrawerEmp(e)} data-testid={`visa-detail-${e.employee_number}`}>
                        <Eye className="w-3.5 h-3.5 mr-1" /> Detail
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail drawer */}
      <Dialog open={!!drawerEmp} onOpenChange={(o) => !o && setDrawerEmp(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="visa-detail-drawer">
          <DialogHeader>
            <DialogTitle>{drawerEmp?.name} — visa compliance</DialogTitle>
            <DialogDescription>
              Employee {drawerEmp?.employee_number} · {drawerEmp?.job_title || ''} · {drawerEmp?.nationality || ''}
            </DialogDescription>
          </DialogHeader>
          {drawerEmp && (
            <div className="space-y-4">
              <Section title="Current visa document">
                {drawerEmp.document?.id ? (
                  <div className="text-xs space-y-1">
                    <KV k="Title" v={drawerEmp.document.title} />
                    <KV k="Category" v={drawerEmp.document.category} />
                    <KV k="Visa type" v={drawerEmp.document.visa_type} />
                    <KV k="Share code" v={drawerEmp.document.share_code} mono />
                    <KV k="CoS number" v={drawerEmp.document.cos_number} mono />
                    <KV k="Expiry date" v={drawerEmp.document.expiry_date} />
                    <KV k="Uploaded" v={`${(drawerEmp.document.uploaded_at || '').slice(0, 10)} by ${drawerEmp.document.uploaded_by || ''}`} />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No visa / right-to-work document on file.</p>
                )}
              </Section>

              <Section title="Reminder alerts already issued">
                {(drawerEmp.alerts_sent || []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">No alerts fired yet.</p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {drawerEmp.alerts_sent.map((a) => (
                      <li key={a.id} className="flex items-start gap-2">
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-600 mt-0.5 shrink-0" />
                        <span>
                          <strong>{a.threshold_days === -1 ? 'EXPIRED' : `${a.threshold_days}-day notice`}</strong>
                          {' '}sent on {(a.alerted_at || '').slice(0, 10)} →
                          <span className="text-muted-foreground"> {a.recipients}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Right-to-work review log" action={
                <Button size="sm" onClick={() => setReviewOpen(true)} className="bg-indigo-600 hover:bg-indigo-700 text-white" data-testid="visa-add-review">
                  <Plus className="w-3.5 h-3.5 mr-1" /> Record re-check
                </Button>
              }>
                <ReviewHistory employeeId={drawerEmp.employee_id} authHeader={authHeader} />
              </Section>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Record review dialog */}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="max-w-md" data-testid="visa-review-dialog">
          <DialogHeader>
            <DialogTitle>Record right-to-work re-check</DialogTitle>
            <DialogDescription>
              Permanent audit row — once recorded it cannot be edited or deleted (compliance trail).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <select
              value={reviewForm.review_method}
              onChange={(e) => setReviewForm({ ...reviewForm, review_method: e.target.value })}
              className="h-9 w-full px-3 rounded-md border bg-background text-sm"
              data-testid="visa-review-method"
            >
              {REVIEW_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
            {reviewForm.review_method === 'share_code' && (
              <Input placeholder="Share code (e.g. ABC-DEF-GHI)"
                value={reviewForm.share_code}
                onChange={(e) => setReviewForm({ ...reviewForm, share_code: e.target.value })}
                data-testid="visa-review-share-code" />
            )}
            <Input placeholder="Visa type (e.g. Skilled Worker)"
              value={reviewForm.visa_type}
              onChange={(e) => setReviewForm({ ...reviewForm, visa_type: e.target.value })} />
            <Input type="date" placeholder="Valid until"
              value={reviewForm.valid_until}
              onChange={(e) => setReviewForm({ ...reviewForm, valid_until: e.target.value })}
              data-testid="visa-review-valid-until" />
            <Textarea placeholder="Notes (e.g. 'Mia presented Tier 2 visa in person, share code verified on gov.uk RTW service.')"
              value={reviewForm.notes}
              onChange={(e) => setReviewForm({ ...reviewForm, notes: e.target.value })}
              rows={3} maxLength={1000} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewOpen(false)}>Cancel</Button>
            <Button onClick={handleRecordReview} className="bg-indigo-600 hover:bg-indigo-700 text-white" data-testid="visa-review-submit">
              Record (permanent)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* HR Settings + Baseline Review Wizard (Feb 2026) */}
      <HRSettingsDialog
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); fetchBaselineStatus(); }}
        currentUserRole={currentRole}
      />
      <BaselineReviewWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onComplete={() => { fetchBaselineStatus(); fetchReport(); }}
      />
    </div>
  );
}

function SummaryCell({ label, value, cls = '' }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${cls}`}>
      <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">{label}</div>
      <div className="text-xl font-bold">{value}</div>
    </div>
  );
}

function Section({ title, children, action }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</h4>
        {action}
      </div>
      {children}
    </div>
  );
}

function KV({ k, v, mono }) {
  if (!v) return null;
  return (
    <div className="flex gap-2">
      <span className="w-24 text-muted-foreground">{k}:</span>
      <span className={mono ? 'font-mono' : ''}>{v}</span>
    </div>
  );
}

/**
 * Sub-component for the review log. Fetched on-demand so opening the
 * drawer doesn't always load every employee's full review history.
 */
function ReviewHistory({ employeeId, authHeader }) {
  const [reviews, setReviews] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const r = await axios.get(`${API}/api/hr/visa-compliance/${employeeId}/reviews`, { headers: authHeader() });
        setReviews(r.data || []);
      } catch {
        setReviews([]);
      }
    })();
  }, [employeeId, authHeader]);
  if (reviews === null) return <p className="text-xs text-muted-foreground">Loading…</p>;
  if (reviews.length === 0) return <p className="text-xs text-muted-foreground">No checks recorded yet — record the first one to start the audit trail.</p>;
  return (
    <ul className="space-y-2 text-xs">
      {reviews.map((r) => (
        <li key={r.id} className="border-l-2 border-emerald-300 pl-2 py-0.5">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
            <strong>{(r.reviewed_at || '').slice(0, 10)}</strong>
            <span className="text-[10px] uppercase font-bold text-muted-foreground">{r.review_method.replace(/_/g, ' ')}</span>
          </div>
          <div className="ml-5 text-[11px] text-muted-foreground">
            {r.reviewer_email}
            {r.share_code && <span> · share code <code className="font-mono text-foreground">{r.share_code}</code></span>}
            {r.visa_type && <span> · {r.visa_type}</span>}
            {r.valid_until && <span> · valid until {r.valid_until}</span>}
          </div>
          {r.notes && <div className="ml-5 italic mt-0.5 text-[11px]">&ldquo;{r.notes}&rdquo;</div>}
        </li>
      ))}
    </ul>
  );
}
