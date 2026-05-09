import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { ShoppingCart, Package } from 'lucide-react';
import { Card } from '../../components/ui/card';
import { safeToFixed } from '../../utils/safeStr';

export const CustomerOrders = () => {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchOrders();
  }, []);

  const fetchOrders = async () => {
    try {
      const response = await api.getOrders();
      setOrders(response.data);
    } catch (error) {
      toast.error('Failed to load orders');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  return (
    <div className="space-y-6" data-testid="customer-orders-page">
      <div>
        <h1 className="text-4xl font-heading font-bold tracking-tightest mb-2">My Orders</h1>
        <p className="text-muted-foreground">Track your order history</p>
      </div>

      <div className="space-y-4">
        {orders.length === 0 ? (
          <Card className="p-12 text-center">
            <ShoppingCart className="h-16 w-16 mx-auto mb-4 text-muted-foreground opacity-20" />
            <p className="text-muted-foreground">No orders yet</p>
            <p className="text-sm text-muted-foreground mt-2">Browse products and place your first order</p>
          </Card>
        ) : (
          orders.map(order => (
            <Card key={order.id} className="p-6" data-testid={`order-card-${order.id}`}>
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-8 space-y-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-1">Order ID</p>
                      <p className="font-mono text-sm">{order.id}</p>
                    </div>
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                      order.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                      order.status === 'processing' ? 'bg-blue-100 text-blue-800' :
                      order.status === 'completed' ? 'bg-emerald-100 text-emerald-800' :
                      order.status === 'cancelled' ? 'bg-red-100 text-red-800' :
                      'bg-gray-100 text-gray-800'
                    }`} data-testid={`order-status-badge-${order.id}`}>
                      {order.status}
                    </span>
                  </div>

                  <div>
                    <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-2">Items</p>
                    <div className="space-y-2">
                      {order.items.map((item, idx) => (
                        <div key={idx} className="flex items-center justify-between p-3 bg-secondary rounded-md">
                          <div className="flex items-center gap-3">
                            <Package className="h-4 w-4 text-muted-foreground" />
                            <div>
                              <p className="font-medium text-sm">{item.product_name}</p>
                              <p className="text-xs text-muted-foreground">Quantity: {item.quantity}</p>
                            </div>
                          </div>
                          <p className="font-mono tabular-nums text-sm">£{(item.price * item.quantity).toFixed(2)}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="lg:col-span-4 space-y-4">
                  <div className="p-4 bg-secondary rounded-md">
                    <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-2">Total Amount</p>
                    <p className="text-3xl font-heading font-bold tracking-tightest tabular-nums" data-testid={`order-total-${order.id}`}>
                      £{safeToFixed(order.total_amount, 2)}
                    </p>
                  </div>

                  <div className="p-4 bg-secondary rounded-md">
                    <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-2">Order Date</p>
                    <p className="text-sm">{new Date(order.created_at).toLocaleDateString()}</p>
                    <p className="text-xs text-muted-foreground">{new Date(order.created_at).toLocaleTimeString()}</p>
                  </div>

                  {order.status === 'completed' && (
                    <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-md">
                      <p className="text-sm text-emerald-800 font-medium">Order Completed</p>
                      <p className="text-xs text-emerald-600 mt-1">Thank you for your order!</p>
                    </div>
                  )}

                  {order.status === 'pending' && (
                    <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-md">
                      <p className="text-sm text-yellow-800 font-medium">Pending</p>
                      <p className="text-xs text-yellow-600 mt-1">Your order is being processed</p>
                    </div>
                  )}

                  {order.status === 'processing' && (
                    <div className="p-4 bg-blue-50 border border-blue-200 rounded-md">
                      <p className="text-sm text-blue-800 font-medium">Processing</p>
                      <p className="text-xs text-blue-600 mt-1">Your order is being prepared</p>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
};
