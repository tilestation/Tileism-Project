import React, { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { 
  ShoppingBag, Truck, MapPin, CreditCard, ChevronRight, CheckCircle2,
  Minus, Plus, Trash2, ArrowLeft, Lock, Clock, Package, AlertCircle, Loader2, Zap, Sparkles, Wallet
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { toast } from 'sonner';
import { formatCartQuantity, snapCartQuantity, getCartStepSize } from '../../utils/cartDisplay';
import { getEffectivePrice, getRetailIncVat, getActiveTierDiscount } from '../../utils/cartPricing';
import { useTradeUser } from '../../hooks/useTradeUser';
import PaymentMethodCards from '../../components/shop/PaymentMethodCards';
import useAbandonedCartTracker from '../../hooks/useAbandonedCartTracker';
import CheckoutMaintenanceWarning from '../../components/shop/CheckoutMaintenanceWarning';
import { useCheckoutMaintenanceCountdown } from '../../contexts/MaintenanceContext';
import { normaliseImageUrl, safeToFixed} from '../../utils/safeStr';
import axios from 'axios';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// 16 May 2026 — Pull the human-readable error detail out of an axios
// error. Sentry's fetch interception used to swallow the response body
// before our code parsed it, which is the whole reason we migrated off
// fetch. With axios the body sits on `err.response.data` reliably.
const extractAxiosErrorDetail = (err, fallback = 'Request failed') => {
  const status = err?.response?.status;
  const data = err?.response?.data;
  if (data && typeof data === 'object') {
    return data.detail || data.message || data.error || fallback;
  }
  if (typeof data === 'string' && data.trim()) {
    // Server returned plain text / HTML — strip tags so toast stays short.
    return data.replace(/<[^>]+>/g, '').trim().slice(0, 200) || fallback;
  }
  if (status) return `${fallback} (HTTP ${status})`;
  return err?.message || fallback;
};

const DEFAULT_SETTINGS = {
  delivery: { enabled: true, free_threshold: 499, default_fee: 49.99, label: 'Home Delivery', description: 'Delivered within 3-5 working days', zones: [], congestion_charge: { enabled: true, amount: 18.00, label: 'Congestion Charge (Central London)' }, express: { enabled: true, extra_fee: 25.00, label: 'Express Delivery', description: '2-3 working days', standard_label: 'Standard Delivery', standard_description: '5-7 working days' } },
  collection: { enabled: true, label: 'Click & Collect', description: 'FREE - Collect from our store', ready_time: 'Ready within 24 hours', stores: [{ id: '1', name: 'Tile Station - Tonbridge', address: 'Unit 5, Cannon Lane, Tonbridge TN9 1PP', active: true }] },
  time_slots: [],
  text: { step1_title: 'Your Details', step2_title: 'Delivery Method', step3_title: 'Payment', secure_message: 'Your payment information is encrypted and secure.', order_notes_placeholder: 'Special instructions for delivery...', success_message: 'Thank you! Your order has been placed.' },
  min_order: 0,
  free_sample: {
    enabled: false,
    threshold: 100,
    label: 'Add a FREE sample',
    fulfillment_mode: 'separate_parcel',
    direct_ship_suppliers: [],
    unlocked_text_pack: "🎁 You've unlocked a FREE sample — add your sample choice in the order notes below.",
    unlocked_text_separate: "🎁 FREE sample unlocked — we'll post it to you separately by Royal Mail. Add your sample choice in the order notes below.",
  },
  payments: {
    klarna_enabled: false,
    paypal_enabled: false,
    wallet_express_enabled: false,
  },
};

const TileCheckoutPage = () => {
  const navigate = useNavigate();
  const maintCountdown = useCheckoutMaintenanceCountdown();
  const [step, setStep] = useState(1);
  const [cartItems, setCartItems] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [placing, setPlacing] = useState(false);
  const [orderComplete, setOrderComplete] = useState(false);

  // Form state
  const [details, setDetails] = useState({
    email: '', firstName: '', lastName: '', phone: '',
  });
  const [delivery, setDelivery] = useState({
    method: 'delivery', // 'delivery' or 'collect'
    speed: 'standard', // 'standard' or 'express'
    address1: '', address2: '', city: '', county: '', postcode: '',
    notes: '', timeSlot: '',
  });
  const [payment, setPayment] = useState({
    method: 'card',
  });
  // Selected payment method on Step 3 cards (drives Pay button label + Stripe session)
  // Values: 'card' | 'paypal' | 'klarna' | 'wallet'
  const [selectedMethod, setSelectedMethod] = useState('card');
  // Billing address — by default same as delivery. Toggled off to expose separate fields.
  // Sent to backend on place-order so invoices/receipts use the correct billing address.
  const [billing, setBilling] = useState({
    same_as_delivery: true,
    company: '',
    firstName: '',
    lastName: '',
    address1: '',
    address2: '',
    city: '',
    county: '',
    postcode: '',
  });

  // Abandoned-cart promo code state
  const [promoInput, setPromoInput] = useState('');
  const [promoApplied, setPromoApplied] = useState(null); // { code, percent_off, discount_amount }
  const [promoError, setPromoError] = useState('');
  const [promoChecking, setPromoChecking] = useState(false);

  // Trade-credit redemption — when the trader clicked "Spend my credit" on
  // their dashboard, we auto-apply their full balance (capped at order total)
  // here on the checkout page. They can remove it at any time.
  const [tradeCreditEnabled, setTradeCreditEnabled] = useState(false);
  const [tradeCreditBalance, setTradeCreditBalance] = useState(0);

  // Auto-fill the code from ?promo=... when the customer clicks the day-1 email CTA.
  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('promo');
    if (code) setPromoInput(code.toUpperCase());

    // Trade-credit (or shop refund/loyalty credit) auto-apply — sessionStorage
    // flag set by either the trade dashboard CTA or the shop dashboard pill.
    // We deliberately do NOT clear the flag here — React 18 strict-mode
    // double-mounts in dev, which would otherwise wipe the flag on the first
    // run and the second mount would re-init `tradeCreditEnabled` to false.
    // The flag is cleared on successful order placement OR when the user
    // clicks "remove" on the credit row.
    try {
      const flag = sessionStorage.getItem('tile_use_trade_credit');
      if (flag === '1') {
        const raw = localStorage.getItem('tile_shop_customer');
        if (raw) {
          const cust = JSON.parse(raw);
          const balance = Number(cust?.credit_balance || 0);
          // Allow both trade customers AND regular shoppers with refund/loyalty
          // credit to auto-apply at checkout. The redeem endpoint enforces the
          // same relaxed rule server-side.
          if (balance > 0 && localStorage.getItem('tile_shop_token')) {
            setTradeCreditEnabled(true);
            setTradeCreditBalance(balance);
          }
        }
      }
    } catch (e) { /* ignore */ }
  }, []);

  useEffect(() => {
    // Load cart from localStorage
    const stored = localStorage.getItem('tilestation_cart');
    if (stored) {
      try { setCartItems(JSON.parse(stored)); } catch (e) { /* ignore */ }
    }
    // Fetch checkout settings
    axios.get(`${API_URL}/api/website-admin/public/checkout-settings`)
      .then(res => res.data)
      .then(d => {
        if (d?.settings && Object.keys(d.settings).length) {
          setSettings(prev => ({
            ...prev,
            delivery: { ...prev.delivery, ...(d.settings.delivery || {}) },
            collection: { ...prev.collection, ...(d.settings.collection || {}) },
            time_slots: d.settings.time_slots || prev.time_slots,
            text: { ...prev.text, ...(d.settings.text || {}) },
            min_order: d.settings.min_order ?? prev.min_order,
            free_sample: { ...prev.free_sample, ...(d.settings.free_sample || {}) },
            payments: { ...(prev.payments || {}), ...(d.settings.payments || {}) },
          }));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const { isTrade, tradeDiscount } = useTradeUser();
  const subtotal = useMemo(() => cartItems.reduce(
    (sum, item) => sum + getEffectivePrice(item, isTrade, tradeDiscount) * (item.quantity || 0),
    0
  ), [cartItems, isTrade, tradeDiscount]);

  // Item-level delivery rules — mandatory charges + parcel flags per cart item
  const [deliveryFlags, setDeliveryFlags] = useState({});
  useEffect(() => {
    const ids = [...new Set(cartItems.map(i => String(i.id || i.product_id || '')).filter(Boolean))];
    if (ids.length === 0) { setDeliveryFlags({}); return; }
    axios.post(`${API_URL}/api/shop/delivery-flags`, { ids })
      .then(res => setDeliveryFlags(res.data?.flags || {}))
      .catch(() => {});
  }, [cartItems]);

  // Mandatory item delivery charge: highest single charge among marked items,
  // waived ONLY when the non-marked items alone cross the free-delivery threshold.
  // Parcel-only orders: the parcel rate replaces the pallet delivery fee.
  const { itemDeliveryCharge, parcelOnly, parcelFee, markedItemIds } = useMemo(() => {
    const items = cartItems || [];
    const marked = [];
    const fees = [];
    const ids = new Set();
    let eligible = 0;
    let parcelAll = items.length > 0;
    items.forEach(item => {
      const key = String(item.id || item.product_id || '');
      const f = deliveryFlags[key] || {};
      const line = getEffectivePrice(item, isTrade, tradeDiscount) * (item.quantity || 0);
      if (f.delivery_charge_required && Number(f.delivery_charge) > 0) {
        marked.push(Number(f.delivery_charge));
        ids.add(key);
      } else {
        eligible += line;
      }
      if (f.parcel_delivery) {
        if (Number(f.parcel_fee) > 0) fees.push(Number(f.parcel_fee));
      } else {
        parcelAll = false;
      }
    });
    const threshold = settings.delivery.free_threshold || 499;
    const charge = (delivery.method === 'delivery' && marked.length > 0 && eligible < threshold)
      ? Math.max(...marked)
      : 0;
    return {
      itemDeliveryCharge: charge,
      parcelOnly: parcelAll && marked.length === 0,
      parcelFee: fees.length ? Math.max(...fees) : null,
      markedItemIds: ids,
    };
  }, [cartItems, deliveryFlags, isTrade, tradeDiscount, settings.delivery, delivery.method]);

  // Calculate delivery fee and congestion charge based on postcode zone
  const { deliveryFee, congestionCharge, matchedZone } = useMemo(() => {
    if (delivery.method === 'collect') return { deliveryFee: 0, congestionCharge: 0, matchedZone: null };
    if (step < 2 || !delivery.postcode) return { deliveryFee: null, congestionCharge: 0, matchedZone: null };

    const pc = delivery.postcode.toUpperCase().replace(/\s/g, '');
    const zones = settings.delivery.zones || [];
    let fee = settings.delivery.default_fee;
    let zone = null;

    for (const z of zones) {
      const prefixes = z.postcodes.split(',').map(p => p.trim().toUpperCase()).filter(Boolean);
      if (prefixes.some(prefix => pc.startsWith(prefix))) {
        fee = z.fee;
        zone = z;
        break;
      }
    }

    // Parcel-only order — the courier parcel rate replaces the pallet delivery fee
    if (parcelOnly && parcelFee !== null && subtotal < settings.delivery.free_threshold) {
      fee = parcelFee;
    }

    // Free delivery for orders over threshold
    if (subtotal >= settings.delivery.free_threshold) fee = 0;

    // Congestion charge applies even on free delivery — but only to palletised
    // deliveries; parcel-only orders go by courier and are exempt
    const cc = settings.delivery.congestion_charge || {};
    const ccAmount = (zone?.is_congestion_zone && cc.enabled && !parcelOnly) ? (cc.amount || 0) : 0;

    return { deliveryFee: fee, congestionCharge: ccAmount, matchedZone: zone };
  }, [delivery.method, delivery.postcode, step, subtotal, settings.delivery, parcelOnly, parcelFee]);

  // Express delivery surcharge
  const expressSettings = settings.delivery.express || {};
  const expressFee = (delivery.method === 'delivery' && delivery.speed === 'express' && expressSettings.enabled) ? (expressSettings.extra_fee || 0) : 0;

  const promoDiscount = promoApplied ? Number(promoApplied.discount_amount || 0) : 0;
  // Pre-credit total is what the order will be saved at; trade credit then
  // deducts atomically from balance via /trade/credits/redeem before /pay.
  const totalBeforeCredit = Math.max(0, subtotal + (deliveryFee || 0) + congestionCharge + expressFee + itemDeliveryCharge - promoDiscount);
  const tradeCreditApplied = tradeCreditEnabled
    ? Math.round(Math.min(tradeCreditBalance, totalBeforeCredit) * 100) / 100
    : 0;
  const total = Math.max(0, totalBeforeCredit - tradeCreditApplied);
  if (typeof window !== 'undefined') {
    window.__tradeCreditDebug = { tradeCreditEnabled, tradeCreditBalance, totalBeforeCredit, tradeCreditApplied, total };
  }

  // Track abandoned cart whenever the shopper has typed an email AND has items in cart.
  useAbandonedCartTracker({
    email: details.email,
    name: `${details.firstName || ''} ${details.lastName || ''}`.trim(),
    phone: details.phone,
    items: cartItems,
    total: subtotal,
  });

  const applyPromoCode = async () => {
    const code = (promoInput || '').trim().toUpperCase();
    if (!code) return;
    setPromoChecking(true);
    setPromoError('');
    try {
      const res = await axios.post(`${API_URL}/api/shop/discount-codes/validate`, {
        code, email: details.email || '', subtotal,
      });
      const data = res.data;
      if (data?.valid) {
        setPromoApplied({
          code: data.code,
          percent_off: data.percent_off,
          discount_amount: data.discount_amount,
        });
        toast.success(`${data.percent_off}% off applied — saves £${Number(data.discount_amount).toFixed(2)}`);
      } else {
        setPromoApplied(null);
        setPromoError(data?.reason || 'Invalid code');
      }
    } catch (e) {
      // Axios throws on 4xx — the discount-codes endpoint returns
      // `{valid: false, reason: "..."}` in the body on bad codes, so
      // surface that detail when present.
      const data = e?.response?.data;
      if (data && typeof data === 'object' && data.reason) {
        setPromoApplied(null);
        setPromoError(data.reason);
      } else {
        setPromoError('Could not check code. Try again.');
      }
    } finally {
      setPromoChecking(false);
    }
  };

  const removePromoCode = () => {
    setPromoApplied(null);
    setPromoInput('');
    setPromoError('');
  };

  const updateQuantity = (idx, direction) => {
    // direction: -1 (minus) or +1 (plus) — translate to box-sized step for tiles
    const updated = [...cartItems];
    const item = updated[idx];
    const step = getCartStepSize(item);
    const proposed = (Number(item.quantity) || step) + (direction * step);
    updated[idx].quantity = snapCartQuantity(item, proposed);
    setCartItems(updated);
    localStorage.setItem('tilestation_cart', JSON.stringify(updated));
  };

  const removeItem = (idx) => {
    const updated = cartItems.filter((_, i) => i !== idx);
    setCartItems(updated);
    localStorage.setItem('tilestation_cart', JSON.stringify(updated));
  };

  const validateStep1 = () => {
    if (!details.email || !details.firstName || !details.lastName) {
      toast.error('Please fill in all required fields');
      return false;
    }
    if (!/\S+@\S+\.\S+/.test(details.email)) {
      toast.error('Please enter a valid email address');
      return false;
    }
    return true;
  };

  const validateStep2 = () => {
    if (delivery.method === 'delivery') {
      if (!delivery.address1 || !delivery.city || !delivery.postcode) {
        toast.error('Please fill in your delivery address');
        return false;
      }
    }
    if (!billing.same_as_delivery) {
      if (!billing.address1 || !billing.city || !billing.postcode) {
        toast.error('Please fill in your billing address');
        return false;
      }
    }
    return true;
  };

  const handlePlaceOrder = async () => {
    setPlacing(true);
    try {
      // Compute the canonical billing address — when the shopper ticks "same as delivery"
      // we mirror the delivery address into billing so the backend always has a record.
      const billingPayload = billing.same_as_delivery
        ? {
            same_as_delivery: true,
            firstName: details.firstName,
            lastName: details.lastName,
            company: '',
            address1: delivery.address1,
            address2: delivery.address2,
            city: delivery.city,
            county: delivery.county,
            postcode: delivery.postcode,
          }
        : { ...billing };

      // Step 1: Create the order
      // Compute savings_meta — same maths as the cart strips. Persisted on the
      // order so the email + invoice PDF render the same "You saved £X" line.
      const savingsLines = [];
      let totalRetailIncVat = 0;
      let totalSaved = 0;
      for (const item of cartItems) {
        const qty = Number(item.quantity) || 0;
        if (qty <= 0) continue;
        const retail = getRetailIncVat(item, tradeDiscount);
        const tierPct = getActiveTierDiscount(item);
        const tradePct = isTrade ? (Number(item.trade_discount || tradeDiscount) || 0) : 0;
        const retailLine = retail * qty;
        totalRetailIncVat += retailLine;
        if (tierPct === 0 && tradePct === 0) continue;
        const afterTier = retailLine * (1 - tierPct / 100);
        const afterTrade = afterTier * (1 - tradePct / 100);
        const saved = retailLine - afterTrade;
        if (saved < 0.01) continue;
        totalSaved += saved;
        savingsLines.push({
          product_id: item.id,
          name: item.display_name || item.name || '',
          tier_pct: tierPct,
          tier_saved: Math.round((retailLine - afterTier) * 100) / 100,
          trade_pct: tradePct,
          trade_saved: Math.round((afterTier - afterTrade) * 100) / 100,
          line_saved: Math.round(saved * 100) / 100,
        });
      }
      const savings_meta = totalSaved >= 0.01 ? {
        total_saved: Math.round(totalSaved * 100) / 100,
        retail_subtotal: Math.round(totalRetailIncVat * 100) / 100,
        percent_off_retail: totalRetailIncVat > 0 ? Math.round((totalSaved / totalRetailIncVat) * 100) : 0,
        lines_with_savings: savingsLines.length,
        is_trade: !!isTrade,
        breakdown: savingsLines,
      } : null;

      const orderData = {
        items: cartItems.map(item => ({
          product_id: item.id,
          // Cart context stores `display_name` (human-readable) — fall back through
          // sensible options so the admin Online Orders page never shows raw IDs.
          name: item.display_name || item.name || item.slug || 'Unknown product',
          variant: item.variant,
          // Effective price = retail × (1 − volume tier %) × (1 − trade %); for
          // trade users it's already ex-VAT. Backend recomputes subtotal from
          // these values, so sending the discounted price keeps the order in
          // sync with what the customer sees in the cart.
          price: getEffectivePrice(item, isTrade, tradeDiscount),
          quantity: item.quantity, image: item.image,
        })),
        customer: details,
        delivery: { ...delivery, fee: deliveryFee || 0, express_fee: expressFee },
        billing: billingPayload,
        payment: payment,
        promo_code: promoApplied?.code || null,
        subtotal, delivery_fee: deliveryFee || 0, express_fee: expressFee, total,
        savings_meta,
      };
      let orderResult;
      try {
        const orderRes = await axios.post(`${API_URL}/api/shop/guest-checkout`, orderData, {
          headers: { 'Content-Type': 'application/json' },
        });
        orderResult = orderRes.data;
      } catch (err) {
        // Distinguish network errors (no response) from server errors
        // (4xx/5xx) so the toast wording matches what actually went wrong.
        if (!err?.response) {
          console.error('[checkout] Network error during order creation:', err);
          toast.error('Cannot reach our server. Check your internet connection and try again.');
          return;
        }
        const detail = extractAxiosErrorDetail(err, 'Failed to place order');
        console.error('[checkout] Order creation failed:', err.response.status, detail);
        toast.error(detail);
        return;
      }

      // Step 1.5: Apply trade credit (if enabled). Atomic deduction from
      // shop_customers.credit_balance + ledger entry + order.total update.
      // If this fails for any reason, we surface the error and abort the
      // payment redirect — the order itself will linger as unpaid (Stripe
      // hasn't been called yet) and can be retried.
      if (tradeCreditEnabled && tradeCreditApplied > 0) {
        try {
          const tradeToken = localStorage.getItem('tile_shop_token');
          const redeemRes = await axios.post(
            `${API_URL}/api/shop/trade/credits/redeem`,
            { order_id: orderResult.order_id, amount: tradeCreditApplied },
            {
              headers: {
                'Content-Type': 'application/json',
                ...(tradeToken ? { Authorization: `Bearer ${tradeToken}` } : {}),
              },
            },
          );
          const redeemBody = redeemRes.data;
          // Refresh the cached customer balance so the dashboard shows the
          // post-redemption figure on next visit.
          try {
            const raw = localStorage.getItem('tile_shop_customer');
            if (raw) {
              const cust = JSON.parse(raw);
              cust.credit_balance = redeemBody.new_balance;
              localStorage.setItem('tile_shop_customer', JSON.stringify(cust));
              window.dispatchEvent(new Event('trade-auth-change'));
            }
            sessionStorage.removeItem('tile_use_trade_credit');
          } catch (e) { /* ignore cache refresh blip */ }
        } catch (err) {
          if (!err?.response) {
            console.error('[checkout] Network error during credit redemption:', err);
            toast.error('Could not apply trade credit — please try again.');
            return;
          }
          const detail = extractAxiosErrorDetail(err, 'Trade credit redemption failed');
          console.error('[checkout] Trade credit redemption failed:', detail);
          toast.error(`Could not apply trade credit: ${detail}`);
          return;
        }
      }

      // Step 2: Create Stripe payment session
      let payResult;
      try {
        const payRes = await axios.post(
          `${API_URL}/api/shop/guest-checkout/pay`,
          {
            order_id: orderResult.order_id,
            origin_url: window.location.origin,
            // Selected on Step 3 cards. Backend filters Stripe's payment_method_types
            // so the shopper lands on (or is preselected to) their chosen method.
            preferred_method: selectedMethod,
          },
          { headers: { 'Content-Type': 'application/json' } },
        );
        payResult = payRes.data;
      } catch (err) {
        if (!err?.response) {
          console.error('[checkout] Network error during payment setup:', err);
          // Show the actual error message so users + support can triage
          // (timeouts, CORS, DNS, Railway proxy closing connection mid-response).
          const msg = err?.message ? `Network error: ${err.message}` : 'Cannot reach payment service. Please try again.';
          toast.error(msg);
          return;
        }
        const detail = extractAxiosErrorDetail(err, 'Payment setup failed');
        console.error('[checkout] Payment setup failed:', err.response.status, detail, { rawBody: err.response.data });
        toast.error(detail || `Payment setup failed (HTTP ${err.response.status}). Please contact support.`);
        return;
      }

      if (!payResult?.checkout_url) {
        console.error('[checkout] Pay endpoint returned no checkout_url:', payResult);
        toast.error('Payment link missing from server. Please contact support.');
        return;
      }

      // Step 3: Clear cart and redirect to Stripe
      localStorage.removeItem('tilestation_cart');
      window.location.href = payResult.checkout_url;
    } catch (e) {
      console.error('[checkout] Unexpected error:', e);
      toast.error(e?.message ? `Checkout failed: ${e.message}` : 'Something went wrong. Please try again.');
    } finally {
      setPlacing(false);
    }
  };

  if (loading) return (
    <div className="min-h-screen bg-[#F9F8F6]">
      <ShopHeader />
      <div className="flex items-center justify-center py-24"><Loader2 className="w-8 h-8 animate-spin text-[#78716C]" /></div>
      <ShopFooter />
    </div>
  );

  if (orderComplete) return (
    <div className="min-h-screen bg-[#F9F8F6]">
      <ShopHeader />
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-lg mx-auto text-center">
          <motion.div
            initial={{ scale: 0, rotate: -45 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', damping: 12 }}
            className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-6"
          >
            <CheckCircle2 className="w-10 h-10 text-emerald-500" />
          </motion.div>
          <h1 className="text-3xl font-bold text-[#1C1917] tracking-tight mb-4">{settings.text.success_message}</h1>
          <p className="text-[#78716C] mb-8">We'll send a confirmation to <strong className="text-[#1C1917]">{details.email}</strong></p>
          <Link to="/tiles" className="inline-flex items-center gap-2 bg-[#1C1917] text-[#F7EA1C] font-semibold px-6 py-3 rounded-lg hover:bg-[#292524] transition-colors">
            Continue Shopping <ChevronRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
      <ShopFooter />
    </div>
  );

  if (cartItems.length === 0) return (
    <div className="min-h-screen bg-[#F9F8F6]">
      <ShopHeader />
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-lg mx-auto text-center">
          <ShoppingBag className="w-16 h-16 mx-auto text-[#D6D3D1] mb-4" />
          <h1 className="text-2xl font-bold text-[#1C1917] tracking-tight mb-2">Your basket is empty</h1>
          <p className="text-[#78716C] mb-6">Browse our collections to find the perfect tiles.</p>
          <Link to="/tiles" className="inline-flex items-center gap-2 bg-[#1C1917] text-[#F7EA1C] font-semibold px-6 py-3 rounded-lg hover:bg-[#292524] transition-colors">
            Browse Tiles <ChevronRight className="w-4 h-4" />
          </Link>
        </div>
      </div>
      <ShopFooter />
    </div>
  );

  const text = settings.text;
  const stepTitles = [text.step1_title, text.step2_title, text.step3_title];
  const freeThreshold = settings.delivery.free_threshold || 499;
  const progressPct = Math.min(100, Math.max(0, (subtotal / freeThreshold) * 100));
  const amountToFree = Math.max(0, freeThreshold - subtotal);

  return (
    <div className="min-h-screen bg-[#F9F8F6]">
      <ShopHeader />
      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-6 lg:py-10">
        {/* Breadcrumb */}
        <nav className="text-[11px] font-medium tracking-[0.08em] uppercase text-[#78716C] mb-6">
          <Link to="/" className="hover:text-[#1C1917] transition-colors">Home</Link>
          <span className="mx-2 text-[#D6D3D1]">/</span>
          <Link to="/tiles" className="hover:text-[#1C1917] transition-colors">Shop</Link>
          <span className="mx-2 text-[#D6D3D1]">/</span>
          <span className="text-[#1C1917]">Checkout</span>
        </nav>

        {/* Progress Steps — refined with animated connectors + spring checkmarks */}
        <div className="flex items-center justify-center gap-1 sm:gap-3 mb-10">
          {stepTitles.map((label, idx) => {
            const isDone = step > idx + 1;
            const isActive = step === idx + 1;
            return (
              <React.Fragment key={idx}>
                <button
                  onClick={() => idx + 1 < step && setStep(idx + 1)}
                  className="flex items-center gap-2.5 group"
                  disabled={idx + 1 > step}
                  data-testid={`checkout-step-indicator-${idx + 1}`}
                >
                  <motion.div
                    initial={false}
                    animate={{
                      scale: isActive ? 1.05 : 1,
                      backgroundColor: isDone ? '#1C1917' : isActive ? '#1C1917' : '#F3F0EB',
                      color: isDone || isActive ? '#F7EA1C' : '#A8A29E',
                    }}
                    transition={{ type: 'spring', damping: 16, stiffness: 200 }}
                    className={`w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center font-bold text-sm shadow-sm ${isDone ? 'ring-2 ring-[#1C1917]/10' : ''}`}
                  >
                    {isDone ? (
                      <motion.div initial={{ scale: 0, rotate: -45 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', damping: 12 }}>
                        <CheckCircle2 className="w-5 h-5" />
                      </motion.div>
                    ) : idx + 1}
                  </motion.div>
                  <span className={`text-[13px] font-semibold hidden sm:inline tracking-tight transition-colors ${isActive ? 'text-[#1C1917]' : isDone ? 'text-[#78716C]' : 'text-[#A8A29E]'}`}>{label}</span>
                </button>
                {idx < 2 && (
                  <div className="relative w-10 sm:w-16 h-[2px] bg-[#E7E5E4] rounded overflow-hidden">
                    <motion.div
                      initial={false}
                      animate={{ width: step > idx + 1 ? '100%' : '0%' }}
                      transition={{ duration: 0.5, ease: 'easeOut' }}
                      className="absolute inset-y-0 left-0 bg-[#1C1917]"
                    />
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
          {/* Main Content */}
          <div className="lg:col-span-7 space-y-6">
            {/* Step 1: Details */}
            {step === 1 && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-white rounded-2xl border border-[#E7E5E4] p-6 md:p-8 shadow-[0_1px_3px_rgba(28,25,23,0.04)]"
                data-testid="checkout-step-1"
              >
                <div className="flex items-center gap-3 mb-6">
                  <span className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[#78716C]">Step 1 of 3</span>
                  <span className="h-px flex-1 bg-[#E7E5E4]" />
                </div>
                <h2 className="text-2xl font-bold text-[#1C1917] tracking-tight mb-6">{text.step1_title}</h2>
                <div className="space-y-5">
                  <div>
                    <Label htmlFor="email">Email Address *</Label>
                    <Input id="email" type="email" value={details.email} onChange={(e) => setDetails(p => ({ ...p, email: e.target.value }))} placeholder="you@example.com" className="mt-1" required />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label htmlFor="firstName">First Name *</Label>
                      <Input id="firstName" value={details.firstName} onChange={(e) => setDetails(p => ({ ...p, firstName: e.target.value }))} placeholder="John" className="mt-1" required />
                    </div>
                    <div>
                      <Label htmlFor="lastName">Last Name *</Label>
                      <Input id="lastName" value={details.lastName} onChange={(e) => setDetails(p => ({ ...p, lastName: e.target.value }))} placeholder="Smith" className="mt-1" required />
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="phone">Phone Number</Label>
                    <Input id="phone" value={details.phone} onChange={(e) => setDetails(p => ({ ...p, phone: e.target.value }))} placeholder="07123 456789" className="mt-1" />
                  </div>
                  <Button onClick={() => validateStep1() && setStep(2)} className="w-full bg-[#1C1917] hover:bg-[#292524] text-[#F7EA1C] py-6 text-lg font-semibold transition-all hover:-translate-y-0.5 hover:shadow-lg" data-testid="checkout-to-step-2">
                    Continue to {text.step2_title} <ChevronRight className="w-5 h-5 ml-2" />
                  </Button>
                </div>
              </motion.div>
            )}

            {/* Step 2: Delivery */}
            {step === 2 && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="space-y-6" data-testid="checkout-step-2">
                <div className="bg-white rounded-2xl border border-[#E7E5E4] p-6 md:p-8 shadow-[0_1px_3px_rgba(28,25,23,0.04)]">
                  <div className="flex items-center gap-3 mb-6">
                    <span className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[#78716C]">Step 2 of 3</span>
                    <span className="h-px flex-1 bg-[#E7E5E4]" />
                  </div>
                  <h2 className="text-2xl font-bold text-[#1C1917] tracking-tight mb-6">{text.step2_title}</h2>

                  {/* Delivery Method Selection */}
                  <div className="space-y-3 mb-6">
                    {settings.delivery.enabled && (
                      <button
                        onClick={() => setDelivery(p => ({ ...p, method: 'delivery' }))}
                        className={`w-full flex items-start gap-4 p-4 rounded-xl border-2 text-left transition-all ${delivery.method === 'delivery' ? 'border-[#F7EA1C] bg-[#F7EA1C]/5' : 'border-gray-200 hover:border-gray-300'}`}
                      >
                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 ${delivery.method === 'delivery' ? 'border-[#F7EA1C]' : 'border-gray-300'}`}>
                          {delivery.method === 'delivery' && <div className="w-2.5 h-2.5 rounded-full bg-[#F7EA1C]" />}
                        </div>
                        <Truck className={`w-5 h-5 mt-0.5 flex-shrink-0 ${delivery.method === 'delivery' ? 'text-[#F7EA1C]' : 'text-gray-400'}`} />
                        <div className="flex-1">
                          <span className="font-semibold text-gray-900">{settings.delivery.label}</span>
                          <p className="text-sm text-gray-500">{settings.delivery.description}</p>
                          <p className="text-[10px] text-gray-400 mt-0.5">* Some items are excluded from free delivery — a mandatory delivery charge may apply.</p>
                          {subtotal >= settings.delivery.free_threshold && (
                            <span className="inline-block mt-1 text-xs font-medium text-green-600 bg-green-50 px-2 py-0.5 rounded">FREE on this order</span>
                          )}
                        </div>
                      </button>
                    )}
                    {settings.collection.enabled && (
                      <button
                        onClick={() => setDelivery(p => ({ ...p, method: 'collect' }))}
                        className={`w-full flex items-start gap-4 p-4 rounded-xl border-2 text-left transition-all ${delivery.method === 'collect' ? 'border-[#F7EA1C] bg-[#F7EA1C]/5' : 'border-gray-200 hover:border-gray-300'}`}
                      >
                        <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 ${delivery.method === 'collect' ? 'border-[#F7EA1C]' : 'border-gray-300'}`}>
                          {delivery.method === 'collect' && <div className="w-2.5 h-2.5 rounded-full bg-[#F7EA1C]" />}
                        </div>
                        <MapPin className={`w-5 h-5 mt-0.5 flex-shrink-0 ${delivery.method === 'collect' ? 'text-[#F7EA1C]' : 'text-gray-400'}`} />
                        <div className="flex-1">
                          <span className="font-semibold text-gray-900">{settings.collection.label}</span>
                          <p className="text-sm text-gray-500">{settings.collection.description}</p>
                          <p className="text-xs text-gray-400 mt-1">{settings.collection.ready_time}</p>
                        </div>
                      </button>
                    )}
                  </div>

                  {/* Delivery Address */}
                  {delivery.method === 'delivery' && (
                    <div className="border-t pt-6 space-y-4">
                      <h3 className="font-semibold text-gray-900">Delivery Address</h3>
                      <div>
                        <Label>Address Line 1 *</Label>
                        <Input value={delivery.address1} onChange={(e) => setDelivery(p => ({ ...p, address1: e.target.value }))} placeholder="123 High Street" className="mt-1" />
                      </div>
                      <div>
                        <Label>Address Line 2</Label>
                        <Input value={delivery.address2} onChange={(e) => setDelivery(p => ({ ...p, address2: e.target.value }))} placeholder="Flat 2 (optional)" className="mt-1" />
                      </div>
                      <div className="grid grid-cols-3 gap-4">
                        <div>
                          <Label>City *</Label>
                          <Input value={delivery.city} onChange={(e) => setDelivery(p => ({ ...p, city: e.target.value }))} placeholder="London" className="mt-1" />
                        </div>
                        <div>
                          <Label>County</Label>
                          <Input value={delivery.county} onChange={(e) => setDelivery(p => ({ ...p, county: e.target.value }))} placeholder="Kent" className="mt-1" />
                        </div>
                        <div>
                          <Label>Postcode *</Label>
                          <Input value={delivery.postcode} onChange={(e) => setDelivery(p => ({ ...p, postcode: e.target.value }))} placeholder="TN9 1PP" className="mt-1" />
                          {delivery.postcode && deliveryFee !== null && deliveryFee > 0 && (
                            <p className="text-xs text-gray-500 mt-1">
                              Delivery to {delivery.postcode.toUpperCase()}: <strong>£{safeToFixed(deliveryFee, 2)}</strong>
                              {congestionCharge > 0 && <span className="text-red-600"> + £{safeToFixed(congestionCharge, 2)} congestion charge</span>}
                            </p>
                          )}
                          {delivery.postcode && deliveryFee === 0 && delivery.method === 'delivery' && (
                            <p className="text-xs mt-1 font-medium">
                              <span className="text-green-600">Free delivery on this order!</span>
                              {congestionCharge > 0 && <span className="text-red-600"> + £{safeToFixed(congestionCharge, 2)} congestion charge payable</span>}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Billing Address — defaults to "same as delivery"; uncheck to expose form */}
                  {delivery.method === 'delivery' && (
                    <div className="border-t pt-6 mt-2" data-testid="billing-address-section">
                      <h3 className="font-semibold text-gray-900 mb-3">Billing Address</h3>
                      <label
                        className="flex items-center gap-2.5 cursor-pointer select-none mb-3"
                        data-testid="billing-same-as-delivery-toggle"
                        onClick={(e) => { e.preventDefault(); setBilling(b => ({ ...b, same_as_delivery: !b.same_as_delivery })); }}
                      >
                        <span
                          role="checkbox"
                          aria-checked={billing.same_as_delivery}
                          tabIndex={0}
                          onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setBilling(b => ({ ...b, same_as_delivery: !b.same_as_delivery })); } }}
                          className={`relative inline-flex h-5 w-5 items-center justify-center rounded border-2 transition-colors ${billing.same_as_delivery ? 'bg-[#1C1917] border-[#1C1917]' : 'bg-white border-gray-300'}`}
                        >
                          {billing.same_as_delivery && <CheckCircle2 className="w-3.5 h-3.5 text-[#F7EA1C]" />}
                        </span>
                        <span className="text-sm text-[#1C1917]">My billing address is the same as my delivery address</span>
                      </label>

                      {!billing.same_as_delivery && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          className="space-y-3 pt-2"
                          data-testid="billing-address-fields"
                        >
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <Label>First Name *</Label>
                              <Input value={billing.firstName} onChange={(e) => setBilling(p => ({ ...p, firstName: e.target.value }))} placeholder="John" className="mt-1" data-testid="billing-first-name" />
                            </div>
                            <div>
                              <Label>Last Name *</Label>
                              <Input value={billing.lastName} onChange={(e) => setBilling(p => ({ ...p, lastName: e.target.value }))} placeholder="Smith" className="mt-1" data-testid="billing-last-name" />
                            </div>
                          </div>
                          <div>
                            <Label>Company (optional)</Label>
                            <Input value={billing.company} onChange={(e) => setBilling(p => ({ ...p, company: e.target.value }))} placeholder="Company Ltd." className="mt-1" data-testid="billing-company" />
                          </div>
                          <div>
                            <Label>Address Line 1 *</Label>
                            <Input value={billing.address1} onChange={(e) => setBilling(p => ({ ...p, address1: e.target.value }))} placeholder="123 High Street" className="mt-1" data-testid="billing-address1" />
                          </div>
                          <div>
                            <Label>Address Line 2</Label>
                            <Input value={billing.address2} onChange={(e) => setBilling(p => ({ ...p, address2: e.target.value }))} placeholder="Flat 2 (optional)" className="mt-1" data-testid="billing-address2" />
                          </div>
                          <div className="grid grid-cols-3 gap-3">
                            <div>
                              <Label>City *</Label>
                              <Input value={billing.city} onChange={(e) => setBilling(p => ({ ...p, city: e.target.value }))} placeholder="London" className="mt-1" data-testid="billing-city" />
                            </div>
                            <div>
                              <Label>County</Label>
                              <Input value={billing.county} onChange={(e) => setBilling(p => ({ ...p, county: e.target.value }))} placeholder="Kent" className="mt-1" data-testid="billing-county" />
                            </div>
                            <div>
                              <Label>Postcode *</Label>
                              <Input value={billing.postcode} onChange={(e) => setBilling(p => ({ ...p, postcode: e.target.value.toUpperCase() }))} placeholder="TN9 1PP" className="mt-1" data-testid="billing-postcode" />
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </div>
                  )}

                  {/* Delivery Speed Selection (Standard vs Express) */}
                  {delivery.method === 'delivery' && expressSettings.enabled && (
                    <div className="border-t pt-6 mt-2">
                      <h3 className="font-semibold text-gray-900 mb-3">Delivery Speed</h3>
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          data-testid="delivery-speed-standard"
                          onClick={() => setDelivery(p => ({ ...p, speed: 'standard' }))}
                          className={`flex flex-col p-4 rounded-xl border-2 text-left transition-all ${delivery.speed === 'standard' ? 'border-[#F7EA1C] bg-[#F7EA1C]/5' : 'border-gray-200 hover:border-gray-300'}`}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${delivery.speed === 'standard' ? 'border-[#F7EA1C]' : 'border-gray-300'}`}>
                              {delivery.speed === 'standard' && <div className="w-2 h-2 rounded-full bg-[#F7EA1C]" />}
                            </div>
                            <Truck className="w-4 h-4 text-gray-500" />
                            <span className="font-semibold text-gray-900 text-sm">{expressSettings.standard_label || 'Standard Delivery'}</span>
                          </div>
                          <p className="text-xs text-gray-500 ml-6">{expressSettings.standard_description || '5-7 working days'}</p>
                          <p className="text-xs text-gray-400 ml-6 mt-1">Included in delivery cost</p>
                        </button>
                        <button
                          data-testid="delivery-speed-express"
                          onClick={() => setDelivery(p => ({ ...p, speed: 'express' }))}
                          className={`flex flex-col p-4 rounded-xl border-2 text-left transition-all ${delivery.speed === 'express' ? 'border-amber-500 bg-amber-50' : 'border-gray-200 hover:border-gray-300'}`}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${delivery.speed === 'express' ? 'border-amber-500' : 'border-gray-300'}`}>
                              {delivery.speed === 'express' && <div className="w-2 h-2 rounded-full bg-amber-500" />}
                            </div>
                            <Zap className="w-4 h-4 text-amber-500" />
                            <span className="font-semibold text-gray-900 text-sm">{expressSettings.label || 'Express Delivery'}</span>
                          </div>
                          <p className="text-xs text-gray-500 ml-6">{expressSettings.description || '2-3 working days'}</p>
                          <p className="text-xs font-medium text-amber-600 ml-6 mt-1">+ £{(expressSettings.extra_fee || 0).toFixed(2)}</p>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Collection Store */}
                  {delivery.method === 'collect' && settings.collection.stores?.length > 0 && (
                    <div className="border-t pt-6">
                      <h3 className="font-semibold text-gray-900 mb-3">Collection Store</h3>
                      {settings.collection.stores.filter(s => s.active !== false).map(store => (
                        <div key={store.id} className="flex items-start gap-3 p-4 bg-gray-50 rounded-lg">
                          <MapPin className="w-5 h-5 text-[#F7EA1C] mt-0.5 flex-shrink-0" />
                          <div>
                            <p className="font-medium">{store.name}</p>
                            <p className="text-sm text-gray-500">{store.address}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Order Notes */}
                  <div className="border-t pt-6 mt-6">
                    {(() => {
                      const fs = settings.free_sample || {};
                      if (!fs.enabled) return null;
                      const threshold = Number(fs.threshold) || 0;
                      if (subtotal < threshold) return null;
                      const mode = fs.fulfillment_mode || 'separate_parcel';
                      const directs = (fs.direct_ship_suppliers || []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
                      const cartHasDirect = directs.length > 0 && cartItems.some(i => {
                        const sup = String(i.supplier || '').trim().toLowerCase();
                        return sup && directs.includes(sup);
                      });
                      if (mode === 'hide_on_direct' && cartHasDirect) return null;
                      const shipsSeparate = mode === 'separate_parcel' || (mode === 'smart' && cartHasDirect);
                      const unlockedText = shipsSeparate
                        ? (fs.unlocked_text_separate || fs.unlocked_text_pack || '')
                        : (fs.unlocked_text_pack || '');
                      return (
                        <motion.div
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="mb-3 rounded-lg border border-emerald-300 bg-gradient-to-r from-amber-50 to-emerald-50 px-3 py-2"
                          data-testid="checkout-free-sample-reminder"
                          data-ships-separate={shipsSeparate ? '1' : '0'}
                        >
                          <p className="text-[12px] text-emerald-900 leading-snug">
                            {unlockedText}
                            <span className="block mt-1 text-emerald-800/90">
                              Please write your sample choice below — e.g. <em>"Ashford Oak 100×100 sample"</em>.
                            </span>
                          </p>
                        </motion.div>
                      );
                    })()}
                    <Label>Order Notes (optional)</Label>
                    <textarea
                      value={delivery.notes}
                      onChange={(e) => setDelivery(p => ({ ...p, notes: e.target.value }))}
                      placeholder={text.order_notes_placeholder}
                      className="w-full mt-1 px-3 py-2 border rounded-lg text-sm min-h-[80px] focus:outline-none focus:ring-2 focus:ring-[#F7EA1C] focus:border-transparent"
                    />
                  </div>
                </div>

                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => setStep(1)} className="flex-1 py-6 border-[#E7E5E4] text-[#44403C] hover:bg-[#F3F0EB]">
                    <ArrowLeft className="w-4 h-4 mr-2" /> Back
                  </Button>
                  <Button onClick={() => validateStep2() && setStep(3)} className="flex-1 bg-[#1C1917] hover:bg-[#292524] text-[#F7EA1C] py-6 text-lg font-semibold transition-all hover:-translate-y-0.5 hover:shadow-lg" data-testid="checkout-to-step-3">
                    Continue to {text.step3_title} <ChevronRight className="w-5 h-5 ml-2" />
                  </Button>
                </div>
              </motion.div>
            )}

            {/* Step 3: Payment */}
            {step === 3 && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="space-y-6" data-testid="checkout-step-3">
                <div className="bg-white rounded-2xl border border-[#E7E5E4] p-6 md:p-8 shadow-[0_1px_3px_rgba(28,25,23,0.04)]">
                  <div className="flex items-center gap-3 mb-6">
                    <span className="text-[11px] font-semibold tracking-[0.1em] uppercase text-[#78716C]">Step 3 of 3</span>
                    <span className="h-px flex-1 bg-[#E7E5E4]" />
                  </div>
                  <h2 className="text-2xl font-bold text-[#1C1917] tracking-tight mb-6">{text.step3_title}</h2>

                  <div className="bg-gradient-to-br from-emerald-50 to-[#F3F0EB]/40 border border-emerald-200/50 rounded-xl p-4 mb-6">
                    <div className="flex items-start gap-3">
                      <div className="w-9 h-9 rounded-full bg-emerald-100 flex items-center justify-center flex-shrink-0">
                        <Lock className="w-4 h-4 text-emerald-700" />
                      </div>
                      <div>
                        <p className="font-semibold text-[#1C1917]">Secure Payment</p>
                        <p className="text-sm text-[#78716C]">{text.secure_message}</p>
                      </div>
                    </div>
                  </div>

                  {/* Order Review */}
                  <div className="mb-6">
                    <h3 className="font-semibold text-[#1C1917] mb-3 tracking-tight">Order Review</h3>
                    <div className="bg-[#F9F8F6] border border-[#E7E5E4] rounded-xl p-4 space-y-3">
                      <div className="flex items-center gap-2 text-sm text-[#44403C]">
                        <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                        <span className="truncate"><span className="font-medium text-[#1C1917]">{details.firstName} {details.lastName}</span> — {details.email}</span>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-[#44403C]">
                        <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                        <span className="truncate">
                          {delivery.method === 'delivery'
                            ? <>Delivery to <span className="font-medium text-[#1C1917]">{delivery.address1}, {delivery.city}, {delivery.postcode}</span></>
                            : <>Click &amp; Collect — <span className="font-medium text-[#1C1917]">{settings.collection.stores[0]?.name || 'Store'}</span></>
                          }
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Payment method cards — Trade Point-style branded cards.
                      Stripe presents the actual selector on its hosted page after the
                      shopper hits "Pay"; these cards are a reassurance / branding step. */}
                  <div>
                    <h3 className="font-semibold text-[#1C1917] mb-3 tracking-tight">Payment Methods</h3>
                    <PaymentMethodCards
                      payments={settings.payments || {}}
                      selected={selectedMethod}
                      onSelect={setSelectedMethod}
                    />
                    <div className="mt-4 flex items-center justify-center gap-2 text-[11px] text-[#78716C]">
                      <Lock className="w-3 h-3" />
                      <span>Secured by Stripe · 256-bit SSL · 3D Secure</span>
                    </div>
                  </div>
                </div>

                <CheckoutMaintenanceWarning context="checkout" />

                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => setStep(2)} className="flex-1 py-6 border-[#E7E5E4] text-[#44403C] hover:bg-[#F3F0EB]">
                    <ArrowLeft className="w-4 h-4 mr-2" /> Back
                  </Button>
                  <Button onClick={handlePlaceOrder} disabled={placing || maintCountdown.blocking} className="flex-1 bg-[#635BFF] hover:bg-[#5249E5] text-white py-6 text-lg font-semibold shadow-lg shadow-[#635BFF]/20 transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-[#635BFF]/30 disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:bg-[#A8A29E] disabled:shadow-none" data-testid="place-order-btn">
                    {maintCountdown.blocking ? (
                      <><Lock className="w-5 h-5 mr-2" /> Checkout closed — try again shortly</>
                    ) : placing ? (
                      <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> Processing...</>
                    ) : (
                      <><Lock className="w-5 h-5 mr-2" /> Pay £{safeToFixed(total, 2)}{selectedMethod === 'paypal' ? ' with PayPal' : selectedMethod === 'klarna' ? ' with Klarna' : selectedMethod === 'wallet' ? ' with Apple/Google Pay' : ''}</>
                    )}
                  </Button>
                </div>
              </motion.div>
            )}
          </div>

          {/* Order Summary Sidebar — Modern Receipt */}
          <div className="lg:col-span-5">
            <div className="bg-[#F3F0EB] rounded-2xl border border-[#E7E5E4] sticky top-24 overflow-hidden shadow-[0_1px_3px_rgba(28,25,23,0.04)]">
              {/* Receipt header strip */}
              <div className="bg-[#1C1917] text-[#F7EA1C] px-6 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShoppingBag className="w-4 h-4" />
                  <span className="text-[13px] font-bold tracking-tight">Order Summary</span>
                </div>
                <span className="text-[10px] font-semibold tracking-[0.08em] uppercase text-[#F7EA1C]/80">
                  {cartItems.length} {cartItems.length === 1 ? 'item' : 'items'}
                </span>
              </div>

              <div className="p-6 space-y-5">
                {/* Free-delivery progress bar (only when delivery mode + below threshold) */}
                {delivery.method === 'delivery' && subtotal < freeThreshold && (
                  <div className="bg-white rounded-xl p-4 border border-[#E7E5E4]">
                    <div className="flex items-center justify-between text-[12px] font-medium text-[#1C1917] mb-2">
                      <span className="flex items-center gap-1.5">
                        <Truck className="w-3.5 h-3.5 text-[#78716C]" />
                        <span>Spend <strong>£{safeToFixed(amountToFree, 2)}</strong> more for</span>
                      </span>
                      <span className="text-emerald-700 font-bold">FREE delivery</span>
                    </div>
                    <div className="h-2 w-full bg-[#F3F0EB] rounded-full overflow-hidden" data-testid="free-delivery-progress">
                      <motion.div
                        initial={false}
                        animate={{ width: `${progressPct}%` }}
                        transition={{ duration: 0.6, ease: 'easeOut' }}
                        className="h-full bg-gradient-to-r from-emerald-400 to-emerald-600 rounded-full relative"
                      >
                        <div className="absolute inset-0 bg-white/20 animate-pulse" />
                      </motion.div>
                    </div>
                  </div>
                )}

                {/* Qualifies badge */}
                {delivery.method === 'delivery' && subtotal >= freeThreshold && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="bg-gradient-to-r from-emerald-50 to-[#F3F0EB] border border-emerald-200 rounded-xl p-3 flex items-center gap-2.5"
                  >
                    <motion.div initial={{ scale: 0, rotate: -45 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', damping: 12 }}>
                      <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                    </motion.div>
                    <div>
                      <p className="text-sm font-semibold text-emerald-900">You qualify for FREE delivery</p>
                      <p className="text-[11px] text-emerald-700/80">Saved £{(settings.delivery.default_fee || 49.99).toFixed(2)} on shipping</p>
                    </div>
                  </motion.div>
                )}

                {/* Cart Items — animated list */}
                <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1 -mr-1">
                  <AnimatePresence mode="popLayout">
                    {cartItems.map((item, idx) => (
                      <motion.div
                        key={item.id + '-' + idx}
                        layout
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, height: 0 }}
                        transition={{ type: 'spring', damping: 20, stiffness: 200 }}
                        className="bg-white rounded-xl p-3 border border-[#E7E5E4] flex gap-3 group hover:shadow-sm transition-shadow"
                      >
                        <div className="h-16 w-16 rounded-lg bg-[#F9F8F6] border border-[#E7E5E4] overflow-hidden flex-shrink-0 flex items-center justify-center">
                          {item.image ? (
                            <img src={normaliseImageUrl(item.image)} alt={item.name} className="w-full h-full object-cover" />
                          ) : (
                            <Package className="w-6 h-6 text-[#D6D3D1]" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-[13px] text-[#1C1917] leading-tight line-clamp-2 pr-6">{item.name}</p>
                          {item.variant && <p className="text-[11px] text-[#78716C] mt-0.5">{item.variant}</p>}
                          {markedItemIds.has(String(item.id || item.product_id || '')) && (
                            <p className="text-[10px] text-amber-700 font-medium mt-0.5 flex items-center gap-1" data-testid={`item-delivery-note-${item.slug || item.id}`}>
                              <Truck className="w-3 h-3" />
                              £{Number((deliveryFlags[String(item.id || item.product_id || '')] || {}).delivery_charge || 0).toFixed(2)} delivery charge applies
                            </p>
                          )}
                          <div className="mt-1.5 inline-flex items-center px-2 py-0.5 bg-[#F3F0EB] rounded-md">
                            <span className="font-mono text-[10px] tracking-tight text-[#44403C]" data-testid={`cart-qty-context-${item.slug}`}>
                              {formatCartQuantity(item)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between mt-2">
                            <div className="flex items-center gap-1 bg-white border border-[#E7E5E4] rounded-lg px-1 py-0.5 shadow-sm">
                              <motion.button whileTap={{ scale: 0.9 }} onClick={() => updateQuantity(idx, -1)} className="w-6 h-6 rounded flex items-center justify-center text-[#78716C] hover:text-[#1C1917] hover:bg-[#F3F0EB] transition-colors">
                                <Minus className="w-3 h-3" />
                              </motion.button>
                              <span className="text-[12px] font-semibold tabular-nums text-[#1C1917] min-w-[28px] text-center">{Number(item.quantity).toFixed(Number(item.quantity) % 1 === 0 ? 0 : 2)}</span>
                              <motion.button whileTap={{ scale: 0.9 }} onClick={() => updateQuantity(idx, 1)} className="w-6 h-6 rounded flex items-center justify-center text-[#78716C] hover:text-[#1C1917] hover:bg-[#F3F0EB] transition-colors">
                                <Plus className="w-3 h-3" />
                              </motion.button>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="font-bold text-[13px] text-[#1C1917] tabular-nums">£{(item.price * item.quantity).toFixed(2)}</span>
                              <button onClick={() => removeItem(idx)} className="text-[#A8A29E] hover:text-red-500 transition-colors p-0.5" aria-label="Remove item">
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>

                {/* Totals — dashed receipt divider */}
                <div className="pt-4 border-t border-dashed border-[#D6D3D1] space-y-2.5">
                  <div className="flex justify-between text-sm">
                    <span className="text-[#78716C]">Subtotal</span>
                    <span className="font-semibold text-[#1C1917] tabular-nums">£{subtotal.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-[#78716C]">{parcelOnly && (deliveryFee || 0) > 0 ? 'Delivery (parcel)' : 'Delivery'}</span>
                    {deliveryFee === null ? (
                      <span className="text-[#A8A29E] italic text-xs">Calculated next step</span>
                    ) : deliveryFee === 0 ? (
                      <span className="text-emerald-600 font-bold tracking-wide text-xs uppercase">FREE</span>
                    ) : (
                      <span className="font-semibold text-[#1C1917] tabular-nums">£{safeToFixed(deliveryFee, 2)}</span>
                    )}
                  </div>
                  {itemDeliveryCharge > 0 && (
                    <div data-testid="item-delivery-charge-row">
                      <div className="flex justify-between text-sm">
                        <span className="text-amber-700 flex items-center gap-1"><Truck className="w-3 h-3" />Item delivery charge</span>
                        <span className="font-semibold text-amber-700 tabular-nums">+ £{itemDeliveryCharge.toFixed(2)}</span>
                      </div>
                      <p className="text-[10px] text-[#A8A29E] leading-snug mt-0.5">
                        Some items are excluded from free delivery — this charge is waived when your other items exceed £{(settings.delivery.free_threshold || 499).toFixed(0)}.
                      </p>
                    </div>
                  )}
                  {congestionCharge > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-red-700">{settings.delivery.congestion_charge?.label || 'Congestion Charge'}</span>
                      <span className="font-semibold text-red-700 tabular-nums">£{safeToFixed(congestionCharge, 2)}</span>
                    </div>
                  )}
                  {expressFee > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-amber-700 flex items-center gap-1"><Zap className="w-3 h-3" />{expressSettings.label || 'Express Delivery'}</span>
                      <span className="font-semibold text-amber-700 tabular-nums">+ £{expressFee.toFixed(2)}</span>
                    </div>
                  )}

                  {/* Promo code (abandoned-cart day-1 etc.) */}
                  {!promoApplied ? (
                    <div className="pt-2">
                      <Label className="text-[11px] uppercase tracking-wider text-[#78716C]">Promo code</Label>
                      <div className="flex gap-2 mt-1">
                        <Input
                          value={promoInput}
                          onChange={(e) => { setPromoInput(e.target.value.toUpperCase()); setPromoError(''); }}
                          placeholder="BACK-XXXXXX"
                          className="text-sm h-9"
                          data-testid="promo-code-input"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={applyPromoCode}
                          disabled={!promoInput || promoChecking}
                          data-testid="promo-code-apply"
                        >
                          {promoChecking ? '...' : 'Apply'}
                        </Button>
                      </div>
                      {promoError && (
                        <p className="text-[11px] text-red-600 mt-1" data-testid="promo-code-error">{promoError}</p>
                      )}
                    </div>
                  ) : (
                    <div className="flex justify-between items-center text-sm bg-emerald-50 border border-emerald-200 rounded-md px-2 py-1.5" data-testid="promo-code-applied">
                      <span className="text-emerald-700 flex items-center gap-1.5">
                        <Sparkles className="w-3 h-3" />
                        <span className="font-mono font-semibold">{promoApplied.code}</span>
                        <span className="text-[11px]">({promoApplied.percent_off}% off)</span>
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-emerald-700 tabular-nums">– £{Number(promoApplied.discount_amount).toFixed(2)}</span>
                        <button
                          type="button"
                          onClick={removePromoCode}
                          className="text-[11px] text-emerald-700/70 hover:text-emerald-900 underline"
                          data-testid="promo-code-remove"
                        >
                          remove
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Trade Credit Applied — emerald row, only when enabled via dashboard CTA */}
                {tradeCreditEnabled && tradeCreditApplied > 0 && (
                  <div
                    className="flex justify-between items-center text-sm bg-emerald-100 border-2 border-emerald-300 rounded-md px-3 py-2"
                    data-testid="trade-credit-applied"
                  >
                    <span className="text-emerald-800 flex items-center gap-1.5 font-medium">
                      <Wallet className="w-3.5 h-3.5" />
                      <span>Trade credit applied</span>
                      {tradeCreditApplied < tradeCreditBalance && (
                        <span className="text-[10px] text-emerald-700/80 font-normal">
                          (£{(tradeCreditBalance - tradeCreditApplied).toFixed(2)} left for next order)
                        </span>
                      )}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-emerald-800 tabular-nums">– £{tradeCreditApplied.toFixed(2)}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setTradeCreditEnabled(false);
                          try { sessionStorage.removeItem('tile_use_trade_credit'); } catch (e) { /* ignore */ }
                        }}
                        className="text-[11px] text-emerald-700/70 hover:text-emerald-900 underline"
                        data-testid="trade-credit-remove"
                      >
                        remove
                      </button>
                    </div>
                  </div>
                )}

                {/* Grand Total — hero row */}
                <div className="pt-4 border-t-2 border-dashed border-[#1C1917]/20 flex items-end justify-between">
                  <div>
                    <p className="text-[10px] font-semibold tracking-[0.1em] uppercase text-[#78716C]">Total</p>
                    <p className="text-[11px] text-[#A8A29E] mt-0.5">Including VAT</p>
                  </div>
                  <motion.p
                    key={safeToFixed(total, 2)}
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="text-3xl font-bold text-[#1C1917] tracking-tight tabular-nums"
                  >
                    £{safeToFixed(total, 2)}
                  </motion.p>
                </div>

                {deliveryFee === null && (
                  <p className="text-[11px] text-[#A8A29E] text-center">Delivery calculated after entering postcode</p>
                )}

                {/* Trust microcopy */}
                <div className="pt-2 flex items-center justify-center gap-1.5 text-[10px] text-[#78716C]">
                  <Lock className="w-3 h-3" />
                  <span>Secure checkout powered by Stripe</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <ShopFooter />
    </div>
  );
};

export default TileCheckoutPage;
