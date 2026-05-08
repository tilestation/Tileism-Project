import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { 
  X, 
  ChevronLeft, 
  ChevronRight, 
  ShoppingCart, 
  Scissors, 
  Heart, 
  Eye,
  Star,
  Truck,
  Shield,
  Check,
  ZoomIn
} from 'lucide-react';
import { toast } from 'sonner';
import { useTradeUser } from '../../hooks/useTradeUser';
import { useTrustBadges } from '../../hooks/useTrustBadges';
import { normaliseImageList, normaliseImageUrl } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const QuickViewModal = ({ 
  isOpen, 
  onClose, 
  collection, 
  onAddToCart, 
  onAddSample 
}) => {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [quantity, setQuantity] = useState(1);
  const [isAddingToCart, setIsAddingToCart] = useState(false);
  const modalRef = useRef(null);
  const { isTrade, getTradePrice } = useTradeUser();
  const { badges: trustBadgeData } = useTrustBadges();

  // Fetch products for this collection
  useEffect(() => {
    if (isOpen && collection) {
      const fetchProducts = async () => {
        setLoading(true);
        try {
          const res = await fetch(
            `${API_URL}/api/tiles/collection/${encodeURIComponent(collection.series_name)}?limit=10`
          );
          const data = await res.json();
          const fetchedProducts = data.products || [];
          setProducts(fetchedProducts);
          if (fetchedProducts.length > 0) {
            setSelectedProduct(fetchedProducts[0]);
          }
        } catch (e) {
          console.error('Error fetching products:', e);
        } finally {
          setLoading(false);
        }
      };
      fetchProducts();
    }
  }, [isOpen, collection]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  // Handle click outside
  const handleBackdropClick = (e) => {
    if (modalRef.current && !modalRef.current.contains(e.target)) {
      onClose();
    }
  };

  if (!isOpen || !collection) return null;

  // Image entries from the API may be strings or {url, alt} objects.
  // normaliseImageList unwraps both shapes and filters blanks.
  const images = normaliseImageList(
    selectedProduct?.images
    || collection.product_images?.map(p => p.image)
    || [collection.hero_image]
  );
  const currentImage = images[currentImageIndex] || images[0];

  const nextImage = () => {
    setCurrentImageIndex((prev) => (prev + 1) % images.length);
  };

  const prevImage = () => {
    setCurrentImageIndex((prev) => (prev - 1 + images.length) % images.length);
  };

  const handleAddToCart = async () => {
    if (!selectedProduct) return;
    setIsAddingToCart(true);
    
    try {
      if (onAddToCart) {
        onAddToCart({
          id: selectedProduct.id,
          name: selectedProduct.display_name,
          display_name: selectedProduct.display_name,
          price: selectedProduct.room_lot_price || selectedProduct.pallet_price || 0,
          image: selectedProduct.images?.[0] || '',
          size: selectedProduct.size,
          finish: selectedProduct.finish,
          color: selectedProduct.color,
          quantity: quantity,
          coverage: selectedProduct.coverage_per_box,
          supplier: selectedProduct.supplier
        }, quantity);
      }
      toast.success(`Added ${quantity}m² to cart`);
    } catch (e) {
      toast.error('Failed to add to cart');
    } finally {
      setIsAddingToCart(false);
    }
  };

  const handleAddSample = () => {
    if (!selectedProduct) return;
    if (onAddSample) {
      const success = onAddSample({
        id: selectedProduct.id,
        name: selectedProduct.display_name,
        display_name: selectedProduct.display_name,
        image: selectedProduct.images?.[0] || '',
        images: selectedProduct.images,
        size: selectedProduct.size,
        finish: selectedProduct.finish,
        color: selectedProduct.color,
        slug: selectedProduct.slug
      });
      if (!success) return;
    }
    toast.success('Sample added to basket');
  };

  const rawPrice = selectedProduct?.room_lot_price || selectedProduct?.pallet_price || collection.prices_from || 0;
  const price = isTrade ? getTradePrice(rawPrice) : rawPrice;
  const rawWasPrice = selectedProduct?.was_price;
  const wasPrice = rawWasPrice ? (isTrade ? getTradePrice(rawWasPrice) : rawWasPrice) : null;
  const isOnSale = rawWasPrice && rawWasPrice > rawPrice;

  return (
    <div 
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fadeIn"
      onClick={handleBackdropClick}
      data-testid="quick-view-modal"
    >
      <div 
        ref={modalRef}
        className="relative w-full max-w-5xl max-h-[90vh] bg-white rounded-2xl shadow-2xl overflow-hidden animate-slideUp"
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-2 bg-white/90 hover:bg-white rounded-full shadow-lg transition-all hover:scale-110"
          data-testid="quick-view-close"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="flex flex-col md:flex-row h-full max-h-[90vh]">
          {/* Image Gallery - Left Side */}
          <div className="relative w-full md:w-1/2 bg-gray-50">
            {/* Main Image */}
            <div className="relative aspect-square">
              <img
                src={currentImage}
                alt={collection.series_name}
                className="w-full h-full object-cover"
              />
              
              {/* Sale Badge */}
              {isOnSale && (
                <div className="absolute top-4 left-4 px-3 py-1.5 bg-red-600 text-white text-sm font-semibold rounded">
                  SALE
                </div>
              )}

              {/* Navigation Arrows */}
              {images.length > 1 && (
                <>
                  <button
                    onClick={prevImage}
                    className="absolute left-3 top-1/2 -translate-y-1/2 p-2 bg-white/90 hover:bg-white rounded-full shadow-md transition-all hover:scale-110"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <button
                    onClick={nextImage}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-2 bg-white/90 hover:bg-white rounded-full shadow-md transition-all hover:scale-110"
                  >
                    <ChevronRight className="w-5 h-5" />
                  </button>
                </>
              )}

              {/* Image Counter */}
              {images.length > 1 && (
                <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1.5">
                  {images.map((_, idx) => (
                    <button
                      key={idx}
                      onClick={() => setCurrentImageIndex(idx)}
                      className={`w-2 h-2 rounded-full transition-all ${
                        idx === currentImageIndex ? 'bg-gray-900 w-6' : 'bg-gray-400'
                      }`}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Thumbnail Strip */}
            {images.length > 1 && (
              <div className="flex gap-2 p-3 overflow-x-auto">
                {images.slice(0, 6).map((img, idx) => (
                  <button
                    key={idx}
                    onClick={() => setCurrentImageIndex(idx)}
                    className={`w-16 h-16 rounded-lg overflow-hidden border-2 transition-all flex-shrink-0 ${
                      idx === currentImageIndex ? 'border-gray-900' : 'border-transparent hover:border-gray-300'
                    }`}
                  >
                    <img src={img} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Product Details - Right Side */}
          <div className="w-full md:w-1/2 p-6 md:p-8 overflow-y-auto">
            {loading ? (
              <div className="animate-pulse space-y-4">
                <div className="h-8 bg-gray-200 rounded w-3/4"></div>
                <div className="h-4 bg-gray-200 rounded w-1/2"></div>
                <div className="h-6 bg-gray-200 rounded w-1/4"></div>
              </div>
            ) : (
              <>
                {/* Collection Label */}
                <p className="text-xs font-medium text-gray-500 uppercase tracking-widest mb-2">
                  Collection
                </p>
                
                <h2 className="text-2xl md:text-3xl font-light text-gray-900 mb-2">
                  {selectedProduct?.display_name || collection.series_name}
                </h2>

                {/* Rating */}
                <div className="flex items-center gap-2 mb-4">
                  <div className="flex">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <Star
                        key={star}
                        className={`w-4 h-4 ${star <= 4 ? 'fill-amber-400 text-amber-400' : 'text-gray-300'}`}
                      />
                    ))}
                  </div>
                  <span className="text-sm text-gray-500">(24 reviews)</span>
                </div>

                {/* Price */}
                <div className="flex items-baseline gap-3 mb-6">
                  <span className={`text-3xl font-semibold ${isOnSale ? 'text-red-600' : 'text-gray-900'}`}>
                    £{price.toFixed(2)}
                  </span>
                  <span className="text-gray-500">/m²</span>
                  {isTrade && <span className="text-[10px] text-gray-400 ml-1">ex. VAT</span>}
                  {isOnSale && wasPrice && (
                    <span className="text-lg text-gray-400 line-through">
                      £{wasPrice.toFixed(2)}
                    </span>
                  )}
                </div>

                {/* Product Variants */}
                {products.length > 1 && (
                  <div className="mb-6">
                    <p className="text-sm font-medium text-gray-700 mb-2">Available Options</p>
                    <div className="flex flex-wrap gap-2">
                      {products.slice(0, 6).map((product) => (
                        <button
                          key={product.id}
                          onClick={() => {
                            setSelectedProduct(product);
                            setCurrentImageIndex(0);
                          }}
                          className={`px-3 py-2 text-sm rounded-lg border transition-all ${
                            selectedProduct?.id === product.id
                              ? 'border-gray-900 bg-gray-900 text-white'
                              : 'border-gray-300 hover:border-gray-900'
                          }`}
                        >
                          {product.size || product.color || product.finish}
                        </button>
                      ))}
                      {products.length > 6 && (
                        <Link
                          to={`/shop/collection/${encodeURIComponent(collection.series_name)}`}
                          className="px-3 py-2 text-sm text-gray-500 hover:text-gray-900"
                        >
                          +{products.length - 6} more
                        </Link>
                      )}
                    </div>
                  </div>
                )}

                {/* Quantity */}
                <div className="mb-6">
                  <p className="text-sm font-medium text-gray-700 mb-2">Quantity (m²)</p>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setQuantity(Math.max(1, quantity - 1))}
                      className="w-10 h-10 rounded-lg border border-gray-300 hover:bg-gray-100 flex items-center justify-center"
                    >
                      -
                    </button>
                    <input
                      type="number"
                      value={quantity}
                      onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-20 h-10 text-center border border-gray-300 rounded-lg"
                    />
                    <button
                      onClick={() => setQuantity(quantity + 1)}
                      className="w-10 h-10 rounded-lg border border-gray-300 hover:bg-gray-100 flex items-center justify-center"
                    >
                      +
                    </button>
                    <span className="text-sm text-gray-500 ml-2">
                      Total: £{(price * quantity).toFixed(2)}
                    </span>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className="flex gap-3 mb-6">
                  <button
                    onClick={handleAddToCart}
                    disabled={isAddingToCart}
                    className="flex-1 flex items-center justify-center gap-2 px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-xl transition-all hover:scale-[1.02] active:scale-[0.98]"
                    data-testid="quick-view-add-to-cart"
                  >
                    {isAddingToCart ? (
                      <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <ShoppingCart className="w-5 h-5" />
                    )}
                    Add to Cart
                  </button>
                  <button
                    onClick={handleAddSample}
                    className="flex items-center justify-center gap-2 px-4 py-3 border-2 border-gray-900 text-gray-900 font-semibold rounded-xl hover:bg-gray-900 hover:text-white transition-all"
                    data-testid="quick-view-add-sample"
                  >
                    <Scissors className="w-5 h-5" />
                    Sample
                  </button>
                  <button
                    className="p-3 border border-gray-300 rounded-xl hover:bg-gray-100 transition-all"
                    title="Add to wishlist"
                  >
                    <Heart className="w-5 h-5" />
                  </button>
                </div>

                {/* Trust Badges */}
                <div className="grid grid-cols-2 gap-3 py-4 border-t border-gray-200">
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <Truck className="w-4 h-4 text-green-600" />
                    {trustBadgeData.delivery.title} {trustBadgeData.delivery.subtitle}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <Shield className="w-4 h-4 text-blue-600" />
                    {trustBadgeData.quality.title}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <Check className="w-4 h-4 text-emerald-600" />
                    In stock
                  </div>
                  <div className="flex items-center gap-2 text-sm text-gray-600">
                    <Eye className="w-4 h-4 text-purple-600" />
                    12 viewing now
                  </div>
                </div>

                {/* View Full Details Link */}
                <Link
                  to={`/shop/collection/${encodeURIComponent(collection.series_name)}`}
                  className="block text-center py-3 text-gray-600 hover:text-gray-900 underline underline-offset-4 transition-colors"
                  onClick={onClose}
                  data-testid="quick-view-full-details"
                >
                  View full details →
                </Link>
              </>
            )}
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(20px) scale(0.98); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .animate-fadeIn {
          animation: fadeIn 0.2s ease-out;
        }
        .animate-slideUp {
          animation: slideUp 0.3s ease-out;
        }
      `}</style>
    </div>
  );
};

export default QuickViewModal;
