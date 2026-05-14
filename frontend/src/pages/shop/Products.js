import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Search, ShoppingCart, Plus, Minus, Package, Layers, Truck, MessageSquare } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { OTPVerification } from '../../components/OTPVerification';
import { BulkInquiryModal } from '../../components/BulkInquiryModal';
import { useAuth } from '../../contexts/AuthContext';
import { safeToFixed, safeArr} from '../../utils/safeStr';
import { firstImageUrl, imageUrl } from '../../utils/imageUrl';

export const CustomerProducts = () => {
  const { user } = useAuth();
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [cart, setCart] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showOTPModal, setShowOTPModal] = useState(false);
  const [otpLoading, setOtpLoading] = useState(false);
  const [pendingOrderData, setPendingOrderData] = useState(null);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [smsSent, setSmsSent] = useState(false);
  const [showInquiryModal, setShowInquiryModal] = useState(false);
  const [inquiryProduct, setInquiryProduct] = useState(null);
  const [inquiryLoading, setInquiryLoading] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [productsRes, categoriesRes] = await Promise.all([
        api.getProductsWithCustomPricing(), // Use custom pricing endpoint
        api.getCategories()
      ]);
      setProducts(productsRes.data.filter(p => p.stock > 0));
      setCategories(categoriesRes.data);
    } catch (error) {
      toast.error('Failed to load products');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  // Enhanced addToCart to handle bulk pricing
  const addToCart = (product, quantity = 1, price = null, tier = 'piece') => {
    const effectivePrice = price || product.price;
    const totalQuantity = quantity;
    
    // Check stock
    const existingItem = cart.find(item => item.product_id === product.id);
    const currentCartQty = existingItem ? existingItem.quantity : 0;
    
    if (currentCartQty + totalQuantity > product.stock) {
      toast.error('Cannot add more than available stock');
      return;
    }

    if (existingItem) {
      // Update existing item
      setCart(cart.map(item => 
        item.product_id === product.id 
          ? { ...item, quantity: item.quantity + totalQuantity, price: effectivePrice, tier }
          : item
      ));
    } else {
      // Add new item
      setCart([...cart, { 
        product_id: product.id, 
        product_name: product.name, 
        price: effectivePrice, 
        quantity: totalQuantity,
        tier
      }]);
    }
    
    const tierLabel = tier === 'room_lot' ? 'Room Lot' : tier === 'pallet' ? 'Full Pallet' : '';
    toast.success(`Added ${totalQuantity} ${tierLabel} to cart`);
  };

  const updateQuantity = (productId, delta) => {
    setCart(cart.map(item => {
      if (item.product_id === productId) {
        const newQuantity = item.quantity + delta;
        const product = products.find(p => p.id === productId);
        if (newQuantity > product.stock) {
          toast.error('Cannot exceed available stock');
          return item;
        }
        return { ...item, quantity: Math.max(0, newQuantity) };
      }
      return item;
    }).filter(item => item.quantity > 0));
  };

  const handleCheckout = async () => {
    if (cart.length === 0) {
      toast.error('Cart is empty');
      return;
    }

    const orderData = { items: cart };
    setPendingOrderData(orderData);
    setSmsSent(false);
    setShowOTPModal(true);
  };

  const handleRequestOTP = async (phone) => {
    setOtpLoading(true);
    try {
      const response = await api.requestOTP(pendingOrderData, phone);
      setPhoneNumber(phone);
      
      if (response.data.sms_sent) {
        toast.success('OTP sent to your phone via SMS!', {
          duration: 5000,
          description: 'Check your messages for the verification code'
        });
        setSmsSent(true);
      } else {
        // Demo mode - OTP returned in response
        toast.success(`OTP Generated: ${response.data.otp}`, {
          duration: 10000,
          description: 'Enter this code to verify your order (Demo Mode)'
        });
        console.log('Demo OTP:', response.data.otp);
        setSmsSent(false);
      }
      
      return { success: true };
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to send OTP');
      return { success: false };
    } finally {
      setOtpLoading(false);
    }
  };

  const handleOTPVerify = async (otp, phone) => {
    setOtpLoading(true);
    try {
      await api.verifyOTPAndCreateOrder(pendingOrderData, otp, phone || phoneNumber);
      toast.success('Order placed successfully! Our team will process it shortly.');
      setCart([]);
      setShowOTPModal(false);
      setPendingOrderData(null);
      setPhoneNumber('');
      setSmsSent(false);
      fetchData();
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Invalid OTP or verification failed');
    } finally {
      setOtpLoading(false);
    }
  };

  const handleOTPCancel = () => {
    setShowOTPModal(false);
    setPendingOrderData(null);
    setPhoneNumber('');
    setSmsSent(false);
  };

  // Bulk Inquiry handlers
  const openInquiryModal = (product) => {
    setInquiryProduct(product);
    setShowInquiryModal(true);
  };

  const handleInquirySubmit = async (data) => {
    setInquiryLoading(true);
    try {
      await api.createBulkInquiry(data);
      toast.success('Inquiry submitted successfully!');
      return true;
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to submit inquiry');
      return false;
    } finally {
      setInquiryLoading(false);
    }
  };

  const filteredProducts = products.filter(p => {
    const matchesSearch = p.name.toLowerCase().includes(search.toLowerCase()) || p.sku.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = !categoryFilter || p.category_id === categoryFilter;
    return matchesSearch && matchesCategory;
  });

  const clearanceProducts = filteredProducts.filter(p => p.clearance);
  const regularProducts = filteredProducts.filter(p => !p.clearance);

  const cartTotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  return (
    <div className="space-y-6" data-testid="customer-products-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-heading font-bold tracking-tightest mb-2">Products</h1>
          <p className="text-muted-foreground">Browse and order from available inventory</p>
        </div>
        <Badge variant="outline" className="text-lg px-4 py-2" data-testid="cart-badge">
          <ShoppingCart className="mr-2 h-4 w-4" />
          {cart.length} items
        </Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card className="p-6">
            <div className="flex flex-col sm:flex-row gap-4 mb-6">
              <div className="flex-1 relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search products..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-10"
                  data-testid="search-products-input"
                />
              </div>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="px-3 py-2 rounded-md border border-input bg-background text-sm"
                data-testid="category-filter-customer"
              >
                <option value="">All Categories</option>
                {categories.map(cat => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {clearanceProducts.length > 0 && (
                <div className="md:col-span-2 mb-6">
                  <div className="bg-red-50 border-2 border-red-200 rounded-lg p-4 mb-4">
                    <h2 className="text-2xl font-heading font-bold tracking-tightest text-red-700 mb-2">
                      🔥 Clearance Sale
                    </h2>
                    <p className="text-sm text-red-600">Limited stock - Get amazing deals on these products!</p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {clearanceProducts.map(product => (
                      <Card key={product.id} className="p-4 hover:shadow-md duration-200 border-2 border-red-200 bg-red-50/30" data-testid={`product-card-${product.id}`}>
                        <div className="space-y-3">
                          {product.images && safeArr(product.images).length > 0 && (
                            <div className="relative w-full h-48 bg-secondary rounded-md overflow-hidden">
                              <img 
                                src={firstImageUrl(product.images)} 
                                alt={product.name}
                                className="w-full h-full object-cover"
                                onError={(e) => {
                                  e.target.style.display = 'none';
                                }}
                              />
                              {safeArr(product.images).length > 1 && (
                                <div className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded-full">
                                  +{safeArr(product.images).length - 1} more
                                </div>
                              )}
                              <div className="absolute top-2 left-2 bg-red-600 text-white text-xs font-bold px-3 py-1 rounded-full">
                                CLEARANCE
                              </div>
                            </div>
                          )}
                          <div>
                            <h3 className="font-heading font-bold tracking-tightest">{product.name}</h3>
                            <p className="text-xs text-muted-foreground font-mono">{product.sku}</p>
                            {product.category_name && (
                              <Badge variant="secondary" className="mt-1 text-xs">{product.category_name}</Badge>
                            )}
                          </div>
                          {product.description && (
                            <p className="text-sm text-muted-foreground">{product.description.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')}</p>
                          )}
                          <div className="flex items-center justify-between pt-2">
                            <div>
                              {product.clearance_price ? (
                                <div>
                                  <p className="text-sm line-through text-muted-foreground">£{safeToFixed(product.price, 2)}</p>
                                  <p className="text-2xl font-heading font-bold tracking-tightest tabular-nums text-red-600">
                                    £{safeToFixed(product.clearance_price, 2)}
                                  </p>
                                  <p className="text-xs text-red-600 font-medium">
                                    Save £{(product.price - product.clearance_price).toFixed(2)}
                                  </p>
                                </div>
                              ) : (
                                <p className="text-2xl font-heading font-bold tracking-tightest tabular-nums text-red-600">
                                  £{safeToFixed(product.price, 2)}
                                </p>
                              )}
                              <p className="text-xs text-muted-foreground">{product.stock} in stock</p>
                              {product.m2_quantity && (
                                <p className="text-xs text-accent font-medium">{safeToFixed(product.m2_quantity, 2)} m²</p>
                              )}
                            </div>
                            <Button 
                              size="sm" 
                              onClick={() => addToCart(product, 1, product.clearance_price || product.price, 'clearance')}
                              data-testid={`add-to-cart-${product.id}`}
                              className="bg-red-600 hover:bg-red-700 text-white"
                            >
                              <Plus className="h-4 w-4 mr-1" /> Add
                            </Button>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                </div>
              )}

              {regularProducts.length === 0 && clearanceProducts.length === 0 ? (
                <div className="col-span-full text-center py-12">
                  <Package className="h-16 w-16 mx-auto mb-4 text-muted-foreground opacity-20" />
                  <p className="text-muted-foreground">No products available</p>
                </div>
              ) : (
                regularProducts.map(product => {
                  const hasRoomLot = product.room_lot_enabled && product.room_lot_quantity && product.room_lot_price;
                  const hasPallet = product.pallet_enabled && product.pallet_quantity && product.pallet_price;
                  const hasBulkPricing = hasRoomLot || hasPallet;
                  
                  return (
                    <Card key={product.id} className="p-4 hover:shadow-md duration-200" data-testid={`product-card-${product.id}`}>
                      <div className="space-y-3">
                        {product.images && safeArr(product.images).length > 0 && (
                          <div className="relative w-full h-48 bg-secondary rounded-md overflow-hidden">
                            <img 
                              src={firstImageUrl(product.images)} 
                              alt={product.name}
                              className="w-full h-full object-cover"
                              onError={(e) => {
                                e.target.style.display = 'none';
                              }}
                            />
                            {safeArr(product.images).length > 1 && (
                              <div className="absolute bottom-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded-full">
                                +{safeArr(product.images).length - 1} more
                              </div>
                            )}
                            {hasBulkPricing && (
                              <div className="absolute top-2 left-2 bg-blue-600 text-white text-xs font-bold px-2 py-1 rounded-full flex items-center gap-1">
                                <Layers className="h-3 w-3" /> BULK DEALS
                              </div>
                            )}
                          </div>
                        )}
                        <div>
                          <h3 className="font-heading font-bold tracking-tightest">{product.name}</h3>
                          <p className="text-xs text-muted-foreground font-mono">{product.sku}</p>
                          {product.category_name && (
                            <Badge variant="secondary" className="mt-1 text-xs">{product.category_name}</Badge>
                          )}
                        </div>
                        {product.description && (
                          <p className="text-sm text-muted-foreground line-clamp-2">{product.description.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')}</p>
                        )}
                        
                        {/* Pricing Section */}
                        <div className="pt-2 space-y-2">
                          {/* Base Piece Price */}
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-xl font-heading font-bold tracking-tightest tabular-nums">£{safeToFixed(product.price, 2)}<span className="text-sm font-normal text-muted-foreground">{product.is_surface_product !== false ? '/m²' : '/each'}</span></p>
                              <p className="text-xs text-muted-foreground">{product.stock} in stock</p>
                              {product.m2_quantity && (
                                <p className="text-xs text-accent font-medium">{safeToFixed(product.m2_quantity, 2)} m² per piece</p>
                              )}
                            </div>
                            <Button 
                              size="sm" 
                              onClick={() => addToCart(product, 1, product.price, 'piece')}
                              data-testid={`add-to-cart-${product.id}`}
                              className="bg-accent hover:bg-accent/90"
                            >
                              <Plus className="h-4 w-4 mr-1" /> Add
                            </Button>
                          </div>
                          
                          {/* Bulk Pricing Options */}
                          {hasBulkPricing && (
                            <div className="border-t border-border pt-3 space-y-2">
                              <p className="text-xs font-semibold text-muted-foreground uppercase">Bulk Pricing Available:</p>
                              
                              {hasRoomLot && (
                                <button
                                  onClick={() => addToCart(product, product.room_lot_quantity, product.room_lot_price, 'room_lot')}
                                  className="w-full flex items-center justify-between p-2 rounded-md border border-blue-200 bg-blue-50 hover:bg-blue-100 text-left transition-colors"
                                  data-testid={`add-room-lot-${product.id}`}
                                >
                                  <div className="flex items-center gap-2">
                                    <Layers className="h-4 w-4 text-blue-600" />
                                    <div>
                                      <span className="text-sm font-medium text-blue-800">Room Lot</span>
                                      <span className="text-xs text-blue-600 ml-1">({product.room_lot_quantity} pcs)</span>
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <span className="font-bold text-blue-700">£{safeToFixed(product.room_lot_price, 2)}</span>
                                    <span className="text-xs text-blue-600">{product.is_surface_product !== false ? '/m²' : '/each'}</span>
                                    <p className="text-xs text-green-600 font-medium">
                                      Save £{((product.price - product.room_lot_price) * product.room_lot_quantity).toFixed(2)}
                                    </p>
                                  </div>
                                </button>
                              )}
                              
                              {hasPallet && (
                                <button
                                  onClick={() => addToCart(product, product.pallet_quantity, product.pallet_price, 'pallet')}
                                  className="w-full flex items-center justify-between p-2 rounded-md border border-green-200 bg-green-50 hover:bg-green-100 text-left transition-colors"
                                  data-testid={`add-pallet-${product.id}`}
                                >
                                  <div className="flex items-center gap-2">
                                    <Truck className="h-4 w-4 text-green-600" />
                                    <div>
                                      <span className="text-sm font-medium text-green-800">Full Pallet</span>
                                      <span className="text-xs text-green-600 ml-1">({product.pallet_quantity} pcs)</span>
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <span className="font-bold text-green-700">£{safeToFixed(product.pallet_price, 2)}</span>
                                    <span className="text-xs text-green-600">{product.is_surface_product !== false ? '/m²' : '/each'}</span>
                                    <p className="text-xs text-green-600 font-medium">
                                      Save £{((product.price - product.pallet_price) * product.pallet_quantity).toFixed(2)}
                                    </p>
                                  </div>
                                </button>
                              )}
                              
                              {/* Bulk Order Inquiry Button */}
                              <button
                                onClick={() => openInquiryModal(product)}
                                className="w-full flex items-center justify-center gap-2 p-2 rounded-md border border-purple-200 bg-purple-50 hover:bg-purple-100 text-purple-700 text-sm font-medium transition-colors"
                                data-testid={`bulk-inquiry-${product.id}`}
                              >
                                <MessageSquare className="h-4 w-4" />
                                Need more? Request custom quote
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </Card>
                  );
                })
              )}
            </div>
          </Card>
        </div>

        <div className="lg:col-span-1">
          <Card className="p-6 sticky top-6" data-testid="cart-panel">
            <h2 className="text-xl font-heading font-bold tracking-tightest mb-4 pb-3 border-b border-border/50">
              Shopping Cart
            </h2>
            
            {cart.length === 0 ? (
              <div className="text-center py-8">
                <ShoppingCart className="h-12 w-12 mx-auto mb-3 text-muted-foreground opacity-20" />
                <p className="text-sm text-muted-foreground">Your cart is empty</p>
              </div>
            ) : (
              <>
                <div className="space-y-3 mb-6 max-h-[400px] overflow-y-auto">
                  {cart.map(item => (
                    <div key={item.product_id} className="p-3 bg-secondary rounded-md" data-testid={`cart-item-${item.product_id}`}>
                      <p className="font-medium text-sm">{item.product_name}</p>
                      {item.tier && item.tier !== 'piece' && (
                        <span className={`text-xs px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${
                          item.tier === 'room_lot' ? 'bg-blue-100 text-blue-700' :
                          item.tier === 'pallet' ? 'bg-green-100 text-green-700' :
                          item.tier === 'clearance' ? 'bg-red-100 text-red-700' : ''
                        }`}>
                          {item.tier === 'room_lot' && <><Layers className="h-3 w-3" /> Room Lot</>}
                          {item.tier === 'pallet' && <><Truck className="h-3 w-3" /> Full Pallet</>}
                          {item.tier === 'clearance' && 'Clearance'}
                        </span>
                      )}
                      <div className="flex items-center justify-between mt-2">
                        <div className="flex items-center gap-2">
                          <Button 
                            size="sm" 
                            variant="outline" 
                            onClick={() => updateQuantity(item.product_id, -1)}
                            data-testid={`decrease-qty-${item.product_id}`}
                            className="h-7 w-7 p-0"
                          >
                            <Minus className="h-3 w-3" />
                          </Button>
                          <span className="font-mono text-sm w-8 text-center">{item.quantity}</span>
                          <Button 
                            size="sm" 
                            variant="outline" 
                            onClick={() => updateQuantity(item.product_id, 1)}
                            data-testid={`increase-qty-${item.product_id}`}
                            className="h-7 w-7 p-0"
                          >
                            <Plus className="h-3 w-3" />
                          </Button>
                        </div>
                        <div className="text-right">
                          <p className="font-mono tabular-nums text-sm">£{(item.price * item.quantity).toFixed(2)}</p>
                          <p className="text-xs text-muted-foreground">£{safeToFixed(item.price, 2)}{item.is_surface_product !== false ? '/m²' : '/each'}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="border-t border-border pt-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="font-heading font-bold tracking-tightest">Total</p>
                    <p className="text-2xl font-heading font-bold tracking-tightest tabular-nums" data-testid="cart-total">
                      £{cartTotal.toFixed(2)}
                    </p>
                  </div>
                  <Button 
                    onClick={handleCheckout} 
                    className="w-full bg-accent hover:bg-accent/90"
                    data-testid="checkout-button"
                  >
                    Place Order
                  </Button>
                </div>
              </>
            )}
          </Card>
        </div>
      </div>

      {showOTPModal && (
        <OTPVerification
          onRequestOTP={handleRequestOTP}
          onVerify={handleOTPVerify}
          onCancel={handleOTPCancel}
          loading={otpLoading}
          expiresInMinutes={5}
          smsSent={smsSent}
          initialPhoneNumber={phoneNumber}
        />
      )}

      {showInquiryModal && inquiryProduct && (
        <BulkInquiryModal
          product={inquiryProduct}
          onSubmit={handleInquirySubmit}
          onClose={() => {
            setShowInquiryModal(false);
            setInquiryProduct(null);
          }}
          loading={inquiryLoading}
          userEmail={user?.email || ''}
          userName={user?.name || ''}
        />
      )}
    </div>
  );
};
