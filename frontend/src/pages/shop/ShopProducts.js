import React, { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { Filter, Grid, List, SlidersHorizontal, X, ShoppingCart, Heart } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Input } from '../../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Checkbox } from '../../components/ui/checkbox';
import { useShopAuth } from '../../contexts/ShopAuthContext';
import { useTradeUser } from '../../hooks/useTradeUser';
import { toast } from 'sonner';
import { safeArr } from '../../utils/safeStr';

export const ShopProducts = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const { isTrade, getTradePrice } = useTradeUser();
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [totalProducts, setTotalProducts] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [viewMode, setViewMode] = useState('grid');
  const { addToCart, isAuthenticated } = useShopAuth();

  // Get filter values from URL
  const currentPage = parseInt(searchParams.get('page') || '1');
  const categoryId = searchParams.get('category_id') || '';
  const search = searchParams.get('search') || '';
  const minPrice = searchParams.get('min_price') || '';
  const maxPrice = searchParams.get('max_price') || '';
  const inStockOnly = searchParams.get('in_stock_only') === 'true';
  const clearanceOnly = searchParams.get('clearance_only') === 'true';
  const sortBy = searchParams.get('sort_by') || 'name';

  useEffect(() => {
    fetchCategories();
  }, []);

  useEffect(() => {
    fetchProducts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const fetchCategories = async () => {
    try {
      const response = await api.shopGetCategories();
      setCategories(response.data);
    } catch (error) {
      console.error('Failed to load categories:', error);
    }
  };

  const fetchProducts = async () => {
    setLoading(true);
    try {
      const params = {
        page: currentPage,
        limit: 20,
        sort_by: sortBy
      };
      
      if (categoryId) params.category_id = categoryId;
      if (search) params.search = search;
      if (minPrice) params.min_price = parseFloat(minPrice);
      if (maxPrice) params.max_price = parseFloat(maxPrice);
      if (inStockOnly) params.in_stock_only = true;
      if (clearanceOnly) params.clearance_only = true;

      const response = await api.shopGetProducts(params);
      setProducts(response.data.products);
      setTotalProducts(response.data.total);
      setTotalPages(response.data.total_pages);
    } catch (error) {
      console.error('Failed to load products:', error);
      toast.error('Failed to load products');
    } finally {
      setLoading(false);
    }
  };

  const updateFilter = (key, value) => {
    const params = new URLSearchParams(searchParams);
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    // Only reset to first page when changing filters, not when changing page directly
    if (key !== 'page') {
      params.set('page', '1');
    }
    setSearchParams(params);
  };

  const clearFilters = () => {
    setSearchParams({});
  };

  const handleAddToCart = async (product, e) => {
    e.preventDefault();
    e.stopPropagation();
    
    try {
      await addToCart({
        product_id: product.id,
        name: product.name,
        sku: product.sku,
        price: product.clearance && product.clearance_price ? product.clearance_price : product.price,
        quantity: 1,
        image: product.images?.[0] || ''
      });
      toast.success(`${product.name} added to cart`);
    } catch (error) {
      toast.error('Failed to add to cart');
    }
  };

  const formatPrice = (price) => `£${(isTrade ? getTradePrice(price) : price)?.toFixed(2) || '0.00'}`;

  const hasActiveFilters = categoryId || search || minPrice || maxPrice || inStockOnly || clearanceOnly;

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-slate-900">
            {clearanceOnly ? 'Clearance Sale' : search ? `Search: "${search}"` : 'All Tiles'}
          </h1>
          <p className="text-slate-500 mt-1">{totalProducts} products found</p>
        </div>
        
        <div className="flex items-center gap-3">
          {/* Mobile Filter Toggle */}
          <Button
            variant="outline"
            className="lg:hidden"
            onClick={() => setShowFilters(!showFilters)}
          >
            <SlidersHorizontal className="w-4 h-4 mr-2" />
            Filters
          </Button>
          
          {/* Sort */}
          <Select value={sortBy} onValueChange={(v) => updateFilter('sort_by', v)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">Name (A-Z)</SelectItem>
              <SelectItem value="price_asc">Price (Low to High)</SelectItem>
              <SelectItem value="price_desc">Price (High to Low)</SelectItem>
              <SelectItem value="newest">Newest First</SelectItem>
            </SelectContent>
          </Select>
          
          {/* View Mode */}
          <div className="hidden sm:flex border rounded-lg overflow-hidden">
            <Button
              variant={viewMode === 'grid' ? 'default' : 'ghost'}
              size="sm"
              className="rounded-none"
              onClick={() => setViewMode('grid')}
            >
              <Grid className="w-4 h-4" />
            </Button>
            <Button
              variant={viewMode === 'list' ? 'default' : 'ghost'}
              size="sm"
              className="rounded-none"
              onClick={() => setViewMode('list')}
            >
              <List className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex gap-6">
        {/* Filters Sidebar */}
        <aside className={`
          fixed inset-y-0 left-0 z-50 w-80 bg-white shadow-lg transform transition-transform lg:relative lg:inset-auto lg:z-auto lg:w-64 lg:shadow-none lg:transform-none
          ${showFilters ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        `}>
          <div className="p-4 lg:p-0">
            {/* Mobile Close Button */}
            <div className="flex items-center justify-between mb-4 lg:hidden">
              <h3 className="font-semibold">Filters</h3>
              <Button variant="ghost" size="sm" onClick={() => setShowFilters(false)}>
                <X className="w-5 h-5" />
              </Button>
            </div>

            {/* Clear Filters */}
            {hasActiveFilters && (
              <Button
                variant="outline"
                size="sm"
                className="w-full mb-4"
                onClick={clearFilters}
              >
                Clear All Filters
              </Button>
            )}

            {/* Categories */}
            <div className="mb-6">
              <h3 className="font-semibold mb-3">Categories</h3>
              <div className="space-y-2">
                <button
                  className={`block text-sm w-full text-left px-2 py-1 rounded ${!categoryId ? 'bg-amber-100 text-amber-700' : 'hover:bg-gray-100'}`}
                  onClick={() => updateFilter('category_id', '')}
                >
                  All Categories
                </button>
                {categories.map((cat) => (
                  <button
                    key={cat.id}
                    className={`block text-sm w-full text-left px-2 py-1 rounded ${categoryId === cat.id ? 'bg-amber-100 text-amber-700' : 'hover:bg-gray-100'}`}
                    onClick={() => updateFilter('category_id', cat.id)}
                  >
                    {cat.name} ({cat.product_count})
                  </button>
                ))}
              </div>
            </div>

            {/* Price Range */}
            <div className="mb-6">
              <h3 className="font-semibold mb-3">Price Range</h3>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  placeholder="Min"
                  value={minPrice}
                  onChange={(e) => updateFilter('min_price', e.target.value)}
                  className="w-24"
                />
                <span className="text-slate-400">-</span>
                <Input
                  type="number"
                  placeholder="Max"
                  value={maxPrice}
                  onChange={(e) => updateFilter('max_price', e.target.value)}
                  className="w-24"
                />
              </div>
            </div>

            {/* Availability */}
            <div className="mb-6">
              <h3 className="font-semibold mb-3">Availability</h3>
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={inStockOnly}
                    onCheckedChange={(checked) => updateFilter('in_stock_only', checked ? 'true' : '')}
                  />
                  <span className="text-sm">In Stock Only</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={clearanceOnly}
                    onCheckedChange={(checked) => updateFilter('clearance_only', checked ? 'true' : '')}
                  />
                  <span className="text-sm">Clearance Items</span>
                </label>
              </div>
            </div>
          </div>
        </aside>

        {/* Mobile Overlay */}
        {showFilters && (
          <div
            className="fixed inset-0 bg-black/50 z-40 lg:hidden"
            onClick={() => setShowFilters(false)}
          />
        )}

        {/* Products Grid */}
        <div className="flex-1">
          {loading ? (
            <div className={`grid gap-4 ${viewMode === 'grid' ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4' : 'grid-cols-1'}`}>
              {[...Array(8)].map((_, i) => (
                <Card key={i} className="animate-pulse">
                  <div className="aspect-square bg-gray-200"></div>
                  <div className="p-4 space-y-2">
                    <div className="h-4 bg-gray-200 rounded w-3/4"></div>
                    <div className="h-4 bg-gray-200 rounded w-1/2"></div>
                  </div>
                </Card>
              ))}
            </div>
          ) : products.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-slate-500 mb-4">No products found</p>
              <Button variant="outline" onClick={clearFilters}>Clear Filters</Button>
            </div>
          ) : (
            <>
              <div className={`grid gap-4 ${viewMode === 'grid' ? 'grid-cols-2 md:grid-cols-3 lg:grid-cols-4' : 'grid-cols-1'}`}>
                {products.map((product) => (
                  <Link key={product.id} to={`/shop/products/${product.id}`}>
                    <Card className={`group overflow-hidden hover:shadow-lg transition-shadow ${viewMode === 'list' ? 'flex' : ''}`}>
                      <div className={`bg-gray-100 relative overflow-hidden ${viewMode === 'list' ? 'w-40 h-40 flex-shrink-0' : 'aspect-square'}`}>
                        {product.images?.[0] ? (
                          <img
                            src={product.images[0]}
                            alt={product.name}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400">
                            <span className="text-4xl">🪨</span>
                          </div>
                        )}
                        {product.clearance && (
                          <Badge className="absolute top-2 left-2 bg-red-500 text-white">Sale</Badge>
                        )}
                        {!product.in_stock && (
                          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                            <Badge variant="secondary">Out of Stock</Badge>
                          </div>
                        )}
                        
                        {/* Secondary Image Thumbnails */}
                        {product.images?.length > 1 && viewMode === 'grid' && (
                          <div className="absolute bottom-2 left-2 flex gap-1">
                            {safeArr(product.images).slice(1, 4).map((img, idx) => (
                              <div 
                                key={idx} 
                                className="w-8 h-8 rounded border-2 border-white overflow-hidden shadow-sm"
                              >
                                <img 
                                  src={img} 
                                  alt="" 
                                  className="w-full h-full object-cover"
                                />
                              </div>
                            ))}
                            {safeArr(product.images).length > 4 && (
                              <div className="w-8 h-8 rounded border-2 border-white bg-black/70 flex items-center justify-center shadow-sm">
                                <span className="text-white text-xs font-medium">+{safeArr(product.images).length - 4}</span>
                              </div>
                            )}
                          </div>
                        )}
                        
                        {/* Quick Actions */}
                        <div className="absolute bottom-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                          {product.in_stock && (
                            <Button
                              size="icon"
                              className="bg-white/90 hover:bg-white text-slate-900 h-8 w-8"
                              onClick={(e) => handleAddToCart(product, e)}
                            >
                              <ShoppingCart className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                      </div>
                      
                      <div className={`p-4 ${viewMode === 'list' ? 'flex-1' : ''}`}>
                        <p className="text-xs text-slate-500 mb-1">{product.sku}</p>
                        <h3 className="font-medium text-slate-900 group-hover:text-amber-600 transition-colors line-clamp-2">
                          {product.name}
                        </h3>
                        <p className="text-sm text-slate-500 mt-1">{product.category_name}</p>
                        
                        {viewMode === 'list' && product.description && (
                          <p className="text-sm text-slate-500 mt-2 line-clamp-2">{product.description.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')}</p>
                        )}
                        
                        <div className="mt-2 flex items-center gap-2">
                          {product.clearance && product.clearance_price ? (
                            <>
                              <span className="font-bold text-red-600">{formatPrice(product.clearance_price)}</span>
                              <span className="text-sm text-slate-400 line-through">{formatPrice(product.price)}</span>
                            </>
                          ) : (
                            <span className="font-bold text-slate-900">{formatPrice(product.price)}</span>
                          )}
                          <span className="text-sm text-slate-500">/ {product.unit}</span>
                        </div>
                        
                        {product.in_stock && (
                          <p className="text-xs text-green-600 mt-1">✓ In Stock ({product.stock} available)</p>
                        )}
                      </div>
                    </Card>
                  </Link>
                ))}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex justify-center gap-2 mt-8">
                  <Button
                    variant="outline"
                    disabled={currentPage === 1}
                    onClick={() => updateFilter('page', String(currentPage - 1))}
                  >
                    Previous
                  </Button>
                  
                  <div className="flex items-center gap-1">
                    {[...Array(Math.min(5, totalPages))].map((_, i) => {
                      let pageNum;
                      if (totalPages <= 5) {
                        pageNum = i + 1;
                      } else if (currentPage <= 3) {
                        pageNum = i + 1;
                      } else if (currentPage >= totalPages - 2) {
                        pageNum = totalPages - 4 + i;
                      } else {
                        pageNum = currentPage - 2 + i;
                      }
                      
                      return (
                        <Button
                          key={pageNum}
                          variant={currentPage === pageNum ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => updateFilter('page', String(pageNum))}
                        >
                          {pageNum}
                        </Button>
                      );
                    })}
                  </div>
                  
                  <Button
                    variant="outline"
                    disabled={currentPage === totalPages}
                    onClick={() => updateFilter('page', String(currentPage + 1))}
                  >
                    Next
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default ShopProducts;
