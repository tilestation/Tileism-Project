/**
 * PendingMarketingEmails.jsx — 22 Jun 2026
 * ════════════════════════════════════════
 *
 * Admin outbox for every automatic promotional email — abandoned
 * cart nudges, lead welcome vouchers, sample follow-ups. Nothing
 * sends until it's reviewed here.
 *
 * Built after a customer (Luke) placed an order and then received an
 * "Automatic reply: External: Here's 10% off your tiles" — the day-1
 * promo landed 24h after his cart timed out but *before* our
 * abandoned-cart-to-order recovery hook caught the completed sale.
 * By requiring owner sign-off on every promo, we eliminate the entire
 * class of "you just paid full price, here's a discount" incidents.
 *
 * Route: /admin/marketing/pending-emails
 * API:   /api/marketing-outbox/*
 */
import React, { useEffect, useState, useCallback } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import {
  Mail, Send, X, Eye, Filter, RefreshCw, CheckCircle2, AlertCircle,
  Clock, Ban, ShoppingCart, Gift, Sparkles, Search, ChevronDown,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card } from '../../components/ui/card';
import { Switch } from '../../components/ui/switch';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../components/ui/dialog';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const CATEGORY_ICONS = {
  abandoned_day_0:      ShoppingCart,
  abandoned_day_1:      ShoppingCart,
  abandoned_last_chance: ShoppingCart,
  lead_welcome:         Gift,
  sample_followup:      Sparkles,
};

const STATUS_TABS = [
  { key: 'pending',  label: 'Pending review', tone: 'bg-amber-100 text-amber-900 border-amber-200' },
  { key: 'sent',     label: 'Sent by admin',  tone: 'bg-emerald-100 text-emerald-900 border-emerald-200' },
  { key: 'auto_sent', label: 'Auto-sent',     tone: 'bg-blue-100 text-blue-900 border-blue-200' },
  { key: 'skipped',  label: 'Skipped',        tone: 'bg-gray-100 text-gray-700 border-gray-200' },
  { key: 'blocked_recent_order', label: 'Blocked (paid customer)', tone: 'bg-rose-100 text-rose-900 border-rose-200' },
  { key: 'failed',   label: 'Failed',         tone: 'bg-rose-100 text-rose-900 border-rose-200' },
];

const authHeader = () => ({
  Authorization: `Bearer ${localStorage.getItem('admin_token') || localStorage.getItem('token') || ''}`,
});

export default function PendingMarketingEmails() {
  const [statusFilter, setStatusFilter] = useState('pending');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [manualMode, setManualMode] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [previewDoc, setPreviewDoc] = useState(null);
  const [batchBusy, setBatchBusy] = useState(false);

  const fetchStats = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/api/marketing-outbox/stats`, { headers: authHeader() });
      setStats(res.data);
      setManualMode(!!res.data.manual_mode);
    } catch (err) {
      console.warn('stats fetch failed', err);
    }
  }, []);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const params = { status: statusFilter, limit: 100 };
      if (categoryFilter) params.category = categoryFilter;
      if (search.trim()) params.search = search.trim();
      const res = await axios.get(`${API_URL}/api/marketing-outbox`, {
        headers: authHeader(), params,
      });
      setItems(res.data.items || []);
      setTotal(res.data.total || 0);
      setCategories(res.data.categories || []);
      setSelected(new Set()); // clear on refilter
    } catch (err) {
      toast.error(`Load failed: ${err?.response?.data?.detail || err.message}`);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, categoryFilter, search]);

  useEffect(() => { fetchStats(); }, [fetchStats]);
  useEffect(() => { fetchList(); }, [fetchList]);

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAll = () => {
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.filter(i => i.status === 'pending').map(i => i.id)));
    }
  };

  const flipManualMode = async (newVal) => {
    try {
      await axios.put(
        `${API_URL}/api/marketing-outbox/settings`,
        { manual_mode: newVal },
        { headers: authHeader() },
      );
      setManualMode(newVal);
      fetchStats();
      toast.success(newVal
        ? 'Manual review ON — every promo now waits for your approval'
        : 'Manual review OFF — promos will auto-send (old behaviour)');
    } catch (err) {
      toast.error(`Failed to update setting: ${err?.response?.data?.detail || err.message}`);
    }
  };

  const sendOne = async (id, { force = false } = {}) => {
    try {
      const res = await axios.post(
        `${API_URL}/api/marketing-outbox/${id}/send`,
        {},
        { headers: authHeader(), params: force ? { force: true } : {} },
      );
      if (res.data?.ok) {
        toast.success('Email sent ✅');
      } else if (res.data?.error === 'blocked_recent_order') {
        toast.warning('Blocked — recipient has a paid order in the last 7 days', {
          description: res.data.hint || '',
          action: {
            label: 'Send anyway',
            onClick: () => sendOne(id, { force: true }),
          },
        });
      } else {
        toast.error(`Send failed: ${res.data?.error || 'unknown'}`);
      }
      fetchList();
      fetchStats();
    } catch (err) {
      toast.error(`Send failed: ${err?.response?.data?.detail || err.message}`);
    }
  };

  const skipOne = async (id) => {
    try {
      const res = await axios.post(
        `${API_URL}/api/marketing-outbox/${id}/skip`,
        { reason: '' },
        { headers: authHeader() },
      );
      if (res.data?.ok) {
        toast.success('Skipped');
        fetchList();
        fetchStats();
      } else {
        toast.error(`Skip failed: ${res.data?.error || 'unknown'}`);
      }
    } catch (err) {
      toast.error(`Skip failed: ${err?.response?.data?.detail || err.message}`);
    }
  };

  const batchSend = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`Send ${selected.size} email(s) now?`)) return;
    setBatchBusy(true);
    try {
      const res = await axios.post(
        `${API_URL}/api/marketing-outbox/batch-send`,
        { ids: [...selected], force: false },
        { headers: authHeader() },
      );
      toast.success(`Sent ${res.data.sent} of ${res.data.attempted}`);
      fetchList();
      fetchStats();
    } catch (err) {
      toast.error(`Batch send failed: ${err?.response?.data?.detail || err.message}`);
    } finally {
      setBatchBusy(false);
    }
  };

  const openPreview = async (id) => {
    try {
      const res = await axios.get(`${API_URL}/api/marketing-outbox/${id}`, { headers: authHeader() });
      setPreviewDoc(res.data);
    } catch (err) {
      toast.error(`Preview failed: ${err?.response?.data?.detail || err.message}`);
    }
  };

  return (
    <div className="space-y-6 p-6" data-testid="pending-marketing-emails-page">
      <header className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Mail className="h-7 w-7" />
            Pending marketing emails
          </h1>
          <p className="text-sm text-muted-foreground max-w-2xl mt-1">
            Every promotional email — abandoned-cart nudges, lead welcome
            vouchers, sample follow-ups — waits here for your approval
            before it goes to the customer. Order confirmations and
            receipts still send automatically.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { fetchList(); fetchStats(); }}
            data-testid="pending-emails-refresh"
          >
            <RefreshCw className="w-4 h-4 mr-1" /> Refresh
          </Button>
        </div>
      </header>

      {/* Master toggle — manual mode ON/OFF */}
      <Card className="p-4 flex items-center justify-between gap-4 border-l-4 border-l-amber-500">
        <div>
          <div className="text-sm font-semibold flex items-center gap-2">
            <Filter className="h-4 w-4" />
            Manual review mode
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono uppercase ${manualMode ? 'bg-emerald-100 text-emerald-900' : 'bg-gray-100 text-gray-700'}`}>
              {manualMode ? 'On' : 'Off'}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {manualMode
              ? 'Every promo email queues here for you to review + send. Recommended.'
              : 'Promo emails send automatically as they used to. You can still review after-the-fact in the "Auto-sent" tab.'}
          </p>
        </div>
        <Switch
          checked={manualMode}
          onCheckedChange={flipManualMode}
          data-testid="manual-mode-switch"
        />
      </Card>

      {/* Stats strip */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
          <StatTile label="Pending"   value={stats.pending}   tone="amber"    icon={Clock} />
          <StatTile label="Sent"      value={stats.sent}      tone="emerald"  icon={CheckCircle2} />
          <StatTile label="Auto-sent" value={stats.auto_sent} tone="blue"     icon={Send} />
          <StatTile label="Skipped"   value={stats.skipped}   tone="gray"     icon={X} />
          <StatTile label="Blocked"   value={stats.blocked}   tone="rose"     icon={Ban} />
          <StatTile label="Failed"    value={stats.failed}    tone="rose"     icon={AlertCircle} />
        </div>
      )}

      {/* Filters */}
      <Card className="p-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 flex-wrap" role="tablist">
          {STATUS_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setStatusFilter(tab.key)}
              className={
                'px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ' +
                (statusFilter === tab.key
                  ? tab.tone
                  : 'bg-transparent border-gray-200 text-gray-600 hover:bg-gray-50')
              }
              data-testid={`status-tab-${tab.key}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <div className="relative">
          <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-gray-400" />
          <Input
            placeholder="Search email / name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-9 w-56"
            data-testid="pending-emails-search"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="h-9 border rounded-md px-2 text-sm bg-background"
          data-testid="pending-emails-category-filter"
        >
          <option value="">All categories</option>
          {categories.map(c => (
            <option key={c.key} value={c.key}>{c.label}</option>
          ))}
        </select>
      </Card>

      {/* Bulk actions bar — only when items are selected */}
      {selected.size > 0 && (
        <div
          className="sticky top-0 z-10 bg-blue-50 border border-blue-200 rounded-md px-3 py-2 flex items-center justify-between"
          data-testid="bulk-action-bar"
        >
          <div className="text-sm text-blue-900">
            <strong>{selected.size}</strong> selected
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={batchSend}
              disabled={batchBusy}
              data-testid="bulk-send-btn"
            >
              <Send className="w-4 h-4 mr-1" />
              Send selected ({selected.size})
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set())}
              data-testid="bulk-clear-btn"
            >
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* List */}
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
              <th className="p-3 w-8">
                {statusFilter === 'pending' && (
                  <input
                    type="checkbox"
                    checked={selected.size > 0 && selected.size === items.filter(i => i.status === 'pending').length}
                    onChange={selectAll}
                    data-testid="select-all-checkbox"
                  />
                )}
              </th>
              <th className="p-3">Type</th>
              <th className="p-3">Recipient</th>
              <th className="p-3">Subject / preview</th>
              <th className="p-3">Created</th>
              <th className="p-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">Loading…</td></tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-12 text-center text-muted-foreground">
                  <ChevronDown className="w-6 h-6 mx-auto opacity-40" />
                  <div className="mt-2">Nothing to show here.</div>
                  {statusFilter === 'pending' && (
                    <div className="text-xs mt-1 opacity-70">
                      No promotional emails are waiting for review — you&apos;re all caught up.
                    </div>
                  )}
                </td>
              </tr>
            ) : items.map(row => {
              const Icon = CATEGORY_ICONS[row.category] || Mail;
              const canSend = row.status === 'pending' || row.status === 'failed';
              const canSkip = row.status === 'pending';
              return (
                <tr key={row.id} className="border-b hover:bg-gray-50 align-top" data-testid={`outbox-row-${row.id}`}>
                  <td className="p-3">
                    {canSend && (
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => toggleSelect(row.id)}
                        data-testid={`select-${row.id}`}
                      />
                    )}
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-2 text-xs font-medium text-gray-700">
                      <Icon className="h-3.5 w-3.5" />
                      <span>{row.category_label}</span>
                    </div>
                  </td>
                  <td className="p-3">
                    <div className="font-medium">{row.recipient_name || '—'}</div>
                    <div className="text-xs text-muted-foreground font-mono">{row.recipient_email}</div>
                  </td>
                  <td className="p-3">
                    <div className="font-medium truncate max-w-md">{row.subject}</div>
                    <div className="text-xs text-muted-foreground truncate max-w-md">{row.preview}</div>
                  </td>
                  <td className="p-3 text-xs text-muted-foreground whitespace-nowrap">
                    {row.created_at ? new Date(row.created_at).toLocaleString('en-GB') : '—'}
                  </td>
                  <td className="p-3">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm" variant="outline"
                        onClick={() => openPreview(row.id)}
                        data-testid={`preview-${row.id}`}
                      >
                        <Eye className="w-3.5 h-3.5 mr-1" /> Preview
                      </Button>
                      {canSend && (
                        <Button
                          size="sm"
                          onClick={() => sendOne(row.id)}
                          data-testid={`send-${row.id}`}
                        >
                          <Send className="w-3.5 h-3.5 mr-1" /> Send
                        </Button>
                      )}
                      {canSkip && (
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => skipOne(row.id)}
                          data-testid={`skip-${row.id}`}
                        >
                          <X className="w-3.5 h-3.5" /> Skip
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {total > items.length && (
          <div className="p-3 border-t text-xs text-muted-foreground text-center">
            Showing {items.length} of {total}. Refine with the search or category filter above.
          </div>
        )}
      </Card>

      {/* Preview dialog */}
      <Dialog open={!!previewDoc} onOpenChange={(v) => !v && setPreviewDoc(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-base">
              {previewDoc?.subject}
            </DialogTitle>
            <div className="text-xs text-muted-foreground">
              To: <span className="font-mono">{previewDoc?.recipient_email}</span>
              {previewDoc?.category_label && (
                <> · <span>{previewDoc.category_label}</span></>
              )}
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto border rounded-md bg-white" data-testid="preview-iframe-container">
            <iframe
              title="Email preview"
              srcDoc={previewDoc?.html || ''}
              style={{ width: '100%', minHeight: '500px', border: 'none' }}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setPreviewDoc(null)}>Close</Button>
            {previewDoc && (previewDoc.status === 'pending' || previewDoc.status === 'failed') && (
              <>
                <Button
                  variant="outline"
                  onClick={() => { skipOne(previewDoc.id); setPreviewDoc(null); }}
                  data-testid="preview-skip-btn"
                >
                  <X className="w-4 h-4 mr-1" /> Skip
                </Button>
                <Button
                  onClick={() => { sendOne(previewDoc.id); setPreviewDoc(null); }}
                  data-testid="preview-send-btn"
                >
                  <Send className="w-4 h-4 mr-1" /> Send now
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}


function StatTile({ label, value, tone, icon: Icon }) {
  const toneClasses = {
    amber:   'border-amber-200 bg-amber-50 text-amber-900',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    blue:    'border-blue-200 bg-blue-50 text-blue-900',
    rose:    'border-rose-200 bg-rose-50 text-rose-900',
    gray:    'border-gray-200 bg-gray-50 text-gray-800',
  };
  return (
    <div className={`rounded-md border px-3 py-2 ${toneClasses[tone] || toneClasses.gray}`}>
      <div className="text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1 opacity-70">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className="text-2xl font-bold mt-0.5">{value ?? 0}</div>
    </div>
  );
}
