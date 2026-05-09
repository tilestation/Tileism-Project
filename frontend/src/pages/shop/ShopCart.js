import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Trash2, Minus, Plus, ShoppingBag, ArrowRight } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { useShopAuth } from '../../contexts/ShopAuthContext';
import { toast } from 'sonner';
import { normaliseImageUrl } from '../../utils/safeStr';

export const ShopCart = () => {
  const { cart, cartTotal, updateCartItem, removeFromCart, clearCart, isAuthenticated } = useShopAuth();
  const navigate = useNavigate();

  const formatPrice = (price) => `£${price?.toFixed(2) || '0.00'}`;

  const handleQuantityChange = async (productId, newQuantity) => {
    try {
      await updateCartItem(productId, newQuantity);
    } catch (error) {
      toast.error('Failed to update cart');
    }
  };

  const handleRemove = async (productId, productName) => {
    try {
      await removeFromCart(productId);
      toast.success(`${productName} removed from cart`);
    } catch (error) {
      toast.error('Failed to remove item');
    }
  };

  const handleCheckout = () => {
    if (!isAuthenticated) {
      toast.info('Please sign in to continue checkout');
      navigate('/shop/login?redirect=/shop/checkout');
    } else {
      navigate('/shop/checkout');
    }
  };

  const subtotal = cartTotal;
  const vat = subtotal * 0.2;
  const deliveryFee = subtotal >= 500 ? 0 : 49.99;
  const total = subtotal + vat + deliveryFee;

  if (cart.length === 0) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <div className="max-w-md mx-auto">
          <div className="w-24 h-24 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <ShoppingBag className="w-12 h-12 text-slate-400" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">Your cart is empty</h1>
          <p className="text-slate-500 mb-8">Looks like you haven&apos;t added anything to your cart yet.</p>
          <Link to="/shop/products">
            <Button size="lg" className="bg-amber-500 hover:bg-amber-600 text-slate-900">
              Continue Shopping
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl md:text-3xl font-bold text-slate-900 mb-8">Shopping Cart</h1>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Cart Items */}
        <div className="lg:col-span-2 space-y-4">
          {cart.map((item) => (
            <Card key={item.product_id} className="p-4">
              <div className="flex gap-4">
                {/* Product Image */}
                <div className="w-24 h-24 bg-gray-100 rounded-lg overflow-hidden flex-shrink-0">
                  {item.image ? (
                    <img src={normaliseImageUrl(item.image)} alt={item.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-400">
                      <span className="text-2xl">🪨</span>
                    </div>
                  )}
                </div>

                {/* Product Info */}
                <div className="flex-1 min-w-0">
                  <Link
                    to={`/shop/products/${item.product_id}`}
                    className="font-medium text-slate-900 hover:text-amber-600 line-clamp-2"
                  >
                    {item.name}
                  </Link>
                  {item.sku && <p className="text-sm text-slate-500 mt-1">SKU: {item.sku}</p>}
                  <p className="font-semibold mt-2">{formatPrice(item.price)} each</p>
                </div>

                {/* Quantity & Actions */}
                <div className="flex flex-col items-end justify-between">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-slate-400 hover:text-red-500"
                    onClick={() => handleRemove(item.product_id, item.name)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                  
                  <div className="flex items-center border rounded-lg">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleQuantityChange(item.product_id, item.quantity - 1)}
                      disabled={item.quantity <= 1}
                    >
                      <Minus className="w-3 h-3" />
                    </Button>
                    <span className="w-8 text-center text-sm">{item.quantity}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleQuantityChange(item.product_id, item.quantity + 1)}
                    >
                      <Plus className="w-3 h-3" />
                    </Button>
                  </div>
                  
                  <p className="font-semibold text-slate-900">
                    {formatPrice(item.price * item.quantity)}
                  </p>
                </div>
              </div>
            </Card>
          ))}

          {/* Clear Cart */}
          <div className="flex justify-between items-center pt-4">
            <Link to="/shop/products">
              <Button variant="outline">Continue Shopping</Button>
            </Link>
            <Button
              variant="ghost"
              className="text-red-500 hover:text-red-600 hover:bg-red-50"
              onClick={() => {
                clearCart();
                toast.success('Cart cleared');
              }}
            >
              Clear Cart
            </Button>
          </div>
        </div>

        {/* Order Summary */}
        <div>
          <Card className="p-6 sticky top-24">
            <h2 className="text-lg font-bold text-slate-900 mb-4">Order Summary</h2>
            
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Subtotal ({cart.length} items)</span>
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
              
              {subtotal < 500 && (
                <p className="text-xs text-amber-600 bg-amber-50 p-2 rounded">
                  Spend {formatPrice(500 - subtotal)} more for free delivery!
                </p>
              )}
              
              <hr className="my-3" />
              
              <div className="flex justify-between text-lg font-bold">
                <span>Total</span>
                <span>{formatPrice(total)}</span>
              </div>
            </div>

            <Button
              size="lg"
              className="w-full mt-6 bg-amber-500 hover:bg-amber-600 text-slate-900 font-semibold"
              onClick={handleCheckout}
            >
              Proceed to Checkout
              <ArrowRight className="w-5 h-5 ml-2" />
            </Button>

            <p className="text-xs text-slate-500 text-center mt-4">
              Secure checkout powered by Stripe
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default ShopCart;
