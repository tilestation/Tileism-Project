/**
 * HR Personnel File Compliance Checklist Dialog (Feb 2026).
 *
 * Per-employee × required-document matrix with traffic-light status
 * cells. Click ✗ to jump straight to the upload modal pre-seeded
 * with the right employee + category. Download PDF for audit
 * submission.
 *
 * Mounted from `DocumentsTab.jsx`.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import {
  ClipboardCheck, FileDown, AlertTriangle, CheckCircle2, X, Upload,
  Users, Filter,
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '../../../components/ui/dialog';

const API = process.env.REACT_APP_BACKEND_URL;

// Cell visuals
const STATUS_CELL = {
  ok:                 { glyph: '✓', bg: 'bg-emerald-100 text-emerald-900',  ring: '' },
  expiring:           { glyph: '⚠', bg: 'bg-amber-100 text-amber-900',      ring: 'ring-1 ring-amber-300' },
  expired:            { glyph: '✗', bg: 'bg-rose-200 text-rose-900',        ring: 'ring-1 ring-rose-400' },
  missing:            { glyph: '✗', bg: 'bg-rose-100 text-rose-900',        ring: 'ring-1 ring-rose-300' },
  optional_missing:   { glyph: '—', bg: 'bg-muted text-muted-foreground',   ring: '' },
};

const VERDICT_PILL = {
  compliant:     { cls: 'bg-emerald-100 text-emerald-900 border-emerald-300', label: 'Compliant', Icon: CheckCircle2 },
  action_needed: { cls: 'bg-amber-100 text-amber-900 border-amber-300',       label: 'Action',    Icon: AlertTriangle },
  non_compliant: { cls: 'bg-rose-200 text-rose-900 border-rose-400',          label: 'Fail',      Icon: X },
};

const PROFILE_TONE = {
  sponsored_worker: 'bg-indigo-100 text-indigo-900 border-indigo-300',
  settled_worker:   'bg-cyan-100 text-cyan-900 border-cyan-300',
  british_worker:   'bg-slate-200 text-slate-900 border-slate-300',
};

const FILTERS = [
  { value: 'all',           label: 'All workers' },
  { value: 'non_compliant', label: 'Non-compliant only' },
  { value: 'action_needed', label: 'Action needed only' },
  { value: 'sponsored',     label: 'Sponsored only' },
];

export default function ComplianceChecklistDialog({ open, onClose, onUploadFor }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  const authHeader = () => {
    const t = localStorage.getItem('token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  const fetchChecklist = useCallback(async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API}/api/hr/compliance/checklist`, { headers: authHeader() });
      setData(r.data);
    } catch (e) {
      toast.error(`Checklist failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (open) fetchChecklist(); }, [open, fetchChecklist]);

  const downloadPdf = async () => {
    try {
      const r = await axios.get(`${API}/api/hr/compliance/checklist.pdf`, {
        headers: authHeader(), responseType: 'blob',
      });
      const url = window.URL.createObjectURL(r.data);
      const a = document.createElement('a');
      const today = new Date().toISOString().slice(0, 10);
      a.href = url; a.download = `personnel_file_completeness_${today}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
      toast.success('Compliance PDF downloaded.');
    } catch (e) {
      toast.error(`PDF failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const rows = data?.rows || [];
  const filteredRows = useMemo(() => {
    if (filter === 'all') return rows;
    if (filter === 'sponsored') return rows.filter((r) => r.profile === 'sponsored_worker');
    return rows.filter((r) => r.verdict === filter);
  }, [rows, filter]);

  // Group rows by profile for cleaner matrices
  const grouped = useMemo(() => {
    const out = { sponsored_worker: [], settled_worker: [], british_worker: [] };
    filteredRows.forEach((r) => { out[r.profile]?.push(r); });
    return out;
  }, [filteredRows]);

  const overall = data?.overall_counts || {};

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="max-w-[95vw] max-h-[95vh] overflow-y-auto"
        data-testid="compliance-checklist-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="w-5 h-5 text-indigo-600" />
            Personnel File Completeness — Sponsor Licence Audit Checklist
          </DialogTitle>
          <DialogDescription>
            Per-worker matrix of required documents. <strong>✓</strong> = on file &amp; valid &middot;{' '}
            <strong>⚠</strong> = present but expiring or no expiry recorded &middot;{' '}
            <strong>✗</strong> = missing or expired. Click any <strong>✗</strong> to upload the
            missing document.
          </DialogDescription>
        </DialogHeader>

        {/* Top summary strip */}
        {!loading && data && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-testid="compliance-overall">
            <SummaryStat label="Workers"        value={rows.length} cls="bg-card" testid="compliance-total" />
            <SummaryStat label="✓ Compliant"    value={overall.compliant ?? 0}     cls="bg-emerald-50 border-emerald-200" testid="compliance-ok" />
            <SummaryStat label="⚠ Action"       value={overall.action_needed ?? 0} cls="bg-amber-50 border-amber-200"    testid="compliance-action" />
            <SummaryStat label="✗ Non-compliant" value={overall.non_compliant ?? 0} cls="bg-rose-100 border-rose-300"     testid="compliance-fail" />
          </div>
        )}

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 justify-between">
          <div className="flex items-center gap-1 text-xs">
            <Filter className="w-3.5 h-3.5" />
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8 px-2 rounded-md border bg-background text-xs"
              data-testid="compliance-filter"
            >
              {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <span className="text-muted-foreground ml-2">
              Showing {filteredRows.length} of {rows.length}
            </span>
          </div>
          <Button onClick={downloadPdf} className="bg-indigo-600 hover:bg-indigo-700 text-white"
            data-testid="compliance-download-pdf">
            <FileDown className="w-4 h-4 mr-1.5" />
            Download Personnel File PDF
          </Button>
        </div>

        {/* Matrices per profile */}
        {loading ? (
          <div className="p-10 text-center text-xs text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-xs text-muted-foreground border rounded-md">
            No active employees on file yet. Add an employee in the Employees tab first.
          </div>
        ) : (
          <div className="space-y-6">
            {['sponsored_worker', 'settled_worker', 'british_worker'].map((profile) => {
              const group = grouped[profile] || [];
              if (group.length === 0) return null;
              // All rows in a profile share the same requirement set
              const reqs = group[0].requirements;
              return (
                <ProfileMatrix
                  key={profile}
                  profile={profile}
                  reqs={reqs}
                  workers={group}
                  onUploadFor={onUploadFor}
                  onClose={onClose}
                />
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SummaryStat({ label, value, cls, testid }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${cls}`} data-testid={testid}>
      <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}

function ProfileMatrix({ profile, reqs, workers, onUploadFor, onClose }) {
  const PROFILE_TITLES = {
    sponsored_worker: 'Sponsored Worker (visa)',
    settled_worker:   'Settled / ILR / EUSS',
    british_worker:   'British / Irish',
  };
  return (
    <div className="rounded-lg border bg-card" data-testid={`compliance-matrix-${profile}`}>
      <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40">
        <Users className="w-4 h-4 text-muted-foreground" />
        <h3 className="text-sm font-bold">{PROFILE_TITLES[profile]}</h3>
        <span className={`inline-block px-2 py-0.5 text-[10px] font-bold uppercase rounded border ${PROFILE_TONE[profile]}`}>
          {workers.length}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/30 text-left">
              <th className="px-3 py-2 font-bold sticky left-0 bg-muted/30">Employee</th>
              {reqs.map((r) => (
                <th key={r.category} className="px-2 py-2 font-bold text-center min-w-[100px]"
                  title={r.label}>
                  <div className="whitespace-normal leading-tight">{r.label.split(' / ')[0]}</div>
                  {!r.required && (
                    <div className="text-[9px] font-normal italic text-muted-foreground">optional</div>
                  )}
                </th>
              ))}
              <th className="px-3 py-2 font-bold text-center">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {workers.map((w) => {
              const verdict = VERDICT_PILL[w.verdict] || VERDICT_PILL.non_compliant;
              const VerdictIcon = verdict.Icon;
              return (
                <tr key={w.employee_id} className="hover:bg-muted/20"
                  data-testid={`compliance-row-${w.employee_number || w.employee_id}`}>
                  <td className="px-3 py-2 sticky left-0 bg-card whitespace-nowrap">
                    <div className="font-semibold">{w.name}</div>
                    <div className="text-[10px] font-mono text-muted-foreground">{w.employee_number}</div>
                  </td>
                  {w.requirements.map((req) => {
                    const isOptionalMissing = !req.required && req.status === 'missing';
                    const cellKey = isOptionalMissing ? 'optional_missing' : req.status;
                    const cell = STATUS_CELL[cellKey] || STATUS_CELL.missing;
                    const canUpload = (req.status === 'missing' || req.status === 'expired')
                      || (req.status === 'expiring' && req.expires);
                    return (
                      <td key={req.category} className="px-1 py-1 text-center">
                        <button
                          type="button"
                          onClick={() => {
                            if (canUpload && onUploadFor) {
                              onClose?.();
                              onUploadFor({
                                employee_id: w.employee_id,
                                employee_name: w.name,
                                category: req.category,
                              });
                            }
                          }}
                          disabled={!canUpload}
                          className={`inline-flex items-center justify-center w-12 h-9 rounded-md text-sm font-bold ${cell.bg} ${cell.ring} ${canUpload ? 'cursor-pointer hover:scale-105 transition-transform' : 'cursor-default'}`}
                          title={canUpload
                            ? `Click to upload ${req.label} for ${w.name}`
                            : `${req.label}: ${req.status}${req.document?.expiry_date ? ` (expires ${req.document.expiry_date})` : ''}`}
                          data-testid={`compliance-cell-${w.employee_number || w.employee_id}-${req.category}`}
                        >
                          {cell.glyph}
                        </button>
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-center">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase rounded border ${verdict.cls}`}>
                      <VerdictIcon className="w-3 h-3" />
                      {verdict.label}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
