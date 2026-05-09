import React, { useState, useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Filter, Grid, List, Heart, ChevronDown, X, SlidersHorizontal } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Checkbox } from '../../components/ui/checkbox';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { useTradeUser } from '../../hooks/useTradeUser';
import SeoHead from '../../components/seo/SeoHead';
import { safeArr } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const TileListingPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tiles, setTiles] = useState([]);
  const [filters, setFilters] = useState(null);
  const [loading, setLoading] = useState(true);
  const { isTrade, getTradePrice } = useTradeUser();
  const [totalPages, setTotalPages] = useState(1);
  const [totalProducts, setTotalProducts] = useState(0);
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [viewMode, setViewMode] = useState('grid');

  // Get current filter values from URL
  const currentFilters = useMemo(() => ({
    search: searchParams.get('search') || '',
    supplier: searchParams.get('supplier') || '',
    size: searchParams.get('size') || '',
    finish: searchParams.get('finish') || '',
    color: searchParams.get('color') || '',
    material: searchParams.get('material') || '',
    sort: searchParams.get('sort') || 'name',
    page: parseInt(searchParams.get('page')) || 1,
  }), [searchParams]);

  // Fetch filters on mount
  useEffect(() => {
    const fetchFilters = async () => {
      try {
        const res = await fetch(`${API_URL}/api/tiles/filters`);
        const data = await res.json();
        setFilters(data);
      } catch (e) {
        console.error('Error loading filters:', e);
      }
    };
    fetchFilters();
  }, []);

  // Fetch tiles when filters change
  useEffect(() => {
    const fetchTiles = async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (currentFilters.search) params.append('search', currentFilters.search);
        if (currentFilters.supplier) params.append('supplier', currentFilters.supplier);
        if (currentFilters.size) params.append('size', currentFilters.size);
        if (currentFilters.finish) params.append('finish', currentFilters.finish);
        if (currentFilters.color) params.append('color', currentFilters.color);
        if (currentFilters.material) params.append('material', currentFilters.material);
        params.append('sort_by', currentFilters.sort);
        params.append('page', currentFilters.page);
        params.append('limit', 24);

        const res = await fetch(`${API_URL}/api/tiles/products?${params}`);
        const data = await res.json();
        
        setTiles(data.products || []);
        setTotalPages(data.total_pages || 1);
        setTotalProducts(data.total || 0);
      } catch (e) {
        console.error('Error loading tiles:', e);
      } finally {
        setLoading(false);
      }
    };
    fetchTiles();
  }, [currentFilters]);

  const updateFilter = (key, value) => {
    const newParams = new URLSearchParams(searchParams);
    if (value) {
      newParams.set(key, value);
    } else {
      newParams.delete(key);
    }
    // Only reset to page 1 when changing filters, not when changing page directly
    if (key !== 'page') {
      newParams.set('page', '1');
    }
    setSearchParams(newParams);
  };

  const clearAllFilters = () => {
    setSearchParams({});
  };

  const activeFilterCount = Object.values(currentFilters).filter(v => v && v !== 'name' && v !== 1).length;

  // Filter Section Component
  const FilterSection = ({ title, options, filterKey, currentValue }) => (
    <div className="border-b border-gray-200 py-4">
      <h3 className="font-medium text-gray-900 mb-3">{title}</h3>
      <div className="space-y-2 max-h-48 overflow-y-auto">
        {options.map((option) => (
          <label key={option} className="flex items-center gap-2 cursor-pointer hover:text-amber-600">
            <Checkbox
              checked={currentValue === option}
              onCheckedChange={(checked) => updateFilter(filterKey, checked ? option : '')}
            />
            <span className="text-sm text-gray-700">{option}</span>
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-white">
      <SeoHead
        title={
          currentFilters.search
            ? `${currentFilters.search} — Tile Search Results`
            : currentFilters.category
              ? `${currentFilters.category} Tiles · Browse Range`
              : 'All Tiles · Premium Range with Free UK Delivery'
        }
        description={
          `Browse ${tiles.length} premium tiles from Tile Station. ` +
          `Kitchen, bathroom, floor and wall tiles in every size and finish. ` +
          `Free samples, free UK delivery on orders over £500.`
        }
        canonical={
          currentFilters.search || currentFilters.category
            ? `/tiles?${new URLSearchParams(currentFilters).toString()}`
            : '/tiles'
        }
        noindex={!!currentFilters.search}
      />
      <ShopHeader />

      <div className="container mx-auto px-4 py-8">
        {/* Breadcrumb & Title */}
        <div className="mb-6">
          <nav className="text-sm text-gray-500 mb-2">
            <Link to="/tiles" className="hover:text-amber-500">Collections</Link>
            <span className="mx-2">/</span>
            <span className="text-gray-900">All Products</span>
          </nav>
          <div className="flex justify-between items-center">
            <h1 className="text-2xl md:text-3xl font-bold text-gray-900">
              {currentFilters.search ? `Search: "${currentFilters.search}"` : 'All Tiles'}
            </h1>
            <span className="text-gray-500">{totalProducts} products</span>
          </div>
        </div>

        <div className="flex gap-8">
          {/* Desktop Filters Sidebar */}
          <aside className="hidden lg:block w-64 flex-shrink-0">
            <div className="sticky top-32">
              <div className="flex justify-between items-center mb-4">
                <h2 className="font-semibold text-gray-900 flex items-center gap-2">
                  <Filter className="h-4 w-4" />
                  Filters
                </h2>
                {activeFilterCount > 0 && (
                  <button 
                    onClick={clearAllFilters}
                    className="text-sm text-amber-500 hover:text-amber-600"
                  >
                    Clear all
                  </button>
                )}
              </div>

              {filters && (
                <>
                  <FilterSection 
                    title="Collection" 
                    options={filters.suppliers} 
                    filterKey="supplier" 
                    currentValue={currentFilters.supplier} 
                  />
                  <FilterSection 
                    title="Finish" 
                    options={filters.finishes} 
                    filterKey="finish" 
                    currentValue={currentFilters.finish} 
                  />
                  <FilterSection 
                    title="Size" 
                    options={safeArr(filters.sizes).slice(0, 15)} 
                    filterKey="size" 
                    currentValue={currentFilters.size} 
                  />
                  <FilterSection 
                    title="Colour" 
                    options={filters.colors} 
                    filterKey="color" 
                    currentValue={currentFilters.color} 
                  />
                  <FilterSection 
                    title="Material" 
                    options={filters.materials} 
                    filterKey="material" 
                    currentValue={currentFilters.material} 
                  />
                </>
              )}
            </div>
          </aside>

          {/* Main Content */}
          <main className="flex-1 min-w-0">
            {/* Toolbar */}
            <div className="flex flex-wrap justify-between items-center gap-4 mb-6 pb-4 border-b">
              {/* Mobile Filter Button */}
              <Button
                variant="outline"
                className="lg:hidden flex items-center gap-2"
                onClick={() => setShowMobileFilters(true)}
              >
                <SlidersHorizontal className="h-4 w-4" />
                Filters
                {activeFilterCount > 0 && (
                  <span className="bg-amber-500 text-white text-xs px-2 py-0.5 rounded-full">
                    {activeFilterCount}
                  </span>
                )}
              </Button>

              {/* Sort */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">Sort by:</span>
                <select
                  value={currentFilters.sort}
                  onChange={(e) => updateFilter('sort', e.target.value)}
                  className="border rounded-md px-3 py-2 text-sm bg-white"
                >
                  <option value="name">Name A-Z</option>
                  <option value="price_asc">Price: Low to High</option>
                  <option value="price_desc">Price: High to Low</option>
                </select>
              </div>

              {/* View Mode */}
              <div className="hidden sm:flex items-center gap-1 border rounded-md">
                <button
                  onClick={() => setViewMode('grid')}
                  className={`p-2 ${viewMode === 'grid' ? 'bg-gray-100' : ''}`}
                >
                  <Grid className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setViewMode('list')}
                  className={`p-2 ${viewMode === 'list' ? 'bg-gray-100' : ''}`}
                >
                  <List className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Active Filters */}
            {activeFilterCount > 0 && (
              <div className="flex flex-wrap gap-2 mb-6">
                {currentFilters.supplier && (
                  <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-600 px-3 py-1 rounded-full text-sm">
                    {currentFilters.supplier}
                    <button onClick={() => updateFilter('supplier', '')}><X className="h-3 w-3" /></button>
                  </span>
                )}
                {currentFilters.finish && (
                  <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-600 px-3 py-1 rounded-full text-sm">
                    {currentFilters.finish.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bR(\d+)\b/gi, (_, n) => `R${n}`)}
                    <button onClick={() => updateFilter('finish', '')}><X className="h-3 w-3" /></button>
                  </span>
                )}
                {currentFilters.size && (
                  <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-600 px-3 py-1 rounded-full text-sm">
                    {currentFilters.size}
                    <button onClick={() => updateFilter('size', '')}><X className="h-3 w-3" /></button>
                  </span>
                )}
                {currentFilters.color && (
                  <span className="inline-flex items-center gap-1 bg-amber-100 text-amber-600 px-3 py-1 rounded-full text-sm">
                    {currentFilters.color}
                    <button onClick={() => updateFilter('color', '')}><X className="h-3 w-3" /></button>
                  </span>
                )}
              </div>
            )}

            {/* Product Grid */}
            {loading ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
                {[...Array(12)].map((_, i) => (
                  <div key={i} className="animate-pulse">
                    <div className="bg-gray-200 aspect-square rounded-lg mb-3"></div>
                    <div className="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
                    <div className="h-4 bg-gray-200 rounded w-1/2"></div>
                  </div>
                ))}
              </div>
            ) : tiles.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-gray-500 mb-4">No tiles found matching your criteria.</p>
                <Button onClick={clearAllFilters}>Clear Filters</Button>
              </div>
            ) : (
              <div 
                className={viewMode === 'grid' ? 'grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-6' : 'flex flex-col gap-6'}
              >
                {tiles.map((tile) => (
                  <Link
                    key={tile.id}
                    to={`/tiles/${tile.slug}`}
                    className={`group block ${viewMode === 'list' ? 'flex gap-4' : ''}`}
                    style={{ minWidth: 0 }}
                  >
                    <div 
                      className={`${viewMode === 'list' ? 'w-40 h-40 flex-shrink-0' : ''} bg-gray-100 rounded-lg overflow-hidden`}
                      style={viewMode === 'grid' ? { position: 'relative', width: '100%', paddingBottom: '100%' } : {}}
                    >
                      {tile.images?.[0] ? (
                        <img
                          src={tile.images[0]}
                          alt={tile.display_name}
                          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                          className="group-hover:scale-105 transition duration-300"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-gray-400" style={viewMode === 'grid' ? { position: 'absolute', top: 0, left: 0, width: '100%', height: '100%' } : {}}>
                          No Image
                        </div>
                      )}
                      {/* Stock Alert Badges */}
                      {tile.stock !== undefined && tile.stock <= 0 && (
                        <div className="absolute top-2 left-2 bg-red-500 text-white text-xs font-bold px-2 py-1 rounded">
                          Out of Stock
                        </div>
                      )}
                      {tile.stock > 0 && tile.stock <= 5 && (
                        <div className="absolute top-2 left-2 bg-orange-500 text-white text-xs font-bold px-2 py-1 rounded animate-pulse">
                          Only {tile.stock} left!
                        </div>
                      )}
                      {tile.stock > 5 && tile.stock <= 10 && (
                        <div className="absolute top-2 left-2 bg-amber-500 text-white text-xs font-bold px-2 py-1 rounded">
                          Low Stock
                        </div>
                      )}
                      
                      {/* Secondary Image Thumbnails */}
                      {tile.images?.length > 1 && viewMode === 'grid' && (
                        <div className="absolute bottom-2 left-2 flex gap-1">
                          {safeArr(tile.images).slice(1, 4).map((img, idx) => (
                            <div 
                              key={idx} 
                              className="w-8 h-8 rounded border-2 border-white overflow-hidden shadow-sm bg-white"
                            >
                              <img 
                                src={img} 
                                alt="" 
                                className="w-full h-full object-cover"
                                loading="lazy"
                              />
                            </div>
                          ))}
                          {safeArr(tile.images).length > 4 && (
                            <div className="w-8 h-8 rounded border-2 border-white bg-black/70 flex items-center justify-center shadow-sm">
                              <span className="text-white text-xs font-medium">+{safeArr(tile.images).length - 4}</span>
                            </div>
                          )}
                        </div>
                      )}
                      
                      <button 
                        className="absolute top-3 right-3 p-2 bg-white rounded-full shadow opacity-0 group-hover:opacity-100 transition"
                        onClick={(e) => { e.preventDefault(); /* Add to wishlist */ }}
                      >
                        <Heart className="h-4 w-4 text-gray-600" />
                      </button>
                    </div>
                    <div className={viewMode === 'list' ? 'flex-1' : 'mt-3'}>
                      <h3 className="font-medium text-gray-900 group-hover:text-amber-500 transition line-clamp-2">
                        {tile.display_name}
                      </h3>
                      <div className="mt-1">
                        <p className="text-amber-500 font-semibold">
                          £{(isTrade ? getTradePrice(tile.price) : tile.price)?.toFixed(2)}{tile.is_surface_product !== false ? '/m²' : '/each'}
                          {isTrade && <span className="text-[10px] text-gray-400 font-normal ml-1">ex. VAT</span>}
                        </p>
                        {tile.price_per_tile && (
                          <p className="text-sm text-gray-500">
                            £{(isTrade ? getTradePrice(tile.price_per_tile) : tile.price_per_tile)?.toFixed(2)}/tile
                          </p>
                        )}
                      </div>
                      {tile.size && (
                        <p className="text-sm text-gray-500">{tile.size}</p>
                      )}
                      {tile.finish && (
                        <p className="text-sm text-gray-500 capitalize">{tile.finish.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bR(\d+)\b/gi, (_, n) => `R${n}`)}</p>
                      )}
                    </div>
                  </Link>
                ))}
              </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex justify-center gap-2 mt-8">
                {[...Array(totalPages)].map((_, i) => (
                  <button
                    key={i}
                    onClick={() => updateFilter('page', i + 1)}
                    className={`px-4 py-2 rounded ${
                      currentFilters.page === i + 1
                        ? 'bg-amber-500 text-white'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
            )}
          </main>
        </div>
      </div>

      {/* Mobile Filters Modal */}
      {showMobileFilters && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 lg:hidden">
          <div className="absolute right-0 top-0 bottom-0 w-full max-w-sm bg-white overflow-y-auto">
            <div className="sticky top-0 bg-white border-b p-4 flex justify-between items-center">
              <h2 className="font-semibold text-lg">Filters</h2>
              <button onClick={() => setShowMobileFilters(false)}>
                <X className="h-6 w-6" />
              </button>
            </div>
            <div className="p-4">
              {filters && (
                <>
                  <FilterSection 
                    title="Collection" 
                    options={filters.suppliers} 
                    filterKey="supplier" 
                    currentValue={currentFilters.supplier} 
                  />
                  <FilterSection 
                    title="Finish" 
                    options={filters.finishes} 
                    filterKey="finish" 
                    currentValue={currentFilters.finish} 
                  />
                  <FilterSection 
                    title="Size" 
                    options={safeArr(filters.sizes).slice(0, 15)} 
                    filterKey="size" 
                    currentValue={currentFilters.size} 
                  />
                  <FilterSection 
                    title="Colour" 
                    options={filters.colors} 
                    filterKey="color" 
                    currentValue={currentFilters.color} 
                  />
                </>
              )}
            </div>
            <div className="sticky bottom-0 bg-white border-t p-4 flex gap-4">
              <Button variant="outline" className="flex-1" onClick={clearAllFilters}>
                Clear All
              </Button>
              <Button className="flex-1 bg-amber-500 hover:bg-amber-600" onClick={() => setShowMobileFilters(false)}>
                Apply Filters
              </Button>
            </div>
          </div>
        </div>
      )}

      <ShopFooter />
    </div>
  );
};

export default TileListingPage;
