import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Package, ShoppingCart, Eye } from 'lucide-react';
import { Card } from '../../components/ui/card';
import { safeToFixed, safeArr} from '../../utils/safeStr';

export const CustomerDashboard = () => {
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [productsRes, ordersRes] = await Promise.all([
        api.getProducts(),
        api.getOrders()
      ]);
      setProducts(productsRes.data.filter(p => p.stock > 0).slice(0, 6));
      setOrders(ordersRes.data.slice(0, 5));
    } catch (error) {
      toast.error('Failed to load dashboard data');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  return (
    <div className="space-y-8" data-testid="customer-dashboard">
      <div>
        <h1 className="text-4xl font-heading font-bold tracking-tightest mb-2">Dashboard</h1>
        <p className="text-muted-foreground">Welcome to your inventory portal</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card className="p-6" data-testid="available-products-card">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-2">Available Products</p>
              <p className="text-3xl font-heading font-bold tracking-tightest tabular-nums">{products.length}</p>
            </div>
            <Package className="h-8 w-8 text-blue-600" strokeWidth={1.5} />
          </div>
        </Card>

        <Card className="p-6" data-testid="my-orders-card">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground mb-2">My Orders</p>
              <p className="text-3xl font-heading font-bold tracking-tightest tabular-nums">{orders.length}</p>
            </div>
            <ShoppingCart className="h-8 w-8 text-emerald-600" strokeWidth={1.5} />
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6" data-testid="featured-products">
          <h2 className="text-xl font-heading font-bold tracking-tightest mb-4 pb-3 border-b border-border/50">
            Featured Products
          </h2>
          <div className="space-y-3">
            {products.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No products available</p>
            ) : (
              products.map(product => (
                <div key={product.id} className="flex items-center justify-between p-3 bg-secondary rounded-md" data-testid={`product-${product.id}`}>
                  <div>
                    <p className="font-medium">{product.name}</p>
                    <p className="text-xs text-muted-foreground">{product.category_name || 'Uncategorized'}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold tabular-nums">£{safeToFixed(product.price, 2)}</p>
                    <p className="text-xs text-muted-foreground">{product.stock} in stock</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card className="p-6" data-testid="recent-orders-customer">
          <h2 className="text-xl font-heading font-bold tracking-tightest mb-4 pb-3 border-b border-border/50">
            Recent Orders
          </h2>
          <div className="space-y-3">
            {orders.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No orders yet</p>
            ) : (
              orders.map(order => (
                <div key={order.id} className="flex items-center justify-between p-3 bg-secondary rounded-md" data-testid={`order-${order.id}`}>
                  <div>
                    <p className="font-medium text-sm font-mono">{order.id.substring(0, 8)}...</p>
                    <p className="text-xs text-muted-foreground">{safeArr(order.items).length} items</p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold tabular-nums text-sm">£{safeToFixed(order.total_amount, 2)}</p>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      order.status === 'pending' ? 'bg-yellow-100 text-yellow-800' :
                      order.status === 'completed' ? 'bg-emerald-100 text-emerald-800' :
                      'bg-gray-100 text-gray-800'
                    }`}>
                      {order.status}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};
