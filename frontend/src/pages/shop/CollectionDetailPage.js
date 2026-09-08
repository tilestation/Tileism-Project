import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { fetchDeliveryTerms } from '../../lib/deliveryTerms';
import { 
  Heart, 
  ArrowLeft, 
  Truck, 
  Star, 
  Check,
  ShoppingCart,
  Minus,
  Plus,
  ChevronRight,
  ChevronLeft,
  Scissors,
  Info,
  Shield,
  ZoomIn,
  User,
  Settings,
  Calculator,
  Tag,
  Percent,
  X,
  Maximize2,
  Play,
  Pause,
  Home,
  Eye,
  Clock,
  MapPin,
  Share2,
  Facebook,
  Mail,
  Copy,
  ChevronDown,
  Droplet,
  Ruler,
  Layers,
  Wrench,
  Printer
} from 'lucide-react';
import { ShopHeader, ShopFooter } from './TileStationHome';
import SeoHead from '../../components/seo/SeoHead';
import { formatSizeDual, sizeToCm } from '../../utils/sizeFormat';
import RenderProductDescription from '../../components/shop/RenderProductDescription';
import { Button } from '../../components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip';
import { useCart } from '../../contexts/TileCartContext';
import { useSampleCart } from '../../contexts/SampleCartContext';
import { useWishlist } from '../../contexts/WishlistContext';
import { toast } from 'sonner';

// Multi-finish helpers — products may carry a `finishes` array alongside the scalar `finish`
const getProductFinishes = (p) => {
  const arr = Array.isArray(p?.finishes) ? p.finishes.map(f => String(f).trim()).filter(Boolean) : [];
  if (arr.length > 0) return arr;
  const single = (p?.finish || p?.attributes?.finish || '').trim();
  return single ? [single] : [];
};
const productHasFinish = (p, f) =>
  getProductFinishes(p).some(x => x.toLowerCase() === String(f || '').trim().toLowerCase());
import LiveChatWidget from '../../components/shop/LiveChatWidget';
import { RecentlyViewedSection, YouMayAlsoNeed, trackRecentView } from '../../components/shop/CrossSellSections';
import { usePageTracking } from '../../hooks/usePageTracking';
import { useTradeUser } from '../../hooks/useTradeUser';
import { useTrustBadges } from '../../hooks/useTrustBadges';
// Crash-proof string + array helpers — see /utils/safeStr.js for full
// rationale. The collection detail page has 90+ string operations on
// fields that can be null/undefined/objects/numbers in production data.
// Without these helpers, ANY ONE bad value crashes the whole PDP.
import {
  safeStr, safeLower, safeMatch, safeIncludes, safeSplit,
  safeArr, safeNum, safeToFixed, normaliseImageList, normaliseImageUrl,
} from '../../utils/safeStr';
import { SafeSection } from '../../components/shop/StorefrontErrorBoundary';
import { DeliveryInfoCompact } from './InfoPage';
import AdvancedTileCalculator from '../../components/shop/AdvancedTileCalculator';
import { TradeLoginBox } from '../../components/shop/TradeLoginPrompt';
import VolumePricingTable from '../../components/shop/VolumePricingTable';
import OrderSampleButton from '../../components/shop/OrderSampleButton';
import PinterestSaveButton from '../../components/shop/PinterestSaveButton';
import { computePillDims, parseSizeToMm } from '../../utils/sizePill';
import { firstImageUrl, imageUrl } from '../../utils/imageUrl';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Normalize any size string ("30.0x60.0", "300 x 600mm", "600x600mm") to one canonical mm label
const canonicalSizeLabel = (s) => {
  if (!s) return '';
  const nums = (String(s).match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (nums.length < 2) return String(s).trim();
  const lower = String(s).toLowerCase();
  const isMm = lower.includes('mm') ? true : lower.includes('cm') ? false : Math.max(nums[0], nums[1]) > 120;
  const toMm = (v) => Math.round(isMm ? v : v * 10);
  const parts = [toMm(nums[0]), toMm(nums[1])];
  if (nums.length >= 3) {
    const t = toMm(nums[2]);
    if (t <= 30) parts.push(t);
  }
  return parts.join('x') + 'mm';
};
const dedupeSizeLabels = (sizes) => [...new Set((sizes || []).map(canonicalSizeLabel).filter(Boolean))];

// Real-colour vocabulary — used to auto-label the variant selector
// ("Colour" vs "Design" vs "Colour / Design") for collections whose variants
// are design names (e.g. Romantic, Leaf, Garden) rather than colours.
const COLOUR_WORDS = new Set([
  'white', 'black', 'grey', 'gray', 'beige', 'cream', 'ivory', 'brown', 'taupe', 'sand',
  'anthracite', 'charcoal', 'graphite', 'silver', 'gold', 'blue', 'navy', 'teal', 'aqua',
  'turquoise', 'green', 'olive', 'sage', 'mint', 'red', 'terracotta', 'burgundy', 'maroon',
  'pink', 'blush', 'rose', 'purple', 'violet', 'lilac', 'lavender', 'yellow', 'mustard',
  'ochre', 'orange', 'amber', 'copper', 'bronze', 'rust', 'mocha', 'coffee', 'chocolate',
  'tan', 'camel', 'greige', 'pearl', 'smoke', 'ash', 'bone', 'multicolour', 'multicolor', 'multi',
  // Italian / Spanish colour names common in tile ranges
  'bianco', 'blanco', 'nero', 'negro', 'grigio', 'gris', 'crema', 'marfil', 'avorio',
  'antracite', 'marrone', 'marron', 'azul', 'azzurro', 'verde', 'rosso', 'rojo', 'rosa',
  'oro', 'plata', 'perla', 'arena', 'tortora', 'moka', 'cotto',
]);
const isRealColour = (name) =>
  String(name || '').toLowerCase().split(/[^a-z]+/).some(w => COLOUR_WORDS.has(w));

const hexIsDark = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum < 140;
};

const CollectionDetailPage = () => {
  // Splat route: param name is '*' (allows slashes in collection names like "70 x 350 x 20/5mm")
  const params = useParams();
  const seriesName = params['*'] || params.seriesName || '';
  const [searchParams] = useSearchParams();
  const productSlugParam = searchParams.get('product'); // From /tiles/:slug redirect
  const skuParam = searchParams.get('sku'); // Direct product link → opens that exact tile
  const { addToCart } = useCart();
  const { addSample, isInSamples, sampleCount, maxSamples } = useSampleCart();
  const { isInWishlist, toggleWishlist } = useWishlist();
  const { isTrade, getTradePrice } = useTradeUser();
  const { badges: trustBadgeData, enabled: trustBadgesEnabled } = useTrustBadges();
  
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tierPricing, setTierPricing] = useState(null);
  const [tierPricingSlug, setTierPricingSlug] = useState(null);
  const [creditBackRate, setCreditBackRate] = useState(null);
  const [productTradeDiscount, setProductTradeDiscount] = useState(null);
  // Effective per-product trade discount as a PERCENT of the selected product's
  // unit price. Supports fixed-£ trade prices saved from the admin Tier Pricing
  // modal (converted to an equivalent % so the existing % maths keeps working).
  const getEffTradePct = () => {
    if (!isTrade) return 0;
    const raw = selectedProduct?.trade_discount ?? productTradeDiscount;
    const val = Number(raw) || 0;
    if (val <= 0) return 0;
    const type = String(selectedProduct?.trade_discount_type || 'percent').toLowerCase();
    if (type !== 'fixed') return val;
    const base = Number(selectedProduct?.room_lot_price ?? selectedProduct?.price ?? 0);
    return base > 0 ? Math.min(100, (val / base) * 100) : 0;
  };
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [collectionDescription, setCollectionDescription] = useState('');
  const [variantLabelOverride, setVariantLabelOverride] = useState('');
  const [descriptionSource, setDescriptionSource] = useState(''); // 'custom', 'series', or 'auto'
  const [isAddingToCart, setIsAddingToCart] = useState(false);
  const [cartAdded, setCartAdded] = useState(false);  
  // Selected options state
  const [selectedColor, setSelectedColor] = useState(null);
  const [selectedFinish, setSelectedFinish] = useState(null);
  const [selectedSize, setSelectedSize] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedMaterialProduct, setSelectedMaterialProduct] = useState(null); // For material/tool collections with distinct products
  const userClickedRef = useRef(null); // tracks 'color' or 'finish' to prevent auto-switch race conditions
  const [quantity, setQuantity] = useState(1);
  // 24 May 2026 — default to 'box', not 'sqm'. A box is the natural
  // minimum order unit (customers pay box prices, not partial m²),
  // and defaulting to 'sqm' caused the m² input to show "1" while
  // the box input also showed "1" — confusingly identical-looking
  // values even though 1 box covers 1.26 m² in this example. With
  // 'box' as the default, the m² input now renders the actual
  // coverage (e.g. 1.26) on first load, which matches the "1 box =
  // 1.26 m² actual coverage" hint and stops customers wondering
  // why both inputs show "1". Cart math is unchanged — getEffective
  // SqmQuantity already handles either unit.
  const [quantityUnit, setQuantityUnit] = useState('box');
  // Pallet pricing tier — 'm2' (default per-m²), 'half_pallet', or 'full_pallet'.
  // When half/full pallet selected, qty is forced to the matching minimum m²
  // and the £/m² rate switches to the tile's pallet-rate field.
  const [pricingTier, setPricingTier] = useState('m2');
  const [mainImageIndex, setMainImageIndex] = useState(0);
  const [isZooming, setIsZooming] = useState(false);
  const [zoomPosition, setZoomPosition] = useState({ x: 0, y: 0 });
  const [previewThumbIdx, setPreviewThumbIdx] = useState(null);
  const [showCalculator, setShowCalculator] = useState(false);
  const [relatedProducts, setRelatedProducts] = useState([]);
  const [pinnedYouMayNeed, setPinnedYouMayNeed] = useState([]);
  const [relatedScrollIndex, setRelatedScrollIndex] = useState(0);
  // Frequently Bought Together — real co-purchase recs from /api/recommendations
  const [fbtItems, setFbtItems] = useState([]);
  const [fbtSelected, setFbtSelected] = useState(new Set());

  // Actual-size 1:1 preview toggle
  const [showActualSize, setShowActualSize] = useState(false);

  // Global sample-service toggle — controls whether "Order Sample"
  // buttons are visible site-wide. Combined with per-product
  // `samples_hidden` flag for fine-grained control. Fetched on mount
  // from the public sample-service content endpoint. Defaults to ON
  // so a missing/slow API doesn't break the existing UX.
  const [sampleServiceEnabled, setSampleServiceEnabled] = useState(true);
  useEffect(() => {
    fetch(`${API_URL}/api/content/sample-service`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.global_enabled === false) setSampleServiceEnabled(false);
      })
      .catch(() => { /* default already ON */ });
  }, []);
  // Convenience: true only when global toggle is ON AND this specific
  // product hasn't been opted out by admin. Clearance tiles are
  // handled separately — `OrderSampleButton` itself shows a "no
  // samples on clearance, visit showroom" notice. Legacy CTA pills
  // (banner/modal) check `canShowSampleButton && !clearance` to
  // hide cleanly on clearance tiles.
  const canShowSampleButton =
    sampleServiceEnabled && !selectedProduct?.samples_hidden;
  const canShowLegacySampleCTA =
    canShowSampleButton && !selectedProduct?.clearance;
  
  // Image Gallery Enhancement States
  const [showLightbox, setShowLightbox] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [showRoomView, setShowRoomView] = useState(false);
  const [deliveryTerms, setDeliveryTerms] = useState('');
  useEffect(() => { fetchDeliveryTerms().then(setDeliveryTerms); }, []);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  
  // Delivery Countdown State
  const [deliveryCountdown, setDeliveryCountdown] = useState({ hours: 0, minutes: 0, seconds: 0 });
  
  // Product Documents State
  const [productDocuments, setProductDocuments] = useState([]);
  
  // Accordion States for Technical Specs
  const [openAccordions, setOpenAccordions] = useState({ specs: true, installation: false, maintenance: false, delivery: false });
  
  // Page Settings from Admin Panel
  const [pageSettings, setPageSettings] = useState(null);
  
  usePageTracking();

  const decodedSeriesName = decodeURIComponent(seriesName);
  // Admin landing-page preview (?preview=1) — includes unpublished products.
  const isAdminPreview = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('preview') === '1';

  // Check login status - only for SHOP customers, not admin users
  // Admin tokens (tileStationToken, token, auth_token) should NOT hide the Trade box
  // Only VALID shop customer tokens should hide it
  useEffect(() => {
    const shopToken = localStorage.getItem('shop_token');
    const tileShopToken = localStorage.getItem('tile_shop_token');
    
    // Validate token is not expired before hiding Trade box
    const isTokenValid = (token) => {
      if (!token) return false;
      try {
        const parts = token.split('.');
        if (parts.length !== 3) return false;
        const payload = JSON.parse(atob(parts[1]));
        if (payload.exp && payload.exp * 1000 < Date.now()) {
          return false; // Token expired
        }
        return true;
      } catch {
        return false; // Invalid token format
      }
    };
    
    const validShopToken = isTokenValid(shopToken);
    const validTileShopToken = isTokenValid(tileShopToken);
    
    // Clear expired tokens AND their cached customer payload — keeping them in
    // sync prevents the "phantom logged-in" state where the header shows
    // a trade pill but the trade account API rejects the missing/expired token.
    if (shopToken && !validShopToken) {
      localStorage.removeItem('shop_token');
    }
    if (tileShopToken && !validTileShopToken) {
      localStorage.removeItem('tile_shop_token');
      localStorage.removeItem('tile_shop_customer');
      window.dispatchEvent(new Event('trade-auth-change'));
    }
    
    setIsLoggedIn(validShopToken || validTileShopToken);
  }, []);

  // Fetch page settings from admin panel
  useEffect(() => {
    const fetchPageSettings = async () => {
      try {
        const res = await fetch(`${API_URL}/api/website-admin/collection-detail-settings`);
        if (res.ok) {
          const data = await res.json();
          if (data.settings && Object.keys(data.settings).length > 0) {
            setPageSettings(data.settings);
            // Apply accordion default open states from settings
            if (data.settings.accordionSections?.sections) {
              const sections = data.settings.accordionSections.sections;
              setOpenAccordions({
                specs: sections.specifications?.defaultOpen ?? true,
                installation: sections.installation?.defaultOpen ?? false,
                maintenance: sections.maintenance?.defaultOpen ?? false
              });
            }
          }
        }
      } catch (error) {
        console.error('Error fetching page settings:', error);
        // Continue with defaults if fetch fails
      }
    };
    fetchPageSettings();
  }, []);

  // Helper to extract color from product name (used throughout the component)
  // Returns the LAST color keyword found before dimensions (e.g. 60x60cm)
  // This avoids picking up color words that are part of the series name
  // e.g. "Ardesia Slate Black 30x60cm Matt" → returns "Black", not "Slate"
  const extractColorFromName = (name) => {
    if (!name) return null;
    const colorKeywords = new Set([
      'white', 'ivory', 'cream', 'beige', 'sand', 'bone', 'pearl', 'crema', 'bianco',
      'grey', 'gray', 'silver', 'charcoal', 'graphite', 'ash', 'smoke', 'slate', 'grigio', 'ice', 'snow',
      'black', 'anthracite', 'onyx', 'nero', 'dark', 'carbon',
      'brown', 'walnut', 'chocolate', 'coffee', 'bronze', 'copper', 'taupe', 'mocha', 'tobacco',
      'blue', 'navy', 'aqua', 'teal', 'ocean', 'azure', 'cobalt', 'sky', 'turquoise', 'indigo', 'denim', 'jean', 'blu',
      'green', 'sage', 'olive', 'emerald', 'forest', 'moss', 'mint', 'verde',
      'pink', 'rose', 'blush', 'coral', 'salmon', 'orchid', 'rosa',
      'red', 'terracotta', 'rust', 'burgundy', 'maroon', 'garnet',
      'gold', 'golden', 'brass', 'amber', 'honey', 'caramel', 'lemon',
      'purple', 'lilac', 'lavender', 'mauve', 'violet', 'magenta',
      'natural', 'stone', 'earth', 'clay', 'greige', 'platinum',
      'noce', 'cenere', 'perla', 'gris', 'blanco', 'marfil', 'bordeaux',
    ]);
    const parts = name.split(/\s+/);
    let lastColor = null;
    for (const part of parts) {
      if (/^\d+(\.\d+)?[xX]\d+/.test(part)) break;
      if (colorKeywords.has(part.toLowerCase())) {
        lastColor = part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
      }
    }
    return lastColor;
  };

  // Get color for a product - from field OR extracted from name
  // Always returns normalized (lowercase trimmed) value for consistent comparison
  const getProductColor = (product) => {
    // Only use explicitly saved color — never extract from product name
    const fieldColor = product?.color || product?.attributes?.color;
    if (fieldColor && fieldColor.trim()) return fieldColor.trim().toLowerCase();
    return null;
  };

  // Match a product against the selected variant (color OR first-word-of-name)
  const matchesSelectedVariant = useCallback((product, variant) => {
    if (!variant) return true;
    const color = getProductColor(product);
    if (color === variant) return true;
    // Match by first word of display name (for products without color)
    const displayName = (product?.display_name || product?.product_name || product?.name || '').trim();
    const firstWord = displayName.split(/\s+/)[0] || '';
    return firstWord.toLowerCase() === variant.toLowerCase();
  }, []);


  // Preload every variant's lead images once the collection loads, so
  // switching colour/size swaps instantly instead of flashing like a reload.
  useEffect(() => {
    products.slice(0, 40).forEach(p => {
      normaliseImageList(p?.images).slice(0, 2).forEach(src => {
        if (src && !/\.(mp4|webm|mov)(\?|$)/i.test(src)) {
          const im = new Image();
          im.src = src;
        }
      });
    });
  }, [products]);

  // Fetch products
  useEffect(() => {
    let cancelled = false;

    // Reset all product-selection state when the collection route changes.
    // Without this, the previous collection's selectedProduct can survive long
    // enough to render under the new collection heading, especially when both
    // collections share the same colour / finish / size values. That is how a
    // Songbird variant can appear briefly (or stay stuck) inside Genesis Slate
    // until the user clicks another swatch.
    setLoading(true);
    setProducts([]);
    setSelectedProduct(null);
    setSelectedColor(null);
    setSelectedFinish(null);
    setSelectedSize(null);
    setSelectedStyle(null);
    setSelectedMaterialProduct(null);
    setMainImageIndex(0);
    setPreviewThumbIdx(null);
    setProductDocuments([]);

    const fetchProducts = async () => {
      try {
        const res = await fetch(`${API_URL}/api/tiles/collection/${encodeURIComponent(decodedSeriesName)}?limit=100${isAdminPreview ? '&preview=1' : ''}`);
        const data = await res.json();
        if (cancelled) return;
        const fetchedProducts = data.products || [];
        setProducts(fetchedProducts);
        
        // Track this collection as recently viewed
        if (fetchedProducts.length > 0) {
          const first = fetchedProducts[0];
          trackRecentView({
            slug: encodeURIComponent(decodedSeriesName),
            display_name: decodedSeriesName,
            image: normaliseImageUrl(first?.images?.[0]),
            price: first?.room_lot_price || first?.price,
            product_group: first?.product_group || 'tiles',
            is_surface_product: first?.is_surface_product,
          });
        }
        
        // Get custom description (admin-set) or series-level description.
        // IMPORTANT: only an EXPLICIT admin collection description (saved in
        // collection_settings) may override each product's own description.
        // The backend also falls back to "one arbitrary product's description"
        // — that must NEVER mask the selected variant's own text, otherwise
        // regenerated descriptions look "stuck" on one size.
        setVariantLabelOverride(data.variant_label || '');
        const customDesc = (data.custom_description || '').trim();
        const seriesDesc = (data.series_description || '').trim();
        const customSrc = data.custom_description_source || (customDesc ? 'settings' : '');
        if (customDesc && customSrc === 'settings') {
          setCollectionDescription(customDesc);
          setDescriptionSource('custom');
        } else if (seriesDesc) {
          setCollectionDescription(seriesDesc);
          setDescriptionSource('series');
        } else if (customDesc) {
          setCollectionDescription(customDesc);
          setDescriptionSource('fallback');
        } else {
          setCollectionDescription('');
          setDescriptionSource('auto');
        }
        
        // Store credit_back_rate from collection API
        if (data.credit_back_rate !== undefined) {
          setCreditBackRate(data.credit_back_rate);
        }
        // Store trade_discount from collection API
        if (data.trade_discount !== undefined) {
          setProductTradeDiscount(data.trade_discount);
        }
        
        // Auto-select product options
        if (fetchedProducts.length > 0) {
          // If redirected from /tiles/:slug, find and select THAT specific product
          let targetProduct = null;
          if (productSlugParam) {
            targetProduct = fetchedProducts.find(p => p.slug === productSlugParam);
          }
          // Direct product link: ?sku=P14790 (admin previews, quotes, WhatsApp links)
          if (!targetProduct && skuParam) {
            const want = skuParam.trim().toLowerCase();
            targetProduct = fetchedProducts.find(p => [p.sku, p.supplier_code, p.id].some(v => v && String(v).toLowerCase() === want));
          }
          
          // Otherwise find the cheapest product
          if (!targetProduct) {
            targetProduct = fetchedProducts.reduce((min, current) => {
              const currentPrice = current.room_lot_price || current.price || Infinity;
              const minPrice = min?.room_lot_price || min?.price || Infinity;
              return currentPrice < minPrice ? current : min;
            }, fetchedProducts[0]);
          }
          
          if (targetProduct) {
            // Pin the selected product immediately so the PDP never renders the
            // previous collection's title/specs while the option state settles.
            setSelectedProduct({ ...targetProduct, _isPreview: false });

            // Get the color (from field or extracted from name) — normalize to lowercase
            const rawColor = targetProduct.color || targetProduct.attributes?.color || extractColorFromName(targetProduct.display_name || targetProduct.name);
            setSelectedColor(rawColor && rawColor.trim() ? rawColor.trim().toLowerCase() : null);
            
            // Get the finish
            const productFinish = targetProduct.finish || targetProduct.attributes?.finish;
            setSelectedFinish(productFinish || null);
            
            // Get the size
            const productSize = targetProduct.size || targetProduct.attributes?.size;
            setSelectedSize(productSize || null);
            setSelectedStyle(null);
            setSelectedMaterialProduct(null);
          }
        }
      } catch (e) {
        if (cancelled) return;
        console.error('Error loading collection:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchProducts();
    return () => { cancelled = true; };
  }, [decodedSeriesName, productSlugParam, isAdminPreview]);

  // Fetch related products/collections
  useEffect(() => {
    const fetchRelatedProducts = async () => {
      try {
        const res = await fetch(`${API_URL}/api/tiles/related/${encodeURIComponent(decodedSeriesName)}?limit=8`);
        if (res.ok) {
          const data = await res.json();
          setRelatedProducts(data.related_series || []);
          setPinnedYouMayNeed(data.pinned_you_may_need || []);
        }
      } catch (e) {
        console.error('Error fetching related products:', e);
      }
    };
    
    if (decodedSeriesName) {
      fetchRelatedProducts();
    }
  }, [decodedSeriesName]);

  // Fetch product documents (PDF datasheets) when selected product changes
  useEffect(() => {
    const fetchDocuments = async () => {
      if (!selectedProduct) {
        setProductDocuments([]);
        return;
      }
      const supplier = selectedProduct.supplier_name || selectedProduct.supplier;
      const sku = selectedProduct.supplier_code || selectedProduct.sku || selectedProduct.display_code;
      if (!supplier || !sku) {
        setProductDocuments([]);
        return;
      }
      try {
        const res = await fetch(`${API_URL}/api/product-documents/by-product/${encodeURIComponent(supplier)}/${encodeURIComponent(sku)}`);
        if (res.ok) {
          const data = await res.json();
          setProductDocuments(data || []);
        }
      } catch (e) {
        // Silently fail — documents are optional
        setProductDocuments([]);
      }
    };
    fetchDocuments();
  }, [selectedProduct?.supplier_code, selectedProduct?.sku, selectedProduct?.display_code, selectedProduct?.supplier_name, selectedProduct?.supplier]);

  // Check if products have color data (from field OR extractable from name)
  const hasColors = useMemo(() => {
    return products.some(p => {
      const color = getProductColor(p);
      return color && color.trim() !== '';
    });
  }, [products]);

  // Check if products have finishes (show selector even with 1 finish, consistent with color/size)
  const hasFinishes = useMemo(() => {
    return products.some(p => getProductFinishes(p).length > 0);
  }, [products]);
  const hasMultipleFinishes = useMemo(() => {
    const finishes = products.flatMap(p => getProductFinishes(p)).map(f => f.toLowerCase());
    return new Set(finishes).size > 1;
  }, [products]);

  // Detect "style" variants: products sharing the same colour+finish+size but with different names
  // e.g. "Linear Decor" vs "Stripe Decor" — need a Pattern/Style selector
  const [selectedStyle, setSelectedStyle] = useState(null);
  
  // Extract style label from a product name by removing series, colour, finish, size
  const getStyleLabel = useCallback((product) => {
    const name = (product?.display_name || product?.product_name || product?.name || '').trim();
    const seriesName = (product?.series || product?.original_series || '').trim();
    const color = (getProductColor(product) || '').trim();
    const finish = (product?.finish || product?.attributes?.finish || '').trim();

    // Unit products (cleaners, adhesives — size like "1L"/"20kg", not "60x60",
    // or materials/tools groups): each product is a distinct item, so the Type
    // chip shows the name EXACTLY as saved in Supplier Products — no stripping.
    const sizeVal = (product?.size || product?.attributes?.size || '').trim();
    const groupVal = String(product?.product_group || product?.main_category || '').toLowerCase();
    const dimensional = /\d+\s*x\s*\d+/i.test(sizeVal);
    if (!dimensional && (sizeVal || ['materials', 'tools', 'accessories'].includes(groupVal))) return name;

    let remaining = name;
    // Remove series prefix
    if (seriesName) {
      remaining = remaining.replace(new RegExp('^' + seriesName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i'), '');
    }
    // Remove colour (handle multi-word colours like "Dark Grey", "Light Grey", "Navy Blue")
    if (color) {
      remaining = remaining.replace(new RegExp(color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
    } else {
      // No saved colour → the variant selector uses the FIRST WORD of the name as the swatch label.
      // Strip it here so the first word (variant name) doesn't leak into the Pattern selector.
      remaining = remaining.replace(/^\s*\S+\s+/, '');
    }
    // Remove 3-dim sizes first (e.g. "90x300x14/3mm", "80x300x10/3mm") — must run before the 2-dim rule
    remaining = remaining.replace(/\b\d+\s*[xX]\s*\d+\s*[xX]\s*[\d./]+\s*(?:cm|mm)?\b/gi, '');
    // Remove 2-dim sizes (e.g. "60x60", "600x600mm")
    remaining = remaining.replace(/\b\d+\s*[xX]\s*\d+(?:\.\d+)?\s*(?:cm|mm)?\b/gi, '');
    // Remove saved finish
    if (finish) {
      remaining = remaining.replace(new RegExp(finish.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
    }
    // Remove ALL common finish words (catches finishes embedded in name but not saved as the finish field)
    const finishWords = ['matt','matte','gloss','glossy','polished','satin','rustic','textured','honed',
      'lappato','brushed','natural','smooth','structured','embossed','decor','bocciardato',
      'bush-hammered','tumbled','flamed','sandblasted','grip','outdoor','r10','r11','r9',
      'uv','oil','oiled','lacquered','limed','white'];
    finishWords.forEach(fw => {
      remaining = remaining.replace(new RegExp('\\b' + fw + '\\b', 'gi'), '');
    });
    // Remove common material/type noise words so only genuine pattern names remain
    const materialWords = ['oak','wood','engineered','porcelain','ceramic','marble','stone','glass','spc','lvt','vinyl'];
    materialWords.forEach(mw => {
      remaining = remaining.replace(new RegExp('\\b' + mw + '\\b', 'gi'), '');
    });
    remaining = remaining.replace(/[\s/]+/g, ' ').trim();
    return remaining || 'Plain';
  }, []);
  
  const styleOptions = useMemo(() => {
    // Only consider products matching the current colour + finish + size selection
    let filtered = [...products];
    if (selectedColor) {
      filtered = filtered.filter(p => matchesSelectedVariant(p, selectedColor));
    }
    if (selectedFinish) {
      filtered = filtered.filter(p => productHasFinish(p, selectedFinish));
    }
    if (selectedSize) {
      const normSize = (selectedSize || '').toLowerCase().replace(/\s+/g, '').replace(/cm$/i, '');
      filtered = filtered.filter(p => {
        const pSize = (p.size || p.attributes?.size || '').toLowerCase().replace(/\s+/g, '').replace(/cm$/i, '');
        return pSize === normSize;
      });
    }
    
    // Only show pattern selector if there are DUPLICATE products after colour+finish+size filtering
    // (i.e., multiple products that are otherwise indistinguishable)
    if (filtered.length <= 1) return [];
    
    // Extract styles from the filtered set
    const styles = new Map();
    filtered.forEach(p => {
      const label = getStyleLabel(p);
      const key = label.toLowerCase();
      if (!styles.has(key)) {
        styles.set(key, label);
      }
    });
    
    return styles.size > 1 ? [...styles.values()].sort() : [];
  }, [products, selectedColor, selectedFinish, selectedSize, matchesSelectedVariant, getStyleLabel]);
  
  // Helper to match product against selected style
  const matchesStyle = useCallback((product, style) => {
    if (!style) return true;
    const label = getStyleLabel(product);
    return label.toLowerCase() === style.toLowerCase();
  }, [getStyleLabel]);

  // Product Display Classification (see business_rules.py for full docs):
  // "Surface Products" have a dimensional size (e.g. 60x60cm) → show Tile Calculator, Specs, etc.
  // "Unit Products" have no dimensional size (e.g. 1L, 3kg) → hide tile-specific features
  const isSurfaceProduct = useMemo(() => {
    if (products.length === 0) return true; // default to showing all features
    const dimensionalPattern = /\d+\s*x\s*\d+/i;
    return products.some(p => {
      const size = p.size || (p.attributes && p.attributes.size) || '';
      return dimensionalPattern.test(size);
    });
  }, [products]);

  // Admin pricing-unit override: a product saved as "Per Unit" in the Manager is
  // priced and sold each — even when it has a tile size (e.g. 30x30 decor mosaics).
  const sellsPerM2 = isSurfaceProduct && selectedProduct?.pricing_unit !== 'unit';
  const priceUnit = sellsPerM2 ? 'm²' : ' each';

  // Detect material-type collections where products are distinct items (not color/size variants)
  // These use the "Category - Product Name" naming pattern
  const materialProductOptions = useMemo(() => {
    if (products.length <= 1 || isSurfaceProduct) return [];
    // Check if products use the " - " naming convention (materials/tools/accessories)
    const withSeparator = products.filter(p => safeIncludes(p?.display_name || p?.name, ' - '));
    if (withSeparator.length < 2) return [];
    // Extract unique product labels (the part after " - ")
    return products.map((p, idx) => {
      const name = safeStr(p?.display_name || p?.name);
      const label = safeIncludes(name, ' - ')
        ? safeSplit(name, ' - ').slice(1).join(' - ').trim()
        : name;
      return { label, index: idx, product: p };
    });
  }, [products, isSurfaceProduct]);

  const isMaterialCollection = materialProductOptions.length >= 2;

  // Product-group aware label for the Style/Pattern selector.
  // Tiles get "Pattern" (existing behaviour); materials/flooring/etc. get a label that
  // makes sense for that category so the PDP stops calling adhesive bags a "Pattern".
  const styleSelectorLabel = useMemo(() => {
    const group = String(products[0]?.product_group || 'tiles').toLowerCase();
    const mainCat = String(products[0]?.main_category || '').toLowerCase();
    if (group === 'materials' || mainCat === 'materials' || isMaterialCollection) return 'Type';
    if (group === 'flooring' || mainCat === 'flooring') return 'Finish';
    if (group === 'bathroom' || mainCat === 'bathroom') return 'Model';
    if (group === 'underfloor_heating' || mainCat.includes('underfloor')) return 'Kit Size';
    if (group === 'tools' || mainCat === 'tools') return 'Model';
    return 'Pattern';
  }, [products, isMaterialCollection]);

  // Auto-select first material product when collection loads (or the ?sku= one)
  useEffect(() => {
    if (isMaterialCollection && !selectedMaterialProduct && products.length > 0) {
      const want = (skuParam || '').trim().toLowerCase();
      const idx = want ? products.findIndex(p => [p.sku, p.supplier_code, p.id].some(v => v && String(v).toLowerCase() === want)) : -1;
      const start = idx >= 0 ? idx : 0;
      setSelectedMaterialProduct(start);
      setSelectedProduct({ ...products[start], _isPreview: false });
    }
  }, [isMaterialCollection, products]);

  // Update selectedProduct when material product selection changes
  useEffect(() => {
    if (isMaterialCollection && selectedMaterialProduct !== null && products[selectedMaterialProduct]) {
      setSelectedProduct({ ...products[selectedMaterialProduct], _isPreview: false });
      setMainImageIndex(0);
    }
  }, [selectedMaterialProduct, isMaterialCollection, products]);

  // Normalize size for comparison (handles "30x60" vs "30x60cm" etc)
  const normalizeSize = useCallback((s) => (s || '').toLowerCase().replace(/\s+/g, '').replace(/cm$/i, ''), []);

  // Find the cheapest product based on current selections
  // This updates dynamically as customer makes color/size/finish selections
  const cheapestProduct = useMemo(() => {
    let filtered = [...products];
    
    // Filter by color if selected (also matches name-based variants)
    if (selectedColor) {
      filtered = filtered.filter(p => matchesSelectedVariant(p, selectedColor));
    }
    
    // Filter by finish if selected
    if (hasMultipleFinishes && selectedFinish) {
      filtered = filtered.filter(p => productHasFinish(p, selectedFinish));
    }
    
    // Filter by style if selected (e.g. "Linear Decor" vs "Stripe Decor")
    if (selectedStyle && styleOptions.length > 0) {
      filtered = filtered.filter(p => matchesStyle(p, selectedStyle));
    }
    
    // Filter by size if selected
    if (selectedSize) {
      const normalizedSelected = normalizeSize(selectedSize);
      filtered = filtered.filter(p => {
        const size = p.size || (p.attributes && p.attributes.size);
        return normalizeSize(size) === normalizedSelected;
      });
    }
    
    // If no products match, use all products
    if (filtered.length === 0) {
      filtered = products;
    }
    
    // Find the cheapest product by room_lot_price or price
    return filtered.reduce((cheapest, current) => {
      const currentPrice = current.room_lot_price || current.price || Infinity;
      const cheapestPrice = cheapest?.room_lot_price || cheapest?.price || Infinity;
      return currentPrice < cheapestPrice ? current : cheapest;
    }, filtered[0] || null);
  }, [products, selectedColor, selectedFinish, selectedSize, hasColors, hasMultipleFinishes]);

  // Fetch tier pricing based on cheapest product in current selection
  // This ensures we always show relevant tier pricing that updates with selections
  // Track which specific product (by id) the current tier pricing belongs to
  useEffect(() => {
    const productToUse = selectedProduct?._isPreview === false ? selectedProduct : cheapestProduct;
    const productId = productToUse?.id || productToUse?.slug || productToUse?.sku;
    
    if (productToUse?.slug || productToUse?.sku) {
      // If tier pricing is explicitly disabled on the product, skip the API call
      if (productToUse.tier_pricing_disabled) {
        setTierPricing(null);
        setTierPricingSlug(productId);
        return;
      }
      // Clear stale tier pricing immediately when the product changes
      if (tierPricingSlug !== productId) {
        setTierPricing(null);
      }
      const fetchTierPricing = async () => {
        try {
          // Use query-param endpoint to avoid production path routing issues
          const productPrice = productToUse.room_lot_price || productToUse.price || 0;
          const productSku = productToUse.sku || productToUse.supplier_code || '';
          const params = new URLSearchParams({
            base_price: productPrice,
            ...(productSku && { product_sku: productSku }),
            ...(isTrade && { is_trade: 'true' })
          });
          const tierUrl = `${API_URL}/api/tiles/pricing/calculate?${params.toString()}`;
          const res = await fetch(tierUrl);
          if (res.ok) {
            const data = await res.json();
            // Check if disabled or has tiers
            if (!data.disabled && data.tiers && data.tiers.length > 0) {
              // Use trade_tiers if available (trade user), otherwise regular tiers
              const tiersToUse = (isTrade && data.trade_tiers) ? data.trade_tiers : data.tiers;
              setTierPricing(tiersToUse);
              setTierPricingSlug(productId);
              if (data.credit_back_rate !== undefined) setCreditBackRate(data.credit_back_rate);
              if (data.trade_discount !== undefined) setProductTradeDiscount(data.trade_discount);
            } else {
              setTierPricing(null);
              setTierPricingSlug(productId);
            }
          }
        } catch (e) {
          console.error('Error fetching tier pricing:', e);
          setTierPricing(null);
          setTierPricingSlug(productId);
        }
      };
      fetchTierPricing();
    } else {
      setTierPricing(null);
      setTierPricingSlug(null);
    }
  }, [selectedProduct?.id, selectedProduct?.slug, selectedProduct?.sku, selectedProduct?._isPreview, cheapestProduct?.id, cheapestProduct?.slug, cheapestProduct?.sku, isTrade]);

  // Frequently Bought Together — real co-purchase recommendations.
  // Falls back server-side to similar tiles when the product hasn't sold yet.
  useEffect(() => {
    const pid = selectedProduct?.id || cheapestProduct?.id;
    if (!pid || selectedProduct?._isPreview) {
      setFbtItems([]);
      setFbtSelected(new Set());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/api/recommendations/frequently-bought-together/${pid}?limit=3`);
        if (!res.ok) throw new Error('rec fetch failed');
        const data = await res.json();
        if (cancelled) return;
        const items = Array.isArray(data) ? data.filter(t => t && t.id) : [];
        setFbtItems(items);
        // Default: pre-select all so the bundle total reflects the full suggested cart.
        setFbtSelected(new Set(items.map(t => t.id)));
      } catch (e) {
        if (!cancelled) {
          setFbtItems([]);
          setFbtSelected(new Set());
        }
      }
    })();
    return () => { cancelled = true; };
  }, [selectedProduct?.id, selectedProduct?._isPreview, cheapestProduct?.id]);

  // Format color/variant name: "dark-grey" -> "Dark Grey", "brilliant-white" -> "Brilliant White"
  const formatColorName = (name) => {
    if (!name) return '';
    return name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  };

  // Get unique colors with images - OR name-based variants if NO products have colours
  const colorOptions = useMemo(() => {
    if (!hasColors && !hasFinishes) return [];
    const variantMap = new Map();
    
    // First pass: check if ANY products have saved colours
    const anyHaveSavedColor = products.some(p => {
      const color = getProductColor(p);
      return color && color.trim();
    });
    
    if (anyHaveSavedColor) {
      // Colour mode: ONLY show saved colours, skip products without colour
      products.forEach(p => {
        const color = getProductColor(p);
        if (color && color.trim() && !variantMap.has(color)) {
          variantMap.set(color, {
            name: color,
            // firstImageUrl(p.images) may be either a string URL (legacy) or
            // {url, alt, alt_generated_at} (post-May-2026 SEO migration).
            // normaliseImageUrl returns a clean string URL or '' so React
            // never tries to render src={Object} (= [object Object] = 404).
            image: normaliseImageUrl(firstImageUrl(p.images)) || null,
            hex: getColorHex(color),
            variantType: 'color'
          });
        }
      });
    } else {
      // No saved colours at all: use first word of display name as variant
      products.forEach(p => {
        const displayName = (p.display_name || p.product_name || p.name || '').trim();
        const firstWord = displayName.split(/\s+/)[0] || '';
        if (firstWord && !variantMap.has(firstWord.toLowerCase())) {
          variantMap.set(firstWord.toLowerCase(), {
            name: firstWord.toLowerCase(),
            image: normaliseImageUrl(firstImageUrl(p.images)) || null,
            hex: '#CCCCCC',
            variantType: 'name'
          });
        }
      });
    }
    
    return Array.from(variantMap.values());
  }, [products, hasColors, hasFinishes]);

  // Get unique finishes
  const finishOptions = useMemo(() => {
    if (!hasFinishes) return [];
    const seen = new Map();
    products.flatMap(p => getProductFinishes(p)).forEach(f => {
      const k = f.toLowerCase();
      if (!seen.has(k)) seen.set(k, f);
    });
    return [...seen.values()].sort();
  }, [products, hasFinishes]);

  // Get which colors are available for the currently selected finish
  const availableColorsForFinish = useMemo(() => {
    if (!selectedFinish || !hasMultipleFinishes) return null; // null = all available
    const variants = new Set();
    products.forEach(p => {
      if (productHasFinish(p, selectedFinish)) {
        const color = getProductColor(p);
        if (color) {
          variants.add(color);
        } else {
          // Name-based variant: use first word of display name
          const displayName = (p.display_name || p.product_name || p.name || '').trim();
          const firstWord = displayName.split(/\s+/)[0] || '';
          if (firstWord) variants.add(firstWord.toLowerCase());
        }
      }
    });
    return variants;
  }, [products, selectedFinish, hasMultipleFinishes]);

  // Get which finishes are available for the currently selected color
  const availableFinishesForColor = useMemo(() => {
    if (!selectedColor || !hasMultipleFinishes) return null;
    const finishes = new Set();
    products.forEach(p => {
      if (matchesSelectedVariant(p, selectedColor)) {
        getProductFinishes(p).forEach(f => finishes.add(f));
      }
    });
    return finishes;
  }, [products, selectedColor, hasMultipleFinishes, matchesSelectedVariant]);

  // Get all sizes — indoor first sorted by area (width × height), outdoor at the end
  // Row label for the variant selector: admin override → auto-detect from the
  // variant names (all colours → "Colour", none → "Design", mixed → "Colour / Design")
  const variantRowLabel = useMemo(() => {
    if (variantLabelOverride) return variantLabelOverride;
    if (colorOptions.length === 0) return 'Colour';
    if (!colorOptions.some(c => c.variantType === 'color')) return 'Variant';
    const colourish = colorOptions.filter(o => isRealColour(o.name)).length;
    if (colourish === colorOptions.length) return 'Colour';
    if (colourish === 0) return 'Design';
    return 'Colour / Design';
  }, [colorOptions, variantLabelOverride]);

  const allSizes = useMemo(() => {
    const sizes = products.map(p => p.size || (p.attributes && p.attributes.size) || '').filter(Boolean);
    const parseDims = (s) => {
      const nums = s.match(/\d+/g);
      return nums ? nums.map(Number) : [0];
    };
    return [...new Set(sizes)].sort((a, b) => {
      const aOutdoor = (a.match(/x/gi) || []).length >= 2;
      const bOutdoor = (b.match(/x/gi) || []).length >= 2;
      if (aOutdoor !== bOutdoor) return aOutdoor ? 1 : -1;
      const aDims = parseDims(a);
      const bDims = parseDims(b);
      const aArea = (aDims[0] || 0) * (aDims[1] || aDims[0] || 0);
      const bArea = (bDims[0] || 0) * (bDims[1] || bDims[0] || 0);
      return aArea - bArea;
    });
  }, [products]);

  // Get available sizes for selected color and finish
  const availableSizes = useMemo(() => {
    let filtered = [...products];
    
    if (selectedColor) {
      filtered = filtered.filter(p => matchesSelectedVariant(p, selectedColor));
    }
    if (hasMultipleFinishes && selectedFinish) {
      filtered = filtered.filter(p => productHasFinish(p, selectedFinish));
    }
    
    const sizes = filtered.map(p => p.size || (p.attributes && p.attributes.size) || '').filter(Boolean);
    const parseDims = (s) => {
      const nums = s.match(/\d+/g);
      return nums ? nums.map(Number) : [0];
    };
    return [...new Set(sizes)].sort((a, b) => {
      const aOutdoor = (a.match(/x/gi) || []).length >= 2;
      const bOutdoor = (b.match(/x/gi) || []).length >= 2;
      if (aOutdoor !== bOutdoor) return aOutdoor ? 1 : -1;
      const aDims = parseDims(a);
      const bDims = parseDims(b);
      const aArea = (aDims[0] || 0) * (aDims[1] || aDims[0] || 0);
      const bArea = (bDims[0] || 0) * (bDims[1] || bDims[0] || 0);
      return aArea - bArea;
    });
  }, [products, selectedColor, selectedFinish, hasColors, hasMultipleFinishes]);

  // Get ALL sizes available for selected color (ignoring finish) — used for enable/disable logic
  const sizesForColor = useMemo(() => {
    if (!selectedColor) return null;
    let filtered = products.filter(p => matchesSelectedVariant(p, selectedColor));
    const sizes = filtered.map(p => p.size || (p.attributes && p.attributes.size) || '').filter(Boolean);
    return new Set(sizes);
  }, [products, selectedColor]);

  // Get ALL sizes across the entire collection, ignoring both color and finish.
  // Used as ultimate fallback when sizesForColor is null (no color variants,
  // or color matching is unreliable due to inconsistent data). Prevents sizes
  // from being falsely disabled when a valid product exists in another finish.
  const sizesIgnoringFinish = useMemo(() => {
    if (!hasMultipleFinishes) return null;
    const sizes = products.map(p => p.size || (p.attributes && p.attributes.size) || '').filter(Boolean);
    return new Set(sizes);
  }, [products, hasMultipleFinishes]);

  // Current volume discount percentage based on tier pricing and quantity
  // Used by getPriceForSize to show the actual price the customer pays on each size button
  const volumeDiscountPercent = useMemo(() => {
    if (!tierPricing || tierPricing.length === 0) return 0;
    // We can't call getEffectiveSqmQuantity here (not yet defined), so read quantity directly
    const qty = parseFloat(quantity) || 0;
    for (let i = tierPricing.length - 1; i >= 0; i--) {
      const tier = tierPricing[i];
      if (qty >= tier.min_qty) {
        return tier.discount_percent || 0;
      }
    }
    return 0;
  }, [tierPricing, quantity]);

  // Price lookup per size — returns the price the customer will actually pay
  // (base price adjusted by the current volume discount tier)
  const getPriceForSize = useCallback((size) => {
    let filtered = [...products];
    if (selectedColor) {
      filtered = filtered.filter(p => matchesSelectedVariant(p, selectedColor));
    }
    if (hasMultipleFinishes && selectedFinish) {
      filtered = filtered.filter(p => productHasFinish(p, selectedFinish));
    }
    if (selectedStyle && styleOptions.length > 0) {
      filtered = filtered.filter(p => matchesStyle(p, selectedStyle));
    }
    const normalizedTarget = normalizeSize(size);
    const match = filtered.find(p => normalizeSize(p.size || (p.attributes && p.attributes.size) || '') === normalizedTarget);
    if (!match) {
      // Try without finish constraint
      let fallback = [...products];
      if (selectedColor) fallback = fallback.filter(p => matchesSelectedVariant(p, selectedColor));
      const fb = fallback.find(p => normalizeSize(p.size || (p.attributes && p.attributes.size) || '') === normalizedTarget);
      if (!fb) return null;
      // The stored price IS the current selling price (backend bakes sales in).
      // NEVER recompute from was_price × discount_percentage — that % goes
      // stale when the admin later edits the price (20 Aug: £39 vs £42.99 bug).
      const base = fb.room_lot_price || fb.price || 0;
      const volumeDiscount = volumeDiscountPercent > 0 ? (1 - volumeDiscountPercent / 100) : 1;
      const adjusted = base * volumeDiscount;
      return isTrade ? Math.round((adjusted * (1 - getEffTradePct() / 100) / 1.20) * 100) / 100 : Math.round(adjusted * 100) / 100;
    }
    // Stored price IS the selling price — see comment in the fallback above.
    const base = match.room_lot_price || match.price || 0;
    const volumeDiscount = volumeDiscountPercent > 0 ? (1 - volumeDiscountPercent / 100) : 1;
    const adjusted = base * volumeDiscount;
    const tradeAdj = isTrade ? (1 - getEffTradePct() / 100) : 1;
    return isTrade ? Math.round((adjusted * tradeAdj / 1.20) * 100) / 100 : Math.round(adjusted * 100) / 100;
  }, [products, selectedColor, selectedFinish, hasColors, hasMultipleFinishes, normalizeSize, isTrade, productTradeDiscount, selectedProduct, tierPricing, volumeDiscountPercent]);

  // Variant behind a size button (same colour/finish/style filters as getPriceForSize)
  const getProductForSize = useCallback((size) => {
    const normalizedTarget = normalizeSize(size);
    const bySize = (p) => normalizeSize(p.size || (p.attributes && p.attributes.size) || '') === normalizedTarget;
    let filtered = [...products];
    if (selectedColor) filtered = filtered.filter(p => matchesSelectedVariant(p, selectedColor));
    if (hasMultipleFinishes && selectedFinish) filtered = filtered.filter(p => productHasFinish(p, selectedFinish));
    if (selectedStyle && styleOptions.length > 0) filtered = filtered.filter(p => matchesStyle(p, selectedStyle));
    return filtered.find(bySize)
      || products.filter(p => !selectedColor || matchesSelectedVariant(p, selectedColor)).find(bySize)
      || null;
  }, [products, selectedColor, selectedFinish, hasMultipleFinishes, selectedStyle, styleOptions, normalizeSize]);

  // Clear size selection if it becomes unavailable (e.g., after changing color/finish)
  // Then re-select the cheapest available size
  useEffect(() => {
    if (selectedSize && availableSizes.length > 0 && !availableSizes.includes(selectedSize)) {
      // Find cheapest product among available options and select its size
      let filtered = [...products];
      if (selectedColor) {
        filtered = filtered.filter(p => matchesSelectedVariant(p, selectedColor));
      }
      if (hasMultipleFinishes && selectedFinish) {
        filtered = filtered.filter(p => productHasFinish(p, selectedFinish));
      }
      const cheapest = filtered.reduce((min, curr) => {
        const currPrice = curr.room_lot_price || curr.price || Infinity;
        const minPrice = min?.room_lot_price || min?.price || Infinity;
        return currPrice < minPrice ? curr : min;
      }, filtered[0]);
      const newSize = cheapest?.size || cheapest?.attributes?.size || availableSizes[0];
      setSelectedSize(newSize || null);
    }
  }, [availableSizes, selectedSize, products, selectedColor, selectedFinish, hasColors, hasMultipleFinishes]);

  // Auto-switch color when finish changes and current color isn't available for new finish
  // SKIP if user explicitly clicked a color (let the finish auto-switch handle it instead)
  useEffect(() => {
    if (userClickedRef.current === 'color') {
      userClickedRef.current = null;
      return;
    }
    if (selectedColor && availableColorsForFinish !== null && !availableColorsForFinish.has(selectedColor)) {
      const firstAvailable = availableColorsForFinish.size > 0 ? [...availableColorsForFinish][0] : null;
      setSelectedColor(firstAvailable);
    }
  }, [availableColorsForFinish, selectedColor]);

  // Auto-switch finish when color changes and current finish isn't available for new color
  // SKIP if user explicitly clicked a finish (let the color auto-switch handle it instead)
  useEffect(() => {
    if (userClickedRef.current === 'finish') {
      userClickedRef.current = null;
      return;
    }
    if (selectedFinish && availableFinishesForColor !== null && !availableFinishesForColor.has(selectedFinish)) {
      const firstAvailable = availableFinishesForColor.size > 0 ? [...availableFinishesForColor][0] : null;
      setSelectedFinish(firstAvailable);
    }
  }, [availableFinishesForColor, selectedFinish]);

  // Find selected product based on color, finish, and size
  useEffect(() => {
    if (products.length === 0) return;
    
    // Check if there are any variant options at all
    const hasAnyVariants = hasColors || hasMultipleFinishes || (products.length > 1 && products.some(p => {
      const size = p.size || (p.attributes && p.attributes.size);
      return size && size.trim();
    }));
    
    // If no variant options exist (single product or all same), select it directly
    if (!hasAnyVariants) {
      setSelectedProduct({ ...products[0], _isPreview: false });
      return;
    }
    
    // If no selections made yet, show preview
    if (!selectedColor && !selectedFinish && !selectedSize) {
      setSelectedProduct({ ...products[0], _isPreview: true });
      return;
    }
    
    let filtered = [...products];
    
    if (selectedColor) {
      filtered = filtered.filter(p => matchesSelectedVariant(p, selectedColor));
    }
    if (hasMultipleFinishes && selectedFinish) {
      filtered = filtered.filter(p => productHasFinish(p, selectedFinish));
    }
    if (selectedStyle && styleOptions.length > 0) {
      filtered = filtered.filter(p => matchesStyle(p, selectedStyle));
    }
    if (selectedSize) {
      const normalizedSelected = normalizeSize(selectedSize);
      filtered = filtered.filter(p => {
        const size = p.size || (p.attributes && p.attributes.size);
        return normalizeSize(size) === normalizedSelected;
      });
    }
    
    let product = filtered[0] || null;
    // Stale size carried over from the previous colour? Retry without the
    // size filter and adopt the new product's size so the selection
    // converges instead of dead-ending on an empty match.
    if (!product && selectedSize) {
      let relaxed = [...products];
      if (selectedColor) relaxed = relaxed.filter(p => matchesSelectedVariant(p, selectedColor));
      if (hasMultipleFinishes && selectedFinish) relaxed = relaxed.filter(p => productHasFinish(p, selectedFinish));
      if (selectedStyle && styleOptions.length > 0) relaxed = relaxed.filter(p => matchesStyle(p, selectedStyle));
      product = relaxed[0] || null;
      if (product) {
        const newSize = product.size || (product.attributes && product.attributes.size) || null;
        setSelectedSize(newSize || null);
      }
    }
    if (product) {
      setSelectedProduct({ ...product, _isPreview: false });
      setMainImageIndex(0);
    }
    // No match at all (transient state while colour/finish auto-switch
    // effects settle): KEEP the previous product on screen. Clearing it
    // collapsed the whole page for a frame, which clamped the scroll
    // position and made variant switches feel like a full page reload.
  }, [selectedColor, selectedFinish, selectedStyle, selectedSize, products, hasColors, hasMultipleFinishes, styleOptions, matchesStyle]);

  // Helper functions
  function getColorHex(colorName) {
    const colorMap = {
      'white': '#FFFFFF', 'ivory': '#FFFFF0', 'cream': '#FFFDD0', 'beige': '#F5F5DC',
      'grey': '#808080', 'gray': '#808080', 'silver': '#C0C0C0', 'charcoal': '#36454F',
      'black': '#1a1a1a', 'anthracite': '#293133', 'dark': '#2d2d2d',
      'sand': '#C2B280', 'taupe': '#483C32', 'brown': '#8B4513', 'walnut': '#5D432C',
      'blue': '#4169E1', 'navy': '#000080', 'aqua': '#00FFFF', 'teal': '#008080',
      'green': '#228B22', 'sage': '#9DC183', 'olive': '#808000',
      'pink': '#FFC0CB', 'rose': '#FF007F', 'terracotta': '#E2725B',
      'gold': '#FFD700', 'copper': '#B87333', 'bronze': '#CD7F32',
      'natural': '#E8DCC4', 'stone': '#928E85', 'marble': '#F0EAE2',
      'onyx': '#353839', 'graphite': '#383838', 'pearl': '#F0EAD6',
      'crema': '#FFFDD0', 'bianco': '#FFFFFF', 'nero': '#1a1a1a'
    };
    const lower = colorName?.toLowerCase() || '';
    for (const [key, hex] of Object.entries(colorMap)) {
      if (lower.includes(key)) return hex;
    }
    return '#E5E5E5';
  }

  function getStockStatus(product) {
    if (!product) return { label: 'Unknown', color: 'text-gray-500', dotColor: 'bg-gray-400' };

    // 14 May 2026 — respect admin's manual override FIRST. Previously
    // the PDP ignored `stock_status`/`in_stock` and derived everything
    // from the numeric `stock` field, so admin marking a tile as
    // "Out of Stock" had no visible effect on the live site.
    const explicitStatus = (product.stock_status || '').toLowerCase();
    if (explicitStatus === 'out_of_stock') {
      return { label: 'Out of Stock', color: 'text-red-600', dotColor: 'bg-red-500' };
    }
    if (explicitStatus === 'low_stock') {
      return { label: 'Low Stock', color: 'text-amber-600', dotColor: 'bg-amber-500' };
    }
    if (explicitStatus === 'special_order') {
      return { label: 'Special Order', color: 'text-blue-600', dotColor: 'bg-blue-500' };
    }
    // Admin marked via Attribute Studio "Special Order" (2-3 week lead time)
    if (product.special_order === true) {
      return { label: 'Special Order', color: 'text-blue-600', dotColor: 'bg-blue-500' };
    }
    // Admin explicitly set "In Stock" — authoritative even when the numeric
    // stock count is 0 (unit products often have no stock feed).
    if (explicitStatus === 'in_stock') {
      return { label: 'In Stock', color: 'text-green-600', dotColor: 'bg-green-500' };
    }
    // Boolean override (set by admin alongside stock_status). Only
    // honoured when the admin explicitly set in_stock=false — a
    // boolean true here doesn't override the numeric stock check.
    if (product.in_stock === false) {
      return { label: 'Out of Stock', color: 'text-red-600', dotColor: 'bg-red-500' };
    }

    if (product.always_in_stock) {
      return { label: 'In Stock', color: 'text-green-600', dotColor: 'bg-green-500' };
    }

    const stock = product.stock || product.stock_quantity || product.stock_m2 || 0;
    if (stock <= 0) {
      return { label: 'Out of Stock', color: 'text-red-600', dotColor: 'bg-red-500' };
    }
    if (stock < 10) {
      return { label: 'Low Stock', color: 'text-amber-600', dotColor: 'bg-amber-500' };
    }
    return { label: 'In Stock', color: 'text-green-600', dotColor: 'bg-green-500' };
  }

  // Get sqm_per_box (the correct field name from backend)
  const getSqmPerBox = () => {
    if (!selectedProduct) return null;
    return selectedProduct.sqm_per_box || selectedProduct.box_m2_coverage || selectedProduct.coverage_per_box || null;
  };

  // Calculate effective m² quantity based on unit selection
  // When ordering by m², we round up to full boxes, so actual coverage may be higher
  const getEffectiveSqmQuantity = () => {
    if (!selectedProduct || !sellsPerM2) return quantity;
    const sqmPerBox = getSqmPerBox();
    if (quantityUnit === 'box' && sqmPerBox) {
      // Box mode: quantity is boxes, multiply by sqm per box
      return quantity * sqmPerBox;
    }
    if (quantityUnit === 'sqm' && sqmPerBox) {
      // m² mode: calculate boxes needed (round up), then get actual coverage
      const boxesRequired = Math.ceil(quantity / sqmPerBox);
      return boxesRequired * sqmPerBox;
    }
    return quantity;
  };

  // Check if product is on sale (using sale_active, was_price, OR sale labels)
  const regularSellingPrice = selectedProduct?.room_lot_price || selectedProduct?.price || 0;
  const hasSaleLabel = selectedProduct?.labels?.some(l => 
    ['sale', 'clearance', 'on sale'].includes(l?.toLowerCase?.())
  );
  const hasExplicitSale = selectedProduct?.sale_active &&
    selectedProduct?.was_price > 0 &&
    selectedProduct?.was_price > regularSellingPrice;
  const isOnSale = hasExplicitSale || hasSaleLabel;
  // Marked CLEARANCE → big flashing CLEARANCE branding everywhere SALE would show
  const isClearanceProduct = !!selectedProduct?.clearance
    || (selectedProduct?.labels || []).some(l => /clearance/i.test(String(l)));

  // The stored `price` IS the current (sale) selling price — the backend
  // updates it when a sale is applied. NEVER recompute from
  // was_price × discount_percentage: that % goes stale when the admin later
  // edits the list price (20 Aug bug: PDP showed £39.00 instead of £42.99).
  // was_price is display-only (the WAS strike-through / savings maths).
  const saleSellingPrice = regularSellingPrice;
  const currentSellingPrice = regularSellingPrice;

  // Get current price based on quantity (tier pricing) and sale
  const getCurrentPrice = () => {
    if (!selectedProduct) return 0;
    
    // Half / Full pallet tier override — bypasses sale + tier pricing,
    // uses the tile's pallet-rate field directly. The £/m² rate stored
    // on the tile is the FINAL retail-inc-VAT price; trade discount +
    // ex-VAT conversion are applied at the final displayPrice step.
    if (pricingTier === 'full_pallet' && Number(selectedProduct.pallet_price) > 0) {
      return Number(selectedProduct.pallet_price);
    }
    if (pricingTier === 'half_pallet' && Number(selectedProduct.half_pallet_price) > 0) {
      return Number(selectedProduct.half_pallet_price);
    }
    
    // Use sale price as base when product is on sale (but never higher than regular)
    const regularBase = selectedProduct.room_lot_price || selectedProduct.price || 0;
    // Stored price IS the selling price (sale already baked in by the backend)
    const basePrice = regularBase;
    const effectiveQty = getEffectiveSqmQuantity();
    
    // Check tier pricing first
    if (tierPricing && tierPricing.length > 0) {
      // Detect if tiers belong to this product by comparing the base tier price
      // When sizes share a slug, the tier API returns prices for the cheapest size
      // For trade tiers, undo the trade discount before comparing
      const tierBasePrice = tierPricing[0]?.price_per_m2 || tierPricing[0]?.price || 0;
      const effectiveTierBase = (isTrade && getEffTradePct() > 0)
        ? tierBasePrice / (1 - getEffTradePct() / 100)
        : tierBasePrice;
      // Use relative comparison (within 2%) to handle rounding differences
      const tiersMatchProduct = basePrice > 0 && Math.abs(effectiveTierBase - basePrice) / basePrice < 0.02;
      
      for (let i = tierPricing.length - 1; i >= 0; i--) {
        const tier = tierPricing[i];
        if (effectiveQty >= tier.min_qty) {
          if (tiersMatchProduct) {
            // Tiers are for this product — use absolute prices
            return tier.price_per_m2 || tier.price || basePrice;
          } else {
            // Tiers are from a different product (shared slug) — apply discount % to this product's price
            const discountPercent = tier.total_discount_percent || tier.discount_percent || 0;
            let price = basePrice;
            if (discountPercent > 0) {
              // Apply volume discount portion only (total_discount includes trade, discount_percent is volume-only)
              const volumeDiscount = tier.discount_percent || 0;
              price = basePrice * (1 - volumeDiscount / 100);
            }
            // For trade users, apply trade discount on top of volume discount
            if (isTrade && getEffTradePct() > 0) {
              price = price * (1 - getEffTradePct() / 100);
            }
            return Math.round(price * 100) / 100;
          }
        }
      }
    }
    
    return basePrice;
  };

  // Get current tier discount percentage based on quantity (volume-only discount)
  const getCurrentTierDiscount = () => {
    // Pallet tier overrides volume-tier pricing — pallet rate is the final rate.
    if (pricingTier !== 'm2') return 0;
    if (!tierPricing || tierPricing.length === 0) return 0;
    
    const effectiveQty = getEffectiveSqmQuantity();
    
    for (let i = tierPricing.length - 1; i >= 0; i--) {
      const tier = tierPricing[i];
      if (effectiveQty >= tier.min_qty) {
        return tier.discount_percent || 0;
      }
    }
    
    return 0;
  };

  // Get the total combined discount from the active tier (trade + volume, matches tier table savings_label)
  const getCurrentTierTotalDiscount = () => {
    if (pricingTier !== 'm2') return 0;
    if (!tierPricing || tierPricing.length === 0) return 0;
    
    const effectiveQty = getEffectiveSqmQuantity();
    
    for (let i = tierPricing.length - 1; i >= 0; i--) {
      const tier = tierPricing[i];
      if (effectiveQty >= tier.min_qty) {
        return tier.total_discount_percent || tier.discount_percent || 0;
      }
    }
    
    return 0;
  };

  // Get original price (was_price for explicit sale, or base price for label-based sales)
  const getOriginalPrice = () => {
    if (!selectedProduct) return 0;
    if (hasExplicitSale && selectedProduct.was_price) {
      return selectedProduct.was_price;
    }
    return selectedProduct.room_lot_price || selectedProduct.price || 0;
  };

  // Calculate total price
  const currentPrice = getCurrentPrice();

  // Half + Full Pallet info derived from the selected product's tile fields
  // (see backend/routes/tiles.py serialize_tile_for_shop for shape).
  // - fullPalletAvailable / halfPalletAvailable gate which chips render
  // - minM2 is the m² floor when that tier is selected
  // - rate is the £/m² for the tier (retail-inc-VAT — same convention
  //   as room_lot_price; trade discount + ex-VAT applied at displayPrice)
  // - savingsVsM2 is the £ difference between buying the same m² at the
  //   per-m² rate vs the pallet rate. Powers the "Save £X" pop badge
  //   on each chip (16 May 2026 conversion experiment: visualising the
  //   discount typically lifts pallet conversion 8-15% on tile retailers).
  const palletInfo = (() => {
    const sp = selectedProduct || {};
    const fullRate = Number(sp.pallet_price) || 0;
    const halfRate = Number(sp.half_pallet_price) || 0;
    const fullM2 = Number(sp.m2_per_pallet) || 0;
    let halfM2 = Number(sp.m2_per_half_pallet) || 0;
    if (!halfM2 && fullM2 > 0) halfM2 = Math.round((fullM2 / 2) * 100) / 100;
    // Per-m² baseline rate — same source the "Per m²" chip displays, so
    // the savings figure honestly matches what the customer sees on the
    // alternative button. Falls back to legacy `price` if `room_lot_price`
    // is unset (older imports).
    const m2Rate = Number(sp.room_lot_price) || Number(sp.price) || 0;
    const halfSavings = halfRate > 0 && halfM2 > 0 && m2Rate > halfRate
      ? Math.round((m2Rate - halfRate) * halfM2 * 100) / 100
      : 0;
    const fullSavings = fullRate > 0 && fullM2 > 0 && m2Rate > fullRate
      ? Math.round((m2Rate - fullRate) * fullM2 * 100) / 100
      : 0;
    // Unit-priced products (adhesives, tools sold per bag/each) count pallet
    // quantities in units rather than m² — labels follow suit.
    const isUnit = sp.pallet_qty_unit === 'unit' || sp.pricing_unit === 'unit' || !isSurfaceProduct;
    return {
      fullPalletAvailable: fullRate > 0 && fullM2 > 0,
      halfPalletAvailable: halfRate > 0 && halfM2 > 0,
      fullRate,
      halfRate,
      fullM2,
      halfM2,
      m2Rate,
      halfSavings,
      fullSavings,
      isUnit,
      rateSuffix: isUnit ? '/unit' : 'm²',
      qtyWord: isUnit ? 'units' : 'm²',
    };
  })();

  // Snap basket qty to the pallet-tier minimum whenever tier changes.
  // Per spec: clicking a tier ALWAYS sets qty to that tier's minimum so
  // the customer sees the exact pallet quantity (no "min 16 m² but qty
  // shows 32 m²" confusion). Customer can still bump qty UP via the +/−
  // steppers, but never below the minimum.
  // Switching BACK to per-unit/m² resets qty to 1 so the pallet quantity
  // (e.g. 27) doesn't linger at the per-unit price.
  // Pallet-only products (admin flag): no per-m²/per-unit buying — Half / Full pallet only
  const palletOnly = !!selectedProduct?.pallet_only && (palletInfo.fullPalletAvailable || palletInfo.halfPalletAvailable);
  useEffect(() => {
    if (palletOnly && pricingTier === 'm2') {
      setPricingTier(palletInfo.fullPalletAvailable ? 'full_pallet' : 'half_pallet');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [palletOnly, pricingTier, selectedProduct?.sku]);

  const prevPricingTierRef = useRef('m2');
  useEffect(() => {
    if (pricingTier === 'full_pallet' && palletInfo.fullM2 > 0) {
      if (sellsPerM2) setQuantityUnit('sqm');
      setQuantity(palletInfo.fullM2);
    } else if (pricingTier === 'half_pallet' && palletInfo.halfM2 > 0) {
      if (sellsPerM2) setQuantityUnit('sqm');
      setQuantity(palletInfo.halfM2);
    } else if (pricingTier === 'm2' && prevPricingTierRef.current !== 'm2') {
      setQuantity(1);
    }
    prevPricingTierRef.current = pricingTier;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pricingTier, palletInfo.fullM2, palletInfo.halfM2]);

  // When tier pricing is active, trade discount is already baked into trade_tiers prices.
  // When tier pricing is disabled/null, we must apply trade discount manually.
  const tradeDiscountFactor = (isTrade && getEffTradePct() > 0 && (!tierPricing || tierPricing.length === 0))
    ? (1 - getEffTradePct() / 100) : 1;
  // For trade users: apply trade discount (if not in tiers) then remove VAT
  const displayPrice = isTrade
    ? Math.round((currentPrice * tradeDiscountFactor / 1.20) * 100) / 100
    : currentPrice;
  const originalPrice = getOriginalPrice();
  const displayOriginalPrice = isTrade ? Math.round((originalPrice / 1.20) * 100) / 100 : originalPrice;
  const currentTierDiscount = getCurrentTierDiscount();
  const effectiveSqm = getEffectiveSqmQuantity();
  const totalPrice = (displayPrice * effectiveSqm).toFixed(2);
  const originalTotalPrice = isOnSale ? (displayOriginalPrice * effectiveSqm).toFixed(2) : null;

  // Calculate TOTAL combined discount (sale + tier)
  // For sale items: compute total % off from was_price to current tier price
  // For non-sale items: use the tier's total_discount_percent (matches tier table savings_label)
  // === SINGLE SOURCE OF TRUTH for all discount breakdowns ===
  // Computed once, used by: ribbon, bottom badge, trade badge.
  //
  // EFFECTIVE-RATE labels (Approach 1):
  // We label each discount tier by the % it actually saved off RRP, so the
  // numbers always add up. Math under the hood stays compound (margin-safe).
  //
  // Example — sale 20% + volume 10% + trade 5% on £100:
  //   £100 -> -£20 (sale)   -> £80   -> sale label  = 20% off
  //   £80  -> -£8  (volume) -> £72   -> volume label =  8% off  (£8/£100)
  //   £72  -> -£3.60(trade) -> £68.40-> trade label  =  4% off  (£3.60/£100)
  //   Sum = 32% = total compound % off RRP — and 20+8+4 = 32 ✓
  //
  // Customer-facing tooltip uses these same effective rates + £ saved per layer.
  // *Raw* rates (used internally / when displaying the trade badge in some
  // places) are still exposed as saleRate/volumeRate/tradeRate.
  const discountBreakdown = (() => {
    // Effective sale % from ACTUAL prices (was → current selling price), not
    // the stored discount_percentage which goes stale after price edits.
    const saleRate = (hasExplicitSale && selectedProduct?.was_price > 0 && currentSellingPrice < selectedProduct.was_price)
      ? Math.round(((selectedProduct.was_price - currentSellingPrice) / selectedProduct.was_price) * 1000) / 10
      : 0;
    const volumeRate = palletOnly ? 0 : (currentTierDiscount || 0);
    const tradeRate = getEffTradePct();

    const empty = {
      saleContrib: 0, volumeContrib: 0, tradeContrib: 0, total: 0,
      saleRate: 0, volumeRate: 0, tradeRate: 0,
      saleSaved: 0, volumeSaved: 0, tradeSaved: 0, totalSaved: 0,
      basePrice: 0,
    };

    // Fallback: explicit sale via was_price with no rates set
    if (hasExplicitSale && selectedProduct?.was_price && saleRate === 0 && tradeRate === 0 && volumeRate === 0) {
      const basePrice = selectedProduct.was_price;
      if (basePrice > 0 && currentPrice < basePrice) {
        const totalPct = Math.round(((basePrice - currentPrice) / basePrice) * 100);
        const totalSaved = Math.round((basePrice - currentPrice) * 100) / 100;
        return {
          ...empty,
          saleContrib: totalPct, total: totalPct,
          saleRate: totalPct,
          saleSaved: totalSaved, totalSaved,
          basePrice,
        };
      }
    }

    if (saleRate === 0 && volumeRate === 0 && tradeRate === 0) {
      return empty;
    }

    // Use a £100 reference (RRP) so effective rates fall out naturally as £.
    const basePrice = 100;
    const afterSaleP = basePrice * (1 - saleRate / 100);
    const afterVolumeP = afterSaleP * (1 - volumeRate / 100);
    const afterTradeP = afterVolumeP * (1 - tradeRate / 100);

    const saleSaved = basePrice - afterSaleP;
    const volumeSaved = afterSaleP - afterVolumeP;
    const tradeSaved = afterVolumeP - afterTradeP;
    const totalSaved = basePrice - afterTradeP;

    // Effective rates = £ saved per £100 RRP (rounded, with the last layer
    // absorbing rounding so the three always sum to the displayed total).
    const total = Math.round((totalSaved / basePrice) * 100);
    let saleContrib = Math.round((saleSaved / basePrice) * 100);
    let volumeContrib = Math.round((volumeSaved / basePrice) * 100);
    let tradeContrib = total - saleContrib - volumeContrib;
    if (tradeContrib < 0) {
      // Edge: rounding pushed trade negative — pull from largest contributor.
      if (saleContrib >= volumeContrib) saleContrib += tradeContrib;
      else volumeContrib += tradeContrib;
      tradeContrib = 0;
    }

    return {
      saleContrib, volumeContrib, tradeContrib, total,
      // Raw input rates (kept for any caller that needs the tier-table number)
      saleRate: Math.round(saleRate),
      volumeRate: Math.round(volumeRate),
      tradeRate: Math.round(tradeRate),
      // Per-£100 figures (used by the tooltip)
      saleSaved: Math.round(saleSaved * 100) / 100,
      volumeSaved: Math.round(volumeSaved * 100) / 100,
      tradeSaved: Math.round(tradeSaved * 100) / 100,
      totalSaved: Math.round(totalSaved * 100) / 100,
      basePrice,
    };
  })();
  
  const totalCombinedDiscount = discountBreakdown.total;

  // Calculate boxes needed (for display)
  const boxesNeeded = () => {
    const sqmPerBox = getSqmPerBox();
    if (!sqmPerBox || !sellsPerM2) return null;
    if (quantityUnit === 'box') return quantity;
    return Math.ceil(quantity / sqmPerBox);
  };

  const stockStatus = getStockStatus(selectedProduct);
  const sqmPerBox = getSqmPerBox();

  // Add to cart
  const handleAddToCart = async () => {
    if (!selectedProduct || isAddingToCart) return;
    
    // Start animation
    setIsAddingToCart(true);
    
    // Simulate a brief delay for visual feedback
    await new Promise(resolve => setTimeout(resolve, 300));
    
    const sqmQuantity = getEffectiveSqmQuantity();
    const boxes = boxesNeeded();
    // Pallet tier → cart line uses a different priceType so the basket
    // can show a "Half Pallet" / "Full Pallet" badge and so the line
    // doesn't merge with a same-tile per-m² line already in the basket.
    const cartPriceType = pricingTier === 'full_pallet'
      ? 'full_pallet'
      : pricingTier === 'half_pallet'
        ? 'half_pallet'
        : (selectedProduct.priceType || 'room_lot');
    addToCart({
      id: selectedProduct.id,
      name: selectedProduct.display_name || selectedProduct.name,
      slug: selectedProduct.slug,
      image: normaliseImageUrl(firstImageUrl(selectedProduct.images)),
      price: displayPrice,
      // Canonical retail (inc-VAT) for cart re-pricing on trade login/logout.
      // When volume tiers are active for a trade user, currentPrice is already
      // trade-net — reverse the per-product trade discount to recover retail.
      retail_price_inc_vat: (() => {
        if (pricingTier !== 'm2' || !isTrade) return currentPrice;
        if (!tierPricing || tierPricing.length === 0) return currentPrice;
        const td = Number(selectedProduct.trade_discount ?? productTradeDiscount) || 0;
        if (td <= 0) return currentPrice;
        const type = String(selectedProduct.trade_discount_type || 'percent').toLowerCase();
        const retail = type === 'fixed' ? currentPrice + td : currentPrice / (1 - td / 100);
        return Math.round(retail * 100) / 100;
      })(),
      silent: true,
      priceType: cartPriceType,
      pallet_tier: pricingTier === 'm2' ? null : pricingTier,
      // Pallet-rate lines can't drop below the pallet quantity in the basket.
      pallet_min_qty: pricingTier === 'full_pallet'
        ? (palletInfo.fullM2 || null)
        : pricingTier === 'half_pallet'
          ? (palletInfo.halfM2 || null)
          : null,
      size: selectedProduct.size,
      finish: selectedProduct.finish,
      color: selectedProduct.color,
      coverage: sqmPerBox || 1,
      quantity: sqmQuantity,
      boxes: boxes,
      isTrade: isTrade,
      trade_discount: selectedProduct.trade_discount ?? productTradeDiscount,
      trade_discount_type: selectedProduct.trade_discount_type || 'percent',
      credit_back_rate: selectedProduct.credit_back_rate ?? creditBackRate,
      // Unit metadata — so cart/checkout can show "2.16 m² · 3 boxes" and
      // the +/- stepper can step by a full box.
      sqm_per_box: sqmPerBox || null,
      tiles_per_box: selectedProduct.tiles_per_box || null,
      // The PDP's unit determination (palletInfo.isUnit — pallet_qty_unit /
      // surface heuristics) is what the customer SAW ("Per unit £X each"), so
      // it wins over the API's pricing_unit which defaults to 'm2' when unset.
      pricing_unit: palletInfo.isUnit ? 'unit' : (selectedProduct.pricing_unit || 'm2'),
      // Tier config for the "add 1 box to unlock X% off" upsell nudge
      tier_thresholds: selectedProduct.tier_thresholds || null,
      tier_discounts: selectedProduct.tier_discounts || null,
      tier_pricing_disabled: !!selectedProduct.tier_pricing_disabled,
      was_price: selectedProduct.was_price || null,
      list_price: selectedProduct.list_price || selectedProduct.price || null,
    });
    
    // Show success state
    setIsAddingToCart(false);
    setCartAdded(true);
    const unitWord = palletInfo.isUnit ? 'units' : 'm²';
    toast.success(
      pricingTier === 'full_pallet'
        ? `Added Full Pallet (${sqmQuantity.toFixed(palletInfo.isUnit ? 0 : 2)} ${unitWord}) to cart!`
        : pricingTier === 'half_pallet'
          ? `Added Half Pallet (${sqmQuantity.toFixed(palletInfo.isUnit ? 0 : 2)} ${unitWord}) to cart!`
          : palletInfo.isUnit
            ? `Added ${sqmQuantity.toFixed(0)} unit${sqmQuantity === 1 ? '' : 's'} to cart!`
            : `Added ${sqmQuantity.toFixed(2)} m²${boxes ? ` (${boxes} box${boxes > 1 ? 'es' : ''})` : ''} to cart!`
    );
    
    // Reset after animation
    setTimeout(() => setCartAdded(false), 2000);
  };

  // Add to samples
  const handleAddSample = () => {
    if (!selectedProduct) return;
    if (sampleCount >= maxSamples) {
      toast.error(`Maximum ${maxSamples} samples allowed`);
      return;
    }
    addSample({
      id: selectedProduct.id,
      name: selectedProduct.display_name || selectedProduct.name,
      slug: selectedProduct.slug,
      image: normaliseImageUrl(firstImageUrl(selectedProduct.images)),
      size: selectedProduct.size,
      finish: selectedProduct.finish,
      color: selectedProduct.color
    });
    toast.success('Sample added!');
  };

  // Trade Bundle Booster: ship the tile + matching FBT essentials in one click.
  // Trade-only — only fires when isTrade && fbtItems.length > 0.
  const handleAddTradeKit = () => {
    if (!selectedProduct) return;
    // Build kit: selected tile first, then up to 2 FBT essentials (3-sample limit)
    const kit = [selectedProduct, ...fbtItems.slice(0, 2)];
    let added = 0;
    let skippedDup = 0;
    for (const item of kit) {
      if (sampleCount + added >= maxSamples) break;
      if (isInSamples(item.id)) { skippedDup++; continue; }
      const ok = addSample({
        id: item.id,
        name: item.display_name || item.name,
        slug: item.slug,
        image: normaliseImageUrl(firstImageUrl(item.images) || item.image),
        size: item.size,
        finish: item.finish,
        color: item.color,
      });
      if (ok) added++;
    }
    if (added > 0) {
      toast.success(`Trade kit added — ${added} sample${added > 1 ? 's' : ''} on the way`);
    } else if (skippedDup > 0) {
      toast.info('All trade-kit items are already in your sample basket');
    } else {
      toast.error('Could not add trade kit — sample basket may be full');
    }
  };

  // Delivery Countdown Timer - calculates time until 2PM cutoff for next-day delivery
  useEffect(() => {
    const calculateCountdown = () => {
      const now = new Date();
      const cutoff = new Date();
      cutoff.setHours(14, 0, 0, 0); // 2PM cutoff
      
      // If past 2PM, set cutoff to next day
      if (now > cutoff) {
        cutoff.setDate(cutoff.getDate() + 1);
      }
      
      const diff = cutoff - now;
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const seconds = Math.floor((diff % (1000 * 60)) / 1000);
      
      setDeliveryCountdown({ hours, minutes, seconds });
    };
    
    calculateCountdown();
    const interval = setInterval(calculateCountdown, 1000);
    return () => clearInterval(interval);
  }, []);

  // Image zoom handlers
  const handleMouseMove = (e) => {
    if (!isZooming) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setZoomPosition({ x, y });
  };

  // Product images array (defined early for use in callbacks)
  // Normalise to string URLs.
  // Production data has accumulated 4 different image entry shapes over
  // time (legacy migrations, CDN re-imports, manual edits):
  //   1. plain string URL
  //   2. {src: 'https://...'} object
  //   3. {url: 'https://...'} object
  //   4. {large: 'https://...', thumbnail: '...'} multi-resolution object
  // normaliseImageList handles all 4 + filters out blanks. Without this,
  // <img src={...}> on a non-string entry shows the broken-image icon
  // and string ops on it crash the whole page.
  const productImages = normaliseImageList(selectedProduct?.images);

  // Per-image framing set by admin (Images panel → Frame button)
  const getImageFraming = (url) =>
    (selectedProduct?.image_framing || []).find(f => normaliseImageUrl(f.url) === url);

  // Lightbox handlers
  const openLightbox = (index) => {
    setLightboxIndex(index);
    setShowLightbox(true);
    document.body.style.overflow = 'hidden';
  };

  const closeLightbox = () => {
    setShowLightbox(false);
    document.body.style.overflow = 'unset';
  };

  const nextImage = useCallback(() => {
    if (productImages.length === 0) return;
    setLightboxIndex((prev) => (prev + 1) % productImages.length);
  }, [productImages.length]);

  const prevImage = useCallback(() => {
    if (productImages.length === 0) return;
    setLightboxIndex((prev) => (prev - 1 + productImages.length) % productImages.length);
  }, [productImages.length]);

  // Keyboard navigation for lightbox
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!showLightbox) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowRight') nextImage();
      if (e.key === 'ArrowLeft') prevImage();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showLightbox, nextImage, prevImage]);

  // Check if media is video — fully defensive, never throws.
  const isVideo = (url) => {
    const s = safeStr(url);
    if (!s) return false;
    return safeMatch(s, /\.(mp4|webm|ogg|mov)$/i).length > 0
      || safeIncludes(s, 'youtube')
      || safeIncludes(s, 'vimeo');
  };

  // Get lifestyle/room images (for "View in Room" feature)
  const lifestyleImages = useMemo(() => {
    // Filter images that look like lifestyle/room shots (usually larger index images)
    // Or return all images if there's no distinction
    return productImages.filter((img, idx) => idx > 0).length > 0 
      ? productImages.filter((img, idx) => idx > 0) 
      : productImages;
  }, [productImages]);

  // Enhanced loading state with skeleton placeholders
  if (loading) {
    return (
      <div className="min-h-screen bg-white">
        <ShopHeader />
        <div className="max-w-7xl mx-auto px-4 py-8">
          {/* Breadcrumb skeleton */}
          <div className="flex items-center gap-2 mb-8">
            <div className="h-4 w-16 bg-gray-200 rounded animate-pulse"></div>
            <div className="h-4 w-4 bg-gray-200 rounded animate-pulse"></div>
            <div className="h-4 w-12 bg-gray-200 rounded animate-pulse"></div>
            <div className="h-4 w-4 bg-gray-200 rounded animate-pulse"></div>
            <div className="h-4 w-24 bg-gray-200 rounded animate-pulse"></div>
          </div>
          
          <div className="grid lg:grid-cols-2 gap-8 lg:gap-12">
            {/* Image skeleton */}
            <div className="space-y-4">
              <div className="aspect-square bg-gray-200 rounded-lg animate-pulse"></div>
              <div className="flex gap-2">
                {[1,2,3,4].map(i => (
                  <div key={i} className="w-20 h-20 bg-gray-200 rounded-lg animate-pulse"></div>
                ))}
              </div>
            </div>
            
            {/* Content skeleton */}
            <div className="space-y-6">
              <div className="h-10 w-3/4 bg-gray-200 rounded animate-pulse"></div>
              <div className="h-6 w-1/2 bg-gray-200 rounded animate-pulse"></div>
              <div className="flex gap-3">
                {[1,2,3].map(i => (
                  <div key={i} className="w-14 h-14 bg-gray-200 rounded-lg animate-pulse"></div>
                ))}
              </div>
              <div className="flex gap-2">
                {[1,2].map(i => (
                  <div key={i} className="h-10 w-24 bg-gray-200 rounded-lg animate-pulse"></div>
                ))}
              </div>
              <div className="h-40 bg-gray-200 rounded-lg animate-pulse"></div>
              <div className="h-14 bg-amber-200 rounded-lg animate-pulse"></div>
            </div>
          </div>
        </div>
        <ShopFooter />
      </div>
    );
  }

  if (!selectedProduct) {
    return (
      <div className="min-h-screen bg-white">
        <ShopHeader />
        <div className="max-w-7xl mx-auto px-4 py-16 text-center">
          <h1 className="text-2xl font-medium text-gray-900 mb-4">Collection Not Found</h1>
          <p className="text-gray-600 mb-6">The collection "{decodedSeriesName}" doesn't exist or has no products.</p>
          <Link to="/tiles" className="text-amber-600 hover:text-amber-700">
            ← Browse all tiles
          </Link>
        </div>
        <ShopFooter />
      </div>
    );
  }

  // Product/series-aware SEO data — derives best canonical + descriptors
  // from selectedProduct first, then cheapest fallback, then series.
  const seoProduct = selectedProduct?._isPreview === false ? selectedProduct : cheapestProduct;
  const seoTitle = seoProduct?.display_name || decodedSeriesName || 'Tile Collection';
  const seoSize = seoProduct?.size || '';
  const seoFinish = seoProduct?.finish || '';
  const seoDesc = (seoProduct?.short_description || seoProduct?.description || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .slice(0, 250)
    || `${decodedSeriesName} tiles${seoSize ? ' in ' + seoSize : ''}${seoFinish ? ', ' + seoFinish + ' finish' : ''}. Free UK delivery on orders over £500. Free samples available.`;
  const seoImage = normaliseImageUrl(seoProduct?.images?.[0]) || normaliseImageUrl(seoProduct?.thumbnail) || normaliseImageUrl(seoProduct?.product_images?.[0]);
  const seoSlug = seoProduct?.slug || selectedProduct?.slug || '';
  const seoCanonical = seoSlug ? `/tiles/${seoSlug}` : `/shop/collection/${encodeURIComponent(decodedSeriesName || '')}`;
  const seoPrice = Number(seoProduct?.price_per_unit || seoProduct?.price || 0).toFixed(2);
  const seoStock = (seoProduct?.stock_qty || 0) > 0 ? 'InStock' : 'OutOfStock';

  return (
    <div className="min-h-screen bg-white">
      <SeoHead
        title={`${seoTitle}${seoSize ? ' — ' + seoSize : ''}${seoFinish ? ' ' + seoFinish : ''}`.trim()}
        description={seoDesc}
        canonical={seoCanonical}
        type="product"
        image={seoImage}
        keywords={[seoTitle, seoSize, seoFinish, decodedSeriesName, 'tiles UK'].filter(Boolean).join(', ')}
        jsonLd={seoProduct ? {
          '@context': 'https://schema.org/',
          '@type': 'Product',
          name: seoTitle,
          image: (seoProduct?.images || [seoImage].filter(Boolean)),
          description: seoDesc,
          sku: seoProduct?.sku || seoProduct?.supplier_code,
          brand: { '@type': 'Brand', name: seoProduct?.brand || seoProduct?.supplier_name || 'Tile Station' },
          offers: {
            '@type': 'Offer',
            url: seoSlug ? `https://tilestation.co.uk/tiles/${seoSlug}` : undefined,
            priceCurrency: 'GBP',
            price: seoPrice,
            availability: `https://schema.org/${seoStock}`,
            itemCondition: 'https://schema.org/NewCondition',
            seller: { '@type': 'Organization', name: 'Tile Station' },
          },
        } : null}
      />
      <ShopHeader />
      
      {/* Trust Badges / USP Strip - Uses shared hook for consistent values */}
      {trustBadgesEnabled && (
      <div className="bg-gray-50 border-b border-gray-100">
        <div className="max-w-7xl mx-auto px-4">
          <div className="flex items-center justify-between sm:justify-center gap-2 sm:gap-4 md:gap-8 py-3 overflow-x-auto scrollbar-hide">
            {/* Free Delivery */}
            {trustBadgeData.delivery.enabled !== false && (
            <div className="flex items-center gap-1.5 sm:gap-2 text-gray-700 whitespace-nowrap">
              <div className="w-6 h-6 sm:w-8 sm:h-8 bg-amber-100 rounded-full flex items-center justify-center flex-shrink-0">
                <Truck className="w-3 h-3 sm:w-4 sm:h-4 text-amber-600" />
              </div>
              <div className="hidden sm:block">
                <p className="text-xs font-semibold text-gray-900">{trustBadgeData.delivery.title}</p>
                <p className="text-xs text-gray-500">{trustBadgeData.delivery.subtitle}</p>
              </div>
              <span className="sm:hidden text-[10px] font-medium leading-tight text-center">
                {trustBadgeData.delivery.title}<br/>{trustBadgeData.delivery.subtitle}
              </span>
            </div>
            )}
            
            {/* Divider */}
            <div className="h-6 w-px bg-gray-200 sm:h-8"></div>
            
            {/* Free Samples - Only for surface products */}
            {isSurfaceProduct && trustBadgeData.samples.enabled !== false && (
            <>
            <div className="flex items-center gap-1.5 sm:gap-2 text-gray-700 whitespace-nowrap">
              <div className="w-6 h-6 sm:w-8 sm:h-8 bg-green-100 rounded-full flex items-center justify-center flex-shrink-0">
                <Scissors className="w-3 h-3 sm:w-4 sm:h-4 text-green-600" />
              </div>
              <div className="hidden sm:block">
                <p className="text-xs font-semibold text-gray-900">{trustBadgeData.samples.title}</p>
                <p className="text-xs text-gray-500">{trustBadgeData.samples.subtitle}</p>
              </div>
              <span className="sm:hidden text-[10px] font-medium leading-tight text-center">
                {trustBadgeData.samples.title}
              </span>
            </div>
            <div className="h-6 w-px bg-gray-200 sm:h-8"></div>
            </>
            )}
            
            {/* Quality Guaranteed */}
            {trustBadgeData.quality.enabled !== false && (
            <div className="flex items-center gap-1.5 sm:gap-2 text-gray-700 whitespace-nowrap">
              <div className="w-6 h-6 sm:w-8 sm:h-8 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                <Shield className="w-3 h-3 sm:w-4 sm:h-4 text-blue-600" />
              </div>
              <div className="hidden sm:block">
                <p className="text-xs font-semibold text-gray-900">{trustBadgeData.quality.title}</p>
                <p className="text-xs text-gray-500">{trustBadgeData.quality.subtitle}</p>
              </div>
              <span className="sm:hidden text-[10px] font-medium leading-tight text-center">
                {trustBadgeData.quality.title}
              </span>
            </div>
            )}
            
            {/* Divider */}
            <div className="h-6 w-px bg-gray-200 sm:h-8"></div>
            
            {/* Secure Payment */}
            {trustBadgeData.secure.enabled !== false && (
            <div className="flex items-center gap-1.5 sm:gap-2 text-gray-700 whitespace-nowrap">
              <div className="w-6 h-6 sm:w-8 sm:h-8 bg-purple-100 rounded-full flex items-center justify-center flex-shrink-0">
                <Check className="w-3 h-3 sm:w-4 sm:h-4 text-purple-600" />
              </div>
              <div className="hidden sm:block">
                <p className="text-xs font-semibold text-gray-900">{trustBadgeData.secure.title}</p>
                <p className="text-xs text-gray-500">{trustBadgeData.secure.subtitle}</p>
              </div>
              <span className="sm:hidden text-[10px] font-medium leading-tight text-center">
                {trustBadgeData.secure.title}
              </span>
            </div>
            )}
          </div>
        </div>
      </div>
      )}
      
      {/* Breadcrumb */}
      <div className="max-w-7xl mx-auto px-4 py-4">
        <nav className="flex items-center text-sm text-gray-500">
          <Link to="/shop" className="hover:text-amber-600">Home</Link>
          <ChevronRight className="w-4 h-4 mx-2" />
          <Link to="/tiles" className="hover:text-amber-600">Tiles</Link>
          <ChevronRight className="w-4 h-4 mx-2" />
          <span className="text-gray-900">{decodedSeriesName}</span>
        </nav>
      </div>

      {/* Admin preview: draft products included on this page */}
      {isAdminPreview && products.some(p => p.is_draft) && (
        <div className="max-w-7xl mx-auto px-4" data-testid="preview-draft-banner">
          <div className="mb-3 px-4 py-3 rounded-lg border border-amber-300 bg-amber-50 text-sm text-amber-800">
            <b>Draft preview:</b> {products.filter(p => p.is_draft).length} product(s) on this page {products.filter(p => p.is_draft).length === 1 ? 'is' : 'are'} not live on the website yet —{' '}
            {products.filter(p => p.is_draft).slice(0, 6).map(p => p.display_name).join(', ')}
            {products.filter(p => p.is_draft).length > 6 ? ` +${products.filter(p => p.is_draft).length - 6} more` : ''}. Publish them from the admin manager to make them live.
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 pb-16">
        <div className="grid lg:grid-cols-2 gap-8 lg:gap-12">
          
          {/* Left: Image Gallery - ENHANCED */}
          <div className="space-y-4 min-w-0">
            {/* Main Image with Zoom and Click to Lightbox */}
            <div 
              className="relative aspect-square bg-gray-100 rounded-xl overflow-hidden group"
              onMouseEnter={() => setIsZooming(true)}
              onMouseLeave={() => setIsZooming(false)}
              onMouseMove={handleMouseMove}
            >
              {productImages.length > 0 ? (
                <>
                  {/* Check if current media is video */}
                  {isVideo(productImages[previewThumbIdx ?? mainImageIndex]) ? (
                    <div className="relative w-full h-full">
                      <video
                        src={productImages[previewThumbIdx ?? mainImageIndex]}
                        className="w-full h-full object-cover"
                        controls={isVideoPlaying}
                        muted
                        loop
                        playsInline
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsVideoPlaying(!isVideoPlaying);
                        }}
                      />
                      {!isVideoPlaying && (
                        <div 
                          className="absolute inset-0 flex items-center justify-center bg-black/30 cursor-pointer"
                          onClick={() => setIsVideoPlaying(true)}
                        >
                          <div className="w-20 h-20 bg-white/90 rounded-full flex items-center justify-center shadow-lg hover:scale-110 transition-transform">
                            <Play className="w-10 h-10 text-amber-600 ml-1" />
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <img
                      key={productImages[previewThumbIdx ?? mainImageIndex]}
                      src={productImages[previewThumbIdx ?? mainImageIndex]}
                      alt={selectedProduct?.display_name || decodedSeriesName}
                      className="w-full h-full object-cover transition-all duration-200 cursor-zoom-in pdp-img-fade"
                      style={(() => {
                        if (isZooming && previewThumbIdx === null) return { transform: 'scale(2)', transformOrigin: `${zoomPosition.x}% ${zoomPosition.y}%` };
                        const f = getImageFraming(productImages[previewThumbIdx ?? mainImageIndex]);
                        return f ? { objectPosition: `${f.x}% ${f.y}%`, transform: `scale(${f.zoom})`, transformOrigin: `${f.x}% ${f.y}%` } : {};
                      })()}
                      onClick={() => openLightbox(previewThumbIdx ?? mainImageIndex)}
                    />
                  )}
                  
                  {/* CLEARANCE ribbon — big, flashing, replaces the Sale ribbon */}
                  {isClearanceProduct && (
                    <div className="absolute top-3 right-3 z-20 pointer-events-none" data-testid="clearance-ribbon">
                      <div className="clearance-badge clearance-flash flex flex-col items-center px-5 py-2.5 rounded-md bg-[#e5d918] border-[3px] border-[#FF2A00] shadow-2xl">
                        <span className="clearance-fire-text text-2xl sm:text-3xl font-black text-[#FF2A00] leading-none tracking-[0.2em] uppercase">Clearance</span>
                        {hasExplicitSale && discountBreakdown?.total > 0 && (
                          <span className="mt-1 text-xs font-black text-black/80 uppercase tracking-wider">Save {discountBreakdown.total}% · while stocks last</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Sale Badge - Large prominent ribbon style like Tile Mountain */}
                  {isOnSale && !isClearanceProduct && (
                    <div className="absolute top-0 right-0 z-10">
                      <div className="relative">
                        <Star className="absolute -top-1 left-1 w-5 h-5 fill-yellow-400 text-yellow-400 z-20" />
                        <div className="bg-red-600 text-white pl-7 pr-5 py-3 rounded-bl-lg shadow-xl">
                          <span className="text-2xl font-bold italic tracking-wide drop-shadow-sm">Sale</span>
                        </div>
                        <div className="absolute -bottom-2 left-0 w-0 h-0 border-r-[10px] border-r-transparent border-t-[10px] border-t-red-800"></div>
                      </div>
                    </div>
                  )}
                  
                  {/* Other Labels */}
                  {selectedProduct?.labels?.filter(label => !['sale', 'clearance'].includes(label.toLowerCase())).length > 0 && (
                    <div className={`absolute top-4 ${isOnSale || isClearanceProduct ? 'left-4' : 'right-4'} flex flex-col gap-1`}>
                      {selectedProduct.labels
                        .filter(label => !['sale', 'clearance'].includes(label.toLowerCase()))
                        .map((label, idx) => (
                          <span key={idx} className="bg-amber-500 text-white px-2 py-1 rounded text-xs font-medium">
                            {label}
                          </span>
                        ))}
                    </div>
                  )}
                  
                  {/* Bottom Action Bar */}
                  <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                    <div className="flex items-center justify-between">
                      <div className="flex gap-2">
                        {/* Fullscreen Button */}
                        <button
                          onClick={() => openLightbox(mainImageIndex)}
                          className="bg-white/90 hover:bg-white text-gray-800 px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 transition-all hover:scale-105"
                        >
                          <Maximize2 className="w-4 h-4" />
                          <span className="hidden sm:inline">Fullscreen</span>
                        </button>
                        
                        {/* View in Room — hidden per admin request (Aug 2026) */}
                      </div>
                      
                      {/* Zoom hint */}
                      <div className="bg-black/50 text-white px-2 py-1 rounded text-xs flex items-center gap-1">
                        <ZoomIn className="w-3 h-3" />
                        Click to expand
                      </div>
                    </div>
                  </div>
                  
                  {/* Mobile Navigation Dots */}
                  {productImages.length > 1 && (
                    <div className="absolute bottom-16 left-1/2 transform -translate-x-1/2 flex gap-2 md:hidden">
                      {productImages.map((_, idx) => (
                        <button
                          key={idx}
                          onClick={() => setMainImageIndex(idx)}
                          className={`w-2.5 h-2.5 rounded-full transition-all ${
                            mainImageIndex === idx 
                              ? 'bg-amber-500 w-6' 
                              : 'bg-white/70 hover:bg-white'
                          }`}
                        />
                      ))}
                    </div>
                  )}
                  
                  {/* Image Navigation Arrows */}
                  {productImages.length > 1 && (
                    <>
                      <button
                        onClick={(e) => { e.stopPropagation(); setMainImageIndex((prev) => (prev - 1 + productImages.length) % productImages.length); }}
                        onMouseEnter={() => setIsZooming(false)}
                        className="absolute left-3 top-1/2 -translate-y-1/2 z-20 w-10 h-10 bg-white/90 hover:bg-white rounded-full flex items-center justify-center shadow-lg opacity-70 hover:opacity-100 transition-opacity"
                        data-testid="gallery-prev-btn"
                      >
                        <ChevronLeft className="w-6 h-6 text-gray-700" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setMainImageIndex((prev) => (prev + 1) % productImages.length); }}
                        onMouseEnter={() => setIsZooming(false)}
                        className="absolute right-3 top-1/2 -translate-y-1/2 z-20 w-10 h-10 bg-white/90 hover:bg-white rounded-full flex items-center justify-center shadow-lg opacity-70 hover:opacity-100 transition-opacity"
                        data-testid="gallery-next-btn"
                      >
                        <ChevronRight className="w-6 h-6 text-gray-700" />
                      </button>
                    </>
                  )}
                </>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-gray-400">
                  No image available
                </div>
              )}
            </div>

            {/* Thumbnails - Desktop */}
            {productImages.length > 1 && (
              <div className="hidden md:flex gap-2 overflow-x-auto pb-2">
                {productImages.map((img, idx) => (
                  <button
                    key={idx}
                    onClick={() => { setMainImageIndex(idx); setPreviewThumbIdx(null); }}
                    onMouseEnter={() => setPreviewThumbIdx(idx)}
                    onMouseLeave={() => setPreviewThumbIdx(null)}
                    className={`relative flex-shrink-0 w-20 h-20 rounded-lg overflow-hidden border-2 transition-all ${
                      mainImageIndex === idx ? 'border-amber-500 ring-2 ring-amber-200'
                        : previewThumbIdx === idx ? 'border-amber-300 ring-1 ring-amber-100 scale-105'
                        : 'border-transparent hover:border-gray-300'
                    }`}
                    data-testid={`thumbnail-${idx}`}
                  >
                    {isVideo(img) ? (
                      <div className="relative w-full h-full bg-gray-200">
                        <video src={img} className="w-full h-full object-cover" muted />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                          <Play className="w-6 h-6 text-white" />
                        </div>
                      </div>
                    ) : (
                      <img src={img} alt="" className="w-full h-full object-cover" />
                    )}
                  </button>
                ))}
              </div>
            )}

            {/* Collection Description - Under Images (DESKTOP ONLY) */}
            {/* On mobile, this moves below the Add to Cart button */}
            <div className="hidden lg:block">
            {selectedProduct && (() => {
              // Priority: explicit admin collection description → the selected
              // product's OWN description (per-variant or series-wide AI text)
              // → any remaining collection-level text → auto-generated template
              const savedDescription = (descriptionSource === 'custom' && collectionDescription.trim())
                || (selectedProduct.description || '').trim()
                || (collectionDescription || '').trim();
              if (savedDescription) {
                // Split description into paragraphs for readability
                // If it has explicit line breaks, use those. Otherwise, split every 2-3 sentences.
                const rawText = savedDescription;
                let paragraphs;
                if (rawText.includes('\n')) {
                  paragraphs = rawText.split(/\n+/).filter(p => p.trim());
                } else {
                  // Split into sentences, then group every 2-3 sentences into a paragraph
                  const sentences = rawText.match(/[^.!?]+[.!?]+/g) || [rawText];
                  paragraphs = [];
                  for (let i = 0; i < sentences.length; i += 3) {
                    paragraphs.push(sentences.slice(i, i + 3).join('').trim());
                  }
                }
                return (
                  <div className="bg-white border border-gray-200 rounded-lg p-5 mt-4" data-testid="product-description">
                    <h3 className="font-semibold text-gray-900 mb-3 text-base">About This Product</h3>
                    <div className="text-sm text-gray-600 leading-relaxed space-y-3">
                      {paragraphs.map((para, idx) => (
                        <RenderProductDescription key={idx} text={para} />
                      ))}
                    </div>
                  </div>
                );
              }
              
              // Auto-generate description from product data
              const p = selectedProduct;
              const series = decodedSeriesName;
              const material = p.material || p.attributes?.material || '';
              const suitability = p.suitability || p.attributes?.suitability || '';
              const slipRating = p.slip_rating || p.attributes?.slip_rating || '';
              const thickness = p.thickness || p.attributes?.thickness || '';
              const edge = p.edge || p.attributes?.edge || '';
              const madeIn = p.made_in || '';
              const rooms = p.rooms || [];
              const styles = p.styles || [];
              const features = p.features || [];
              
              // Determine indoor/outdoor from sizes (normalized + deduped labels)
              const sizeLabels = dedupeSizeLabels(allSizes);
              const indoorSizes = sizeLabels.filter(s => (s.match(/x/gi) || []).length < 2);
              const outdoorSizes = sizeLabels.filter(s => (s.match(/x/gi) || []).length >= 2);
              const hasIndoor = indoorSizes.length > 0;
              const hasOutdoor = outdoorSizes.length > 0;
              
              // Collect unique colors/finishes across collection
              const collectionColors = colorOptions.map(c => c.name);
              const collectionFinishes = finishOptions.length > 0 ? finishOptions : [];
              const fmtFinish = f => f.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bR(\d+)\b/gi, (_, n) => `R${n}`);
              
              // Build natural flowing paragraph
              const sentences = [];
              
              // Opening — material + use type + suitability
              if (material) {
                const useType = hasIndoor && hasOutdoor ? 'both indoor and outdoor spaces' : hasOutdoor ? 'outdoor spaces' : 'interior spaces';
                sentences.push(`The ${series} collection is crafted from high-quality ${material.toLowerCase()}, designed for ${useType}${suitability ? ` and suitable for ${suitability.toLowerCase()} installation` : ''}.`);
              } else {
                sentences.push(`The ${series} collection is designed for ${hasIndoor && hasOutdoor ? 'indoor and outdoor' : hasOutdoor ? 'outdoor' : 'indoor'} use${suitability ? `, suitable for ${suitability.toLowerCase()} installation` : ''}.`);
              }
              
              // Technical details — thickness, slip, edge woven naturally
              const techParts = [];
              if (thickness) techParts.push(`a thickness of ${thickness}`);
              if (slipRating) techParts.push(`a slip rating of ${slipRating}${slipRating.match(/R1[01]/) ? ', making it a reliable choice for wet areas' : ''}`);
              if (edge) techParts.push(`a ${edge.toLowerCase()} edge for a clean, seamless look`);
              if (techParts.length > 0) {
                sentences.push(`With ${techParts.join(' and ')}, this range is built to perform in busy environments.`);
              }
              
              // Sizes — grouped by indoor/outdoor
              if (sizeLabels.length > 0) {
                if (hasIndoor && hasOutdoor) {
                  sentences.push(`The collection is available in ${indoorSizes.join(', ')} for indoor use, alongside ${outdoorSizes.join(', ')} thicker options suited for patios, driveways and outdoor areas.`);
                } else if (sizeLabels.length > 2) {
                  sentences.push(`Offered in a range of sizes — ${sizeLabels.join(', ')} — giving you flexibility across different room layouts and spaces.`);
                } else {
                  sentences.push(`Available in ${sizeLabels.join(' and ')}.`);
                }
              }
              
              // Colours and finishes — woven together
              if (collectionColors.length > 0 && collectionFinishes.length > 0) {
                const colorList = collectionColors.length > 2 
                  ? `${collectionColors.slice(0, -1).join(', ')} and ${collectionColors[collectionColors.length - 1]}`
                  : collectionColors.join(' and ');
                const finishList = collectionFinishes.map(fmtFinish).join(', ');
                sentences.push(`It comes in ${colorList}, each available in ${finishList.toLowerCase()} finish${collectionFinishes.length > 1 ? 'es' : ''} to match your space.`);
              } else if (collectionColors.length > 0) {
                sentences.push(`Available in ${collectionColors.join(', ')}.`);
              } else if (collectionFinishes.length > 0) {
                const finishList = collectionFinishes.map(fmtFinish).join(', ');
                sentences.push(`Offered in ${finishList.toLowerCase()} finish${collectionFinishes.length > 1 ? 'es' : ''}.`);
              }
              
              // Rooms — practical application
              if (rooms.length > 0) {
                const roomList = rooms.length > 2
                  ? `${rooms.slice(0, -1).join(', ')} and ${rooms[rooms.length - 1]}`
                  : rooms.join(' and ');
                sentences.push(`A great option for ${roomList.toLowerCase()}, ${series} brings a consistent look throughout your home or project.`);
              }
              
              // Styles
              if (styles.length > 0) {
                sentences.push(`The ${styles.join(', ').toLowerCase()} aesthetic pairs well with both modern and traditional interiors.`);
              }
              
              // Features
              if (features.length > 0) {
                sentences.push(`Notable features include ${features.join(', ').toLowerCase()}.`);
              }
              
              // Origin — closing note
              if (madeIn) {
                sentences.push(`Manufactured in ${madeIn}.`);
              }
              
              return (
                <div className="bg-white border border-gray-200 rounded-lg p-5 mt-4" data-testid="product-description">
                  <h3 className="font-semibold text-gray-900 mb-3 text-base">About This Product</h3>
                  <p className="text-sm text-gray-600 leading-relaxed">
                    {sentences.join(' ')}
                  </p>
                </div>
              );
            })()}
            </div>
          </div>

          {/* Right: Product Details */}
          {/* min-w-0 is critical — without it, intrinsic min-content of children
              (large price text, sale banners, volume pricing table) forces this
              grid track wider than the viewport on mobile, causing content to
              clip past the right edge. */}
          <div className="space-y-5 min-w-0">
            {/* Title & SKU */}
            <div>
              <h1 className="text-2xl md:text-3xl font-bold text-gray-900 uppercase tracking-wide">
                {decodedSeriesName}
              </h1>
              {/* Show complete product name from actual product data */}
              {selectedProduct && (selectedProduct.display_name || selectedProduct.name) && (() => {
                const rawName = selectedProduct.display_name || selectedProduct.name || '';
                const rawSize = selectedProduct.size || '';
                // Tile dimensions are often expressed in two interchangeable ways
                // (e.g. "30x60cm" and "600x300x7mm"). Build every alias of the size so
                // a size already present in the name in EITHER format is detected.
                const buildSizeAliases = (sz) => {
                  if (!sz) return [];
                  const aliases = new Set();
                  const lower = sz.toLowerCase().replace(/\s/g, '');
                  aliases.add(lower);
                  const m = lower.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(?:x[\d./]+(?:mm|cm)?)?(mm|cm)?$/);
                  if (m) {
                    const [, a, b, unit] = m;
                    const na = Number(a), nb = Number(b);
                    const storedUnit = unit || 'mm';
                    aliases.add(`${na}x${nb}`);
                    aliases.add(`${na}x${nb}${storedUnit}`);
                    aliases.add(`${nb}x${na}`);
                    aliases.add(`${nb}x${na}${storedUnit}`);
                    if (storedUnit === 'mm' && na >= 100 && nb >= 100) {
                      const ca = na / 10, cb = nb / 10;
                      aliases.add(`${ca}x${cb}cm`);
                      aliases.add(`${cb}x${ca}cm`);
                    }
                    if (storedUnit === 'cm') {
                      const ma = na * 10, mb = nb * 10;
                      aliases.add(`${ma}x${mb}mm`);
                      aliases.add(`${mb}x${ma}mm`);
                    }
                  }
                  return [...aliases];
                };

                // Clean the name at render-time. Some products have BOTH sizes baked
                // into display_name (e.g. "Costa Stone Bianco 30x60cm Matt 600x300x7mm").
                // If the cm and mm forms of the same dimension both appear in the string,
                // strip the trailing mm token so the banner shows one clean size.
                const cleanName = (n) => {
                  if (!n) return n;
                  // Trailing 3-dim mm token: " 600x300x7mm" or " 600x300x14/3mm"
                  const trailingMmMatch = n.match(/\s+(\d+)x(\d+)(?:x[\d./]+(?:mm)?)(?:\s*mm)?\s*$/i);
                  if (trailingMmMatch) {
                    const [full, a, b] = trailingMmMatch;
                    const na = Number(a), nb = Number(b);
                    if (na >= 100 && nb >= 100) {
                      const ca = na / 10, cb = nb / 10;
                      const lower = n.toLowerCase();
                      const cmForms = [`${ca}x${cb}cm`, `${cb}x${ca}cm`, `${ca}x${cb}`, `${cb}x${ca}`];
                      // Only strip if the cm form is ALSO present earlier in the name
                      if (cmForms.some(f => lower.slice(0, lower.length - full.length).includes(f))) {
                        return n.slice(0, n.length - full.length).trim();
                      }
                    }
                  }
                  return n;
                };

                const fullName = cleanName(rawName);
                const aliases = buildSizeAliases(rawSize);
                const lowerName = fullName.toLowerCase().replace(/\s/g, '');
                const sizeAlreadyInName = aliases.some(a => lowerName.includes(a));
                return (
                  <p className="text-lg font-semibold text-gray-800 mt-2 bg-amber-50 px-3 py-2 rounded-lg border border-amber-200" data-testid="product-full-name">
                    {fullName}
                    {rawSize && !sizeAlreadyInName && (
                      <span className="text-gray-500 font-normal"> — {rawSize}</span>
                    )}
                  </p>
                );
              })()}
              {selectedProduct?.made_in && (
                <div className="inline-flex items-center gap-2 mt-3 px-3 py-1.5 rounded-full bg-gradient-to-r from-gray-50 to-gray-100 border border-gray-200 shadow-sm" data-testid="product-detail-made-in">
                  <img 
                    src={`https://flagcdn.com/32x24/${({
                      'italy': 'it', 'spain': 'es', 'portugal': 'pt', 'turkey': 'tr',
                      'india': 'in', 'china': 'cn', 'poland': 'pl', 'germany': 'de',
                      'uk': 'gb', 'united kingdom': 'gb', 'france': 'fr', 'belgium': 'be',
                      'brazil': 'br', 'morocco': 'ma', 'egypt': 'eg', 'iran': 'ir',
                      'indonesia': 'id', 'vietnam': 'vn', 'mexico': 'mx', 'usa': 'us'
                    })[String(selectedProduct.made_in).toLowerCase()] || 'eu'}.png`}
                    alt={selectedProduct.made_in}
                    className="inline-block rounded-sm shadow-sm"
                    width="32"
                    height="24"
                  />
                  <span className="text-sm font-semibold text-gray-700 tracking-wide">Made in {selectedProduct.made_in}</span>
                </div>
              )}
            </div>

            {/* SALE PRICE Ribbon */}
            {isOnSale && (() => {
              const tierDiscountPercent = currentTierDiscount || 0;
              const tradeDiscountPercent = getEffTradePct();
              const creditBack = isTrade ? (Number(selectedProduct?.credit_back_rate ?? creditBackRate) || 0) : 0;

              // CASE 1: Explicit sale with was_price — show full WAS/NOW ribbon
              if (hasExplicitSale) {
                const effectiveWasPrice = selectedProduct.was_price;
                const nowPrice = displayPrice;
                const wasPrice = isTrade ? effectiveWasPrice / 1.20 : effectiveWasPrice;
                const totalSavings = Math.max(0, wasPrice - nowPrice);
                // Use shared breakdown for consistency
                const displayTotalOff = discountBreakdown.total;
                
                if (totalSavings <= 0) return null;

                return (
                  <div data-testid="sale-price-ribbon" data-clearance={isClearanceProduct ? 'true' : undefined}>
                    <div className="rounded-2xl overflow-hidden" style={{ background: isClearanceProduct ? 'linear-gradient(135deg, #111827 0%, #1f2937 55%, #7f1d1d 100%)' : 'linear-gradient(135deg, #ef4444 0%, #dc2626 50%, #b91c1c 100%)' }}>
                      <div className="px-4 sm:px-6 py-4 sm:py-5 flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          {isClearanceProduct ? (
                            <div className="flex flex-wrap items-center gap-2 mb-1.5" data-testid="clearance-price-label">
                              <span className="clearance-badge inline-flex items-center px-2.5 py-1 rounded-sm bg-[#e5d918] border-2 border-[#FF2A00]">
                                <span className="clearance-fire-text text-sm font-black text-[#FF2A00] leading-none tracking-widest uppercase">Clearance</span>
                              </span>
                              <span className="text-yellow-200 text-xs font-bold uppercase tracking-widest">Clearance Price · while stocks last</span>
                            </div>
                          ) : (
                            <div className="text-red-200 text-xs font-bold uppercase tracking-widest mb-1">Sale Price</div>
                          )}
                          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                            <span className="text-white/60 text-base line-through">WAS £{safeToFixed(wasPrice, 2)}{priceUnit}</span>
                            <span className="text-white text-2xl sm:text-3xl font-black tracking-tight">NOW £{safeToFixed(nowPrice, 2)}{priceUnit}</span>
                            {isTrade && <span className="text-white/50 text-xs">ex. VAT</span>}
                          </div>
                        </div>
                        <div className="bg-white rounded-xl px-4 py-3 text-center shadow-lg min-w-[90px] flex-shrink-0">
                          <div className="text-red-600 text-lg font-black leading-tight">SAVE £{totalSavings.toFixed(2)}{priceUnit}</div>
                          <div className="text-gray-500 text-xs font-bold mt-0.5">{displayTotalOff}% OFF</div>
                        </div>
                      </div>
                    {/* Discount breakdown — uses shared discountBreakdown */}
                    {(() => {
                      const { saleContrib, volumeContrib, tradeContrib } = discountBreakdown;
                      const hasMultiple = [saleContrib > 0, volumeContrib > 0, tradeContrib > 0].filter(Boolean).length;
                      
                      if (hasMultiple + (creditBack > 0 ? 1 : 0) < 2) return null;
                      
                      return (
                        <div className="bg-red-900/30 px-6 py-2.5 flex items-center gap-4 text-xs flex-wrap border-t border-white/10">
                          {saleContrib > 0 && (
                            <span className="flex items-center gap-1.5 font-semibold text-white/90">
                              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400" />Sale: {saleContrib}% off
                            </span>
                          )}
                          {volumeContrib > 0 && (
                            <><span className="text-white/30">|</span><span className="flex items-center gap-1.5 font-semibold text-white/90"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" />Volume: {volumeContrib}% off</span></>
                          )}
                          {tradeContrib > 0 && isTrade && (
                            <><span className="text-white/30">|</span><span className="flex items-center gap-1.5 font-semibold text-white/90"><span className="w-1.5 h-1.5 rounded-full bg-blue-400" />Trade: {tradeContrib}% off</span></>
                          )}
                          {hasMultiple > 1 && (
                            <>
                              <span className="text-white/30">|</span>
                              <TooltipProvider delayDuration={150}>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      className="flex items-center gap-1.5 font-black text-white cursor-help focus:outline-none focus:ring-1 focus:ring-white/40 rounded-sm"
                                      data-testid="total-discount-pill"
                                      aria-label="See how this discount is calculated"
                                    >
                                      <span className="w-1.5 h-1.5 rounded-full bg-white" />
                                      Total: {discountBreakdown.total}% off
                                      <span className="ml-0.5 text-[10px] text-white/60 leading-none">ⓘ</span>
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" className="max-w-xs bg-gray-900 text-white border-gray-800 p-3" data-testid="total-discount-tooltip">
                                    <p className="font-bold text-sm mb-1.5">How we got {discountBreakdown.total}% off</p>
                                    <p className="text-xs text-white/80 leading-snug">
                                      Each layer applies to the price after the previous one — the labels show the actual % you saved on the original RRP, so they always add up.
                                    </p>
                                    <div className="mt-2 space-y-0.5 text-xs font-mono">
                                      {discountBreakdown.saleContrib > 0 && (
                                        <div className="flex justify-between gap-3"><span className="text-white/70">Sale</span><span className="text-yellow-300">−{discountBreakdown.saleContrib}% (£{discountBreakdown.saleSaved.toFixed(2)})</span></div>
                                      )}
                                      {discountBreakdown.volumeContrib > 0 && (
                                        <div className="flex justify-between gap-3"><span className="text-white/70">Volume</span><span className="text-amber-300">−{discountBreakdown.volumeContrib}% (£{discountBreakdown.volumeSaved.toFixed(2)})</span></div>
                                      )}
                                      {discountBreakdown.tradeContrib > 0 && (
                                        <div className="flex justify-between gap-3"><span className="text-white/70">Trade</span><span className="text-blue-300">−{discountBreakdown.tradeContrib}% (£{discountBreakdown.tradeSaved.toFixed(2)})</span></div>
                                      )}
                                      <div className="flex justify-between gap-3 pt-1 mt-1 border-t border-white/15 font-bold"><span>Total</span><span className="text-emerald-300">−{discountBreakdown.total}% (£{discountBreakdown.totalSaved.toFixed(2)})</span></div>
                                    </div>
                                    <p className="mt-2 text-[10px] text-white/50">Per £100 RRP — your actual saving scales with quantity & price.</p>
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </>
                          )}
                          {creditBack > 0 && (
                            <><span className="text-white/20 mx-1">·</span><span className="flex items-center gap-1.5 font-semibold text-green-300 italic">+ Extra {creditBack}% Credit Back</span></>
                          )}
                        </div>
                      );
                    })()}
                    </div>
                  </div>
                );
              }

              // CASE 2: Label-only sale (no was_price) — show sale banner with current price + volume savings info
              if (hasSaleLabel) {
                const nowPrice = displayPrice;
                // Pallet-only lines can't use per-m² volume tiers, so don't advertise them
                const maxTierDiscount = !palletOnly && tierPricing && tierPricing.length > 0 ? (tierPricing[tierPricing.length - 1]?.discount_percent || 0) : 0;

                return (
                  <div data-testid="sale-price-ribbon" data-clearance={isClearanceProduct ? 'true' : undefined}>
                    <div className="rounded-2xl overflow-hidden" style={{ background: isClearanceProduct ? 'linear-gradient(135deg, #111827 0%, #1f2937 55%, #7f1d1d 100%)' : 'linear-gradient(135deg, #ef4444 0%, #dc2626 50%, #b91c1c 100%)' }}>
                      <div className="px-4 sm:px-6 py-4 sm:py-5 flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          {isClearanceProduct ? (
                            <div className="flex flex-wrap items-center gap-2 mb-1.5" data-testid="clearance-price-label">
                              <span className="clearance-badge inline-flex items-center px-2.5 py-1 rounded-sm bg-[#e5d918] border-2 border-[#FF2A00]">
                                <span className="clearance-fire-text text-sm font-black text-[#FF2A00] leading-none tracking-widest uppercase">Clearance</span>
                              </span>
                              <span className="text-yellow-200 text-xs font-bold uppercase tracking-widest">Clearance Price · while stocks last</span>
                            </div>
                          ) : (
                            <div className="text-red-200 text-xs font-bold uppercase tracking-widest mb-1">Sale Price</div>
                          )}
                          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                            <span className="text-white text-2xl sm:text-3xl font-black tracking-tight">£{safeToFixed(nowPrice, 2)}{priceUnit}</span>
                            {isTrade && <span className="text-white/50 text-xs">ex. VAT</span>}
                          </div>
                        </div>
                        {maxTierDiscount > 0 && (
                          <div className="bg-white rounded-xl px-4 py-3 text-center shadow-lg min-w-[90px] flex-shrink-0">
                            <div className="text-red-600 text-sm font-black leading-tight">UP TO</div>
                            <div className="text-red-600 text-lg font-black leading-tight">{maxTierDiscount}% OFF</div>
                          </div>
                        )}
                      </div>
                      {/* Discount breakdown for label-only sales */}
                      {(() => {
                        const activeDiscounts = [
                          tierDiscountPercent > 0 || maxTierDiscount > 0,
                          tradeDiscountPercent > 0,
                          creditBack > 0
                        ].filter(Boolean).length;
                        
                        if (activeDiscounts < 1) return null;
                        
                        // Effective-rate labels (Approach 1) — same logic as
                        // the sale path: show £ saved per £100 RRP so the
                        // numbers always add up. Volume rate is unchanged
                        // because it's the first layer; trade is the residual.
                        const volumeRate = tierDiscountPercent || 0;
                        const tradeRate = tradeDiscountPercent || 0;
                        const basePrice = 100;
                        const afterVolumeP = basePrice * (1 - volumeRate / 100);
                        const afterTradeP = afterVolumeP * (1 - tradeRate / 100);
                        const volumeSaved = basePrice - afterVolumeP;
                        const tradeSaved = afterVolumeP - afterTradeP;
                        const totalSaved = basePrice - afterTradeP;
                        const totalContrib = Math.round((totalSaved / basePrice) * 100);
                        let volumeContribNoSale = Math.round((volumeSaved / basePrice) * 100);
                        let tradeContribNoSale = totalContrib - volumeContribNoSale;
                        if (tradeContribNoSale < 0) {
                          volumeContribNoSale += tradeContribNoSale;
                          tradeContribNoSale = 0;
                        }
                        
                        return (
                          <div className="bg-red-900/30 px-6 py-2.5 flex items-center gap-4 text-xs flex-wrap border-t border-white/10">
                            {volumeRate > 0 && (
                              <span className="flex items-center gap-1.5 font-semibold text-white/90">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />Volume: {volumeContribNoSale}% off
                              </span>
                            )}
                            {!volumeRate && maxTierDiscount > 0 && !tradeRate && (
                              <span className="flex items-center gap-1.5 font-semibold text-white/90">
                                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />Volume: Save up to {maxTierDiscount}%
                              </span>
                            )}
                            {tradeRate > 0 && (
                              <>{volumeRate > 0 && <span className="text-white/30">|</span>}<span className="flex items-center gap-1.5 font-semibold text-white/90"><span className="w-1.5 h-1.5 rounded-full bg-blue-400" />Trade: {tradeContribNoSale}% off</span></>
                            )}
                            {volumeRate > 0 && tradeRate > 0 && (
                              <>
                                <span className="text-white/30">|</span>
                                <TooltipProvider delayDuration={150}>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <button
                                        type="button"
                                        className="flex items-center gap-1.5 font-black text-white cursor-help focus:outline-none focus:ring-1 focus:ring-white/40 rounded-sm"
                                        data-testid="total-discount-pill-no-sale"
                                        aria-label="See how this discount is calculated"
                                      >
                                        <span className="w-1.5 h-1.5 rounded-full bg-white" />
                                        Total: {totalContrib}% off
                                        <span className="ml-0.5 text-[10px] text-white/60 leading-none">ⓘ</span>
                                      </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="max-w-xs bg-gray-900 text-white border-gray-800 p-3" data-testid="total-discount-tooltip-no-sale">
                                      <p className="font-bold text-sm mb-1.5">How we got {totalContrib}% off</p>
                                      <p className="text-xs text-white/80 leading-snug">
                                        Each layer applies to the price after the previous one — the labels show the actual % you saved on the original RRP, so they always add up.
                                      </p>
                                      <div className="mt-2 space-y-0.5 text-xs font-mono">
                                        <div className="flex justify-between gap-3"><span className="text-white/70">Volume</span><span className="text-amber-300">−{volumeContribNoSale}% (£{volumeSaved.toFixed(2)})</span></div>
                                        <div className="flex justify-between gap-3"><span className="text-white/70">Trade</span><span className="text-blue-300">−{tradeContribNoSale}% (£{tradeSaved.toFixed(2)})</span></div>
                                        <div className="flex justify-between gap-3 pt-1 mt-1 border-t border-white/15 font-bold"><span>Total</span><span className="text-emerald-300">−{totalContrib}% (£{totalSaved.toFixed(2)})</span></div>
                                      </div>
                                      <p className="mt-2 text-[10px] text-white/50">Per £100 RRP — your actual saving scales with quantity & price.</p>
                                    </TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              </>
                            )}
                            {creditBack > 0 && (
                              <><span className="text-white/20 mx-1">·</span><span className="flex items-center gap-1.5 font-semibold text-green-300 italic">+ Extra {creditBack}% Credit Back</span></>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              }

              return null;
            })()}

            {/* Stock Status */}
            <div className={`flex items-center gap-2 ${stockStatus.color}`}>
              <span className={`w-2.5 h-2.5 rounded-full ${stockStatus.dotColor}`}></span>
              <span className="font-medium">{stockStatus.label}</span>
            </div>

            {/* Special Order notice — set via Attribute Studio, shows the admin's note */}
            {(selectedProduct?.special_order || (selectedProduct?.stock_status || '').toLowerCase() === 'special_order') && (
              <div className="flex items-start gap-2.5 rounded-lg border border-blue-200 bg-blue-50 px-3.5 py-2.5" data-testid="special-order-notice">
                <Clock className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
                <div className="text-sm text-blue-800">
                  <span className="font-semibold">Special order item.</span>{' '}
                  {selectedProduct?.special_order_note || 'Typically delivered in 2–3 weeks.'}
                </div>
              </div>
            )}

            {/* Product Selector for Material/Tool collections */}
            {isMaterialCollection && (
              <div data-testid="material-product-selector">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Product: <span className="font-normal text-gray-500">
                    {materialProductOptions[selectedMaterialProduct]?.label || 'Select a product'}
                  </span>
                </label>
                <div className="flex flex-col gap-2">
                  {materialProductOptions.map((opt) => (
                    <button
                      key={opt.index}
                      onClick={() => setSelectedMaterialProduct(opt.index)}
                      data-testid={`material-product-${opt.index}`}
                      className={`text-left px-4 py-3 rounded-lg border text-sm font-medium transition ${
                        selectedMaterialProduct === opt.index
                          ? 'border-amber-500 bg-amber-50 text-amber-700'
                          : 'border-gray-300 hover:border-gray-400 text-gray-700'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Color Selector — hidden for material collections */}
            {!isMaterialCollection && colorOptions.length > 0 && (
              <div>
                <label className="block text-base font-semibold text-gray-800 mb-2" data-testid="variant-row-label">
                  {variantRowLabel}: <span className={`font-normal ${selectedColor ? 'text-gray-500' : 'text-amber-600'}`}>
                    {selectedColor ? formatColorName(selectedColor) : 'Please select'}
                  </span>
                </label>
                <div className="flex flex-wrap gap-3">
                  {colorOptions.map((color) => {
                    // NOTE: Variants are ALWAYS shown — they are top-level navigation within a
                    // collection. Clicking a variant auto-switches finish/size via the
                    // `availableFinishesForColor` effect (see useEffect at ~line 893).
                    return (
                    <button
                      key={color.name}
                      onClick={() => {
                        userClickedRef.current = 'color';
                        setSelectedColor(color.name);
                        setSelectedStyle(null); // Reset pattern when colour changes
                      }}
                      className={`relative group flex flex-col items-center ${
                        selectedColor === color.name 
                          ? 'ring-2 ring-amber-500 ring-offset-2' 
                          : 'hover:ring-2 hover:ring-gray-300 hover:ring-offset-1'
                      } rounded-lg overflow-visible transition-all cursor-pointer`}
                      title={formatColorName(color.name)}
                    >
                      {color.image ? (
                        <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-lg overflow-hidden">
                          <img
                            src={color.image}
                            alt={formatColorName(color.name)}
                            className="w-full h-full object-cover"
                            loading="lazy"
                            onError={(e) => {
                              // Production has had broken swatch URLs from
                              // an old CDN migration. 2-stage fallback:
                              //   1) Try the placeholder asset
                              //   2) Hide image, show coloured square w/ initials
                              // Without this we get the broken-image icon
                              // sitting next to a perfectly working text label.
                              if (!e.target.dataset.fallbackTried) {
                                e.target.dataset.fallbackTried = '1';
                                e.target.src = '/images/swatch-placeholder.svg';
                              } else {
                                e.target.style.display = 'none';
                                const parent = e.target.parentElement;
                                if (parent && !parent.dataset.placeholderApplied) {
                                  parent.dataset.placeholderApplied = '1';
                                  // Use the colour's own hex if we have it,
                                  // otherwise a neutral gradient.
                                  if (color.hex) {
                                    parent.style.backgroundColor = color.hex;
                                  } else {
                                    parent.classList.add('bg-gradient-to-br', 'from-gray-100', 'to-gray-200');
                                  }
                                  parent.classList.add('flex', 'items-center', 'justify-center', 'border', 'border-gray-200');
                                  const span = document.createElement('span');
                                  span.className = 'text-xs text-gray-500 font-semibold uppercase tracking-wide';
                                  span.textContent = (color.name || 'Variant').slice(0, 2).toUpperCase();
                                  parent.appendChild(span);
                                }
                              }
                            }}
                          />
                        </div>
                      ) : (
                        <div 
                          className="w-24 h-24 sm:w-28 sm:h-28 rounded-lg border border-gray-200 flex items-center justify-center px-1"
                          style={{ backgroundColor: color.hex }}
                        >
                          <span className={`text-xs font-semibold text-center leading-tight break-words ${hexIsDark(color.hex) ? 'text-white' : 'text-gray-600'}`}>
                            {formatColorName(color.name)}
                          </span>
                        </div>
                      )}
                      {selectedColor === color.name && (
                        <div className="absolute top-0 left-0 right-0 flex items-center justify-center bg-black/20 rounded-lg aspect-square">
                          <Check className="w-7 h-7 text-white" />
                        </div>
                      )}
                      <span className={`text-sm mt-1 ${selectedColor === color.name ? 'text-amber-600 font-medium' : 'text-gray-500'}`}>
                        {formatColorName(color.name)}
                      </span>
                    </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Finish Selector — hidden for material collections */}
            {!isMaterialCollection && hasFinishes && finishOptions.length > 0 && (
              <div>
                <label className="block text-base font-semibold text-gray-800 mb-2">
                  Finish: <span className={`font-normal ${selectedFinish ? 'text-gray-500' : 'text-amber-600'}`}>
                    {selectedFinish ? selectedFinish.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bR(\d+)\b/gi, (_, n) => `R${n}`) : 'Please select'}
                  </span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {finishOptions.map((finish) => {
                    const notInCurrentColor = availableFinishesForColor !== null && !availableFinishesForColor.has(finish);
                    // Hide finishes not available for the selected colour
                    if (notInCurrentColor) return null;
                    return (
                    <button
                      key={finish}
                      onClick={() => {
                        userClickedRef.current = 'finish';
                        setSelectedFinish(finish);
                        setSelectedStyle(null); // Reset pattern when finish changes
                      }}
                      className={`px-5 py-2.5 rounded-lg border text-base font-medium transition ${
                        selectedFinish === finish
                          ? 'border-amber-500 bg-amber-50 text-amber-700'
                          : 'border-gray-300 hover:border-gray-400 text-gray-700'
                      }`}
                    >
                      {finish.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bR(\d+)\b/gi, (_, n) => `R${n}`)}
                    </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Style/Pattern Selector — only shows when products share colour+finish+size */}
            {styleOptions.length > 1 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {styleSelectorLabel}: <span className={`font-normal ${selectedStyle ? 'text-gray-500' : 'text-amber-600'}`}>
                    {selectedStyle || 'Please select'}
                  </span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {styleOptions.map((style) => (
                    <button
                      key={style}
                      onClick={() => {
                        userClickedRef.current = 'style';
                        setSelectedStyle(style);
                      }}
                      className={`px-5 py-2.5 rounded-lg border text-base font-medium transition ${
                        selectedStyle === style
                          ? 'border-amber-500 bg-amber-50 text-amber-700'
                          : 'border-gray-300 hover:border-gray-400 text-gray-700'
                      }`}
                      data-testid={`style-option-${style.toLowerCase()}`}
                    >
                      {style}
                    </button>
                  ))}
                </div>
              </div>
            )}


            {/* Size Selector with Price Labels — only show sizes available in current color+finish */}
            {!isMaterialCollection && allSizes.length > 0 && (() => {
              // Compute proportional pill dimensions for the visible sizes
              const visibleSizes = allSizes.filter((s) => availableSizes.includes(s));
              const pillDims = computePillDims(visibleSizes);
              const dimMap = new Map(visibleSizes.map((s, i) => [s, pillDims[i]]));
              // Actual physical size of the currently selected tile (mm)
              const selectedDimsMm = selectedSize ? parseSizeToMm(selectedSize) : null;
              // Cap the on-screen 1:1 canvas to the available column width (~530px ≈ 140mm)
              // 1mm in CSS = 96/25.4 ≈ 3.78px. Caps in mm that fit the right column.
              const MAX_VIEW_W_MM = 140;
              const MAX_VIEW_H_MM = 110;
              // Orient long side horizontal so wide tiles read as wide on screen
              const tileMm = selectedDimsMm
                ? [Math.max(selectedDimsMm[0], selectedDimsMm[1]), Math.min(selectedDimsMm[0], selectedDimsMm[1])]
                : null;
              let displayW = tileMm ? tileMm[0] : 0;
              let displayH = tileMm ? tileMm[1] : 0;
              let scaleNote = '1:1 actual size';
              if (tileMm) {
                const scaleX = MAX_VIEW_W_MM / tileMm[0];
                const scaleY = MAX_VIEW_H_MM / tileMm[1];
                const scale = Math.min(1, scaleX, scaleY);
                if (scale < 1) {
                  displayW = tileMm[0] * scale;
                  displayH = tileMm[1] * scale;
                  scaleNote = `~${Math.round(scale * 100)}% scale (capped to fit screen)`;
                }
              }
              const labelLong = tileMm ? tileMm[0] : 0;
              const labelShort = tileMm ? tileMm[1] : 0;
              const printUrl = selectedSize
                ? `/shop/tile-scale-print/${encodeURIComponent(selectedSize)}?series=${encodeURIComponent(seriesName || '')}${selectedFinish ? `&color=${encodeURIComponent(selectedFinish)}` : ''}${isTrade ? '&trade=Trade%20Customer' : ''}&print=1`
                : null;
              return (
              <div>
                <label className="block text-base font-semibold text-gray-800 mb-2">
                  Size: <span className={`font-normal ${selectedSize ? 'text-gray-500' : 'text-amber-600'}`}>
                    {selectedSize ? formatSizeDual(selectedSize) : 'Please select'}
                  </span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  {allSizes.map((size) => {
                    const inCurrentFinish = availableSizes.includes(size);
                    // Hide ALL sizes not available in the current color+finish selection
                    if (!inCurrentFinish) return null;
                    const price = getPriceForSize(size);
                    const sizeUnit = getProductForSize(size)?.pricing_unit === 'unit' || !isSurfaceProduct ? 'each' : 'm\u00B2';
                    const dim = dimMap.get(size);
                    const isSelected = selectedSize === size;
                    // Proportional sizing — falls back to default fixed pill if size doesn't parse
                    const proportional = !!dim;
                    const style = proportional ? { width: `${dim.w}px`, height: `${dim.h}px` } : undefined;
                    const tight = proportional && (dim.w < 80 || dim.h < 50);
                    return (
                    <button
                      key={size}
                      data-testid={`size-pill-${size}`}
                      onClick={() => {
                        setSelectedSize(size);
                      }}
                      style={style}
                      title={`${size}${price !== null ? ` — \u00A3${price.toFixed(2)}/${sizeUnit}` : ''}`}
                      className={`flex flex-col items-center justify-center rounded-lg border font-medium transition flex-shrink-0 ${
                        proportional ? 'px-1 py-1' : 'px-5 py-3 min-w-[110px]'
                      } ${
                        isSelected
                          ? 'border-amber-500 border-2 bg-amber-50 text-amber-700 shadow-sm'
                          : 'border-gray-300 hover:border-amber-400 hover:shadow-sm text-gray-700'
                      }`}
                    >
                      <span className={tight ? 'text-xs leading-tight font-semibold' : proportional ? 'text-sm leading-tight font-semibold' : 'text-base'}>
                        {size}
                      </span>
                      {!tight && sizeToCm(size) && (
                        <span className={`${proportional ? 'text-[10px]' : 'text-xs'} ${isSelected ? 'text-amber-500' : 'text-gray-400'} leading-tight`}>
                          ({sizeToCm(size)})
                        </span>
                      )}
                      {price !== null && (
                        <span className={`${tight ? 'text-[10px] mt-0.5' : proportional ? 'text-[11px] mt-0.5' : 'text-sm mt-0.5'} ${isSelected ? 'text-amber-600' : 'text-gray-400'}`}>
                          {'\u00A3'}{price.toFixed(2)}/{sizeUnit}
                        </span>
                      )}
                    </button>
                    );
                  })}
                </div>

                {/* Actual-size toggle + Print PDF — only for tiles with parseable dimensions */}
                {selectedDimsMm && (
                  <div className="mt-3 p-2.5 bg-gray-50 border border-gray-200 rounded-lg flex items-center justify-between gap-3 flex-wrap">
                    <button
                      type="button"
                      data-testid="actual-size-toggle"
                      onClick={() => setShowActualSize((v) => !v)}
                      className="flex items-center gap-2.5 text-left flex-1 min-w-0"
                    >
                      <span
                        className={`relative inline-block w-10 h-5 rounded-full transition flex-shrink-0 ${
                          showActualSize ? 'bg-amber-500' : 'bg-gray-300'
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${
                            showActualSize ? 'translate-x-5' : ''
                          }`}
                        ></span>
                      </span>
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold text-gray-800">Show actual size</span>
                        <span className="block text-[10px] text-gray-500 leading-tight">
                          {showActualSize
                            ? 'Hold a credit card (85.6mm wide) to your screen to verify scale'
                            : 'See this tile at its real-world dimensions on screen'}
                        </span>
                      </span>
                    </button>
                    {printUrl && (
                      <a
                        href={printUrl}
                        target="_blank"
                        rel="nofollow noopener noreferrer"
                        data-testid="download-scale-pdf-btn"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-gray-300 rounded-md hover:border-amber-500 hover:text-amber-600 transition flex-shrink-0 bg-white"
                      >
                        <Printer className="w-3.5 h-3.5" />
                        Download to-scale PDF
                      </a>
                    )}
                  </div>
                )}

                {/* 1:1 actual-size canvas */}
                {showActualSize && selectedDimsMm && (
                  <div
                    data-testid="actual-size-canvas"
                    className="mt-3 p-4 bg-gray-50 border border-dashed border-gray-300 rounded-lg overflow-auto group/canvas relative"
                    style={{ minHeight: '120px' }}
                  >
                    <div className="relative mx-auto flex-shrink-0" style={{ width: `${displayW}mm`, height: `${displayH}mm` }}>
                      <div
                        className="w-full h-full flex items-center justify-center text-gray-400 font-semibold tracking-wider"
                        style={{
                          background: 'linear-gradient(135deg, #f3efe7 0%, #e8e1d3 100%)',
                          border: '1px solid #999',
                          boxShadow: '0 4px 16px rgba(0,0,0,.08)',
                          fontSize: '11px',
                        }}
                      >
                        {(seriesName || 'Tile').toUpperCase()} · {selectedSize}
                      </div>
                      <div
                        className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/75 text-white font-mono"
                        style={{ fontSize: '9px', letterSpacing: '0.05em' }}
                      >
                        {scaleNote}
                      </div>
                      {/* width dimension */}
                      <div className="absolute -bottom-5 left-0 right-0 border-t border-gray-400 text-center font-mono text-[10px] text-gray-500">
                        <span className="bg-gray-50 px-1.5 -translate-y-2 inline-block">{labelLong} mm</span>
                      </div>
                      {/* height dimension */}
                      <div className="absolute top-0 bottom-0 -right-6 border-r border-gray-400 font-mono text-[10px] text-gray-500" style={{ width: '1px' }}>
                        <span className="absolute top-1/2 -translate-y-1/2 left-1.5 bg-gray-50 px-0.5" style={{ writingMode: 'vertical-rl' }}>
                          {labelShort} mm
                        </span>
                      </div>
                    </div>

                    {/* Free sample CTA — overlay fades in on hover/touch */}
                    {selectedProduct && (() => {
                      const inSamples = isInSamples(selectedProduct.id);
                      const limitReached = !inSamples && sampleCount >= maxSamples;
                      // Trade Bundle Booster: enabled for logged-in trade with FBT essentials available
                      const tradeKitEnabled = isTrade && fbtItems.length > 0 && !inSamples && !limitReached;
                      const kitSize = Math.min(maxSamples - sampleCount, 1 + Math.min(fbtItems.length, 2));
                      return (
                        <div className="absolute inset-x-3 bottom-3 flex justify-center pointer-events-none opacity-100 md:opacity-0 md:group-hover/canvas:opacity-100 focus-within:opacity-100 transition-opacity duration-200">
                          {inSamples ? (
                            <Link
                              to="/shop/sample-cart"
                              data-testid="sample-cart-link"
                              className="pointer-events-auto inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-full shadow-lg transition"
                            >
                              <Check className="w-3.5 h-3.5" />
                              In your sample basket — view ({sampleCount}/{maxSamples})
                            </Link>
                          ) : limitReached ? (
                            <Link
                              to="/shop/sample-cart"
                              data-testid="sample-cart-full-link"
                              className="pointer-events-auto inline-flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-800 text-white text-xs font-semibold rounded-full shadow-lg transition"
                            >
                              Sample basket full ({maxSamples}/{maxSamples}) — review
                            </Link>
                          ) : tradeKitEnabled ? (
                            <button
                              type="button"
                              data-testid="trade-bundle-booster-cta"
                              onClick={handleAddTradeKit}
                              title={`Adds tile + matching ${fbtItems.slice(0, 2).map(i => (i.display_name || i.name)).join(' + ')}`}
                              className="pointer-events-auto inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-amber-600 to-amber-500 hover:from-amber-700 hover:to-amber-600 text-white text-xs font-semibold rounded-full shadow-lg transition transform hover:-translate-y-0.5"
                            >
                              <Mail className="w-3.5 h-3.5" />
                              Send me a free trade kit ({kitSize} samples — tile + adhesive + grout) →
                            </button>
                          ) : (
                            canShowLegacySampleCTA && (
                            <button
                              type="button"
                              data-testid="order-free-sample-cta"
                              onClick={handleAddSample}
                              className="pointer-events-auto inline-flex items-center gap-2 px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white text-xs font-semibold rounded-full shadow-lg transition transform hover:-translate-y-0.5"
                            >
                              <Mail className="w-3.5 h-3.5" />
                              Order a free sample of this exact size →
                            </button>
                            )
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
              );
            })()}

            {/* Tier Pricing Table — hidden for pallet-only lines (no per-m² buying) */}
            {!palletOnly && (
            <VolumePricingTable
              tierPricing={tierPricing}
              isSurfaceProduct={sellsPerM2}
              isTrade={isTrade}
              tradeDiscount={getEffTradePct()}
              selectedProduct={selectedProduct}
              getEffectiveSqmQuantity={getEffectiveSqmQuantity}
            />
            )}

            {/* Price Display - removed "From" section as it was confusing */}
            {/* Price will be shown in the quantity/total section below */}

            {/* Trade Customer Box - PROTECTED COMPONENT */}
            <TradeLoginBox isLoggedIn={isLoggedIn} />

            {/* Quantity, Price Total, Add to Cart - Moved up after Trade Box */}
            <div className="space-y-4">
              {/* Pallet Tier Selector — Half Pallet / Full Pallet chips
                  appear only when the tile has pallet rates set. Selecting
                  a tier auto-snaps qty to the matching minimum m² and
                  switches the £/m² rate. */}
              {(palletInfo.halfPalletAvailable || palletInfo.fullPalletAvailable) && !selectedProduct?._isPreview && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 pt-5" data-testid="pallet-tier-selector">
                  <div className="flex items-center gap-2 mb-3">
                    <Truck className="w-5 h-5 text-emerald-700" />
                    <span className="text-base font-semibold text-emerald-900">{palletOnly ? 'Sold by the pallet only' : 'Bulk pricing options'}</span>
                    {isTrade && <span className="text-xs font-semibold text-emerald-700">ex VAT</span>}
                  </div>
                  {palletOnly && (
                    <p className="text-xs text-emerald-800 -mt-2 mb-3" data-testid="pallet-only-notice">
                      This clearance line is available in {palletInfo.halfPalletAvailable && palletInfo.fullPalletAvailable ? 'half or full' : palletInfo.fullPalletAvailable ? 'full' : 'half'} pallets only — no individual {palletInfo.isUnit ? 'units' : 'm²'}.
                    </p>
                  )}
                  <div className={`grid gap-2 pt-1 ${[!palletOnly, palletInfo.halfPalletAvailable, palletInfo.fullPalletAvailable].filter(Boolean).length === 3 ? 'grid-cols-3' : [!palletOnly, palletInfo.halfPalletAvailable, palletInfo.fullPalletAvailable].filter(Boolean).length === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    {!palletOnly && (
                    <button
                      type="button"
                      data-testid="pallet-tier-m2"
                      onClick={() => setPricingTier('m2')}
                      className={`w-full px-2 py-2.5 rounded-xl text-sm sm:text-base font-bold border-2 transition-colors ${
                        pricingTier === 'm2'
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                      }`}
                    >
                      {palletInfo.isUnit ? 'Per unit' : 'Per m²'}
                      <span className="block text-[11px] sm:text-sm font-medium opacity-90 mt-0.5 leading-tight">
                        £{(() => {
                          const b = Number(selectedProduct?.room_lot_price) || Number(selectedProduct?.price) || 0;
                          return (isTrade ? (b * (1 - getEffTradePct() / 100)) / 1.2 : b).toFixed(2);
                        })()}{palletInfo.isUnit ? ' each' : 'm²'}
                      </span>
                    </button>
                    )}
                    {palletInfo.halfPalletAvailable && (
                      <button
                        type="button"
                        data-testid="pallet-tier-half"
                        onClick={() => setPricingTier('half_pallet')}
                        className={`relative w-full px-2 py-2.5 rounded-xl text-sm sm:text-base font-bold border-2 transition-colors ${
                          pricingTier === 'half_pallet'
                            ? 'bg-emerald-600 text-white border-emerald-600'
                            : 'bg-white text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                        }`}
                      >
                        {palletInfo.halfSavings > 0 && (
                          <span
                            className="absolute -top-2.5 right-1 bg-amber-500 text-white text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full shadow-sm pointer-events-none whitespace-nowrap"
                            data-testid="pallet-half-savings-badge"
                          >
                            {(() => { const s = isTrade ? palletInfo.halfSavings / 1.2 : palletInfo.halfSavings; return `Save £${s.toFixed(s < 10 ? 2 : 0)}`; })()}
                          </span>
                        )}
                        Half Pallet
                        <span className="block text-[11px] sm:text-sm font-medium opacity-90 mt-0.5 leading-tight">
                          £{(isTrade ? palletInfo.halfRate / 1.2 : palletInfo.halfRate).toFixed(2)}{palletInfo.rateSuffix} · min {palletInfo.halfM2} {palletInfo.qtyWord}
                        </span>
                      </button>
                    )}
                    {palletInfo.fullPalletAvailable && (
                      <button
                        type="button"
                        data-testid="pallet-tier-full"
                        onClick={() => setPricingTier('full_pallet')}
                        className={`relative w-full px-2 py-2.5 rounded-xl text-sm sm:text-base font-bold border-2 transition-colors ${
                          pricingTier === 'full_pallet'
                            ? 'bg-emerald-600 text-white border-emerald-600'
                            : 'bg-white text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                        }`}
                      >
                        {palletInfo.fullSavings > 0 && (
                          <span
                            className="absolute -top-2.5 right-1 bg-amber-500 text-white text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full shadow-sm pointer-events-none whitespace-nowrap"
                            data-testid="pallet-full-savings-badge"
                          >
                            {(() => { const s = isTrade ? palletInfo.fullSavings / 1.2 : palletInfo.fullSavings; return `Save £${s.toFixed(s < 10 ? 2 : 0)}`; })()}
                          </span>
                        )}
                        Full Pallet
                        <span className="block text-[11px] sm:text-sm font-medium opacity-90 mt-0.5 leading-tight">
                          £{(isTrade ? palletInfo.fullRate / 1.2 : palletInfo.fullRate).toFixed(2)}{palletInfo.rateSuffix} · min {palletInfo.fullM2} {palletInfo.qtyWord}
                        </span>
                      </button>
                    )}
                  </div>
                  {pricingTier !== 'm2' && (
                    <p className="text-sm text-emerald-700 mt-2.5" data-testid="pallet-tier-min-notice">
                      Minimum order:{' '}
                      <strong>
                        {pricingTier === 'full_pallet' ? palletInfo.fullM2 : palletInfo.halfM2} {palletInfo.qtyWord}
                      </strong>
                      . You can add more, but not less.
                    </p>
                  )}
                </div>
              )}

              {/* Dual Quantity Inputs - m² and Box side by side, always visible */}
              {sellsPerM2 && sqmPerBox ? (
                <div className="space-y-3">
                  {/* m² input */}
                  <div className="flex items-center gap-4 flex-wrap">
                    <span className="text-gray-600 min-w-[60px] text-sm font-medium">m²:</span>
                    <div className="flex items-center border-2 border-gray-200 rounded-xl overflow-hidden">
                      <button
                        onClick={() => {
                          // Respect pallet-tier minimum if set
                          const minQty = pricingTier === 'full_pallet'
                            ? palletInfo.fullM2
                            : pricingTier === 'half_pallet'
                              ? palletInfo.halfM2
                              : 1;
                          setQuantityUnit('sqm');
                          setQuantity(Math.max(minQty, (quantityUnit === 'sqm' ? quantity : Math.ceil(quantity * sqmPerBox)) - 1));
                        }}
                        className="p-3 hover:bg-gray-100 active:bg-gray-200 transition-colors"
                        data-testid="sqm-minus"
                      >
                        <Minus className="w-5 h-5" />
                      </button>
                      <input
                        type="number"
                        value={quantityUnit === 'sqm' ? quantity : Math.round(quantity * sqmPerBox * 100) / 100}
                        onChange={(e) => {
                          const minQty = pricingTier === 'full_pallet'
                            ? palletInfo.fullM2
                            : pricingTier === 'half_pallet'
                              ? palletInfo.halfM2
                              : 1;
                          const val = Math.max(minQty, parseFloat(e.target.value) || minQty);
                          setQuantityUnit('sqm');
                          setQuantity(val);
                        }}
                        className="w-20 text-center text-lg font-bold border-0 focus:ring-0"
                        min="1"
                        step="0.1"
                        data-testid="sqm-input"
                      />
                      <button
                        onClick={() => {
                          setQuantityUnit('sqm');
                          setQuantity((quantityUnit === 'sqm' ? quantity : Math.ceil(quantity * sqmPerBox)) + 1);
                        }}
                        className="p-3 hover:bg-gray-100 active:bg-gray-200 transition-colors"
                        data-testid="sqm-plus"
                      >
                        <Plus className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                  {/* Box input */}
                  <div className="flex items-center gap-4 flex-wrap">
                    <span className="text-gray-600 min-w-[60px] text-sm font-medium">Boxes:</span>
                    <div className="flex items-center border-2 border-gray-200 rounded-xl overflow-hidden">
                      <button
                        onClick={() => {
                          const minSqm = pricingTier === 'full_pallet'
                            ? palletInfo.fullM2
                            : pricingTier === 'half_pallet'
                              ? palletInfo.halfM2
                              : 0;
                          // m² floor → boxes floor (round up)
                          const minBoxes = minSqm > 0 && sqmPerBox > 0 ? Math.ceil(minSqm / sqmPerBox) : 1;
                          setQuantityUnit('box');
                          setQuantity(Math.max(minBoxes, (quantityUnit === 'box' ? quantity : Math.ceil(quantity / sqmPerBox)) - 1));
                        }}
                        className="p-3 hover:bg-gray-100 active:bg-gray-200 transition-colors"
                        data-testid="box-minus"
                      >
                        <Minus className="w-5 h-5" />
                      </button>
                      <input
                        type="number"
                        value={quantityUnit === 'box' ? quantity : Math.ceil(quantity / sqmPerBox)}
                        onChange={(e) => {
                          const val = Math.max(1, parseInt(e.target.value) || 1);
                          setQuantityUnit('box');
                          setQuantity(val);
                        }}
                        className="w-20 text-center text-lg font-bold border-0 focus:ring-0"
                        min="1"
                        data-testid="box-input"
                      />
                      <button
                        onClick={() => {
                          setQuantityUnit('box');
                          setQuantity((quantityUnit === 'box' ? quantity : Math.ceil(quantity / sqmPerBox)) + 1);
                        }}
                        className="p-3 hover:bg-gray-100 active:bg-gray-200 transition-colors"
                        data-testid="box-plus"
                      >
                        <Plus className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                /* Non-surface products: simple quantity input */
                <div className="flex items-center gap-4 flex-wrap">
                  <span className="text-gray-600 min-w-[60px]">Qty:</span>
                  <div className="flex items-center border-2 border-gray-200 rounded-xl overflow-hidden">
                    <button
                      onClick={() => {
                        const minQty = pricingTier === 'full_pallet'
                          ? palletInfo.fullM2
                          : pricingTier === 'half_pallet'
                            ? palletInfo.halfM2
                            : 1;
                        setQuantity(Math.max(minQty, quantity - 1));
                      }}
                      className="p-3 hover:bg-gray-100 active:bg-gray-200 transition-colors"
                      data-testid="qty-minus"
                    >
                      <Minus className="w-5 h-5" />
                    </button>
                    <input
                      type="number"
                      value={quantity}
                      onChange={(e) => {
                        const minQty = pricingTier === 'full_pallet'
                          ? palletInfo.fullM2
                          : pricingTier === 'half_pallet'
                            ? palletInfo.halfM2
                            : 1;
                        setQuantity(Math.max(minQty, parseFloat(e.target.value) || minQty));
                      }}
                      className="w-20 text-center text-lg font-bold border-0 focus:ring-0"
                      min="1"
                      step="0.1"
                      data-testid="qty-input"
                    />
                    <button
                      onClick={() => setQuantity(quantity + 1)}
                      className="p-3 hover:bg-gray-100 active:bg-gray-200 transition-colors"
                      data-testid="qty-plus"
                    >
                      <Plus className="w-5 h-5" />
                    </button>
                  </div>
                </div>
              )}
              
              {/* ENHANCED Price display - Larger, bolder, better hierarchy */}
              <div>
                {!selectedProduct?._isPreview && (
                  <div className="text-right flex-1 min-w-[200px]">
                    {/* Main Price - Large and bold */}
                    <div className="flex items-center justify-end gap-3 flex-wrap">
                      <span className={`text-3xl font-extrabold tracking-tight ${isOnSale ? 'text-red-600' : 'text-gray-900'}`}>
                        £{safeToFixed(displayPrice, 2)}
                        <span className="text-lg font-semibold text-gray-500">{priceUnit}</span>
                      </span>
                      {isTrade && <span className="text-[10px] text-gray-400 font-normal">ex. VAT</span>}
                      {/* Sale badge with animation */}
                      {totalCombinedDiscount > 0 && (
                        <span className={`text-sm font-bold px-3 py-1 rounded-full animate-pulse ${isOnSale ? 'bg-red-500 text-white' : 'bg-green-500 text-white'}`}>
                          Save {totalCombinedDiscount}%
                        </span>
                      )}
                    </div>
                    {/* WAS price for sale items */}
                    {isOnSale && displayOriginalPrice > displayPrice && (
                      <div className="text-base text-gray-400 line-through mt-1">
                        Was £{safeToFixed(displayOriginalPrice, 2)}{priceUnit}
                      </div>
                    )}
                    {/* Trade credit-back badge */}
                    {isTrade && Number(selectedProduct?.credit_back_rate ?? creditBackRate) > 0 && (
                      <div className="text-xs font-semibold text-emerald-600 mt-1" data-testid="pdp-credit-back-badge">
                        +{Number(selectedProduct?.credit_back_rate ?? creditBackRate)}% credit back on this item
                      </div>
                    )}
                    {/* Box price - smaller, secondary - only for per-m² surface products */}
                    {sellsPerM2 && (
                    <div className="text-sm text-gray-500 mt-1">
                      {boxesNeeded()} box{boxesNeeded() > 1 ? 'es' : ''} @ £{(sqmPerBox ? displayPrice * sqmPerBox : displayPrice).toFixed(2)}/box
                    </div>
                    )}
                    {/* Total - Large and prominent */}
                    <div className="mt-3 pt-3 border-t border-gray-200">
                      <div className="flex items-baseline justify-end gap-2">
                        <span className="text-sm text-gray-500">Total:</span>
                        <span className="text-2xl font-black text-gray-900">£{totalPrice}</span>
                      </div>
                      {/* Savings highlight */}
                      {totalCombinedDiscount > 0 && displayOriginalPrice > displayPrice && (
                        <div className="text-sm font-semibold text-green-600 mt-1 flex items-center justify-end gap-1">
                          <Check className="w-4 h-4" />
                          You save £{((displayOriginalPrice - displayPrice) * effectiveSqm).toFixed(2)}
                        </div>
                      )}
                      {/* Trade Discount Badge (trade users) - uses shared discountBreakdown */}
                      {isTrade && productTradeDiscount > 0 && discountBreakdown.tradeContrib > 0 && (
                        <div className="mt-2 flex justify-end" data-testid="product-trade-discount-badge">
                          <span className="text-xs font-medium text-blue-700 bg-blue-50 border border-blue-200 px-2 py-1 rounded-md">
                            Trade: {discountBreakdown.tradeContrib}% off
                          </span>
                        </div>
                      )}
                      {/* Credit Back Badge (trade users) - shows % and £ amount */}
                      {isTrade && creditBackRate > 0 && (
                        <div className="mt-2 flex justify-end" data-testid="product-credit-back-badge">
                          <span className="text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-md">
                            Extra {creditBackRate}% Credit Back (£{(parseFloat(totalPrice) * creditBackRate / 100).toFixed(2)})
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Coverage Info - only for per-m² surface products */}
              {sellsPerM2 && sqmPerBox && (
                <div className="text-sm text-gray-600 bg-gray-50 p-3 rounded-lg">
                  {quantityUnit === 'box' ? (
                    <span>
                      <strong>{quantity} box{quantity > 1 ? 'es' : ''}</strong> = <strong>{effectiveSqm.toFixed(2)} m²</strong> total coverage
                      <span className="text-gray-400 ml-1">({sqmPerBox} m² per box)</span>
                    </span>
                  ) : (
                    <span>
                      <strong>{quantity} m²</strong> → rounded up to <strong>{boxesNeeded()} box{boxesNeeded() > 1 ? 'es' : ''}</strong> = <strong>{effectiveSqm.toFixed(2)} m²</strong> actual coverage
                      <span className="text-gray-400 ml-1">({sqmPerBox} m² per box)</span>
                    </span>
                  )}
                </div>
              )}

              {/* Action Buttons */}
              <div className="space-y-3">
                {/* Show message if selections are incomplete */}
                {selectedProduct?._isPreview && isSurfaceProduct && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
                    Please select {[
                      colorOptions.length > 0 && !selectedColor ? variantRowLabel : null,
                      hasMultipleFinishes && finishOptions.length > 0 && !selectedFinish ? 'Finish' : null,
                      styleOptions.length > 1 && !selectedStyle ? styleSelectorLabel : null,
                      availableSizes.length > 0 && !selectedSize ? 'Size' : null
                    ].filter(Boolean).join(', ')} to continue
                  </div>
                )}
                
                <div className="flex flex-wrap gap-3">
                  {/* ENHANCED Add to Cart Button with micro-interactions */}
                  <Button
                    onClick={handleAddToCart}
                    data-testid="add-to-cart-btn"
                    className={`flex-1 py-4 rounded-xl font-bold text-lg flex items-center justify-center gap-3 transition-all duration-300 transform ${
                      selectedProduct?._isPreview 
                        ? 'bg-gray-300 cursor-not-allowed text-gray-500' 
                        : cartAdded 
                          ? 'bg-green-500 text-white scale-[1.02]' 
                          : isAddingToCart 
                            ? 'bg-amber-400 text-white' 
                            : 'bg-amber-500 hover:bg-amber-600 hover:scale-[1.02] hover:shadow-lg active:scale-[0.98] text-white shadow-md'
                    }`}
                    disabled={stockStatus.label === 'Out of Stock' || selectedProduct?._isPreview || isAddingToCart}
                  >
                    {isAddingToCart ? (
                      <>
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        Adding...
                      </>
                    ) : cartAdded ? (
                      <>
                        <Check className="w-6 h-6" />
                        Added to Cart!
                      </>
                    ) : (
                      <>
                        <ShoppingCart className="w-6 h-6" />
                        Add to Cart
                      </>
                    )}
                  </Button>
                  {isSurfaceProduct && canShowSampleButton && (
                    <OrderSampleButton
                      product={selectedProduct}
                      globalEnabled={sampleServiceEnabled}
                      buttonClassName="px-5 py-4 rounded-xl shadow-sm"
                      buttonLabel="Order Sample"
                    />
                  )}
                  <Button
                    onClick={() => toggleWishlist(selectedProduct)}
                    variant="outline"
                    className={`px-5 py-4 border-2 rounded-xl transition-all duration-200 ${
                      isInWishlist(selectedProduct?.id) 
                        ? 'border-red-500 text-red-500 bg-red-50' 
                        : 'border-gray-300 hover:border-red-500 hover:bg-red-50'
                    }`}
                    title="Add to Wishlist"
                    disabled={selectedProduct?._isPreview}
                  >
                    <Heart className={`w-5 h-5 transition-transform duration-200 ${isInWishlist(selectedProduct?.id) ? 'fill-current scale-110' : 'hover:scale-110'}`} />
                  </Button>
                  {/* Pinterest save — pin opens in a new window. Rich Pin
                      meta on this PDP means the resulting pin gets price
                      + availability auto-attached by Pinterest's crawler. */}
                  {selectedProduct && !selectedProduct?._isPreview && normaliseImageUrl(firstImageUrl(selectedProduct.images)) && (
                    <PinterestSaveButton
                      url={typeof window !== 'undefined' ? window.location.href : ''}
                      media={normaliseImageUrl(firstImageUrl(selectedProduct.images))}
                      description={`${selectedProduct.display_name || selectedProduct.name || ''} — Tile Station UK`.slice(0, 480)}
                      size="md"
                      label="Save"
                      className="px-5 py-3.5 rounded-xl"
                    />
                  )}
                </div>
              </div>
            </div>

            {/* Collection Description - MOBILE ONLY (shown after Add to Cart) */}
            <div className="lg:hidden">
            {selectedProduct && (() => {
              const savedDescription = (descriptionSource === 'custom' && collectionDescription.trim())
                || (selectedProduct.description || '').trim()
                || (collectionDescription || '').trim();
              if (savedDescription) {
                const rawText = savedDescription;
                let paragraphs;
                if (rawText.includes('\n')) {
                  paragraphs = rawText.split(/\n+/).filter(p => p.trim());
                } else {
                  const sentences = rawText.match(/[^.!?]+[.!?]+/g) || [rawText];
                  paragraphs = [];
                  for (let i = 0; i < sentences.length; i += 3) {
                    paragraphs.push(sentences.slice(i, i + 3).join('').trim());
                  }
                }
                return (
                  <div className="bg-white border border-gray-200 rounded-lg p-5" data-testid="product-description-mobile">
                    <h3 className="font-semibold text-gray-900 mb-3 text-base">About This Product</h3>
                    <div className="text-sm text-gray-600 leading-relaxed space-y-3">
                      {paragraphs.map((para, idx) => (
                        <RenderProductDescription key={idx} text={para} />
                      ))}
                    </div>
                  </div>
                );
              }
              const p = selectedProduct;
              const series = decodedSeriesName;
              const material = p.material || p.attributes?.material || '';
              const suitability = p.suitability || p.attributes?.suitability || '';
              const slipRating = p.slip_rating || p.attributes?.slip_rating || '';
              const thickness = p.thickness || p.attributes?.thickness || '';
              const edge = p.edge || p.attributes?.edge || '';
              const madeIn = p.made_in || '';
              const rooms = p.rooms || [];
              const styles = p.styles || [];
              const features = p.features || [];
              const sizeLabelsM = dedupeSizeLabels(allSizes);
              const indoorSizes = sizeLabelsM.filter(s => (s.match(/x/gi) || []).length < 2);
              const outdoorSizes = sizeLabelsM.filter(s => (s.match(/x/gi) || []).length >= 2);
              const hasIndoor = indoorSizes.length > 0;
              const hasOutdoor = outdoorSizes.length > 0;
              const collectionColors = colorOptions.map(c => c.name);
              const collectionFinishes = finishOptions;
              const sentences = [];
              const suitDesc = suitability === 'wall-floor' ? 'walls and floors' : suitability === 'wall' ? 'walls' : suitability === 'floor' ? 'floors' : '';
              const materialDesc = material ? `${material.charAt(0).toUpperCase() + material.slice(1).toLowerCase()}` : 'Porcelain';
              let intro = `The ${series} collection`;
              if (collectionColors.length > 0) intro += ` is available in ${collectionColors.length} colour${collectionColors.length > 1 ? 's' : ''} including ${collectionColors.slice(0, 3).join(', ')}`;
              if (collectionColors.length > 3) intro += ` and more`;
              intro += '.';
              sentences.push(intro);
              if (materialDesc || suitDesc) {
                let matSentence = `Made from ${materialDesc.toLowerCase()}`;
                if (suitDesc) matSentence += `, suitable for ${suitDesc}`;
                if (hasOutdoor) matSentence += ' including outdoor spaces';
                matSentence += '.';
                sentences.push(matSentence);
              }
              if (thickness) sentences.push(`Each tile is ${thickness}mm thick${edge ? ` with a ${edge.toLowerCase()} edge` : ''}.`);
              if (slipRating) sentences.push(`Slip rating: ${slipRating.toUpperCase()}.`);
              if (rooms.length > 0) sentences.push(`Ideal for ${rooms.join(', ').toLowerCase()}.`);
              if (styles.length > 0) sentences.push(`Style: ${styles.join(', ')}.`);
              if (features.length > 0) sentences.push(`Notable features include ${features.join(', ').toLowerCase()}.`);
              if (madeIn) sentences.push(`Manufactured in ${madeIn}.`);
              return (
                <div className="bg-white border border-gray-200 rounded-lg p-5" data-testid="product-description-mobile">
                  <h3 className="font-semibold text-gray-900 mb-3 text-base">About This Product</h3>
                  <p className="text-sm text-gray-600 leading-relaxed">{sentences.join(' ')}</p>
                </div>
              );
            })()}
            </div>

            {/* Delivery Estimate Section - Controlled by admin settings.
                Hidden for products with a mandatory delivery charge (would be misleading). */}
            {(pageSettings?.deliveryEstimate?.enabled !== false) && !selectedProduct?.delivery_charge_required && (() => {
              const isNextDay = pageSettings?.nextDayDelivery?.enabled && 
                pageSettings?.nextDayDelivery?.suppliers?.includes(selectedProduct?.supplier);
              return (
            <div className={`border rounded-xl p-4 ${isNextDay ? 'bg-gradient-to-r from-green-50 to-emerald-50 border-green-200' : 'bg-gray-50 border-gray-200'}`}>
              <div className="flex items-start gap-3">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${isNextDay ? 'bg-green-100' : 'bg-gray-200'}`}>
                  <Truck className={`w-5 h-5 ${isNextDay ? 'text-green-600' : 'text-gray-500'}`} />
                </div>
                <div className="flex-1">
                  {isNextDay ? (
                    <>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-green-800">Next Day Delivery Available</span>
                        <span className="text-xs bg-green-200 text-green-800 px-2 py-0.5 rounded-full font-medium">
                          FREE over £{pageSettings?.deliveryEstimate?.freeDeliveryThreshold || 499}
                        </span>
                      </div>
                      
                      {/* Countdown Timer */}
                      {(pageSettings?.deliveryEstimate?.showCountdown !== false) && (
                      <div className="mt-2 flex items-center gap-2 flex-wrap">
                        <Clock className="w-4 h-4 text-green-600" />
                        <span className="text-sm text-green-700">Order within</span>
                        <div className="flex items-center gap-1">
                          <span className="bg-green-600 text-white px-2 py-0.5 rounded font-mono font-bold text-sm">
                            {String(deliveryCountdown.hours).padStart(2, '0')}
                          </span>
                          <span className="text-green-600 font-bold">:</span>
                          <span className="bg-green-600 text-white px-2 py-0.5 rounded font-mono font-bold text-sm">
                            {String(deliveryCountdown.minutes).padStart(2, '0')}
                          </span>
                          <span className="text-green-600 font-bold">:</span>
                          <span className="bg-green-600 text-white px-2 py-0.5 rounded font-mono font-bold text-sm">
                            {String(deliveryCountdown.seconds).padStart(2, '0')}
                          </span>
                        </div>
                        <span className="text-sm text-green-700">for next-day dispatch</span>
                      </div>
                      )}
                    </>
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-gray-800">Delivery Information</span>
                      <span className="text-xs bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full font-medium">
                        FREE over £{pageSettings?.deliveryEstimate?.freeDeliveryThreshold || 499}
                      </span>
                    </div>
                  )}
                  
                  {/* Delivery Options */}
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="flex items-center gap-1.5 text-gray-600">
                      <Check className={`w-3.5 h-3.5 ${isNextDay ? 'text-green-500' : 'text-gray-400'}`} />
                      <span>Standard: {pageSettings?.deliveryEstimate?.standardDays || '2-3'} days</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-gray-600">
                      <Check className={`w-3.5 h-3.5 ${isNextDay ? 'text-green-500' : 'text-gray-400'}`} />
                      <span>Express: {pageSettings?.deliveryEstimate?.expressDays || 'Next day'}</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-gray-600">
                      <MapPin className={`w-3.5 h-3.5 ${isNextDay ? 'text-green-500' : 'text-gray-400'}`} />
                      <span>UK Mainland only</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-gray-600">
                      <Truck className={`w-3.5 h-3.5 ${isNextDay ? 'text-green-500' : 'text-gray-400'}`} />
                      <span>Pallet delivery</span>
                    </div>
                  </div>
                  {deliveryTerms && (
                    <p className="text-[10px] text-gray-400 mt-2 leading-snug" data-testid="pdp-delivery-terms">{deliveryTerms}</p>
                  )}
                </div>
              </div>
            </div>
              );
            })()}


            {/* Share Buttons - compact, stays in right column */}
            {(pageSettings?.shareButtons?.enabled !== false) && (
            <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl">
              <span className="text-sm font-medium text-gray-600">Share:</span>
              <div className="flex gap-2">
                {(pageSettings?.shareButtons?.platforms?.facebook !== false) && (
                <button
                  onClick={() => {
                    const url = window.location.href;
                    window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`, '_blank', 'width=600,height=400');
                  }}
                  className="w-9 h-9 bg-blue-600 hover:bg-blue-700 text-white rounded-full flex items-center justify-center transition-colors"
                  title="Share on Facebook"
                >
                  <Facebook className="w-4 h-4" />
                </button>
                )}
                {(pageSettings?.shareButtons?.platforms?.whatsapp !== false) && (
                <button
                  onClick={() => {
                    const url = window.location.href;
                    const text = `Check out ${selectedProduct?.display_name || decodedSeriesName} tiles!`;
                    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(text + ' ' + url)}`, '_blank');
                  }}
                  className="w-9 h-9 bg-green-500 hover:bg-green-600 text-white rounded-full flex items-center justify-center transition-colors"
                  title="Share on WhatsApp"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                </button>
                )}
                {(pageSettings?.shareButtons?.platforms?.email !== false) && (
                <button
                  onClick={() => {
                    const url = window.location.href;
                    const subject = `Check out these tiles: ${selectedProduct?.display_name || decodedSeriesName}`;
                    window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent('I found these amazing tiles: ' + url)}`;
                  }}
                  className="w-9 h-9 bg-gray-600 hover:bg-gray-700 text-white rounded-full flex items-center justify-center transition-colors"
                  title="Share via Email"
                >
                  <Mail className="w-4 h-4" />
                </button>
                )}
                {(pageSettings?.shareButtons?.platforms?.copyLink !== false) && (
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(window.location.href);
                    toast.success('Link copied to clipboard!');
                  }}
                  className="w-9 h-9 bg-gray-400 hover:bg-gray-500 text-white rounded-full flex items-center justify-center transition-colors"
                  title="Copy Link"
                >
                  <Copy className="w-4 h-4" />
                </button>
                )}
              </div>
            </div>
            )}

          </div>
        </div>
      </div>

      {/* ═══ Full-Width Product Information Tabs ═══ */}
      <div className="max-w-7xl mx-auto px-4 pb-8" data-testid="product-info-tabs">
        {/* Tab Navigation */}
        <div className="flex border-b border-gray-200 overflow-x-auto">
          {[
            { id: 'specs', label: 'Specifications', icon: <Ruler className="w-4 h-4" /> },
            ...(isSurfaceProduct ? [{ id: 'calculator', label: 'Room Calculator', icon: <Calculator className="w-4 h-4" /> }] : []),
            ...(isSurfaceProduct ? [{ id: 'installation', label: 'Installation', icon: <Wrench className="w-4 h-4" /> }] : []),
            ...(isSurfaceProduct ? [{ id: 'maintenance', label: 'Care & Maintenance', icon: <Droplet className="w-4 h-4" /> }] : []),
            { id: 'delivery', label: 'Delivery', icon: <Truck className="w-4 h-4" /> },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setOpenAccordions(prev => ({ ...prev, activeTab: tab.id }))}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                (openAccordions.activeTab || 'specs') === tab.id
                  ? 'border-amber-500 text-amber-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
              data-testid={`tab-${tab.id}`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="bg-white border border-t-0 border-gray-200 rounded-b-xl p-6">

          {/* Specifications Tab */}
          {(openAccordions.activeTab || 'specs') === 'specs' && (() => {
            const flo = selectedProduct?.field_label_overrides || {};
            const specLabel = (k, fb) => flo[k] || fb;
            return (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6" data-testid="tab-content-specs">
              {selectedProduct?.size && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <span className="text-xs text-gray-400 uppercase tracking-wider">{specLabel('size', 'Size')}</span>
                  <p className="font-semibold text-gray-900 mt-1">{formatSizeDual(selectedProduct.size)}</p>
                </div>
              )}
              {getProductFinishes(selectedProduct || {}).length > 0 && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <span className="text-xs text-gray-400 uppercase tracking-wider">{specLabel('finish', 'Finish')}</span>
                  <p className="font-semibold text-gray-900 mt-1 capitalize">{getProductFinishes(selectedProduct).join(', ')}</p>
                </div>
              )}
              {(selectedProduct?.material || selectedProduct?.attributes?.material) && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <span className="text-xs text-gray-400 uppercase tracking-wider">{specLabel('material', 'Material')}</span>
                  <p className="font-semibold text-gray-900 mt-1">{selectedProduct.material || selectedProduct.attributes?.material}</p>
                </div>
              )}
              {(selectedProduct?.thickness || selectedProduct?.attributes?.thickness) && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <span className="text-xs text-gray-400 uppercase tracking-wider">{specLabel('thickness', 'Thickness')}</span>
                  <p className="font-semibold text-gray-900 mt-1">{selectedProduct.thickness || selectedProduct.attributes?.thickness}</p>
                </div>
              )}
              {(selectedProduct?.suitability || selectedProduct?.attributes?.suitability) && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <span className="text-xs text-gray-400 uppercase tracking-wider">{specLabel('suitability', 'Suitability')}</span>
                  <p className="font-semibold text-gray-900 mt-1">{(selectedProduct.suitability || selectedProduct.attributes?.suitability || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' & ')}</p>
                </div>
              )}
              {(selectedProduct?.slip_rating || selectedProduct?.attributes?.slip_rating) && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <span className="text-xs text-gray-400 uppercase tracking-wider">{specLabel('slip_rating', 'Slip Rating')}</span>
                  <p className="font-semibold text-gray-900 mt-1">{(selectedProduct.slip_rating || selectedProduct.attributes?.slip_rating || '').toUpperCase()}</p>
                </div>
              )}
              {selectedProduct?.made_in && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <span className="text-xs text-gray-400 uppercase tracking-wider">{specLabel('made_in', 'Country of Origin')}</span>
                  <p className="font-semibold text-gray-900 mt-1">{selectedProduct.made_in}</p>
                </div>
              )}
              {isSurfaceProduct && selectedProduct?.tiles_per_box && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <span className="text-xs text-gray-400 uppercase tracking-wider">{specLabel('tiles_per_box', 'Tiles per Box')}</span>
                  <p className="font-semibold text-gray-900 mt-1">{selectedProduct.tiles_per_box}</p>
                </div>
              )}
              {isSurfaceProduct && sqmPerBox && (
                <div className="bg-gray-50 rounded-lg p-4">
                  <span className="text-xs text-gray-400 uppercase tracking-wider">{specLabel('sqm_per_box', 'Coverage per Box')}</span>
                  <p className="font-semibold text-gray-900 mt-1">{sqmPerBox} m&sup2;</p>
                </div>
              )}
              {/* Admin-defined custom spec fields (e.g. Frost Proof → Yes) */}
              {(Array.isArray(selectedProduct?.custom_specs) ? selectedProduct.custom_specs : [])
                .filter(cs => cs && cs.label && cs.value !== '' && cs.value !== null && cs.value !== undefined)
                .map(cs => (
                  <div key={cs.key || cs.label} className="bg-gray-50 rounded-lg p-4" data-testid={`spec-custom-${cs.key || cs.label}`}>
                    <span className="text-xs text-gray-400 uppercase tracking-wider">{cs.label}</span>
                    <p className="font-semibold text-gray-900 mt-1">{String(cs.value)}</p>
                  </div>
                ))}
            </div>
            );
          })()}

          {/* Delivery Tab */}
          {(openAccordions.activeTab || 'specs') === 'delivery' && (
            <div data-testid="tab-content-delivery">
              <DeliveryInfoCompact />
            </div>
          )}

          {/* Installation Tab */}
          {openAccordions.activeTab === 'installation' && isSurfaceProduct && (
            <div data-testid="tab-content-installation">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {[
                  { title: 'Surface Preparation', text: 'Ensure the surface is clean, dry, and level before installation.' },
                  { title: 'Adhesive', text: 'Use a flexible tile adhesive suitable for porcelain tiles.' },
                  { title: 'Spacing', text: 'Use 3mm spacers for a consistent grout line.' },
                  { title: 'Grouting', text: 'Allow 24 hours before grouting. Use colour-matched grout.' },
                  { title: 'Cutting', text: 'Use a wet tile cutter or angle grinder with a diamond blade.' },
                ].map((step, i) => (
                  <div key={i} className="flex items-start gap-3 bg-blue-50 rounded-lg p-4">
                    <div className="w-7 h-7 rounded-full bg-blue-600 text-white flex items-center justify-center flex-shrink-0 text-sm font-bold">{i + 1}</div>
                    <div>
                      <p className="font-semibold text-gray-900 text-sm">{step.title}</p>
                      <p className="text-gray-600 text-sm mt-0.5">{step.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Maintenance Tab */}
          {openAccordions.activeTab === 'maintenance' && isSurfaceProduct && (
            <div data-testid="tab-content-maintenance">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {[
                  { title: 'Daily Cleaning', text: 'Sweep or vacuum to remove loose dirt and debris.' },
                  { title: 'Weekly Mopping', text: 'Use warm water with a pH-neutral cleaner.' },
                  { title: 'Stain Removal', text: 'For tough stains, use a mild abrasive cleaner.' },
                  { title: 'Grout Care', text: 'Reseal grout annually to prevent discolouration.' },
                  { title: 'Avoid', text: 'Harsh chemicals, bleach, and abrasive scrubbing pads.' },
                ].map((tip, i) => (
                  <div key={i} className="flex items-start gap-3 bg-cyan-50 rounded-lg p-4">
                    <Check className="w-5 h-5 text-cyan-600 mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="font-semibold text-gray-900 text-sm">{tip.title}</p>
                      <p className="text-gray-600 text-sm mt-0.5">{tip.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Calculator Tab */}
          {openAccordions.activeTab === 'calculator' && isSurfaceProduct && selectedProduct && (
            <div data-testid="tab-content-calculator">
              <AdvancedTileCalculator
                product={selectedProduct}
                onCalculate={(sqm) => {
                  if (quantityUnit === 'box' && sqmPerBox) {
                    setQuantity(Math.ceil(sqm / sqmPerBox));
                  } else {
                    setQuantity(Math.ceil(sqm));
                    setQuantityUnit('sqm');
                  }
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Frequently Bought Together Section - Real co-purchase recommendations */}
      {!selectedProduct?._isPreview && (pageSettings?.frequentlyBoughtTogether?.enabled !== false) && fbtItems.length > 0 && (
        <div className="max-w-7xl mx-auto px-4 py-8 border-t border-gray-100">
          <div className="bg-gradient-to-r from-amber-50 to-orange-50 rounded-2xl p-6 md:p-8" data-testid="fbt-section">
            <h2 className="text-xl md:text-2xl font-bold text-gray-900 mb-2 flex items-center gap-2">
              <ShoppingCart className="w-6 h-6 text-amber-600" />
              {pageSettings?.frequentlyBoughtTogether?.title || 'Frequently Bought Together'}
            </h2>
            <p className="text-gray-600 text-sm mb-6">
              {pageSettings?.frequentlyBoughtTogether?.subtitle || 'Installation essentials customers buy with this tile'}
            </p>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 items-center">
              {/* Current Product (anchor) */}
              <div className="bg-white rounded-xl p-4 shadow-sm border-2 border-amber-200">
                <div className="aspect-square rounded-lg overflow-hidden mb-3 bg-gray-100">
                  {productImages[0] ? (
                    <img src={productImages[0]} alt={selectedProduct?.display_name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-gray-400">No image</div>
                  )}
                </div>
                <p className="font-medium text-sm text-gray-900 line-clamp-2">{selectedProduct?.display_name || decodedSeriesName}</p>
                <p className="text-amber-600 font-bold mt-1">£{safeToFixed(displayPrice, 2)}{priceUnit}{isTrade && <span className="text-[10px] text-gray-400 font-normal ml-1">ex. VAT</span>}</p>
                <span className="inline-block mt-2 text-xs bg-amber-100 text-amber-700 px-2 py-1 rounded-full">Selected</span>
              </div>

              {/* Plus Sign */}
              <div className="hidden md:flex justify-center">
                <div className="w-8 h-8 bg-gray-200 rounded-full flex items-center justify-center text-gray-500 font-bold">+</div>
              </div>

              {/* Recommended tiles */}
              <div className="md:col-span-2 grid grid-cols-2 sm:grid-cols-3 gap-3">
                {fbtItems.slice(0, 3).map((rec) => {
                  const checked = fbtSelected.has(rec.id);
                  const recPrice = Number(rec.room_lot_price ?? rec.price ?? 0);
                  return (
                    <Link
                      key={rec.id}
                      to={`/tiles/${rec.slug}`}
                      onClick={(e) => {
                        // Toggling the checkbox shouldn't navigate.
                        if (e.target.closest('label')) e.preventDefault();
                      }}
                      className="bg-white rounded-xl p-3 shadow-sm border border-gray-200 hover:border-amber-300 transition-colors group"
                      data-testid={`fbt-rec-${rec.id}`}
                    >
                      <div className="aspect-square rounded-lg overflow-hidden mb-2 bg-gray-100">
                        {normaliseImageUrl(firstImageUrl(rec.images)) ? (
                          <img src={normaliseImageUrl(firstImageUrl(rec.images))} alt={rec.display_name || rec.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">No image</div>
                        )}
                      </div>
                      <p className="font-medium text-xs text-gray-900 line-clamp-2">{rec.display_name || rec.name}</p>
                      {rec.size && <p className="text-gray-500 text-[11px]">{rec.size}</p>}
                      <p className="text-gray-900 font-semibold text-sm mt-1">£{recPrice.toFixed(2)}<span className="text-[10px] text-gray-400 font-normal">m²</span></p>
                      {rec.times_bought_together > 0 && (
                        <p className="text-[10px] text-amber-700 mt-0.5">{rec.times_bought_together}× bought together</p>
                      )}
                      <label className="flex items-center gap-2 mt-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            setFbtSelected(prev => {
                              const next = new Set(prev);
                              if (next.has(rec.id)) next.delete(rec.id); else next.add(rec.id);
                              return next;
                            });
                          }}
                          className="w-4 h-4 text-amber-500 rounded border-gray-300 focus:ring-amber-500"
                          data-testid={`fbt-toggle-${rec.id}`}
                        />
                        <span className="text-xs text-gray-600">Add</span>
                      </label>
                    </Link>
                  );
                })}
              </div>
            </div>

            {/* Total + Add All */}
            {(() => {
              const extras = fbtItems.filter(r => fbtSelected.has(r.id));
              const extrasTotal = extras.reduce((sum, r) => sum + Number(r.room_lot_price ?? r.price ?? 0), 0);
              const bundleTotal = Number(displayPrice || 0) + extrasTotal;
              return (
                <div className="mt-6 pt-6 border-t border-amber-200 flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div className="text-center sm:text-left">
                    <p className="text-sm text-gray-600">Bundle Total{extras.length > 0 ? ` (${extras.length + 1} item${extras.length === 0 ? '' : 's'})` : ''}:</p>
                    <p className="text-2xl font-bold text-gray-900" data-testid="fbt-bundle-total">
                      £{bundleTotal.toFixed(2)}
                      <span className="text-sm font-normal text-gray-500 ml-1">{sellsPerM2 ? 'per m²' : ''}</span>
                    </p>
                    {extras.length > 0 && <p className="text-sm text-green-600 font-medium">Add all in one click</p>}
                  </div>
                  <button
                    onClick={() => {
                      // Add anchor first (defers to existing add flow), then queue extras at 1 m² / unit each.
                      extras.forEach(rec => {
                        addToCart({
                          product_id: rec.id,
                          name: rec.display_name || rec.name,
                          price: Number(rec.room_lot_price ?? rec.price ?? 0),
                          quantity: 1,
                          silent: true,
                          image: normaliseImageUrl(firstImageUrl(rec.images)),
                          slug: rec.slug,
                        });
                      });
                      toast.success(extras.length > 0 ? `Added ${extras.length} accessor${extras.length === 1 ? 'y' : 'ies'} to cart` : 'Pick at least one item');
                    }}
                    disabled={extras.length === 0}
                    className="w-full sm:w-auto px-8 py-4 bg-amber-500 hover:bg-amber-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white rounded-xl font-bold text-lg flex items-center justify-center gap-2 shadow-lg hover:shadow-xl transition-all hover:scale-105 disabled:hover:scale-100"
                    data-testid="fbt-add-all-btn"
                  >
                    <ShoppingCart className="w-5 h-5" />
                    Add Bundle to Cart
                  </button>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Related Downloads - PDF datasheets */}
      {productDocuments.length > 0 && (
        <div className="max-w-7xl mx-auto px-4 py-8" data-testid="related-downloads">
          <div className="bg-gray-100 rounded-lg p-6">
            <h3 className="text-lg font-bold text-gray-800 uppercase tracking-wide mb-4">
              Related Downloads
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {productDocuments.map(doc => (
                <a
                  key={doc.id}
                  href={`${API_URL}/api/product-documents/${doc.id}/download`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex flex-col items-center p-4 bg-white border border-gray-200 rounded-lg hover:border-gray-400 hover:shadow-sm transition cursor-pointer"
                  data-testid={`download-doc-${doc.id}`}
                >
                  <div className="w-16 h-20 mb-3 relative flex items-center justify-center">
                    <svg viewBox="0 0 60 72" className="w-full h-full">
                      <path d="M0 4C0 1.8 1.8 0 4 0H38L56 18V68C56 70.2 54.2 72 52 72H4C1.8 72 0 70.2 0 68V4Z" fill="#E5E7EB" />
                      <path d="M38 0L56 18H42C39.8 18 38 16.2 38 14V0Z" fill="#D1D5DB" />
                      <rect x="8" y="38" width="40" height="14" rx="2" fill="#DC2626" />
                      <text x="28" y="49" textAnchor="middle" fill="white" fontSize="10" fontWeight="bold" fontFamily="Arial, sans-serif">PDF</text>
                    </svg>
                  </div>
                  <p className="text-xs text-center text-gray-700 font-medium leading-tight group-hover:text-gray-900 line-clamp-2">
                    {(doc.display_name || doc.original_filename || '').replace(/^[a-f0-9]{20,}_/i, '')}
                  </p>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Customers Also Liked Section */}
      {relatedProducts.length > 0 && (
        <div className="max-w-7xl mx-auto px-4 py-12">
          <h2 className="text-2xl font-semibold text-center mb-8">Customers Also Liked</h2>
          
          <div className="relative">
            {/* Left Arrow */}
            {relatedScrollIndex > 0 && (
              <button
                onClick={() => setRelatedScrollIndex(Math.max(0, relatedScrollIndex - 1))}
                className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-4 z-10 w-10 h-10 bg-white shadow-lg rounded-full flex items-center justify-center hover:bg-gray-50"
              >
                <ChevronLeft className="w-6 h-6" />
              </button>
            )}
            
            {/* Products Grid */}
            <div className="overflow-hidden">
              <div 
                className="flex transition-transform duration-300 gap-6"
                style={{ transform: `translateX(-${relatedScrollIndex * 280}px)` }}
              >
                {relatedProducts.map((item, index) => (
                  <Link
                    key={index}
                    to={`/shop/collection/${encodeURIComponent(item.series_name)}`}
                    className="flex-shrink-0 w-64 group"
                  >
                    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden hover:shadow-lg transition-shadow">
                      {/* Product Image */}
                      <div className="aspect-square bg-gray-100 relative overflow-hidden">
                        {item.pinned && (
                          <span
                            className="absolute top-2 left-2 z-10 px-2 py-0.5 bg-amber-500 text-white text-[10px] font-bold uppercase rounded-full shadow"
                            data-testid="staff-pick-badge"
                          >
                            Staff Pick
                          </span>
                        )}
                        {(normaliseImageUrl(item.image) || normaliseImageUrl(item.sample_product?.images?.[0])) ? (
                          <img
                            src={normaliseImageUrl(item.image) || normaliseImageUrl(item.sample_product?.images?.[0])}
                            alt={item.series_name}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400">
                            No image
                          </div>
                        )}
                      </div>
                      
                      {/* Product Info */}
                      <div className="p-4">
                        <h3 className="font-medium text-gray-900 mb-1 truncate">
                          {item.series_name}
                        </h3>
                        {item.material && (
                          <p className="text-sm text-gray-500 mb-2">{item.material}</p>
                        )}
                        {item.price > 0 && (
                          <p className="text-amber-600 font-semibold">
                            £{(isTrade ? getTradePrice(item.price) : item.price).toFixed(2)}{item.sample_product?.pricing_unit === 'unit' || !isSurfaceProduct ? ' each' : 'm²'}
                            {isTrade && <span className="text-[10px] text-gray-400 font-normal ml-1">ex. VAT</span>}
                          </p>
                        )}
                        <button className="w-full mt-3 py-2 bg-gray-900 text-white text-sm font-medium rounded hover:bg-gray-800 transition">
                          VIEW
                        </button>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
            
            {/* Right Arrow */}
            {relatedScrollIndex < relatedProducts.length - 4 && (
              <button
                onClick={() => setRelatedScrollIndex(Math.min(relatedProducts.length - 4, relatedScrollIndex + 1))}
                className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-4 z-10 w-10 h-10 bg-white shadow-lg rounded-full flex items-center justify-center hover:bg-gray-50"
              >
                <ChevronRight className="w-6 h-6" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Recently Viewed Products */}
      <RecentlyViewedSection currentProductSlug={encodeURIComponent(decodedSeriesName)} maxItems={6} />

      {/* You May Also Need - Cross-group recommendations */}
      <YouMayAlsoNeed currentGroup={products[0]?.product_group || 'tiles'} maxItems={6} pinnedItems={pinnedYouMayNeed} />

      <ShopFooter />
      {/* Bottom spacer for sticky mobile cart bar */}
      <div className="h-20 md:hidden"></div>
      <LiveChatWidget />
      
      {/* Fullscreen Lightbox Modal */}
      {showLightbox && (
        <div className="fixed inset-0 z-[70] bg-black/95 flex items-center justify-center">
          {/* Close Button */}
          <button
            onClick={closeLightbox}
            className="absolute top-4 right-4 z-[71] w-12 h-12 bg-white/20 hover:bg-white/40 rounded-full flex items-center justify-center transition-colors"
            data-testid="lightbox-close-btn"
          >
            <X className="w-7 h-7 text-white" />
          </button>
          
          {/* Image Counter */}
          <div className="absolute top-4 left-4 text-white/80 text-sm">
            {lightboxIndex + 1} / {productImages.length}
          </div>
          
          {/* Main Image */}
          <div className="relative w-full h-full flex items-center justify-center p-4 md:p-16">
            {isVideo(productImages[lightboxIndex]) ? (
              <video
                src={productImages[lightboxIndex]}
                className="max-w-full max-h-full object-contain"
                controls
                autoPlay
                loop
              />
            ) : (
              <img
                src={productImages[lightboxIndex]}
                alt={`${decodedSeriesName} - Image ${lightboxIndex + 1}`}
                className="max-w-full max-h-full object-contain"
              />
            )}
          </div>
          
          {/* Navigation Arrows */}
          {productImages.length > 1 && (
            <>
              <button
                onClick={prevImage}
                className="absolute left-4 top-1/2 -translate-y-1/2 w-14 h-14 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center transition-colors"
              >
                <ChevronLeft className="w-8 h-8 text-white" />
              </button>
              <button
                onClick={nextImage}
                className="absolute right-4 top-1/2 -translate-y-1/2 w-14 h-14 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center transition-colors"
              >
                <ChevronRight className="w-8 h-8 text-white" />
              </button>
            </>
          )}
          
          {/* Thumbnail Strip */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-2 max-w-[90vw] overflow-x-auto p-2 bg-black/50 rounded-lg">
            {productImages.map((img, idx) => (
              <button
                key={idx}
                onClick={() => setLightboxIndex(idx)}
                className={`flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden border-2 transition-all ${
                  lightboxIndex === idx ? 'border-amber-500 opacity-100' : 'border-transparent opacity-50 hover:opacity-80'
                }`}
              >
                {isVideo(img) ? (
                  <div className="relative w-full h-full bg-gray-700">
                    <Play className="absolute inset-0 m-auto w-6 h-6 text-white" />
                  </div>
                ) : (
                  <img src={img} alt="" className="w-full h-full object-cover" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      
      {/* View in Room Modal */}
      {showRoomView && lifestyleImages.length > 0 && (
        <div className="fixed inset-0 z-[70] bg-black/90 flex items-center justify-center p-4">
          {/* Close Button */}
          <button
            onClick={() => setShowRoomView(false)}
            className="absolute top-4 right-4 z-[71] w-12 h-12 bg-white/20 hover:bg-white/40 rounded-full flex items-center justify-center transition-colors"
            data-testid="room-view-close-btn"
          >
            <X className="w-6 h-6 text-white" />
          </button>
          
          {/* Title */}
          <div className="absolute top-4 left-4 text-white">
            <h3 className="text-lg font-semibold flex items-center gap-2">
              <Home className="w-5 h-5" />
              View in Room
            </h3>
            <p className="text-white/60 text-sm mt-1">See how this tile looks in real spaces</p>
          </div>
          
          {/* Lifestyle Images Grid */}
          <div className="w-full max-w-6xl max-h-[80vh] overflow-y-auto mt-20">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {lifestyleImages.map((img, idx) => (
                <div 
                  key={idx} 
                  className="relative aspect-video rounded-xl overflow-hidden cursor-pointer group"
                  onClick={() => {
                    setShowRoomView(false);
                    setLightboxIndex(productImages.indexOf(img));
                    setShowLightbox(true);
                  }}
                >
                  <img 
                    src={img} 
                    alt={`${decodedSeriesName} in room ${idx + 1}`}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                  />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                    <Maximize2 className="w-8 h-8 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </div>
              ))}
            </div>
            
            {/* Info Banner */}
            <div className="mt-6 p-4 bg-white/10 rounded-xl">
              <div className="flex items-center gap-3">
                <Eye className="w-6 h-6 text-amber-400" />
                <div>
                  <p className="text-white font-medium">Want to see this tile in your space?</p>
                  <p className="text-white/60 text-sm">Order a free sample and try it at home</p>
                </div>
                {canShowLegacySampleCTA && (
                <button
                  onClick={() => {
                    setShowRoomView(false);
                    handleAddSample();
                  }}
                  className="ml-auto px-4 py-2 bg-amber-500 hover:bg-amber-600 text-white rounded-lg font-medium transition-colors"
                >
                  Order Sample
                </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Sticky Mobile Add-to-Cart Bar - Controlled by admin settings */}
      {!selectedProduct?._isPreview && (pageSettings?.stickyMobileCart?.enabled !== false) && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 shadow-[0_-4px_20px_rgba(0,0,0,0.1)] p-3 z-40 md:hidden transform transition-transform duration-300">
          <div className="flex items-center gap-3">
            {/* Price Section */}
            {(pageSettings?.stickyMobileCart?.showPrice !== false) && (
            <div className="flex-1">
              <div className="flex items-baseline gap-2">
                <span className={`text-xl font-bold ${isOnSale ? 'text-red-600' : 'text-gray-900'}`}>
                  £{safeToFixed(displayPrice, 2)}<span className="text-sm font-medium text-gray-500">{priceUnit}</span>
                </span>
                {isTrade && <span className="text-[10px] text-gray-400">ex. VAT</span>}
                {isOnSale && displayOriginalPrice > displayPrice && (
                  <span className="text-xs text-gray-400 line-through">
                    £{safeToFixed(displayOriginalPrice, 2)}{priceUnit}
                  </span>
                )}
              </div>
              {(pageSettings?.stickyMobileCart?.showTotal !== false) && (
              <div className="text-xs text-gray-500">
                Total: <span className="font-semibold text-gray-900">£{totalPrice}</span>
              </div>
              )}
            </div>
            )}
            
            {/* Add to Cart Button */}
            <button
              onClick={handleAddToCart}
              disabled={stockStatus.label === 'Out of Stock' || isAddingToCart}
              className={`px-6 py-3 rounded-xl font-bold text-base flex items-center gap-2 transition-all duration-300 ${
                cartAdded 
                  ? 'bg-green-500 text-white' 
                  : isAddingToCart 
                    ? 'bg-amber-400 text-white' 
                    : 'bg-amber-500 hover:bg-amber-600 active:scale-95 text-white shadow-md'
              }`}
            >
              {isAddingToCart ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                  Adding...
                </>
              ) : cartAdded ? (
                <>
                  <Check className="w-5 h-5" />
                  Added!
                </>
              ) : (
                <>
                  <ShoppingCart className="w-5 h-5" />
                  Add to Cart
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default CollectionDetailPage;
