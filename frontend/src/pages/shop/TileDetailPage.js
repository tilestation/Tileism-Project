import React, { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Heart, Truck, Package, ShieldCheck, Minus, Plus, ChevronRight, ChevronLeft, Scissors, ShoppingCart, Users, Star, Layers, BadgeCheck, Crown, FileText, Send, X, Building2, Phone, Mail, MapPin, Loader2, Calculator, GitCompare } from 'lucide-react';
import RenderProductDescription from '../../components/shop/RenderProductDescription';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../../components/ui/dialog';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { useCart } from '../../contexts/TileCartContext';
import { useWishlist } from '../../contexts/WishlistContext';
import { useCompare } from '../../contexts/CompareContext';
import { useSampleCart } from '../../contexts/SampleCartContext';
import { toast } from 'sonner';
import { ImageZoom } from '../../components/shop/ImageZoom';
import { ReviewSection } from '../../components/shop/ReviewSection';
import { RecentlyViewedProducts, trackProductView } from '../../components/shop/RecentlyViewedProducts';
import { RecentlyViewedSection, YouMayAlsoNeed, trackRecentView } from '../../components/shop/CrossSellSections';
import { ShareProduct } from '../../components/shop/ShareProduct';
import KlarnaOSM from '../../components/shop/KlarnaOSM';
import { PriceMatchBadge } from '../../components/shop/PriceMatchBadge';
import { TradeLoginBanner, TradeLoginBox } from '../../components/shop/TradeLoginPrompt';
import RoomVisualizer from '../../components/shop/RoomVisualizer';
import AdvancedTileCalculator from '../../components/shop/AdvancedTileCalculator';
import { usePageTracking } from '../../hooks/usePageTracking';
import LiveChatWidget from '../../components/shop/LiveChatWidget';
import { useTrustBadges } from '../../hooks/useTrustBadges';
import SeoHead from '../../components/seo/SeoHead';
import { normaliseImageUrl, safeToFixed, safeArr} from '../../utils/safeStr';
import { firstImageUrl, imageUrl } from '../../utils/imageUrl';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const TileDetailPage = () => {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { addToCart } = useCart();
  const { isInWishlist, toggleWishlist } = useWishlist();
  const { has: isInCompare, add: addToCompare, remove: removeFromCompare, isFull: compareIsFull } = useCompare();
  const [compareEnabled, setCompareEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const apiUrl = process.env.REACT_APP_BACKEND_URL;
    fetch(`${apiUrl}/api/storefront-features/public`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setCompareEnabled(!!d?.compare_enabled); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleCompareToggle = () => {
    if (!tile) return;
    if (isInCompare(tile.slug)) {
      removeFromCompare(tile.slug);
      toast.success('Removed from compare');
    } else if (compareIsFull) {
      toast.error('Compare is full — remove a tile first');
    } else {
      addToCompare({
        slug: tile.slug,
        name: tile.product_name || tile.name,
        image: (tile.images && firstImageUrl(tile.images)) || tile.image_url,
        price: currentPrice,
      });
      toast.success('Added to compare');
    }
  };
  const { addSample, isInSamples, sampleCount, maxSamples } = useSampleCart();
  const { badges: trustBadgeData } = useTrustBadges();
  const [tile, setTile] = useState(null);
  const [similarTiles, setSimilarTiles] = useState([]);
  const [frequentlyBought, setFrequentlyBought] = useState([]);
  const [reviewSummary, setReviewSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedImage, setSelectedImage] = useState(0);
  const [quantity, setQuantity] = useState(1);
  const [priceType] = useState('room_lot'); // Always use room_lot price
  const [showVisualizer, setShowVisualizer] = useState(false);
  const [tierPricing, setTierPricing] = useState(null);
  const [tradeStatus, setTradeStatus] = useState({ is_trade: false, trade_discount: 0 });
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  
  // Track page views for analytics
  usePageTracking();
  
  // Quote request state
  const [quoteStatus, setQuoteStatus] = useState({ show_quote_button: false, threshold: 150 });
  const [showQuoteModal, setShowQuoteModal] = useState(false);
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);
  const [quoteForm, setQuoteForm] = useState({
    customer_name: '',
    customer_email: '',
    customer_phone: '',
    customer_company: '',
    project_details: '',
    delivery_postcode: '',
    preferred_contact: 'email'
  });

  // Box calculation helper - rounds up to nearest full box
  const calculateBoxInfo = (requestedQty, sqmPerBox, tilesPerBox, pricePerM2) => {
    if (!sqmPerBox || sqmPerBox <= 0) return null;
    
    const boxesNeeded = Math.ceil(requestedQty / sqmPerBox);
    const actualSqm = boxesNeeded * sqmPerBox;
    const totalTiles = tilesPerBox ? boxesNeeded * tilesPerBox : null;
    const boxPrice = pricePerM2 ? (sqmPerBox * pricePerM2) : null;
    const totalPrice = pricePerM2 ? (actualSqm * pricePerM2) : null;
    
    return {
      requestedQty,
      boxesNeeded,
      actualSqm: parseFloat(actualSqm.toFixed(2)),
      totalTiles,
      sqmPerBox: parseFloat(sqmPerBox.toFixed(2)),
      tilesPerBox,
      extraSqm: parseFloat((actualSqm - requestedQty).toFixed(2)),
      boxPrice: boxPrice ? parseFloat(boxPrice.toFixed(2)) : null,
      totalPrice: totalPrice ? parseFloat(totalPrice.toFixed(2)) : null
    };
  };

  // NOTE: boxInfo is calculated after currentPrice is defined (see below in component)
  
  // Quick box quantity helpers
  const setBoxQuantity = (numBoxes) => {
    if (tile?.sqm_per_box) {
      // Round to avoid floating point issues
      const qty = Math.round(numBoxes * tile.sqm_per_box * 1000) / 1000;
      setQuantity(qty);
    }
  };
  
  const addBoxes = (numBoxes, boxInfoParam) => {
    if (tile?.sqm_per_box && boxInfoParam) {
      setQuantity((boxInfoParam.boxesNeeded + numBoxes) * tile.sqm_per_box);
    }
  };

  // Check if customer is logged in - validate token is not expired
  useEffect(() => {
    const token = localStorage.getItem('tile_shop_token');
    const customerData = localStorage.getItem('tile_shop_customer');
    
    // Validate token before hiding Trade box
    let tokenValid = false;
    if (token) {
      try {
        const parts = token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(atob(parts[1]));
          tokenValid = !(payload.exp && payload.exp * 1000 < Date.now());
        }
      } catch { /* invalid token */ }
      if (!tokenValid) {
        localStorage.removeItem('tile_shop_token');
        localStorage.removeItem('tile_shop_customer');
        window.dispatchEvent(new Event('trade-auth-change'));
      }
    }
    setIsLoggedIn(tokenValid);
    
    // Pre-fill form if customer data exists (even without active token for convenience)
    if (customerData) {
      try {
        const customer = JSON.parse(customerData);
        setQuoteForm(prev => ({
          ...prev,
          customer_name: customer.name || '',
          customer_email: customer.email || '',
          customer_phone: customer.phone || ''
        }));
      } catch (e) {}
    }
  }, []);

  // Check quote status when quantity changes
  useEffect(() => {
    const checkQuoteStatus = async () => {
      if (!tile) return;
      
      try {
        // Determine pricing unit
        const pricingUnit = tile.pricing_unit || 'm2';
        
        // Pass product's quote settings to the API
        const quoteDisabled = tile.quote_disabled ? 'true' : 'false';
        const customThreshold = tile.custom_quote_threshold ? `&custom_threshold=${tile.custom_quote_threshold}` : '';
        
        const res = await fetch(
          `${API_URL}/api/shop/products/${tile.slug || tile.id}/quote-status?quantity=${quantity}&quote_disabled=${quoteDisabled}${customThreshold}&pricing_unit=${pricingUnit}`
        );
        if (res.ok) {
          const data = await res.json();
          setQuoteStatus(data);
        }
      } catch (e) {
        console.log('Quote status not available');
      }
    };
    
    if (tile) {
      checkQuoteStatus();
    }
  }, [tile, quantity]);

  // Fetch trade status when logged in
  useEffect(() => {
    const fetchTradeStatus = async () => {
      const token = localStorage.getItem('tile_shop_token');
      if (!token) {
        setTradeStatus({ is_trade: false, trade_discount: 0 });
        return;
      }
      
      try {
        const res = await fetch(`${API_URL}/api/shop/trade/status`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          setTradeStatus(data);
        }
      } catch (e) {
        console.log('Trade status not available');
        setTradeStatus({ is_trade: false, trade_discount: 0 });
      }
    };
    
    if (isLoggedIn) {
      fetchTradeStatus();
    }
  }, [isLoggedIn]);

  // Fetch tier pricing when quantity or trade status changes
  useEffect(() => {
    const fetchTierPricing = async () => {
      if (!tile) return;
      
      // If tier pricing is explicitly disabled on the product, skip the API call
      if (tile.tier_pricing_disabled) {
        setTierPricing({ disabled: true });
        return;
      }
      
      // Determine pricing unit and base price
      const pricingUnit = tile.pricing_unit || 'm2';
      const basePrice = pricingUnit === 'unit' 
        ? (tile.unit_price || tile.price || 0)
        : (tile.room_lot_price || tile.price || 0);
      
      if (!basePrice) return;
      
      try {
        // Use different endpoint for unit-based products
        const endpoint = pricingUnit === 'unit' 
          ? `${API_URL}/api/tiles/pricing/calculate-unit`
          : `${API_URL}/api/tiles/pricing/calculate`;
        
        const priceParam = pricingUnit === 'unit' ? 'unit_price' : 'base_price';
        const skuParam = tile.sku ? `&product_sku=${encodeURIComponent(tile.sku)}` : '';
        // Pass trade status if user is a trade customer
        const tradeParams = tradeStatus.is_trade 
          ? `&is_trade=true&trade_discount=${tradeStatus.trade_discount}` 
          : '';
        
        const res = await fetch(
          `${endpoint}?${priceParam}=${basePrice}&quantity=${quantity}${skuParam}${tradeParams}`
        );
        if (res.ok) {
          const data = await res.json();
          setTierPricing(data);
        }
      } catch (e) {
        console.log('Tier pricing not available');
      }
    };
    
    if (tile) {
      fetchTierPricing();
    }
  }, [tile, quantity, tradeStatus]);

  useEffect(() => {
    const fetchTile = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${API_URL}/api/tiles/products/${slug}`);
        if (!res.ok) throw new Error('Tile not found');
        const data = await res.json();
        setTile(data);

        // Fetch similar tiles
        const similarRes = await fetch(`${API_URL}/api/tiles/similar/${slug}?limit=4`);
        const similarData = await similarRes.json();
        setSimilarTiles(similarData);

        // Fetch frequently bought together
        if (data.id) {
          try {
            const fbtRes = await fetch(`${API_URL}/api/recommendations/frequently-bought-together/${data.id}?limit=4`);
            if (fbtRes.ok) {
              const fbtData = await fbtRes.json();
              setFrequentlyBought(fbtData);
            }
          } catch (e) {
            console.log('Recommendations not available');
          }
          
          // Fetch review summary
          try {
            const reviewRes = await fetch(`${API_URL}/api/reviews/summary/${data.id}`);
            if (reviewRes.ok) {
              const reviewData = await reviewRes.json();
              setReviewSummary(reviewData);
            }
          } catch (e) {
            console.log('Reviews not available');
          }
          
          // Track product view for recently viewed
          trackProductView(data.id);
          trackRecentView(data);
        }
      } catch (e) {
        console.error('Error:', e);
        toast.error('Tile not found');
        navigate('/tiles');
      } finally {
        setLoading(false);
      }
    };
    fetchTile();
  }, [slug, navigate]);

  const handleAddToCart = () => {
    if (!tile) return;
    // Use rounded box quantity if box info is available
    const finalQuantity = boxInfo ? boxInfo.actualSqm : quantity;
    addToCart(tile, finalQuantity, priceType);
    
    // Show toast with box info if applicable
    if (boxInfo && boxInfo.boxesNeeded > 0) {
      toast.success(`Added ${boxInfo.boxesNeeded} box${boxInfo.boxesNeeded > 1 ? 'es' : ''} (${boxInfo.actualSqm}m²) to cart`);
    }
  };

  const handleSubmitQuote = async (e) => {
    e.preventDefault();
    if (!tile) return;
    
    // Validate form
    if (!quoteForm.customer_name || !quoteForm.customer_email || !quoteForm.customer_phone) {
      toast.error('Please fill in all required fields');
      return;
    }
    
    setQuoteSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/shop/quotes/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: tile.id || tile.slug,
          product_name: tile.display_name || tile.name,
          product_sku: tile.sku,
          quantity: quantity,
          ...quoteForm
        })
      });
      
      if (res.ok) {
        const data = await res.json();
        toast.success(data.message);
        setShowQuoteModal(false);
        // Reset form
        setQuoteForm({
          customer_name: '',
          customer_email: '',
          customer_phone: '',
          customer_company: '',
          project_details: '',
          delivery_postcode: '',
          preferred_contact: 'email'
        });
      } else {
        const error = { detail: 'Failed to submit quote request' };
        toast.error(error.detail || 'Failed to submit quote request');
      }
    } catch (e) {
      console.error('Quote submission error:', e);
      toast.error('Failed to submit quote request');
    } finally {
      setQuoteSubmitting(false);
    }
  };

  const handleWishlistToggle = () => {
    if (!tile) return;
    const added = toggleWishlist(tile);
    toast.success(added ? 'Added to wishlist' : 'Removed from wishlist');
  };

  const handleOrderSample = () => {
    if (!tile) return;
    if (isInSamples(tile.id)) {
      navigate('/shop/tile-samples');
      return;
    }
    addSample(tile);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-white">
        <ShopHeader />
        <div className="container mx-auto px-4 py-8">
          <div className="animate-pulse">
            <div className="grid md:grid-cols-2 gap-8">
              <div className="aspect-square bg-gray-200 rounded-lg"></div>
              <div className="space-y-4">
                <div className="h-8 bg-gray-200 rounded w-3/4"></div>
                <div className="h-6 bg-gray-200 rounded w-1/4"></div>
                <div className="h-24 bg-gray-200 rounded"></div>
              </div>
            </div>
          </div>
        </div>
        <ShopFooter />
      </div>
    );
  }

  if (!tile) return null;

  const currentPrice = priceType === 'pallet' ? tile.pallet_price : tile.room_lot_price;
  
  // Get box info for current quantity (calculated after currentPrice is available)
  const boxInfo = tile?.sqm_per_box && tile.pricing_unit !== 'unit' 
    ? calculateBoxInfo(quantity, tile.sqm_per_box, tile.tiles_per_box, currentPrice)
    : null;

  return (
    <div className="min-h-screen bg-white">
      <SeoHead
        title={`${tile.display_name} — ${tile.size || ''} ${tile.finish || ''}`.trim()}
        description={
          tile.short_description ||
          tile.description?.slice(0, 200) ||
          `${tile.display_name} from Tile Station — ${tile.size || ''} ${tile.finish || ''}. ` +
          `Free UK delivery on orders over £500. Free samples available.`
        }
        canonical={`/tiles/${tile.slug || tile.id}`}
        type="product"
        image={firstImageUrl(tile.images) || tile.thumbnail}
        keywords={`${tile.display_name}, ${tile.size}, ${tile.finish}, ${tile.series_name || ''}, ${tile.category_name || 'tiles'}`}
        jsonLd={{
          '@context': 'https://schema.org/',
          '@type': 'Product',
          name: tile.display_name,
          image: tile.images || [tile.thumbnail].filter(Boolean),
          description: tile.short_description || tile.description?.slice(0, 500),
          sku: tile.sku,
          brand: { '@type': 'Brand', name: tile.brand || 'Tile Station' },
          offers: {
            '@type': 'Offer',
            url: `https://tilestation.co.uk/tiles/${tile.slug || tile.id}`,
            priceCurrency: 'GBP',
            price: Number(tile.price_per_unit || tile.price || 0).toFixed(2),
            availability: tile.stock_qty > 0
              ? 'https://schema.org/InStock'
              : 'https://schema.org/OutOfStock',
            itemCondition: 'https://schema.org/NewCondition',
            seller: { '@type': 'Organization', name: 'Tile Station' },
          },
        }}
      />
      <ShopHeader />

      <div className="container mx-auto px-4 py-8">
        {/* Breadcrumb */}
        <nav className="text-sm text-gray-500 mb-6">
          <Link to="/tiles" className="hover:text-amber-500">Home</Link>
          <span className="mx-2">/</span>
          <Link to="/tiles" className="hover:text-amber-500">Tiles</Link>
          <span className="mx-2">/</span>
          <span className="text-gray-900">{tile.display_name}</span>
        </nav>

        <div className="grid md:grid-cols-2 gap-8 lg:gap-12">
          {/* Image Gallery with Zoom */}
          <div>
            <div className="relative aspect-square bg-gray-50 rounded-lg overflow-hidden mb-4 border border-gray-200 shadow-sm">
              {tile.images?.[selectedImage] ? (
                <ImageZoom
                  src={imageUrl(tile.images[selectedImage])}
                  alt={tile.display_name}
                  className="w-full h-full"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-400">
                  No Image Available
                </div>
              )}
              
              {/* Image Navigation */}
              {tile.images?.length > 1 && (
                <>
                  <button
                    onClick={() => setSelectedImage(prev => prev > 0 ? prev - 1 : safeArr(tile.images).length - 1)}
                    className="absolute left-4 top-1/2 -translate-y-1/2 p-2 bg-white rounded-full shadow hover:bg-gray-50 z-10"
                  >
                    <ChevronLeft className="h-5 w-5" />
                  </button>
                  <button
                    onClick={() => setSelectedImage(prev => prev < safeArr(tile.images).length - 1 ? prev + 1 : 0)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 p-2 bg-white rounded-full shadow hover:bg-gray-50 z-10"
                  >
                    <ChevronRight className="h-5 w-5" />
                  </button>
                </>
              )}
            </div>

            {/* Thumbnail Gallery */}
            {tile.images?.length > 1 && (
              <div className="flex gap-2 overflow-x-auto">
                {safeArr(tile.images).map((img, idx) => (
                  <button
                    key={idx}
                    onClick={() => setSelectedImage(idx)}
                    className={`w-20 h-20 flex-shrink-0 rounded-md overflow-hidden border-2 shadow-sm ${
                      selectedImage === idx ? 'border-amber-600' : 'border-gray-200'
                    }`}
                  >
                    <img src={img} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}

            {/* Product Description - Under Images */}
            {tile.description && (
              <div className="bg-white border border-gray-200 rounded-lg p-5 mt-6" data-testid="product-description">
                <h3 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
                  <FileText className="w-4 h-4 text-gray-600" />
                  Product Description
                </h3>
                <div className="prose prose-sm max-w-none text-gray-600 leading-relaxed">
                  {tile.description.split('\n').map((paragraph, idx) => (
                    paragraph.trim() && (
                      <RenderProductDescription
                        key={idx}
                        text={paragraph}
                        className="mb-2 last:mb-0"
                      />
                    )
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Product Info */}
          <div>
            <div className="flex justify-between items-start">
              <div>
                <h1 className="text-2xl md:text-3xl font-bold text-gray-900 mb-2">
                  {tile.display_name}
                </h1>
                
                {/* Review Summary */}
                {reviewSummary && reviewSummary.total_reviews > 0 && (
                  <div className="flex items-center gap-2 mb-4">
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <Star
                          key={star}
                          className={`h-4 w-4 ${
                            star <= reviewSummary.average_rating
                              ? 'fill-amber-400 text-amber-400'
                              : 'text-gray-300'
                          }`}
                        />
                      ))}
                    </div>
                    <span className="text-sm text-gray-600">
                      {reviewSummary.average_rating?.toFixed(1)} ({reviewSummary.total_reviews} reviews)
                    </span>
                  </div>
                )}
              </div>
              <button 
                onClick={handleWishlistToggle}
                className={`p-2 border rounded-md hover:bg-gray-50 ${tile && isInWishlist(tile.id) ? 'bg-red-50 border-red-200' : ''}`}
                data-testid="wishlist-toggle-btn"
              >
                <Heart className={`h-5 w-5 ${tile && isInWishlist(tile.id) ? 'text-red-500 fill-red-500' : 'text-gray-600'}`} />
              </button>
              {compareEnabled && tile && (
                <button
                  onClick={handleCompareToggle}
                  className={`p-2 border rounded-md hover:bg-gray-50 ${isInCompare(tile.slug) ? 'bg-emerald-50 border-emerald-200' : ''}`}
                  title={isInCompare(tile.slug) ? 'Remove from compare' : 'Add to compare'}
                  data-testid="compare-toggle-btn"
                >
                  <GitCompare className={`h-5 w-5 ${isInCompare(tile.slug) ? 'text-emerald-600' : 'text-gray-600'}`} />
                </button>
              )}
            </div>

            {/* Tier Pricing */}
            <div className="bg-gray-50 rounded-lg p-4 mb-6">
              {/* WAS/NOW Sale Banner - Show if sale_active */}
              {tile?.sale_active && tile?.was_price && tile?.was_price > currentPrice && (() => {
                const wasPrice = tile.was_price;
                const salePrice = tile.room_lot_price || tile.price || 0;
                const finalPrice = currentPrice;
                const saleOff = Math.round(((wasPrice - salePrice) / wasPrice) * 100);
                const volumeOff = tierPricing?.current_discount_percent || 0;
                const totalOff = Math.round(((wasPrice - finalPrice) / wasPrice) * 100);
                const hasTierDiscount = volumeOff > 0 && finalPrice < salePrice;

                return (
                  <div data-testid="sale-price-ribbon" className="rounded-xl overflow-hidden border border-red-200/60 mb-5 -mx-1">
                    <div className="bg-gradient-to-r from-[#8B1A1A] to-[#A62626] px-5 py-3.5 flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <span className="bg-white text-red-700 text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded">Sale</span>
                        <span className="text-red-200/70 text-sm line-through">£{safeToFixed(wasPrice, 2)}m²</span>
                        <span className="text-white text-2xl font-black tracking-tight">£{finalPrice.toFixed(2)}<span className="text-sm font-semibold text-white/80">m²</span></span>
                      </div>
                      <div className="bg-white px-3.5 py-2 rounded-lg text-center shadow-sm">
                        <div className="text-[10px] font-bold uppercase leading-none text-red-700">Save</div>
                        <div className="text-base font-black leading-tight text-red-700">£{(wasPrice - finalPrice).toFixed(2)}m²</div>
                      </div>
                    </div>
                    {/* Discount breakdown — guaranteed-sum: individual contributions always add to total */}
                    {(() => {
                      // Round volume, then force sale = remainder so sum always equals total
                      const volumeContrib = hasTierDiscount && wasPrice > 0 ? Math.round((wasPrice * (1 - saleOff / 100) - finalPrice) / wasPrice * 100) : 0;
                      const saleContrib = Math.max(0, totalOff - volumeContrib);
                      
                      const activeDiscounts = [saleContrib > 0, volumeContrib > 0].filter(Boolean).length;
                      if (activeDiscounts < 2) return null;
                      
                      return (
                        <div className="bg-red-50 px-5 py-2 flex items-center gap-4 text-xs">
                          <span className="flex items-center gap-1.5 font-medium text-red-800"><span className="w-1.5 h-1.5 rounded-full bg-red-500" />Sale: <strong>{saleContrib}% off</strong></span>
                          <span className="text-red-200">|</span>
                          <span className="flex items-center gap-1.5 font-medium text-amber-700"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" />Volume: <strong>{volumeContrib}% off</strong></span>
                          <span className="text-red-200">|</span>
                          <span className="flex items-center gap-1.5 font-bold text-green-700"><span className="w-1.5 h-1.5 rounded-full bg-green-500" />Total: {totalOff}% off</span>
                        </div>
                      );
                    })()}
                  </div>
                );
              })()}
              
              {/* Klarna OSM — "From £X/mo with Klarna" (hidden unless admin enabled it) */}
              {typeof finalPrice === 'number' && finalPrice > 0 && (
                <KlarnaOSM
                  price={finalPrice}
                  placement="credit-promotion-standard"
                  className="block mb-4"
                />
              )}
              
              <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <Layers className="w-4 h-4" />
                {tradeStatus.is_trade ? 'Trade Pricing' : 'Pricing'}
                {tradeStatus.is_trade && (
                  <span className="ml-auto flex items-center gap-1 bg-amber-500 text-white text-xs px-2 py-0.5 rounded-full">
                    <Crown className="w-3 h-3" /> Trade Account
                  </span>
                )}
              </h3>
              
              {tierPricing && !tierPricing.disabled ? (
                <div className="space-y-3">
                  {/* Trade Account Badge - when logged in as trade */}
                  {tradeStatus.is_trade && (
                    <div className="bg-gradient-to-r from-amber-500 to-amber-600 rounded-lg p-3 text-white mb-3">
                      <div className="flex items-center gap-2">
                        <BadgeCheck className="w-5 h-5" />
                        <div>
                          <p className="font-semibold text-sm">Trade Pricing Active</p>
                          <p className="text-xs opacity-90">Extra {tradeStatus.trade_discount}% off all tier prices</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Tier Table - show trade prices if trade user */}
                  <div className="bg-white rounded-lg border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-100 text-gray-600">
                          <th className="py-2 px-3 text-left font-medium">Quantity</th>
                          <th className="py-2 px-3 text-right font-medium">
                            {tradeStatus.is_trade 
                              ? (tierPricing.pricing_unit === 'unit' ? 'Trade Price/unit' : 'Trade Price/m²')
                              : (tierPricing.pricing_unit === 'unit' ? 'Price/unit' : 'Price/m²')
                            }
                          </th>
                          <th className="py-2 px-3 text-right font-medium">Savings</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(tradeStatus.is_trade && tierPricing.trade_tiers ? tierPricing.trade_tiers : tierPricing.tiers).map((tier, idx) => {
                          const priceField = tierPricing.pricing_unit === 'unit' ? 'price_per_unit' : 'price_per_m2';
                          return (
                            <tr 
                              key={tier.tier}
                              className={`border-t ${tierPricing.current_tier === tier.tier ? (tradeStatus.is_trade ? 'bg-amber-100' : 'bg-amber-50') : ''}`}
                            >
                              <td className="py-2 px-3 text-gray-700">
                                {tier.label}
                                {tierPricing.current_tier === tier.tier && (
                                  <span className={`ml-2 text-xs ${tradeStatus.is_trade ? 'bg-amber-600' : 'bg-amber-500'} text-white px-1.5 py-0.5 rounded`}>
                                    Your Price
                                  </span>
                                )}
                              </td>
                              <td className="py-2 px-3 text-right font-semibold text-gray-900">
                                £{(tier[priceField] || tier.price_per_m2 || tier.price_per_unit || 0).toFixed(2)}
                                {tradeStatus.is_trade && tierPricing.tiers[idx] && (
                                  <span className="block text-xs text-gray-400 line-through">
                                    £{(tierPricing.tiers[idx][priceField] || tierPricing.tiers[idx].price_per_m2 || tierPricing.tiers[idx].price_per_unit || 0).toFixed(2)}
                                  </span>
                                )}
                              </td>
                              <td className="py-2 px-3 text-right">
                                {(tier.discount_percent > 0 || (tradeStatus.is_trade && tier.total_discount_percent > 0)) ? (
                                  <span className="text-green-600 font-medium">{tier.savings_label}</span>
                                ) : (
                                  <span className="text-gray-400">{tier.savings_label}</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Current Price Summary */}
                  <div className="flex items-center justify-between pt-2 border-t">
                    <div>
                      <div className={`text-2xl font-bold ${tradeStatus.is_trade ? 'text-amber-600' : 'text-amber-500'}`}>
                        £{(tierPricing.pricing_unit === 'unit'
                          ? (tradeStatus.is_trade && tierPricing.trade_current_price_per_unit 
                              ? tierPricing.trade_current_price_per_unit 
                              : tierPricing.current_price_per_unit)
                          : (tradeStatus.is_trade && tierPricing.trade_current_price_per_m2 
                              ? tierPricing.trade_current_price_per_m2 
                              : tierPricing.current_price_per_m2)
                        )?.toFixed(2) || '0.00'}
                        <span className="text-base text-gray-500">
                          {tierPricing.pricing_unit === 'unit' ? 'unit' : 'm²'}
                        </span>
                      </div>
                      {tradeStatus.is_trade && (tierPricing.trade_current_price_per_m2 || tierPricing.trade_current_price_per_unit) && (
                        <div className="text-sm text-gray-400 line-through">
                          Retail: £{(tierPricing.pricing_unit === 'unit' 
                            ? tierPricing.current_price_per_unit 
                            : tierPricing.current_price_per_m2)?.toFixed(2) || '0.00'}
                          {tierPricing.pricing_unit === 'unit' ? 'unit' : 'm²'}
                        </div>
                      )}
                      {quantity > 1 && (
                        <div className="text-sm text-gray-600">
                          Total: <span className="font-semibold">
                            £{(tradeStatus.is_trade && tierPricing.trade_total_price 
                              ? tierPricing.trade_total_price 
                              : tierPricing.total_price)?.toFixed(2) || '0.00'}
                          </span> for {quantity}{tierPricing.pricing_unit === 'unit' ? ' units' : 'm²'}
                        </div>
                      )}
                    </div>
                    {((tradeStatus.is_trade && tierPricing.trade_discount_percent) || tierPricing.current_discount_percent > 0) && (
                      <div className="text-right">
                        <span className={`inline-block ${tradeStatus.is_trade ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'} text-sm font-medium px-2 py-1 rounded`}>
                          {tradeStatus.is_trade 
                            ? `Saving ${tierPricing.current_discount_percent + tierPricing.trade_discount_percent}%`
                            : `Saving ${tierPricing.current_discount_percent}%`
                          }
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Custom Quote Prompt */}
                  {tierPricing.show_custom_quote && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mt-3">
                      <p className="text-blue-800 text-sm font-medium">
                        Big Project? Request a Custom Quote
                      </p>
                      <p className="text-blue-600 text-xs mt-1">
                        For orders over {tierPricing.custom_quote_threshold}m², we can offer tailored pricing.
                      </p>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        className="mt-2 border-blue-300 text-blue-700 hover:bg-blue-100"
                        onClick={() => navigate('/contact?type=quote')}
                      >
                        Request Quote
                      </Button>
                    </div>
                  )}

                  {/* Trade Account Prompt - PROTECTED COMPONENT */}
                  <TradeLoginBox isLoggedIn={tradeStatus.is_trade} />
                </div>
              ) : (
                // Simple price display (tier pricing disabled or not available)
                <div className="space-y-2">
                  <div className="text-3xl font-bold text-amber-500">
                    £{(tile?.pricing_unit === 'unit' ? (tile?.unit_price || currentPrice) : currentPrice)?.toFixed(2)}
                    <span className="text-lg text-gray-500">
                      {tile?.pricing_unit === 'unit' ? ' each' : 'm²'}
                    </span>
                  </div>
                  {tile?.pricing_unit !== 'unit' && tile.price_per_tile && (
                    <div className="text-lg text-gray-700">
                      £{tile.price_per_tile?.toFixed(2)}
                      <span className="text-sm text-gray-500">/tile</span>
                    </div>
                  )}
                  {quantity > 1 && (
                    <div className="text-sm text-gray-600">
                      Total: <span className="font-semibold">
                        £{((tile?.pricing_unit === 'unit' ? (tile?.unit_price || currentPrice) : currentPrice) * quantity).toFixed(2)}
                      </span> for {quantity}{tile?.pricing_unit === 'unit' ? ' units' : 'm²'}
                    </div>
                  )}
                  {/* Trade Account Prompt for non-tier pricing products - PROTECTED COMPONENT */}
                  <TradeLoginBox isLoggedIn={tradeStatus.is_trade} />
                </div>
              )}
            </div>

            {/* Specifications Section - Compact & Clean */}
            <div className="bg-gray-50 rounded-lg p-4 mb-6">
              <h3 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
                <Layers className="w-4 h-4 text-gray-600" />
                Specifications
              </h3>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                {tile.size && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Size</span>
                    <span className="font-medium">{tile.size}</span>
                  </div>
                )}
                {tile.finish && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Finish</span>
                    <span className="font-medium capitalize">{tile.finish}</span>
                  </div>
                )}
                {tile.material && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Material</span>
                    <span className="font-medium">{tile.material}</span>
                  </div>
                )}
                {tile.color && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Colour</span>
                    <span className="font-medium">{(tile.color || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</span>
                  </div>
                )}
                {/* Series (replaces Collection) */}
                {(tile.series || tile.original_series) && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Series</span>
                    <span className="font-medium">{tile.series || tile.original_series}</span>
                  </div>
                )}
                {tile.edge && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Edge</span>
                    <span className="font-medium capitalize">{tile.edge}</span>
                  </div>
                )}
                {tile.slip_rating && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Slip Rating</span>
                    <span className="font-medium">{tile.slip_rating.toUpperCase()}</span>
                  </div>
                )}
                {tile.thickness && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Thickness</span>
                    <span className="font-medium">{tile.thickness}</span>
                  </div>
                )}
                {tile.suitability && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Suitability</span>
                    <span className="font-medium">{tile.suitability.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' & ')}</span>
                  </div>
                )}
                {/* Box Coverage Info */}
                {tile.tiles_per_box && tile.tiles_per_box > 0 && (
                  <div className="flex justify-between text-teal-700">
                    <span>Tiles per Box</span>
                    <span className="font-bold">{tile.tiles_per_box}</span>
                  </div>
                )}
                {tile.sqm_per_box && tile.sqm_per_box > 0 && (
                  <div className="flex justify-between text-teal-700">
                    <span>m² per Box</span>
                    <span className="font-bold">{parseFloat(tile.sqm_per_box).toFixed(2)}m²</span>
                  </div>
                )}
              </div>
            </div>

            {/* Stock Status Badge - thresholds: 0 = Out of Stock, <30m² = Low Stock, >30m² = In Stock */}
            <div className="mb-4" data-testid="stock-status-badge">
              {(() => {
                const stockQty = tile.stock || tile.stock_quantity || tile.stock_m2 || 0;
                const lowStockThreshold = 30; // m² threshold for low stock
                const explicitStatus = (tile.stock_status || '').toLowerCase();
                
                if (explicitStatus === 'out_of_stock' || tile.in_stock === false) {
                  return (
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-red-100 text-red-800 rounded-full text-sm font-medium">
                      <span className="w-2 h-2 bg-red-500 rounded-full"></span>
                      Out of Stock
                    </div>
                  );
                }
                if (explicitStatus === 'low_stock') {
                  return (
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-amber-100 text-amber-800 rounded-full text-sm font-medium">
                      <span className="w-2 h-2 bg-amber-500 rounded-full"></span>
                      Low Stock
                    </div>
                  );
                }
                if (explicitStatus === 'in_stock' || tile.always_in_stock || stockQty > lowStockThreshold) {
                  return (
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-green-100 text-green-800 rounded-full text-sm font-medium">
                      <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                      In Stock
                    </div>
                  );
                } else if (stockQty > 0) {
                  return (
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-amber-100 text-amber-800 rounded-full text-sm font-medium">
                      <span className="w-2 h-2 bg-amber-500 rounded-full"></span>
                      Low Stock
                    </div>
                  );
                } else if (tile.in_stock === true) {
                  return (
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-green-100 text-green-800 rounded-full text-sm font-medium">
                      <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
                      In Stock
                    </div>
                  );
                } else {
                  return (
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-red-100 text-red-800 rounded-full text-sm font-medium">
                      <span className="w-2 h-2 bg-red-500 rounded-full"></span>
                      Out of Stock
                    </div>
                  );
                }
              })()}
            </div>

            {/* Quantity Input & Add to Cart - Compact Layout */}
            <div className="bg-white border-2 border-gray-200 rounded-lg p-4 mb-4">
              <div className="flex items-center gap-4 flex-wrap">
                {/* Quantity Input */}
                <div className="flex items-center gap-2">
                  <span className="text-gray-600 text-sm font-medium">
                    {tile?.pricing_unit === 'unit' ? 'Qty:' : 'm²:'}
                  </span>
                  <div className="flex items-center border rounded-md bg-white">
                    <button 
                      onClick={() => setQuantity(q => Math.max(1, q - 1))}
                      className="p-2 hover:bg-gray-100"
                    >
                      <Minus className="h-4 w-4" />
                    </button>
                    <Input
                      type="number"
                      value={quantity}
                      onChange={(e) => setQuantity(Math.max(1, parseFloat(e.target.value) || 1))}
                      className="w-20 text-center border-0 font-bold"
                      min="1"
                      step="0.1"
                    />
                    <button 
                      onClick={() => setQuantity(q => q + 1)}
                      className="p-2 hover:bg-gray-100"
                    >
                      <Plus className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Box Rounding Info - Shows when customer enters m² */}
                {tile?.sqm_per_box && tile.sqm_per_box > 0 && boxInfo && (
                  <div className="flex items-center gap-3 px-3 py-2 bg-teal-50 rounded-lg border border-teal-200">
                    <Package className="w-4 h-4 text-teal-600" />
                    <div className="text-sm">
                      <span className="text-teal-700">= </span>
                      <span className="font-bold text-teal-800">{boxInfo.boxesNeeded} box{boxInfo.boxesNeeded > 1 ? 'es' : ''}</span>
                      <span className="text-teal-600 ml-1">({boxInfo.actualSqm}m²)</span>
                    </div>
                    <div className="text-lg font-bold text-teal-800">
                      £{boxInfo.totalPrice?.toFixed(2) || (currentPrice * boxInfo.actualSqm).toFixed(2)}
                    </div>
                  </div>
                )}

                {/* Price when no box info */}
                {(!tile?.sqm_per_box || !boxInfo) && (
                  <div className="text-lg font-bold text-gray-800">
                    £{((tile?.pricing_unit === 'unit' ? (tile?.unit_price || currentPrice) : currentPrice) * quantity).toFixed(2)}
                  </div>
                )}
              </div>

              {/* Extra coverage note */}
              {boxInfo && boxInfo.extraSqm > 0 && (
                <div className="mt-2 text-xs text-teal-600">
                  Includes +{boxInfo.extraSqm}m² extra (tiles sold in full boxes)
                </div>
              )}

              {/* Add to Cart & Sample Buttons - Side by Side */}
              <div className="flex gap-3 mt-4">
                {quoteStatus.show_quote_button && !quoteStatus.quote_disabled ? (
                  <Button 
                    className="flex-1 bg-amber-500 hover:bg-amber-600 text-white font-semibold py-5"
                    onClick={() => setShowQuoteModal(true)}
                    data-testid="request-quote-btn"
                  >
                    <FileText className="h-4 w-4 mr-2" />
                    Request Quote
                  </Button>
                ) : (
                  <Button 
                    className="flex-1 bg-[#333333] hover:bg-[#444444] text-[#F7EA1C] font-semibold py-5"
                    onClick={handleAddToCart}
                    data-testid="add-to-cart-btn"
                  >
                    <ShoppingCart className="h-4 w-4 mr-2" />
                    Add to Cart
                  </Button>
                )}
                <Button 
                  variant={isInSamples(tile?.id) ? "default" : "outline"}
                  className={isInSamples(tile?.id) 
                    ? "py-5 bg-green-600 hover:bg-green-700 text-white" 
                    : "py-5 border-[#333333] text-[#333333] hover:bg-[#333333] hover:text-[#F7EA1C]"
                  }
                  onClick={handleOrderSample}
                  data-testid="order-sample-btn"
                >
                  <Scissors className="h-4 w-4 mr-2" />
                  {isInSamples(tile?.id) ? 'View Samples' : 'Free Sample'}
                </Button>
              </div>
            </div>

            {/* Advanced Tile Calculator */}
            <AdvancedTileCalculator 
              tile={tile}
              onAddToCart={(sqm) => {
                setQuantity(sqm);
                toast.success(`Quantity set to ${sqm}m²`);
              }}
            />

            {/* Large Order Notice */}
            {quoteStatus.show_quote_button && !quoteStatus.quote_disabled && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4">
                <p className="text-amber-800 text-sm font-medium flex items-center gap-2">
                  <FileText className="w-4 h-4" />
                  Large Order - Custom Pricing Available
                </p>
                <p className="text-amber-600 text-xs mt-1">
                  For orders over {quoteStatus.threshold}m², request a quote for the best price.
                </p>
              </div>
            )}

              {/* AI Room Visualizer Button */}
              <Button
                variant="outline"
                className="w-full py-4 border-amber-500 text-amber-600 hover:bg-amber-50 mt-3"
                onClick={() => setShowVisualizer(true)}
                data-testid="room-visualizer-btn"
              >
                <Layers className="h-4 w-4 mr-2" />
                Visualize in Your Room
              </Button>

            {/* Share Buttons */}
            <div className="mt-6 pt-6 border-t">
              <ShareProduct 
                productName={tile.display_name} 
                productUrl={window.location.href}
                productImage={firstImageUrl(tile.images)}
              />
            </div>

            {/* Price Match Guarantee Badge */}
            <div className="mt-6">
              <PriceMatchBadge variant="default" />
            </div>

            {/* USPs */}
            <div className="grid grid-cols-3 gap-4 mt-8 pt-8 border-t">
              <div className="text-center">
                <Truck className="h-6 w-6 mx-auto mb-2 text-amber-500" />
                <p className="text-xs text-gray-600">{trustBadgeData.delivery.title}<br/>{trustBadgeData.delivery.subtitle}</p>
              </div>
              <div className="text-center">
                <Package className="h-6 w-6 mx-auto mb-2 text-amber-500" />
                <p className="text-xs text-gray-600">Free Click<br/>& Collect</p>
              </div>
              <div className="text-center">
                <ShieldCheck className="h-6 w-6 mx-auto mb-2 text-amber-500" />
                <p className="text-xs text-gray-600">{trustBadgeData.quality.title}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Frequently Bought Together */}
        {frequentlyBought.length > 0 && (
          <section className="mt-16 bg-amber-50 -mx-4 px-4 py-8 md:mx-0 md:px-8 md:rounded-xl">
            <h2 className="text-2xl font-bold text-gray-900 mb-2 flex items-center gap-2">
              <Users className="h-6 w-6 text-amber-600" />
              Customers Also Bought
            </h2>
            <p className="text-gray-600 mb-6">Complete your project with these popular additions</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {frequentlyBought.map((t) => (
                <Link
                  key={t.id}
                  to={`/tiles/${t.slug}`}
                  className="group bg-white rounded-lg p-3 shadow-sm hover:shadow-md transition"
                >
                  <div className="aspect-square bg-gray-100 rounded-md overflow-hidden mb-3 relative">
                    {firstImageUrl(t.images) ? (
                      <img
                        src={firstImageUrl(t.images)}
                        alt={t.display_name}
                        className="w-full h-full object-cover group-hover:scale-105 transition"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-400 text-sm">
                        No Image
                      </div>
                    )}
                    {t.times_bought_together && (
                      <div className="absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded">
                        {t.times_bought_together}x bought together
                      </div>
                    )}
                  </div>
                  <h3 className="font-medium text-gray-900 group-hover:text-amber-600 transition line-clamp-2 text-sm">
                    {t.display_name || t.name}
                  </h3>
                  <p className="text-amber-600 font-semibold mt-1">
                    £{(t.room_lot_price || t.price)?.toFixed(2)}m²
                  </p>
                  {t.price_per_tile && (
                    <p className="text-xs text-gray-500">
                      £{t.price_per_tile?.toFixed(2)}/tile
                    </p>
                  )}
                  <Button 
                    size="sm" 
                    variant="outline" 
                    className="w-full mt-2 text-xs"
                    onClick={(e) => {
                      e.preventDefault();
                      addToCart(t, 1, 'room_lot');
                      toast.success('Added to cart');
                    }}
                  >
                    <ShoppingCart className="h-3 w-3 mr-1" />
                    Add to Cart
                  </Button>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Similar Products */}
        {similarTiles.length > 0 && (
          <section className="mt-16">
            <h2 className="text-2xl font-bold text-gray-900 mb-6">You May Also Like</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              {similarTiles.map((t) => (
                <Link
                  key={t.id}
                  to={`/tiles/${t.slug}`}
                  className="group"
                >
                  <div className="aspect-square bg-gray-100 rounded-lg overflow-hidden mb-3">
                    {firstImageUrl(t.images) ? (
                      <img
                        src={firstImageUrl(t.images)}
                        alt={t.display_name}
                        className="w-full h-full object-cover group-hover:scale-105 transition"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-400">
                        No Image
                      </div>
                    )}
                  </div>
                  <h3 className="font-medium text-gray-900 group-hover:text-amber-500 transition line-clamp-2">
                    {t.display_name}
                  </h3>
                  <p className="text-amber-500 font-semibold">
                    £{t.price?.toFixed(2)}m²
                  </p>
                  {t.price_per_tile && (
                    <p className="text-sm text-gray-500">
                      £{t.price_per_tile?.toFixed(2)}/tile
                    </p>
                  )}
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Customer Reviews Section */}
        <ReviewSection productId={tile?.id} productName={tile?.display_name} />
      </div>

      {/* Recently Viewed Products */}
      <RecentlyViewedSection currentProductSlug={tile?.slug || tile?.id} maxItems={6} />

      {/* You May Also Need - Cross-group recommendations */}
      <YouMayAlsoNeed currentGroup={tile?.product_group || 'tiles'} maxItems={6} />

      {/* Room Visualizer Modal */}
      {showVisualizer && (
        <RoomVisualizer 
          tile={tile} 
          onClose={() => setShowVisualizer(false)} 
        />
      )}

      {/* Quote Request Modal */}
      <Dialog open={showQuoteModal} onOpenChange={setShowQuoteModal}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-amber-500" />
              Request a Quote
            </DialogTitle>
            <DialogDescription>
              Get custom pricing for your large order of {tile?.display_name || 'this product'}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmitQuote} className="space-y-4 mt-4">
            {/* Product Summary */}
            <div className="bg-gray-50 rounded-lg p-3 flex items-center gap-3">
              {tile?.images?.[0] && (
                <img src={normaliseImageUrl(firstImageUrl(tile.images))} alt={tile.display_name} className="w-16 h-16 object-cover rounded" />
              )}
              <div>
                <p className="font-medium text-gray-900">{tile?.display_name}</p>
                <p className="text-amber-600 font-semibold">{quantity}m² requested</p>
              </div>
            </div>

            {/* Contact Details */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="customer_name">Full Name *</Label>
                <div className="relative mt-1">
                  <Input
                    id="customer_name"
                    value={quoteForm.customer_name}
                    onChange={(e) => setQuoteForm(prev => ({...prev, customer_name: e.target.value}))}
                    placeholder="John Smith"
                    required
                    data-testid="quote-name-input"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="customer_company">Company (Optional)</Label>
                <div className="relative mt-1">
                  <Building2 className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <Input
                    id="customer_company"
                    value={quoteForm.customer_company}
                    onChange={(e) => setQuoteForm(prev => ({...prev, customer_company: e.target.value}))}
                    placeholder="ABC Construction"
                    className="pl-9"
                    data-testid="quote-company-input"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="customer_email">Email *</Label>
                <div className="relative mt-1">
                  <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <Input
                    id="customer_email"
                    type="email"
                    value={quoteForm.customer_email}
                    onChange={(e) => setQuoteForm(prev => ({...prev, customer_email: e.target.value}))}
                    placeholder="john@example.com"
                    className="pl-9"
                    required
                    data-testid="quote-email-input"
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="customer_phone">Phone *</Label>
                <div className="relative mt-1">
                  <Phone className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <Input
                    id="customer_phone"
                    type="tel"
                    value={quoteForm.customer_phone}
                    onChange={(e) => setQuoteForm(prev => ({...prev, customer_phone: e.target.value}))}
                    placeholder="07123 456789"
                    className="pl-9"
                    required
                    data-testid="quote-phone-input"
                  />
                </div>
              </div>
            </div>

            <div>
              <Label htmlFor="delivery_postcode">Delivery Postcode</Label>
              <div className="relative mt-1">
                <MapPin className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input
                  id="delivery_postcode"
                  value={quoteForm.delivery_postcode}
                  onChange={(e) => setQuoteForm(prev => ({...prev, delivery_postcode: e.target.value}))}
                  placeholder="SW1A 1AA"
                  className="pl-9"
                  data-testid="quote-postcode-input"
                />
              </div>
            </div>

            <div>
              <Label htmlFor="project_details">Project Details (Optional)</Label>
              <Textarea
                id="project_details"
                value={quoteForm.project_details}
                onChange={(e) => setQuoteForm(prev => ({...prev, project_details: e.target.value}))}
                placeholder="Tell us about your project - timeline, special requirements, etc."
                rows={3}
                className="mt-1"
                data-testid="quote-details-input"
              />
            </div>

            <div>
              <Label>Preferred Contact Method</Label>
              <div className="flex gap-4 mt-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="preferred_contact"
                    value="email"
                    checked={quoteForm.preferred_contact === 'email'}
                    onChange={(e) => setQuoteForm(prev => ({...prev, preferred_contact: e.target.value}))}
                    className="text-amber-500"
                  />
                  <span className="text-sm">Email</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="preferred_contact"
                    value="phone"
                    checked={quoteForm.preferred_contact === 'phone'}
                    onChange={(e) => setQuoteForm(prev => ({...prev, preferred_contact: e.target.value}))}
                    className="text-amber-500"
                  />
                  <span className="text-sm">Phone</span>
                </label>
              </div>
            </div>

            <div className="flex gap-3 pt-4 border-t">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowQuoteModal(false)}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={quoteSubmitting}
                className="flex-1 bg-amber-500 hover:bg-amber-600 text-white"
                data-testid="submit-quote-btn"
              >
                {quoteSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Submitting...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4 mr-2" />
                    Submit Quote Request
                  </>
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <ShopFooter />
      
      {/* Live Chat Widget */}
      <LiveChatWidget />
    </div>
  );
};

export default TileDetailPage;
