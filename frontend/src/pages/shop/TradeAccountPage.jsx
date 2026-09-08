import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { 
  Building2, User, Mail, Phone, MapPin, LogOut, Package, 
  CreditCard, Award, TrendingUp, ChevronRight, Edit2, 
  Clock, FileText, Wallet, Gift, ShoppingBag, Settings,
  CheckCircle2, AlertCircle, Loader2, Download, Sparkles, X,
  RotateCw, ShoppingCart, Truck, RotateCcw, Activity
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { useCart } from '../../contexts/TileCartContext';
import { toast } from 'sonner';
import { normaliseImageUrl, safeToFixed, safeArr} from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const ICON_MAP = { Wallet, ShoppingBag, TrendingUp, Package, Gift, Award, Building2 };
const getIcon = (name) => ICON_MAP[name] || ShoppingBag;

const DEFAULT_TIERS = [
  { id: 'bronze', name: 'Bronze', discount: 1, min_spend: 0, color: '#B45309' },
  { id: 'silver', name: 'Silver', discount: 2, min_spend: 5000, color: '#9CA3AF' },
  { id: 'gold', name: 'Gold', discount: 3, min_spend: 15000, color: '#FBBF24' },
  { id: 'platinum', name: 'Platinum', discount: 5, min_spend: 50000, color: '#D1D5DB' },
];

const COLOR_MAP = {
  green: { bg: 'bg-green-100', text: 'text-green-600' },
  blue: { bg: 'bg-blue-100', text: 'text-blue-600' },
  purple: { bg: 'bg-purple-100', text: 'text-purple-600' },
  pink: { bg: 'bg-pink-100', text: 'text-pink-600' },
};

const TradeAccountPage = () => {
  const navigate = useNavigate();
  const { addToCart } = useCart();
  const [customer, setCustomer] = useState(null);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [settings, setSettings] = useState(null);
  const [savings, setSavings] = useState(null);
  // Per-order reorder loading state — keyed by order_id, value: 'loading' | undefined
  const [reorderingId, setReorderingId] = useState(null);
  // Activity stream for the dashboard timeline widget
  const [activity, setActivity] = useState({ events: [], loading: true });
  // Deep-link target — when the user clicks an activity row, we switch tabs
  // and briefly highlight the matching order/credit row by ref_id.
  const [highlightRef, setHighlightRef] = useState(null);
  // Detailed credit-history (online + in-store EPOS) for the Discount tab
  const [creditEvents, setCreditEvents] = useState({ events: [], loading: true });
  const [expandedEventId, setExpandedEventId] = useState(null);
  const [copiedEventId, setCopiedEventId] = useState(null);
  // Hide-voided-orders toggle — persists in localStorage so the trader's
  // preference survives page reloads. Default off: traders WANT to see
  // voided rows by default (audit trail) but can declutter after heavy
  // staff-side corrections.
  const [hideVoidedOrders, setHideVoidedOrders] = useState(() => {
    try {
      return localStorage.getItem('tile_trader_hide_voided_orders') === '1';
    } catch {
      return false;
    }
  });
  // Month filter on the Credit history list — values are ISO 'YYYY-MM' or
  // the empty string for "All". Driven entirely off the events array, no
  // extra API call. Resets cleanly when the events list refreshes.
  const [creditMonthFilter, setCreditMonthFilter] = useState('');

  useEffect(() => {
    fetchAccountData();
    fetchActivityStream();
    fetchCreditHistory();
    fetch(`${API_URL}/api/website-admin/public/trade-account-settings`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.settings && Object.keys(d.settings).length) setSettings(d.settings); })
      .catch(() => {});
  }, []);

  const fetchCreditHistory = async () => {
    const token = localStorage.getItem('tile_shop_token');
    if (!token) {
      setCreditEvents({ events: [], loading: false });
      return;
    }
    try {
      const res = await fetch(`${API_URL}/api/shop/trade/credit-history-detailed`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        setCreditEvents({ events: [], loading: false });
        return;
      }
      const data = await res.json();
      setCreditEvents({ events: data.events || [], loading: false });
    } catch {
      setCreditEvents({ events: [], loading: false });
    }
  };

  // Plain-text breakdown copy — same monospace format as the EPOS chip and
  // admin Sales Hub card so the trader's reply (when they paste it) reads
  // identically to the staff version.
  const copyEventBreakdown = async (ev) => {
    const breakdown = Array.isArray(ev?.breakdown) ? ev.breakdown : [];
    if (breakdown.length === 0) return;
    const header = `Credit-back breakdown — ${ev.source_label || 'Invoice'}`;
    const separator = '─'.repeat(Math.min(56, header.length + 2));
    const nameCol = 28;
    const calcCol = 18;
    const lines = breakdown.map((r) => {
      const name = (r.product_name || r.sku || 'Unnamed line').toString();
      const rate = Number(r.rate) || 0;
      const net = Number(r.net) || 0;
      const credit = Number(r.credit) || 0;
      const rateTxt = `${rate.toFixed(rate % 1 === 0 ? 0 : 1)}% × £${safeToFixed(net, 2)}`;
      const namePart =
        name.length > nameCol ? `${name.slice(0, nameCol - 1)}…` : name.padEnd(nameCol);
      return `${namePart}  ${rateTxt.padEnd(calcCol)} £${safeToFixed(credit, 2)}`;
    });
    const total = Number(ev.amount || 0).toFixed(2);
    const totalLine = `${'Total credit'.padEnd(nameCol)}  ${' '.padEnd(calcCol)} £${total}`;
    const plain = [header, separator, ...lines, separator, totalLine].join('\n');
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(plain);
      } else {
        const ta = document.createElement('textarea');
        ta.value = plain;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedEventId(ev.id);
      toast.success('Breakdown copied — ready to paste', { duration: 2200 });
      setTimeout(() => setCopiedEventId((cur) => (cur === ev.id ? null : cur)), 1800);
    } catch {
      toast.error('Could not copy — please try again');
    }
  };

  const fetchActivityStream = async () => {
    const token = localStorage.getItem('tile_shop_token');
    if (!token) { setActivity({ events: [], loading: false }); return; }
    try {
      const res = await fetch(`${API_URL}/api/shop/account/activity-stream?limit=10`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) { setActivity({ events: [], loading: false }); return; }
      const data = await res.json();
      setActivity({ events: data.events || [], loading: false });
    } catch {
      setActivity({ events: [], loading: false });
    }
  };

  // Deep-link an activity row → switches to the right tab, scrolls to the
  // matching record, and triggers a brief amber pulse on it.
  const handleActivityClick = (ev) => {
    if (!ev?.type) return;
    const isCredit = ev.type.startsWith('credit_');
    const isOrder = ev.type.startsWith('order_');
    const targetTab = isCredit ? 'credit' : isOrder ? 'orders' : null;
    if (!targetTab) return;
    setActiveTab(targetTab);
    setHighlightRef(ev.ref_id || null);
    // Wait for the tab to render, then scroll the highlighted row into view.
    setTimeout(() => {
      const el = document.querySelector(`[data-ref-id="${ev.ref_id}"]`);
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
    // Auto-clear the highlight after the pulse animation completes.
    setTimeout(() => setHighlightRef(null), 2400);
  };

  const tiers = settings?.tiers?.length > 0 ? settings.tiers : DEFAULT_TIERS;
  const tiersEnabled = settings?.tiers_enabled === true; // tiers are opt-in — discounts are set manually per trader
  const dashboard = settings?.dashboard || {};
  const stats = (dashboard.stats || []).filter(s => s.enabled !== false);
  const quickActions = (dashboard.quick_actions || []).filter(a => a.enabled !== false);
  const creditSteps = dashboard.credit_steps || [
    { title: 'Make a Purchase', description: 'Shop online or in any showroom — quote your trade reference at the till' },
    { title: 'Earn Credit Back', description: 'A percentage of every purchase comes back to you as trade credit' },
    { title: 'Use on Future Orders', description: 'Apply your credit balance at checkout or in store to save more' },
  ];
  // When tiers are globally disabled, the master switch wins over the
  // per-card dashboard sub-settings — hide the tier pill, progress bar
  // and any tier-related dashboard widgets entirely.
  const showTierCard = tiersEnabled && dashboard.show_tier_card !== false;
  const showProgressBar = tiersEnabled && dashboard.show_progress_bar !== false;
  const accountTypeLabel = dashboard.account_type_label || 'Proforma / Cash Account';

  // Same math as /api/shop/savings/summary, computed client-side for the
  // Orders list so every paid line gets a "− £X vs retail" chip beside the
  // total. Skipped for non-trade users or unpaid orders.
  const PAID_STATUSES = ['completed', 'paid', 'fulfilled', 'shipped', 'ready_for_collection', 'delivered'];
  const computeOrderSaving = (order) => {
    if (!savings?.is_trade) return 0;
    const td = savings.trade_discount || customer?.trade_discount || 0;
    if (td <= 0 || td >= 100) return 0;
    const status = (order?.status || '').toLowerCase();
    const payStatus = (order?.payment_status || '').toLowerCase();
    if (!PAID_STATUSES.includes(status) && !['paid', 'completed', 'succeeded'].includes(payStatus)) return 0;
    const subtotal = Number(order?.subtotal) || 0;
    if (subtotal <= 0) return 0;
    return Math.round(subtotal * 1.20 * (td / (100 - td)) * 100) / 100;
  };

  // CSV-safe escape: wrap in quotes if the field contains comma / quote / newline,
  // and double up any embedded quotes per RFC 4180.
  const csvCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const downloadSavingsStatement = () => {
    if (!orders || orders.length === 0) return;
    const td = savings?.trade_discount ?? customer?.trade_discount ?? 0;
    const headers = [
      'Order Number',
      'Date',
      'Status',
      'Subtotal (ex VAT)',
      'Total (inc VAT)',
      'Saved vs Retail',
      'Trade Rate %',
    ];
    const rows = orders.map((o) => {
      const dateStr = o.created_at ? new Date(o.created_at).toLocaleDateString('en-GB') : '';
      const subtotal = Number(o.subtotal) || 0;
      const saved = computeOrderSaving(o);
      return [
        o.order_number || (o.id ? o.id.slice(-8) : ''),
        dateStr,
        o.status || 'pending',
        subtotal.toFixed(2),
        (Number(o.total) || 0).toFixed(2),
        saved.toFixed(2),
        td,
      ].map(csvCell).join(',');
    });
    const totalSaved = orders.reduce((s, o) => s + computeOrderSaving(o), 0);
    const totalSubtotal = orders.reduce((s, o) => s + (Number(o.subtotal) || 0), 0);
    const totalIncVat = orders.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const totalRow = [
      'TOTAL',
      '',
      '',
      totalSubtotal.toFixed(2),
      totalIncVat.toFixed(2),
      totalSaved.toFixed(2),
      '',
    ].map(csvCell).join(',');
    const csv = [headers.map(csvCell).join(','), ...rows, totalRow].join('\r\n');
    // BOM so Excel renders £ symbols correctly
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' });
    const fname = `tilestation-savings-statement-${customer?.business_name?.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'trade'}-${new Date().toISOString().slice(0, 10)}.csv`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fname;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    toast.success(`Statement downloaded — ${orders.length} order${orders.length === 1 ? '' : 's'}, total saved £${totalSaved.toFixed(2)}`);
  };

  // Stream a per-order UK VAT invoice PDF from the backend. We use fetch
  // (not a plain <a href>) so we can carry the JWT bearer token and surface
  // a friendly toast on auth/server errors instead of a blank tab.
  const downloadOrderVatInvoice = async (order) => {
    if (!order?.id) return;
    const token = localStorage.getItem('tile_shop_token');
    if (!token) {
      toast.error('Please sign in to download invoices');
      return;
    }
    const tId = toast.loading('Generating VAT invoice…');
    try {
      const res = await fetch(`${API_URL}/api/shop/orders/${order.id}/vat-invoice.pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(detail || `Server returned ${res.status}`);
      }
      const blob = await res.blob();
      const orderNo = order.order_number || order.id.slice(-8);
      const fname = `VAT_Invoice_${orderNo}.pdf`;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = fname;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
      toast.success(`Downloaded VAT_Invoice_${orderNo}.pdf`, { id: tId });
    } catch (err) {
      toast.error(`Could not download invoice: ${err.message || err}`, { id: tId });
    }
  };

  // Build tier lookup from dynamic tiers
  const tierLookup = {};
  tiers.forEach((t, idx) => {
    const nextTier = idx < tiers.length - 1 ? tiers[idx + 1] : null;
    tierLookup[t.id || t.name.toLowerCase()] = {
      name: t.name, color: t.color, discount: t.discount,
      nextTier: nextTier ? (nextTier.id || nextTier.name.toLowerCase()) : null,
      nextSpend: nextTier ? nextTier.min_spend : null,
    };
  });

  const fetchAccountData = async () => {
    try {
      const token = localStorage.getItem('tile_shop_token');
      if (!token) {
        // No token — straight to trade login, no toast (clean unauthenticated path)
        navigate('/shop/trade/login?redirect=/shop/trade/account');
        return;
      }
      const [customerRes, ordersRes, savingsRes] = await Promise.all([
        fetch(`${API_URL}/api/shop/auth/me`, { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`${API_URL}/api/shop/orders`, { headers: { 'Authorization': `Bearer ${token}` } }),
        fetch(`${API_URL}/api/shop/savings/summary`, { headers: { 'Authorization': `Bearer ${token}` } }),
      ]);
      if (!customerRes.ok) {
        // Stale/invalid token — clear BOTH token and cached customer so the
        // header doesn't keep showing a phantom trade pill after redirect.
        const status = customerRes.status;
        let detail = '';
        try { const body = await customerRes.json(); detail = body.detail || ''; } catch {}
        console.error(`[TradeAccount] /auth/me failed: ${status} ${detail}`);
        localStorage.removeItem('tile_shop_token');
        localStorage.removeItem('tile_shop_customer');
        window.dispatchEvent(new Event('trade-auth-change'));
        toast.error(status === 401 ? 'Session expired — please sign in again' : 'Could not load your account, please sign in');
        navigate('/shop/trade/login?redirect=/shop/trade/account');
        return;
      }
      const customerData = await customerRes.json();
      setCustomer(customerData);
      // Refresh cached customer payload so header stays in sync with truth from server.
      try { localStorage.setItem('tile_shop_customer', JSON.stringify(customerData)); } catch {}
      window.dispatchEvent(new Event('trade-auth-change'));
      if (ordersRes.ok) { const ordersData = await ordersRes.json(); setOrders(ordersData.orders || ordersData || []); }
      if (savingsRes.ok) { setSavings(await savingsRes.json()); }
    } catch (error) {
      // Network error or unexpected exception — preserve token (probably transient)
      console.error('[TradeAccount] Network error:', error);
      toast.error('Network error — please try again');
    } finally { setLoading(false); }
  };

  const handleLogout = () => {
    localStorage.removeItem('tile_shop_token');
    localStorage.removeItem('tile_shop_customer');
    toast.success('Logged out successfully');
    navigate('/');
  };

  const [emailingStatement, setEmailingStatement] = useState(false);
  const [welcomeDismissed, setWelcomeDismissed] = useState(() => {
    try { return sessionStorage.getItem('trade_welcome_dismissed') === '1'; } catch { return false; }
  });

  const emailSavingsStatement = async () => {
    if (emailingStatement) return;
    const token = localStorage.getItem('tile_shop_token');
    if (!token) return;
    try {
      setEmailingStatement(true);
      const res = await fetch(`${API_URL}/api/shop/savings/email-statement`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // ALWAYS surface a useful message — never the silent fallback.
        // (21 May 2026 — user got generic "Could not email statement"
        // toast with no actionable info. Now we always show either the
        // backend's detail field or the HTTP status code.)
        const message = (
          data.detail
          || (res.status === 503 && 'Email service is temporarily unavailable — please use Download.')
          || (res.status === 502 && 'Our email provider is currently down — please use Download.')
          || (res.status === 401 && 'Please sign in again to email your statement.')
          || `Email failed (HTTP ${res.status}) — please use Download instead.`
        );
        toast.error(message);
        return;
      }
      toast.success(`Statement emailed to ${data.email}`);
    } catch (err) {
      toast.error(`Could not reach email service (${err?.message || 'network error'}) — please use Download instead`);
    } finally {
      setEmailingStatement(false);
    }
  };

  // One-click reorder: pulls fresh items via the backend (current price + stock)
  // then funnels them into the live cart context. Skips delisted/out-of-stock
  // items with a clear toast so the trade user never wonders why a SKU is missing.
  const handleReorder = async (orderId) => {
    const token = localStorage.getItem('tile_shop_token');
    if (!token || !orderId) return;
    setReorderingId(orderId);
    try {
      const res = await fetch(`${API_URL}/api/shop/orders/${orderId}/reorder-items`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || 'Could not load reorder items');
      }
      const data = await res.json();
      const items = data.items || [];
      let added = 0;
      let skipped = 0;
      for (const item of items) {
        if (!item.available) { skipped++; continue; }
        // addToCart toasts per-item — that's fine, gives clear feedback.
        addToCart(item, item.quantity || 1);
        added++;
      }
      if (added > 0) {
        toast.success(
          skipped > 0
            ? `Added ${added} item${added > 1 ? 's' : ''} — ${skipped} unavailable, skipped`
            : `Added ${added} item${added > 1 ? 's' : ''} to cart`,
          { action: { label: 'View cart', onClick: () => navigate('/shop/tile-cart') } }
        );
      } else if (skipped > 0) {
        toast.error('All items from that order are no longer available');
      } else {
        toast.error('No items to reorder');
      }
    } catch (e) {
      toast.error(e.message || 'Could not reorder items');
    } finally {
      setReorderingId(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <ShopHeader />
        <div className="container mx-auto px-4 py-16 flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
        </div>
        <ShopFooter />
      </div>
    );
  }

  if (!customer) return null;

  const tierKey = customer.trade_tier || 'bronze';
  const tier = tierLookup[tierKey] || tierLookup[Object.keys(tierLookup)[0]] || { name: 'Bronze', discount: 1, color: '#B45309', nextTier: null, nextSpend: null };
  const totalSpent = customer.total_spent || 0;
  const progressToNext = tier.nextSpend ? Math.min((totalSpent / tier.nextSpend) * 100, 100) : 100;

  const tabs = [
    { id: 'overview', label: 'Overview', icon: Building2 },
    { id: 'orders', label: 'Orders', icon: Package },
    { id: 'credit', label: 'Discount', icon: Gift },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  // Stat values from customer data
  const statValues = {
    credit: `£${(customer.credit_balance || 0).toFixed(2)}`,
    orders: orders.length.toString(),
    spent: `£${totalSpent.toLocaleString()}`,
  };
  const statSubtext = {
    credit: 'Available to use',
    orders: 'Lifetime orders',
    spent: 'This year',
  };

  const defaultStats = [
    { id: 'credit', label: 'Discount Balance', icon: 'Wallet', color: 'green' },
    { id: 'orders', label: 'Total Orders', icon: 'ShoppingBag', color: 'blue' },
    { id: 'spent', label: 'Total Spent', icon: 'TrendingUp', color: 'purple' },
  ];
  const displayStats = stats.length > 0 ? stats : defaultStats;

  const defaultActions = [
    { id: 'shop', title: 'Shop Products', description: 'Browse our trade catalogue', link: '/tiles', icon: 'ShoppingBag' },
    { id: 'samples', title: 'Order Samples', description: 'Request product samples', link: '/shop/sample-service', icon: 'Package' },
  ];
  const displayActions = quickActions.length > 0 ? quickActions : defaultActions;

  return (
    <div className="min-h-screen bg-gray-50">
      <ShopHeader />
      <div className="container mx-auto px-4 py-8">
        <nav className="text-sm text-gray-500 mb-6">
          <Link to="/" className="hover:text-[#F7EA1C]">Home</Link>
          <span className="mx-2">/</span>
          <span className="text-gray-900">Trade Account</span>
        </nav>

        <div className="grid lg:grid-cols-4 gap-6">
          {/* Sidebar */}
          <div className="lg:col-span-1">
            <div className="bg-white rounded-2xl shadow-sm p-6 sticky top-24">
              <div className="text-center mb-6 pb-6 border-b">
                <div className="w-16 h-16 bg-[#333333] rounded-full flex items-center justify-center mx-auto mb-3">
                  <Building2 className="w-8 h-8 text-[#F7EA1C]" />
                </div>
                <h2 className="font-bold text-gray-900">{customer.business_name || customer.name}</h2>
                <p className="text-sm text-gray-500">{customer.email}</p>
                {customer.trade_account_number && (
                  <p
                    className="inline-block mt-2 text-[11px] font-mono font-semibold tracking-wide bg-gray-100 text-gray-700 px-2 py-0.5 rounded select-all"
                    title="Your unique trade account reference — quote this when contacting us"
                    data-testid="trade-account-number"
                  >
                    Account #{customer.trade_account_number}
                  </p>
                )}
                {showTierCard && (
                <div className="inline-flex items-center gap-1 mt-2 px-3 py-1 rounded-full text-sm font-medium text-white" style={{ backgroundColor: tier.color }}>
                  <Award className="w-4 h-4" />
                  {tier.name} Trade
                </div>
                )}
              </div>
              <nav className="space-y-1">
                {tabs.map(tab => (
                  <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors ${activeTab === tab.id ? 'bg-[#333333] text-[#F7EA1C]' : 'text-gray-600 hover:bg-gray-100'}`}>
                    <tab.icon className="w-5 h-5" />{tab.label}
                  </button>
                ))}
              </nav>
              <button onClick={handleLogout} className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-red-600 hover:bg-red-50 mt-4">
                <LogOut className="w-5 h-5" />Sign Out
              </button>
            </div>
          </div>

          {/* Main Content */}
          <div className="lg:col-span-3">
            {activeTab === 'overview' && (
              <div className="space-y-6">
                {/* Welcome banner — once-per-session, surfaces what's new since last visit */}
                {!welcomeDismissed && (() => {
                  // Strip common UK business suffixes for a friendlier greeting
                  // ("Tile Station LTD" → "Tile Station"); falls back to first
                  // name from `customer.name` if no business name is set.
                  const greeting = (() => {
                    const biz = (customer.business_name || '').trim();
                    if (biz) {
                      return biz.replace(/[\s,]+(LTD|Ltd|Limited|Ltd\.|PLC|Plc|LLP|LLC|Inc\.|Inc)\.?\s*$/, '').trim() || biz;
                    }
                    return (customer.name || 'there').split(/\s+/)[0];
                  })();
                  const credit = Number(customer.credit_balance) || 0;
                  // "Active" = anything not yet delivered/completed/cancelled.
                  const PAID_STATUSES = ['completed', 'paid', 'fulfilled', 'shipped', 'ready_for_collection', 'delivered'];
                  const TERMINAL_STATUSES = ['delivered', 'completed', 'cancelled', 'refunded'];
                  const activeOrders = (orders || []).filter(o => {
                    const s = (o?.status || '').toLowerCase();
                    return s && !TERMINAL_STATUSES.includes(s);
                  });
                  const shipped = activeOrders.filter(o => ['shipped', 'in_transit', 'out_for_delivery'].includes((o?.status || '').toLowerCase()));
                  const tradeRate = customer.trade_discount || tier?.discount || 0;
                  const highlights = [];
                  if (credit > 0) highlights.push({
                    icon: Wallet,
                    color: 'bg-emerald-50 text-emerald-700 border-emerald-200',
                    iconColor: 'text-emerald-600',
                    label: `£${safeToFixed(credit, 2)} credit ready`,
                    sub: 'apply at checkout',
                  });
                  if (shipped.length > 0) highlights.push({
                    icon: Package,
                    color: 'bg-blue-50 text-blue-700 border-blue-200',
                    iconColor: 'text-blue-600',
                    label: `${shipped.length} order${shipped.length > 1 ? 's' : ''} on the way`,
                    sub: 'track in Orders tab',
                  });
                  if (activeOrders.length - shipped.length > 0) {
                    const inProgress = activeOrders.length - shipped.length;
                    highlights.push({
                      icon: Clock,
                      color: 'bg-amber-50 text-amber-700 border-amber-200',
                      iconColor: 'text-amber-600',
                      label: `${inProgress} order${inProgress > 1 ? 's' : ''} in progress`,
                      sub: 'being prepared',
                    });
                  }
                  // Trade discount % pill hidden 29-Apr-2026 per user
                  // request — re-enable when the tier programme launches.
                  // The discount itself is still auto-applied at checkout
                  // and visible in cart pricing, this just removes the
                  // "X% trade discount active" chip from the welcome banner.
                  // if (tradeRate > 0) highlights.push({
                  //   icon: Sparkles,
                  //   color: 'bg-purple-50 text-purple-700 border-purple-200',
                  //   iconColor: 'text-purple-600',
                  //   label: `${tradeRate}% trade discount active`,
                  //   sub: 'auto-applied at checkout',
                  // });

                  // Friendly never-empty placeholder for new traders with
                  // no balance + no orders yet. Renders ONLY when no other
                  // highlight has been pushed — established traders with
                  // credit/orders see their own data instead.
                  if (highlights.length === 0) highlights.push({
                    icon: Sparkles,
                    color: 'bg-[#F7EA1C]/10 text-[#1a1a1a] border-[#F7EA1C]/40',
                    iconColor: 'text-[#1a1a1a]',
                    label: 'Earn credit-back on every purchase',
                    sub: 'in store and online',
                  });
                  // Always show at least the perks chip — banner is never empty for a trade user.
                  const visibleHighlights = highlights.slice(0, 3);
                  if (visibleHighlights.length === 0) return null;
                  return (
                    <div
                      data-testid="trade-welcome-banner"
                      className="relative bg-gradient-to-br from-[#1a1a1a] to-[#2a2a2a] border border-[#F7EA1C]/20 rounded-2xl p-5 sm:p-6 overflow-hidden"
                    >
                      {/* subtle yellow accent stripes — matches trade login hero */}
                      <div className="absolute inset-0 opacity-[0.06] pointer-events-none" style={{
                        backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 35px, #F7EA1C 35px, #F7EA1C 70px)'
                      }} />
                      <button
                        type="button"
                        data-testid="trade-welcome-dismiss"
                        onClick={() => {
                          setWelcomeDismissed(true);
                          try { sessionStorage.setItem('trade_welcome_dismissed', '1'); } catch {}
                        }}
                        className="absolute top-3 right-3 text-gray-500 hover:text-white transition p-1 rounded"
                        aria-label="Dismiss welcome banner"
                      >
                        <X className="w-4 h-4" />
                      </button>
                      <div className="relative">
                        <div className="flex items-center gap-2 text-[#F7EA1C] text-xs font-semibold tracking-wider uppercase mb-1">
                          <Sparkles className="w-3.5 h-3.5" />
                          Welcome back
                        </div>
                        <h2 className="text-xl sm:text-2xl font-bold text-white mb-1">
                          Good to see you, {greeting}.
                        </h2>
                        <p className="text-gray-400 text-sm mb-4">
                          {visibleHighlights.length === 1
                            ? "Here's what's waiting for you today."
                            : `${visibleHighlights.length} things waiting for your attention.`}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {visibleHighlights.map((h, idx) => (
                            <div
                              key={idx}
                              data-testid={`welcome-highlight-${idx}`}
                              className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg border ${h.color}`}
                            >
                              <h.icon className={`w-4 h-4 ${h.iconColor} flex-shrink-0`} />
                              <div className="leading-tight">
                                <div className="text-xs font-semibold">{h.label}</div>
                                <div className="text-[10px] opacity-70">{h.sub}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Tier Status Card */}
                {showTierCard && (
                <div className="bg-gradient-to-br from-[#333333] to-[#444444] rounded-2xl p-6 text-white">
                  <div className="flex items-start justify-between mb-6">
                    <div>
                      <p className="text-gray-400 text-sm">Your Trade Tier</p>
                      <h2 className="text-3xl font-bold flex items-center gap-2">
                        <span className="w-4 h-4 rounded-full" style={{ backgroundColor: tier.color }} />
                        {tier.name}
                      </h2>
                    </div>
                    <div className="text-right">
                      <p className="text-gray-400 text-sm">Discount Rate</p>
                      <p className="text-3xl font-bold text-[#F7EA1C]">{tier.discount}%</p>
                    </div>
                  </div>
                  {showProgressBar && tier.nextTier && tierLookup[tier.nextTier] && (
                    <div>
                      <div className="flex justify-between text-sm mb-2">
                        <span>Progress to {tierLookup[tier.nextTier].name}</span>
                        <span>£{totalSpent.toLocaleString()} / £{tier.nextSpend.toLocaleString()}</span>
                      </div>
                      <div className="h-3 bg-gray-700 rounded-full overflow-hidden">
                        <div className="h-full bg-[#F7EA1C] rounded-full transition-all duration-500" style={{ width: `${progressToNext}%` }} />
                      </div>
                      <p className="text-gray-400 text-sm mt-2">
                        Spend £{(tier.nextSpend - totalSpent).toLocaleString()} more to reach {tierLookup[tier.nextTier].name}
                      </p>
                    </div>
                  )}
                </div>
                )}

                {/* Order Again — one-click rebuy of the last 3 paid orders */}
                {(() => {
                  const PAID = ['paid', 'completed', 'fulfilled', 'shipped', 'delivered', 'ready_for_collection'];
                  const reorderable = (orders || [])
                    .filter(o => {
                      const s = (o?.status || '').toLowerCase();
                      const ps = (o?.payment_status || '').toLowerCase();
                      return (PAID.includes(s) || PAID.includes(ps)) && (o.items || []).length > 0;
                    })
                    .slice(0, 3);
                  if (reorderable.length === 0) return null;
                  return (
                    <div data-testid="order-again-row" className="bg-white rounded-2xl shadow-sm p-5 sm:p-6">
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                          <RotateCw className="w-5 h-5 text-[#F7EA1C]" />
                          <div>
                            <h3 className="font-bold text-gray-900 text-base sm:text-lg leading-tight">Order again</h3>
                            <p className="text-xs text-gray-500">One-click reorder at today's prices — your trade discount applies automatically</p>
                          </div>
                        </div>
                        <Link to="#" onClick={(e) => { e.preventDefault(); setActiveTab('orders'); }} className="text-xs font-medium text-gray-500 hover:text-gray-900 inline-flex items-center gap-0.5">
                          All orders <ChevronRight className="w-3 h-3" />
                        </Link>
                      </div>
                      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {reorderable.map(order => {
                          const orderItems = order.items || [];
                          const visible = orderItems.slice(0, 3);
                          const extra = orderItems.length - visible.length;
                          const date = order.created_at ? new Date(order.created_at) : null;
                          const dateLabel = date ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
                          const isLoadingThis = reorderingId === order.id;
                          return (
                            <div
                              key={order.id}
                              data-testid={`reorder-card-${order.id}`}
                              className="border border-gray-200 rounded-xl p-3 hover:border-[#F7EA1C] hover:shadow-md transition flex flex-col"
                            >
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] font-mono text-gray-400 uppercase tracking-wider">{order.order_number || order.id.slice(0, 8)}</span>
                                <span className="text-[10px] text-gray-500">{dateLabel}</span>
                              </div>
                              <div className="flex -space-x-2 mb-2">
                                {visible.map((it, idx) => (
                                  <div key={idx} className="w-12 h-12 rounded-lg border-2 border-white bg-gray-100 overflow-hidden flex-shrink-0 ring-1 ring-gray-200">
                                    {it.image ? (
                                      <img src={normaliseImageUrl(it.image)} alt={it.name} className="w-full h-full object-cover" loading="lazy" />
                                    ) : (
                                      <div className="w-full h-full flex items-center justify-center text-gray-300">
                                        <Package className="w-5 h-5" />
                                      </div>
                                    )}
                                  </div>
                                ))}
                                {extra > 0 && (
                                  <div className="w-12 h-12 rounded-lg border-2 border-white bg-gray-700 text-white text-xs font-semibold flex items-center justify-center flex-shrink-0">
                                    +{extra}
                                  </div>
                                )}
                              </div>
                              <div className="text-xs text-gray-700 line-clamp-1 mb-1 font-medium">
                                {visible.map(i => i.name).filter(Boolean).join(', ') || 'Items'}
                              </div>
                              <div className="text-xs text-gray-500 mb-3">
                                {orderItems.length} item{orderItems.length === 1 ? '' : 's'} · originally £{(order.total || order.subtotal || 0).toFixed(2)}
                              </div>
                              <button
                                type="button"
                                data-testid={`reorder-btn-${order.id}`}
                                onClick={() => handleReorder(order.id)}
                                disabled={isLoadingThis}
                                className="mt-auto inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg transition bg-[#1a1a1a] hover:bg-[#333] text-[#F7EA1C] disabled:opacity-60 disabled:cursor-wait"
                              >
                                {isLoadingThis ? (
                                  <>
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    Adding...
                                  </>
                                ) : (
                                  <>
                                    <ShoppingCart className="w-3.5 h-3.5" />
                                    Reorder all
                                  </>
                                )}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* Activity Stream — compact glanceable timeline of recent
                    account events. Mines orders + status_history + trade_credits
                    server-side; renders newest-first with colour-coded icons. */}
                {(activity.loading || activity.events.length > 0) && (
                  <div data-testid="activity-stream" className="bg-white rounded-2xl shadow-sm p-5 sm:p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-2">
                        <Activity className="w-5 h-5 text-[#F7EA1C]" />
                        <div>
                          <h3 className="font-bold text-gray-900 text-base sm:text-lg leading-tight">Recent activity</h3>
                          <p className="text-xs text-gray-500">A timeline of what's been happening on your account</p>
                        </div>
                      </div>
                      {activity.events.length > 5 && (
                        <span className="text-[10px] font-mono text-gray-400 uppercase tracking-wider">
                          last {activity.events.length}
                        </span>
                      )}
                    </div>

                    {activity.loading ? (
                      <div className="py-8 flex justify-center">
                        <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                      </div>
                    ) : (() => {
                      const ICON_MAP = {
                        'shopping-bag': ShoppingBag, 'credit-card': CreditCard,
                        'package': Package, 'truck': Truck,
                        'check-circle': CheckCircle2, 'x': X,
                        'rotate-ccw': RotateCcw, 'wallet': Wallet,
                      };
                      const COLOR_MAP = {
                        amber: 'bg-amber-50 text-amber-600 ring-amber-200',
                        emerald: 'bg-emerald-50 text-emerald-600 ring-emerald-200',
                        blue: 'bg-blue-50 text-blue-600 ring-blue-200',
                        rose: 'bg-rose-50 text-rose-600 ring-rose-200',
                        purple: 'bg-purple-50 text-purple-600 ring-purple-200',
                      };
                      const formatRelative = (iso) => {
                        if (!iso) return '';
                        try {
                          const d = new Date(iso);
                          const diffMs = Date.now() - d.getTime();
                          const mins = Math.floor(diffMs / 60000);
                          if (mins < 1) return 'just now';
                          if (mins < 60) return `${mins}m ago`;
                          const hours = Math.floor(mins / 60);
                          if (hours < 24) return `${hours}h ago`;
                          const days = Math.floor(hours / 24);
                          if (days < 7) return `${days}d ago`;
                          return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
                        } catch { return ''; }
                      };
                      // Cap render to 10, with internal scroll if more
                      const visible = activity.events.slice(0, 10);
                      return (
                        <ol className="relative max-h-[420px] overflow-y-auto pr-1">
                          {visible.map((ev, idx) => {
                            const Icon = ICON_MAP[ev.icon] || Package;
                            const colorCls = COLOR_MAP[ev.color] || COLOR_MAP.amber;
                            const isLast = idx === visible.length - 1;
                            return (
                              <li
                                key={`${ev.type}-${ev.at}-${idx}`}
                                data-testid={`activity-event-${idx}`}
                                className="relative pl-10 pb-4"
                              >
                                {/* Vertical connector line */}
                                {!isLast && (
                                  <span className="absolute left-[15px] top-7 bottom-0 w-px bg-gray-200" aria-hidden="true" />
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleActivityClick(ev)}
                                  className="w-full text-left flex items-start justify-between gap-3 -mx-2 px-2 py-1 rounded-md hover:bg-gray-50 transition group"
                                >
                                  {/* Icon dot */}
                                  <span className={`absolute left-0 top-0.5 w-7 h-7 rounded-full ring-2 flex items-center justify-center ${colorCls}`}>
                                    <Icon className="w-3.5 h-3.5" />
                                  </span>
                                  <div className="min-w-0 flex-1 pl-8">
                                    <div className="text-sm font-semibold text-gray-900 leading-tight group-hover:text-[#1a1a1a]">{ev.title}</div>
                                    <div className="text-xs text-gray-500 mt-0.5 truncate">{ev.subtitle}</div>
                                  </div>
                                  <div className="flex items-center gap-1 mt-0.5 flex-shrink-0">
                                    <span className="text-[10px] text-gray-400 font-mono whitespace-nowrap">
                                      {formatRelative(ev.at)}
                                    </span>
                                    <ChevronRight className="w-3 h-3 text-gray-300 group-hover:text-gray-500 transition" />
                                  </div>
                                </button>
                              </li>
                            );
                          })}
                        </ol>
                      );
                    })()}
                  </div>
                )}

                {/* "Saved this year" — value reinforcement for trade customers.
                    Pulls the actual £ saved across paid/completed orders YTD vs
                    what a retail customer would have paid for the same items. */}
                {savings?.is_trade && savings.total_saved > 0 && (
                  <div
                    className="bg-gradient-to-br from-amber-50 via-yellow-50 to-amber-100 border border-amber-200 rounded-2xl p-5 sm:p-6 flex items-start gap-4"
                    data-testid="trade-savings-yearly-card"
                  >
                    <div className="w-12 h-12 rounded-xl bg-amber-500 text-white flex items-center justify-center shrink-0 shadow-sm">
                      <TrendingUp className="w-6 h-6" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs uppercase tracking-wider text-amber-700/80 font-semibold">Saved with us in {savings.year}</p>
                      <p className="text-3xl sm:text-4xl font-black text-amber-900 tabular-nums leading-none mt-1" data-testid="trade-savings-amount">
                        £{savings.total_saved.toFixed(2)}
                      </p>
                      <p className="text-sm text-amber-800 mt-1.5">
                        Across {savings.order_count} order{savings.order_count === 1 ? '' : 's'} — vs what a retail customer would have paid for the same items.
                      </p>
                      <p className="text-[11px] text-amber-700/70 mt-1">
                        Calculated using your current trade rate ({savings.trade_discount}% off RRP). Take this to your bookkeeper as a real margin gain on every job.
                      </p>
                    </div>
                  </div>
                )}

                {/* "Last order saved you £X" — concrete, recent, clickable receipt. */}
                {savings?.is_trade && savings.last_order && savings.last_order.saved > 0 && (
                  <button
                    type="button"
                    onClick={() => setActiveTab('orders')}
                    className="w-full bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center justify-between gap-3 text-left hover:border-amber-300 hover:bg-amber-50/40 transition-colors group"
                    data-testid="trade-savings-last-order-strip"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
                        <CheckCircle2 className="w-4 h-4" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm text-gray-700 leading-snug">
                          Your last order
                          {savings.last_order.created_at ? (
                            <> on <span className="font-semibold">{new Date(savings.last_order.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span></>
                          ) : null}
                          {' '}saved you{' '}
                          <span className="font-bold text-emerald-700 tabular-nums">£{safeToFixed(savings.last_order.saved, 2)}</span>
                          {' '}vs retail.
                        </p>
                        {savings.last_order.order_number && (
                          <p className="text-[11px] text-gray-500 mt-0.5">Order #{savings.last_order.order_number}</p>
                        )}
                      </div>
                    </div>
                    <span className="flex items-center gap-1 text-xs font-medium text-gray-600 group-hover:text-amber-700 shrink-0">
                      View receipt
                      <ChevronRight className="w-4 h-4" />
                    </span>
                  </button>
                )}

                {/* Stats Grid */}
                <div className="grid md:grid-cols-3 gap-4">
                  {displayStats.map(stat => {
                    const StatIcon = getIcon(stat.icon);
                    const colors = COLOR_MAP[stat.color] || COLOR_MAP.blue;
                    return (
                      <div key={stat.id} className="bg-white rounded-xl p-5 shadow-sm">
                        <div className="flex items-center gap-3 mb-2">
                          <div className={`w-10 h-10 ${colors.bg} rounded-lg flex items-center justify-center`}>
                            <StatIcon className={`w-5 h-5 ${colors.text}`} />
                          </div>
                          <span className="text-gray-500 text-sm">{stat.label}</span>
                        </div>
                        <p className="text-2xl font-bold text-gray-900">{statValues[stat.id] || '0'}</p>
                        <p className={`${colors.text} text-sm mt-1`}>{statSubtext[stat.id] || ''}</p>
                      </div>
                    );
                  })}
                </div>

                {/* Recent Orders */}
                <div className="bg-white rounded-xl shadow-sm p-6">
                  {(() => {
                    // Derive filtered list + voided count here so the
                    // header, toggle, and body all share one source of
                    // truth. Toggle only renders when the customer has
                    // at least one voided row to hide.
                    const voidedCount = orders.filter(
                      o => o.status === 'deleted' || o.status === 'cancelled'
                    ).length;
                    const visibleOrders = hideVoidedOrders
                      ? orders.filter(o => o.status !== 'deleted' && o.status !== 'cancelled')
                      : orders;
                    return (
                      <>
                        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
                          <h3 className="font-bold text-gray-900">Recent Orders</h3>
                          <div className="flex items-center gap-3">
                            {voidedCount > 0 && (
                              <label
                                className="inline-flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer select-none"
                                data-testid="hide-voided-orders-label"
                              >
                                <input
                                  type="checkbox"
                                  checked={hideVoidedOrders}
                                  onChange={(e) => {
                                    const next = e.target.checked;
                                    setHideVoidedOrders(next);
                                    try {
                                      localStorage.setItem(
                                        'tile_trader_hide_voided_orders',
                                        next ? '1' : '0'
                                      );
                                    } catch {
                                      /* storage unavailable, non-fatal */
                                    }
                                  }}
                                  className="w-3.5 h-3.5 accent-rose-600"
                                  data-testid="hide-voided-orders-toggle"
                                />
                                <span>
                                  Hide voided
                                  <span className="text-gray-400"> ({voidedCount})</span>
                                </span>
                              </label>
                            )}
                            <button
                              onClick={() => setActiveTab('orders')}
                              className="text-sm text-[#333333] hover:text-[#F7EA1C] flex items-center gap-1"
                            >
                              View All <ChevronRight className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                  {visibleOrders.length > 0 ? (
                    <div className="space-y-3">
                      {visibleOrders.slice(0, 3).map(order => {
                        const orderSaved = computeOrderSaving(order);
                        const isVoided = order.status === 'deleted' || order.status === 'cancelled';
                        const voidReason = order.void_reason || (isVoided ? 'This order was voided. Any trade credit has been refunded.' : null);
                        const deletedAt = order.deleted_at
                          ? new Date(order.deleted_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                          : null;
                        const tooltipText = isVoided
                          ? [
                              voidReason,
                              deletedAt ? `Voided on ${deletedAt}` : null,
                              order.deleted_by_name ? `By ${order.deleted_by_name}` : null,
                            ].filter(Boolean).join(' · ')
                          : '';
                        return (
                        <div
                          key={order.id}
                          className={`flex items-center justify-between p-3 rounded-lg transition ${
                            isVoided
                              ? 'bg-gray-100 border border-dashed border-gray-300 opacity-70'
                              : 'bg-gray-50'
                          }`}
                          title={tooltipText}
                          data-testid={`trader-recent-order-${order.id}`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                              isVoided ? 'bg-gray-200' : 'bg-gray-200'
                            }`}>
                              <Package className={`w-5 h-5 ${isVoided ? 'text-gray-400' : 'text-gray-500'}`} />
                            </div>
                            <div className="min-w-0">
                              <p className={`font-medium text-gray-900 ${isVoided ? 'line-through text-gray-500' : ''}`}>
                                Order #{order.order_number || order.id?.slice(-8)}
                              </p>
                              <p className="text-sm text-gray-500">{new Date(order.created_at).toLocaleDateString()}</p>
                              {isVoided && voidReason && (
                                <p className="text-[11px] text-rose-700 mt-0.5 italic">
                                  {voidReason}
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="text-right flex items-center gap-3 shrink-0">
                            <div>
                              <p className={`font-semibold ${isVoided ? 'text-gray-400 line-through' : 'text-gray-900'}`}>£{order.total?.toFixed(2)}</p>
                              {orderSaved > 0 && !isVoided && (
                                <span className="inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 tabular-nums mt-0.5">
                                  −£{orderSaved.toFixed(2)} saved
                                </span>
                              )}
                              <span className={`block text-xs px-2 py-1 rounded mt-1 ${
                                order.status === 'deleted'
                                  ? 'bg-rose-100 text-rose-700 font-semibold'
                                  : order.status === 'cancelled'
                                  ? 'bg-amber-100 text-amber-800 font-semibold'
                                  : order.status === 'completed' || order.status === 'delivered'
                                  ? 'bg-green-100 text-green-700'
                                  : order.status === 'processing'
                                  ? 'bg-blue-100 text-blue-700'
                                  : 'bg-gray-100 text-gray-600'
                              }`}>
                                {order.status === 'deleted' ? 'Deleted' : (order.status || 'Pending')}
                              </span>
                            </div>
                            {!isVoided && (
                              <button
                                type="button"
                                onClick={() => downloadOrderVatInvoice(order)}
                                className="p-2 rounded-md text-gray-600 hover:text-emerald-700 hover:bg-emerald-50 border border-transparent hover:border-emerald-200 transition-colors"
                                title="Download VAT Invoice (PDF)"
                                data-testid={`download-vat-invoice-btn-${order.id}`}
                              >
                                <FileText className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-center py-8 text-gray-500">
                      <Package className="w-12 h-12 mx-auto mb-3 opacity-50" />
                      <p>No orders yet</p>
                      <Link to="/tiles" className="text-[#333333] hover:text-[#F7EA1C] mt-2 inline-block">Browse Products</Link>
                    </div>
                  )}
                      </>
                    );
                  })()}
                </div>

                {/* Quick Actions */}
                <div className="grid md:grid-cols-2 gap-4">
                  {displayActions.map(action => {
                    const AIcon = getIcon(action.icon);
                    return (
                      <Link key={action.id} to={action.link} className="bg-white rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow flex items-center gap-4">
                        <div className="w-12 h-12 bg-[#F7EA1C] rounded-xl flex items-center justify-center">
                          <AIcon className="w-6 h-6 text-[#333333]" />
                        </div>
                        <div>
                          <h3 className="font-bold text-gray-900">{action.title}</h3>
                          <p className="text-sm text-gray-500">{action.description}</p>
                        </div>
                        <ChevronRight className="w-5 h-5 text-gray-400 ml-auto" />
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Orders Tab */}
            {activeTab === 'orders' && (
              <div className="bg-white rounded-2xl shadow-sm p-6">
                <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
                  <h2 className="text-xl font-bold text-gray-900">Order History</h2>
                  {savings?.is_trade && orders.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={downloadSavingsStatement}
                        data-testid="download-savings-statement-btn"
                        className="border-emerald-200 text-emerald-800 hover:bg-emerald-50 hover:text-emerald-900"
                      >
                        <Download className="w-4 h-4 mr-1.5" />
                        Download CSV
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={emailSavingsStatement}
                        disabled={emailingStatement}
                        data-testid="email-savings-statement-btn"
                        className="border-amber-200 text-amber-800 hover:bg-amber-50 hover:text-amber-900"
                      >
                        <Mail className="w-4 h-4 mr-1.5" />
                        {emailingStatement ? 'Sending…' : 'Email me this'}
                      </Button>
                    </div>
                  )}
                </div>
                {orders.length > 0 ? (
                  <div className="space-y-4">
                    {orders.map(order => {
                      const orderSaved = computeOrderSaving(order);
                      return (
                      <div
                        key={order.id}
                        data-ref-id={order.id}
                        data-testid={`order-row-${order.id}`}
                        className={`border rounded-xl p-4 transition-colors transition-shadow duration-300 ${
                          highlightRef === order.id
                            ? 'border-amber-400 shadow-[0_0_0_4px_rgba(247,234,28,0.25)] bg-amber-50/40'
                            : 'hover:border-[#F7EA1C]'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div>
                            <p className="font-bold text-gray-900">Order #{order.order_number || order.id?.slice(-8)}</p>
                            <p className="text-sm text-gray-500 mt-1"><Clock className="w-4 h-4 inline mr-1" />{new Date(order.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-xl font-bold text-gray-900">£{order.total?.toFixed(2)}</p>
                            {orderSaved > 0 && (
                              <span
                                className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full mt-1 bg-emerald-50 text-emerald-700 border border-emerald-200 tabular-nums"
                                data-testid={`order-saving-chip-${order.id}`}
                                title={`You saved this much vs the retail-customer price for the same items`}
                              >
                                −£{orderSaved.toFixed(2)} vs retail
                              </span>
                            )}
                            <span className={`inline-flex items-center gap-1 text-sm px-3 py-1 rounded-full mt-1 ml-1 ${order.status === 'completed' ? 'bg-green-100 text-green-700' : order.status === 'processing' ? 'bg-blue-100 text-blue-700' : order.status === 'shipped' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'}`}>
                              {order.status === 'completed' && <CheckCircle2 className="w-4 h-4" />}
                              {order.status?.charAt(0).toUpperCase() + order.status?.slice(1) || 'Pending'}
                            </span>
                          </div>
                        </div>
                        {order.items && (
                          <div className="mt-4 pt-4 border-t flex items-center justify-between gap-3 flex-wrap">
                            <p className="text-sm text-gray-500">{safeArr(order.items).length} item(s)</p>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => downloadOrderVatInvoice(order)}
                              className="text-xs h-8 border-gray-200 text-gray-700 hover:bg-emerald-50 hover:text-emerald-800 hover:border-emerald-200"
                              data-testid={`download-vat-invoice-full-${order.id}`}
                            >
                              <FileText className="w-3.5 h-3.5 mr-1.5" />
                              Download VAT Invoice
                            </Button>
                          </div>
                        )}

                        {/* Savings pill — same emerald strip as cart/email,
                            persisted on the order via savings_meta. Shown to
                            returning customers as a re-affirmation of value. */}
                        {order.savings_meta && (order.savings_meta.total_saved || 0) >= 0.01 && (
                          <div
                            data-testid={`order-savings-pill-${order.id}`}
                            className="mt-3 px-4 py-3 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-xl shadow-md flex items-center gap-3"
                          >
                            <Gift className="w-5 h-5 text-emerald-100 flex-shrink-0" />
                            <div className="min-w-0 flex-1">
                              <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-100">Savings on this order</div>
                              <div className="text-[13px] font-bold leading-tight">
                                Volume + Trade discounts saved you{' '}
                                <span className="tabular-nums">£{Number(order.savings_meta.total_saved).toFixed(2)}</span>
                              </div>
                              <div className="text-[11px] text-emerald-100 mt-0.5">
                                across {order.savings_meta.lines_with_savings || 0} line{(order.savings_meta.lines_with_savings || 0) === 1 ? '' : 's'} · {order.savings_meta.percent_off_retail || 0}% off retail
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-center py-12 text-gray-500">
                    <Package className="w-16 h-16 mx-auto mb-4 opacity-30" />
                    <p className="text-lg">No orders yet</p>
                    <p className="text-sm mt-1">Your order history will appear here</p>
                    <Link to="/tiles" className="inline-flex items-center gap-2 bg-[#333333] text-[#F7EA1C] px-6 py-3 rounded-lg mt-4 hover:bg-[#444444]">Start Shopping <ChevronRight className="w-4 h-4" /></Link>
                  </div>
                )}
              </div>
            )}

            {/* Credit/Discount Tab */}
            {activeTab === 'credit' && (
              <div className="space-y-6">
                <div
                  data-testid="credit-balance-card"
                  data-ref-id={highlightRef && highlightRef.startsWith('TS-') ? highlightRef : undefined}
                  className={`bg-gradient-to-br from-green-500 to-green-600 rounded-2xl p-6 text-white transition-shadow duration-300 ${
                    highlightRef && (highlightRef.startsWith('TS-') || activity.events.some(e => e.ref_id === highlightRef && e.type.startsWith('credit_')))
                      ? 'ring-4 ring-amber-300 ring-offset-2'
                      : ''
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-green-100">Available Discount Balance</p>
                      <p className="text-4xl font-bold mt-1">£{(customer.credit_balance || 0).toFixed(2)}</p>
                      <p className="text-green-100 text-sm mt-2">Use at checkout on your next order</p>
                    </div>
                    <div className="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center">
                      <Wallet className="w-8 h-8" />
                    </div>
                  </div>
                  {Number(customer.credit_balance || 0) > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        try {
                          sessionStorage.setItem('tile_use_trade_credit', '1');
                        } catch (e) { /* ignore quota */ }
                        navigate('/shop/tile-cart');
                      }}
                      className="mt-4 w-full bg-white text-green-700 font-semibold py-2.5 rounded-lg hover:bg-green-50 transition-colors flex items-center justify-center gap-2 shadow-sm"
                      data-testid="spend-credit-cta"
                    >
                      Spend my credit at checkout →
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => navigate('/shop/trade/credit-statement')}
                    className="mt-3 w-full bg-white/20 text-white border border-white/30 font-semibold py-2.5 rounded-lg hover:bg-white/30 transition-colors flex items-center justify-center gap-2"
                    data-testid="view-credit-statement-btn"
                  >
                    View full credit statement →
                  </button>
                </div>

                <div className="bg-white rounded-2xl shadow-sm p-6">
                  <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2">
                    <Gift className="w-5 h-5 text-[#F7EA1C]" />
                    {tiersEnabled ? 'How Discount Tiers Work' : 'How Trade Credit Works'}
                  </h3>
                  <div className="space-y-4">
                    {creditSteps.map((step, idx) => (
                      <div key={step.id || idx} className="flex gap-4">
                        <div className="w-8 h-8 bg-[#F7EA1C] rounded-full flex items-center justify-center font-bold text-[#333333] flex-shrink-0">{idx + 1}</div>
                        <div>
                          <p className="font-medium text-gray-900">{step.title}</p>
                          <p className="text-sm text-gray-500">{step.description}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Credit history with per-product breakdown — lets the
                    trader reconcile their balance themselves. Mines BOTH
                    the online order pipeline and EPOS in-store invoice
                    pipeline via /api/shop/trade/credit-history-detailed. */}
                <div
                  className="bg-white rounded-2xl shadow-sm p-6"
                  data-testid="credit-history-card"
                >
                  {(() => {
                    // Derive the month dropdown options from the actual
                    // events list — guarantees we never show an empty
                    // month and always include every month with activity.
                    const monthBuckets = new Map();
                    for (const e of creditEvents.events) {
                      if (!e?.at) continue;
                      const d = new Date(e.at);
                      if (Number.isNaN(d.getTime())) continue;
                      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                      if (!monthBuckets.has(key)) {
                        monthBuckets.set(
                          key,
                          d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
                        );
                      }
                    }
                    // Newest first
                    const monthOptions = Array.from(monthBuckets.entries()).sort((a, b) =>
                      b[0].localeCompare(a[0])
                    );
                    const filteredEvents = creditMonthFilter
                      ? creditEvents.events.filter((e) => {
                          if (!e?.at) return false;
                          const d = new Date(e.at);
                          if (Number.isNaN(d.getTime())) return false;
                          return (
                            `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` ===
                            creditMonthFilter
                          );
                        })
                      : creditEvents.events;
                    const filteredEarn = filteredEvents
                      .filter((e) => e.type === 'earn')
                      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
                    const filteredRedeem = filteredEvents
                      .filter((e) => e.type === 'redeem')
                      .reduce((sum, e) => sum + Math.abs(Number(e.amount) || 0), 0);
                    return (
                      <>
                        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                          <h3 className="font-bold text-gray-900 flex items-center gap-2">
                            <Activity className="w-5 h-5 text-[#F7EA1C]" />
                            Credit history
                          </h3>
                          {creditEvents.events.length > 0 && monthOptions.length > 1 && (
                            <select
                              value={creditMonthFilter}
                              onChange={(e) => {
                                setCreditMonthFilter(e.target.value);
                                setExpandedEventId(null);
                              }}
                              className="text-xs border border-gray-200 rounded-md px-2 py-1.5 bg-white hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-200"
                              data-testid="credit-history-month-filter"
                              aria-label="Filter credit history by month"
                            >
                              <option value="">📅 All months ({creditEvents.events.length})</option>
                              {monthOptions.map(([key, label]) => {
                                const count = creditEvents.events.filter((ev) => {
                                  if (!ev?.at) return false;
                                  const d = new Date(ev.at);
                                  if (Number.isNaN(d.getTime())) return false;
                                  return (
                                    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === key
                                  );
                                }).length;
                                return (
                                  <option key={key} value={key}>
                                    {label} ({count})
                                  </option>
                                );
                              })}
                            </select>
                          )}
                          {/* Download Full Statement — emits a single
                              PDF covering all credit activity for the
                              current year. Same endpoint regardless of
                              the in-app filter; the goal is reconciling
                              against the trader's own books. */}
                          {creditEvents.events.length > 0 && (
                            <a
                              href={`${API_URL}/api/shop/trade/credit-statement.pdf?year=${new Date().getFullYear()}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
                              data-testid="download-credit-statement"
                              title="Download a PDF statement of all credit activity for this year"
                            >
                              <Download className="w-3.5 h-3.5" />
                              Download Statement
                            </a>
                          )}
                        </div>

                        {creditMonthFilter && filteredEvents.length > 0 && (
                          <div
                            className="mb-3 px-3 py-2 rounded-md bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between gap-2 flex-wrap"
                            data-testid="credit-history-month-summary"
                          >
                            <span>
                              <strong>{filteredEvents.length}</strong>{' '}
                              {filteredEvents.length === 1 ? 'event' : 'events'} in{' '}
                              {monthBuckets.get(creditMonthFilter)}
                            </span>
                            <span className="tabular-nums">
                              <span className="text-emerald-700 font-semibold">+£{filteredEarn.toFixed(2)} earned</span>
                              {filteredRedeem > 0 && (
                                <>
                                  <span className="mx-2 text-emerald-300">·</span>
                                  <span className="text-rose-700 font-semibold">−£{filteredRedeem.toFixed(2)} redeemed</span>
                                </>
                              )}
                            </span>
                          </div>
                        )}

                        {creditEvents.loading ? (
                          <div className="flex items-center gap-2 text-sm text-gray-500 py-4">
                            <Loader2 className="w-4 h-4 animate-spin" /> Loading your credit history…
                          </div>
                        ) : creditEvents.events.length === 0 ? (
                          <p className="text-sm text-gray-500 py-4" data-testid="credit-history-empty">
                            No credit-back events yet. Every paid online order or in-store invoice will appear here with the per-product breakdown.
                          </p>
                        ) : filteredEvents.length === 0 ? (
                          <p className="text-sm text-gray-500 py-4" data-testid="credit-history-empty-month">
                            No credit events in {monthBuckets.get(creditMonthFilter)}.{' '}
                            <button
                              type="button"
                              className="text-emerald-700 underline font-semibold"
                              onClick={() => setCreditMonthFilter('')}
                              data-testid="credit-history-clear-filter"
                            >
                              Show all months
                            </button>
                          </p>
                        ) : (
                          <ul className="divide-y divide-gray-100">
                            {filteredEvents.map((ev) => {
                        const isEarn = ev.type === 'earn';
                        const isInStore = ev.channel === 'in_store';
                        const breakdown = Array.isArray(ev.breakdown) ? ev.breakdown : [];
                        const hasBreakdown = breakdown.length > 0;
                        const isExpanded = expandedEventId === ev.id;
                        const isCopied = copiedEventId === ev.id;
                        const dateTxt = ev.at
                          ? new Date(ev.at).toLocaleDateString('en-GB', {
                              day: '2-digit', month: 'short', year: 'numeric',
                            })
                          : '';
                        const amount = Math.abs(Number(ev.amount) || 0);
                        return (
                          <li
                            key={ev.id || `${ev.source_ref}-${ev.at}`}
                            className="py-3"
                            data-testid={`credit-history-event-${ev.id}`}
                          >
                            <div className="flex items-start justify-between gap-3 flex-wrap">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                                    isEarn
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : 'bg-rose-100 text-rose-800'
                                  }`}>
                                    {isEarn ? '+ Earned' : '− Redeemed'}
                                  </span>
                                  <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">
                                    {isInStore ? 'In-store' : 'Online'}
                                  </span>
                                  {/* Showroom badge — surfaces WHERE the
                                      credit was earned/redeemed (e.g.
                                      Tonbridge vs Sydenham). Helps the
                                      trader spot which store they
                                      shopped at. */}
                                  {isInStore && ev.showroom_name && (
                                    <span
                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold"
                                      title={`Recorded at ${ev.showroom_name}`}
                                    >
                                      🏪 {ev.showroom_name}
                                    </span>
                                  )}
                                  <span className="font-mono text-xs text-gray-700">
                                    {ev.source_label}
                                  </span>
                                </div>
                                <p className="text-xs text-gray-500 mt-0.5">{dateTxt}</p>
                              </div>
                              <div className="text-right shrink-0">
                                <p className={`font-bold tabular-nums ${
                                  isEarn ? 'text-emerald-700' : 'text-rose-700'
                                }`}>
                                  {isEarn ? '+' : '−'}£{amount.toFixed(2)}
                                </p>
                                {hasBreakdown && (
                                  <button
                                    type="button"
                                    onClick={() => setExpandedEventId(isExpanded ? null : ev.id)}
                                    className="mt-1 inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-700 hover:text-emerald-900 hover:underline"
                                    data-testid={`credit-history-toggle-${ev.id}`}
                                    aria-expanded={isExpanded}
                                  >
                                    {isExpanded ? 'Hide' : 'Show'} breakdown
                                    <ChevronRight className={`w-2.5 h-2.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                                  </button>
                                )}
                              </div>
                            </div>
                            {isExpanded && hasBreakdown && (
                              <div
                                className="mt-2 rounded-md border border-emerald-200 bg-emerald-50/40 overflow-hidden"
                                data-testid={`credit-history-breakdown-${ev.id}`}
                              >
                                <div className="flex items-center justify-between gap-2 px-3 py-2 bg-emerald-50 border-b border-emerald-100">
                                  <p className="text-[11px] font-bold uppercase tracking-wide text-emerald-800">
                                    Per-product breakdown
                                  </p>
                                  <button
                                    type="button"
                                    onClick={() => copyEventBreakdown(ev)}
                                    className={`inline-flex items-center gap-1 text-[10.5px] font-semibold px-2 py-1 rounded border transition-colors ${
                                      isCopied
                                        ? 'text-emerald-900 bg-emerald-100 border-emerald-300'
                                        : 'text-emerald-800 bg-white border-emerald-200 hover:bg-emerald-50'
                                    }`}
                                    data-testid={`credit-history-copy-${ev.id}`}
                                  >
                                    {isCopied ? <CheckCircle2 className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
                                    {isCopied ? 'Copied' : 'Copy'}
                                  </button>
                                </div>
                                <table className="w-full text-[12px]">
                                  <tbody>
                                    {breakdown.map((row, idx) => {
                                      const name = (row.product_name || row.sku || 'Unnamed line').toString();
                                      const truncated = name.length > 44 ? `${name.slice(0, 42)}…` : name;
                                      const rate = Number(row.rate) || 0;
                                      const net = Number(row.net) || 0;
                                      const credit = Number(row.credit) || 0;
                                      return (
                                        <tr
                                          key={`${row.sku || row.product_id || idx}-${idx}`}
                                          className="border-b border-emerald-50 last:border-b-0 bg-white"
                                          data-testid={`credit-history-breakdown-row-${ev.id}-${idx}`}
                                        >
                                          <td className="px-3 py-1.5 text-gray-900" title={name}>{truncated}</td>
                                          <td className="px-3 py-1.5 text-gray-600 tabular-nums whitespace-nowrap text-right">
                                            {rate.toFixed(rate % 1 === 0 ? 0 : 1)}% × £{safeToFixed(net, 2)}
                                          </td>
                                          <td className="px-3 py-1.5 text-right font-semibold text-emerald-800 tabular-nums whitespace-nowrap">
                                            £{safeToFixed(credit, 2)}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                    <tr className="bg-emerald-50">
                                      <td className="px-3 py-1.5 font-bold text-emerald-900" colSpan={2}>
                                        Total credit
                                      </td>
                                      <td className="px-3 py-1.5 text-right font-bold text-emerald-900 tabular-nums">
                                        £{amount.toFixed(2)}
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </li>
                        );
                            })}
                          </ul>
                        )}
                      </>
                    );
                  })()}
                </div>

                {tiersEnabled && (
                  <div className="bg-white rounded-2xl shadow-sm p-6">
                    <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2">
                      <Award className="w-5 h-5 text-[#F7EA1C]" />
                      Discount Tiers
                    </h3>
                    <div className="space-y-3">
                      {tiers.map(t => {
                        const isCurrent = (t.id || t.name.toLowerCase()) === tierKey;
                        return (
                          <div key={t.id || t.name} className={`flex items-center justify-between p-4 rounded-xl border-2 ${isCurrent ? 'border-[#F7EA1C] bg-[#F7EA1C]/5' : 'border-gray-100'}`}>
                            <div className="flex items-center gap-3">
                              <div className="w-4 h-4 rounded-full" style={{ backgroundColor: t.color }} />
                              <span className="font-medium">{t.name}</span>
                              {isCurrent && <span className="text-xs bg-[#333333] text-[#F7EA1C] px-2 py-1 rounded">Current</span>}
                            </div>
                            <div className="text-right">
                              <span className="font-bold text-lg">{t.discount}%</span>
                              <span className="text-gray-500 text-sm ml-1">discount</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Settings Tab */}
            {activeTab === 'settings' && (
              <div className="space-y-6">
                <div className="bg-white rounded-2xl shadow-sm p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-bold text-gray-900">Business Information</h3>
                    <Button variant="outline" size="sm"><Edit2 className="w-4 h-4 mr-1" /> Edit</Button>
                  </div>
                  <div className="grid md:grid-cols-2 gap-4">
                    <div><p className="text-sm text-gray-500">Business Name</p><p className="font-medium">{customer.business_name || customer.name}</p></div>
                    <div><p className="text-sm text-gray-500">VAT Number</p><p className="font-medium">{customer.vat_number || 'Not provided'}</p></div>
                    <div><p className="text-sm text-gray-500">Trade Type</p><p className="font-medium">{customer.trade_type || 'Trade Customer'}</p></div>
                    <div><p className="text-sm text-gray-500">Account Type</p><p className="font-medium">{accountTypeLabel}</p></div>
                  </div>
                </div>
                <div className="bg-white rounded-2xl shadow-sm p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-bold text-gray-900">Contact Information</h3>
                    <Button variant="outline" size="sm"><Edit2 className="w-4 h-4 mr-1" /> Edit</Button>
                  </div>
                  <div className="grid md:grid-cols-2 gap-4">
                    <div className="flex items-center gap-3"><Mail className="w-5 h-5 text-gray-400" /><div><p className="text-sm text-gray-500">Email</p><p className="font-medium">{customer.email}</p></div></div>
                    <div className="flex items-center gap-3"><Phone className="w-5 h-5 text-gray-400" /><div><p className="text-sm text-gray-500">Phone</p><p className="font-medium">{customer.phone || 'Not provided'}</p></div></div>
                  </div>
                </div>
                <div className="bg-white rounded-2xl shadow-sm p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-bold text-gray-900">Business Address</h3>
                    <Button variant="outline" size="sm"><Edit2 className="w-4 h-4 mr-1" /> Edit</Button>
                  </div>
                  <div className="flex items-start gap-3">
                    <MapPin className="w-5 h-5 text-gray-400 mt-0.5" />
                    <div>
                      {customer.address ? (
                        <>{customer.address.line1 && <p>{customer.address.line1}</p>}{customer.address.line2 && <p>{customer.address.line2}</p>}<p>{customer.address.city}, {customer.address.postcode}</p></>
                      ) : <p className="text-gray-500">No address saved</p>}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <ShopFooter />
    </div>
  );
};

export default TradeAccountPage;
