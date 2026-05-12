/**
 * Admin · Stripe Reconcile
 * ────────────────────────
 * Built in response to the 2 May 2026 silent-failure incident where
 * Zoe Ward paid £2.99 for samples, Stripe captured the money, but
 * because the customer never reached the /tile-sample-success page
 * (and the webhook configuration was off) the order stayed at
 * status='pending' forever — no email, no Telegram alert, no dispatch.
 *
 * This page:
 *   1. Auto-runs an immediate Stripe re-query for every pending order
 *      with a session_id (one-click "Scan now" button)
 *   2. Lists every remaining orphan with the customer's name, email,
 *      delivery address (joined from `abandoned_sample_baskets`), and
 *      Stripe payment ID
 *   3. Per-row buttons: ✅ Mark as fulfilled (with tracking) | 💷 Refund
 *      | 🔄 Re-check on Stripe
 *
 * The daily cron in routes/stripe_reconcile.py runs the same scan at
 * 08:00 UTC and emails the admin with anything still pending.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
  AlertTriangle, RefreshCw, CheckCircle2, PoundSterling, Search,
  Package, Mail, Phone, MapPin, ExternalLink, Truck, Ban, Loader2,
  ShieldAlert,
} from 'lucide-react';

const API = process.env.REACT_APP_BACKEND_URL;
const tokenHdr = () => {
  const t = localStorage.getItem('token') || localStorage.getItem('access_token') || '';
  return t ? { Authorization: `Bearer ${t}` } : {};
};
const fmtMoney = (n) => `£${(Number(n) || 0).toFixed(2)}`;
const fmtDateTime = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
};
const fmtAddress = (a) => {
  if (!a) return '';
  return [a.line1, a.line2, a.city, a.postcode, a.country]
    .filter(Boolean).join(', ');
};

export default function StripeReconcile() {
  const [daysBack, setDaysBack] = useState(60);
  const [orphans, setOrphans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState(null);
  const [busyRow, setBusyRow] = useState(null);
  const [search, setSearch] = useState('');

  const fetchOrphans = useCallback(async () => {
    setLoading(true);
    try {
      const r = await axios.get(
        `${API}/api/admin/stripe-reconcile/orphans?days_back=${daysBack}`,
        { headers: tokenHdr() }
      );
      setOrphans(r.data.orphans || []);
    } catch (e) {
      toast.error(`Failed to load: ${e?.response?.data?.detail || e.message}`);
    } finally { setLoading(false); }
  }, [daysBack]);

  useEffect(() => { fetchOrphans(); }, [fetchOrphans]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return orphans;
    return orphans.filter(o =>
      (o.customer_email || '').toLowerCase().includes(q) ||
      (o.customer_name || '').toLowerCase().includes(q) ||
      (o.order_number || '').toLowerCase().includes(q) ||
      (o.stripe_session_id || '').toLowerCase().includes(q)
    );
  }, [orphans, search]);

  const runScan = async () => {
    if (!window.confirm(`Auto-recover every pending order from the last ${daysBack} days that Stripe says is paid? (Sends a "sorry, samples on the way" email to each.)`)) return;
    setScanning(true);
    try {
      const r = await axios.post(
        `${API}/api/admin/stripe-reconcile/scan?days_back=${daysBack}`,
        {}, { headers: tokenHdr() }
      );
      setLastScan(r.data);
      toast.success(`Scan complete · ${r.data.recovered} recovered · ${r.data.still_pending} still pending`);
      fetchOrphans();
    } catch (e) {
      toast.error(`Scan failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setScanning(false); }
  };

  const recoverOne = async (row) => {
    setBusyRow(row.order_id);
    try {
      const r = await axios.post(
        `${API}/api/admin/stripe-reconcile/recover-one`,
        { session_id: row.stripe_session_id },
        { headers: tokenHdr() }
      );
      if (r.data.recovered) {
        toast.success(`Recovered ${row.customer_email} — ${fmtMoney(r.data.amount_paid)} flipped to paid + email sent`);
        fetchOrphans();
      } else {
        toast.info(`No action — ${r.data.reason || 'Stripe says not paid yet'}`);
      }
    } catch (e) {
      toast.error(`Recover failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setBusyRow(null); }
  };

  const refund = async (row) => {
    if (!window.confirm(`Refund ${fmtMoney(row.amount)} to ${row.customer_email}?\n\nThis is irreversible.`)) return;
    setBusyRow(row.order_id);
    try {
      const r = await axios.post(
        `${API}/api/admin/stripe-reconcile/refund`,
        { session_id: row.stripe_session_id, payment_intent_id: row.stripe_payment_intent_id, reason: 'requested_by_customer' },
        { headers: tokenHdr() }
      );
      toast.success(`Refunded ${fmtMoney(r.data.amount)} · status ${r.data.status}`);
      fetchOrphans();
    } catch (e) {
      toast.error(`Refund failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setBusyRow(null); }
  };

  const markFulfilled = async (row) => {
    const tracking = window.prompt(`Mark ${row.customer_email}'s order as shipped.\n\nTracking number (optional):`, '');
    if (tracking === null) return;  // cancelled
    setBusyRow(row.order_id);
    try {
      await axios.post(
        `${API}/api/admin/stripe-reconcile/mark-fulfilled`,
        { order_id: row.order_id, tracking_number: tracking || null },
        { headers: tokenHdr() }
      );
      toast.success('Marked as shipped');
      fetchOrphans();
    } catch (e) {
      toast.error(`Failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setBusyRow(null); }
  };

  const totalOrphanValue = orphans.reduce((s, o) => s + (Number(o.amount) || 0), 0);

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6" data-testid="stripe-reconcile-page">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShieldAlert className="w-6 h-6 text-red-500" /> Stripe Reconciliation
          </h1>
          <p className="text-sm text-gray-500 mt-1 max-w-2xl">
            Customers who paid via Stripe but whose order never reached "paid" status —
            usually because they closed the browser tab after paying. One-click recovery from here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={365}
            value={daysBack}
            onChange={(e) => setDaysBack(Number(e.target.value) || 60)}
            className="w-20"
            data-testid="days-back-input"
          />
          <span className="text-sm text-gray-500">days back</span>
          <Button variant="outline" onClick={fetchOrphans} disabled={loading} data-testid="refresh-btn">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* SUMMARY CARDS */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4 border-l-4 border-red-500">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 text-red-500" /> Orphan orders
          </div>
          <div className="text-3xl font-bold mt-2 tabular-nums" data-testid="orphan-count">
            {loading ? '…' : orphans.length}
          </div>
          <div className="text-xs text-gray-500">paid by customer, missed by us</div>
        </Card>
        <Card className="p-4 border-l-4 border-amber-500">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
            <PoundSterling className="w-3.5 h-3.5 text-amber-500" /> Total value at risk
          </div>
          <div className="text-3xl font-bold mt-2 tabular-nums">
            {loading ? '…' : fmtMoney(totalOrphanValue)}
          </div>
          <div className="text-xs text-gray-500">held in Stripe, no fulfilment</div>
        </Card>
        <Card className="p-4 border-l-4 border-emerald-500">
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" /> Last scan
          </div>
          <div className="text-base font-semibold mt-2" data-testid="last-scan-summary">
            {lastScan ? `${lastScan.recovered} recovered · ${lastScan.still_pending} pending` : 'Not run yet'}
          </div>
          <Button
            size="sm"
            onClick={runScan}
            disabled={scanning || orphans.length === 0}
            className="mt-2 w-full bg-emerald-600 hover:bg-emerald-700 text-white"
            data-testid="scan-btn"
          >
            {scanning ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <RefreshCw className="w-4 h-4 mr-1" />}
            Auto-recover all
          </Button>
        </Card>
      </div>

      {/* SEARCH */}
      <Card className="p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by email, name, order number, Stripe session id…"
            className="pl-9"
            data-testid="search-input"
          />
        </div>
      </Card>

      {/* ORPHAN LIST */}
      {loading ? (
        <Card className="p-12 text-center text-gray-500">Loading orphan orders…</Card>
      ) : filtered.length === 0 ? (
        <Card className="p-12 text-center">
          <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
          <h2 className="text-lg font-semibold mb-1">
            {orphans.length === 0 ? 'No orphan orders 🎉' : 'No matches'}
          </h2>
          <p className="text-sm text-gray-500">
            {orphans.length === 0
              ? `Every order in the last ${daysBack} days that Stripe says was paid is matched to a fulfilled order in your DB.`
              : 'Adjust your search to widen the filter.'}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((row) => (
            <Card key={row.order_id} className="p-4" data-testid={`orphan-row-${row.order_id}`}>
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 items-start">
                <div className="lg:col-span-4">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full uppercase tracking-wide ${
                      row.kind === 'sample' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                    }`}>
                      {row.kind}
                    </span>
                    <span className="text-xs text-gray-500 font-mono">{row.order_number || row.order_id}</span>
                  </div>
                  <div className="font-semibold text-sm flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 text-gray-400" />
                    {row.customer_email || <span className="text-red-500">no email</span>}
                  </div>
                  {row.customer_name && (
                    <div className="text-xs text-gray-700 mt-1">{row.customer_name}</div>
                  )}
                  {row.customer_phone && (
                    <div className="text-xs text-gray-600 mt-1 flex items-center gap-1.5">
                      <Phone className="w-3 h-3" /> {row.customer_phone}
                    </div>
                  )}
                </div>

                <div className="lg:col-span-4 min-w-0">
                  <div className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-1 flex items-center gap-1.5">
                    <MapPin className="w-3 h-3" /> Delivery address
                  </div>
                  <div className="text-xs text-gray-700 leading-snug">
                    {fmtAddress(row.delivery_address) || (
                      <span className="text-red-500 italic">Not captured — email customer to ask</span>
                    )}
                  </div>
                  <div className="mt-2 text-[11px] text-gray-400 space-y-0.5">
                    <div>Created: {fmtDateTime(row.created_at)}</div>
                    {row.stripe_session_id && <div className="font-mono break-all">{row.stripe_session_id}</div>}
                  </div>
                </div>

                <div className="lg:col-span-2 text-right">
                  <div className="text-xs font-bold text-gray-500 uppercase tracking-wide">Amount</div>
                  <div className="text-2xl font-bold tabular-nums text-emerald-700">{fmtMoney(row.amount)}</div>
                  {row.items?.length > 0 && (
                    <div className="text-xs text-gray-500 mt-1 flex items-center gap-1 justify-end">
                      <Package className="w-3 h-3" /> {row.items.length} items
                    </div>
                  )}
                </div>

                <div className="lg:col-span-2 flex flex-col gap-1.5">
                  <Button
                    size="sm"
                    onClick={() => recoverOne(row)}
                    disabled={busyRow === row.order_id || !row.stripe_session_id}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white w-full"
                    data-testid={`recover-${row.order_id}`}
                  >
                    <CheckCircle2 className="w-3 h-3 mr-1" /> Recover
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => markFulfilled(row)}
                    disabled={busyRow === row.order_id}
                    className="w-full"
                    data-testid={`fulfill-${row.order_id}`}
                  >
                    <Truck className="w-3 h-3 mr-1" /> Mark shipped
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => refund(row)}
                    disabled={busyRow === row.order_id}
                    className="w-full border-red-300 text-red-600 hover:bg-red-50"
                    data-testid={`refund-${row.order_id}`}
                  >
                    <Ban className="w-3 h-3 mr-1" /> Refund
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* HOW IT WORKS */}
      <Card className="p-5 bg-amber-50 border-amber-200">
        <h2 className="text-sm font-bold flex items-center gap-2 text-amber-900 mb-2">
          <AlertTriangle className="w-4 h-4" /> How this works
        </h2>
        <ul className="text-xs text-amber-800 space-y-1 list-disc pl-5">
          <li><strong>Recover</strong> — re-queries Stripe for the session ID; if Stripe says paid, flips the order to "paid", emails the customer, fires admin Telegram alert.</li>
          <li><strong>Mark shipped</strong> — for orders you've already packed; stores tracking number.</li>
          <li><strong>Refund</strong> — immediately refunds the full amount via Stripe API. Irreversible.</li>
          <li><strong>Daily cron</strong> runs the auto-recovery scan at 08:00 UTC and emails you a digest of anything still pending.</li>
          <li><strong>Address</strong> shown is joined from <code>abandoned_sample_baskets</code> — the frontend captures it before payment. If it says "Not captured", the customer abandoned mid-flow and you'll need to email them.</li>
        </ul>
      </Card>
    </div>
  );
}
