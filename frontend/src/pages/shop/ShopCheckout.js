import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { CreditCard, Truck, Store, ChevronLeft, Lock, UserPlus } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group';
import { Checkbox } from '../../components/ui/checkbox';
import { useShopAuth } from '../../contexts/ShopAuthContext';
import { toast } from 'sonner';
import { normaliseImageUrl } from '../../utils/safeStr';

export const ShopCheckout = () => {
  const { cart, cartTotal, customer, isAuthenticated, clearCart } = useShopAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [stores, setStores] = useState([]);
  const [deliveryMethod, setDeliveryMethod] = useState('delivery');
  const [isGuestCheckout, setIsGuestCheckout] = useState(!isAuthenticated);
  const [createAccount, setCreateAccount] = useState(false);
  
  const [formData, setFormData] = useState({
    customer_name: customer?.name || '',
    customer_email: customer?.email || '',
    customer_phone: customer?.phone || '',
    address_line1: customer?.address?.line1 || '',
    address_line2: customer?.address?.line2 || '',
    city: customer?.address?.city || '',
    postcode: customer?.address?.postcode || '',
    collect_store_id: '',
    notes: '',
    password: ''
  });

  // Load stores on mount - using callback pattern to avoid lint warning
  const [storesLoaded, setStoresLoaded] = useState(false);
  
  useEffect(() => {
    // Get cart from localStorage for guest checkout
    if (!isAuthenticated && cart.length === 0) {
      const savedCart = localStorage.getItem('shop_cart');
      if (!savedCart || JSON.parse(savedCart).length === 0) {
        navigate('/shop/cart');
        return;
      }
    }
    
    if (isAuthenticated && cart.length === 0) {
      navigate('/shop/cart');
      return;
    }

    // Load stores
    if (!storesLoaded) {
      api.shopGetStores()
        .then(response => {
          setStores(response.data);
          setStoresLoaded(true);
        })
        .catch(error => console.error('Failed to load stores:', error));
    }
  }, [isAuthenticated, cart, navigate, storesLoaded]);

  // Sync customer data to form - using render-time sync instead of effect
  const customerDataKey = customer ? `${customer.name}-${customer.email}` : '';
  const [lastCustomerKey, setLastCustomerKey] = useState('');
  
  if (customer && customerDataKey !== lastCustomerKey) {
    setFormData(prev => ({
      ...prev,
      customer_name: customer.name || prev.customer_name,
      customer_email: customer.email || prev.customer_email,
      customer_phone: customer.phone || prev.customer_phone,
      address_line1: customer.address?.line1 || prev.address_line1,
      address_line2: customer.address?.line2 || prev.address_line2,
      city: customer.address?.city || prev.city,
      postcode: customer.address?.postcode || prev.postcode,
    }));
    setIsGuestCheckout(false);
    setLastCustomerKey(customerDataKey);
  }

  // Get cart items - from context if authenticated, from localStorage if guest
  const getCartItems = () => {
    if (isAuthenticated) {
      return cart;
    }
    const savedCart = localStorage.getItem('shop_cart');
    return savedCart ? JSON.parse(savedCart) : [];
  };

  const cartItems = getCartItems();
  const calculatedCartTotal = cartItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const formatPrice = (price) => `£${price?.toFixed(2) || '0.00'}`;

  const subtotal = calculatedCartTotal;
  const vat = subtotal * 0.2;
  const deliveryFee = deliveryMethod === 'collect' ? 0 : (subtotal >= 500 ? 0 : 49.99);
  const total = subtotal + vat + deliveryFee;

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    // Validation
    if (!formData.customer_name || !formData.customer_email) {
      toast.error('Please fill in your name and email');
      return;
    }
    
    if (deliveryMethod === 'delivery') {
      if (!formData.address_line1 || !formData.city || !formData.postcode) {
        toast.error('Please fill in your delivery address');
        return;
      }
    } else {
      if (!formData.collect_store_id) {
        toast.error('Please select a store for collection');
        return;
      }
    }

    if (isGuestCheckout && createAccount && (!formData.password || formData.password.length < 8)) {
      toast.error('Password must be at least 8 characters');
      return;
    }

    setLoading(true);
    
    try {
      const itemsToOrder = cartItems.map(item => ({
        product_id: item.product_id,
        name: item.name,
        sku: item.sku || '',
        price: item.price,
        quantity: item.quantity,
        image: item.image || ''
      }));

      let orderResponse;
      let checkoutResponse;

      if (isGuestCheckout) {
        // Guest checkout
        const guestOrderData = {
          customer_name: formData.customer_name,
          customer_email: formData.customer_email,
          customer_phone: formData.customer_phone,
          delivery_method: deliveryMethod,
          delivery_address: deliveryMethod === 'delivery' ? {
            line1: formData.address_line1,
            line2: formData.address_line2,
            city: formData.city,
            postcode: formData.postcode,
            country: 'United Kingdom'
          } : {},
          collect_store_id: deliveryMethod === 'collect' ? formData.collect_store_id : null,
          notes: formData.notes,
          items: itemsToOrder,
          create_account: createAccount,
          password: createAccount ? formData.password : null
        };

        orderResponse = await api.shopCreateGuestOrder(guestOrderData);
        
        // Create Stripe checkout session for guest
        checkoutResponse = await api.shopCreateGuestCheckoutSession({
          origin_url: window.location.origin,
          order_id: orderResponse.data.order_id
        });
      } else {
        // Authenticated checkout
        const token = localStorage.getItem('shop_token');
        
        const orderData = {
          customer_name: formData.customer_name,
          customer_email: formData.customer_email,
          customer_phone: formData.customer_phone,
          delivery_method: deliveryMethod,
          delivery_address: deliveryMethod === 'delivery' ? {
            line1: formData.address_line1,
            line2: formData.address_line2,
            city: formData.city,
            postcode: formData.postcode,
            country: 'United Kingdom'
          } : {},
          collect_store_id: deliveryMethod === 'collect' ? formData.collect_store_id : null,
          notes: formData.notes,
          items: itemsToOrder
        };

        orderResponse = await api.shopCreateOrder(token, orderData);
        
        // Create Stripe checkout session
        checkoutResponse = await api.shopCreateCheckoutSession(token, {
          origin_url: window.location.origin,
          order_id: orderResponse.data.order_id
        });
      }

      // Clear guest cart from localStorage
      if (isGuestCheckout) {
        localStorage.removeItem('shop_cart');
      }

      // Redirect to Stripe using window.open for better compatibility
      const redirectUrl = checkoutResponse.data.checkout_url;
      window.open(redirectUrl, '_self');
      
    } catch (error) {
      console.error('Checkout error:', error);
      toast.error(error.response?.data?.detail || 'Checkout failed. Please try again.');
      setLoading(false);
    }
  };

  // Show checkout for both guest and authenticated users
  if (cartItems.length === 0) {
    return null;
  }

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Back Button */}
      <Button
        variant="ghost"
        className="mb-6"
        onClick={() => navigate('/shop/cart')}
      >
        <ChevronLeft className="w-4 h-4 mr-2" />
        Back to Cart
      </Button>

      <h1 className="text-2xl md:text-3xl font-bold text-slate-900 mb-8">Checkout</h1>

      {/* Guest Checkout Banner */}
      {isGuestCheckout && (
        <Card className="p-4 mb-6 bg-blue-50 border-blue-200">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-blue-900">Checking out as guest</p>
              <p className="text-sm text-blue-700">You can create an account during checkout to track orders</p>
            </div>
            <Link to="/shop/login?redirect=/shop/checkout">
              <Button variant="outline" size="sm">
                Sign In Instead
              </Button>
            </Link>
          </div>
        </Card>
      )}

      <form onSubmit={handleSubmit}>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Checkout Form */}
          <div className="lg:col-span-2 space-y-6">
            {/* Contact Information */}
            <Card className="p-6">
              <h2 className="text-lg font-semibold mb-4">Contact Information</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="customer_name">Full Name *</Label>
                  <Input
                    id="customer_name"
                    name="customer_name"
                    value={formData.customer_name}
                    onChange={handleInputChange}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="customer_email">Email *</Label>
                  <Input
                    id="customer_email"
                    name="customer_email"
                    type="email"
                    value={formData.customer_email}
                    onChange={handleInputChange}
                    required
                  />
                </div>
                <div className="md:col-span-2">
                  <Label htmlFor="customer_phone">Phone Number</Label>
                  <Input
                    id="customer_phone"
                    name="customer_phone"
                    type="tel"
                    value={formData.customer_phone}
                    onChange={handleInputChange}
                  />
                </div>
              </div>
            </Card>

            {/* Delivery Method */}
            <Card className="p-6">
              <h2 className="text-lg font-semibold mb-4">Delivery Method</h2>
              <RadioGroup value={deliveryMethod} onValueChange={setDeliveryMethod}>
                <div className="space-y-3">
                  <label className={`flex items-start gap-4 p-4 border rounded-lg cursor-pointer transition-colors ${deliveryMethod === 'delivery' ? 'border-amber-500 bg-amber-50' : 'hover:bg-gray-50'}`}>
                    <RadioGroupItem value="delivery" id="delivery" />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <Truck className="w-5 h-5 text-amber-600" />
                        <span className="font-medium">Home Delivery</span>
                      </div>
                      <p className="text-sm text-slate-500 mt-1">
                        {subtotal >= 499 ? 'FREE delivery' : `£49.99 delivery (FREE on orders over £499)`}
                      </p>
                    </div>
                  </label>
                  
                  <label className={`flex items-start gap-4 p-4 border rounded-lg cursor-pointer transition-colors ${deliveryMethod === 'collect' ? 'border-amber-500 bg-amber-50' : 'hover:bg-gray-50'}`}>
                    <RadioGroupItem value="collect" id="collect" />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <Store className="w-5 h-5 text-amber-600" />
                        <span className="font-medium">Click & Collect</span>
                      </div>
                      <p className="text-sm text-slate-500 mt-1">FREE - Collect from one of our showrooms</p>
                    </div>
                  </label>
                </div>
              </RadioGroup>
            </Card>

            {/* Delivery Address */}
            {deliveryMethod === 'delivery' && (
              <Card className="p-6">
                <h2 className="text-lg font-semibold mb-4">Delivery Address</h2>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="address_line1">Address Line 1 *</Label>
                    <Input
                      id="address_line1"
                      name="address_line1"
                      value={formData.address_line1}
                      onChange={handleInputChange}
                      required={deliveryMethod === 'delivery'}
                    />
                  </div>
                  <div>
                    <Label htmlFor="address_line2">Address Line 2</Label>
                    <Input
                      id="address_line2"
                      name="address_line2"
                      value={formData.address_line2}
                      onChange={handleInputChange}
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
                        required={deliveryMethod === 'delivery'}
                      />
                    </div>
                    <div>
                      <Label htmlFor="postcode">Postcode *</Label>
                      <Input
                        id="postcode"
                        name="postcode"
                        value={formData.postcode}
                        onChange={handleInputChange}
                        required={deliveryMethod === 'delivery'}
                      />
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {/* Store Selection */}
            {deliveryMethod === 'collect' && (
              <Card className="p-6">
                <h2 className="text-lg font-semibold mb-4">Select Store for Collection</h2>
                <RadioGroup
                  value={formData.collect_store_id}
                  onValueChange={(value) => setFormData(prev => ({ ...prev, collect_store_id: value }))}
                >
                  <div className="space-y-3">
                    {stores.map((store) => (
                      <label
                        key={store.id}
                        className={`flex items-start gap-4 p-4 border rounded-lg cursor-pointer transition-colors ${formData.collect_store_id === store.id ? 'border-amber-500 bg-amber-50' : 'hover:bg-gray-50'}`}
                      >
                        <RadioGroupItem value={store.id} id={store.id} />
                        <div>
                          <span className="font-medium">{store.name}</span>
                          <p className="text-sm text-slate-500">{store.address}</p>
                          <p className="text-xs text-slate-400 mt-1">{store.opening_hours}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </RadioGroup>
              </Card>
            )}

            {/* Order Notes */}
            <Card className="p-6">
              <h2 className="text-lg font-semibold mb-4">Order Notes (Optional)</h2>
              <Textarea
                name="notes"
                value={formData.notes}
                onChange={handleInputChange}
                placeholder="Any special instructions for your order..."
                rows={3}
              />
            </Card>

            {/* Create Account Option (Guest Only) */}
            {isGuestCheckout && (
              <Card className="p-6">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="create-account"
                    checked={createAccount}
                    onCheckedChange={setCreateAccount}
                  />
                  <div className="flex-1">
                    <Label htmlFor="create-account" className="cursor-pointer">
                      <div className="flex items-center gap-2">
                        <UserPlus className="w-4 h-4 text-amber-600" />
                        <span className="font-medium">Create an account</span>
                      </div>
                      <p className="text-sm text-slate-500 mt-1">
                        Track your orders, save addresses, and checkout faster next time
                      </p>
                    </Label>
                    
                    {createAccount && (
                      <div className="mt-4">
                        <Label htmlFor="password">Create Password *</Label>
                        <Input
                          id="password"
                          name="password"
                          type="password"
                          value={formData.password}
                          onChange={handleInputChange}
                          placeholder="At least 8 characters"
                          minLength={8}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </Card>
            )}
          </div>

          {/* Order Summary */}
          <div>
            <Card className="p-6 sticky top-24">
              <h2 className="text-lg font-bold text-slate-900 mb-4">Order Summary</h2>
              
              {/* Items */}
              <div className="space-y-3 mb-4 max-h-60 overflow-y-auto">
                {cartItems.map((item) => (
                  <div key={item.product_id} className="flex gap-3">
                    <div className="w-12 h-12 bg-gray-100 rounded flex-shrink-0">
                      {item.image ? (
                        <img src={normaliseImageUrl(item.image)} alt="" className="w-full h-full object-cover rounded" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400 text-sm">🪨</div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium line-clamp-1">{item.name}</p>
                      <p className="text-xs text-slate-500">Qty: {item.quantity}</p>
                    </div>
                    <p className="text-sm font-medium">{formatPrice(item.price * item.quantity)}</p>
                  </div>
                ))}
              </div>
              
              <hr className="my-4" />
              
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-500">Subtotal</span>
                  <span className="font-medium">{formatPrice(subtotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">VAT (20%)</span>
                  <span className="font-medium">{formatPrice(vat)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Delivery</span>
                  <span className="font-medium">
                    {deliveryFee === 0 ? (
                      <span className="text-green-600">FREE</span>
                    ) : (
                      formatPrice(deliveryFee)
                    )}
                  </span>
                </div>
                
                <hr className="my-2" />
                
                <div className="flex justify-between text-lg font-bold">
                  <span>Total</span>
                  <span>{formatPrice(total)}</span>
                </div>
              </div>

              <Button
                type="submit"
                size="lg"
                className="w-full mt-6 bg-amber-500 hover:bg-amber-600 text-slate-900 font-semibold"
                disabled={loading}
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <span className="animate-spin">⏳</span>
                    Processing...
                  </span>
                ) : (
                  <>
                    <CreditCard className="w-5 h-5 mr-2" />
                    Pay {formatPrice(total)}
                  </>
                )}
              </Button>

              <div className="flex items-center justify-center gap-2 mt-4 text-xs text-slate-500">
                <Lock className="w-3 h-3" />
                Secure checkout powered by Stripe
              </div>
            </Card>
          </div>
        </div>
      </form>
    </div>
  );
};

export default ShopCheckout;
