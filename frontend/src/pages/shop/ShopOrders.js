import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api';
import { Package, ChevronRight, Clock, CheckCircle, Truck, MapPin } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { useShopAuth } from '../../contexts/ShopAuthContext';
import { normaliseImageUrl, safeArr} from '../../utils/safeStr';

export const ShopOrders = () => {
  const { isAuthenticated } = useShopAuth();
  const navigate = useNavigate();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/shop/login?redirect=/shop/orders');
      return;
    }
    fetchOrders();
  }, [isAuthenticated, navigate]);

  const fetchOrders = async () => {
    try {
      const token = localStorage.getItem('shop_token');
      const response = await api.shopGetOrders(token);
      setOrders(response.data);
    } catch (error) {
      console.error('Failed to load orders:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatPrice = (price) => `£${price?.toFixed(2) || '0.00'}`;
  
  const formatDate = (dateStr) => {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  };

  const getStatusBadge = (status, paymentStatus) => {
    if (paymentStatus === 'pending') {
      return <Badge className="bg-yellow-100 text-yellow-800">Pending Payment</Badge>;
    }
    
    switch (status) {
      case 'confirmed':
        return <Badge className="bg-blue-100 text-blue-800">Confirmed</Badge>;
      case 'processing':
        return <Badge className="bg-purple-100 text-purple-800">Processing</Badge>;
      case 'shipped':
        return <Badge className="bg-indigo-100 text-indigo-800">Shipped</Badge>;
      case 'delivered':
        return <Badge className="bg-green-100 text-green-800">Delivered</Badge>;
      case 'ready_for_collection':
        return <Badge className="bg-amber-100 text-amber-800">Ready for Collection</Badge>;
      case 'collected':
        return <Badge className="bg-green-100 text-green-800">Collected</Badge>;
      case 'cancelled':
        return <Badge className="bg-red-100 text-red-800">Cancelled</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const getStatusIcon = (status, paymentStatus) => {
    if (paymentStatus === 'pending') {
      return <Clock className="w-5 h-5 text-yellow-500" />;
    }
    
    switch (status) {
      case 'delivered':
      case 'collected':
        return <CheckCircle className="w-5 h-5 text-green-500" />;
      case 'shipped':
        return <Truck className="w-5 h-5 text-indigo-500" />;
      case 'ready_for_collection':
        return <MapPin className="w-5 h-5 text-amber-500" />;
      default:
        return <Package className="w-5 h-5 text-blue-500" />;
    }
  };

  if (!isAuthenticated) {
    return null;
  }

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-8">My Orders</h1>
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <Card key={i} className="p-6 animate-pulse">
              <div className="h-6 bg-gray-200 rounded w-1/4 mb-4"></div>
              <div className="h-4 bg-gray-200 rounded w-1/2 mb-2"></div>
              <div className="h-4 bg-gray-200 rounded w-1/3"></div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (orders.length === 0) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <div className="max-w-md mx-auto">
          <div className="w-24 h-24 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <Package className="w-12 h-12 text-slate-400" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">No orders yet</h1>
          <p className="text-slate-500 mb-8">Start shopping to see your orders here.</p>
          <Link to="/shop/products">
            <Button size="lg" className="bg-amber-500 hover:bg-amber-600 text-slate-900">
              Start Shopping
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl md:text-3xl font-bold text-slate-900 mb-8">My Orders</h1>

      <div className="space-y-4">
        {orders.map((order) => (
          <Card key={order.id} className="p-6">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex items-start gap-4">
                {getStatusIcon(order.status, order.payment_status)}
                <div>
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <h3 className="font-semibold text-slate-900">{order.order_number}</h3>
                    {getStatusBadge(order.status, order.payment_status)}
                    {order.source === 'in_store' && (
                      <span
                        className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 border border-amber-200"
                        title={`Paid in store at ${order.showroom_name || 'our showroom'}`}
                        data-testid="instore-order-pill"
                      >
                        🏪 In-store
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-500">
                    {order.source === 'in_store' ? 'Issued at' : 'Placed on'} {formatDate(order.created_at)}
                    {order.source === 'in_store' && order.showroom_name ? ` · ${order.showroom_name}` : ''}
                  </p>
                  <p className="text-sm text-slate-500">
                    {order.items?.length} item(s){order.source !== 'in_store' && ` • ${order.delivery_method === 'collect' ? 'Click & Collect' : 'Delivery'}`}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-lg font-bold text-slate-900">{formatPrice(order.total)}</p>
                  <p className="text-xs text-slate-500">
                    {order.payment_status === 'paid' ? 'Paid' : 'Awaiting Payment'}
                  </p>
                </div>
                {order.source === 'in_store' ? (
                  <span className="text-xs text-slate-400 italic px-3" title="In-store invoices are managed by our team — please contact your local showroom for amendments.">
                    Receipt
                  </span>
                ) : (
                  <Link to={`/shop/orders/${order.id}`}>
                    <Button variant="ghost" size="icon">
                      <ChevronRight className="w-5 h-5" />
                    </Button>
                  </Link>
                )}
              </div>
            </div>

            {/* Order Items Preview */}
            <div className="mt-4 pt-4 border-t flex gap-2 overflow-x-auto">
              {order.items?.slice(0, 4).map((item, idx) => (
                <div key={idx} className="w-16 h-16 bg-gray-100 rounded flex-shrink-0">
                  {item.image ? (
                    <img src={normaliseImageUrl(item.image)} alt="" className="w-full h-full object-cover rounded" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-400 text-sm">🪨</div>
                  )}
                </div>
              ))}
              {order.items?.length > 4 && (
                <div className="w-16 h-16 bg-gray-100 rounded flex items-center justify-center text-sm text-slate-500">
                  +{safeArr(order.items).length - 4}
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
};

export default ShopOrders;
