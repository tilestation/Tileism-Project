/**
 * HR Documents tab — upload + expiring-soon list per employee.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Upload, Download, Trash2, FileText, AlertTriangle, Calendar } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../../components/ui/dialog';

const API = process.env.REACT_APP_BACKEND_URL;

const CATEGORIES = [
  { value: 'contract',          label: 'Contract' },
  { value: 'right_to_work',     label: 'Right to work' },
  { value: 'id',                label: 'ID' },
  { value: 'p45',               label: 'P45' },
  { value: 'p46',               label: 'P46' },
  { value: 'visa',              label: 'Visa' },
  { value: 'certification',     label: 'Certification' },
  { value: 'training',          label: 'Training' },
  { value: 'policy_acknowledgement', label: 'Policy ack' },
  { value: 'other',             label: 'Other' },
];

const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',', 2)[1] || '');
  reader.onerror = reject;
  reader.readAsDataURL(file);
});

export default function DocumentsTab({ onExpiringChange }) {
  const [employees, setEmployees] = useState([]);
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [docs, setDocs] = useState([]);
  const [expiring, setExpiring] = useState([]);
  const [loading, setLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadForm, setUploadForm] = useState({
    category: 'contract', title: '', expiry_date: '', notes: '',
    visible_to_employee: true,
  });
  const fileRef = useRef(null);

  const authHeader = () => {
    const t = localStorage.getItem('token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  useEffect(() => {
    (async () => {
      try {
        const r = await axios.get(`${API}/api/hr/employees`, { headers: authHeader() });
        setEmployees(r.data || []);
        if (r.data?.[0]) setSelectedEmployee(r.data[0].id);
      } catch (e) {
        if (e?.response?.status !== 403) toast.error(`Employees: ${e?.response?.data?.detail || e.message}`);
      }
    })();
  }, []);

  const fetchDocs = useCallback(async () => {
    if (!selectedEmployee) return;
    setLoading(true);
    try {
      const r = await axios.get(`${API}/api/hr/documents/employee/${selectedEmployee}`, { headers: authHeader() });
      setDocs(r.data || []);
    } catch (e) {
      toast.error(`Docs: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  }, [selectedEmployee]);

  const fetchExpiring = useCallback(async () => {
    try {
      const r = await axios.get(`${API}/api/hr/documents/expiring?within_days=30`, { headers: authHeader() });
      setExpiring(r.data || []);
      onExpiringChange?.(r.data?.length || 0);
    } catch { /* non-fatal */ }
  }, [onExpiringChange]);

  useEffect(() => { fetchDocs(); }, [fetchDocs]);
  useEffect(() => { fetchExpiring(); }, [fetchExpiring]);

  const handleUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) { toast.error('Pick a file.'); return; }
    if (!uploadForm.title.trim()) { toast.error('Give the document a title.'); return; }
    setUploading(true);
    try {
      const b64 = await fileToBase64(file);
      await axios.post(`${API}/api/hr/documents`, {
        employee_id: selectedEmployee,
        category: uploadForm.category,
        title: uploadForm.title.trim(),
        file_name: file.name,
        file_base64: b64,
        mime_type: file.type || 'application/octet-stream',
        expiry_date: uploadForm.expiry_date || null,
        notes: uploadForm.notes.trim() || null,
        visible_to_employee: uploadForm.visible_to_employee,
      }, { headers: authHeader() });
      toast.success('Document uploaded.');
      setUploadOpen(false);
      setUploadForm({ category: 'contract', title: '', expiry_date: '', notes: '', visible_to_employee: true });
      await Promise.all([fetchDocs(), fetchExpiring()]);
    } catch (e) {
      toast.error(`Upload failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (id, name) => {
    try {
      const r = await axios.get(`${API}/api/hr/documents/${id}/download`, {
        headers: authHeader(), responseType: 'blob',
      });
      const url = window.URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = name || `document-${id}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(`Download failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const handleDelete = async (id, title) => {
    if (!window.confirm(`Delete document "${title}"? Cannot be undone.`)) return;
    try {
      await axios.delete(`${API}/api/hr/documents/${id}`, { headers: authHeader() });
      toast.success('Deleted.');
      await Promise.all([fetchDocs(), fetchExpiring()]);
    } catch (e) {
      toast.error(`Delete failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const employeeName = (id) => {
    const e = employees.find((x) => x.id === id);
    return e ? `${e.first_name} ${e.last_name}` : '—';
  };

  const daysUntil = (iso) => {
    if (!iso) return null;
    const ms = new Date(iso).getTime() - Date.now();
    return Math.round(ms / 86400000);
  };

  return (
    <div className="space-y-4" data-testid="hr-documents-tab">
      {/* Expiring soon banner */}
      {expiring.length > 0 && (
        <section className="rounded-lg border border-rose-300 bg-rose-50 p-3" data-testid="hr-expiring-banner">
          <h3 className="text-sm font-bold text-rose-900 flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4" />
            Expiring within 30 days ({expiring.length})
          </h3>
          <div className="space-y-1">
            {expiring.slice(0, 5).map((d) => (
              <div key={d.id} className="text-xs flex justify-between gap-2">
                <span>
                  <strong>{employeeName(d.employee_id)}</strong> — {d.title}
                  <span className="ml-2 text-rose-700">{d.category}</span>
                </span>
                <span className="font-mono">
                  <Calendar className="w-3 h-3 inline mr-1" />
                  {d.expiry_date} <span className="text-rose-700">({daysUntil(d.expiry_date)}d)</span>
                </span>
              </div>
            ))}
            {expiring.length > 5 && (
              <div className="text-xs text-rose-700">+{expiring.length - 5} more — open each employee below to review</div>
            )}
          </div>
        </section>
      )}

      {/* Employee picker + upload */}
      <div className="flex gap-2 items-center flex-wrap">
        <select
          value={selectedEmployee}
          onChange={(e) => setSelectedEmployee(e.target.value)}
          className="h-9 px-3 rounded-md border bg-background text-sm flex-1 min-w-[200px]"
          data-testid="hr-docs-employee-select"
        >
          <option value="">Pick an employee…</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>{e.first_name} {e.last_name} · {e.employee_number}</option>
          ))}
        </select>
        <Button
          onClick={() => setUploadOpen(true)}
          disabled={!selectedEmployee}
          className="bg-indigo-600 hover:bg-indigo-700 text-white"
          data-testid="hr-upload-doc-btn"
        >
          <Upload className="w-4 h-4 mr-1.5" /> Upload document
        </Button>
      </div>

      {/* Document list */}
      <div className="rounded-lg border bg-card">
        {!selectedEmployee ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Pick an employee above to see their documents.</div>
        ) : loading ? (
          <div className="p-6 text-center text-sm text-muted-foreground">Loading…</div>
        ) : docs.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No documents yet — click <strong>Upload document</strong> to add one.
          </div>
        ) : (
          <div className="divide-y" data-testid="hr-docs-list">
            {docs.map((d) => {
              const dleft = daysUntil(d.expiry_date);
              const expClass = dleft === null ? '' :
                dleft < 0 ? 'text-rose-700 font-bold' :
                dleft <= 30 ? 'text-rose-700' :
                dleft <= 90 ? 'text-amber-700' : 'text-muted-foreground';
              return (
                <div key={d.id} className="px-4 py-3 hover:bg-muted/30 flex items-center justify-between gap-3" data-testid={`hr-doc-${d.id}`}>
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <FileText className="w-5 h-5 text-indigo-600 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-sm truncate">{d.title}</div>
                      <div className="text-[10px] text-muted-foreground flex flex-wrap gap-2 mt-0.5">
                        <span className="uppercase font-bold">{d.category.replace(/_/g, ' ')}</span>
                        <span>{d.file_name}</span>
                        <span>{Math.round((d.file_size || 0) / 1024)} KB</span>
                        {!d.visible_to_employee && <span className="text-amber-700">HR-only</span>}
                        {d.expiry_date && (
                          <span className={expClass}>
                            <Calendar className="w-3 h-3 inline mr-0.5" />
                            Expires {d.expiry_date}
                            {dleft !== null && ` (${dleft < 0 ? 'expired' : `${dleft}d`})`}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Button size="sm" variant="outline" onClick={() => handleDownload(d.id, d.file_name)} data-testid={`hr-doc-download-${d.id}`}>
                      <Download className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => handleDelete(d.id, d.title)} className="text-rose-700 hover:bg-rose-50" data-testid={`hr-doc-delete-${d.id}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Upload dialog */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent className="max-w-md" data-testid="hr-upload-dialog">
          <DialogHeader>
            <DialogTitle>Upload document</DialogTitle>
            <DialogDescription>
              For {employeeName(selectedEmployee)}. Max 10MB per file.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-semibold block mb-1">Category</label>
              <select
                value={uploadForm.category}
                onChange={(e) => setUploadForm({ ...uploadForm, category: e.target.value })}
                className="h-9 w-full px-3 rounded-md border bg-background text-sm"
                data-testid="hr-upload-category"
              >
                {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1">Title *</label>
              <Input
                value={uploadForm.title}
                onChange={(e) => setUploadForm({ ...uploadForm, title: e.target.value })}
                placeholder="e.g. Mia — Employment contract 2024"
                data-testid="hr-upload-title"
              />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1">File *</label>
              <input type="file" ref={fileRef} className="text-xs w-full" data-testid="hr-upload-file" />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1">
                Expiry date <span className="text-muted-foreground font-normal">(optional — alerts 30 days before)</span>
              </label>
              <Input
                type="date"
                value={uploadForm.expiry_date}
                onChange={(e) => setUploadForm({ ...uploadForm, expiry_date: e.target.value })}
                data-testid="hr-upload-expiry"
              />
            </div>
            <div>
              <label className="text-xs font-semibold block mb-1">Notes</label>
              <Input
                value={uploadForm.notes}
                onChange={(e) => setUploadForm({ ...uploadForm, notes: e.target.value })}
                placeholder="optional internal note"
              />
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={uploadForm.visible_to_employee}
                onChange={(e) => setUploadForm({ ...uploadForm, visible_to_employee: e.target.checked })}
                data-testid="hr-upload-visible-checkbox"
              />
              <span>Visible to the employee in their self-service portal</span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button
              onClick={handleUpload}
              disabled={uploading}
              className="bg-indigo-600 hover:bg-indigo-700 text-white"
              data-testid="hr-upload-submit"
            >
              {uploading ? 'Uploading…' : 'Upload'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
