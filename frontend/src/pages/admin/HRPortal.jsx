/**
 * HR Portal — admin entry point (13 Jun 2026).
 *
 * Tab-based page that hosts the four MVP modules:
 *   1. Employees      — directory + create/edit drawer
 *   2. Leave          — pending approvals + calendar
 *   3. Documents      — vault + expiring-soon flags
 *   4. Time tracking  — live clock-ins + weekly timesheet
 *
 * Mounted at `/admin/hr`. Lazy-loads each tab so the bundle stays
 * reasonable even as the modules grow.
 *
 * Access: only `super_admin` / `hr_admin` roles. The PageGate in
 * App.js + the backend role checks both enforce this.
 */
import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Users, Calendar, FileText, Clock, AlertCircle, ShieldCheck } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../../components/ui/tabs';
import EmployeesTab from './hr/EmployeesTab';
import LeaveTab from './hr/LeaveTab';
import DocumentsTab from './hr/DocumentsTab';
import TimeTrackingTab from './hr/TimeTrackingTab';
import VisaComplianceTab from './hr/VisaComplianceTab';

const API = process.env.REACT_APP_BACKEND_URL;

export default function HRPortal() {
  const [activeTab, setActiveTab] = useState('employees');
  const [pendingCount, setPendingCount] = useState(0);
  const [expiringCount, setExpiringCount] = useState(0);

  const authHeader = () => {
    const t = localStorage.getItem('token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  // Fetch tab badge counters once on mount so the user can see "3
  // pending leave requests" / "2 expiring docs" without opening each tab.
  useEffect(() => {
    (async () => {
      try {
        const [pending, expiring] = await Promise.all([
          axios.get(`${API}/api/hr/leave/requests/pending`, { headers: authHeader() }).catch(() => ({ data: [] })),
          axios.get(`${API}/api/hr/documents/expiring?within_days=30`, { headers: authHeader() }).catch(() => ({ data: [] })),
        ]);
        setPendingCount(pending.data?.length || 0);
        setExpiringCount(expiring.data?.length || 0);
      } catch { /* unauthed render handled by PageGate */ }
    })();
  }, []);

  return (
    <div className="space-y-6 p-1" data-testid="hr-portal">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">HR Portal</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Employee records, leave, documents and time tracking — all in one place.
          </p>
        </div>
        {(pendingCount > 0 || expiringCount > 0) && (
          <div className="flex flex-wrap gap-2">
            {pendingCount > 0 && (
              <button
                type="button"
                onClick={() => setActiveTab('leave')}
                className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300 hover:bg-amber-200 transition-colors"
                data-testid="hr-pending-leave-badge"
              >
                <AlertCircle className="w-3.5 h-3.5" />
                {pendingCount} leave request{pendingCount === 1 ? '' : 's'} awaiting approval
              </button>
            )}
            {expiringCount > 0 && (
              <button
                type="button"
                onClick={() => setActiveTab('documents')}
                className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-full bg-rose-100 text-rose-900 border border-rose-300 hover:bg-rose-200 transition-colors"
                data-testid="hr-expiring-docs-badge"
              >
                <AlertCircle className="w-3.5 h-3.5" />
                {expiringCount} document{expiringCount === 1 ? '' : 's'} expiring soon
              </button>
            )}
          </div>
        )}
      </header>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="grid grid-cols-2 sm:grid-cols-5 w-full" data-testid="hr-tab-list">
          <TabsTrigger value="employees" data-testid="hr-tab-employees">
            <Users className="w-4 h-4 mr-2" />Employees
          </TabsTrigger>
          <TabsTrigger value="leave" data-testid="hr-tab-leave">
            <Calendar className="w-4 h-4 mr-2" />Leave
            {pendingCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-amber-500 text-white text-[10px] font-bold">
                {pendingCount > 9 ? '9+' : pendingCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="documents" data-testid="hr-tab-documents">
            <FileText className="w-4 h-4 mr-2" />Documents
            {expiringCount > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-rose-500 text-white text-[10px] font-bold">
                {expiringCount > 9 ? '9+' : expiringCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="visa" data-testid="hr-tab-visa">
            <ShieldCheck className="w-4 h-4 mr-2" />Visa
          </TabsTrigger>
          <TabsTrigger value="time" data-testid="hr-tab-time">
            <Clock className="w-4 h-4 mr-2" />Time
          </TabsTrigger>
        </TabsList>

        <TabsContent value="employees">
          <EmployeesTab />
        </TabsContent>
        <TabsContent value="leave">
          <LeaveTab onPendingChange={setPendingCount} />
        </TabsContent>
        <TabsContent value="documents">
          <DocumentsTab onExpiringChange={setExpiringCount} />
        </TabsContent>
        <TabsContent value="visa">
          <VisaComplianceTab />
        </TabsContent>
        <TabsContent value="time">
          <TimeTrackingTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
