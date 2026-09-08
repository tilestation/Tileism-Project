import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Gift, Sparkles, X } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { useTradeUser } from '../../hooks/useTradeUser';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
const DISMISSED_KEY = 'tilestation_cart_save_dismissed';

/**
 * Small "Save 10% — email me my code" banner shown on the cart page for guests
 * who haven't already entered an email. Reuses the welcome-popup endpoint so
 * the discount % / expiry settings stay in one place.
 */
export default function CartSaveBanner() {
  const { isTrade } = useTradeUser();
  const [enabled, setEnabled] = useState(false);
  const [percent, setPercent] = useState(10);
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISSED_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      axios.get(`${API}/storefront-features/public`),
      axios.get(`${API}/website-admin/welcome-popup/public`),
    ]).then(([f, p]) => {
      if (cancelled) return;
      const featOk = !!f.data?.cart_save_banner_enabled;
      const popup = p.data || {};
      const couponOk = !!popup.coupon_enabled;
      setEnabled(featOk && couponOk);
      if (popup.coupon_percent) setPercent(Number(popup.coupon_percent));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* noop */ }
    setDismissed(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    try {
      await axios.post(`${API}/website-admin/welcome-popup/email`, {
        email: email.trim(),
        source: 'cart_save_banner',
      });
      setSubmitted(true);
    } catch { /* silent — never block cart */ }
    finally { setSubmitting(false); }
  };

  // Trade customers already get trade prices — never dangle a retail coupon at them.
  if (!enabled || dismissed || isTrade) return null;

  if (submitted) {
    return (
      <div
        className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 flex items-center justify-between gap-3"
        data-testid="cart-save-banner-success"
      >
        <div className="flex items-center gap-3">
          <Sparkles className="w-5 h-5 text-emerald-600 shrink-0" />
          <p className="text-sm text-emerald-900">
            <strong>Check your inbox.</strong> Your discount code is on its way to <strong>{email}</strong>.
          </p>
        </div>
        <button
          onClick={dismiss}
          className="text-emerald-700/60 hover:text-emerald-900 p-1"
          aria-label="Dismiss"
          data-testid="cart-save-banner-dismiss-success"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl border border-amber-200 bg-gradient-to-br from-amber-50 to-amber-100/40 p-4"
      data-testid="cart-save-banner"
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
          <Gift className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-gray-900">
            Save {percent}% on this order
          </p>
          <p className="text-xs text-gray-600 mt-0.5">
            Drop your email and we'll send you a single-use {percent}% off code.
          </p>
          <form onSubmit={submit} className="mt-3 flex flex-col sm:flex-row gap-2">
            <Input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              className="bg-white"
              data-testid="cart-save-banner-input"
            />
            <Button type="submit" disabled={submitting || !email.trim()} data-testid="cart-save-banner-submit">
              {submitting ? 'Sending…' : 'Get my code'}
            </Button>
          </form>
        </div>
        <button
          onClick={dismiss}
          className="text-gray-400 hover:text-gray-700 p-1 shrink-0"
          aria-label="Dismiss"
          data-testid="cart-save-banner-dismiss"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
