/**
 * OnlineOrders — Admin "Online Orders" page.
 *
 * Lists website-checkout orders (both card-flow and PayPal/Klarna/Wallet
 * Express) from the `shop_orders` collection. Click any row → modal with
 * full detail (items, delivery + billing addresses, customer info, status
 * history, order notes). Status can be updated inline.
 *
 * Backend:
 *   GET  /api/shop/admin/online-orders          → list (paginated, filtered)
 *   GET  /api/shop/admin/online-orders/:id      → detail
 *   PUT  /api/shop/orders/:id/status            → update status (existing)
 */
import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Package, Search, Eye, RefreshCw, Truck, Store, MapPin,
  Receipt, CreditCard, ChevronLeft, ChevronRight, ArrowLeft, X,
  CheckCircle2, Clock, AlertCircle, Mail, Phone, Loader2, Trash2, MessageSquare, Send,
} from 'lucide-react';
import axios from 'axios';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { toast } from 'sonner';
import ClickToCallButton from '../../components/ClickToCallButton';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const STATUS_META = {
  pending:                { label: 'Pending',       color: 'bg-amber-100 text-amber-800 border-amber-200',   icon: Clock },
  confirmed:              { label: 'Confirmed',     color: 'bg-blue-100 text-blue-800 border-blue-200',     icon: CheckCircle2 },
  processing:             { label: 'Processing',    color: 'bg-purple-100 text-purple-800 border-purple-200', icon: Package },
  shipped:                { label: 'Shipped',       color: 'bg-orange-100 text-orange-800 border-orange-200', icon: Truck },
  delivered:              { label: 'Delivered',     color: 'bg-emerald-100 text-emerald-800 border-emerald-200', icon: CheckCircle2 },
  ready_for_collection:   { label: 'Ready',         color: 'bg-cyan-100 text-cyan-800 border-cyan-200',     icon: Store },
  collected:              { label: 'Collected',     color: 'bg-emerald-100 text-emerald-800 border-emerald-200', icon: CheckCircle2 },
  cancelled:              { label: 'Cancelled',     color: 'bg-rose-100 text-rose-800 border-rose-200',    icon: AlertCircle },
};

const STATUS_OPTIONS = [
  { value: 'confirmed',           label: 'Confirmed' },
  { value: 'processing',          label: 'Processing' },
  { value: 'ready_for_collection',label: 'Ready for Collection' },
  { value: 'shipped',             label: 'Shipped / Out for Delivery' },
  { value: 'delivered',           label: 'Delivered' },
  { value: 'collected',           label: 'Collected' },
  { value: 'cancelled',           label: 'Cancelled' },
];

function StatusPill({ status }) {
  const meta = STATUS_META[status] || { label: status || 'Unknown', color: 'bg-gray-100 text-gray-700 border-gray-200', icon: Clock };
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full border ${meta.color}`}>
      <Icon className="w-3 h-3" />
      {meta.label}
    </span>
  );
}

const PAYMENT_META = {
  paid:      { label: 'Paid',         color: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  initiated: { label: 'Awaiting',     color: 'bg-amber-100 text-amber-800 border-amber-200' },
  pending:   { label: 'Not started',  color: 'bg-gray-100 text-gray-600 border-gray-200' },
  failed:    { label: 'Failed',       color: 'bg-rose-100 text-rose-800 border-rose-200' },
  refunded:  { label: 'Refunded',     color: 'bg-purple-100 text-purple-800 border-purple-200' },
};

function PaymentPill({ status }) {
  const meta = PAYMENT_META[status] || { label: status || '—', color: 'bg-gray-100 text-gray-500 border-gray-200' };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-medium rounded-full border ${meta.color}`}>
      {meta.label}
    </span>
  );
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function formatAddress(addr) {
  if (!addr || typeof addr !== 'object') return null;
  const lines = [
    addr.address1, addr.address2, addr.city, addr.county, (addr.postcode || '').toUpperCase(),
  ].filter(Boolean);
  return lines.length ? lines.join(', ') : null;
}

/* ---------------- Detail modal ---------------- */

function OrderDetailModal({ orderId, onClose, onStatusChanged, onDeleted }) {
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingStatus, setSavingStatus] = useState(false);
  const [newStatus, setNewStatus] = useState('');
  // Delete-with-password state — only super_admin sees this UI.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  // Status-update notes prompt — opens when admin clicks "Update". The
  // note becomes part of the status_history and is shown prominently on
  // the customer-facing Track Order page + the email body. Skip = save
  // status without a note.
  const [notesPromptOpen, setNotesPromptOpen] = useState(false);
  const [statusNote, setStatusNote] = useState('');
  // Quick-reply templates — admin picks one to pre-fill the textarea
  // ("Tiles dispatched via DPD"). Curated list lives in website_settings;
  // editable inline via the small "Edit list" popover.
  const [quickReplies, setQuickReplies] = useState([]);
  const [editRepliesOpen, setEditRepliesOpen] = useState(false);
  const [repliesDraft, setRepliesDraft] = useState('');
  const [savingReplies, setSavingReplies] = useState(false);
  // Custom one-off email modal — for situations a status update doesn't
  // cover (e.g. "Your driver will call 30min before arrival"). Reuses the
  // same email wrapper as status emails for consistent branding.
  const [customEmailOpen, setCustomEmailOpen] = useState(false);
  const [customEmailSubject, setCustomEmailSubject] = useState('');
  const [customEmailBody, setCustomEmailBody] = useState('');
  const [sendingCustomEmail, setSendingCustomEmail] = useState(false);

  const sendCustomEmail = async () => {
    if (!customEmailBody.trim()) {
      toast.error('Email body cannot be empty');
      return;
    }
    setSendingCustomEmail(true);
    try {
      const res = await axios.post(
        `${API_URL}/api/shop/orders/${orderId}/send-custom-email`,
        { subject: customEmailSubject.trim(), body: customEmailBody.trim() },
        auth
      );
      toast.success('Email sent to customer', {
        description: `Delivered to ${res.data?.to || order?.customer_email}`,
      });
      setCustomEmailOpen(false);
      setCustomEmailSubject('');
      setCustomEmailBody('');
      await fetchOrder();
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Failed to send email');
    } finally {
      setSendingCustomEmail(false);
    }
  };

  // 📧 Manually resend the order-confirmation emails (customer + owner).
  // Built for the 16 Jun 2026 P0 incident where a customer paid but
  // neither email fired. Hits the new idempotent dispatcher backend-side.
  const [resendingConfirmation, setResendingConfirmation] = useState(false);
  const handleResendConfirmation = async () => {
    if (!order || resendingConfirmation) return;
    setResendingConfirmation(true);
    try {
      const res = await axios.post(
        `${API_URL}/api/shop/admin/online-orders/${order.id}/resend-confirmation`,
        {},
        auth,
      );
      const r = res.data?.result || {};
      const cust = r.customer?.success;
      const ownr = r.owner?.success;
      if (cust && ownr) {
        toast.success('Confirmation emails resent', {
          description: `Customer + owner notifications dispatched for ${order.order_number}`,
        });
      } else if (cust) {
        toast.warning('Customer email sent, owner email failed', {
          description: r.owner?.error || 'See email_log for details',
        });
      } else if (ownr) {
        toast.warning('Owner email sent, customer email failed', {
          description: r.customer?.error || 'See email_log for details',
        });
      } else {
        toast.error('Both emails failed', {
          description: `${r.customer?.error || ''} / ${r.owner?.error || ''}`,
        });
      }
      await fetchOrder();
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Resend failed');
    } finally {
      setResendingConfirmation(false);
    }
  };

  const token = localStorage.getItem('token');
  const auth = { headers: { Authorization: `Bearer ${token}` } };

  const currentUser = (() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}'); }
    catch { return {}; }
  })();
  const isSuperAdmin = currentUser?.role === 'super_admin';

  const fetchOrder = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get(`${API_URL}/api/shop/admin/online-orders/${orderId}`, auth);
      setOrder(res.data);
      setNewStatus(res.data.status || '');
    } catch (err) {
      toast.error('Failed to load order details');
      onClose();
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  useEffect(() => { fetchOrder(); }, [fetchOrder]);

  // Fetch the curated quick-reply templates once when the modal opens —
  // the backend seeds sensible defaults on first call so we never get a
  // blank dropdown.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await axios.get(`${API_URL}/api/shop/admin/status-quick-replies`, auth);
        if (!cancelled) setQuickReplies(res.data?.replies || []);
      } catch { /* non-fatal — dropdown just stays hidden */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveQuickReplies = async () => {
    setSavingReplies(true);
    try {
      const replies = repliesDraft
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      const res = await axios.put(
        `${API_URL}/api/shop/admin/status-quick-replies`,
        { replies },
        auth
      );
      setQuickReplies(res.data?.replies || []);
      toast.success(`Saved ${res.data?.count || 0} quick replies`);
      setEditRepliesOpen(false);
    } catch (err) {
      toast.error('Failed to save quick replies');
    } finally {
      setSavingReplies(false);
    }
  };

  const handleStatusUpdate = async (noteOverride) => {
    if (!newStatus || newStatus === order?.status) return;
    setSavingStatus(true);
    try {
      const note = (noteOverride !== undefined ? noteOverride : statusNote).trim();
      await axios.put(
        `${API_URL}/api/shop/orders/${orderId}/status`,
        { status: newStatus, ...(note ? { notes: note } : {}) },
        auth
      );
      toast.success(`Order status updated to ${newStatus}`, {
        description: note
          ? 'Customer has been emailed with your note.'
          : 'Customer has been emailed automatically.',
      });
      setNotesPromptOpen(false);
      setStatusNote('');
      await fetchOrder();
      onStatusChanged?.();
    } catch (err) {
      const detail = err?.response?.data?.detail || 'Failed to update status';
      toast.error(detail);
    } finally {
      setSavingStatus(false);
    }
  };

  // "Update" button click — open the notes prompt instead of submitting
  // immediately, so admins can attach a customer-facing message (e.g.
  // "Your tiles are on the next van"). Empty note = same as before.
  const openStatusUpdate = () => {
    if (!newStatus || newStatus === order?.status) return;
    setStatusNote('');
    setNotesPromptOpen(true);
  };

  const handleDelete = async () => {
    if (!deletePassword.trim()) {
      toast.error('Enter your super-admin password to confirm');
      return;
    }
    setDeleting(true);
    try {
      await axios.delete(`${API_URL}/api/shop/admin/online-orders/${orderId}`, {
        ...auth,
        data: { password: deletePassword, reason: deleteReason.trim() || undefined },
      });
      toast.success('Order deleted', { description: 'A backup copy was kept for audit.' });
      setDeleteOpen(false);
      setDeletePassword('');
      setDeleteReason('');
      onDeleted?.();
      onClose();
    } catch (err) {
      const detail = err?.response?.data?.detail || 'Failed to delete order';
      toast.error(detail);
    } finally {
      setDeleting(false);
    }
  };

  if (!orderId) return null;

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto"
      data-testid="order-detail-modal"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-4xl my-8 max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <div>
            <h2 className="text-lg font-bold text-gray-900">
              {order?.order_number ? `Order #${order.order_number}` : 'Loading order…'}
            </h2>
            {order?.created_at && <p className="text-xs text-gray-500 mt-0.5">{formatDate(order.created_at)}</p>}
          </div>
          <div className="flex items-center gap-2">
            {isSuperAdmin && order && (
              <button
                onClick={() => setDeleteOpen(true)}
                className="px-3 py-1.5 text-xs font-medium rounded-md text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 transition-colors flex items-center gap-1.5"
                data-testid="delete-order-btn"
                title="Delete this order (super-admin only)"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete order
              </button>
            )}
            <button onClick={onClose} className="p-2 rounded-md hover:bg-gray-100" aria-label="Close" data-testid="modal-close">
              <X className="w-5 h-5 text-gray-500" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : order && (
            <>
              {/* Status row */}
              <div className="flex flex-wrap items-center gap-3 bg-gray-50 border border-gray-200 rounded-xl p-4">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">Status</span>
                <StatusPill status={order.status} />
                <div className="ml-auto flex items-center gap-2">
                  <select
                    value={newStatus}
                    onChange={(e) => setNewStatus(e.target.value)}
                    className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
                    data-testid="status-select"
                  >
                    <option value="">— Change status —</option>
                    {STATUS_OPTIONS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                  <Button
                    onClick={openStatusUpdate}
                    disabled={savingStatus || !newStatus || newStatus === order.status}
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-700 text-white"
                    data-testid="status-save-btn"
                  >
                    {savingStatus ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Update'}
                  </Button>
                </div>
              </div>

              {/* Customer + Payment */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border border-gray-200 rounded-xl p-4">
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">Customer</h3>
                    {order.customer_email && (() => {
                      // "Last contacted X ago" hint on the Send-email button —
                      // helps admins avoid double-messaging during a busy
                      // afternoon. Computed from the most recent successful
                      // email_log entry.
                      const lastOk = (order.email_log || [])
                        .slice()
                        .reverse()
                        .find(e => e && e.ok && e.sent_at);
                      let hint = null;
                      if (lastOk) {
                        const diffMin = Math.max(0, Math.round((Date.now() - new Date(lastOk.sent_at).getTime()) / 60000));
                        if (diffMin < 1) hint = 'just now';
                        else if (diffMin < 60) hint = `${diffMin}m ago`;
                        else if (diffMin < 1440) hint = `${Math.round(diffMin / 60)}h ago`;
                        else hint = `${Math.round(diffMin / 1440)}d ago`;
                      }
                      return (
                        <button
                          type="button"
                          onClick={() => { setCustomEmailSubject(''); setCustomEmailBody(''); setCustomEmailOpen(true); }}
                          className="text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700 font-medium"
                          title={hint
                            ? `Last contacted this customer ${hint}. Click to send a new email.`
                            : 'Send a one-off email to this customer (uses the same branded wrapper as status emails)'}
                          data-testid="send-custom-email-btn"
                        >
                          <Send className="w-3 h-3" /> Send email
                          {hint && <span className="text-[10px] text-emerald-500 font-normal ml-0.5">· {hint}</span>}
                        </button>
                      );
                    })()}
                  </div>
                  <div className="text-sm space-y-1.5 text-gray-700">
                    <div className="font-medium text-gray-900">{order.customer_name || '—'}</div>
                    {order.customer_email && <div className="flex items-center gap-1.5"><Mail className="w-3.5 h-3.5 text-gray-400" /><a href={`mailto:${order.customer_email}`} className="text-emerald-700 hover:underline">{order.customer_email}</a></div>}
                    {order.customer_phone && (
                      <div className="flex items-center gap-2">
                        <Phone className="w-3.5 h-3.5 text-gray-400" />
                        <a href={`tel:${order.customer_phone}`} className="hover:underline font-mono">
                          {order.customer_phone}
                        </a>
                        <ClickToCallButton
                          number={order.customer_phone}
                          variant="icon"
                          customerName={order.customer_name}
                        />
                      </div>
                    )}
                  </div>
                </div>
                <div className="border border-gray-200 rounded-xl p-4">
                  <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2"><CreditCard className="w-4 h-4 text-gray-400" /> Payment</h3>
                  <div className="text-sm space-y-1.5 text-gray-700">
                    <div>Method: <strong className="capitalize">{order.payment_method || '—'}</strong></div>
                    <div>Status: <strong className="capitalize">{order.payment_status || '—'}</strong></div>
                    {order.source && <div className="text-xs text-gray-500">Source: {order.source}</div>}
                  </div>
                </div>
              </div>

              {/* Delivery + Billing */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border border-gray-200 rounded-xl p-4" data-testid="delivery-address-block">
                  <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
                    {order.delivery_method === 'collect' ? <Store className="w-4 h-4 text-gray-400" /> : <Truck className="w-4 h-4 text-gray-400" />}
                    {order.delivery_method === 'collect' ? 'Collection' : 'Delivery Address'}
                  </h3>
                  {order.delivery_method === 'collect' ? (
                    <div className="space-y-1" data-testid="collect-store-block">
                      <p className="text-xs uppercase tracking-wider text-gray-400 font-semibold">Click &amp; Collect from</p>
                      {order.collect_store ? (
                        <>
                          <p className="text-sm font-bold text-gray-900" data-testid="collect-store-name">
                            {order.collect_store.name}
                          </p>
                          {order.collect_store.address && (
                            <p className="text-xs text-gray-600 leading-relaxed whitespace-pre-line">
                              {order.collect_store.address}
                            </p>
                          )}
                          {(order.collect_store.phone || order.collect_store.email) && (
                            <div className="pt-1 text-xs text-gray-500 space-y-0.5">
                              {order.collect_store.phone && <div>{order.collect_store.phone}</div>}
                              {order.collect_store.email && <div className="truncate">{order.collect_store.email}</div>}
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="text-sm text-amber-700 italic" data-testid="collect-store-missing">
                          No store selected — customer picked Click &amp; Collect without choosing a branch (legacy order or a bug in the checkout flow).
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-gray-700 leading-relaxed">{formatAddress(order.delivery_address) || <span className="text-gray-400">Not provided</span>}</p>
                  )}
                  {order.delivery_speed && <p className="text-xs mt-2 text-gray-500">Speed: <strong className="capitalize">{order.delivery_speed}</strong></p>}
                </div>
                <div className="border border-gray-200 rounded-xl p-4" data-testid="billing-address-block">
                  <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2"><Receipt className="w-4 h-4 text-gray-400" /> Billing Address</h3>
                  {!order.billing_address ? (
                    <p className="text-xs text-gray-400 italic">Not captured (legacy order)</p>
                  ) : order.billing_address.same_as_delivery ? (
                    <p className="text-sm text-gray-600 italic">Same as delivery address</p>
                  ) : (
                    <div className="text-sm text-gray-700 space-y-1">
                      {(order.billing_address.first_name || order.billing_address.last_name) && (
                        <div className="font-medium text-gray-900">
                          {[order.billing_address.first_name, order.billing_address.last_name].filter(Boolean).join(' ')}
                        </div>
                      )}
                      {order.billing_address.company && <div className="text-gray-600">{order.billing_address.company}</div>}
                      <div className="leading-relaxed">{formatAddress(order.billing_address)}</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Items */}
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <h3 className="text-sm font-semibold text-gray-900 px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center gap-2">
                  <Package className="w-4 h-4 text-gray-400" /> Items ({(order.items || []).length})
                </h3>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200 text-gray-500">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">Product</th>
                      <th className="text-right px-4 py-2 font-medium">Qty</th>
                      <th className="text-right px-4 py-2 font-medium">Price</th>
                      <th className="text-right px-4 py-2 font-medium">Line Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(order.items || []).map((item, idx) => {
                      const qty = Number(item.quantity || 0);
                      const price = Number(item.price || 0);
                      return (
                        <tr key={idx} className="border-b last:border-b-0 border-gray-100">
                          <td className="px-4 py-2.5">
                            <div className="font-medium text-gray-900">{item.name || item.product_id || '—'}</div>
                            {item.variant && <div className="text-xs text-gray-500">{item.variant}</div>}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums">{qty.toFixed(2)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums">£{price.toFixed(2)}</td>
                          <td className="px-4 py-2.5 text-right tabular-nums font-medium">£{(qty * price).toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-gray-50">
                    <tr className="text-sm">
                      <td className="px-4 py-2 text-gray-500" colSpan={3}>Subtotal</td>
                      <td className="px-4 py-2 text-right tabular-nums">£{(order.subtotal ?? 0).toFixed(2)}</td>
                    </tr>
                    {!!order.delivery_fee && (
                      <tr className="text-sm">
                        <td className="px-4 py-2 text-gray-500" colSpan={3}>Delivery</td>
                        <td className="px-4 py-2 text-right tabular-nums">£{Number(order.delivery_fee).toFixed(2)}</td>
                      </tr>
                    )}
                    {!!order.express_fee && (
                      <tr className="text-sm">
                        <td className="px-4 py-2 text-gray-500" colSpan={3}>Express</td>
                        <td className="px-4 py-2 text-right tabular-nums">£{Number(order.express_fee).toFixed(2)}</td>
                      </tr>
                    )}
                    {!!order.congestion_charge && (
                      <tr className="text-sm">
                        <td className="px-4 py-2 text-gray-500" colSpan={3}>Congestion charge</td>
                        <td className="px-4 py-2 text-right tabular-nums">£{Number(order.congestion_charge).toFixed(2)}</td>
                      </tr>
                    )}
                    <tr className="border-t-2 border-gray-200">
                      <td className="px-4 py-2.5 font-semibold text-gray-900" colSpan={3}>Total</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-bold text-gray-900">£{(order.total ?? 0).toFixed(2)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Notes (free-sample choice + delivery instructions) */}
              {order.notes && (
                <div className="border border-amber-200 bg-amber-50 rounded-xl p-4" data-testid="order-notes-block">
                  <h3 className="text-sm font-semibold text-amber-900 mb-2">Order Notes</h3>
                  <p className="text-sm text-amber-900 whitespace-pre-wrap">{order.notes}</p>
                </div>
              )}

              {/* Email log — surfaces every email sent for this order so
                  the team can avoid double-messaging the customer. Status
                  emails show the status; custom emails show the subject. */}
              {/* Orphaned-order rescue: paid but NEVER emailed (Carolina case) */}
              {order.payment_status === 'paid' && (!Array.isArray(order.email_log) || order.email_log.length === 0) && (
                <div className="border border-amber-300 bg-amber-50 rounded-xl p-4 flex items-start gap-3"
                  data-testid="orphan-order-banner">
                  <Mail className="w-5 h-5 text-amber-700 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-bold text-amber-900">No confirmation email has ever been sent for this order.</p>
                    <p className="text-xs text-amber-800 mt-0.5">
                      Click below to dispatch the customer confirmation + owner notification now.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleResendConfirmation}
                    disabled={resendingConfirmation}
                    className="text-xs inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-indigo-600 hover:bg-indigo-700 text-white font-bold disabled:opacity-50"
                    data-testid="orphan-resend-btn"
                  >
                    {resendingConfirmation ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
                    {resendingConfirmation ? 'Sending…' : 'Send confirmation now'}
                  </button>
                </div>
              )}

              {Array.isArray(order.email_log) && order.email_log.length > 0 && (
                <div className="border border-gray-200 rounded-xl p-4" data-testid="email-log-block">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
                      <Mail className="w-4 h-4 text-gray-400" /> Email log
                      <span className="text-[11px] text-gray-400 font-normal">({order.email_log.length} sent)</span>
                    </h3>
                    {order.payment_status === 'paid' && (
                      <button
                        type="button"
                        onClick={handleResendConfirmation}
                        disabled={resendingConfirmation}
                        className="text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-700 font-medium disabled:opacity-50"
                        title="Re-send the order confirmation to the customer AND owner"
                        data-testid="resend-confirmation-btn"
                      >
                        {resendingConfirmation ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
                        {resendingConfirmation ? 'Sending…' : 'Resend confirmation'}
                      </button>
                    )}
                  </div>
                  <ul className="space-y-2 text-[12px]" data-testid="email-log-list">
                    {order.email_log.slice().reverse().slice(0, 12).map((e, i) => {
                      const isCustom = e.type === 'custom';
                      return (
                        <li key={i} className="flex items-start gap-2 leading-snug" data-testid={`email-log-row-${i}`}>
                          <span className={`mt-1 inline-block h-2 w-2 rounded-full flex-shrink-0 ${e.ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-baseline gap-x-2">
                              <span
                                className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded ${
                                  isCustom
                                    ? 'bg-indigo-50 text-indigo-700 border border-indigo-100'
                                    : 'bg-gray-100 text-gray-600 border border-gray-200'
                                }`}
                              >
                                {isCustom ? 'Custom' : 'Status'}
                              </span>
                              <strong className="text-gray-900 capitalize">
                                {isCustom ? (e.subject || 'Custom email') : (e.status || 'update')}
                              </strong>
                              <span className="text-gray-400 text-[11px] ml-auto whitespace-nowrap">
                                {formatDate(e.sent_at)}
                              </span>
                            </div>
                            <div className="text-gray-500 truncate">
                              → {e.to}
                              {e.from_admin && (
                                <span className="ml-1 text-gray-400">(by {e.from_admin})</span>
                              )}
                            </div>
                            {!e.ok && e.error && (
                              <div className="text-rose-700 text-[11px] mt-0.5">⚠️ {e.error}</div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {order.email_log.length > 12 && (
                    <p className="text-[11px] text-gray-400 italic mt-2">
                      Showing 12 most recent of {order.email_log.length} emails.
                    </p>
                  )}
                </div>
              )}

              {/* Status history */}
              {Array.isArray(order.status_history) && order.status_history.length > 0 && (
                <div className="border border-gray-200 rounded-xl p-4">
                  <h3 className="text-sm font-semibold text-gray-900 mb-3">Status History</h3>
                  <ol className="space-y-2 text-sm">
                    {order.status_history.slice().reverse().map((h, i) => (
                      <li key={i} className="flex items-baseline gap-2">
                        <StatusPill status={h.status} />
                        <span className="text-xs text-gray-500">{formatDate(h.timestamp)}</span>
                        {h.updated_by && <span className="text-xs text-gray-400">— {h.updated_by}</span>}
                        {h.notes && <span className="text-xs text-gray-700 italic">"{h.notes}"</span>}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {/* Delete confirmation overlay — super-admin only */}
      {deleteOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
          onClick={() => !deleting && setDeleteOpen(false)}
          data-testid="delete-confirm-overlay"
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-rose-100 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-rose-600" />
              </div>
              <div>
                <h3 className="text-base font-bold text-gray-900">Delete order #{order?.order_number}?</h3>
                <p className="text-xs text-gray-500">This is permanent. A backup is kept for audit.</p>
              </div>
            </div>
            <div className="bg-rose-50 border border-rose-200 rounded-md p-3 text-xs text-rose-900 mb-4">
              ⚠️ Customer total: <strong>£{Number(order?.total ?? 0).toFixed(2)}</strong> · Payment: <strong>{order?.payment_status || '—'}</strong>. If this order has been paid, you should refund the customer in Stripe Dashboard <em>before</em> deleting.
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-gray-700 block mb-1">Confirm super-admin password *</label>
                <input
                  type="password"
                  autoFocus
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !deleting) handleDelete(); }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-rose-400"
                  placeholder="Your account password"
                  data-testid="delete-password-input"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-700 block mb-1">Reason (optional)</label>
                <input
                  type="text"
                  value={deleteReason}
                  onChange={(e) => setDeleteReason(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-rose-400"
                  placeholder="e.g. test order, duplicate, fraud, customer cancelled"
                  maxLength={300}
                  data-testid="delete-reason-input"
                />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-5">
              <Button onClick={() => setDeleteOpen(false)} variant="outline" disabled={deleting} data-testid="delete-cancel-btn">
                Cancel
              </Button>
              <Button
                onClick={handleDelete}
                disabled={deleting || !deletePassword.trim()}
                className="bg-rose-600 hover:bg-rose-700 text-white"
                data-testid="delete-confirm-btn"
              >
                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Delete order'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Notes-on-status-update prompt — opens when admin clicks "Update".
          Customer sees the note in their tracking page banner + email body. */}
      {notesPromptOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
          onClick={() => !savingStatus && setNotesPromptOpen(false)}
          data-testid="status-notes-overlay"
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center">
                <MessageSquare className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <h3 className="text-base font-bold text-gray-900">
                  Add a note for the customer?
                </h3>
                <p className="text-xs text-gray-500">
                  Status: <strong className="capitalize">{newStatus.replace(/_/g, ' ')}</strong> · This note appears on their Track Order page and in the email.
                </p>
              </div>
            </div>
            {/* Quick-reply dropdown — pre-fills the textarea so admins
                don't retype the same 5–10 messages every Friday. */}
            {quickReplies.length > 0 && (
              <div className="flex items-center gap-2 mb-2">
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) {
                      setStatusNote(e.target.value);
                      e.target.value = '';
                    }
                  }}
                  className="flex-1 text-xs border border-gray-300 rounded-md px-2 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
                  data-testid="status-quick-reply-select"
                >
                  <option value="">⚡ Pick a quick reply…</option>
                  {quickReplies.map((r, i) => (
                    <option key={i} value={r}>
                      {r.length > 60 ? r.slice(0, 60) + '…' : r}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    setRepliesDraft(quickReplies.join('\n'));
                    setEditRepliesOpen(true);
                  }}
                  className="text-xs text-gray-500 hover:text-gray-800 underline whitespace-nowrap"
                  data-testid="edit-quick-replies-btn"
                >
                  Edit list…
                </button>
              </div>
            )}
            <textarea
              autoFocus
              value={statusNote}
              onChange={(e) => setStatusNote(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 resize-none"
              placeholder={`e.g. "Your tiles are on the next van — should be with you Monday morning."`}
              maxLength={500}
              data-testid="status-notes-input"
            />
            <p className="text-[11px] text-gray-400 mt-1 text-right">
              {statusNote.length}/500
            </p>
            {/* Inline edit-list editor — one reply per line, saves to the
                curated `status_quick_replies` setting on website_settings. */}
            {editRepliesOpen && (
              <div className="mt-3 p-3 bg-gray-50 border border-gray-200 rounded-md">
                <p className="text-xs font-semibold text-gray-700 mb-1">
                  Edit quick replies (one per line, max 50)
                </p>
                <textarea
                  value={repliesDraft}
                  onChange={(e) => setRepliesDraft(e.target.value)}
                  rows={6}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-xs font-mono focus:outline-none focus:ring-2 focus:ring-emerald-400 resize-none"
                  data-testid="quick-replies-draft-textarea"
                />
                <div className="flex gap-2 justify-end mt-2">
                  <button
                    type="button"
                    onClick={() => setEditRepliesOpen(false)}
                    disabled={savingReplies}
                    className="text-xs px-3 py-1 rounded border border-gray-300 hover:bg-gray-100 text-gray-600"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveQuickReplies}
                    disabled={savingReplies}
                    className="text-xs px-3 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
                    data-testid="save-quick-replies-btn"
                  >
                    {savingReplies ? 'Saving…' : 'Save list'}
                  </button>
                </div>
              </div>
            )}
            <div className="flex gap-2 justify-end mt-4">
              <Button
                onClick={() => { setNotesPromptOpen(false); setStatusNote(''); handleStatusUpdate(''); }}
                variant="outline"
                disabled={savingStatus}
                data-testid="status-skip-notes-btn"
              >
                Skip — just update
              </Button>
              <Button
                onClick={() => handleStatusUpdate()}
                disabled={savingStatus}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                data-testid="status-update-with-notes-btn"
              >
                {savingStatus ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Update & send'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* One-off custom email composer — uses the same branded wrapper
          as status emails so the tone stays consistent. */}
      {customEmailOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
          onClick={() => !sendingCustomEmail && setCustomEmailOpen(false)}
          data-testid="custom-email-overlay"
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0">
                <Send className="w-5 h-5 text-emerald-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-base font-bold text-gray-900">
                  Send a custom email
                </h3>
                <p className="text-xs text-gray-500 truncate">
                  To: <span className="font-medium">{order?.customer_email}</span>
                </p>
              </div>
            </div>
            <label className="block text-xs font-semibold text-gray-700 mb-1">Subject</label>
            <input
              value={customEmailSubject}
              onChange={(e) => setCustomEmailSubject(e.target.value)}
              maxLength={120}
              placeholder={`Update on your order ${order?.order_number || ''}`}
              className="w-full mb-3 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400"
              data-testid="custom-email-subject"
            />
            <label className="block text-xs font-semibold text-gray-700 mb-1">Message</label>
            <textarea
              value={customEmailBody}
              onChange={(e) => setCustomEmailBody(e.target.value)}
              rows={7}
              maxLength={4000}
              placeholder={`Hi,\n\nQuick heads up — your delivery driver will call 30 minutes before arrival tomorrow morning.\n\nBest,\nTile Station Team`}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 resize-none"
              data-testid="custom-email-body"
            />
            <p className="text-[11px] text-gray-400 mt-1 text-right">
              {customEmailBody.length}/4000
            </p>
            <p className="text-[11px] text-gray-500 italic mt-2">
              Sent with the same branded wrapper as your order status emails. Customer can reply directly to your admin email.
            </p>
            <div className="flex gap-2 justify-end mt-4">
              <Button
                onClick={() => setCustomEmailOpen(false)}
                variant="outline"
                disabled={sendingCustomEmail}
                data-testid="custom-email-cancel-btn"
              >
                Cancel
              </Button>
              <Button
                onClick={sendCustomEmail}
                disabled={sendingCustomEmail || !customEmailBody.trim()}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                data-testid="custom-email-send-btn"
              >
                {sendingCustomEmail ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Send className="w-4 h-4 mr-1.5" /> Send email</>}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- List page ---------------- */

const PAGE_SIZE = 25;

export default function OnlineOrders() {
  const [orders, setOrders] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [activeOrderId, setActiveOrderId] = useState(null);
  const [stats, setStats] = useState(null);
  const [paymentFilter, setPaymentFilter] = useState('all');
  const [includeAbandoned, setIncludeAbandoned] = useState(false);

  const token = localStorage.getItem('token');
  const auth = { headers: { Authorization: `Bearer ${token}` } };
  const currentUser = (() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}'); }
    catch { return {}; }
  })();

  // Fetch "Today at a Glance" KPIs (refreshes whenever the list refreshes)
  const fetchStats = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/api/shop/admin/online-orders/stats`, auth);
      setStats(res.data);
    } catch {
      /* silent — KPIs are nice-to-have, not critical */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        skip: page * PAGE_SIZE,
        limit: PAGE_SIZE,
      };
      if (statusFilter !== 'all') params.status = statusFilter;
      if (paymentFilter !== 'all') params.payment_status = paymentFilter;
      if (includeAbandoned) params.include_abandoned = true;
      if (debouncedSearch) params.search = debouncedSearch;
      const res = await axios.get(`${API_URL}/api/shop/admin/online-orders`, { ...auth, params });
      setOrders(res.data.orders || []);
      setTotal(res.data.total || 0);
    } catch (err) {
      const detail = err?.response?.data?.detail || 'Failed to load orders';
      toast.error(detail);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, statusFilter, paymentFilter, includeAbandoned, debouncedSearch]);

  useEffect(() => { fetchList(); }, [fetchList]);

  // Reset to first page when filters change
  useEffect(() => { setPage(0); }, [statusFilter, paymentFilter, includeAbandoned, debouncedSearch]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="min-h-screen bg-gray-50" data-testid="online-orders-page">
      <div className="max-w-7xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div className="flex items-center gap-3">
            <Link to="/admin" className="text-gray-500 hover:text-gray-900 transition-colors" aria-label="Back to admin">
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Online Orders</h1>
              <p className="text-sm text-gray-500 mt-0.5">Website checkout orders ({total} total)</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={async () => {
                if (!window.confirm("Create or refresh the £1.50 'Order a Sample' product on this site?")) return;
                try {
                  const r = await axios.post(`${API_URL}/api/shop/admin/seed-sample-product`, {}, auth);
                  toast.success(`Sample product ${r.data?.action} — £${r.data?.price}`, {
                    description: `Visit ${r.data?.url} to test`,
                    duration: 8000,
                  });
                } catch (err) {
                  toast.error(err?.response?.data?.detail || 'Failed to seed sample product');
                }
              }}
              variant="outline"
              size="sm"
              data-testid="seed-sample-btn"
              title="Create the £1.50 sample test product (one-time)"
            >
              <Package className="w-4 h-4 mr-2" /> Seed sample
            </Button>
            <Button
              onClick={async () => {
                const to = window.prompt('Send a test email to:', currentUser?.email || '');
                if (!to || !to.trim()) return;
                try {
                  const r = await axios.post(`${API_URL}/api/shop/admin/test-email`, { to_email: to.trim() }, auth);
                  toast.success(`Test email sent to ${to}`, { description: `From: ${r.data?.sender}` });
                } catch (err) {
                  toast.error(err?.response?.data?.detail || 'Failed to send test email');
                }
              }}
              variant="outline"
              size="sm"
              data-testid="test-email-btn"
              title="Send a test email to verify Resend is working"
            >
              <Mail className="w-4 h-4 mr-2" /> Test email
            </Button>
            <Button onClick={() => { fetchList(); fetchStats(); }} variant="outline" size="sm" data-testid="refresh-btn">
              <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          </div>
        </div>

        {/* Today at a Glance — KPIs */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4" data-testid="today-at-a-glance">
          {[
            { id: 'orders_today',        label: 'Orders Today',          value: stats?.orders_today ?? '—',        accent: 'from-blue-500 to-indigo-600',     icon: Package },
            { id: 'revenue_today',       label: 'Revenue Today',         value: stats ? `£${Number(stats.revenue_today || 0).toFixed(2)}` : '—', accent: 'from-emerald-500 to-emerald-700', icon: Receipt },
            { id: 'pending',             label: 'Pending',               value: stats?.pending ?? '—',              accent: 'from-amber-500 to-orange-600',    icon: Clock },
            { id: 'awaiting_collection', label: 'Awaiting Collection',   value: stats?.awaiting_collection ?? '—', accent: 'from-cyan-500 to-blue-600',       icon: Store },
            { id: 'overdue',             label: 'Overdue (>2 days)',     value: stats?.overdue ?? '—',              accent: 'from-rose-500 to-rose-700',       icon: AlertCircle, alertWhen: (v) => Number(v) > 0 },
          ].map(card => {
            const Icon = card.icon;
            const isAlert = card.alertWhen ? card.alertWhen(card.value) : false;
            return (
              <div
                key={card.id}
                className={`relative overflow-hidden rounded-xl border ${isAlert ? 'border-rose-300 bg-gradient-to-br from-rose-50 to-white shadow-rose-200/40' : 'border-gray-200 bg-white'} shadow-sm p-4`}
                data-testid={`kpi-${card.id}`}
              >
                <div className={`absolute -top-6 -right-6 w-20 h-20 rounded-full bg-gradient-to-br ${card.accent} opacity-10`} />
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider font-medium text-gray-500 mb-1">
                  <Icon className="w-3.5 h-3.5" />
                  {card.label}
                </div>
                <div className={`text-2xl font-bold tabular-nums ${isAlert ? 'text-rose-700' : 'text-gray-900'}`}>{card.value}</div>
              </div>
            );
          })}
        </div>

        {/* Filters */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 mb-4 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by order #, name, email or trade account # (T-00042)…"
              className="pl-9"
              data-testid="orders-search"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
            data-testid="status-filter"
          >
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="confirmed">Confirmed</option>
            <option value="processing">Processing</option>
            <option value="ready_for_collection">Ready for Collection</option>
            <option value="shipped">Shipped</option>
            <option value="delivered">Delivered</option>
            <option value="collected">Collected</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select
            value={paymentFilter}
            onChange={(e) => setPaymentFilter(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-400"
            data-testid="payment-status-filter"
          >
            <option value="all">All payments</option>
            <option value="paid">Paid</option>
            <option value="initiated">Awaiting payment</option>
            <option value="failed">Payment failed</option>
            <option value="pending">Not started</option>
          </select>
          <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer select-none ml-auto" data-testid="abandoned-toggle">
            <input
              type="checkbox"
              checked={includeAbandoned}
              onChange={(e) => setIncludeAbandoned(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            <span>Show abandoned (&gt;30 min, no payment)</span>
          </label>
        </div>

        {/* Table */}
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : orders.length === 0 ? (
            <div className="text-center py-20 px-6">
              <Package className="w-12 h-12 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No online orders yet.</p>
              <p className="text-xs text-gray-400 mt-1">Orders placed via the website checkout will appear here.</p>
            </div>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200 text-gray-600">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Order #</th>
                    <th className="text-left px-4 py-3 font-medium">Customer</th>
                    <th className="text-left px-4 py-3 font-medium">Method</th>
                    <th className="text-left px-4 py-3 font-medium">Items</th>
                    <th className="text-right px-4 py-3 font-medium">Total</th>
                    <th className="text-left px-4 py-3 font-medium">Payment</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="text-left px-4 py-3 font-medium">Date</th>
                    <th className="text-right px-4 py-3 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr
                      key={o.id}
                      className="border-b last:border-b-0 border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors"
                      onClick={() => setActiveOrderId(o.id)}
                      data-testid={`order-row-${o.order_number}`}
                    >
                      <td className="px-4 py-3 font-medium text-gray-900">#{o.order_number || o.id?.slice(0, 8)}</td>
                      <td className="px-4 py-3 text-gray-700">
                        <div className="font-medium">{o.customer_name || '—'}</div>
                        <div className="text-xs text-gray-500 truncate max-w-[200px]">{o.customer_email || ''}</div>
                        {o.trade_account_number && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setSearch(o.trade_account_number); }}
                            className="inline-flex items-center gap-1 text-[10px] font-mono font-semibold mt-1 px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100 hover:border-amber-300 transition-colors"
                            title={`Click to filter — show every order placed by ${o.trade_business_name || o.trade_account_number}`}
                            data-testid={`order-trade-badge-${o.order_number}`}
                          >
                            #{o.trade_account_number}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-700">
                        <span className="inline-flex items-center gap-1 text-xs">
                          {o.delivery_method === 'collect' ? <Store className="w-3 h-3" /> : <Truck className="w-3 h-3" />}
                          {o.delivery_method === 'collect' ? 'Collect' : 'Delivery'}
                        </span>
                        {o.delivery_method === 'collect' && o.collect_store_name && (
                          <div
                            className="text-[10px] font-semibold text-indigo-700 mt-0.5 truncate max-w-[140px]"
                            title={`Click & Collect from ${o.collect_store_name}`}
                            data-testid={`collect-store-name-${o.order_number}`}
                          >
                            {o.collect_store_name}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-700 tabular-nums">{o.items_count}</td>
                      <td className="px-4 py-3 text-right text-gray-900 font-semibold tabular-nums">£{Number(o.total ?? 0).toFixed(2)}</td>
                      <td className="px-4 py-3"><PaymentPill status={o.payment_status} /></td>
                      <td className="px-4 py-3"><StatusPill status={o.status} /></td>
                      <td className="px-4 py-3 text-xs text-gray-500">{formatDate(o.created_at)}</td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => { e.stopPropagation(); setActiveOrderId(o.id); }}
                          data-testid={`view-order-${o.order_number}`}
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-sm text-gray-600">
                  <span>Page {page + 1} of {totalPages}</span>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))} data-testid="prev-page">
                      <ChevronLeft className="w-4 h-4 mr-1" /> Prev
                    </Button>
                    <Button variant="outline" size="sm" disabled={page + 1 >= totalPages} onClick={() => setPage(p => p + 1)} data-testid="next-page">
                      Next <ChevronRight className="w-4 h-4 ml-1" />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {activeOrderId && (
          <OrderDetailModal
            orderId={activeOrderId}
            onClose={() => setActiveOrderId(null)}
            onStatusChanged={() => { fetchList(); fetchStats(); }}
            onDeleted={() => { fetchList(); fetchStats(); }}
          />
        )}
      </div>
    </div>
  );
}
