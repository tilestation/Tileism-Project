/**
 * SampleOrders — Admin page for paid SAMPLE orders (SMP-…).
 *
 * Mirrors OnlineOrders but reads from the `sample_orders` collection
 * (TS-… orders live in `shop_orders` and have their own page). Built
 * lean — no PayPal-specific column, no abandoned-recovery actions
 * (samples have a dedicated `/admin/abandoned-sample-baskets` page).
 *
 * Backend (5 Jun 2026):
 *   GET   /api/shop/admin/sample-orders         — list, filters, pagination
 *   GET   /api/shop/admin/sample-orders/stats   — top-of-page counters
 *   GET   /api/shop/admin/sample-orders/:id     — full doc for the drawer
 *   PATCH /api/shop/admin/sample-orders/:id     — status + tracking + notes
 */
import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import {
  Beaker, Search, Eye, RefreshCw, Truck, Store, ArrowLeft, X,
  CheckCircle2, Clock, AlertCircle, Mail, Phone, Loader2, Send,
  ChevronLeft, ChevronRight, MapPin, Package,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const PAGE_SIZE = 25;

const STATUS_META = {
  pending_payment: { label: 'Pending payment', color: 'bg-amber-100 text-amber-800 border-amber-200', icon: Clock },
  paid:            { label: 'Paid · awaiting dispatch', color: 'bg-blue-100 text-blue-800 border-blue-200', icon: Package },
  ready:           { label: 'Ready for collection', color: 'bg-cyan-100 text-cyan-800 border-cyan-200', icon: Store },
  shipped:         { label: 'Shipped', color: 'bg-orange-100 text-orange-800 border-orange-200', icon: Truck },
  delivered:       { label: 'Delivered', color: 'bg-emerald-100 text-emerald-800 border-emerald-200', icon: CheckCircle2 },
  completed:       { label: 'Completed', color: 'bg-emerald-100 text-emerald-800 border-emerald-200', icon: CheckCircle2 },
  cancelled:       { label: 'Cancelled', color: 'bg-rose-100 text-rose-800 border-rose-200', icon: AlertCircle },
};

const STATUS_OPTIONS = [
  { value: 'paid',      label: 'Paid · awaiting dispatch' },
  { value: 'ready',     label: 'Ready for collection' },
  { value: 'shipped',   label: 'Shipped' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

function StatusPill({ status }) {
  const meta = STATUS_META[status] || { label: status || 'Unknown', color: 'bg-gray-100 text-gray-700 border-gray-200', icon: Clock };
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border ${meta.color}`}
      data-testid={`sample-order-status-${status}`}
    >
      <Icon className="w-3 h-3" />
      {meta.label}
    </span>
  );
}

function StatCard({ label, value, icon: Icon, accent }) {
  return (
    <div className={`p-4 rounded-xl border ${accent} bg-card`}>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="w-3.5 h-3.5" /> {label}
      </div>
      <div className="text-2xl font-extrabold tabular-nums mt-1">{value}</div>
    </div>
  );
}

export default function SampleOrders() {
  const [orders, setOrders] = useState([]);
  const [stats, setStats] = useState(null);
  const [total, setTotal] = useState(0);
  const [skip, setSkip] = useState(0);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [includeUnpaid, setIncludeUnpaid] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [drawerSaving, setDrawerSaving] = useState(false);

  const authHeader = () => {
    const t = localStorage.getItem('admin_token') || localStorage.getItem('token');
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        limit: PAGE_SIZE,
        skip,
        include_unpaid: includeUnpaid ? 'true' : 'false',
      };
      if (statusFilter && statusFilter !== 'all') params.status = statusFilter;
      if (search.trim()) params.search = search.trim();
      const res = await axios.get(`${API_URL}/api/shop/admin/sample-orders`, {
        params,
        headers: authHeader(),
      });
      setOrders(res.data.orders || []);
      setTotal(res.data.total || 0);
    } catch (err) {
      toast.error(`Couldn't load sample orders: ${err?.response?.data?.detail || err.message}`);
    } finally {
      setLoading(false);
    }
  }, [skip, statusFilter, search, includeUnpaid]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/api/shop/admin/sample-orders/stats`, {
        headers: authHeader(),
      });
      setStats(res.data);
    } catch (err) {
      console.warn('[SampleOrders] stats fetch failed', err?.message);
    }
  }, []);

  useEffect(() => { fetchOrders(); }, [fetchOrders]);
  useEffect(() => { fetchStats(); }, [fetchStats]);

  const onSearchSubmit = (e) => {
    e.preventDefault();
    setSkip(0);
    fetchOrders();
  };

  const openDrawer = async (orderRow) => {
    try {
      const res = await axios.get(`${API_URL}/api/shop/admin/sample-orders/${orderRow.id}`, {
        headers: authHeader(),
      });
      setSelected(res.data);
    } catch (err) {
      toast.error(`Couldn't open order: ${err?.response?.data?.detail || err.message}`);
    }
  };

  const updateSelected = async (updates) => {
    if (!selected?.id) return;
    setDrawerSaving(true);
    try {
      const res = await axios.patch(
        `${API_URL}/api/shop/admin/sample-orders/${selected.id}`,
        updates,
        { headers: authHeader() },
      );
      setSelected(res.data.order);
      toast.success('Sample order updated');
      fetchOrders();
      fetchStats();
    } catch (err) {
      toast.error(`Update failed: ${err?.response?.data?.detail || err.message}`);
    } finally {
      setDrawerSaving(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(skip / PAGE_SIZE) + 1;

  return (
    <div className="p-6 max-w-7xl mx-auto" data-testid="sample-orders-page">
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link to="/admin" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-2">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back to admin
          </Link>
          <h1 className="text-3xl font-extrabold flex items-center gap-2">
            <Beaker className="w-8 h-8 text-emerald-600" /> Sample Orders
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Paid sample-postage orders (SMP-…). Online orders (TS-…) live on the
            {' '}<Link to="/admin/online-orders" className="text-emerald-700 underline">Online Orders page</Link>.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => { fetchOrders(); fetchStats(); }}
          data-testid="sample-orders-refresh"
        >
          <RefreshCw className="w-4 h-4 mr-1" /> Refresh
        </Button>
      </div>

      {/* Top stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
          <StatCard label="Orders today" value={stats.orders_today ?? 0} icon={Beaker} accent="border-emerald-200" />
          <StatCard
            label="Revenue today"
            value={`£${Number(stats.revenue_today || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            icon={Package} accent="border-amber-200"
          />
          <StatCard label="Pending dispatch" value={stats.pending_dispatch ?? 0} icon={Clock} accent="border-blue-200" />
          <StatCard label="Awaiting collection" value={stats.awaiting_collection ?? 0} icon={Store} accent="border-cyan-200" />
          <StatCard label="Overdue (>2d)" value={stats.overdue ?? 0} icon={AlertCircle} accent="border-rose-200" />
        </div>
      )}

      {/* Filters */}
      <div className="bg-card border border-border rounded-xl p-4 mb-4 flex flex-wrap items-center gap-3">
        <form onSubmit={onSearchSubmit} className="flex-1 min-w-[260px] relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by order #, name, email, phone…"
            className="pl-10"
            data-testid="sample-orders-search"
          />
        </form>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setSkip(0); }}
          className="h-10 px-3 rounded-md border border-input bg-background text-sm"
          data-testid="sample-orders-status-filter"
        >
          <option value="all">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={includeUnpaid}
            onChange={(e) => { setIncludeUnpaid(e.target.checked); setSkip(0); }}
            data-testid="sample-orders-include-unpaid"
          />
          Include unpaid drafts
        </label>
      </div>

      {/* List */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-12 text-center text-muted-foreground">
            <Loader2 className="w-6 h-6 mx-auto animate-spin mb-2" />
            Loading sample orders…
          </div>
        ) : orders.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground" data-testid="sample-orders-empty">
            <Beaker className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="font-semibold">No sample orders match these filters.</p>
            <p className="text-xs mt-1">Try clearing the search, or toggling &quot;Include unpaid drafts&quot;.</p>
          </div>
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="py-2 px-3 text-left font-medium">Order #</th>
                <th className="py-2 px-3 text-left font-medium">Customer</th>
                <th className="py-2 px-3 text-left font-medium">Samples</th>
                <th className="py-2 px-3 text-right font-medium">Total</th>
                <th className="py-2 px-3 text-left font-medium">Status</th>
                <th className="py-2 px-3 text-left font-medium">Created</th>
                <th className="py-2 px-3 text-right font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr
                  key={o.id || o.order_number}
                  className="border-t border-border hover:bg-emerald-50/40 cursor-pointer"
                  onClick={() => openDrawer(o)}
                  data-testid={`sample-order-row-${o.order_number}`}
                >
                  <td className="py-2 px-3 font-mono text-emerald-700">#{o.order_number}</td>
                  <td className="py-2 px-3">
                    <div className="font-medium">{o.customer_name || '—'}</div>
                    <div className="text-xs text-muted-foreground truncate max-w-[220px]">{o.customer_email}</div>
                  </td>
                  <td className="py-2 px-3 text-xs">
                    {(o.sample_count ?? 0)} item{o.sample_count === 1 ? '' : 's'}
                    {(o.paid_sample_count ?? 0) > 0 && (
                      <span className="ml-1 text-amber-700">· {o.paid_sample_count} paid</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums">
                    £{Number(o.total || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td className="py-2 px-3"><StatusPill status={o.status} /></td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">
                    {o.created_at ? new Date(o.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                  </td>
                  <td className="py-2 px-3 text-right">
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0"><Eye className="w-4 h-4" /></Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between mt-4 text-sm" data-testid="sample-orders-pagination">
          <div className="text-muted-foreground">
            Showing {skip + 1}–{Math.min(skip + PAGE_SIZE, total)} of {total}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={skip === 0}
              onClick={() => setSkip(Math.max(0, skip - PAGE_SIZE))}>
              <ChevronLeft className="w-4 h-4" /> Prev
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums">
              Page {currentPage} / {totalPages}
            </span>
            <Button size="sm" variant="outline" disabled={skip + PAGE_SIZE >= total}
              onClick={() => setSkip(skip + PAGE_SIZE)}>
              Next <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Detail drawer */}
      {selected && (
        <SampleOrderDrawer
          order={selected}
          onClose={() => setSelected(null)}
          onSave={updateSelected}
          saving={drawerSaving}
        />
      )}
    </div>
  );
}

function SampleOrderDrawer({ order, onClose, onSave, saving }) {
  const [status, setStatus] = useState(order.status || 'paid');
  const [tracking, setTracking] = useState(order.tracking || { carrier: '', tracking_number: '', url: '' });
  const [note, setNote] = useState('');

  const hasChanges = (
    status !== order.status
    || (tracking.carrier !== (order.tracking?.carrier || ''))
    || (tracking.tracking_number !== (order.tracking?.tracking_number || ''))
    || (tracking.url !== (order.tracking?.url || ''))
    || note.trim().length > 0
  );

  const save = () => {
    const updates = {};
    if (status !== order.status) updates.status = status;
    if ((tracking.carrier || tracking.tracking_number || tracking.url)
        && (
          tracking.carrier !== (order.tracking?.carrier || '')
          || tracking.tracking_number !== (order.tracking?.tracking_number || '')
          || tracking.url !== (order.tracking?.url || '')
        )) {
      updates.tracking = tracking;
    }
    if (note.trim()) updates.notes = note.trim();
    onSave(updates).then(() => setNote(''));
  };

  return (
    <div className="fixed inset-0 z-50 flex" data-testid="sample-order-drawer">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <aside className="w-full max-w-2xl bg-background border-l border-border overflow-y-auto">
        <header className="sticky top-0 bg-background border-b border-border p-4 flex items-center justify-between z-10">
          <div>
            <div className="text-xs text-muted-foreground">Sample order</div>
            <div className="font-mono font-bold">#{order.order_number}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}><X className="w-4 h-4" /></Button>
        </header>

        <div className="p-4 space-y-5">
          {/* Customer */}
          <section>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Customer</div>
            <div className="font-semibold">{order.customer_name}</div>
            <div className="text-sm text-muted-foreground flex items-center gap-2 mt-0.5">
              <Mail className="w-3.5 h-3.5" /> {order.customer_email}
            </div>
            {order.customer_phone && (
              <div className="text-sm text-muted-foreground flex items-center gap-2 mt-0.5">
                <Phone className="w-3.5 h-3.5" /> {order.customer_phone}
              </div>
            )}
          </section>

          {/* Address */}
          {order.delivery_address && (
            <section>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1 flex items-center gap-1">
                <MapPin className="w-3 h-3" /> Delivery address
              </div>
              <div className="whitespace-pre-line text-sm">{order.delivery_address}</div>
            </section>
          )}

          {/* Items */}
          <section>
            <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
              Samples ({(order.products || []).length})
            </div>
            <ul className="divide-y divide-border border border-border rounded-md overflow-hidden">
              {(order.products || []).map((p, i) => (
                <li key={i} className="flex items-center gap-3 p-2 text-sm">
                  {(p.image_url || p.image) && (
                    <img src={p.image_url || p.image} alt="" className="w-10 h-10 object-cover rounded" />
                  )}
                  <div className="flex-1">{p.product_name || p.name || 'Sample'}</div>
                  <div className="text-xs tabular-nums">
                    {(p.price_gbp || 0) > 0 ? `£${Number(p.price_gbp).toFixed(2)}` : <span className="text-emerald-700 font-semibold">FREE</span>}
                  </div>
                </li>
              ))}
            </ul>
            <div className="text-sm mt-2 flex justify-between text-muted-foreground">
              <span>Postage</span>
              <span className="tabular-nums">£{Number(order.postage_fee || 0).toFixed(2)}</span>
            </div>
            <div className="text-sm flex justify-between font-bold mt-1 border-t border-border pt-1">
              <span>Total</span>
              <span className="tabular-nums">£{Number(order.total || 0).toFixed(2)}</span>
            </div>
          </section>

          {/* Status update */}
          <section>
            <label className="text-xs uppercase tracking-wider text-muted-foreground mb-1 block">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-full h-10 px-3 rounded-md border border-input bg-background text-sm"
              data-testid="sample-order-drawer-status"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
          </section>

          {/* Tracking */}
          <section>
            <label className="text-xs uppercase tracking-wider text-muted-foreground mb-1 block flex items-center gap-1">
              <Truck className="w-3 h-3" /> Tracking
            </label>
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="Carrier (Royal Mail / DPD)"
                value={tracking.carrier || ''}
                onChange={(e) => setTracking({ ...tracking, carrier: e.target.value })}
                data-testid="sample-order-drawer-carrier"
              />
              <Input
                placeholder="Tracking number"
                value={tracking.tracking_number || ''}
                onChange={(e) => setTracking({ ...tracking, tracking_number: e.target.value })}
                data-testid="sample-order-drawer-tracking-no"
              />
            </div>
            <Input
              placeholder="Tracking URL (optional)"
              value={tracking.url || ''}
              onChange={(e) => setTracking({ ...tracking, url: e.target.value })}
              className="mt-2"
              data-testid="sample-order-drawer-tracking-url"
            />
          </section>

          {/* Admin notes */}
          <section>
            <label className="text-xs uppercase tracking-wider text-muted-foreground mb-1 block">Add admin note</label>
            <Textarea
              placeholder="Internal note (only visible to staff)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              data-testid="sample-order-drawer-note"
            />
            {(order.admin_notes || []).length > 0 && (
              <div className="mt-3 space-y-1.5 text-xs text-muted-foreground border-l-2 border-emerald-300 pl-3">
                {order.admin_notes.slice(-4).reverse().map((n, i) => (
                  <div key={i}>
                    <span className="font-semibold text-foreground">{n.by}</span>
                    {' · '}
                    <span>{n.at ? new Date(n.at).toLocaleString('en-GB') : ''}</span>
                    <div>{n.note}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <footer className="sticky bottom-0 bg-background border-t border-border p-4 flex items-center justify-between">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            onClick={save}
            disabled={!hasChanges || saving}
            data-testid="sample-order-drawer-save"
          >
            {saving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </footer>
      </aside>
    </div>
  );
}
