import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Search, Grid, List, Filter, Package } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { ShopHeader, ShopFooter } from './TileStationHome';
import SeoHead from '../../components/seo/SeoHead';
import ProductGridSkeleton from '../../components/shop/ProductGridSkeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const NewCollectionPage = () => {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedSupplier, setSelectedSupplier] = useState('all');
  const [stats, setStats] = useState({ total: 0, by_supplier: {} });
  const [viewMode, setViewMode] = useState('grid');

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedSupplier !== 'all') {
        params.append('supplier', selectedSupplier);
      }
      if (searchTerm) {
        params.append('search', searchTerm);
      }
      
      const response = await fetch(`${API_URL}/api/sync-staging/special-products/new-collection?${params}`);
      if (response.ok) {
        const data = await response.json();
        setProducts(data.products || []);
        setStats({ total: data.total, by_supplier: data.by_supplier || {} });
      }
    } catch (error) {
      console.error('Error fetching new collection products:', error);
    } finally {
      setLoading(false);
    }
  }, [selectedSupplier, searchTerm]);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts]);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      fetchProducts();
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const suppliers = Object.keys(stats.by_supplier);

  return (
    <div className="min-h-screen bg-gray-50">
      <SeoHead
        title="New Tile Collection · Latest Arrivals & Trending Designs"
        description="Discover our latest tile arrivals at Tile Station — fresh designs and trending styles just added. Premium kitchen, bathroom and floor tiles with free UK delivery on orders over £500."
        canonical="/new-collection"
        keywords="new tile collection, latest tile designs, trending tiles, modern tiles, new arrivals tiles UK"
      />
      <ShopHeader />
      
      {/* Hero Banner */}
      <div className="bg-gradient-to-r from-emerald-600 to-teal-500 text-white py-12">
        <div className="container mx-auto px-4">
          <div className="flex items-center gap-3 mb-4">
            <Sparkles className="w-10 h-10" />
            <h1 className="text-4xl font-bold">New Collection</h1>
          </div>
          <p className="text-xl text-emerald-100 max-w-2xl">
            Discover our latest arrivals! Fresh designs and trending styles 
            just added to our collection.
          </p>
          <div className="mt-6 flex items-center gap-4">
            <div className="bg-white/20 backdrop-blur px-4 py-2 rounded-lg">
              <span className="text-2xl font-bold">{stats.total}</span>
              <span className="ml-2 text-emerald-100">New Products</span>
            </div>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-8">
        {/* Filters Bar */}
        <div className="bg-white rounded-lg shadow-sm p-4 mb-6">
          <div className="flex flex-col md:flex-row gap-4 items-center justify-between">
            <div className="flex-1 w-full md:w-auto relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Search new collection..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 w-full"
              />
            </div>
            
            <div className="flex items-center gap-4">
              {suppliers.length > 0 && (
                <Select value={selectedSupplier} onValueChange={setSelectedSupplier}>
                  <SelectTrigger className="w-[180px]">
                    <Filter className="w-4 h-4 mr-2" />
                    <SelectValue placeholder="All Suppliers" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Suppliers</SelectItem>
                    {suppliers.map(supplier => (
                      <SelectItem key={supplier} value={supplier}>
                        {supplier} ({stats.by_supplier[supplier]})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              
              <div className="flex border rounded-lg overflow-hidden">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`p-2 ${viewMode === 'grid' ? 'bg-emerald-500 text-white' : 'bg-white text-gray-600'}`}
                >
                  <Grid className="w-5 h-5" />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`p-2 ${viewMode === 'list' ? 'bg-emerald-500 text-white' : 'bg-white text-gray-600'}`}
                >
                  <List className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Results */}
        {loading ? (
          // 14 May 2026 — skeleton grid (was a centred emerald spinner)
          <ProductGridSkeleton
            count={8}
            cols="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6"
            testId="new-collection-skeleton"
          />
        ) : products.length === 0 ? (
          <div className="text-center py-20">
            <Sparkles className="w-16 h-16 mx-auto mb-4 text-gray-300" />
            <h2 className="text-2xl font-semibold text-gray-700 mb-2">No New Products Yet</h2>
            <p className="text-gray-500 mb-6">Check back soon for exciting new arrivals!</p>
            <Link to="/tiles">
              <Button className="bg-emerald-500 hover:bg-emerald-600">
                Browse All Tiles
              </Button>
            </Link>
          </div>
        ) : (
          <div className={viewMode === 'grid' 
            ? "grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6" 
            : "space-y-4"
          }>
            {products.map((product) => (
              <ProductCard key={product.sku} product={product} viewMode={viewMode} />
            ))}
          </div>
        )}
      </div>

      <ShopFooter />
    </div>
  );
};

const ProductCard = ({ product, viewMode }) => {
  const displayName = product.product_name || product.name;
  const stock = product.stock_quantity || product.stock_m2 || 0;
  const stockUnit = product.stock_m2 ? 'm²' : 'units';
  
  if (viewMode === 'list') {
    return (
      <div className="bg-white rounded-lg shadow-sm p-4 flex gap-4 hover:shadow-md transition-shadow">
        <div className="w-32 h-32 flex-shrink-0 rounded-lg overflow-hidden bg-gray-100">
          {product.image ? (
            <img 
              src={product.image} 
              alt={displayName}
              className="w-full h-full object-cover"
              onError={(e) => e.target.src = '/placeholder-tile.png'}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <Package className="w-8 h-8 text-gray-300" />
            </div>
          )}
        </div>
        <div className="flex-1">
          <div className="flex items-start justify-between">
            <div>
              <span className="inline-block bg-emerald-500 text-white text-xs px-2 py-1 rounded-full mb-2">
                NEW
              </span>
              <h3 className="font-semibold text-gray-900">{displayName}</h3>
              <p className="text-sm text-gray-500 mt-1">{product.supplier}</p>
            </div>
            {product.price && (
              <div className="text-right">
                <p className="text-2xl font-bold text-emerald-600">£{product.price?.toFixed(2)}</p>
                <p className="text-sm text-gray-500">per m²</p>
              </div>
            )}
          </div>
          <div className="mt-3 flex items-center gap-4 text-sm text-gray-600">
            {product.size && <span>Size: {product.size}</span>}
            {product.finish && <span>Finish: {product.finish}</span>}
            <span className={stock > 0 ? 'text-green-600' : 'text-red-600'}>
              Stock: {stock} {stockUnit}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden hover:shadow-md transition-shadow group">
      <div className="relative aspect-square bg-gray-100">
        {product.image ? (
          <img 
            src={product.image} 
            alt={displayName}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            onError={(e) => e.target.src = '/placeholder-tile.png'}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Package className="w-12 h-12 text-gray-300" />
          </div>
        )}
        <span className="absolute top-3 left-3 bg-emerald-500 text-white text-xs px-2 py-1 rounded-full font-medium">
          NEW
        </span>
      </div>
      <div className="p-4">
        <p className="text-xs text-gray-500 mb-1">{product.supplier}</p>
        <h3 className="font-semibold text-gray-900 line-clamp-2 min-h-[48px]">{displayName}</h3>
        <div className="mt-2 flex items-center justify-between">
          {product.price && (
            <p className="text-xl font-bold text-emerald-600">£{product.price?.toFixed(2)}</p>
          )}
          <span className={`text-sm ${stock > 0 ? 'text-green-600' : 'text-red-600'}`}>
            {stock > 0 ? `${stock} ${stockUnit} left` : 'Out of stock'}
          </span>
        </div>
        {product.size && (
          <p className="text-sm text-gray-500 mt-1">{product.size}</p>
        )}
      </div>
    </div>
  );
};

export default NewCollectionPage;
