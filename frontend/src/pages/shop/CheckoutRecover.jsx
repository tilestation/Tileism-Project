import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '../../components/ui/button';

const API_URL = process.env.REACT_APP_BACKEND_URL;

/**
 * Public storefront route hit by the "your payment didn't go through"
 * recovery email. The token in the URL is the auth — the customer
 * doesn't need to be logged in.
 *
 * Flow:
 *   1. Fetch /api/shop/checkout/recover/<token> to validate the token
 *      and get the saved cart + customer details.
 *   2. Show a friendly "your basket is here" screen with the items.
 *   3. Stash the cart in localStorage under `tilecart_v1` so the
 *      existing checkout reads it back, then bounce to /shop/checkout.
 */
export default function CheckoutRecover() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    let alive = true;
    fetch(`${API_URL}/api/shop/checkout/recover/${token}`)
      .then(async (r) => {
        const json = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(json.detail || 'Recovery link is no longer valid.');
        return json;
      })
      .then((d) => { if (alive) setState({ loading: false, data: d, error: null }); })
      .catch((e) => { if (alive) setState({ loading: false, data: null, error: e.message }); });
    return () => { alive = false; };
  }, [token]);

  const restoreAndCheckout = () => {
    const items = state.data?.items || [];
    if (!items.length) return;
    // Restore into the storefront cart (TileCartContext → `tilestation_cart`).
    // Order lines carry `product_id`; the cart needs `id`, a numeric price
    // and quantity or the line is dropped on load.
    try {
      const cartItems = items.map((it) => ({
        ...it,
        id: it.id || it.product_id,
        display_name: it.name,
        price: Number(it.price) || 0,
        quantity: Number(it.quantity) || 1,
      })).filter((it) => it.id && it.price > 0);
      localStorage.setItem('tilestation_cart', JSON.stringify(cartItems));
    } catch { /* localStorage can fail in private mode — checkout still works */ }
    navigate('/shop/tile-checkout');
  };

  if (state.loading) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <Loader2 className="w-7 h-7 animate-spin text-emerald-600 mx-auto" />
        <p className="text-sm text-gray-500 mt-3">Restoring your basket…</p>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="max-w-xl mx-auto px-4 py-12">
        <div className="bg-rose-50 border border-rose-200 rounded-lg p-6 flex items-start gap-3" data-testid="recovery-error">
          <AlertCircle className="w-6 h-6 text-rose-600 flex-shrink-0 mt-0.5" />
          <div>
            <h2 className="text-lg font-bold text-rose-900">Recovery link expired</h2>
            <p className="text-sm text-rose-800 mt-1">{state.error}</p>
            <Link to="/tiles">
              <Button variant="outline" className="mt-4" data-testid="recovery-browse-tiles">
                Browse tiles
              </Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const d = state.data;
  const items = d.items || [];

  return (
    <div className="max-w-xl mx-auto px-4 py-12">
      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-6 flex items-start gap-3 mb-6" data-testid="recovery-success">
        <CheckCircle2 className="w-6 h-6 text-emerald-600 flex-shrink-0 mt-0.5" />
        <div>
          <h2 className="text-lg font-bold text-emerald-900">Your basket is saved</h2>
          <p className="text-sm text-emerald-800 mt-1">
            We've restored your {items.length} item{items.length === 1 ? '' : 's'}. Click below to continue checkout —
            no need to re-add anything.
          </p>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b bg-gray-50">
          <h3 className="font-semibold text-gray-800">Order {d.order_number}</h3>
          {d.decline_reason && (
            <p className="text-xs text-rose-700 mt-1">Bank declined: <em>{d.decline_reason}</em></p>
          )}
        </div>
        <ul className="divide-y divide-gray-100">
          {items.map((it, i) => (
            <li key={i} className="px-4 py-3 flex justify-between text-sm" data-testid={`recovery-item-${i}`}>
              <span className="text-gray-800">{it.name} × {it.quantity}</span>
              <span className="font-mono text-gray-700">£{(Number(it.price || 0) * Number(it.quantity || 0)).toFixed(2)}</span>
            </li>
          ))}
        </ul>
        <div className="px-4 py-3 border-t bg-gray-50 text-sm">
          <div className="flex justify-between"><span>Subtotal</span><span className="font-mono">£{Number(d.subtotal || 0).toFixed(2)}</span></div>
          <div className="flex justify-between"><span>VAT</span><span className="font-mono">£{Number(d.vat || 0).toFixed(2)}</span></div>
          <div className="flex justify-between"><span>Delivery</span><span className="font-mono">£{Number(d.delivery_fee || 0).toFixed(2)}</span></div>
          <div className="flex justify-between font-bold mt-1 pt-1 border-t border-gray-200"><span>Total</span><span className="font-mono">£{Number(d.total || 0).toFixed(2)}</span></div>
        </div>
      </div>

      <Button
        onClick={restoreAndCheckout}
        className="w-full mt-6 bg-emerald-600 hover:bg-emerald-700 text-white"
        data-testid="recovery-resume-checkout"
      >
        Resume checkout →
      </Button>

      <p className="text-xs text-gray-500 text-center mt-4">
        Trouble paying? Call us on <a href="tel:+441474878989" className="text-gray-700 font-medium">01474 878 989</a> — we can take payment over the phone.
      </p>
    </div>
  );
}
