import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Trash2, Package, ArrowRight, ArrowLeft, Info, CheckCircle } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { useSampleCart } from '../../contexts/SampleCartContext';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { toast } from 'sonner';
import { safeToFixed } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const TileSampleCartPage = () => {
  const { samples, sampleCount, maxSamples, postage, removeSample, removeSampleSilent, clearSamples, validateAgainstServer } = useSampleCart();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);

  // Validate the basket against live product data on mount — drops any
  // samples whose product was deleted/renamed since the customer added
  // them, so they never reach the Pay button with a stale ID.
  React.useEffect(() => {
    validateAgainstServer().catch(() => { /* silent — non-fatal */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    address1: '',
    address2: '',
    city: '',
    postcode: ''
  });

  // Pre-fill from logged in customer
  React.useEffect(() => {
    const customer = localStorage.getItem('tile_shop_customer');
    if (customer) {
      try {
        const data = JSON.parse(customer);
        setFormData(prev => ({
          ...prev,
          name: data.name || '',
          email: data.email || '',
          phone: data.phone || '',
          address1: data.address_line1 || '',
          address2: data.address_line2 || '',
          city: data.city || '',
          postcode: data.postcode || ''
        }));
      } catch (e) {}
    }
  }, []);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleSubmitOrder = async () => {
    // Per-field validation — tells the customer EXACTLY what to fix
    // instead of the previous generic "Please fill in all required fields"
    // toast that left them guessing.
    const required = [
      ['name', 'your name'],
      ['email', 'your email'],
      ['address1', 'address line 1'],
      ['city', 'city / town'],
      ['postcode', 'postcode'],
    ];
    const missing = required.filter(([k]) => !String(formData[k] || '').trim());
    if (missing.length) {
      toast.error(`Please add ${missing.map(([, label]) => label).join(', ')}`);
      return;
    }

    setLoading(true);
    try {
      // 0. Capture contact + basket BEFORE we touch any other endpoint so
      //    we never lose a customer to a downstream failure. Best-effort —
      //    if this fails for any reason we still proceed with the order
      //    submission (it's purely defensive).
      try {
        await fetch(`${API_URL}/api/shop/samples/capture`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customer_name: formData.name,
            customer_email: formData.email.trim().toLowerCase(),
            customer_phone: formData.phone,
            delivery_address: {
              line1: formData.address1,
              line2: formData.address2,
              city: formData.city,
              postcode: formData.postcode,
            },
            product_ids: samples.map((s) => s.id),
          }),
        });
      } catch (_captureErr) { /* non-fatal */ }

      // 1. Create the sample-order record in our DB
      const response = await fetch(`${API_URL}/api/shop/samples/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_ids: samples.map(s => s.id),
          customer_name: formData.name,
          customer_email: formData.email.trim().toLowerCase(),
          customer_phone: formData.phone,
          delivery_address: {
            line1: formData.address1,
            line2: formData.address2,
            city: formData.city,
            postcode: formData.postcode
          },
          notes: ''
        })
      });

      if (!response.ok) {
        // 410 = "all samples in basket are stale" — auto-clear the cart so
        // the user doesn't get stuck in a loop of the same error.
        if (response.status === 410) {
          const body = await response.json().catch(() => ({}));
          const detail = body.detail || {};
          clearSamples();
          toast.warning(detail.message || 'Some samples are no longer available — please add fresh ones from the shop.');
          setLoading(false);
          setTimeout(() => navigate('/tiles'), 1500);
          return;
        }
        // 409 = "this customer has already received one of these tiles" —
        // strip those specific tiles from the basket so a retry succeeds
        // with whatever's left.
        if (response.status === 409) {
          const body = await response.json().catch(() => ({}));
          const detail = body.detail || {};
          const dupIds = Array.isArray(detail.already_ordered_product_ids)
            ? detail.already_ordered_product_ids : [];
          if (dupIds.length > 0) {
            const dupSet = new Set(dupIds);
            for (const s of samples) {
              if (dupSet.has(s.id)) {
                // Remove silently — the toast below explains everything
                // in one message rather than spamming N×.
                if (typeof removeSampleSilent === 'function') {
                  removeSampleSilent(s.id);
                } else {
                  removeSample(s.id);
                }
              }
            }
          }
          toast.warning(
            detail.message ||
            "You've already received one or more of these tiles before — they've been removed. Please pick different tiles."
          );
          setLoading(false);
          return;
        }
        // Surface the backend's specific error reason instead of swallowing
        // it as a generic "Failed to create sample order". This was the bug
        // that made 8 customers see the same vague toast on Apr 30, 2026 —
        // the real reasons were "max sample orders this month" or "product
        // not found", but the UI hid them.
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || 'Failed to create sample order');
      }
      const order = await response.json();

      // Heads-up if some basket items were silently skipped (stale IDs).
      // The order still goes through with the remaining valid samples.
      if (Array.isArray(order.skipped_product_ids) && order.skipped_product_ids.length > 0) {
        toast.warning(
          `${order.skipped_product_ids.length} sample${order.skipped_product_ids.length === 1 ? ' was' : 's were'} no longer available and ${order.skipped_product_ids.length === 1 ? 'has' : 'have'} been removed.`
        );
      }

      // 2. Hand the order off to Stripe Checkout for the £2.99 postage.
      //    The previous version of this page navigated straight to the
      //    success screen WITHOUT charging the customer — meaning every
      //    "successful" sample order was actually unpaid. Now we redirect
      //    to Stripe and only mark the order paid once Stripe confirms.
      const checkoutRes = await fetch(
        `${API_URL}/api/shop/samples/checkout/${order.order_id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ origin_url: window.location.origin }),
        }
      );
      if (!checkoutRes.ok) {
        const body = await checkoutRes.json().catch(() => ({}));
        throw new Error(body.detail || 'Could not start payment. Please try again.');
      }
      const { checkout_url } = await checkoutRes.json();
      if (!checkout_url) throw new Error('Payment provider did not return a checkout URL');

      // Persist a tiny breadcrumb so the success page can re-hydrate the
      // friendly summary even after the Stripe round-trip wipes location
      // state. Removed automatically on the success page.
      try {
        sessionStorage.setItem('tile_sample_pending', JSON.stringify({
          order_number: order.order_number,
          sample_count: order.sample_count,
          postage: order.postage_fee,
          email: formData.email.trim().toLowerCase(),
        }));
      } catch (_) { /* sessionStorage disabled — non-fatal */ }

      // Don't clear samples yet — only on confirmed payment, otherwise a
      // cancelled checkout would leave the customer with an empty cart and
      // no way to retry.
      window.location.href = checkout_url;
    } catch (error) {
      toast.error(error.message || 'Something went wrong. Please try again or call us if it persists.');
      setLoading(false);
    }
  };

  if (samples.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50">
        <ShopHeader />
        <div className="container mx-auto px-4 py-16">
          <div className="text-center max-w-md mx-auto">
            <Package className="h-16 w-16 mx-auto text-gray-300 mb-4" />
            <h1 className="text-2xl font-bold text-gray-900 mb-2">No Samples Selected</h1>
            <p className="text-gray-500 mb-6">
              Browse our tiles and add up to {maxSamples} free samples to your basket.
            </p>
            <Button 
              onClick={() => navigate('/tiles')}
              className="bg-[#333333] hover:bg-[#444444] text-[#F7EA1C] font-semibold"
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

  return (
    <div className="min-h-screen bg-gray-50">
      <ShopHeader />

      <div className="container mx-auto px-4 py-8">
        {/* Breadcrumb */}
        <nav className="text-sm text-gray-500 mb-6">
          <Link to="/tiles" className="hover:text-[#F7EA1C]">Home</Link>
          <span className="mx-2">/</span>
          <span className="text-gray-900">Sample Basket</span>
        </nav>

        <h1 className="text-2xl md:text-3xl font-bold text-gray-900 mb-2">Free Tile Samples</h1>
        <p className="text-gray-500 mb-8">
          {sampleCount} of {maxSamples} free samples selected • £{safeToFixed(postage, 2)} delivery
        </p>

        {!showCheckout ? (
          <div className="grid lg:grid-cols-3 gap-8">
            {/* Sample Items */}
            <div className="lg:col-span-2">
              {/* Info Banner */}
              <div className="bg-[#333333] text-white rounded-lg p-4 mb-6 flex items-start gap-3">
                <Info className="h-5 w-5 text-[#F7EA1C] flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-[#F7EA1C]">Free Cut Samples</p>
                  <p className="text-sm text-gray-300 mt-1">
                    Order up to {maxSamples} free tile samples per delivery — only £{safeToFixed(postage, 2)} postage. Need more? Place another order.
                    Samples typically arrive within 3-5 working days.
                  </p>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow-sm divide-y">
                {samples.map((sample) => (
                  <div key={sample.id} className="p-4 md:p-6 flex gap-4">
                    <Link to={`/tiles/${sample.slug}`} className="flex-shrink-0">
                      {sample.image ? (
                        <img
                          src={sample.image}
                          alt={sample.display_name}
                          className="w-24 h-24 md:w-32 md:h-32 object-cover rounded-lg"
                        />
                      ) : (
                        <div className="w-24 h-24 md:w-32 md:h-32 bg-gray-100 rounded-lg flex items-center justify-center text-gray-400">
                          No Image
                        </div>
                      )}
                    </Link>

                    <div className="flex-1 min-w-0">
                      <Link 
                        to={`/tiles/${sample.slug}`}
                        className="font-medium text-gray-900 hover:text-[#333333] line-clamp-2"
                      >
                        {sample.display_name}
                      </Link>
                      
                      <div className="text-sm text-gray-500 mt-1">
                        {sample.size && <span>{sample.size}</span>}
                        {sample.finish && <span> • {sample.finish}</span>}
                      </div>
                      
                      <div className="text-sm text-gray-500 mt-1">
                        SKU: {sample.supplier_code}
                      </div>

                      <div className="mt-3 flex items-center gap-4">
                        <span className="text-green-600 font-medium text-sm flex items-center gap-1">
                          <CheckCircle className="h-4 w-4" />
                          FREE
                        </span>
                        <button 
                          onClick={() => removeSample(sample.id)}
                          className="text-red-500 hover:text-red-600 text-sm flex items-center gap-1"
                        >
                          <Trash2 className="h-4 w-4" />
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-4 mt-6">
                <Button
                  variant="outline"
                  onClick={() => navigate('/tiles')}
                  className="flex items-center gap-2"
                >
                  <ArrowLeft className="h-4 w-4" />
                  {sampleCount < maxSamples ? 'Add More Samples' : 'Continue Shopping'}
                </Button>
                <Button
                  variant="outline"
                  onClick={clearSamples}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                >
                  Clear All
                </Button>
              </div>
            </div>

            {/* Order Summary */}
            <div className="lg:col-span-1">
              <div className="bg-white rounded-lg shadow-sm p-6 sticky top-32">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Order Summary</h2>

                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">{sampleCount} Sample(s)</span>
                    <span className="text-green-600 font-medium">FREE</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Delivery</span>
                    <span className="font-medium">£{safeToFixed(postage, 2)}</span>
                  </div>
                  <div className="border-t pt-3 mt-3">
                    <div className="flex justify-between text-lg font-semibold">
                      <span>Total</span>
                      <span className="text-[#333333]">£{safeToFixed(postage, 2)}</span>
                    </div>
                  </div>
                </div>

                <Button 
                  className="w-full bg-[#333333] hover:bg-[#444444] text-[#F7EA1C] font-semibold mt-6 py-6"
                  onClick={() => setShowCheckout(true)}
                  data-testid="proceed-to-checkout-btn"
                >
                  Checkout
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>

                <p className="text-xs text-gray-500 text-center mt-4">
                  Samples delivered within 3-5 working days
                </p>
              </div>
            </div>
          </div>
        ) : (
          /* Checkout Form */
          <div className="max-w-2xl mx-auto">
            <div className="bg-white rounded-lg shadow-sm p-6 md:p-8">
              <h2 className="text-xl font-semibold text-gray-900 mb-6">Delivery Details</h2>
              
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="name">Full Name *</Label>
                    <Input
                      id="name"
                      name="name"
                      value={formData.name}
                      onChange={handleInputChange}
                      placeholder="John Doe"
                      className="mt-1"
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor="phone">Phone Number</Label>
                    <Input
                      id="phone"
                      name="phone"
                      type="tel"
                      value={formData.phone}
                      onChange={handleInputChange}
                      placeholder="07123 456789"
                      className="mt-1"
                    />
                  </div>
                </div>

                <div>
                  <Label htmlFor="email">Email Address *</Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    value={formData.email}
                    onChange={handleInputChange}
                    placeholder="you@example.com"
                    className="mt-1"
                    required
                  />
                </div>

                <div>
                  <Label htmlFor="address1">Address Line 1 *</Label>
                  <Input
                    id="address1"
                    name="address1"
                    value={formData.address1}
                    onChange={handleInputChange}
                    placeholder="House number and street"
                    className="mt-1"
                    required
                  />
                </div>

                <div>
                  <Label htmlFor="address2">Address Line 2</Label>
                  <Input
                    id="address2"
                    name="address2"
                    value={formData.address2}
                    onChange={handleInputChange}
                    placeholder="Apartment, unit, etc."
                    className="mt-1"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="city">City *</Label>
                    <Input
                      id="city"
                      name="city"
                      value={formData.city}
                      onChange={handleInputChange}
                      className="mt-1"
                      required
                    />
                  </div>
                  <div>
                    <Label htmlFor="postcode">Postcode *</Label>
                    <Input
                      id="postcode"
                      name="postcode"
                      value={formData.postcode}
                      onChange={handleInputChange}
                      className="mt-1"
                      required
                    />
                  </div>
                </div>
              </div>

              {/* Order Summary in checkout */}
              <div className="bg-gray-50 rounded-lg p-4 mt-6">
                <div className="flex justify-between items-center text-sm mb-2">
                  <span className="text-gray-600">{sampleCount} Free Sample(s)</span>
                  <span className="text-green-600">FREE</span>
                </div>
                <div className="flex justify-between items-center font-semibold">
                  <span>Total (Delivery only)</span>
                  <span className="text-[#333333]">£{safeToFixed(postage, 2)}</span>
                </div>
              </div>

              <div className="flex gap-4 mt-6">
                <Button
                  variant="outline"
                  onClick={() => setShowCheckout(false)}
                  className="flex-1"
                >
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back
                </Button>
                <Button
                  className="flex-1 bg-[#333333] hover:bg-[#444444] text-[#F7EA1C] font-semibold"
                  onClick={handleSubmitOrder}
                  disabled={loading}
                  data-testid="place-sample-order-btn"
                >
                  {loading ? 'Processing...' : `Pay £${safeToFixed(postage, 2)}`}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      <ShopFooter />
    </div>
  );
};

export default TileSampleCartPage;
