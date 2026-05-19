import React, { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { toast } from 'sonner';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { BarChart3, TrendingUp, Package, ShoppingCart, Download, FileSpreadsheet, FileText } from 'lucide-react';
import { CreditLiabilityByShowroomCard } from '../../components/admin/CreditLiabilityByShowroomCard';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

export const AdminReports = () => {
  const [stats, setStats] = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(null);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [statsRes, productsRes] = await Promise.all([
        api.getDashboardStats(),
        api.getProducts()
      ]);
      setStats(statsRes.data);
      setProducts(productsRes.data);
    } catch (error) {
      toast.error('Failed to load reports');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async (type, format) => {
    const exportKey = `${type}_${format}`;
    setExporting(exportKey);
    
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API}/export/${type}/${format}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (!response.ok) {
        throw new Error('Export failed');
      }
      
      const blob = await response.blob();
      const contentDisposition = response.headers.get('Content-Disposition');
      const filename = contentDisposition 
        ? contentDisposition.split('filename=')[1]?.replace(/"/g, '')
        : `${type}_export.${format}`;
      
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      
      toast.success(`${type.charAt(0).toUpperCase() + type.slice(1)} exported successfully!`);
    } catch (error) {
      toast.error(`Failed to export ${type}`);
      console.error(error);
    } finally {
      setExporting(null);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64">Loading...</div>;
  }

  const topProducts = [...products]
    .sort((a, b) => b.stock - a.stock)
    .slice(0, 10);

  const lowStockProducts = products.filter(p => p.stock <= p.reorder_level);

  return (
    <div className="space-y-6" data-testid="admin-reports-page">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-4xl font-heading font-bold tracking-tightest mb-2">Reports & Analytics</h1>
          <p className="text-muted-foreground">Insights into your warehouse operations</p>
        </div>
      </div>

      {/* Export Section */}
      <Card className="p-6" data-testid="export-section">
        <h2 className="text-xl font-heading font-bold tracking-tightest mb-4 flex items-center gap-2">
          <Download className="h-5 w-5" />
          Export Reports
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Inventory Export */}
          <div className="bg-secondary rounded-lg p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <Package className="h-4 w-4 text-blue-600" />
              Inventory Report
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              Export all products with stock levels, pricing tiers, and reorder alerts.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleExport('inventory', 'csv')}
                disabled={exporting === 'inventory_csv'}
                data-testid="export-inventory-csv"
              >
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                {exporting === 'inventory_csv' ? 'Exporting...' : 'CSV'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleExport('inventory', 'pdf')}
                disabled={exporting === 'inventory_pdf'}
                data-testid="export-inventory-pdf"
              >
                <FileText className="h-4 w-4 mr-2" />
                {exporting === 'inventory_pdf' ? 'Exporting...' : 'PDF'}
              </Button>
            </div>
          </div>

          {/* Orders Export */}
          <div className="bg-secondary rounded-lg p-4">
            <h3 className="font-semibold mb-3 flex items-center gap-2">
              <ShoppingCart className="h-4 w-4 text-green-600" />
              Orders Report
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              Export all orders with customer details, items, and totals.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleExport('orders', 'csv')}
                disabled={exporting === 'orders_csv'}
                data-testid="export-orders-csv"
              >
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                {exporting === 'orders_csv' ? 'Exporting...' : 'CSV'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleExport('orders', 'pdf')}
                disabled={exporting === 'orders_pdf'}
                data-testid="export-orders-pdf"
              >
                <FileText className="h-4 w-4 mr-2" />
                {exporting === 'orders_pdf' ? 'Exporting...' : 'PDF'}
              </Button>
            </div>
          </div>
        </div>
      </Card>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="p-6" data-testid="report-total-products">
          <div className="flex items-start justify-between mb-4">
            <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Total Products</p>
            <Package className="h-5 w-5 text-blue-600" strokeWidth={1.5} />
          </div>
          <p className="text-3xl font-heading font-bold tracking-tightest tabular-nums">{stats?.total_products || 0}</p>
        </Card>

        <Card className="p-6" data-testid="report-low-stock">
          <div className="flex items-start justify-between mb-4">
            <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Low Stock</p>
            <TrendingUp className="h-5 w-5 text-accent" strokeWidth={1.5} />
          </div>
          <p className="text-3xl font-heading font-bold tracking-tightest tabular-nums text-accent">{stats?.low_stock_count || 0}</p>
        </Card>

        <Card className="p-6" data-testid="report-total-orders">
          <div className="flex items-start justify-between mb-4">
            <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Total Orders</p>
            <ShoppingCart className="h-5 w-5 text-emerald-600" strokeWidth={1.5} />
          </div>
          <p className="text-3xl font-heading font-bold tracking-tightest tabular-nums">{stats?.total_orders || 0}</p>
        </Card>

        <Card className="p-6" data-testid="report-total-revenue">
          <div className="flex items-start justify-between mb-4">
            <p className="text-xs font-mono uppercase tracking-widest text-muted-foreground">Total Revenue</p>
            <BarChart3 className="h-5 w-5 text-purple-600" strokeWidth={1.5} />
          </div>
          <p className="text-3xl font-heading font-bold tracking-tightest tabular-nums">£{stats?.total_revenue?.toFixed(2) || '0.00'}</p>
        </Card>
      </div>

      {/* Credit Liability by Showroom — 24 Feb 2026.
          Surfaces per-showroom credit liability + earn/redeem ratio
          so the owner can spot a store accumulating credit faster
          than customers come back to redeem it. */}
      <div className="mb-6">
        <CreditLiabilityByShowroomCard />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6" data-testid="top-products-card">
          <h2 className="text-xl font-heading font-bold tracking-tightest mb-4 pb-3 border-b border-border/50">
            Top 10 Products by Stock
          </h2>
          <div className="space-y-3">
            {topProducts.map((product, idx) => (
              <div key={product.id} className="flex items-center justify-between p-3 bg-secondary rounded-md">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-muted-foreground w-6">{idx + 1}</span>
                  <div>
                    <p className="font-medium text-sm">{product.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{product.sku}</p>
                  </div>
                </div>
                <p className="font-bold tabular-nums">{product.stock}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-6" data-testid="low-stock-report-card">
          <h2 className="text-xl font-heading font-bold tracking-tightest mb-4 pb-3 border-b border-border/50">
            Low Stock Items
          </h2>
          <div className="space-y-3">
            {lowStockProducts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">All products are well stocked</p>
            ) : (
              lowStockProducts.map(product => (
                <div key={product.id} className="flex items-center justify-between p-3 bg-accent/10 rounded-md border border-accent/20">
                  <div>
                    <p className="font-medium text-sm">{product.name}</p>
                    <p className="text-xs text-muted-foreground">Reorder at: {product.reorder_level}</p>
                  </div>
                  <p className="font-bold text-accent tabular-nums">{product.stock}</p>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
};
