import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import MarginIntelligenceCard from './MarginIntelligenceCard';
import { 
  Package, Truck, FolderOpen, Building2, Upload, Tag, Grid3X3, Square,
  Image, RefreshCw, ArrowRight, TrendingUp, AlertCircle, Database, Activity
} from 'lucide-react';
import { Card, CardContent } from '../../components/ui/card';
import { useHubCardFilter } from '../../hooks/useHubCardFilter';

const API_URL = process.env.REACT_APP_BACKEND_URL;

export default function ProductsHub() {
  const [stats, setStats] = useState({
    totalProducts: 0,
    supplierProducts: 0,
    categories: 0,
    lowStock: 0
  });

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const token = localStorage.getItem('token');
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};

      // Fetch each stat independently so one failure doesn't zero out everything
      let totalProducts = 0, supplierProducts = 0, categories = 0, lowStock = 0;

      try {
        const productsRes = await fetch(`${API_URL}/api/products?limit=1`, { headers });
        const productsData = await productsRes.json();
        totalProducts = productsData.total || (Array.isArray(productsData) ? productsData.length : 0);
        lowStock = productsData.low_stock_count || 0;
      } catch (e) { console.error('Products stats error:', e); }

      try {
        const supplierRes = await fetch(`${API_URL}/api/supplier-sync/stats`, { headers });
        const supplierData = await supplierRes.json();
        supplierProducts = typeof supplierData === 'object' && !Array.isArray(supplierData) && !supplierData.detail
          ? (supplierData._total || Object.values(supplierData).reduce((a, b) => a + (typeof b === 'number' ? b : 0), 0))
          : 0;
      } catch (e) { console.error('Supplier stats error:', e); }

      try {
        const categoriesRes = await fetch(`${API_URL}/api/categories`, { headers });
        const categoriesData = await categoriesRes.json();
        categories = Array.isArray(categoriesData) ? categoriesData.length : 0;
      } catch (e) { console.error('Categories stats error:', e); }

      setStats({ totalProducts, supplierProducts, categories, lowStock });
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  };

  const mainCards = [
    {
      title: 'All Products',
      description: 'View and manage your complete product catalog',
      icon: Package,
      link: '/admin/products',
      color: 'bg-blue-500',
      stat: stats.totalProducts,
      statLabel: 'products',
      permission: 'supplier_products',
      legacyPermission: 'products',
    },
    {
      title: 'Supplier Products',
      description: 'Manage products from Verona, Trimline, and other suppliers',
      icon: Truck,
      link: '/admin/supplier-products',
      color: 'bg-green-500',
      stat: stats.supplierProducts,
      statLabel: 'supplier items',
      permission: 'supplier_products',
      legacyPermission: 'products',
    },
    {
      title: 'Materials Manager',
      description: 'Adhesives, grouts, sealants & cleaning — uses the shared Quick Edit Product modal',
      icon: Package,
      link: '/admin/materials',
      color: 'bg-orange-500',
      stat: null,
      statLabel: 'materials',
      permission: 'supplier_products',
      legacyPermission: 'products',
      badge: 'NEW',
    },
    {
      title: 'Tiles Manager',
      description: 'Wall &amp; floor tiles, mosaics, borders — uses the shared Quick Edit Product modal',
      icon: Square,
      link: '/admin/tiles',
      color: 'bg-blue-500',
      stat: null,
      statLabel: 'tiles',
      permission: 'supplier_products',
      legacyPermission: 'products',
      badge: 'NEW',
    },
    {
      title: 'Sync Hub',
      description: 'Review and apply sync data before updating products',
      icon: RefreshCw,
      link: '/admin/sync-hub',
      color: 'bg-cyan-500',
      stat: null,
      statLabel: null,
      permission: 'sync_hub',
      legacyPermission: 'products',
    },
    {
      title: 'Categories',
      description: 'Organize products into categories',
      icon: FolderOpen,
      link: '/admin/categories',
      color: 'bg-purple-500',
      stat: stats.categories,
      statLabel: 'categories',
      permission: 'manage_categories',
      legacyPermission: 'categories',
    },
    {
      title: 'Supplier Contacts',
      description: 'Manage supplier contact information',
      icon: Building2,
      link: '/admin/suppliers',
      color: 'bg-orange-500',
      stat: null,
      statLabel: null,
      permission: 'suppliers',
      legacyPermission: 'products',
    },
    {
      title: 'Supplier Health',
      description: 'Automatic data quality checks across all suppliers',
      icon: Activity,
      link: '/admin/supplier-health',
      color: 'bg-emerald-500',
      stat: null,
      statLabel: null,
      permission: 'supplier_health',
      legacyPermission: 'products',
    }
  ];

  const toolCards = [
    {
      title: 'Import Products',
      description: 'Bulk import products from spreadsheet',
      icon: Upload,
      link: '/admin/products/import',
      color: 'bg-slate-600',
      permission: 'stock_import',
      legacyPermission: 'products',
      superAdminOnly: true,
    },
    {
      title: 'Price Tickets',
      description: 'Generate and print price labels',
      icon: Tag,
      link: '/admin/price-tickets',
      color: 'bg-slate-600',
      permission: 'supplier_products',
      legacyPermission: 'products',
    },
    {
      title: 'Tiles Info',
      description: 'Tile specifications and details',
      icon: Grid3X3,
      link: '/admin/tiles-info',
      color: 'bg-slate-600',
      permission: 'supplier_products',
      legacyPermission: 'products',
    },
    {
      title: 'Image Scraper',
      description: 'Scrape product images from suppliers',
      icon: Image,
      link: '/admin/image-scraper',
      color: 'bg-slate-600',
      permission: 'image_scraper',
      legacyPermission: 'products',
      superAdminOnly: true,
    },
    {
      title: 'Verona Sync Log',
      description: 'View extension sync history',
      icon: RefreshCw,
      link: '/admin/supplier-sync',
      color: 'bg-slate-600',
      permission: 'supplier_sync',
      legacyPermission: 'products',
    },
    {
      title: 'Scraping Portal',
      description: 'Manage automated overnight scrapers',
      icon: Database,
      link: '/admin/scraping-portal',
      color: 'bg-teal-600',
      permission: 'scraping_portal',
      legacyPermission: 'products',
      superAdminOnly: true,
    }
  ];

  // Filter cards by the current user's effective permissions
  // (16 May 2026 fix — hub pages used to render ALL cards regardless
  // of who was viewing them, so removing pages from the Staff role
  // didn't actually hide the corresponding hub cards. Now they do.)
  const keepCard = useHubCardFilter();
  const visibleMainCards = mainCards.filter(keepCard);
  const visibleToolCards = toolCards.filter(keepCard);

  return (
    <div className="p-6 space-y-8" data-testid="products-hub">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Products & Suppliers</h1>
        <p className="text-gray-500 mt-1">Manage your product catalog and supplier inventory</p>
      </div>

      <MarginIntelligenceCard />

      {/* Quick Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="border-l-4 border-l-blue-500">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Total Products</p>
                <p className="text-2xl font-bold">{stats.totalProducts}</p>
              </div>
              <Package className="w-8 h-8 text-blue-500 opacity-50" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-green-500">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Supplier Products</p>
                <p className="text-2xl font-bold">{stats.supplierProducts}</p>
              </div>
              <Truck className="w-8 h-8 text-green-500 opacity-50" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-purple-500">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Categories</p>
                <p className="text-2xl font-bold">{stats.categories}</p>
              </div>
              <FolderOpen className="w-8 h-8 text-purple-500 opacity-50" />
            </div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-red-500">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">Low Stock Items</p>
                <p className="text-2xl font-bold">{stats.lowStock}</p>
              </div>
              <AlertCircle className="w-8 h-8 text-red-500 opacity-50" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Navigation Cards */}
      <div>
        <h2 className="text-lg font-semibold mb-4">Main Sections</h2>
        {visibleMainCards.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No sections available for your role.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            {visibleMainCards.map((card) => (
              <Link key={card.link} to={card.link}>
                <Card className="h-full hover:shadow-lg transition-all cursor-pointer group border-2 hover:border-gray-300">
                  <CardContent className="pt-6">
                    <div className={`w-12 h-12 rounded-lg ${card.color} flex items-center justify-center mb-4`}>
                      <card.icon className="w-6 h-6 text-white" />
                    </div>
                    <h3 className="font-semibold text-lg mb-1 group-hover:text-blue-600 flex items-center gap-2">
                      {card.title}
                      <ArrowRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </h3>
                    <p className="text-sm text-gray-500 mb-3">{card.description}</p>
                    {card.stat !== null && (
                      <div className="flex items-center gap-1 text-sm">
                        <TrendingUp className="w-4 h-4 text-green-500" />
                        <span className="font-medium">{card.stat}</span>
                        <span className="text-gray-400">{card.statLabel}</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Tools Section */}
      {visibleToolCards.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-4">Tools & Utilities</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            {visibleToolCards.map((card) => (
              <Link key={card.link} to={card.link}>
                <Card className="hover:shadow-md transition-all cursor-pointer group">
                  <CardContent className="pt-4 pb-4">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-lg ${card.color} flex items-center justify-center`}>
                        <card.icon className="w-5 h-5 text-white" />
                      </div>
                      <div>
                        <h3 className="font-medium text-sm group-hover:text-blue-600">{card.title}</h3>
                        <p className="text-xs text-gray-400">{card.description}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
