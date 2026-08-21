import React, { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Trash2, Minus, Plus, ShoppingBag, ArrowRight, ArrowLeft, Truck, Store, MapPin, Phone, Clock, Gift, ChevronDown, Lock, Package } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip';
import { useCart } from '../../contexts/TileCartContext';
import { fetchDeliveryTerms } from '../../lib/deliveryTerms';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { useTradeUser } from '../../hooks/useTradeUser';
import { formatCartQuantity, snapCartQuantity, getCartStepSize, getTierUpsell } from '../../utils/cartDisplay';
import { getEffectivePrice, getEffectiveSubtotal, getRetailIncVat, getActiveTierDiscount } from '../../utils/cartPricing';
import WalletExpressButton from '../../components/shop/WalletExpressButton';
import CartSaveBanner from '../../components/shop/CartSaveBanner';
import CheckoutMaintenanceWarning from '../../components/shop/CheckoutMaintenanceWarning';
import { useCheckoutMaintenanceCountdown } from '../../contexts/MaintenanceContext';
import { safeToFixed } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const TileCartPage = () => {
  const { cart, removeFromCart, updateQuantity, getCartTotal, clearCart } = useCart();
  const navigate = useNavigate();
  const { isTrade, tradeDiscount } = useTradeUser();
  const maintCountdown = useCheckoutMaintenanceCountdown();

  // Delivery method: 'delivery' or 'collection'
  const [deliveryMethod, setDeliveryMethod] = useState('delivery');
  const [stores, setStores] = useState([]);
  const [selectedStore, setSelectedStore] = useState(null);
  const [creditBackRates, setCreditBackRates] = useState({});
  const [defaultCreditBackRate, setDefaultCreditBackRate] = useState(2);
  
  // Klarna Express — only visible when admin toggled Klarna on AND basket >= £30
  const [klarnaCheckoutEnabled, setKlarnaCheckoutEnabled] = useState(false);
  // PayPal Express — only visible when admin toggled PayPal on (no minimum)
  const [paypalCheckoutEnabled, setPaypalCheckoutEnabled] = useState(false);
  // Apple Pay / Google Pay Wallet Express — only visible when admin toggled on AND browser supports it
  const [walletExpressEnabled, setWalletExpressEnabled] = useState(false);
  const [expressLoading, setExpressLoading] = useState(false);
  const [paypalLoading, setPaypalLoading] = useState(false);
  // Admin-configured free delivery threshold + default fee (falls back to sensible defaults)
  const [deliveryThreshold, setDeliveryThreshold] = useState(499);
  const [defaultDeliveryFee, setDefaultDeliveryFee] = useState(49.99);
  // Item-level delivery rules — mandatory charges + parcel flags per cart item
  const [deliveryFlags, setDeliveryFlags] = useState({});
  // Editable free-delivery exclusion small-print
  const [deliveryTerms, setDeliveryTerms] = useState('');
  useEffect(() => { fetchDeliveryTerms().then(setDeliveryTerms); }, []);
  // Free sample upsell config (admin-driven) — shows a nudge on carts under threshold
  const [freeSample, setFreeSample] = useState({
    enabled: false,
    threshold: 100,
    label: 'Add a FREE sample',
    fulfillment_mode: 'separate_parcel',
    direct_ship_suppliers: [],
    locked_text: 'Spend <strong>£{remaining}</strong> more to unlock a <strong>FREE sample</strong> with your order',
    unlocked_text_pack: "🎁 You've unlocked a FREE sample — add your sample choice in the order notes at checkout.",
    unlocked_text_separate: "🎁 You've unlocked a FREE sample — we'll post it to you separately by Royal Mail. Add your sample choice in the order notes at checkout.",
  });

  // Fetch stores
  useEffect(() => {
    fetch(`${API_URL}/api/shop/stores`)
      .then(res => res.ok ? res.json() : [])
      .then(data => {
        setStores(data);
        if (data.length > 0) setSelectedStore(data[0]);
      })
      .catch(() => {});
  }, []);

  // Fetch item-level delivery rules for the basket (mandatory charges + parcel)
  useEffect(() => {
    const ids = [...new Set((cart || []).map(i => String(i.id || i.product_id || '')).filter(Boolean))];
    if (ids.length === 0) { setDeliveryFlags({}); return; }
    fetch(`${API_URL}/api/shop/delivery-flags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
      .then(res => res.ok ? res.json() : { flags: {} })
      .then(d => setDeliveryFlags(d.flags || {}))
      .catch(() => {});
  }, [cart]);

  const itemFlags = (item) => deliveryFlags[String(item.id || item.product_id || '')] || {};

  // Check if admin has enabled Klarna / PayPal / Wallet at checkout (shows Express buttons)
  // Also pulls the admin-configured free-delivery threshold + default fee so the
  // progress bar in the summary respects whatever the admin set in Checkout Settings.
  useEffect(() => {
    fetch(`${API_URL}/api/website-admin/public/checkout-settings`)
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        const settings = data?.settings || {};
        const payments = settings.payments || {};
        setKlarnaCheckoutEnabled(!!payments.klarna_enabled);
        setPaypalCheckoutEnabled(!!payments.paypal_enabled);
        setWalletExpressEnabled(!!payments.wallet_express_enabled);
        const delivery = settings.delivery || {};
        if (typeof delivery.free_threshold === 'number' && delivery.free_threshold > 0) {
          setDeliveryThreshold(delivery.free_threshold);
        }
        if (typeof delivery.default_fee === 'number' && delivery.default_fee >= 0) {
          setDefaultDeliveryFee(delivery.default_fee);
        }
        const fs = settings.free_sample || {};
        if (fs && typeof fs === 'object') {
          setFreeSample(prev => ({ ...prev, ...fs }));
        }
      })
      .catch(() => {
        setKlarnaCheckoutEnabled(false);
        setPaypalCheckoutEnabled(false);
        setWalletExpressEnabled(false);
      });
  }, []);

  // Klarna Express — single-tap basket → Stripe's Klarna-hosted flow
  const handleKlarnaExpress = async () => {
    if (expressLoading) return;
    setExpressLoading(true);
    try {
      const payload = {
        items: cart.map(c => ({
          product_id: c.id || c.slug || '',
          quantity: Number(c.quantity) || 0,
          price: Number(c.price) || 0,
          name: c.name || c.title || 'Product',
          sku: c.sku || '',
          image: c.image || '',
        })),
        origin_url: window.location.origin,
      };
      const res = await fetch(`${API_URL}/api/shop/klarna-express/create-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Unable to start Klarna checkout' }));
        alert(err.detail || 'Unable to start Klarna checkout');
        setExpressLoading(false);
        return;
      }
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        alert('Klarna session could not be created.');
        setExpressLoading(false);
      }
    } catch (e) {
      alert('Network error. Please try again or use standard checkout.');
      setExpressLoading(false);
    }
  };

  // PayPal Express — single-tap basket → Stripe's PayPal-hosted flow
  const handlePaypalExpress = async () => {
    if (paypalLoading) return;
    setPaypalLoading(true);
    try {
      const payload = {
        items: cart.map(c => ({
          product_id: c.id || c.slug || '',
          quantity: Number(c.quantity) || 0,
          price: Number(c.price) || 0,
          name: c.name || c.title || 'Product',
          sku: c.sku || '',
          image: c.image || '',
        })),
        origin_url: window.location.origin,
      };
      const res = await fetch(`${API_URL}/api/shop/paypal-express/create-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Unable to start PayPal checkout' }));
        alert(err.detail || 'Unable to start PayPal checkout');
        setPaypalLoading(false);
        return;
      }
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        alert('PayPal session could not be created.');
        setPaypalLoading(false);
      }
    } catch (e) {
      alert('Network error. Please try again or use standard checkout.');
      setPaypalLoading(false);
    }
  };

  // Fetch credit back rates for trade users
  const fetchCreditBackRates = useCallback(() => {
    if (!isTrade || cart.length === 0) return;
    const slugs = cart.map(item => item.slug).filter(Boolean);
    if (slugs.length === 0) return;
    
    fetch(`${API_URL}/api/shop/cart/credit-back-rates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slugs })
    })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) {
          setCreditBackRates(data.rates || {});
          setDefaultCreditBackRate(data.default_rate || 2);
        }
      })
      .catch(() => {});
  }, [isTrade, cart]);

  useEffect(() => {
    fetchCreditBackRates();
  }, [fetchCreditBackRates]);

  if (cart.length === 0) {
    return (
      <div className="min-h-screen bg-[#F9F8F6]">
        <ShopHeader />
        <div className="container mx-auto px-4 py-16">
          <div className="text-center max-w-md mx-auto">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', damping: 14 }}>
              <ShoppingBag className="h-16 w-16 mx-auto text-[#D6D3D1] mb-4" />
            </motion.div>
            <h1 className="text-2xl font-bold text-[#1C1917] tracking-tight mb-2" data-testid="empty-cart-heading">Your basket is empty</h1>
            <p className="text-[#78716C] mb-6">
              Looks like you haven't added any tiles to your basket yet.
            </p>
            <Button 
              onClick={() => navigate('/tiles')}
              className="bg-[#1C1917] hover:bg-[#292524] text-[#F7EA1C] font-semibold transition-all hover:-translate-y-0.5 hover:shadow-lg"
              data-testid="browse-tiles-btn"
            >
              Browse Tiles
            </Button>
          </div>
        </div>
        <ShopFooter />
      </div>
    );
  }

  const subtotal = getEffectiveSubtotal(cart, isTrade, tradeDiscount);
  const isCollection = deliveryMethod === 'collection';
  const deliveryFee = isCollection ? 0 : (subtotal >= deliveryThreshold ? 0 : defaultDeliveryFee);
  const totalExVat = subtotal + deliveryFee;
  const vatAmount = isTrade ? Math.round(totalExVat * 0.20 * 100) / 100 : 0;
  const totalIncVat = isTrade ? Math.round((totalExVat + vatAmount) * 100) / 100 : totalExVat;

  // Credit back calculation (on ex-VAT product subtotal only, not delivery)
  // Uses per-item credit_back_rate if stored, falls back to API-fetched rate, then default
  const creditBackAmount = isTrade ? cart.reduce((total, item) => {
    const rate = item.credit_back_rate || creditBackRates[item.slug] || defaultCreditBackRate;
    const itemTotal = getEffectivePrice(item, isTrade, tradeDiscount) * (item.quantity || 0);
    return total + (itemTotal * rate / 100);
  }, 0) : 0;

  // Saved vs retail (trade users): difference between retail inc-VAT line total
  // and trade ex-VAT line total — both derived from the canonical retail price
  // so the maths stays correct even after login/logout.
  const savedVsRetail = isTrade ? cart.reduce((total, item) => {
    const retail = getRetailIncVat(item, tradeDiscount);
    const tradeP = getEffectivePrice(item, true, tradeDiscount);
    return total + ((retail - tradeP) * (item.quantity || 0));
  }, 0) : 0;

  // Top-3 contributors to the saved-vs-retail figure for the tooltip — lets a
  // trade customer see exactly WHICH line items are driving their savings,
  // turning an abstract £ total into a tangible per-tile receipt.
  const savingsBreakdown = isTrade ? cart.map((item) => {
    const retail = getRetailIncVat(item, tradeDiscount);
    const tradeP = getEffectivePrice(item, true, tradeDiscount);
    const qty = item.quantity || 0;
    return {
      name: item.display_name || 'Item',
      saved: Math.round((retail - tradeP) * qty * 100) / 100,
    };
  })
    .filter(r => r.saved > 0.01)
    .sort((a, b) => b.saved - a.saved)
    .slice(0, 3) : [];

  const freeThreshold = deliveryThreshold;
  const progressPct = Math.min(100, Math.max(0, (subtotal / freeThreshold) * 100));
  const amountToFree = Math.max(0, freeThreshold - subtotal);

  // Free sample upsell state — only visible when admin has enabled it
  // Detect if cart contains any supplier-direct items (admin-configured list)
  const directSuppliers = (freeSample?.direct_ship_suppliers || []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  const cartHasDirectShip = directSuppliers.length > 0 && cart.some(item => {
    const sup = String(item.supplier || '').trim().toLowerCase();
    return sup && directSuppliers.includes(sup);
  });
  const mode = freeSample?.fulfillment_mode || 'separate_parcel';
  const hideForDirect = mode === 'hide_on_direct' && cartHasDirectShip;
  const sampleEnabled = !!freeSample?.enabled && Number(freeSample?.threshold) > 0 && !hideForDirect;
  const sampleThreshold = Number(freeSample?.threshold) || 0;
  const sampleRemaining = Math.max(0, sampleThreshold - subtotal);
  const sampleUnlocked = sampleEnabled && subtotal >= sampleThreshold;
  const sampleProgress = sampleEnabled && sampleThreshold > 0
    ? Math.min(100, Math.max(0, (subtotal / sampleThreshold) * 100))
    : 0;
  // Pick the right unlocked text based on mode + cart composition
  const sampleShipsSeparate =
    mode === 'separate_parcel' ||
    (mode === 'smart' && cartHasDirectShip);
  const sampleUnlockedText = sampleShipsSeparate
    ? (freeSample.unlocked_text_separate || freeSample.unlocked_text_pack || '')
    : (freeSample.unlocked_text_pack || '');
  const renderSampleText = (tpl) =>
    (tpl || '').replace('{remaining}', safeToFixed(sampleRemaining, 2));

  return (
    <div className="min-h-screen bg-[#F9F8F6]">
      <ShopHeader cartCount={cart.length} />

      {/* Sticky Free Delivery Banner — high-visibility AOV nudge */}
      {!isCollection && (
        <div className="sticky top-0 z-30" data-testid="free-delivery-banner">
          <AnimatePresence mode="wait">
            {subtotal < freeThreshold ? (
              <motion.div
                key="progress"
                initial={{ y: -20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -20, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-[#1C1917] text-white px-4 py-2.5 shadow-md"
              >
                <div className="max-w-[1200px] mx-auto flex items-center gap-3">
                  <Truck className="w-4 h-4 text-[#F7EA1C] flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-3 mb-1.5">
                      <span className="text-[12px] sm:text-[13px] font-medium truncate">
                        You're <span className="font-bold text-[#F7EA1C] tabular-nums">£{safeToFixed(amountToFree, 2)}</span> away from <span className="font-bold">FREE delivery</span>
                      </span>
                      <span className="text-[11px] text-white/60 tabular-nums flex-shrink-0 hidden sm:inline">{Math.round(progressPct)}%</span>
                    </div>
                    <div className="h-1.5 w-full bg-white/15 rounded-full overflow-hidden">
                      <motion.div
                        initial={false}
                        animate={{ width: `${progressPct}%` }}
                        transition={{ duration: 0.6, ease: 'easeOut' }}
                        className="h-full bg-gradient-to-r from-[#F7EA1C] to-emerald-400 rounded-full"
                      />
                    </div>
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="qualified"
                initial={{ y: -20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -20, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="bg-emerald-600 text-white px-4 py-2.5 shadow-md"
                data-testid="free-delivery-banner-qualified"
              >
                <div className="max-w-[1200px] mx-auto flex items-center justify-center gap-2.5">
                  <motion.div initial={{ scale: 0, rotate: -45 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', damping: 12, delay: 0.1 }}>
                    <Gift className="w-4 h-4" />
                  </motion.div>
                  <span className="text-[12px] sm:text-[13px] font-semibold">
                    You qualify for <span className="font-bold">FREE delivery</span> · Saved £{safeToFixed(defaultDeliveryFee, 2)}
                  </span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      <div className="max-w-[1200px] mx-auto px-4 sm:px-6 lg:px-8 py-8 lg:py-12">
        {/* Breadcrumb */}
        <nav className="text-[11px] font-medium tracking-[0.08em] uppercase text-[#78716C] mb-6">
          <Link to="/tiles" className="hover:text-[#1C1917] transition-colors">Home</Link>
          <span className="mx-2 text-[#D6D3D1]">/</span>
          <span className="text-[#1C1917]">Your Basket</span>
        </nav>

        <div className="flex items-baseline gap-3 mb-8">
          <h1 className="text-3xl md:text-4xl font-bold text-[#1C1917] tracking-tight" data-testid="cart-heading">Your Basket</h1>
          <span className="text-sm text-[#78716C]">{cart.length} {cart.length === 1 ? 'item' : 'items'}</span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-start">
          {/* Cart Items */}
          <div className="lg:col-span-7">
            <motion.div
              variants={{ hidden: { opacity: 0 }, show: { opacity: 1, transition: { staggerChildren: 0.08 } } }}
              initial="hidden"
              animate="show"
              className="space-y-3"
            >
              <AnimatePresence mode="popLayout">
              {cart.map((item) => (
                <motion.div
                  key={`${item.id}-${item.priceType}`}
                  layout
                  variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
                  exit={{ opacity: 0, scale: 0.95, height: 0, marginBottom: 0 }}
                  transition={{ type: 'spring', damping: 20, stiffness: 200 }}
                  className="bg-white rounded-2xl border border-[#E7E5E4] p-4 md:p-5 shadow-[0_1px_3px_rgba(28,25,23,0.04)] hover:shadow-[0_4px_12px_rgba(28,25,23,0.06)] transition-shadow"
                  data-testid={`cart-item-${item.slug}`}
                >
                  <div className="flex gap-4">
                    {/* Image */}
                    <Link to={`/tiles/${item.slug}`} className="flex-shrink-0">
                      {item.image ? (
                        <img
                          src={item.image}
                          alt={item.display_name}
                          className="w-24 h-24 md:w-28 md:h-28 object-cover rounded-xl border border-[#E7E5E4]"
                        />
                      ) : (
                        <div className="w-24 h-24 md:w-28 md:h-28 bg-[#F3F0EB] rounded-xl border border-[#E7E5E4] flex items-center justify-center">
                          <Package className="w-8 h-8 text-[#D6D3D1]" />
                        </div>
                      )}
                    </Link>

                    {/* Details */}
                    <div className="flex-1 min-w-0">
                      <Link 
                        to={`/tiles/${item.slug}`}
                        className="font-semibold text-[15px] text-[#1C1917] hover:text-[#635BFF] line-clamp-2 tracking-tight transition-colors"
                      >
                        {item.display_name || item.name || 'Unknown Product'}
                      </Link>
                      
                      <div className="text-xs text-[#78716C] mt-1 flex items-center gap-1.5">
                        {item.size && <span>{item.size}</span>}
                        {item.size && item.finish && <span className="w-1 h-1 rounded-full bg-[#D6D3D1]" />}
                        {item.finish && <span>{item.finish}</span>}
                      </div>

                      {/* Mandatory delivery charge note */}
                      {itemFlags(item).delivery_charge_required && Number(itemFlags(item).delivery_charge) > 0 && (
                        <p className="text-[11px] text-amber-700 font-medium mt-1 flex items-center gap-1" data-testid={`cart-delivery-note-${item.slug || item.id}`}>
                          <Truck className="w-3 h-3" />
                          £{Number(itemFlags(item).delivery_charge).toFixed(2)} delivery charge applies to this item
                        </p>
                      )}
                      {itemFlags(item).parcel_delivery && (
                        <p className="text-[11px] text-sky-700 mt-0.5 flex items-center gap-1" data-testid={`cart-parcel-note-${item.slug || item.id}`}>
                          <Package className="w-3 h-3" />
                          Ships as a parcel
                        </p>
                      )}
                      
                      {/* Pallet tier badge — only when this line was added at a half/full pallet rate */}
                      {(item.pallet_tier === 'half_pallet' || item.pallet_tier === 'full_pallet') && (
                        <div
                          className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 bg-emerald-50 border border-emerald-200 rounded-md"
                          data-testid={`cart-pallet-tier-${item.slug}`}
                        >
                          <Package className="w-3 h-3 text-emerald-700" />
                          <span className="text-[11px] font-semibold text-emerald-800">
                            {item.pallet_tier === 'full_pallet' ? 'Full Pallet' : 'Half Pallet'} rate
                          </span>
                        </div>
                      )}
                      
                      <div className="text-[#1C1917] font-bold mt-2 text-base">
                        &pound;{getEffectivePrice(item, isTrade, tradeDiscount).toFixed(2)}
                        <span className="text-xs text-[#78716C] font-medium ml-1">{item.is_surface_product !== false ? '/ m²' : '/ each'}</span>
                        {isTrade && <span className="text-[10px] text-[#A8A29E] font-normal ml-1">ex. VAT</span>}
                      </div>
                      
                      {/* Rich quantity context: "2 m² · 3 boxes" */}
                      <div className="mt-2 inline-flex items-center px-2 py-1 bg-[#F3F0EB] rounded-md border border-[#E7E5E4]" data-testid={`cart-qty-context-${item.slug}`}>
                        <span className="font-mono text-[11px] tracking-tight text-[#44403C]">{formatCartQuantity(item)}</span>
                      </div>

                      {/* Tier upsell nudge — "Add 1 box to unlock 5% off" */}
                      {(() => {
                        const upsell = getTierUpsell(item);
                        if (!upsell) return null;
                        return (
                          <motion.button
                            type="button"
                            whileHover={{ scale: 1.02 }}
                            whileTap={{ scale: 0.98 }}
                            data-testid={`tier-upsell-${item.slug}`}
                            onClick={() => updateQuantity(item.id, item.priceType, upsell.newQuantity)}
                            className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-800 bg-gradient-to-r from-emerald-50 to-[#FFF9E5] hover:from-emerald-100 border border-emerald-300 rounded-full pl-2 pr-3 py-1.5 transition-colors shadow-sm"
                            title={`Click to add ${upsell.boxesNeeded} box${upsell.boxesNeeded === 1 ? '' : 'es'} (${upsell.sqmNeeded} m²) and unlock the ${upsell.nextDiscountPercent}% tier discount`}
                          >
                            <Gift className="w-3.5 h-3.5" />
                            Add {upsell.boxesNeeded} box{upsell.boxesNeeded === 1 ? '' : 'es'} ({upsell.sqmNeeded} m²) to unlock {upsell.nextDiscountPercent}% off
                          </motion.button>
                        );
                      })()}

                      {/* Quantity & Remove - Mobile */}
                      <div className="flex items-center justify-between mt-4 md:hidden">
                        <div className="flex items-center gap-1 bg-white border border-[#E7E5E4] rounded-lg px-1 py-0.5 shadow-sm">
                          <motion.button whileTap={{ scale: 0.9 }} 
                            onClick={() => updateQuantity(item.id, item.priceType, snapCartQuantity(item, item.quantity - getCartStepSize(item)))}
                            className="w-8 h-8 rounded flex items-center justify-center text-[#78716C] hover:text-[#1C1917] hover:bg-[#F3F0EB] transition-colors"
                          >
                            <Minus className="h-4 w-4" />
                          </motion.button>
                          <Input
                            type="number"
                            step={getCartStepSize(item)}
                            value={item.quantity}
                            onChange={(e) => updateQuantity(item.id, item.priceType, snapCartQuantity(item, parseFloat(e.target.value) || getCartStepSize(item)))}
                            className="w-14 text-center border-0 tabular-nums font-semibold text-[#1C1917] p-0 h-8"
                            min={getCartStepSize(item)}
                          />
                          <motion.button whileTap={{ scale: 0.9 }}
                            onClick={() => updateQuantity(item.id, item.priceType, snapCartQuantity(item, item.quantity + getCartStepSize(item)))}
                            className="w-8 h-8 rounded flex items-center justify-center text-[#78716C] hover:text-[#1C1917] hover:bg-[#F3F0EB] transition-colors"
                          >
                            <Plus className="h-4 w-4" />
                          </motion.button>
                        </div>
                        
                        <button 
                          onClick={() => removeFromCart(item.id, item.priceType)}
                          className="p-2 text-[#A8A29E] hover:text-red-500 transition-colors"
                          data-testid={`remove-item-${item.slug}-mobile`}
                          aria-label="Remove item"
                        >
                          <Trash2 className="h-5 w-5" />
                        </button>
                      </div>
                    </div>

                    {/* Quantity - Desktop */}
                    <div className="hidden md:flex items-start gap-4">
                      <div className="flex flex-col items-center">
                        <div className="flex items-center gap-1 bg-white border border-[#E7E5E4] rounded-lg px-1 py-0.5 shadow-sm">
                          <motion.button whileTap={{ scale: 0.9 }}
                            onClick={() => updateQuantity(item.id, item.priceType, snapCartQuantity(item, item.quantity - getCartStepSize(item)))}
                            className="w-8 h-8 rounded flex items-center justify-center text-[#78716C] hover:text-[#1C1917] hover:bg-[#F3F0EB] transition-colors"
                          >
                            <Minus className="h-4 w-4" />
                          </motion.button>
                          <Input
                            type="number"
                            step={getCartStepSize(item)}
                            value={item.quantity}
                            onChange={(e) => updateQuantity(item.id, item.priceType, snapCartQuantity(item, parseFloat(e.target.value) || getCartStepSize(item)))}
                            className="w-14 text-center border-0 tabular-nums font-semibold text-[#1C1917] p-0 h-8"
                            min={getCartStepSize(item)}
                          />
                          <motion.button whileTap={{ scale: 0.9 }}
                            onClick={() => updateQuantity(item.id, item.priceType, snapCartQuantity(item, item.quantity + getCartStepSize(item)))}
                            className="w-8 h-8 rounded flex items-center justify-center text-[#78716C] hover:text-[#1C1917] hover:bg-[#F3F0EB] transition-colors"
                          >
                            <Plus className="h-4 w-4" />
                          </motion.button>
                        </div>
                        {item.pricing_unit !== 'unit' && item.sqm_per_box > 0 && (
                          <p className="text-[10px] text-[#A8A29E] mt-1.5 tracking-wide">
                            +/- 1 box = {item.sqm_per_box} m²
                          </p>
                        )}
                      </div>
                      
                      <div className="w-24 text-right">
                        <p className="font-bold text-lg text-[#1C1917] tabular-nums">&pound;{(getEffectivePrice(item, isTrade, tradeDiscount) * (item.quantity || 0)).toFixed(2)}</p>
                      </div>
                      
                      <button 
                        onClick={() => removeFromCart(item.id, item.priceType)}
                        className="p-2 text-[#A8A29E] hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                        data-testid={`remove-item-${item.slug}`}
                        aria-label="Remove item"
                      >
                        <Trash2 className="h-5 w-5" />
                      </button>
                    </div>
                  </div>

                  {/* Tier savings strip — full-line-width itemisation of every
                      £ of discount applied. Sits BELOW the image+details+qty
                      flex row so it gets the full card width. Only renders
                      when there's a real saving; quotable receipt-style proof
                      for trade customers passing on quotes to end-clients. */}
                  {(() => {
                    const qty = Number(item.quantity) || 0;
                    if (qty <= 0) return null;
                    const retail = getRetailIncVat(item, tradeDiscount);
                    const tierPct = getActiveTierDiscount(item);
                    const tradePct = isTrade ? (Number(item.trade_discount || tradeDiscount) || 0) : 0;
                    if (tierPct === 0 && tradePct === 0) return null;
                    // Compound savings — mirrors what getEffectivePrice computes.
                    const retailLine = retail * qty;
                    const afterTierLine = retailLine * (1 - tierPct / 100);
                    const tierSaved = retailLine - afterTierLine;
                    const afterTradeLine = afterTierLine * (1 - tradePct / 100);
                    const tradeSaved = afterTierLine - afterTradeLine;
                    const totalSaved = tierSaved + tradeSaved;
                    if (totalSaved < 0.01) return null;
                    return (
                      <div
                        data-testid={`tier-savings-strip-${item.slug}`}
                        className="mt-3 px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg text-[11px] leading-tight"
                      >
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-emerald-900">
                          {tierPct > 0 && (
                            <span className="inline-flex items-center gap-1">
                              <span className="font-semibold">Volume tier −{tierPct}%</span>
                              <span className="text-emerald-700 tabular-nums">(−£{tierSaved.toFixed(2)})</span>
                            </span>
                          )}
                          {tierPct > 0 && tradePct > 0 && (
                            <span className="text-emerald-400 font-bold">+</span>
                          )}
                          {tradePct > 0 && (
                            <span className="inline-flex items-center gap-1">
                              <span className="font-semibold">Trade −{tradePct}%</span>
                              <span className="text-emerald-700 tabular-nums">(−£{tradeSaved.toFixed(2)})</span>
                            </span>
                          )}
                          <span className="text-emerald-400 font-bold">=</span>
                          <span className="font-bold text-emerald-900 tabular-nums">
                            You saved £{totalSaved.toFixed(2)} on this line
                          </span>
                        </div>
                      </div>
                    );
                  })()}
                </motion.div>
              ))}
              </AnimatePresence>
            </motion.div>

            {/* Cart Actions */}
            <div className="flex flex-wrap gap-3 mt-6">
              <Button
                variant="outline"
                onClick={() => navigate('/tiles')}
                className="flex items-center gap-2 border-[#E7E5E4] text-[#44403C] hover:bg-[#F3F0EB] hover:text-[#1C1917]"
              >
                <ArrowLeft className="h-4 w-4" />
                Continue Shopping
              </Button>
              <Button
                variant="outline"
                onClick={clearCart}
                className="text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
              >
                Clear Basket
              </Button>
            </div>
          </div>

          {/* Order Summary — Modern Receipt */}
          <div className="lg:col-span-5">
            <div className="sticky top-24 space-y-3">
              <CartSaveBanner />
              <div className="bg-[#F3F0EB] rounded-2xl border border-[#E7E5E4] overflow-hidden shadow-[0_1px_3px_rgba(28,25,23,0.04)]">
              {/* Receipt header strip */}
              <div className="bg-[#1C1917] text-[#F7EA1C] px-6 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <ShoppingBag className="w-4 h-4" />
                  <h2 className="text-[13px] font-bold tracking-tight" data-testid="order-summary-heading">Order Summary</h2>
                </div>
                <span className="text-[10px] font-semibold tracking-[0.08em] uppercase text-[#F7EA1C]/80">
                  {cart.length} {cart.length === 1 ? 'item' : 'items'}
                </span>
              </div>

              <div className="p-6 space-y-4">
                {/* Free sample upsell — only when admin enabled */}
                {sampleEnabled && !isCollection && (
                  sampleUnlocked ? (
                    <motion.div
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="bg-gradient-to-r from-amber-50 to-emerald-50 border border-emerald-200 rounded-xl p-3"
                      data-testid="free-sample-unlocked"
                    >
                      <p
                        className="text-[12px] font-medium text-emerald-900 leading-snug"
                        dangerouslySetInnerHTML={{ __html: renderSampleText(sampleUnlockedText) }}
                      />
                    </motion.div>
                  ) : (
                    <div className="bg-white rounded-xl p-4 border border-dashed border-amber-300" data-testid="free-sample-nudge">
                      <div className="flex items-center justify-between text-[12px] text-[#1C1917] mb-2 gap-3">
                        <span
                          className="flex-1 leading-snug"
                          dangerouslySetInnerHTML={{ __html: renderSampleText(freeSample.locked_text) }}
                        />
                        <span className="text-amber-700 font-bold text-lg flex-shrink-0" aria-hidden>🎁</span>
                      </div>
                      <div className="h-1.5 w-full bg-[#F3F0EB] rounded-full overflow-hidden">
                        <motion.div
                          initial={false}
                          animate={{ width: `${sampleProgress}%` }}
                          transition={{ duration: 0.6, ease: 'easeOut' }}
                          className="h-full bg-gradient-to-r from-amber-400 to-amber-600 rounded-full"
                        />
                      </div>
                    </div>
                  )
                )}

                {/* Free delivery progress */}
                {!isCollection && subtotal < freeThreshold && (
                  <div className="bg-white rounded-xl p-4 border border-[#E7E5E4]" data-testid="free-delivery-progress-wrap">
                    <div className="flex items-center justify-between text-[12px] font-medium text-[#1C1917] mb-2">
                      <span className="flex items-center gap-1.5">
                        <Truck className="w-3.5 h-3.5 text-[#78716C]" />
                        <span>Spend <strong>£{safeToFixed(amountToFree, 2)}</strong> more for</span>
                      </span>
                      <span className="text-emerald-700 font-bold">FREE delivery</span>
                    </div>
                    <div className="h-2 w-full bg-[#F3F0EB] rounded-full overflow-hidden">
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
                {!isCollection && subtotal >= freeThreshold && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="bg-gradient-to-r from-emerald-50 to-[#F3F0EB] border border-emerald-200 rounded-xl p-3 flex items-center gap-2.5" data-testid="free-delivery-qualified"
                  >
                    <motion.div initial={{ scale: 0, rotate: -45 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', damping: 12 }}>
                      <Gift className="w-5 h-5 text-emerald-600" />
                    </motion.div>
                    <div>
                      <p className="text-sm font-semibold text-emerald-900">You qualify for FREE delivery</p>
                      <p className="text-[11px] text-emerald-700/80">Saved £{safeToFixed(defaultDeliveryFee, 2)} on shipping</p>
                    </div>
                  </motion.div>
                )}
                {!isCollection && deliveryTerms && (
                  <p className="text-[10px] text-[#A8A29E] leading-snug px-1" data-testid="delivery-exclusion-smallprint">
                    {deliveryTerms}
                  </p>
                )}

                <div className="flex justify-between items-baseline pt-1" data-testid="cart-subtotal">
                  <span className="text-[13px] text-[#78716C]">Subtotal{isTrade ? ' (ex. VAT)' : ''}</span>
                  <span className="font-semibold text-[#1C1917] tabular-nums">&pound;{subtotal.toFixed(2)}</span>
                </div>

                {/* Delivery Method Selector */}
                <div className="bg-white border border-[#E7E5E4] rounded-xl overflow-hidden" data-testid="delivery-method-selector">
                  <button
                    onClick={() => setDeliveryMethod('delivery')}
                    className={`w-full flex items-center gap-3 px-3 py-3 text-left transition-all ${
                      deliveryMethod === 'delivery' ? 'bg-[#FFF9E5] border-l-[3px] border-l-[#FFD100]' : 'hover:bg-[#F9F8F6]'
                    }`}
                    data-testid="delivery-option"
                  >
                    <Truck className={`h-4 w-4 ${deliveryMethod === 'delivery' ? 'text-[#1C1917]' : 'text-[#A8A29E]'}`} />
                    <span className={`flex-1 font-semibold text-sm ${deliveryMethod === 'delivery' ? 'text-[#1C1917]' : 'text-[#78716C]'}`}>Delivery</span>
                    <span className="font-semibold text-sm">
                      {subtotal >= deliveryThreshold ? (
                        <span className="text-emerald-600">FREE</span>
                      ) : (
                        <span className="text-[#1C1917] tabular-nums">&pound;{safeToFixed(defaultDeliveryFee, 2)}</span>
                      )}
                    </span>
                  </button>
                  <button
                    onClick={() => setDeliveryMethod('collection')}
                    className={`w-full flex items-center gap-3 px-3 py-3 text-left transition-all border-t border-[#E7E5E4] ${
                      deliveryMethod === 'collection' ? 'bg-[#FFF9E5] border-l-[3px] border-l-[#FFD100]' : 'hover:bg-[#F9F8F6]'
                    }`}
                    data-testid="collection-option"
                  >
                    <Store className={`h-4 w-4 ${deliveryMethod === 'collection' ? 'text-[#1C1917]' : 'text-[#A8A29E]'}`} />
                    <span className={`flex-1 font-semibold text-sm ${deliveryMethod === 'collection' ? 'text-[#1C1917]' : 'text-[#78716C]'}`}>Collect from Store</span>
                    <span className="text-emerald-600 font-semibold text-sm">FREE</span>
                  </button>
                </div>

                {/* Store Selector (when collection is selected) */}
                {isCollection && stores.length > 0 && (
                  <div className="bg-white border border-[#E7E5E4] rounded-xl p-3 space-y-2" data-testid="store-selector">
                    <label className="text-[10px] font-semibold tracking-[0.08em] uppercase text-[#78716C]">Collect from</label>
                    <div className="relative">
                      <select
                        value={selectedStore?.id || selectedStore?.name || ''}
                        onChange={(e) => {
                          const store = stores.find(s => (s.id || s.name) === e.target.value);
                          setSelectedStore(store);
                        }}
                        className="w-full px-3 py-2 pr-8 border border-[#E7E5E4] rounded-md text-sm bg-white appearance-none cursor-pointer focus:ring-2 focus:ring-[#1C1917]/20 focus:border-[#1C1917]"
                        data-testid="store-select-dropdown"
                      >
                        {stores.map((store) => (
                          <option key={store.id || store.name} value={store.id || store.name}>
                            {store.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-[#A8A29E] pointer-events-none" />
                    </div>
                    {selectedStore && (
                      <div className="text-[11px] text-[#78716C] space-y-1 pt-1">
                        {selectedStore.address && (
                          <div className="flex items-start gap-1.5">
                            <MapPin className="h-3 w-3 mt-0.5 text-[#A8A29E] flex-shrink-0" />
                            <span>{selectedStore.address}</span>
                          </div>
                        )}
                        {selectedStore.phone && (
                          <div className="flex items-center gap-1.5">
                            <Phone className="h-3 w-3 text-[#A8A29E] flex-shrink-0" />
                            <span>{selectedStore.phone}</span>
                          </div>
                        )}
                        {selectedStore.opening_hours && (
                          <div className="flex items-center gap-1.5">
                            <Clock className="h-3 w-3 text-[#A8A29E] flex-shrink-0" />
                            <span>Mon-Fri: {selectedStore.opening_hours.monday || '7:30 - 17:30'}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Totals — dashed receipt divider */}
                <div className="pt-4 border-t border-dashed border-[#D6D3D1] space-y-2.5">
                  {isTrade ? (
                    <>
                      <div className="flex justify-between text-sm" data-testid="total-ex-vat">
                        <span className="text-[#78716C]">Total (ex. VAT)</span>
                        <span className="font-semibold text-[#1C1917] tabular-nums">&pound;{totalExVat.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-sm" data-testid="vat-amount">
                        <span className="text-[#78716C]">VAT (20%)</span>
                        <span className="font-semibold text-[#1C1917] tabular-nums">&pound;{vatAmount.toFixed(2)}</span>
                      </div>
                    </>
                  ) : null}
                </div>

                {/* Grand Total — hero row */}
                <div className="pt-3 border-t-2 border-dashed border-[#1C1917]/20 flex items-end justify-between" data-testid={isTrade ? 'total-inc-vat' : 'total-regular'}>
                  <div>
                    <p className="text-[10px] font-semibold tracking-[0.1em] uppercase text-[#78716C]">Total {isTrade ? '(inc. VAT)' : ''}</p>
                    <p className="text-[11px] text-[#A8A29E] mt-0.5">{isTrade ? 'Trade prices shown ex. VAT above' : 'Including VAT'}</p>
                  </div>
                  <motion.p
                    key={(isTrade ? totalIncVat : totalExVat).toFixed(2)}
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="text-3xl font-bold text-[#1C1917] tracking-tight tabular-nums"
                  >
                    &pound;{(isTrade ? totalIncVat : totalExVat).toFixed(2)}
                  </motion.p>
                </div>

                {/* Cart-level savings strip — aggregates volume tier + trade
                    discount across every line into one screenshot-worthy
                    figure customers can forward to their accounts team. */}
                {(() => {
                  let totalRetail = 0;
                  let totalSaved = 0;
                  let linesWithSavings = 0;
                  for (const item of cart) {
                    const qty = Number(item.quantity) || 0;
                    if (qty <= 0) continue;
                    const retail = getRetailIncVat(item, tradeDiscount);
                    const tierPct = getActiveTierDiscount(item);
                    const tradePct = isTrade ? (Number(item.trade_discount || tradeDiscount) || 0) : 0;
                    const retailLine = retail * qty;
                    totalRetail += retailLine;
                    if (tierPct === 0 && tradePct === 0) continue;
                    const afterTier = retailLine * (1 - tierPct / 100);
                    const afterTrade = afterTier * (1 - tradePct / 100);
                    totalSaved += retailLine - afterTrade;
                    if (retailLine - afterTrade >= 0.01) linesWithSavings++;
                  }
                  if (totalSaved < 0.01 || totalRetail < 0.01) return null;
                  const pctOff = Math.round((totalSaved / totalRetail) * 100);
                  return (
                    <div
                      data-testid="cart-savings-summary"
                      className="mt-3 px-4 py-3 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-xl shadow-md flex items-center justify-between gap-3"
                    >
                      <div className="flex items-start gap-2.5 min-w-0">
                        <Gift className="w-5 h-5 text-emerald-100 flex-shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-100">Total savings</p>
                          <p className="text-[13px] font-bold leading-tight">
                            Volume + Trade discounts saved you{' '}
                            <span className="tabular-nums">£{totalSaved.toFixed(2)}</span>
                          </p>
                          <p className="text-[11px] text-emerald-100 mt-0.5">
                            across {linesWithSavings} line{linesWithSavings === 1 ? '' : 's'} · {pctOff}% off retail
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })()}

                {/* Credit Back (trade users only) */}
                {isTrade && creditBackAmount > 0 && (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3" data-testid="credit-back-section">
                    <div className="flex items-center gap-2 mb-1">
                      <Gift className="h-4 w-4 text-emerald-600" />
                      <span className="text-sm font-semibold text-emerald-900">Credit Back Earned</span>
                    </div>
                    <div className="flex justify-between items-baseline">
                      <span className="text-[11px] text-emerald-700/80">
                        on ex. VAT product total (&pound;{subtotal.toFixed(2)})
                      </span>
                      <span className="text-lg font-bold text-emerald-700 tabular-nums" data-testid="credit-back-amount">
                        &pound;{creditBackAmount.toFixed(2)}
                      </span>
                    </div>
                    <p className="text-[10px] text-emerald-600 mt-1">Credit back is applied to your trade account balance</p>
                  </div>
                )}

                {/* Saved vs Retail (trade users only) */}
                {isTrade && savedVsRetail > 0 && (
                  <TooltipProvider delayDuration={150}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="w-full bg-[#FFF9E5] border border-[#FFD100]/40 rounded-xl p-3 text-left cursor-help hover:bg-[#FFF5D1] transition-colors focus:outline-none focus:ring-2 focus:ring-amber-400/40"
                          data-testid="saved-vs-retail-section"
                          aria-label="See how your trade savings break down"
                        >
                          <div className="flex justify-between items-baseline">
                            <span className="text-sm font-semibold text-[#1C1917] flex items-center gap-1">
                              Saved vs retail
                              <span className="text-[10px] text-amber-700/70 leading-none">ⓘ</span>
                            </span>
                            <span className="text-lg font-bold text-amber-700 tabular-nums" data-testid="saved-vs-retail-amount">
                              &pound;{savedVsRetail.toFixed(2)}
                            </span>
                          </div>
                          <p className="text-[10px] text-amber-700 mt-0.5">
                            That&apos;s {Math.round((savedVsRetail / (subtotal + savedVsRetail)) * 100)}% off the retail inc. VAT price
                          </p>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs bg-gray-900 text-white border-gray-800 p-3" data-testid="saved-vs-retail-tooltip">
                        <p className="font-bold text-sm mb-1.5">Your trade savings on this basket</p>
                        <p className="text-xs text-white/80 leading-snug">
                          Compared to what a retail customer would pay (inc. VAT) for the same items.
                        </p>
                        {savingsBreakdown.length > 0 && (
                          <div className="mt-2 space-y-0.5 text-xs font-mono">
                            {savingsBreakdown.map((row) => (
                              <div key={row.name} className="flex justify-between gap-3">
                                <span className="text-white/70 truncate max-w-[180px]">{row.name}</span>
                                <span className="text-amber-300 shrink-0">−£{safeToFixed(row.saved, 2)}</span>
                              </div>
                            ))}
                            {cart.length > savingsBreakdown.length && (
                              <div className="text-[10px] text-white/40 italic">
                                +{cart.length - savingsBreakdown.length} other line{cart.length - savingsBreakdown.length === 1 ? '' : 's'}
                              </div>
                            )}
                            <div className="flex justify-between gap-3 pt-1 mt-1 border-t border-white/15 font-bold">
                              <span>Total saved</span>
                              <span className="text-emerald-300">−£{savedVsRetail.toFixed(2)}</span>
                            </div>
                          </div>
                        )}
                        <p className="mt-2 text-[10px] text-white/50">VAT (20%) is added at checkout — your trade rate already removes it from line prices.</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}

                {/* Apple Pay / Google Pay — above Proceed to Checkout. Renders nothing
                    unless the admin has enabled it AND the browser has one of the wallets.
                    When visible, it is the single fastest path to payment (one tap). */}
                {!isCollection && !maintCountdown.blocking && (
                  <WalletExpressButton
                    cart={cart}
                    total={totalIncVat}
                    enabled={walletExpressEnabled}
                    onSuccess={(orderId) => navigate(`/shop/order-success?order_id=${orderId}`)}
                  />
                )}

                {/* Maintenance imminent? Warn (or block) above the CTA. */}
                <CheckoutMaintenanceWarning context="cart" />

                <motion.div whileHover={!maintCountdown.blocking ? { y: -2 } : undefined} whileTap={!maintCountdown.blocking ? { scale: 0.98 } : undefined}>
                  <Button
                    className="w-full bg-[#1C1917] hover:bg-[#292524] text-[#F7EA1C] font-semibold mt-2 py-6 text-base shadow-lg transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                    onClick={() => navigate('/shop/tile-checkout')}
                    disabled={maintCountdown.blocking}
                    data-testid="proceed-to-checkout-btn"
                  >
                    {maintCountdown.blocking ? (
                      <>
                        <Lock className="mr-2 h-4 w-4" />
                        Checkout closed — back online soon
                      </>
                    ) : (
                      <>
                        Proceed to Checkout
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </Button>
                </motion.div>

                {/* Express Checkout buttons — shown when enabled by admin */}
                {((klarnaCheckoutEnabled && totalIncVat >= 30) || paypalCheckoutEnabled) && !isCollection && !maintCountdown.blocking && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-3 my-1">
                      <div className="flex-1 h-px bg-[#E7E5E4]"></div>
                      <span className="text-[10px] text-[#A8A29E] uppercase tracking-[0.1em] font-semibold">or pay in one tap</span>
                      <div className="flex-1 h-px bg-[#E7E5E4]"></div>
                    </div>

                    {klarnaCheckoutEnabled && totalIncVat >= 30 && (
                      <>
                        <button
                          type="button"
                          data-testid="klarna-express-btn"
                          onClick={handleKlarnaExpress}
                          disabled={expressLoading || paypalLoading}
                          className="w-full flex items-center justify-center gap-2 bg-[#FFA8CD] hover:bg-[#ff94c0] disabled:opacity-60 disabled:cursor-wait text-black font-semibold py-4 rounded-xl transition-colors shadow-sm"
                        >
                          {expressLoading ? (
                            <>
                              <span className="inline-block h-4 w-4 border-2 border-black/30 border-t-black rounded-full animate-spin"></span>
                              Redirecting to Klarna…
                            </>
                          ) : (
                            <>
                              <span>Express Checkout with</span>
                              <span className="font-bold text-base">Klarna</span>
                              <ArrowRight className="h-4 w-4" />
                            </>
                          )}
                        </button>
                        <p className="text-[11px] text-center text-[#78716C] leading-relaxed">
                          Pay in 3 interest-free instalments. Standard delivery only.
                        </p>
                      </>
                    )}

                    {paypalCheckoutEnabled && (
                      <>
                        <button
                          type="button"
                          data-testid="paypal-express-btn"
                          onClick={handlePaypalExpress}
                          disabled={paypalLoading || expressLoading}
                          className="w-full flex items-center justify-center gap-2 bg-[#FFC439] hover:bg-[#F5B72E] disabled:opacity-60 disabled:cursor-wait text-[#003087] font-semibold py-4 rounded-xl transition-colors shadow-sm border border-[#F5B72E]/40"
                        >
                          {paypalLoading ? (
                            <>
                              <span className="inline-block h-4 w-4 border-2 border-[#003087]/30 border-t-[#003087] rounded-full animate-spin"></span>
                              Redirecting to PayPal…
                            </>
                          ) : (
                            <>
                              <span>Express Checkout with</span>
                              <span className="font-black italic text-base tracking-tight">
                                <span className="text-[#003087]">Pay</span><span className="text-[#009CDE]">Pal</span>
                              </span>
                              <ArrowRight className="h-4 w-4" />
                            </>
                          )}
                        </button>
                        <p className="text-[11px] text-center text-[#78716C] leading-relaxed">
                          Skip the form. PayPal fills in your details. Standard delivery only.
                        </p>
                      </>
                    )}
                  </div>
                )}

                <div className="pt-2 flex items-center justify-center gap-1.5 text-[10px] text-[#78716C]">
                  <Lock className="w-3 h-3" />
                  <span>Secure checkout powered by Stripe</span>
                </div>
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

export default TileCartPage;
