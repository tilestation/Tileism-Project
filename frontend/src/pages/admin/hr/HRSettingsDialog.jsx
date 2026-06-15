/**
 * HR Settings Dialog (Feb 2026).
 *
 * One-off configuration for company-wide HR data used by:
 *   • the Visa Monitoring Policy PDF (needs the AO's name + title + email)
 *   • future Sponsor Licence helpers
 *
 * Super-admin only on save. HR-admin can VIEW values inline as
 * read-only so they can see what's been configured by the company
 * director.
 */
import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Settings, Save, Building2, UserCheck } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Textarea } from '../../../components/ui/textarea';
import { Label } from '../../../components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../../components/ui/dialog';

const API = process.env.REACT_APP_BACKEND_URL;

const empty = {
  company_name: '',
  company_number: '',
  registered_address: '',
  sponsor_licence_number: '',
  sponsor_licence_status: 'applying',
  authorising_officer: { name: '', job_title: '', email: '', phone: '' },
  level1_user: { name: '', job_title: '', email: '', phone: '' },
  key_contact: { name: '', job_title: '', email: '', phone: '' },
  policy_effective_date: '',
};

const LICENCE_STATUSES = [
  { value: 'applying', label: 'Applying for first time' },
  { value: 'active', label: 'Active sponsor licence holder' },
  { value: 'renewed', label: 'Renewed' },
  { value: 'none', label: 'Not required' },
];

export default function HRSettingsDialog({ open, onClose, currentUserRole }) {
  const [form, setForm] = useState(empty);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const readOnly = currentUserRole !== 'super_admin';

  const authHeader = () => {
    const t = localStorage.getItem('token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    (async () => {
      try {
        const r = await axios.get(`${API}/api/hr/settings`, { headers: authHeader() });
        setForm({ ...empty, ...r.data, authorising_officer: { ...empty.authorising_officer, ...(r.data?.authorising_officer || {}) },
          level1_user: { ...empty.level1_user, ...(r.data?.level1_user || {}) },
          key_contact: { ...empty.key_contact, ...(r.data?.key_contact || {}) } });
      } catch (e) {
        toast.error(`Load failed: ${e?.response?.data?.detail || e.message}`);
      } finally { setLoading(false); }
    })();
  }, [open]);

  const handleSave = async () => {
    if (readOnly) return;
    if (!form.company_name?.trim()) {
      toast.error('Company name is required');
      return;
    }
    if (!form.authorising_officer?.name?.trim()) {
      toast.error('Authorising Officer name is required for the policy PDF');
      return;
    }
    setSaving(true);
    try {
      const r = await axios.put(`${API}/api/hr/settings`, form, { headers: authHeader() });
      setForm({ ...empty, ...r.data });
      toast.success('HR settings saved. Policy PDF will now show your AO.');
      onClose?.();
    } catch (e) {
      toast.error(`Save failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setSaving(false); }
  };

  const setPerson = (key, field, value) => {
    setForm((f) => ({ ...f, [key]: { ...(f[key] || {}), [field]: value } }));
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose?.()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="hr-settings-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-indigo-600" />
            HR &amp; Sponsor Licence Settings
          </DialogTitle>
          <DialogDescription>
            {readOnly
              ? 'These details appear on the Visa Monitoring Policy PDF. Read-only — ask the super-admin to update.'
              : 'These details appear on the Visa Monitoring Policy PDF (the document the Home Office will read). Super-admin only.'}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="p-6 text-center text-xs text-muted-foreground">Loading…</div>
        ) : (
          <div className="space-y-5">
            {/* Company */}
            <Section icon={<Building2 className="w-4 h-4" />} title="Company">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Company name *" testid="hrset-company-name">
                  <Input value={form.company_name} disabled={readOnly}
                    onChange={(e) => setForm({ ...form, company_name: e.target.value })} />
                </Field>
                <Field label="Companies House number" testid="hrset-company-number">
                  <Input value={form.company_number || ''} disabled={readOnly}
                    onChange={(e) => setForm({ ...form, company_number: e.target.value })}
                    placeholder="e.g. 12345678" />
                </Field>
              </div>
              <Field label="Registered address" testid="hrset-registered-address">
                <Textarea value={form.registered_address || ''} disabled={readOnly}
                  onChange={(e) => setForm({ ...form, registered_address: e.target.value })}
                  rows={3} placeholder={'1 Tile Way\nTonbridge\nKent\nTN9 0AA'} />
              </Field>
            </Section>

            {/* Sponsor licence */}
            <Section icon={<Building2 className="w-4 h-4" />} title="Sponsor Licence">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Sponsor Licence #" testid="hrset-licence-number">
                  <Input value={form.sponsor_licence_number || ''} disabled={readOnly}
                    onChange={(e) => setForm({ ...form, sponsor_licence_number: e.target.value })}
                    placeholder="Leave blank if applying for the first time" />
                </Field>
                <Field label="Status" testid="hrset-licence-status">
                  <select value={form.sponsor_licence_status} disabled={readOnly}
                    onChange={(e) => setForm({ ...form, sponsor_licence_status: e.target.value })}
                    className="h-9 w-full px-3 rounded-md border bg-background text-sm">
                    {LICENCE_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </Field>
              </div>
              <Field label="Policy effective from" testid="hrset-policy-date">
                <Input type="date" value={form.policy_effective_date || ''} disabled={readOnly}
                  onChange={(e) => setForm({ ...form, policy_effective_date: e.target.value })} />
                <p className="text-[10px] text-muted-foreground mt-1">
                  Leave blank to auto-stamp today on first save. <strong>Do not backdate</strong> — the
                  policy must be honestly dated to the day it was actually written.
                </p>
              </Field>
            </Section>

            {/* Authorising Officer */}
            <Section icon={<UserCheck className="w-4 h-4" />} title="Authorising Officer *">
              <p className="text-[11px] text-muted-foreground -mt-1 mb-2">
                The senior person responsible for the Sponsor Licence. Will be named and
                signed off on every Policy PDF.
              </p>
              <PersonForm value={form.authorising_officer || {}}
                onChange={(field, v) => setPerson('authorising_officer', field, v)}
                disabled={readOnly} testidPrefix="hrset-ao" />
            </Section>

            {/* Level 1 user (optional) */}
            <Section icon={<UserCheck className="w-4 h-4" />} title="Level 1 User (optional)">
              <p className="text-[11px] text-muted-foreground -mt-1 mb-2">
                The person who manages day-to-day Sponsor Management System (SMS) tasks.
                Often the same as the AO.
              </p>
              <PersonForm value={form.level1_user || {}}
                onChange={(field, v) => setPerson('level1_user', field, v)}
                disabled={readOnly} testidPrefix="hrset-l1" />
            </Section>

            {/* Key contact (optional) */}
            <Section icon={<UserCheck className="w-4 h-4" />} title="Key Contact (optional)">
              <p className="text-[11px] text-muted-foreground -mt-1 mb-2">
                UK-based first point of contact for Home Office queries.
              </p>
              <PersonForm value={form.key_contact || {}}
                onChange={(field, v) => setPerson('key_contact', field, v)}
                disabled={readOnly} testidPrefix="hrset-kc" />
            </Section>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</Button>
          {!readOnly && (
            <Button onClick={handleSave} disabled={saving || loading}
              className="bg-indigo-600 hover:bg-indigo-700 text-white" data-testid="hrset-save">
              <Save className="w-4 h-4 mr-1.5" />
              {saving ? 'Saving…' : 'Save settings'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Section({ icon, title, children }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="flex items-center gap-2 mb-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
        {icon}
        <span>{title}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Field({ label, testid, children }) {
  return (
    <div data-testid={testid}>
      <Label className="text-xs font-bold mb-1 block">{label}</Label>
      {children}
    </div>
  );
}

function PersonForm({ value, onChange, disabled, testidPrefix }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <Input placeholder="Name" value={value.name || ''} disabled={disabled}
        onChange={(e) => onChange('name', e.target.value)} data-testid={`${testidPrefix}-name`} />
      <Input placeholder="Job title" value={value.job_title || ''} disabled={disabled}
        onChange={(e) => onChange('job_title', e.target.value)} data-testid={`${testidPrefix}-title`} />
      <Input placeholder="Email" type="email" value={value.email || ''} disabled={disabled}
        onChange={(e) => onChange('email', e.target.value)} data-testid={`${testidPrefix}-email`} />
      <Input placeholder="Phone" value={value.phone || ''} disabled={disabled}
        onChange={(e) => onChange('phone', e.target.value)} data-testid={`${testidPrefix}-phone`} />
    </div>
  );
}
