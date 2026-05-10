import React, { useEffect, useState, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { CheckCircle2, Loader2, Package, ArrowLeft, AlertCircle, Mail, MapPin, Truck } from 'lucide-react';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { Button } from '../../components/ui/button';
import { pinterestCheckout } from '../../lib/pinterest';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const OrderSuccessPage = () => {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get('session_id');
  const orderId = searchParams.get('order_id');
  const [status, setStatus] = useState('loading');
  const [order, setOrder] = useState(null);
  // Pinterest Checkout event must fire exactly ONCE per successful order
  // even if the SPA re-renders or the polling loop revisits the page.
  const pinFired = useRef(false);

  // Fire Pinterest Checkout the first time we observe payment_status === 'paid'
  useEffect(() => {
    if (status !== 'paid' || pinFired.current || !order) return;
    pinFired.current = true;
    try {
      pinterestCheckout({
        order_id: order.id || order.order_id || orderId,
        value: order.total_amount || order.total || 0,
        quantity: (order.items || []).reduce((s, i) => s + Number(i.quantity || 1), 0),
        line_items: (order.items || []).map(i => ({
          product_id: i.supplier_code || i.id,
          product_name: i.display_name || i.name,
          quantity: i.quantity,
          price: i.price,
        })),
      });
    } catch { /* analytics never throws */ }
  }, [status, order, orderId]);

  useEffect(() => {
    if (!sessionId && !orderId) { setStatus('error'); return; }

    let cancelled = false;

    // Try session-based status first (the canonical Stripe verify flow).
    // If that fails (e.g. transient Stripe API hiccup, expired session, or webhook
    // delay), fall back to looking the order up by order_id — the order itself is
    // the source of truth in our DB; payment confirmation arrives via webhook.
    const fetchStatus = async () => {
      try {
        if (sessionId) {
          const res = await fetch(`${API_URL}/api/shop/guest-checkout/status/${sessionId}`);
          if (res.ok) {
            const data = await res.json();
            if (cancelled) return null;
            setOrder(data.order);
            setStatus(data.status === 'paid' ? 'paid' : 'pending');
            return data.status;
          }
        }
      } catch { /* fall through */ }

      // Fallback: read directly from the order record. We treat payment_status === 'paid'
      // as success even if Stripe verify endpoint flaked.
      if (orderId) {
        try {
          const r = await fetch(`${API_URL}/api/shop/orders/by-id/${orderId}`);
          if (r.ok) {
            const o = await r.json();
            if (cancelled) return null;
            setOrder(o);
            setStatus(o?.payment_status === 'paid' ? 'paid' : 'pending');
            return o?.payment_status;
          }
        } catch { /* fall through */ }
      }
      return null;
    };

    (async () => {
      const s = await fetchStatus();
      // If still not 'paid', poll every 3s for up to 60s — covers webhook lag.
      if (s !== 'paid') {
        let attempts = 0;
        const interval = setInterval(async () => {
          attempts += 1;
          const next = await fetchStatus();
          if (next === 'paid' || attempts >= 20 || cancelled) clearInterval(interval);
        }, 3000);
        return () => clearInterval(interval);
      }
      return undefined;
    })();

    return () => { cancelled = true; };
  }, [sessionId, orderId]);

  return (
    <div className="min-h-screen bg-gray-50">
      <ShopHeader />
      <div className="max-w-2xl mx-auto px-4 py-12">
        {status === 'loading' && (
          <div className="text-center py-16">
            <Loader2 className="w-12 h-12 animate-spin text-gray-400 mx-auto mb-4" />
            <p className="text-gray-500 text-lg">Checking your payment...</p>
          </div>
        )}

        {status === 'paid' && order && (
          <div className="space-y-6">
            <div className="bg-white rounded-2xl shadow-sm p-8 text-center" data-testid="order-success">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="w-8 h-8 text-green-600" />
              </div>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Payment Successful!</h1>
              <p className="text-gray-500 mb-4">Thank you for your order. We've sent a confirmation to your email.</p>
              <div className="inline-block bg-gray-100 rounded-lg px-4 py-2 text-sm">
                Order Number: <strong className="text-gray-900">{order.order_number}</strong>
              </div>
            </div>

            <div className="bg-white rounded-2xl shadow-sm p-6 space-y-4">
              <h2 className="font-bold text-gray-900">Order Details</h2>

              <div className="flex items-center gap-3 text-sm text-gray-600">
                <Mail className="w-4 h-4 text-gray-400" />
                <span>Confirmation sent to <strong>{order.customer_email}</strong></span>
              </div>

              {order.delivery_method === 'delivery' && order.delivery_address && (
                <div className="flex items-start gap-3 text-sm text-gray-600">
                  <MapPin className="w-4 h-4 text-gray-400 mt-0.5" />
                  <div>
                    <span className="font-medium">Delivering to: </span>
                    {order.delivery_address.address1}, {order.delivery_address.city}, {order.delivery_address.postcode}
                  </div>
                </div>
              )}

              {order.delivery_method === 'collect' && (
                <div className="flex items-center gap-3 text-sm text-gray-600">
                  <Package className="w-4 h-4 text-gray-400" />
                  <span>Click & Collect</span>
                </div>
              )}

              <div className="border-t pt-4 space-y-2">
                {order.items?.map((item, idx) => (
                  <div key={idx} className="flex justify-between text-sm">
                    <span className="text-gray-700">{item.name} x {item.quantity}</span>
                    <span className="font-medium">£{(item.price * item.quantity).toFixed(2)}</span>
                  </div>
                ))}
              </div>

              <div className="border-t pt-3">
                <div className="flex justify-between text-lg font-bold">
                  <span>Total Paid</span>
                  <span>£{order.total?.toFixed(2)}</span>
                </div>
              </div>
            </div>

            <div className="text-center">
              <Link to="/tiles">
                <Button className="bg-[#333] hover:bg-[#444] text-[#F7EA1C]">
                  <ArrowLeft className="w-4 h-4 mr-2" /> Continue Shopping
                </Button>
              </Link>
            </div>
          </div>
        )}

        {status === 'pending' && (
          <div className="bg-white rounded-2xl shadow-sm p-8 text-center">
            <Loader2 className="w-12 h-12 animate-spin text-amber-500 mx-auto mb-4" />
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Processing Payment...</h1>
            <p className="text-gray-500">We're confirming your payment. This usually takes a few seconds.</p>
          </div>
        )}

        {status === 'error' && (
          <div className="bg-white rounded-2xl shadow-sm p-8 text-center">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-8 h-8 text-red-600" />
            </div>
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Something went wrong</h1>
            <p className="text-gray-500 mb-4">We couldn't verify your payment. Please contact us if you were charged.</p>
            <Link to="/shop/tile-checkout">
              <Button variant="outline">Return to Checkout</Button>
            </Link>
          </div>
        )}
      </div>
      <ShopFooter />
    </div>
  );
};

export default OrderSuccessPage;
