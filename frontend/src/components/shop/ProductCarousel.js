import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTradeUser } from '../../hooks/useTradeUser';
import { firstImageUrl, imageUrl } from '../../utils/imageUrl';

const API_URL = process.env.REACT_APP_BACKEND_URL;

export const ProductCarousel = ({ title = "Featured Products", category = null, limit = 8 }) => {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [scrollPosition, setScrollPosition] = useState(0);
  const { isTrade, getTradePrice } = useTradeUser();

  useEffect(() => {
    const ac = new AbortController();
    const fetchProducts = async () => {
      try {
        // The carousel uses /api/tiles/products (returns {products, total, ...}).
        // Older code called /api/tiles/?limit=N which 404'd — this rewrite
        // also adds proper non-2xx handling so service-worker cache races
        // can't cause "body stream already read" noise in the console.
        let url = `${API_URL}/api/tiles/products?limit=${limit}`;
        if (category) {
          url += `&category=${encodeURIComponent(category)}`;
        }
        const res = await fetch(url, { signal: ac.signal });
        if (!res.ok) {
          // Drain the body so SW caches don't choke, but don't try to parse
          await res.text().catch(() => {});
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        setProducts(data.products || data.tiles || data.items || []);
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.warn('[ProductCarousel] fetch failed:', e.message);
        }
      } finally {
        setLoading(false);
      }
    };
    fetchProducts();
    return () => ac.abort();
  }, [category, limit]);

  const scroll = (direction) => {
    const container = document.getElementById('product-carousel');
    if (container) {
      const scrollAmount = 300;
      const newPosition = direction === 'left' 
        ? scrollPosition - scrollAmount 
        : scrollPosition + scrollAmount;
      container.scrollTo({ left: newPosition, behavior: 'smooth' });
      setScrollPosition(newPosition);
    }
  };

  if (loading) {
    return (
      <section className="py-12 bg-white" data-testid="product-carousel">
        <div className="container mx-auto px-4">
          <h2 className="text-2xl font-bold text-slate-900 mb-6">{title}</h2>
          <div className="flex gap-4 overflow-hidden">
            {[1,2,3,4].map(i => (
              <div key={i} className="w-64 flex-shrink-0 animate-pulse">
                <div className="aspect-square bg-slate-200 rounded-lg mb-3" />
                <div className="h-4 bg-slate-200 rounded w-3/4 mb-2" />
                <div className="h-4 bg-slate-200 rounded w-1/2" />
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  if (products.length === 0) return null;

  return (
    <section className="py-12 bg-white" data-testid="product-carousel">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-slate-900">{title}</h2>
          <div className="flex gap-2">
            <button 
              onClick={() => scroll('left')}
              className="w-10 h-10 rounded-full border border-slate-300 flex items-center justify-center hover:bg-slate-100 transition-colors"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button 
              onClick={() => scroll('right')}
              className="w-10 h-10 rounded-full border border-slate-300 flex items-center justify-center hover:bg-slate-100 transition-colors"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div 
          id="product-carousel"
          className="flex gap-4 overflow-x-auto scrollbar-hide pb-4"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {products.map((product) => (
            <Link
              key={product.id}
              to={`/tiles/${product.slug || product.id}`}
              className="w-64 flex-shrink-0 group"
            >
              <div className="aspect-square rounded-lg overflow-hidden bg-slate-100 mb-3">
                <img
                  src={firstImageUrl(product.images) || 'https://via.placeholder.com/300?text=No+Image'}
                  alt={product.website_name || product.name}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
              </div>
              <h3 className="font-medium text-slate-900 group-hover:text-amber-600 transition-colors line-clamp-2">
                {product.website_name || product.name}
              </h3>
              <p className="text-lg font-bold text-slate-900 mt-1">
                £{(isTrade ? getTradePrice(product.room_lot_price || product.price || 0) : (product.room_lot_price || product.price || 0)).toFixed(2)}/m²
                {isTrade && <span className="text-[10px] text-gray-400 font-normal ml-1">ex. VAT</span>}
              </p>
            </Link>
          ))}
        </div>

        <div className="text-center mt-6">
          <Link 
            to="/tiles"
            className="inline-flex items-center gap-2 text-[#333333] hover:text-amber-600 font-semibold"
          >
            View All Products
            <ChevronRight className="w-4 h-4" />
          </Link>
        </div>
      </div>

      <style>{`
        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </section>
  );
};

export default ProductCarousel;
