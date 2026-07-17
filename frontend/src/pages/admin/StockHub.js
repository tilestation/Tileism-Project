import React from 'react';
import HubPage from '../../components/HubPage';
import { 
  Warehouse, Boxes, Layers, Upload, Truck, 
  PackageSearch, PoundSterling, ClipboardList, BarChart3
} from 'lucide-react';

export default function StockHub() {
  const cards = [
    {
      title: 'Tonbridge Warehouse',
      description: 'Live warehouse stock — visible to every store',
      icon: Warehouse,
      link: '/admin/warehouse',
      color: 'bg-slate-900',
      permission: 'warehouse', legacyPermission: 'products',
    },
    {
      title: 'Stock Allocation',
      description: 'Allocate stock to stores and locations',
      icon: Boxes,
      link: '/admin/stock-allocation',
      color: 'bg-blue-600',
      permission: 'stock_allocation', legacyPermission: 'products',
    },
    {
      title: 'Bulk Stock Edit',
      description: 'Update multiple stock quantities at once',
      icon: Layers,
      link: '/admin/bulk-stock',
      color: 'bg-green-600',
      permission: 'bulk_stock', legacyPermission: 'products',
    },
    {
      title: 'Stock Import',
      description: 'Import stock from spreadsheet',
      icon: Upload,
      link: '/admin/stock-import',
      color: 'bg-purple-600',
      permission: 'stock_import', legacyPermission: 'products',
      superAdminOnly: true,
    },
    {
      title: 'Delivery Check-In',
      description: 'Check in deliveries and update stock',
      icon: Truck,
      link: '/admin/delivery-check-in',
      color: 'bg-orange-600',
      permission: 'delivery_check_in', legacyPermission: 'products',
    },
    {
      title: 'To Order Report',
      description: 'Products that need to be reordered',
      icon: PackageSearch,
      link: '/admin/to-order',
      color: 'bg-red-600',
      permission: 'to_order_report', legacyPermission: 'reports',
    },
    {
      title: 'Stock Value',
      description: 'Total value of current stock',
      icon: PoundSterling,
      link: '/admin/stock-cost',
      color: 'bg-emerald-600',
      permission: 'stock_cost', legacyPermission: 'reports',
    },
    {
      title: 'Stocktake Report',
      description: 'Generate stocktake reports',
      icon: ClipboardList,
      link: '/admin/stocktake-report',
      color: 'bg-cyan-600',
      permission: 'stocktake_report', legacyPermission: 'reports',
    },
    {
      title: 'Stock Analytics',
      description: 'Stock movement and trends',
      icon: BarChart3,
      link: '/admin/stock-analytics',
      color: 'bg-slate-600',
      permission: 'analytics', legacyPermission: 'reports',
    },
  ];

  return (
    <HubPage 
      title="Stock Management" 
      subtitle="Manage inventory across all locations"
      icon={Warehouse}
      cards={cards} 
    />
  );
}
