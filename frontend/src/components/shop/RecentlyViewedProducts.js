import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Clock, X } from 'lucide-react';
import { normaliseImageUrl } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Generate or get session ID
const getSessionId = () => {
  let sessionId = localStorage.getItem('tileStationSessionId');
  if (!sessionId) {
    sessionId = 'ts_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
    localStorage.setItem('tileStationSessionId', sessionId);
  }
  return sessionId;
};

/**
 * RecentlyViewedProducts - Shows a bar of recently viewed products
 */
export const RecentlyViewedProducts = ({ currentProductId, maxItems = 6 }) => {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    fetchRecentlyViewed();
  }, [currentProductId]);

  const fetchRecentlyViewed = async () => {
    try {
      const sessionId = getSessionId();
      const res = await fetch(`${API_URL}/api/recently-viewed/${sessionId}?limit=${maxItems + 1}`);
      
      if (res.ok) {
        const data = await res.json();
        // Filter out current product and limit
        const filtered = (data.products || [])
          .filter(p => p.id !== currentProductId)
          .slice(0, maxItems);
        setProducts(filtered);
      }
    } catch (e) {
      console.error('Error fetching recently viewed:', e);
    } finally {
      setLoading(false);
    }
  };

  if (loading || products.length === 0) {
    return null;
  }

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="fixed bottom-4 left-4 z-40 bg-[#333333] text-[#F7EA1C] px-4 py-2 rounded-full shadow-lg flex items-center gap-2 hover:bg-[#444444] transition"
      >
        <Clock className="h-4 w-4" />
        <span className="text-sm font-medium">Recently Viewed ({products.length})</span>
      </button>
    );
  }

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg z-40" data-testid="recently-viewed-bar">
      <div className="container mx-auto px-4">
        <div className="flex items-center gap-4 py-3">
          <div className="flex items-center gap-2 text-gray-700 flex-shrink-0">
            <Clock className="h-4 w-4" />
            <span className="text-sm font-medium hidden sm:inline">Recently Viewed</span>
          </div>
          
          <div className="flex-1 overflow-x-auto">
            <div className="flex gap-3">
              {products.map((product) => (
                <Link
                  key={product.id}
                  to={`/tiles/${product.slug || product.id}`}
                  className="flex-shrink-0 group"
                >
                  <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-lg overflow-hidden border border-gray-200 group-hover:border-amber-400 transition">
                    {normaliseImageUrl(product.images?.[0]) ? (
                      <img
                        src={normaliseImageUrl(product.images[0])}
                        alt={product.display_name || product.name}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full bg-gray-100 flex items-center justify-center text-gray-400 text-xs">
                        No img
                      </div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </div>
          
          <button
            onClick={() => setCollapsed(true)}
            className="p-2 hover:bg-gray-100 rounded-full transition flex-shrink-0"
          >
            <X className="h-4 w-4 text-gray-500" />
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Track a product view
 */
export const trackProductView = async (productId) => {
  if (!productId) return;
  
  try {
    const sessionId = getSessionId();
    await fetch(`${API_URL}/api/recently-viewed/track?product_id=${productId}&session_id=${sessionId}`, {
      method: 'POST'
    });
  } catch (e) {
    console.error('Error tracking product view:', e);
  }
};

export default RecentlyViewedProducts;
