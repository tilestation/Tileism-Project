import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useTradeUser } from '../hooks/useTradeUser';
import { getEffectiveSubtotal } from '../utils/cartPricing';
import { safeToFixed } from '../utils/safeStr';
import { pinterestAddToCart } from '../lib/pinterest';

const CartContext = createContext();

export const useCart = () => {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
};

// Load and validate cart from localStorage synchronously
const loadCartFromStorage = () => {
  try {
    const savedCart = localStorage.getItem('tilestation_cart');
    if (savedCart) {
      const parsedCart = JSON.parse(savedCart);
      const validCart = parsedCart.filter(item => {
        const hasValidPrice = typeof item.price === 'number' && !isNaN(item.price) && item.price > 0;
        const hasValidQuantity = typeof item.quantity === 'number' && !isNaN(item.quantity) && item.quantity > 0;
        const hasId = item.id;
        return hasValidPrice && hasValidQuantity && hasId;
      });
      return validCart;
    }
  } catch (e) {
    console.error('Error loading cart:', e);
    localStorage.removeItem('tilestation_cart');
  }
  return [];
};

export const TileCartProvider = ({ children }) => {
  const [cart, setCart] = useState(loadCartFromStorage);
  const [isOpen, setIsOpen] = useState(false);

  // Save cart to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('tilestation_cart', JSON.stringify(cart));
  }, [cart]);

  // One-time heal: older cart lines may carry a stale pricing_unit ('m2' for
  // unit-priced products). Re-resolve from live product data so every page
  // (basket, checkout, savings math) shows the right unit.
  useEffect(() => {
    const ids = [...new Set(cart.map(i => String(i.id || i.product_id || '')).filter(Boolean))];
    if (ids.length === 0) return;
    fetch(`${process.env.REACT_APP_BACKEND_URL}/api/shop/delivery-flags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const flags = d?.flags || {};
        setCart(prev => {
          let changed = false;
          const next = prev.map(item => {
            const f = flags[String(item.id || item.product_id || '')];
            if (f?.pricing_unit && f.pricing_unit !== item.pricing_unit) {
              changed = true;
              return { ...item, pricing_unit: f.pricing_unit };
            }
            return item;
          });
          return changed ? next : prev;
        });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addToCart = (tile, quantity = 1, priceType = 'room_lot') => {
    setCart(prevCart => {
      // Handle both call patterns:
      // 1. addToCart({...item with price already set}, quantity, priceType)
      // 2. addToCart({...tile with room_lot_price/pallet_price}, quantity, priceType)
      
      const existingIndex = prevCart.findIndex(
        item => item.id === tile.id && item.priceType === (tile.priceType || priceType)
      );

      if (existingIndex > -1) {
        // Update quantity if item exists
        const newCart = [...prevCart];
        // If quantity is passed in tile object (from CollectionDetailPage), use that
        const addQuantity = tile.quantity || quantity;
        newCart[existingIndex].quantity += addQuantity;
        if (!tile.silent) {
          const mergedUnit = (newCart[existingIndex].pricing_unit || tile.pricing_unit || 'm2') === 'unit'
            ? (Number(newCart[existingIndex].quantity) === 1 ? ' unit' : ' units')
            : 'm²';
          toast.success(`Updated quantity to ${newCart[existingIndex].quantity}${mergedUnit}`);
        }
        return newCart;
      } else {
        // Add new item
        // Support both direct price and price type lookup
        let price = tile.price;
        if (price === undefined || price === null) {
          price = priceType === 'pallet' ? tile.pallet_price : tile.room_lot_price;
        }
        
        // Ensure price is a valid number
        if (typeof price !== 'number' || isNaN(price)) {
          console.error('Invalid price for cart item:', tile);
          toast.error('Unable to add item - price unavailable');
          return prevCart;
        }

        // Canonical retail (inc-VAT) price — this is the SOURCE OF TRUTH used to
        // re-derive trade ex-VAT prices live whenever the user logs in/out as trade.
        // Caller MAY pass it explicitly; if not, infer it from the price they sent
        // depending on whether they added it as a trade user.
        let retailIncVat = tile.retail_price_inc_vat;
        if (typeof retailIncVat !== 'number' || isNaN(retailIncVat)) {
          if (tile.isTrade) {
            // tile.price was already trade-discounted + ex-VAT; reverse it.
            const td = Number(tile.trade_discount) || 0;
            retailIncVat = td > 0 && td < 100
              ? Math.round((price * 1.20 / (1 - td / 100)) * 100) / 100
              : Math.round(price * 1.20 * 100) / 100;
          } else {
            retailIncVat = price;
          }
        }

        // Handle quantity from tile object (CollectionDetailPage) or parameter
        const itemQuantity = tile.quantity || quantity;
        
        const palletTierMsg = tile.pallet_tier === 'full_pallet'
          ? ` (Full Pallet)`
          : tile.pallet_tier === 'half_pallet'
            ? ` (Half Pallet)`
            : '';
        const unitLabel = tile.pricing_unit === 'unit'
          ? (Number(itemQuantity) === 1 ? ' unit' : ' units')
          : 'm²';
        if (!tile.silent) toast.success(`Added ${itemQuantity}${unitLabel}${palletTierMsg} to cart`);
        return [...prevCart, {
          id: tile.id,
          slug: tile.slug,
          supplier_code: tile.supplier_code,
          display_name: tile.display_name || tile.name,
          image: tile.image || tile.images?.[0] || '',
          price: price,
          retail_price_inc_vat: retailIncVat,
          priceType: tile.priceType || priceType,
          // Pallet tier is null for per-m² lines, 'half_pallet' / 'full_pallet'
          // for pallet-rate lines. Used by basket UI to show the tier badge.
          pallet_tier: tile.pallet_tier || null,
          // Minimum basket quantity for pallet-rate lines (steppers clamp to this)
          pallet_min_qty: tile.pallet_min_qty || null,
          quantity: itemQuantity,
          size: tile.size,
          finish: tile.finish,
          color: tile.color,
          coverage: tile.coverage,
          boxes: tile.boxes,
          supplier: tile.supplier,
          // Unit metadata — lets the basket & checkout show "2 m² · 3 boxes" instead of plain "2"
          sqm_per_box: tile.sqm_per_box || tile.box_m2_coverage || null,
          tiles_per_box: tile.tiles_per_box || null,
          pricing_unit: tile.pricing_unit || 'm2',
          // Tier discount config — powers "add 1 more box to save X%" upsell nudge
          tier_thresholds: tile.tier_thresholds || null,
          tier_discounts: tile.tier_discounts || null,
          tier_pricing_disabled: !!tile.tier_pricing_disabled,
          was_price: tile.was_price || null,
          list_price: tile.list_price || null,
          // Trade attribution at the moment of add — used for "Saved vs retail" math.
          // trade_discount_type MUST persist so cartPricing.getEffectivePrice knows
          // whether trade_discount is a fixed £ amount or a percent.
          trade_discount: tile.trade_discount || null,
          trade_discount_type: tile.trade_discount_type || null,
          isTrade: !!tile.isTrade,
          credit_back_rate: tile.credit_back_rate || null,
        }];
      }
    });
    // ── Pinterest conversion tracking ──────────────────────────────
    // Fire AddToCart AFTER setCart succeeds. The actual value passed to
    // Pinterest is the line subtotal (price × qty) so the dashboard
    // shows accurate ROAS. No-op until tag id is configured.
    try {
      const price = (typeof tile.price === 'number') ? tile.price : (tile.room_lot_price || 0);
      const q = tile.quantity || quantity || 1;
      pinterestAddToCart({
        product_id: tile.supplier_code || tile.id || tile.slug,
        product_name: tile.display_name || tile.name,
        product_category: tile.category || tile.series_name,
        value: Number(price) * Number(q),
        quantity: q,
      });
    } catch { /* analytics never throws */ }
  };

  const removeFromCart = (itemId, priceType) => {
    setCart(prevCart => prevCart.filter(
      item => !(item.id === itemId && item.priceType === priceType)
    ));
    toast.success('Item removed from cart');
  };

  const updateQuantity = (itemId, priceType, newQuantity) => {
    if (newQuantity < 1) {
      removeFromCart(itemId, priceType);
      return;
    }

    setCart(prevCart => prevCart.map(item => {
      if (item.id === itemId && item.priceType === priceType) {
        return { ...item, quantity: newQuantity };
      }
      return item;
    }));
  };

  const clearCart = () => {
    setCart([]);
    toast.success('Cart cleared');
  };

  const getCartTotal = () => {
    return cart.reduce((total, item) => {
      const itemPrice = typeof item.price === 'number' && !isNaN(item.price) ? item.price : 0;
      const itemQuantity = typeof item.quantity === 'number' && !isNaN(item.quantity) ? item.quantity : 0;
      return total + (itemPrice * itemQuantity);
    }, 0);
  };

  // Header badge count — use number of distinct line items, not the summed m²
  // (summing floats like 1.2 + 2.3 produced "5.939999999995" in the badge).
  const getCartItemCount = () => cart.length;

  const value = {
    cart,
    isOpen,
    setIsOpen,
    addToCart,
    removeFromCart,
    updateQuantity,
    clearCart,
    getCartTotal,
    getCartItemCount
  };

  return (
    <CartContext.Provider value={value}>
      <TradeRepriceWatcher cart={cart} />
      {children}
    </CartContext.Provider>
  );
};

/**
 * Internal watcher that fires a toast when the trade auth status changes
 * while the cart has items. Lives inside the provider so EVERY page that
 * uses TileCartProvider gets the value-reinforcement message — not just the
 * full cart page.
 *
 * Copy + on/off + duration are admin-controlled via /api/storefront-messages/public.
 * Defaults cover the case where the endpoint is unreachable.
 */
const DEFAULT_LOGIN_MSG = {
  enabled: true,
  text: 'Welcome back — your basket switched to trade pricing. You just saved £{savings}.',
  duration_ms: 6000,
};
const DEFAULT_LOGOUT_MSG = {
  enabled: true,
  text: 'Switched back to retail pricing. Sign in to your trade account to save.',
  duration_ms: 5000,
};

const TradeRepriceWatcher = ({ cart }) => {
  const { isTrade, tradeDiscount } = useTradeUser();
  const prevIsTradeRef = useRef(isTrade);
  const initialisedRef = useRef(false);
  const [messages, setMessages] = useState({
    trade_login_toast: DEFAULT_LOGIN_MSG,
    trade_logout_toast: DEFAULT_LOGOUT_MSG,
  });

  // Pull admin-configured copy/toggles once on mount. Silently fall back to
  // defaults if the endpoint is unreachable so we never break the storefront.
  useEffect(() => {
    const apiBase = process.env.REACT_APP_BACKEND_URL;
    if (!apiBase) return;
    let cancelled = false;
    fetch(`${apiBase}/api/storefront-messages/public`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        setMessages({
          trade_login_toast: { ...DEFAULT_LOGIN_MSG, ...(data.trade_login_toast || {}) },
          trade_logout_toast: { ...DEFAULT_LOGOUT_MSG, ...(data.trade_logout_toast || {}) },
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    // The watcher remounts on every route change because each route wraps in
    // its own TileCartProvider. To distinguish a *real* login/logout from a
    // simple page navigation (where useTradeUser asynchronously hydrates from
    // localStorage), we anchor "last known trade state" in sessionStorage and
    // only fire the toast when the persisted state actually flips.
    const SS_KEY = 'tile_trade_last_known';
    let lastKnown = null;
    try {
      const v = sessionStorage.getItem(SS_KEY);
      if (v === '1') lastKnown = true;
      else if (v === '0') lastKnown = false;
    } catch {}

    if (!initialisedRef.current) {
      initialisedRef.current = true;
      prevIsTradeRef.current = isTrade;
      // First mount of the session — record current state without firing.
      if (lastKnown === null) {
        try { sessionStorage.setItem(SS_KEY, isTrade ? '1' : '0'); } catch {}
      }
      // If a previous page already saw the same state, no toast either way.
      return;
    }
    const wasTrade = prevIsTradeRef.current;
    prevIsTradeRef.current = isTrade;
    if (wasTrade === isTrade) return;

    // Only fire when the *persisted* state crosses, i.e. this is a genuine
    // sign-in / sign-out — not a re-mount hydration after route navigation.
    if (lastKnown === isTrade) return;
    try { sessionStorage.setItem(SS_KEY, isTrade ? '1' : '0'); } catch {}

    if (!wasTrade && isTrade) {
      const cfg = messages.trade_login_toast;
      if (!cfg?.enabled) return;
      if (!Array.isArray(cart) || cart.length === 0) return;
      const retail = getEffectiveSubtotal(cart, false, tradeDiscount);
      const trade = getEffectiveSubtotal(cart, true, tradeDiscount);
      const saved = Math.round((retail - trade) * 100) / 100;
      if (saved > 0) {
        const text = (cfg.text || DEFAULT_LOGIN_MSG.text)
          .replace('{savings}', safeToFixed(saved, 2));
        toast.success(text, {
          duration: cfg.duration_ms || DEFAULT_LOGIN_MSG.duration_ms,
          id: 'trade-cart-reprice-in',
        });
      }
      return;
    }

    if (wasTrade && !isTrade) {
      const cfg = messages.trade_logout_toast;
      if (!cfg?.enabled) return;
      toast(cfg.text || DEFAULT_LOGOUT_MSG.text, {
        duration: cfg.duration_ms || DEFAULT_LOGOUT_MSG.duration_ms,
        id: 'trade-cart-reprice-out',
      });
    }
  }, [isTrade, cart, tradeDiscount, messages]);

  return null;
};

export default TileCartProvider;
