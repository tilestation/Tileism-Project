/**
 * HR Employees tab — directory + create/edit drawer.
 * Foundation of the HR portal: every other tab pivots off an employee row.
 */
import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Plus, Search, Edit, Archive, Mail, Phone, Briefcase } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../../../components/ui/dialog';

const API = process.env.REACT_APP_BACKEND_URL;

const CONTRACT_TYPES = [
  { value: 'full_time', label: 'Full-time' },
  { value: 'part_time', label: 'Part-time' },
  { value: 'zero_hours', label: 'Zero-hours' },
  { value: 'casual', label: 'Casual' },
  { value: 'contractor', label: 'Contractor' },
];

const PAY_TYPES = [{ value: 'salary', label: 'Salary' }, { value: 'hourly', label: 'Hourly' }];
const PAY_FREQ = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
];

const EMPTY_EMP = {
  first_name: '', last_name: '', preferred_name: '', dob: '', gender: '',
  personal_email: '', personal_phone: '',
  home_address: { line1: '', line2: '', city: '', postcode: '' },
  ni_number: '', nationality: '',
  emergency_contact: { name: '', relationship: '', phone: '' },
  showroom_id: '', job_title: '', department: '',
  start_date: '', contract_type: 'full_time', hours_per_week: 40,
  probation_end_date: '',
  pay_type: 'salary', pay_amount: 0, pay_frequency: 'monthly',
  bank: { account_name: '', sort_code: '', account_number: '' },
  holiday_entitlement_days: 28,
  status: 'active',
};

export default function EmployeesTab() {
  const [list, setList] = useState([]);
  const [showrooms, setShowrooms] = useState([]);
  const [search, setSearch] = useState('');
  const [showroomFilter, setShowroomFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('active');
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const authHeader = () => {
    const t = localStorage.getItem('token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const params = { status: statusFilter !== 'all' ? statusFilter : undefined };
      if (showroomFilter !== 'all') params.showroom_id = showroomFilter;
      const r = await axios.get(`${API}/api/hr/employees`, { headers: authHeader(), params });
      setList(r.data || []);
    } catch (e) {
      toast.error(`Couldn't load employees: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, showroomFilter]);

  useEffect(() => { fetchList(); }, [fetchList]);

  useEffect(() => {
    (async () => {
      try {
        const r = await axios.get(`${API}/api/showrooms`, { headers: authHeader() });
        setShowrooms(r.data || []);
      } catch { /* non-fatal */ }
    })();
  }, []);

  const filtered = list.filter((e) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      `${e.first_name} ${e.last_name}`.toLowerCase().includes(q)
      || (e.employee_number || '').toLowerCase().includes(q)
      || (e.job_title || '').toLowerCase().includes(q)
      || (e.personal_email || '').toLowerCase().includes(q)
    );
  });

  const openNew = () => { setEditing({ ...EMPTY_EMP, _isNew: true }); setDrawerOpen(true); };
  const openEdit = async (id) => {
    try {
      const r = await axios.get(`${API}/api/hr/employees/${id}`, { headers: authHeader() });
      setEditing({ ...EMPTY_EMP, ...r.data, _isNew: false });
      setDrawerOpen(true);
    } catch (e) {
      toast.error(`Couldn't load record: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const handleSave = async () => {
    try {
      const payload = { ...editing };
      delete payload._isNew;
      // Strip masked bank/NI back to nulls so we don't overwrite the
      // encrypted originals with a masked-out string (e.g. "****1234").
      if ((payload.ni_number || '').includes('*')) delete payload.ni_number;
      if (payload.bank && (payload.bank.sort_code || '').includes('*')) {
        delete payload.bank.sort_code;
      }
      if (payload.bank && (payload.bank.account_number || '').includes('*')) {
        delete payload.bank.account_number;
      }
      if (editing._isNew) {
        delete payload.id; delete payload.employee_number;
        await axios.post(`${API}/api/hr/employees`, payload, { headers: authHeader() });
        toast.success('Employee created.');
      } else {
        await axios.patch(`${API}/api/hr/employees/${editing.id}`, payload, { headers: authHeader() });
        toast.success('Employee updated.');
      }
      setDrawerOpen(false);
      setEditing(null);
      await fetchList();
    } catch (e) {
      toast.error(`Save failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const handleArchive = async (id, name) => {
    if (!window.confirm(`Archive ${name}? (Soft-delete — HMRC requires we keep payroll data 6 years.)`)) return;
    try {
      await axios.delete(`${API}/api/hr/employees/${id}`, { headers: authHeader() });
      toast.success(`${name} archived.`);
      setDrawerOpen(false);
      await fetchList();
    } catch (e) {
      toast.error(`Archive failed: ${e?.response?.data?.detail || e.message}`);
    }
  };

  const showroomName = (id) => (showrooms.find((s) => s.id === id) || {}).name || '—';

  return (
    <div className="space-y-4" data-testid="hr-employees-tab">
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search name, employee #, role, email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="hr-employees-search"
          />
        </div>
        <select
          value={showroomFilter}
          onChange={(e) => setShowroomFilter(e.target.value)}
          className="h-9 px-3 rounded-md border bg-background text-sm"
          data-testid="hr-employees-showroom-filter"
        >
          <option value="all">All showrooms</option>
          {showrooms.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-9 px-3 rounded-md border bg-background text-sm"
          data-testid="hr-employees-status-filter"
        >
          <option value="active">Active only</option>
          <option value="on_leave">On leave</option>
          <option value="left">Left</option>
          <option value="all">All</option>
        </select>
        <Button onClick={openNew} className="bg-indigo-600 hover:bg-indigo-700 text-white" data-testid="hr-add-employee-btn">
          <Plus className="w-4 h-4 mr-1.5" /> Add employee
        </Button>
      </div>

      <div className="rounded-lg border bg-card" data-testid="hr-employees-list">
        {loading ? (
          <div className="p-6 text-center text-muted-foreground text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            No employees yet — click <strong>Add employee</strong> to get started.
          </div>
        ) : (
          <div className="divide-y">
            {filtered.map((e) => (
              <div
                key={e.id}
                onClick={() => openEdit(e.id)}
                className="px-4 py-3 hover:bg-muted/40 cursor-pointer transition-colors"
                data-testid={`hr-employee-row-${e.employee_number}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold">{e.first_name} {e.last_name}</span>
                      <span className="text-xs font-mono text-muted-foreground">{e.employee_number}</span>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${
                        e.status === 'active' ? 'bg-emerald-100 text-emerald-800' :
                        e.status === 'on_leave' ? 'bg-amber-100 text-amber-800' :
                        'bg-slate-200 text-slate-700'
                      }`}>{e.status}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground mt-0.5">
                      <span className="inline-flex items-center gap-1"><Briefcase className="w-3 h-3" />{e.job_title || '—'}</span>
                      <span>{showroomName(e.showroom_id)}</span>
                      {e.personal_email && <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" />{e.personal_email}</span>}
                      {e.personal_phone && <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" />{e.personal_phone}</span>}
                    </div>
                  </div>
                  <Edit className="w-4 h-4 text-muted-foreground" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Edit / Create drawer */}
      <Dialog open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="hr-employee-drawer">
          <DialogHeader>
            <DialogTitle>{editing?._isNew ? 'New employee' : `Edit ${editing?.first_name} ${editing?.last_name}`}</DialogTitle>
            <DialogDescription>
              {editing?._isNew ? 'Required: first + last name. Everything else can come later.' : `Employee # ${editing?.employee_number}`}
            </DialogDescription>
          </DialogHeader>

          {editing && (
            <div className="space-y-4">
              <EmployeeFieldsetSection title="Personal">
                <FieldRow>
                  <LabeledInput label="First name *" v={editing.first_name} onChange={(v) => setEditing({ ...editing, first_name: v })} testid="hr-first-name" />
                  <LabeledInput label="Last name *" v={editing.last_name} onChange={(v) => setEditing({ ...editing, last_name: v })} testid="hr-last-name" />
                </FieldRow>
                <FieldRow>
                  <LabeledInput label="Preferred name" v={editing.preferred_name} onChange={(v) => setEditing({ ...editing, preferred_name: v })} />
                  <LabeledInput label="Date of birth" v={editing.dob} onChange={(v) => setEditing({ ...editing, dob: v })} type="date" />
                </FieldRow>
                <FieldRow>
                  <LabeledInput label="Personal email" v={editing.personal_email} onChange={(v) => setEditing({ ...editing, personal_email: v })} type="email" />
                  <LabeledInput label="Personal phone" v={editing.personal_phone} onChange={(v) => setEditing({ ...editing, personal_phone: v })} />
                </FieldRow>
                <FieldRow>
                  <LabeledInput label="NI number (encrypted at rest)" v={editing.ni_number} onChange={(v) => setEditing({ ...editing, ni_number: v })} />
                  <LabeledInput label="Nationality" v={editing.nationality} onChange={(v) => setEditing({ ...editing, nationality: v })} />
                </FieldRow>
              </EmployeeFieldsetSection>

              <EmployeeFieldsetSection title="Employment">
                <FieldRow>
                  <LabeledInput label="Job title" v={editing.job_title} onChange={(v) => setEditing({ ...editing, job_title: v })} />
                  <LabeledSelect label="Showroom" v={editing.showroom_id} onChange={(v) => setEditing({ ...editing, showroom_id: v })}
                    options={[{ value: '', label: '—' }, ...showrooms.map((s) => ({ value: s.id, label: s.name }))]}
                  />
                </FieldRow>
                <FieldRow>
                  <LabeledInput label="Start date" v={editing.start_date} onChange={(v) => setEditing({ ...editing, start_date: v })} type="date" />
                  <LabeledInput label="Probation ends" v={editing.probation_end_date} onChange={(v) => setEditing({ ...editing, probation_end_date: v })} type="date" />
                </FieldRow>
                <FieldRow>
                  <LabeledSelect label="Contract type" v={editing.contract_type} onChange={(v) => setEditing({ ...editing, contract_type: v })} options={CONTRACT_TYPES} />
                  <LabeledInput label="Hours/week" v={editing.hours_per_week} onChange={(v) => setEditing({ ...editing, hours_per_week: Number(v) || 0 })} type="number" />
                </FieldRow>
              </EmployeeFieldsetSection>

              <EmployeeFieldsetSection title="Pay">
                <FieldRow>
                  <LabeledSelect label="Pay type" v={editing.pay_type} onChange={(v) => setEditing({ ...editing, pay_type: v })} options={PAY_TYPES} />
                  <LabeledInput label={editing.pay_type === 'salary' ? 'Annual salary (£)' : 'Hourly rate (£)'} v={editing.pay_amount} onChange={(v) => setEditing({ ...editing, pay_amount: Number(v) || 0 })} type="number" />
                </FieldRow>
                <FieldRow>
                  <LabeledSelect label="Pay frequency" v={editing.pay_frequency} onChange={(v) => setEditing({ ...editing, pay_frequency: v })} options={PAY_FREQ} />
                  <LabeledInput label="Holiday entitlement (days/yr)" v={editing.holiday_entitlement_days} onChange={(v) => setEditing({ ...editing, holiday_entitlement_days: Number(v) || 0 })} type="number" />
                </FieldRow>
              </EmployeeFieldsetSection>

              <EmployeeFieldsetSection title="Bank (encrypted at rest)">
                <FieldRow>
                  <LabeledInput label="Account name" v={editing.bank?.account_name || ''} onChange={(v) => setEditing({ ...editing, bank: { ...(editing.bank || {}), account_name: v } })} />
                  <LabeledInput label="Sort code" v={editing.bank?.sort_code || ''} onChange={(v) => setEditing({ ...editing, bank: { ...(editing.bank || {}), sort_code: v } })} />
                </FieldRow>
                <FieldRow>
                  <LabeledInput label="Account number" v={editing.bank?.account_number || ''} onChange={(v) => setEditing({ ...editing, bank: { ...(editing.bank || {}), account_number: v } })} />
                </FieldRow>
              </EmployeeFieldsetSection>

              <EmployeeFieldsetSection title="Emergency contact">
                <FieldRow>
                  <LabeledInput label="Name" v={editing.emergency_contact?.name || ''} onChange={(v) => setEditing({ ...editing, emergency_contact: { ...(editing.emergency_contact || {}), name: v } })} />
                  <LabeledInput label="Relationship" v={editing.emergency_contact?.relationship || ''} onChange={(v) => setEditing({ ...editing, emergency_contact: { ...(editing.emergency_contact || {}), relationship: v } })} />
                </FieldRow>
                <FieldRow>
                  <LabeledInput label="Phone" v={editing.emergency_contact?.phone || ''} onChange={(v) => setEditing({ ...editing, emergency_contact: { ...(editing.emergency_contact || {}), phone: v } })} />
                </FieldRow>
              </EmployeeFieldsetSection>
            </div>
          )}

          <DialogFooter className="flex flex-row justify-between items-center w-full">
            <div>
              {!editing?._isNew && editing?.id && (
                <Button
                  type="button" variant="ghost"
                  onClick={() => handleArchive(editing.id, `${editing.first_name} ${editing.last_name}`)}
                  className="text-rose-700 hover:bg-rose-50"
                  data-testid="hr-archive-btn"
                >
                  <Archive className="w-4 h-4 mr-1.5" /> Archive
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setDrawerOpen(false)}>Cancel</Button>
              <Button type="button" onClick={handleSave} className="bg-indigo-600 hover:bg-indigo-700 text-white" data-testid="hr-save-btn">
                {editing?._isNew ? 'Create' : 'Save changes'}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Small layout helpers ─────────────────────────────────────────────
function EmployeeFieldsetSection({ title, children }) {
  return (
    <div className="rounded-md border bg-muted/20 p-3 space-y-2">
      <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{title}</h4>
      {children}
    </div>
  );
}

function FieldRow({ children }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>;
}

function LabeledInput({ label, v, onChange, type = 'text', testid }) {
  return (
    <label className="block text-xs">
      <span className="block font-semibold mb-1">{label}</span>
      <Input
        type={type}
        value={v ?? ''}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
      />
    </label>
  );
}

function LabeledSelect({ label, v, onChange, options }) {
  return (
    <label className="block text-xs">
      <span className="block font-semibold mb-1">{label}</span>
      <select
        value={v || ''}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full px-3 rounded-md border bg-background text-sm"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}
