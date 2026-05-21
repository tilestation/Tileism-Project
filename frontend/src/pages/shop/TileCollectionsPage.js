import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { imageUrl } from '../../utils/imageUrl';
import { 
  Home, 
  Image, 
  SlidersHorizontal, 
  Eye,
  Star,
  ChevronLeft,
  ChevronRight,
  Grid3X3,
  LayoutGrid,
  Rows3,
  TrendingUp,
  Clock,
  Flame,
  Sparkles,
  Heart,
  ShoppingCart,
  Scissors,
  X,
  Filter
} from 'lucide-react';
import { ShopHeader, ShopFooter } from './TileStationHome';
import SeoHead from '../../components/seo/SeoHead';
import FilterPanel from '../../components/shop/FilterPanel';
import { RecentlyViewedSection, YouMayAlsoNeed, trackRecentView } from '../../components/shop/CrossSellSections';
import QuickViewModal from '../../components/shop/QuickViewModal';
import { usePageTracking } from '../../hooks/usePageTracking';
import { useTradeUser } from '../../hooks/useTradeUser';
import { useCart } from '../../contexts/TileCartContext';
import { useSampleCart } from '../../contexts/SampleCartContext';
import LiveChatWidget from '../../components/shop/LiveChatWidget';
import { normaliseImageUrl, safeArr} from '../../utils/safeStr';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Hero Banner Slides with Shop by Room
const HERO_SLIDES = [
  {
    id: 'bathroom',
    title: 'Bathroom Tiles',
    subtitle: 'Create your dream sanctuary',
    image: 'https://images.unsplash.com/photo-1765766600820-58eaf8687f1d?w=1600&q=80',
    link: '/tiles?category=bathroom-tiles',
    color: '#3B82F6'
  },
  {
    id: 'kitchen',
    title: 'Kitchen Tiles',
    subtitle: 'Where style meets function',
    image: 'https://images.unsplash.com/photo-1758548157126-e4c0477f796e?w=1600&q=80',
    link: '/tiles?category=kitchen-tiles',
    color: '#10B981'
  },
  {
    id: 'living',
    title: 'Living Spaces',
    subtitle: 'Elegance for every room',
    image: 'https://images.unsplash.com/photo-1696861080288-0cc2f1cd48d5?w=1600&q=80',
    link: '/tiles?category=floor-tiles',
    color: '#8B5CF6'
  },
  {
    id: 'outdoor',
    title: 'Outdoor Tiles',
    subtitle: 'Extend your living space',
    image: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1600&q=80',
    link: '/tiles?category=outdoor-tiles',
    color: '#F59E0B'
  }
];

// Group-specific hero slides
const GROUP_HERO_SLIDES = {
  tiles: HERO_SLIDES,
  flooring: [
    {
      id: 'vinyl',
      title: 'Vinyl Flooring',
      subtitle: 'Durable luxury for every room',
      image: 'https://images.pexels.com/photos/7587865/pexels-photo-7587865.jpeg?auto=compress&cs=tinysrgb&w=1600',
      link: '/tiles?group=flooring&category=vinyl',
      color: '#8B5CF6'
    },
    {
      id: 'laminate',
      title: 'Laminate Flooring',
      subtitle: 'Stunning styles, unbeatable value',
      image: 'https://images.unsplash.com/photo-1769736436809-eab3de70b175?w=1600&q=80',
      link: '/tiles?group=flooring&category=laminate',
      color: '#D97706'
    },
    {
      id: 'engineered',
      title: 'Engineered Wood',
      subtitle: 'Natural beauty that lasts',
      image: 'https://images.pexels.com/photos/6438755/pexels-photo-6438755.jpeg?auto=compress&cs=tinysrgb&w=1600',
      link: '/tiles?group=flooring&category=engineered-wood',
      color: '#92400E'
    }
  ],
  materials: [
    {
      id: 'adhesives',
      title: 'Adhesives & Grout',
      subtitle: 'Professional-grade bonding solutions',
      image: 'https://images.pexels.com/photos/6474342/pexels-photo-6474342.jpeg?auto=compress&cs=tinysrgb&w=1600',
      link: '/tiles?group=materials&category=adhesives',
      color: '#059669'
    },
    {
      id: 'levelling',
      title: 'Levelling Compounds',
      subtitle: 'The perfect foundation for any floor',
      image: 'https://images.pexels.com/photos/6473974/pexels-photo-6473974.jpeg?auto=compress&cs=tinysrgb&w=1600',
      link: '/tiles?group=materials&category=levelling',
      color: '#6366F1'
    },
    {
      id: 'waterproofing',
      title: 'Waterproofing',
      subtitle: 'Protect every surface with confidence',
      image: 'https://images.pexels.com/photos/3616755/pexels-photo-3616755.jpeg?auto=compress&cs=tinysrgb&w=1600',
      link: '/tiles?group=materials&category=waterproofing',
      color: '#2563EB'
    }
  ],
  tools: [
    {
      id: 'cutting',
      title: 'Cutting Tools',
      subtitle: 'Precision cuts, every time',
      image: 'https://images.unsplash.com/photo-1560846389-956694677531?w=1600&q=80',
      link: '/tiles?group=tools-accessories&category=cutting-tools',
      color: '#DC2626'
    },
    {
      id: 'trowels',
      title: 'Trowels & Spreaders',
      subtitle: 'Essential tools for every tiler',
      image: 'https://images.unsplash.com/photo-1636200534256-c08268363482?w=1600&q=80',
      link: '/tiles?group=tools-accessories&category=trowels',
      color: '#F59E0B'
    },
    {
      id: 'levelling-tools',
      title: 'Levelling Systems',
      subtitle: 'Achieve a flawless, flat finish',
      image: 'https://images.unsplash.com/photo-1628002580365-f3c0a322d577?w=1600&q=80',
      link: '/tiles?group=tools-accessories&category=levelling-systems',
      color: '#0891B2'
    }
  ],
  accessories: [
    {
      id: 'trims',
      title: 'Trims & Profiles',
      subtitle: 'The perfect finishing touch',
      image: 'https://images.unsplash.com/photo-1765876192094-984b1929304c?w=1600&q=80',
      link: '/tiles?group=tools-accessories&category=trims',
      color: '#7C3AED'
    },
    {
      id: 'spacers',
      title: 'Spacers & Wedges',
      subtitle: 'Consistent gaps, professional results',
      image: 'https://images.unsplash.com/photo-1705258814435-65ed6ce0e99a?w=1600&q=80',
      link: '/tiles?group=tools-accessories&category=spacers',
      color: '#0D9488'
    },
    {
      id: 'membranes',
      title: 'Membranes & Matting',
      subtitle: 'Protect, decouple, insulate',
      image: 'https://images.pexels.com/photos/7173661/pexels-photo-7173661.jpeg?auto=compress&cs=tinysrgb&w=1600',
      link: '/tiles?group=tools-accessories&category=membranes',
      color: '#EA580C'
    }
  ],
  'underfloor-heating': [
    {
      id: 'electric',
      title: 'Electric Heating Mats',
      subtitle: 'Warmth beneath every step',
      image: 'https://images.unsplash.com/photo-1695651832926-66591245a88c?w=1600&q=80',
      link: '/tiles?group=underfloor-heating&category=electric',
      color: '#DC2626'
    },
    {
      id: 'water-systems',
      title: 'Water Heating Systems',
      subtitle: 'Efficient whole-home comfort',
      image: 'https://images.unsplash.com/photo-1562863658-51483065f301?w=1600&q=80',
      link: '/tiles?group=underfloor-heating&category=water-systems',
      color: '#2563EB'
    },
    {
      id: 'thermostats',
      title: 'Smart Thermostats',
      subtitle: 'Total control at your fingertips',
      image: 'https://images.pexels.com/photos/7587734/pexels-photo-7587734.jpeg?auto=compress&cs=tinysrgb&w=1600',
      link: '/tiles?group=underfloor-heating&category=thermostats',
      color: '#059669'
    }
  ]
};

// Shop by Room Quick Links (tiles default)
const ROOM_LINKS = [
  { id: 'bathroom', label: 'Bathroom', icon: '🛁', link: '/tiles?category=bathroom-tiles' },
  { id: 'kitchen', label: 'Kitchen', icon: '🍳', link: '/tiles?category=kitchen-tiles' },
  { id: 'living', label: 'Living Room', icon: '🛋️', link: '/tiles?category=floor-tiles' },
  { id: 'outdoor', label: 'Outdoor', icon: '🌿', link: '/tiles?category=outdoor-tiles' },
  { id: 'hallway', label: 'Hallway', icon: '🚪', link: '/tiles?category=floor-tiles' },
];

// Group-specific quick links
const GROUP_ROOM_LINKS = {
  tiles: ROOM_LINKS,
  flooring: [
    { id: 'vinyl', label: 'Vinyl', icon: '🏠', link: '/tiles?group=flooring&category=vinyl' },
    { id: 'laminate', label: 'Laminate', icon: '🪵', link: '/tiles?group=flooring&category=laminate' },
    { id: 'lvt', label: 'LVT', icon: '✨', link: '/tiles?group=flooring&category=lvt' },
    { id: 'engineered', label: 'Engineered Wood', icon: '🌳', link: '/tiles?group=flooring&category=engineered-wood' },
  ],
  materials: [
    { id: 'adhesives', label: 'Adhesives', icon: '🧱', link: '/tiles?group=materials&category=adhesives' },
    { id: 'grout', label: 'Grout & Silicone', icon: '🪣', link: '/tiles?group=materials&category=grout' },
    { id: 'levelling', label: 'Self Levelling', icon: '📐', link: '/tiles?group=materials&category=levelling' },
    { id: 'waterproofing', label: 'Waterproofing', icon: '💧', link: '/tiles?group=materials&category=waterproofing' },
    { id: 'cleaning', label: 'Cleaning', icon: '🧹', link: '/tiles?group=materials&category=cleaning' },
  ],
  tools: [
    { id: 'cutting', label: 'Tile Cutters', icon: '🔪', link: '/tiles?group=tools-accessories&category=cutting-tools' },
    { id: 'trowels', label: 'Trowels', icon: '🔧', link: '/tiles?group=tools-accessories&category=trowels' },
    { id: 'levelling', label: 'Levelling Systems', icon: '📏', link: '/tiles?group=tools-accessories&category=levelling-systems' },
    { id: 'mixing', label: 'Mixing Tools', icon: '⚙️', link: '/tiles?group=tools-accessories&category=mixing' },
  ],
  accessories: [
    { id: 'trims', label: 'Trims & Profiles', icon: '📎', link: '/tiles?group=tools-accessories&category=trims' },
    { id: 'spacers', label: 'Spacers', icon: '➕', link: '/tiles?group=tools-accessories&category=spacers' },
    { id: 'membranes', label: 'Membranes', icon: '🛡️', link: '/tiles?group=tools-accessories&category=membranes' },
    { id: 'sealing', label: 'Sealing Tape', icon: '🔒', link: '/tiles?group=tools-accessories&category=sealing' },
  ],
  'underfloor-heating': [
    { id: 'electric', label: 'Electric Mats', icon: '⚡', link: '/tiles?group=underfloor-heating&category=electric' },
    { id: 'water', label: 'Water Systems', icon: '🌊', link: '/tiles?group=underfloor-heating&category=water-systems' },
    { id: 'thermostats', label: 'Thermostats', icon: '🌡️', link: '/tiles?group=underfloor-heating&category=thermostats' },
    { id: 'insulation', label: 'Insulation Boards', icon: '🧊', link: '/tiles?group=underfloor-heating&category=insulation' },
  ]
};

// Group-aware hero section label
const GROUP_HERO_LABEL = {
  tiles: 'Shop by Room',
  flooring: 'Shop by Type',
  materials: 'Shop by Category',
  tools: 'Shop by Category',
  accessories: 'Shop by Category',
  'underfloor-heating': 'Shop by Type',
};

// Popular Filters Chips
const POPULAR_FILTERS = [
  { label: 'Large Format', filter: 'size:large' },
  { label: 'Marble Effect', filter: 'style:marble' },
  { label: 'Wood Effect', filter: 'style:wood' },
  { label: 'Matt Finish', filter: 'finish:matt' },
  { label: 'Under £30/m²', filter: 'price:0-30' },
  { label: 'In Stock', filter: 'stock:true' },
];

// Lifestyle images for collections
const LIFESTYLE_IMAGES = [
  'https://images.unsplash.com/photo-1765766600805-e75c44124d2c?w=800&q=80',
  'https://images.unsplash.com/photo-1765766600820-58eaf8687f1d?w=800&q=80',
  'https://images.unsplash.com/photo-1758548157126-e4c0477f796e?w=800&q=80',
  'https://images.unsplash.com/photo-1761679296778-7f245d39148d?w=800&q=80',
  'https://images.unsplash.com/photo-1754447628644-b2dc91ce3237?w=800&q=80',
  'https://images.unsplash.com/photo-1758448018619-4cbe2250b9ad?w=800&q=80',
];

const getLifestyleImage = (seriesName) => {
  const hash = seriesName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return LIFESTYLE_IMAGES[hash % LIFESTYLE_IMAGES.length];
};

// Extract actual color name from a product display name
// e.g. "Ardesia Slate Black 30x60cm Matt" → "Black"
const COLOR_SET = new Set([
  'white', 'ivory', 'cream', 'beige', 'sand', 'bone', 'pearl', 'crema', 'bianco',
  'grey', 'gray', 'silver', 'charcoal', 'graphite', 'ash', 'smoke', 'slate', 'grigio',
  'black', 'anthracite', 'onyx', 'nero', 'dark',
  'brown', 'walnut', 'chocolate', 'coffee', 'bronze', 'copper', 'taupe', 'mocha',
  'blue', 'navy', 'aqua', 'teal', 'ocean', 'azure', 'cobalt',
  'green', 'sage', 'olive', 'emerald', 'forest', 'moss', 'mint',
  'pink', 'rose', 'blush', 'coral', 'salmon',
  'red', 'terracotta', 'rust', 'burgundy', 'maroon',
  'gold', 'brass', 'amber', 'honey', 'caramel',
  'natural', 'stone', 'earth', 'clay'
]);
const extractColorLabel = (name) => {
  if (!name) return null;
  const parts = name.split(/\s+/);
  let lastColor = null;
  let size = null;
  for (const part of parts) {
    if (/^\d+[xX]\d+/.test(part)) {
      size = part;
      break;
    }
    if (COLOR_SET.has(part.toLowerCase())) {
      lastColor = part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    }
  }
  return lastColor || size || null;
};

// Enhanced Collection Card with all new features
export const CollectionCard = ({ 
  collection, 
  useLifestyleImages, 
  onQuickView,
  gridCols 
}) => {
  const [currentImageIndex, setCurrentImageIndex] = useState(0);
  const [isHovering, setIsHovering] = useState(false);
  const [isLiked, setIsLiked] = useState(false);
  const intervalRef = useRef(null);
  const { addToCart } = useCart();
  const { addSample } = useSampleCart();
  const { isTrade, getTradePrice } = useTradeUser();

  const {
    series_name,
    product_count,
    hero_image,
    color_swatches = [],
    product_images = [],
    additional_colors = 0,
    sizes = [],
    finishes = [],
    variant_type = 'color',
    variant_count = 0,
    is_new,
    has_new_sizes,
    is_sale,
    labels = [],
    min_price,
    prices_from,
    supplier,
    views_today = Math.floor(Math.random() * 20) + 5,
    stock_level = Math.floor(Math.random() * 50) + 10
  } = collection;

  // Generate deterministic rating & review count from series name (static, not random per render)
  const nameHash = (collection.series_name || '').split('').reduce((acc, ch, i) => acc + ch.charCodeAt(0) * (i + 1), 0);
  const rating = (4.0 + (nameHash % 10) / 10).toFixed(1);   // 4.0 to 4.9
  const review_count = 12 + (nameHash % 83);                  // 12 to 94

  // Use per-product trade_discount from the collection data (API provides correct value including supplier_products lookup)
  const productTradeDiscount = collection.trade_discount || 0;
  
  // Calculate trade price using per-product discount rate
  const getProductTradePrice = (price) => {
    if (!isTrade || !price) return price;
    const discounted = price * (1 - productTradeDiscount / 100);
    return Math.round((discounted / 1.20) * 100) / 100;
  };

  const collectionSlug = encodeURIComponent(series_name.trim());
  
  // Product display classification (see business_rules.py)
  // Surface Products: sizes contain dimensional pattern (e.g. 60x60cm) → show /m²
  // Unit Products: no dimensional sizes → show /each
  const isSurface = collection.is_surface_product !== undefined 
    ? collection.is_surface_product 
    : (sizes || []).some(s => /\d+\s*x\s*\d+/i.test(s));
  
  const displayImage = useLifestyleImages 
    ? getLifestyleImage(series_name)
    : (normaliseImageUrl(hero_image) || getLifestyleImage(series_name));

  const colorCount = variant_count || color_swatches.length + (additional_colors || 0);
  const badgeLabel = variant_type === 'color' 
    ? (colorCount === 1 ? 'COLOUR' : 'COLOURS')
    : (colorCount === 1 ? 'VARIANT' : 'VARIANTS');
  const sizeCount = sizes?.length || 0;
  
  // Both product_images and color_swatches are { color, image } where
  // `image` may be a string URL (legacy) or {url, alt, alt_generated_at}
  // (post-May-2026 SEO migration). normaliseImageUrl unwraps both shapes
  // so React never gets src={Object} (= [object Object] = 404 = broken icon).
  const rawThumbnailImages = (product_images?.length > 0 ? product_images : color_swatches)
    .map(s => ({ image: normaliseImageUrl(s.image), color: s.color || '' }))
    .filter(item => item.image);

  // Deduplicate thumbnails by extracted color/size label, keeping the first image per unique label
  const thumbnailImages = useMemo(() => {
    const seen = new Set();
    return rawThumbnailImages.filter(item => {
      const label = extractColorLabel(item.color) || item.color || '';
      if (seen.has(label)) return false;
      seen.add(label);
      return true;
    });
  }, [rawThumbnailImages]);

  const allImages = [
    { image: displayImage, color: series_name },
    ...thumbnailImages
  ].filter(img => img.image);

  // Auto-slide on hover
  useEffect(() => {
    if (isHovering && allImages.length > 1) {
      intervalRef.current = setInterval(() => {
        setCurrentImageIndex((prev) => (prev + 1) % allImages.length);
      }, 1200);
    } else {
      if (intervalRef.current) clearInterval(intervalRef.current);
      setCurrentImageIndex(0);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isHovering, allImages.length]);

  // Calculate discount percentage from actual prices shown to customer
  const maxWasPrice = collection.max_was_price || 0;
  const tierDisabledForBadge = collection.tier_pricing_disabled;
  // Use backend-computed per-product sale discount % (correct: pairs each product's was_price with its own price)
  const apiSaleDiscountPct = collection.max_sale_discount_pct || null;
  
  const saleDiscountPct = (() => {
    if (tierDisabledForBadge) {
      // Tier pricing disabled: use backend-computed % (accurate per-product calculation)
      if (apiSaleDiscountPct) return apiSaleDiscountPct;
      // Fallback: use base price
      if (maxWasPrice > 0 && min_price > 0 && maxWasPrice > min_price) {
        return Math.round(((maxWasPrice - min_price) / maxWasPrice) * 100);
      }
    } else {
      // Tier pricing enabled: use best tier price (prices_from) — shows max possible savings
      if (maxWasPrice > 0 && prices_from > 0 && maxWasPrice > prices_from) {
        return Math.round(((maxWasPrice - prices_from) / maxWasPrice) * 100);
      }
      // Fallback to base price
      if (maxWasPrice > 0 && min_price > 0 && maxWasPrice > min_price) {
        return Math.round(((maxWasPrice - min_price) / maxWasPrice) * 100);
      }
    }
    // Final fallback: use markup + tier
    const maxWasMarkup = collection.max_was_markup || 0;
    const maxTierDiscount = tierDisabledForBadge ? 0 : (collection.max_tier_discount || 0);
    if (maxWasMarkup > 0 || maxTierDiscount > 0) {
      return Math.round(maxWasMarkup + maxTierDiscount);
    }
    return null;
  })();
  
  // For trade users: compound trade discount with sale discount (never additive)
  const discountPct = (() => {
    const baseDiscount = saleDiscountPct || 0;
    if (isTrade && productTradeDiscount > 0) {
      if (is_sale && baseDiscount > 0) {
        // Sale + Trade: compound = 1 - (1-sale)*(1-trade), shows total savings from was→trade
        return Math.round((1 - (1 - baseDiscount / 100) * (1 - productTradeDiscount / 100)) * 100);
      }
      // Non-sale: show only trade discount (no was_price markup to combine with)
      return productTradeDiscount;
    }
    return saleDiscountPct;
  })();

  // Normalize labels to uppercase for matching
  const normalizedLabels = labels.map(l => l.toUpperCase());
  
  // Build badges from labels and flags
  const badges = [];
  if (is_sale && discountPct > 0) badges.push({ text: 'SALE', type: 'sale' });
  else if (is_sale) badges.push({ text: 'SALE', type: 'sale' }); // No discount calculable, still show SALE badge
  else if (isTrade && discountPct > 0) badges.push({ text: 'TRADE', type: 'trade' });
  if (normalizedLabels.includes('CLEARANCE')) badges.push({ text: 'CLEARANCE', type: 'clearance' });
  if (is_new) badges.push({ text: 'NEW', type: 'new' });
  if (has_new_sizes) badges.push({ text: 'NEW SIZES', type: 'new' });
  if (normalizedLabels.includes('BEST SELLER') || normalizedLabels.includes('BESTSELLER') || review_count > 50) badges.push({ text: 'BEST SELLER', type: 'bestseller' });

  // Badge component - Right Tiles inspired overlay design
  const renderBadge = (badge, idx) => {
    if (badge.type === 'sale') {
      return (
        <div key={idx} className="flex flex-col items-center justify-center w-[56px] h-[56px] rounded-full bg-red-600 shadow-lg shadow-red-600/30 border-2 border-red-500" data-testid={`badge-${badge.type}`}>
          <span className="text-[8px] font-medium text-red-200 leading-none">{isTrade ? 'Trade' : (tierDisabledForBadge ? 'Save' : 'Up to')}</span>
          <span className="text-base font-black text-white leading-none tracking-tight">{discountPct || ''}%</span>
          <span className="text-[8px] font-medium text-red-200 leading-none">Off</span>
        </div>
      );
    }
    if (badge.type === 'trade') {
      return (
        <div key={idx} className="flex flex-col items-center justify-center w-[56px] h-[56px] rounded-full bg-amber-600 shadow-lg shadow-amber-600/30 border-2 border-amber-500" data-testid={`badge-${badge.type}`}>
          <span className="text-[8px] font-medium text-amber-200 leading-none">Trade</span>
          <span className="text-base font-black text-white leading-none tracking-tight">{discountPct}%</span>
          <span className="text-[8px] font-medium text-amber-200 leading-none">Off</span>
        </div>
      );
    }
    if (badge.type === 'clearance') {
      // Orange/red clearance badge
      return (
        <div key={idx} className="flex flex-col items-center justify-center px-3 py-1.5 rounded shadow-lg shadow-orange-500/30" 
          style={{background: 'linear-gradient(135deg, #ea580c 0%, #c2410c 100%)', border: '1px solid #fb923c'}}
          data-testid={`badge-${badge.type}`}
        >
          <span className="text-[10px] font-black text-white leading-tight tracking-widest uppercase">Clearance</span>
        </div>
      );
    }
    if (badge.type === 'new') {
      return (
        <div key={idx} className="flex flex-col items-center justify-center px-2.5 py-1.5 rounded bg-emerald-700 shadow-lg shadow-emerald-700/30 border border-emerald-500/50" data-testid={`badge-${badge.type}`}>
          <span className="text-sm font-black text-amber-300 leading-tight tracking-wide">NEW</span>
          <span className="text-[7px] font-medium text-emerald-100 leading-tight uppercase tracking-widest">{badge.text === 'NEW SIZES' ? 'Sizes' : 'Arrival'}</span>
        </div>
      );
    }
    if (badge.type === 'bestseller') {
      return (
        <div key={idx} className="flex flex-col items-center justify-center w-[56px] h-[56px] rounded-full shadow-lg shadow-amber-500/30" 
          style={{background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 50%, #b45309 100%)', border: '2px solid #fbbf24'}}
          data-testid={`badge-${badge.type}`}
        >
          <svg className="w-3 h-3 text-yellow-200 mb-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          <span className="text-[7px] font-bold text-yellow-100 leading-none uppercase tracking-wider">Best</span>
          <span className="text-[7px] font-bold text-yellow-100 leading-none uppercase tracking-wider">Seller</span>
        </div>
      );
    }
    return (
      <span key={idx} className="px-2.5 py-1 text-[10px] font-bold tracking-wider bg-gray-900 text-white rounded shadow-md" data-testid={`badge-${badge.type}`}>
        {badge.text}
      </span>
    );
  };

  const handleQuickAdd = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Quick add first product to cart
    if (product_images?.[0]) {
      addToCart({
        id: series_name,
        name: series_name,
        display_name: series_name,
        price: prices_from || min_price || 0,
        image: displayImage,
        quantity: 1
      }, 1);
      toast.success('Added to cart');
    }
  };

  const handleQuickSample = (e) => {
    e.preventDefault();
    e.stopPropagation();
    addSample({
      id: series_name,
      name: series_name,
      display_name: series_name,
      image: displayImage,
      slug: collectionSlug
    });
  };

  const handleLike = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsLiked(!isLiked);
    toast.success(isLiked ? 'Removed from wishlist' : 'Added to wishlist');
  };

  // Card size based on grid columns
  const aspectRatio = gridCols === 2 ? 'aspect-[4/5]' : 'aspect-[3/4]';

  return (
    <div
      className="group relative bg-white rounded-xl p-3 pb-4 shadow-[0_1px_8px_rgba(0,0,0,0.06)] border border-black/[0.04] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
      data-testid={`collection-card-${series_name?.toLowerCase().replace(/\s+/g, '-')}`}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <Link to={`/shop/collection/${collectionSlug}`} className="block">
        {/* Image Container */}
        <div className={`relative ${aspectRatio} overflow-hidden rounded-lg bg-gray-100 mb-4`}
        >
          {/* Image Slideshow */}
          <div className="relative w-full h-full">
            {allImages.map((img, index) => (
              <img
                key={index}
                src={img.image}
                alt={`${series_name} - ${img.color || `View ${index + 1}`}`}
                className={`absolute inset-0 w-full h-full object-cover transition-all duration-700 ease-out
                  ${index === currentImageIndex ? 'opacity-100 scale-100' : 'opacity-0 scale-105'}
                  ${isHovering ? 'group-hover:scale-110' : ''}`}
                loading="lazy"
                onError={(e) => {
                  e.target.src = getLifestyleImage(series_name);
                }}
              />
            ))}
          </div>

          {/* Gradient Overlay on Hover */}
          <div className={`absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent 
            transition-opacity duration-300 ${isHovering ? 'opacity-100' : 'opacity-0'}`} 
          />

          {/* Badges - Top Left */}
          {badges.length > 0 && (
            <div className="absolute top-3 left-3 flex flex-col gap-2 z-10">
              {badges.slice(0, 2).map((badge, idx) => renderBadge(badge, idx))}
            </div>
          )}

          {/* Prominent Sale Ribbon — Top Right (matches PDP) */}
          {is_sale && (
            <div className="absolute top-0 right-0 z-10" data-testid="sale-ribbon">
              <div className="relative">
                <Star className="absolute -top-1 left-1 w-4 h-4 fill-yellow-400 text-yellow-400 z-20" />
                <div className="bg-red-600 text-white pl-6 pr-4 py-2 rounded-bl-lg shadow-xl">
                  <span className="text-base font-bold italic tracking-wide drop-shadow-sm">Sale</span>
                </div>
                <div className="absolute -bottom-2 left-0 w-0 h-0 border-r-[8px] border-r-transparent border-t-[8px] border-t-red-800" />
              </div>
            </div>
          )}

          {/* Wishlist Button - Top Right (offset down when sale ribbon present) */}
          <button
            onClick={handleLike}
            className={`absolute ${is_sale ? 'top-14' : 'top-3'} right-3 p-2 rounded-full transition-all duration-300 z-10
              ${isLiked ? 'bg-red-500 text-white' : 'bg-white/90 text-gray-700 hover:bg-white'}
              ${isHovering ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'}`}
          >
            <Heart className={`w-4 h-4 ${isLiked ? 'fill-current' : ''}`} />
          </button>

          {/* Social Proof - Bottom Left */}
          <div className={`absolute bottom-3 left-3 flex items-center gap-2 transition-all duration-300 z-10
            ${isHovering ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}
          >
            <span className="flex items-center gap-1 px-2 py-1 bg-white/95 backdrop-blur-sm rounded-full text-xs font-medium text-gray-700 shadow-sm">
              <Eye className="w-3 h-3" />
              {views_today} viewing
            </span>
            {stock_level < 20 && (
              <span className="flex items-center gap-1 px-2 py-1 bg-red-500/90 backdrop-blur-sm rounded-full text-xs font-medium text-white shadow-sm">
                <Flame className="w-3 h-3" />
                Only {stock_level} left
              </span>
            )}
          </div>

          {/* Quick Actions - Bottom Center on Hover */}
          <div className={`absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 transition-all duration-300 z-10
            ${isHovering ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}
          >
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onQuickView(collection);
              }}
              className="px-4 py-2 bg-white hover:bg-gray-100 text-gray-900 text-sm font-semibold rounded-full shadow-lg transition-all hover:scale-105"
              data-testid={`quick-view-btn-${series_name?.toLowerCase().replace(/\s+/g, '-')}`}
            >
              Quick View
            </button>
          </div>

          {/* Image Dots Indicator */}
          {isHovering && allImages.length > 1 && (
            <div className="absolute bottom-12 left-1/2 -translate-x-1/2 flex gap-1 z-10">
              {allImages.slice(0, 5).map((_, index) => (
                <span 
                  key={index}
                  className={`w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                    index === currentImageIndex ? 'bg-white w-4' : 'bg-white/50'
                  }`}
                />
              ))}
            </div>
          )}

          {/* Variant Count Badge - Bottom Right */}
          {(colorCount > 0 || sizeCount > 0) && (
            <div className={`absolute bottom-3 right-3 flex gap-1.5 transition-all duration-300 z-10
              ${isHovering ? 'opacity-0' : 'opacity-100'}`}
            >
              {colorCount > 0 && (
                <span className="px-2 py-1 text-[10px] font-medium bg-white/95 backdrop-blur-sm text-gray-700 rounded-sm shadow-sm">
                  {colorCount} {badgeLabel}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Collection Info */}
        <div className="space-y-2 px-1">
          {/* Series Name */}
          <h3 className="font-medium text-gray-900 tracking-wide text-sm group-hover:text-amber-600 transition-colors">
            {series_name}
          </h3>

          {/* Rating */}
          <div className="flex items-center gap-1.5">
            <div className="flex">
              {[1, 2, 3, 4, 5].map((star) => (
                <Star
                  key={star}
                  className={`w-3 h-3 ${star <= Math.round(rating) ? 'fill-amber-400 text-amber-400' : 'text-gray-300'}`}
                />
              ))}
            </div>
            <span className="text-xs text-gray-500">({review_count})</span>
          </div>

          {/* Country of Origin */}
          {collection.made_in && (
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-gray-50 border border-gray-200" data-testid="collection-card-made-in">
              <img 
                src={`https://flagcdn.com/28x21/${({
                  'Italy': 'it', 'Spain': 'es', 'Portugal': 'pt', 'Turkey': 'tr',
                  'India': 'in', 'China': 'cn', 'Poland': 'pl', 'Germany': 'de',
                  'UK': 'gb', 'United Kingdom': 'gb', 'France': 'fr', 'Belgium': 'be',
                  'Brazil': 'br', 'Morocco': 'ma', 'Egypt': 'eg', 'Iran': 'ir',
                  'Indonesia': 'id', 'Vietnam': 'vn', 'Mexico': 'mx', 'USA': 'us'
                })[collection.made_in] || 'eu'}.png`}
                alt={collection.made_in}
                className="inline-block rounded-sm shadow-sm"
                width="28"
                height="21"
              />
              <span className="text-xs font-semibold text-gray-700">Made in {collection.made_in}</span>
            </div>
          )}

          {/* Price */}
          {prices_from > 0 && (() => {
            // When tier pricing is disabled for a collection, show base retail price (min_price)
            // Otherwise show prices_from (which includes best tier discount)
            // Trade users always see prices_from with trade discount applied
            const tierDisabled = collection.tier_pricing_disabled;
            const displayBasePrice = tierDisabled && !isTrade ? (min_price || prices_from) : prices_from;
            const showFrom = is_sale || (isTrade && !tierDisabled);
            return (
            <div className="flex items-baseline gap-2">
              <span className={`text-lg font-semibold ${is_sale ? 'text-red-600' : 'text-gray-900'}`}>
                {showFrom ? 'From ' : ''}£{(isTrade ? getProductTradePrice(displayBasePrice) : displayBasePrice).toFixed(2)}
              </span>
              <span className="text-xs text-gray-500">{isSurface ? '/m²' : '/each'}</span>
              {isTrade && <span className="text-[10px] text-gray-400 font-normal ml-0.5">ex. VAT</span>}
              {is_sale && (() => {
                // Show WAS price if available, otherwise fall back to min_price
                const wasPrice = collection.max_was_price || min_price;
                return wasPrice && wasPrice > displayBasePrice ? (
                  <span className="text-sm text-gray-400 line-through">
                    £{(isTrade ? getProductTradePrice(wasPrice) : wasPrice).toFixed(2)}
                  </span>
                ) : null;
              })()}
            </div>
            );
          })()}

          {/* Credit Back Badge (trade users only) */}
          {isTrade && collection.credit_back_rate > 0 && (
            <div className="flex items-center gap-1" data-testid="credit-back-badge">
              <span className="text-[11px] font-medium text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded">
                Extra {collection.credit_back_rate}% Credit Back
              </span>
            </div>
          )}

          {/* Colour Swatches */}
          {thumbnailImages.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-2" data-testid="collection-card-swatches">
              {thumbnailImages.slice(0, 6).map((item, idx) => {
                const colorName = (extractColorLabel(item.color) || item.color || `Variant ${idx + 1}`).replace(/\b\w/g, c => c.toUpperCase());
                return (
                  <div 
                    key={idx}
                    className="flex flex-col items-center"
                  >
                    <div className="w-14 h-14 rounded-lg border border-gray-200 overflow-hidden hover:ring-2 hover:ring-amber-400 hover:ring-offset-1 transition-all shadow-sm">
                      <img 
                        src={imageUrl(item.image)} 
                        alt={colorName}
                        className="w-full h-full object-cover"
                        loading="lazy"
                        onError={(e) => {
                          // Production has had broken swatch URLs from
                          // an old CDN migration. Fall back to a neutral
                          // placeholder so the card stays clean instead
                          // of showing the broken-image icon. After
                          // failing once we hide the <img> entirely
                          // (the colour name below still labels it).
                          if (!e.target.dataset.fallbackTried) {
                            e.target.dataset.fallbackTried = '1';
                            e.target.src = '/images/swatch-placeholder.svg';
                          } else {
                            e.target.style.display = 'none';
                            const parent = e.target.parentElement;
                            if (parent && !parent.dataset.placeholderApplied) {
                              parent.dataset.placeholderApplied = '1';
                              parent.classList.add('bg-gradient-to-br', 'from-gray-100', 'to-gray-200', 'flex', 'items-center', 'justify-center');
                              const span = document.createElement('span');
                              span.className = 'text-[10px] text-gray-400 font-semibold';
                              span.textContent = (colorName || 'Variant').slice(0, 2).toUpperCase();
                              parent.appendChild(span);
                            }
                          }
                        }}
                      />
                    </div>
                    <span className="text-[11px] text-gray-500 mt-1 leading-tight text-center max-w-[60px] truncate">
                      {colorName}
                    </span>
                  </div>
                );
              })}
              {thumbnailImages.length > 6 && (
                <div className="flex flex-col items-center justify-center">
                  <div className="w-14 h-14 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center">
                    <span className="text-sm text-gray-500 font-medium">+{thumbnailImages.length - 6}</span>
                  </div>
                  <span className="text-[11px] text-gray-400 mt-1">More</span>
                </div>
              )}
            </div>
          )}

          {/* Sizes & Finishes — compact tag row */}
          {((sizes && sizes.length > 0) || (finishes && finishes.length > 0)) && (
            <div className="flex flex-wrap gap-1 pt-2" data-testid="collection-card-specs">
              {[...(sizes || [])].sort((a, b) => {
                const aOutdoor = (a.match(/x/gi) || []).length >= 2;
                const bOutdoor = (b.match(/x/gi) || []).length >= 2;
                if (aOutdoor !== bOutdoor) return aOutdoor ? 1 : -1;
                const aNums = a.match(/\d+/g) || [0]; const bNums = b.match(/\d+/g) || [0];
                const aArea = (Number(aNums[0])||0) * (Number(aNums[1])||Number(aNums[0])||0);
                const bArea = (Number(bNums[0])||0) * (Number(bNums[1])||Number(bNums[0])||0);
                return aArea - bArea;
              }).map((size, idx) => (
                <span key={`s-${idx}`} className="px-1.5 py-0.5 text-[10px] font-medium text-gray-600 bg-gray-100 rounded">
                  {size.replace('cm', '')}
                </span>
              ))}
              {(finishes || []).map((finish, idx) => (
                <span key={`f-${idx}`} className="px-1.5 py-0.5 text-[10px] font-medium text-amber-700 bg-amber-50 rounded">
                  {finish.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/\bR(\d+)\b/gi, (_, n) => `R${n}`)}
                </span>
              ))}
            </div>
          )}
        </div>
      </Link>
    </div>
  );
};

// Trending Collections Carousel
const TrendingCarousel = ({ collections, onQuickView }) => {
  const scrollRef = useRef(null);

  const scroll = (direction) => {
    if (scrollRef.current) {
      const scrollAmount = direction === 'left' ? -400 : 400;
      scrollRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' });
    }
  };

  if (!collections || collections.length === 0) return null;

  return (
    <section className="py-12 bg-gray-50">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <TrendingUp className="w-6 h-6 text-amber-500" />
            <h2 className="text-2xl font-light text-gray-900">Trending Now</h2>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => scroll('left')}
              className="p-2 rounded-full border border-gray-300 hover:bg-white hover:shadow-md transition-all"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={() => scroll('right')}
              className="p-2 rounded-full border border-gray-300 hover:bg-white hover:shadow-md transition-all"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div 
          ref={scrollRef}
          className="flex gap-6 overflow-x-auto scrollbar-hide pb-4 -mx-4 px-4"
          style={{ scrollSnapType: 'x mandatory' }}
        >
          {collections.slice(0, 8).map((collection, idx) => (
            <div 
              key={idx} 
              className="flex-shrink-0 w-72"
              style={{ scrollSnapAlign: 'start' }}
            >
              <CollectionCard 
                collection={collection} 
                useLifestyleImages={false}
                onQuickView={onQuickView}
                gridCols={4}
              />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

// Recently Viewed Section
const RecentlyViewed = ({ onQuickView }) => {
  const [recentItems, setRecentItems] = useState([]);
  const { isTrade, getTradePrice } = useTradeUser();

  useEffect(() => {
    const saved = localStorage.getItem('recently_viewed_collections');
    if (saved) {
      try {
        setRecentItems(JSON.parse(saved).slice(0, 4));
      } catch (e) {
        console.error('Error loading recently viewed:', e);
      }
    }
  }, []);

  if (recentItems.length === 0) return null;

  return (
    <section className="py-12 border-t border-gray-100">
      <div className="container mx-auto px-4">
        <div className="flex items-center gap-3 mb-6">
          <Clock className="w-5 h-5 text-gray-500" />
          <h2 className="text-xl font-light text-gray-900">Recently Viewed</h2>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          {recentItems.map((item, idx) => (
            <Link 
              key={idx}
              to={`/shop/collection/${encodeURIComponent(item.series_name)}`}
              className="group"
            >
              <div className="aspect-square rounded-lg overflow-hidden bg-gray-100 mb-2">
                <img 
                  src={imageUrl(item.image) || getLifestyleImage(item.series_name)}
                  alt={item.series_name}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                />
              </div>
              <p className="text-sm font-medium text-gray-900 group-hover:text-amber-600 transition-colors">
                {item.series_name}
              </p>
              {item.price && (
                <p className="text-sm text-gray-500">From £{(isTrade ? getTradePrice(item.price) : item.price).toFixed(2)}{item.is_surface_product !== false ? '/m²' : '/each'}{isTrade && <span className="text-[10px] text-gray-400 ml-1">ex. VAT</span>}</p>
              )}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
};

// Main Collections Page
const TileCollectionsPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [collections, setCollections] = useState([]);
  const [trendingCollections, setTrendingCollections] = useState([]);
  const [navigationItems, setNavigationItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);  // { kind, retryAt } when collections endpoint fails after retries
  const [totalPages, setTotalPages] = useState(1);
  const [totalCollections, setTotalCollections] = useState(0);
  const [totalProducts, setTotalProducts] = useState(0);
  const [viewMode, setViewMode] = useState('product');
  const [showFilters, setShowFilters] = useState(false);
  const [activeFilters, setActiveFilters] = useState({});
  const [gridCols, setGridCols] = useState(3);
  const [quickViewCollection, setQuickViewCollection] = useState(null);
  const [heroSlideIndex, setHeroSlideIndex] = useState(0);
  const [sortBy, setSortBy] = useState('default');
  // In-page narrow-search — lets customers find a specific tile/collection
  // within the current category (e.g. "matt large format" inside Wall Tiles)
  // without scoping out to the whole catalogue.
  const [inPageQuery, setInPageQuery] = useState('');
  // 14 May 2026 — debounced mirror of inPageQuery so we don't fire a
  // backend request on every keystroke. 250 ms feels instant and saves
  // ~10 round-trips for a 5-char query.
  const [inPageDebounced, setInPageDebounced] = useState('');
  
  // Page settings from admin
  const [pageSettings, setPageSettings] = useState(null);
  const [heroSlides, setHeroSlides] = useState(HERO_SLIDES);
  const [roomLinks, setRoomLinks] = useState(ROOM_LINKS);
  const [popularFilters, setPopularFilters] = useState(POPULAR_FILTERS);
  
  const { addToCart } = useCart();
  const { addSample } = useSampleCart();

  // Legacy search-URL redirect — the header used to navigate searches here
  // (`/tiles?search=X`), but tile collections only cover tiles + flooring
  // so tools / grouts / accessories were invisible. Any remaining links
  // (bookmarks, old marketing emails) now 302 to the unified results page.
  const navigate = useNavigate();
  const legacySearchTerm = (searchParams.get('search') || '').trim();
  useEffect(() => {
    if (legacySearchTerm) {
      navigate(`/shop/search?q=${encodeURIComponent(legacySearchTerm)}`, { replace: true });
    }
  }, [legacySearchTerm, navigate]);

  // Sort collections
  const sortedCollections = useMemo(() => {
    const sorted = [...collections];
    switch (sortBy) {
      case 'price-low':
        return sorted.sort((a, b) => (a.min_price || 0) - (b.min_price || 0));
      case 'price-high':
        return sorted.sort((a, b) => (b.min_price || 0) - (a.min_price || 0));
      case 'name-az':
        return sorted.sort((a, b) => (a.series_name || '').localeCompare(b.series_name || ''));
      case 'name-za':
        return sorted.sort((a, b) => (b.series_name || '').localeCompare(a.series_name || ''));
      case 'newest':
        return sorted.sort((a, b) => (b.is_new ? 1 : 0) - (a.is_new ? 1 : 0));
      case 'popular':
        return sorted.sort((a, b) => (b.product_count || 0) - (a.product_count || 0));
      default:
        return sorted;
    }
  }, [collections, sortBy]);

  // Build a single haystack string per collection so a tokenised query can
  // match against name + supplier + sizes + finishes + colours + labels.
  // All tokens must match (AND) so "wood matt" requires both "wood" AND "matt"
  // to appear somewhere — same UX as the global tile search.
  // 14 May 2026 — debounce inPageQuery + reset to page=1 whenever it
  // changes so search results don't get truncated by stale pagination.
  useEffect(() => {
    const id = setTimeout(() => {
      setInPageDebounced(inPageQuery);
      // When the query becomes non-empty (and changes), bounce to page 1
      // so the server returns the *first* page of matching collections
      // rather than e.g. page 3 (which only contained the user's slice
      // before search was applied).
      if (inPageQuery.trim() && currentFilters.page !== '1') {
        const next = new URLSearchParams(searchParams);
        next.set('page', '1');
        setSearchParams(next, { replace: true });
      }
    }, 250);
    return () => clearTimeout(id);
    // currentFilters.page intentionally excluded — we only want to
    // bounce when the *user* types, not when pagination updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inPageQuery]);

  const displayedCollections = useMemo(() => {
    // Server is now responsible for `search` filtering (see
    // effectiveSearch above). The client-side haystack fallback is
    // kept only as a defensive measure if the server ignores the
    // search param for some reason — it filters the already-fetched
    // page rather than expanding it.
    const q = inPageDebounced.trim().toLowerCase();
    if (!q) return sortedCollections;
    const tokens = q.split(/\s+/).filter(Boolean);
    return sortedCollections.filter(c => {
      const swatchColors = (c.color_swatches || []).map(s => s.color || '').join(' ');
      const colours = (c.colors || []).map(x => typeof x === 'string' ? x : (x?.name || '')).join(' ');
      const haystack = [
        c.series_name,
        c.supplier,
        c.made_in,
        (c.sizes || []).join(' '),
        (c.finishes || []).join(' '),
        colours,
        swatchColors,
        (c.labels || []).join(' '),
      ].filter(Boolean).join(' ').toLowerCase();
      return tokens.every(t => haystack.includes(t));
    });
  }, [sortedCollections, inPageDebounced]);

  usePageTracking();

  // Fetch page settings from admin
  useEffect(() => {
    const fetchPageSettings = async () => {
      try {
        const res = await fetch(`${API_URL}/api/website-admin/public/collections-page-settings`);
        if (res.ok) {
          const data = await res.json();
          if (data.settings && Object.keys(data.settings).length > 0) {
            setPageSettings(data.settings);
            // popularFilters are not group-specific, apply directly
            if (data.settings.popularFilters?.length > 0) {
              setPopularFilters(data.settings.popularFilters.filter(f => f.enabled !== false));
            }
          }
        }
      } catch (e) {
        console.error('Error fetching page settings:', e);
      }
    };
    fetchPageSettings();
  }, []);

  // Hero slideshow
  useEffect(() => {
    if (heroSlides.length === 0) return;
    const interval = setInterval(() => {
      setHeroSlideIndex((prev) => (prev + 1) % heroSlides.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [heroSlides.length]);

  // Get current filter values from URL
  const currentFilters = useMemo(() => ({
    category: searchParams.get('category') || '',
    group: searchParams.get('group') || '',
    filter: searchParams.get('filter') || '',
    sale: searchParams.get('sale') || '',
    collection: searchParams.get('collection') || '',
    search: searchParams.get('search') || '',
    style: searchParams.get('style') || '',
    type: searchParams.get('type') || '',
    isNew: searchParams.get('new') === 'true',
    page: parseInt(searchParams.get('page')) || 1,
  }), [searchParams]);

  // ?type=wall|floor — homepage footer uses these. Translate to the backing
  // category so the products query stays a single contract on the server.
  const effectiveCategory = useMemo(() => {
    if (currentFilters.category) return currentFilters.category;
    if (currentFilters.type === 'wall') return 'wall-tiles';
    if (currentFilters.type === 'floor') return 'floor-tiles';
    return '';
  }, [currentFilters.category, currentFilters.type]);

  // ?style=marble-effect|wood-effect|stone-effect|patterned — translate to a
  // search keyword so the backend product list narrows to matching names.
  const effectiveSearch = useMemo(() => {
    // 14 May 2026 — in-page search box typing on `?page=2` only matched
    // collections already on screen (e.g. searching "Dolomite" on page 1
    // returned "0 of 36 collections match" because Dolomite Onyx was on
    // page 2). Fix: feed the in-page query into the same backend search
    // param so the server filters across the entire catalogue, not the
    // current page's slice.
    if (inPageDebounced.trim()) return inPageDebounced.trim();
    if (currentFilters.search) return currentFilters.search;
    const styleMap = {
      'marble-effect': 'marble',
      'wood-effect': 'wood',
      'stone-effect': 'stone',
      'patterned': 'pattern',
    };
    return styleMap[currentFilters.style] || '';
  }, [inPageDebounced, currentFilters.search, currentFilters.style]);

  // Context-aware hero — overrides the rotating carousel whenever a filter is
  // active, so 'Outdoor Tiles' link doesn't show a 'Bathroom Tiles' hero.
  const filteredHero = useMemo(() => {
    const titleCase = (s) => (s || '').replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    if (currentFilters.style) {
      const map = {
        'marble-effect': { title: 'Marble Effect Tiles', subtitle: 'Timeless luxury, durable surface' },
        'wood-effect': { title: 'Wood Effect Tiles', subtitle: 'Warmth of wood, ease of tile' },
        'stone-effect': { title: 'Stone Effect Tiles', subtitle: 'Natural texture, modern finish' },
        'patterned': { title: 'Patterned Tiles', subtitle: 'Bold statement floors and walls' },
      };
      return map[currentFilters.style] || { title: titleCase(currentFilters.style), subtitle: 'Curated collections' };
    }
    if (currentFilters.type === 'wall') return { title: 'Wall Tiles', subtitle: 'Refresh any space, floor to ceiling' };
    if (currentFilters.type === 'floor') return { title: 'Floor Tiles', subtitle: 'Hard-wearing finishes for every room' };
    if (currentFilters.isNew) return { title: 'New Collections', subtitle: 'Fresh arrivals just in' };
    if (currentFilters.category) {
      const t = titleCase(currentFilters.category);
      return { title: t, subtitle: `Browse our ${t.toLowerCase()} range` };
    }
    return null; // fall back to the rotating carousel
  }, [currentFilters.style, currentFilters.type, currentFilters.isNew, currentFilters.category]);

  // Switch hero slides based on active product group
  useEffect(() => {
    const group = currentFilters.group || 'tiles';
    if (group === 'tiles') {
      if (pageSettings?.heroEnabled === false) {
        setHeroSlides([]);
      } else if (pageSettings?.heroSlides?.length > 0) {
        setHeroSlides(pageSettings.heroSlides.filter(s => s.enabled !== false));
      } else {
        setHeroSlides(HERO_SLIDES);
      }
    } else {
      const groupSettings = pageSettings?.groups?.[group];
      if (groupSettings?.heroEnabled === false) {
        setHeroSlides([]);
      } else if (groupSettings?.heroSlides?.length > 0) {
        setHeroSlides(groupSettings.heroSlides.filter(s => s.enabled !== false));
      } else {
        setHeroSlides(GROUP_HERO_SLIDES[group] || HERO_SLIDES);
      }
    }
    setHeroSlideIndex(0);
  }, [currentFilters.group, pageSettings]);

  // Switch room quick links based on active product group
  useEffect(() => {
    const group = currentFilters.group || 'tiles';
    if (group === 'tiles') {
      if (pageSettings?.roomLinksEnabled === false) {
        setRoomLinks([]);
      } else if (pageSettings?.roomLinks?.length > 0) {
        setRoomLinks(pageSettings.roomLinks.filter(r => r.enabled !== false));
      } else {
        setRoomLinks(ROOM_LINKS);
      }
    } else {
      const groupSettings = pageSettings?.groups?.[group];
      if (groupSettings?.roomLinksEnabled === false) {
        setRoomLinks([]);
      } else if (groupSettings?.roomLinks?.length > 0) {
        setRoomLinks(groupSettings.roomLinks.filter(r => r.enabled !== false));
      } else {
        setRoomLinks(GROUP_ROOM_LINKS[group] || ROOM_LINKS);
      }
    }
  }, [currentFilters.group, pageSettings]);

  const currentHeroSlide = heroSlides[heroSlideIndex] || heroSlides[0];

  // Fetch navigation - per product group
  useEffect(() => {
    const fetchNavigation = async () => {
      try {
        // Determine which group's tabs to load
        const group = currentFilters.group;
        const menuType = (group && group !== 'tiles') ? `shop_${group}` : 'shop';
        const res = await fetch(`${API_URL}/api/website-admin/public/navigation/${menuType}`);
        if (res.ok) {
          const data = await res.json();
          // If group-specific tabs are empty, fall back to default 'shop' tabs
          if (data.length === 0 && menuType !== 'shop') {
            const fallbackRes = await fetch(`${API_URL}/api/website-admin/public/navigation/shop`);
            if (fallbackRes.ok) {
              setNavigationItems(await fallbackRes.json());
            }
          } else {
            setNavigationItems(data);
          }
        } else {
          setNavigationItems([
            { id: '1', label: 'ALL TILES', link_url: '/tiles', is_active: true },
            { id: '2', label: 'WALL TILES', link_url: '/tiles?category=wall-tiles', is_active: true },
            { id: '3', label: 'FLOOR TILES', link_url: '/tiles?category=floor-tiles', is_active: true },
            { id: '4', label: 'SALE', link_url: '/tiles?sale=true', is_active: true, highlight: true },
          ]);
        }
      } catch (e) {
        console.error('Error loading navigation:', e);
      }
    };
    fetchNavigation();
  }, [currentFilters.group]);

  // Reset the in-page narrow-search whenever the customer navigates to
  // a different category/group. Otherwise a stale query from "Wall Tiles"
  // would silently filter "Floor Tiles" and feel broken.
  useEffect(() => {
    setInPageQuery('');
  }, [currentFilters.category, currentFilters.group, currentFilters.sale]);

  // Fetch collections — with auto-retry + graceful failure. We retry up
  // to 3 times with exponential backoff if the backend returns 503 or
  // an obvious error response, so a single slow Mongo query no longer
  // shows the customer "0 collections" (today's outage). On final
  // failure we set `loadError` so the UI can render a "trouble loading"
  // state with a manual retry button instead of a fake empty result.
  useEffect(() => {
    let cancelled = false;

    const fetchOnce = async () => {
      const params = new URLSearchParams();
      if (effectiveCategory) params.append('category', effectiveCategory);
      if (currentFilters.filter) params.append('filter', currentFilters.filter);
      // Always send group — default to 'tiles' so Materials/Flooring/etc don't leak in
      params.append('group', currentFilters.group || 'tiles');
      if (effectiveSearch) params.append('search', effectiveSearch);
      if (currentFilters.sale) params.append('sale', currentFilters.sale);
      params.append('page', currentFilters.page);
      params.append('limit', 24);
      Object.entries(activeFilters).forEach(([key, values]) => {
        if (Array.isArray(values) && values.length > 0) {
          params.append(key, values.join(','));
        } else if (values === true) {
          params.append(key, 'true');
        }
      });
      const res = await fetch(`${API_URL}/api/tiles/collections?${params}`);
      const data = await res.json().catch(() => ({}));
      // 503 with retry_after, or backend signalled "temporarily_unavailable"
      const transient = res.status === 503
        || res.status === 502
        || res.status === 504
        || data?.error === 'temporarily_unavailable';
      return { ok: res.ok && !transient, transient, data, status: res.status };
    };

    const fetchWithRetry = async () => {
      setLoading(true);
      setLoadError(null);
      const delays = [800, 1500, 3000];  // ~5s total worst case
      let lastData = null;
      for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
          const { ok, transient, data } = await fetchOnce();
          lastData = data;
          if (ok) {
            if (cancelled) return;
            setCollections(data.collections || []);
            setTotalPages(data.total_pages || 1);
            setTotalCollections(data.total || 0);
            setTotalProducts(data.total_products || 0);
            if (trendingCollections.length === 0 && data.collections?.length > 0) {
              setTrendingCollections(safeArr(data.collections).slice(0, 8));
            }
            setLoadError(null);
            return;
          }
          if (!transient) break;  // hard 4xx — no point retrying
        } catch (e) {
          // network blip — also retry
          console.warn(`Collections fetch attempt ${attempt + 1} failed:`, e?.message);
        }
        if (attempt < delays.length) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
        }
      }
      // All retries exhausted — surface a real error state, NOT an
      // empty "0 collections" result the customer might mistake for
      // a depleted catalogue.
      if (cancelled) return;
      console.error('Collections endpoint failed after retries', lastData);
      setLoadError({
        kind: 'temporarily_unavailable',
        retryAt: Date.now() + 5000,
      });
    };

    fetchWithRetry().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentFilters, activeFilters, effectiveCategory, effectiveSearch]);

  const handleFilterChange = (newFilters) => {
    setActiveFilters(newFilters);
    const newParams = new URLSearchParams(searchParams);
    newParams.set('page', '1');
    setSearchParams(newParams);
  };

  const parseFilterFromUrl = (url) => {
    try {
      const urlObj = new URL(url, window.location.origin);
      return {
        category: urlObj.searchParams.get('category'),
        filter: urlObj.searchParams.get('filter'),
        sale: urlObj.searchParams.get('sale'),
        group: urlObj.searchParams.get('group'),
      };
    } catch {
      return { category: null, filter: null, sale: null, group: null };
    }
  };

  const isNavItemActive = (item) => {
    const { category, filter, sale, group } = parseFilterFromUrl(item.link_url || '');
    // "ALL X" link: no category, filter, or sale — active when none of those are set
    if (!category && !filter && !sale && !currentFilters.category && !currentFilters.filter && !currentFilters.sale) {
      return true;
    }
    return category === currentFilters.category || filter === currentFilters.filter || (sale === 'true' && currentFilters.sale === 'true');
  };

  const handleNavClick = (item) => {
    const { category, filter, sale, group } = parseFilterFromUrl(item.link_url || '');
    const newParams = new URLSearchParams();
    // Preserve current group context, or use the one from the clicked link
    const activeGroup = group || currentFilters.group;
    if (activeGroup) newParams.set('group', activeGroup);
    if (category) newParams.set('category', category);
    if (filter) newParams.set('filter', filter);
    if (sale) newParams.set('sale', sale);
    newParams.set('page', '1');
    setSearchParams(newParams);
  };

  const updateFilter = (key, value) => {
    const newParams = new URLSearchParams(searchParams);
    if (value) newParams.set(key, String(value));
    else newParams.delete(key);
    if (key !== 'page') newParams.set('page', '1');
    setSearchParams(newParams);
  };

  // Save to recently viewed
  useEffect(() => {
    if (quickViewCollection) {
      trackRecentView({
        slug: quickViewCollection.series_slug || encodeURIComponent(quickViewCollection.series_name),
        display_name: quickViewCollection.series_name,
        image: quickViewCollection.hero_image,
        price: quickViewCollection.prices_from,
        product_group: quickViewCollection.product_group || currentFilters.group || 'tiles',
        is_surface_product: quickViewCollection.is_surface_product,
      });
    }
  }, [quickViewCollection]);

  const gridColsClass = {
    2: 'grid-cols-1 md:grid-cols-2 gap-8 lg:gap-12',
    3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 lg:gap-10',
    4: 'grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 lg:gap-6',
  };

  return (
    <div className="min-h-screen bg-white" data-testid="tile-collections-page">
      <SeoHead
        title={
          currentFilters.search
            ? `${currentFilters.search} — Tile Search`
            : 'All Tile Collections · Premium Range with Free UK Delivery'
        }
        description={
          currentFilters.search
            ? `Search results for "${currentFilters.search}" — browse premium tile collections at Tile Station with free UK delivery on orders over £500.`
            : 'Browse all tile collections at Tile Station — kitchen, bathroom, floor and wall tiles in every size and finish. Free UK delivery on orders over £500.'
        }
        canonical="/tiles"
        noindex={!!currentFilters.search}
        keywords="tile collections, tile shop, kitchen tiles, bathroom tiles, floor tiles, porcelain tiles, ceramic tiles UK"
      />
      <ShopHeader />

      {/* Search Results Banner */}
      {currentFilters.search && (
        <section className="bg-gray-50 border-b px-4 md:px-12 lg:px-20 py-8">
          <div className="max-w-screen-2xl mx-auto">
            <p className="text-sm text-gray-500 mb-1">Search results for</p>
            <h1 className="text-2xl md:text-3xl font-light text-gray-900">
              "{currentFilters.search}"
            </h1>
            <p className="text-sm text-gray-500 mt-2">
              {loading
                ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="inline-block w-3 h-3 border-2 border-gray-300 border-t-amber-500 rounded-full animate-spin" />
                    Searching our collections…
                  </span>
                )
                : `${totalCollections} ${totalCollections === 1 ? 'collection' : 'collections'} found`}
            </p>
          </div>
        </section>
      )}

      {/* Enhanced Hero Banner with Slideshow */}
      {!currentFilters.search && heroSlides.length > 0 && (
      <section className="relative h-[50vh] md:h-[70vh] overflow-hidden">
        {/* Background Images */}
        {heroSlides.map((slide, index) => (
          <div
            key={slide.id}
            className={`absolute inset-0 transition-all duration-1000 ${
              index === heroSlideIndex ? 'opacity-100 scale-100' : 'opacity-0 scale-105'
            }`}
          >
            <img
              src={slide.image}
              alt={slide.title}
              className="w-full h-full object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-black/60 via-black/30 to-transparent" />
          </div>
        ))}

        {/* Hero Content */}
        <div className="relative z-10 h-full flex flex-col justify-center px-4 md:px-12 lg:px-20 max-w-screen-2xl mx-auto">
          <div className="max-w-2xl pb-20 md:pb-24">
            <p className="text-amber-400 text-xs sm:text-sm font-medium tracking-widest uppercase mb-3 md:mb-4 animate-fadeInUp">
              {GROUP_HERO_LABEL[currentFilters.group] || GROUP_HERO_LABEL.tiles}
            </p>
            <h1 
              key={heroSlideIndex}
              className="text-2xl sm:text-4xl md:text-5xl lg:text-6xl font-light text-white mb-3 md:mb-4 animate-fadeInUp"
              data-testid="tiles-hero-title"
            >
              {filteredHero?.title || currentHeroSlide?.title}
            </h1>
            <p className="text-white/80 text-sm sm:text-lg md:text-xl mb-5 md:mb-8 animate-fadeInUp animation-delay-100 line-clamp-2">
              {filteredHero?.subtitle || currentHeroSlide?.subtitle}
            </p>
            <Link
              to={currentHeroSlide?.link || '/tiles'}
              className="inline-flex items-center gap-2 px-6 py-3 sm:px-8 sm:py-4 bg-white text-gray-900 font-semibold rounded-full hover:bg-amber-400 hover:text-white transition-all hover:scale-105 animate-fadeInUp animation-delay-200 text-sm sm:text-base"
            >
              Explore Collection
              <ChevronRight className="w-5 h-5" />
            </Link>
          </div>

          {/* Shop by Room Quick Links */}
          {(pageSettings?.roomLinksEnabled !== false) && roomLinks.length > 0 && (
          <div className="absolute bottom-4 md:bottom-8 left-4 md:left-12 lg:left-20 right-4 md:right-12 lg:right-20 hidden sm:block">
            <div className="flex flex-wrap gap-2 md:gap-3">
              {roomLinks.map((room) => (
                <Link
                  key={room.id}
                  to={room.link}
                  className={`flex items-center gap-2 px-4 py-2 rounded-full backdrop-blur-md transition-all hover:scale-105
                    ${room.id === heroSlides[heroSlideIndex]?.id 
                      ? 'bg-white text-gray-900' 
                      : 'bg-white/20 text-white hover:bg-white/40'}`}
                >
                  <span>{room.icon}</span>
                  <span className="text-sm font-medium">{room.label}</span>
                </Link>
              ))}
            </div>
          </div>
          )}

          {/* Slide Indicators */}
          <div className="absolute bottom-8 right-4 md:right-12 lg:right-20 flex gap-2">
            {heroSlides.map((_, index) => (
              <button
                key={index}
                onClick={() => setHeroSlideIndex(index)}
                className={`w-2 h-2 rounded-full transition-all ${
                  index === heroSlideIndex ? 'bg-white w-8' : 'bg-white/40 hover:bg-white/60'
                }`}
              />
            ))}
          </div>
        </div>
      </section>
      )}

      {/* Popular Filters Bar */}
      {(pageSettings?.filtersEnabled !== false) && popularFilters.length > 0 && (
      <div className="border-b border-gray-100 bg-gray-50/50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-3 overflow-x-auto scrollbar-hide">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wider shrink-0">
              Popular:
            </span>
            {popularFilters.map((filter) => (
              <button
                key={filter.label || filter.id}
                onClick={() => updateFilter('filter', filter.filter)}
                className="px-4 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-full hover:border-gray-900 hover:text-gray-900 transition-all whitespace-nowrap"
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      )}

      {/* Navigation Bar */}
      <nav className="border-b border-gray-200 sticky top-0 bg-white z-40 shadow-sm">
        <div className="container mx-auto px-4">
          <div className="flex items-center justify-between py-4">
            {/* Nav Items */}
            <div className="flex items-center gap-3 sm:gap-6 overflow-x-auto scrollbar-hide">
              {navigationItems.filter(item => item.is_active).map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleNavClick(item)}
                  className={`text-xs sm:text-sm tracking-wide whitespace-nowrap transition-colors ${
                    isNavItemActive(item)
                      ? 'text-gray-900 border-b-2 border-gray-900 pb-1 font-medium' 
                      : item.highlight 
                        ? 'text-red-600 hover:text-red-700 font-medium'
                        : 'text-gray-500 hover:text-gray-900'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            {/* Controls */}
            <div className="flex items-center gap-3 ml-4 shrink-0">
              {/* Mobile Filter Toggle */}
              <button
                onClick={() => setShowFilters(!showFilters)}
                className="lg:hidden flex items-center gap-2 px-3 py-2 rounded-lg border hover:bg-gray-50 text-sm"
              >
                <Filter className="w-4 h-4" />
                Filters
                {Object.keys(activeFilters).length > 0 && (
                  <span className="bg-gray-900 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center">
                    {Object.keys(activeFilters).length}
                  </span>
                )}
              </button>

              {/* Grid Size Toggle */}
              <div className="hidden md:flex items-center gap-1 bg-gray-100 rounded-lg p-1">
                <button
                  onClick={() => setGridCols(2)}
                  className={`p-2 rounded-md transition-all ${gridCols === 2 ? 'bg-white shadow-sm' : 'hover:bg-white/50'}`}
                  title="2 columns"
                >
                  <Rows3 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setGridCols(3)}
                  className={`p-2 rounded-md transition-all ${gridCols === 3 ? 'bg-white shadow-sm' : 'hover:bg-white/50'}`}
                  title="3 columns"
                >
                  <Grid3X3 className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setGridCols(4)}
                  className={`p-2 rounded-md transition-all ${gridCols === 4 ? 'bg-white shadow-sm' : 'hover:bg-white/50'}`}
                  title="4 columns"
                >
                  <LayoutGrid className="w-4 h-4" />
                </button>
              </div>

              {/* View Mode */}
              <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
                <button
                  onClick={() => setViewMode('product')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-all ${
                    viewMode === 'product' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                  }`}
                >
                  <Image className="w-4 h-4" />
                  <span className="hidden sm:inline">Products</span>
                </button>
                <button
                  onClick={() => setViewMode('lifestyle')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-all ${
                    viewMode === 'lifestyle' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                  }`}
                >
                  <Home className="w-4 h-4" />
                  <span className="hidden sm:inline">Rooms</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </nav>

      {/* Sale Banner — only visible when SALE tab is active */}
      {currentFilters.sale === 'true' && (
        <div className="bg-gradient-to-r from-red-600 to-red-700 text-white py-2" data-testid="sale-banner">
          <div className="container mx-auto px-4 flex items-center justify-center gap-3">
            <span className="text-sm font-bold tracking-widest uppercase">Sale</span>
            <span className="w-px h-4 bg-white/40" />
            <span className="text-sm font-medium">Up to 70% Off Selected Lines</span>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="flex gap-8">
          {/* Filter Sidebar - Desktop */}
          <aside className="hidden lg:block w-72 shrink-0">
            <div className="sticky top-24">
              <FilterPanel 
                pageSlug="collections"
                category={currentFilters.category}
                group={currentFilters.group || "tiles"}
                onFilterChange={handleFilterChange}
                style="sidebar"
              />
            </div>
          </aside>

          {/* Mobile Filter Panel */}
          {showFilters && (
            <div className="lg:hidden fixed inset-0 z-50 bg-black/50" onClick={() => setShowFilters(false)}>
              <div 
                className="absolute left-0 top-0 bottom-0 w-80 max-w-[85vw] bg-white p-4 overflow-y-auto shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold text-lg">Filters</h2>
                  <button 
                    onClick={() => setShowFilters(false)}
                    className="p-2 hover:bg-gray-100 rounded-full"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
                <FilterPanel 
                  pageSlug="collections"
                  category={currentFilters.category}
                  group={currentFilters.group || "tiles"}
                  onFilterChange={handleFilterChange}
                  style="sidebar"
                />
              </div>
            </div>
          )}

          {/* Products Grid */}
          <div className="flex-1 min-w-0">
            {/* Results Header */}
            <div className="mb-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex-shrink-0">
                <h2 className="text-2xl font-light text-gray-900 mb-1">
                  {currentFilters.sale === 'true'
                    ? 'Sale'
                    : currentFilters.category 
                      ? currentFilters.category.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
                      : 'All Collections'}
                </h2>
                <p className="text-sm text-gray-500" data-testid="collections-count-label">
                  {loading
                    ? (
                      <span className="inline-flex items-center gap-2 text-gray-500">
                        <span className="inline-block w-3 h-3 border-2 border-gray-300 border-t-amber-500 rounded-full animate-spin" />
                        Loading our latest collections…
                      </span>
                    )
                    : inPageQuery.trim()
                      ? `${displayedCollections.length} of ${totalCollections} collections match "${inPageQuery.trim()}"`
                      : `${totalCollections} collections • ${totalProducts.toLocaleString()} products`}
                </p>
              </div>

              {/* Spacer + In-page narrow-search input */}
              <div className="flex-1 w-full sm:max-w-md sm:mx-4">
                <div className="relative">
                  <svg
                    className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 pointer-events-none"
                    fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-4.35-4.35M16 10a6 6 0 11-12 0 6 6 0 0112 0z" />
                  </svg>
                  <input
                    type="search"
                    value={inPageQuery}
                    onChange={(e) => setInPageQuery(e.target.value)}
                    placeholder={`Search ${(currentFilters.sale === 'true'
                      ? 'Sale'
                      : currentFilters.category
                        ? currentFilters.category.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
                        : 'all collections')}…`}
                    className="w-full pl-10 pr-10 py-2 text-sm border border-gray-300 rounded-lg bg-white text-gray-700 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400"
                    data-testid="in-page-search-input"
                    aria-label="Search within this category"
                  />
                  {inPageQuery && (
                    <button
                      type="button"
                      onClick={() => setInPageQuery('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100"
                      data-testid="in-page-search-clear"
                      aria-label="Clear search"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3 flex-shrink-0">
                {Object.keys(activeFilters).length > 0 && (
                  <button 
                    onClick={() => setActiveFilters({})}
                    className="text-sm text-amber-600 hover:text-amber-700 font-medium"
                  >
                    Clear all filters
                  </button>
                )}
                <select
                  value={sortBy}
                  onChange={e => setSortBy(e.target.value)}
                  className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-amber-400 focus:border-amber-400 cursor-pointer"
                  data-testid="sort-dropdown"
                >
                  <option value="default">Sort by: Default</option>
                  <option value="price-low">Price: Low to High</option>
                  <option value="price-high">Price: High to Low</option>
                  <option value="name-az">Name: A to Z</option>
                  <option value="name-za">Name: Z to A</option>
                  <option value="newest">Newest First</option>
                  <option value="popular">Most Products</option>
                </select>
              </div>
            </div>

            {/* Collections Grid */}
            {loading ? (
              <div className={`grid ${gridColsClass[gridCols]}`}>
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="animate-pulse">
                    <div className="bg-gray-200 aspect-[3/4] rounded-xl mb-4"></div>
                    <div className="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
                    <div className="h-4 bg-gray-200 rounded w-1/2 mb-2"></div>
                    <div className="flex gap-2">
                      {[...Array(3)].map((_, j) => (
                        <div key={j} className="w-10 h-10 bg-gray-200 rounded"></div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : loadError ? (
              <div className="text-center py-20" data-testid="collections-load-error">
                <div className="inline-block bg-amber-50 border border-amber-300 rounded-2xl px-8 py-10 max-w-md">
                  <div className="text-5xl mb-3">🔄</div>
                  <h3 className="text-xl font-bold text-slate-900 mb-2">We're having trouble loading our collections</h3>
                  <p className="text-slate-600 mb-6 text-sm">
                    Our catalogue is temporarily unavailable. This is on us, not you — we're already on it. Click below to try again, or refresh the page in a few seconds.
                  </p>
                  <button
                    onClick={() => {
                      // Force a re-fetch by re-setting activeFilters to a new
                      // object reference — the fetch effect depends on this
                      // and a new reference re-triggers it cleanly.
                      setLoadError(null);
                      setActiveFilters((p) => ({ ...p }));
                    }}
                    className="px-6 py-3 bg-slate-900 hover:bg-slate-800 text-yellow-300 font-bold rounded-full transition-all"
                    data-testid="collections-retry-btn"
                  >
                    Try again
                  </button>
                </div>
              </div>
            ) : collections.length === 0 ? (
              <div className="text-center py-20">
                <Sparkles className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                <h3 className="text-xl font-medium text-gray-900 mb-2">No collections found</h3>
                <p className="text-gray-500 mb-6">Try adjusting your filters or browse all collections</p>
                <button 
                  onClick={() => {
                    setActiveFilters({});
                    setSearchParams({});
                  }}
                  className="px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-full transition-all"
                >
                  View All Collections
                </button>
              </div>
            ) : displayedCollections.length === 0 ? (
              // In-page query produced no matches — give the customer a clear
              // escape hatch to the global search instead of a dead-end.
              <div className="text-center py-20" data-testid="in-page-search-empty">
                <Sparkles className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                <h3 className="text-xl font-medium text-gray-900 mb-2">
                  No matches for &ldquo;{inPageQuery.trim()}&rdquo; in {currentFilters.category
                    ? currentFilters.category.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
                    : 'this section'}
                </h3>
                <p className="text-gray-500 mb-6">
                  We couldn&apos;t find anything in this category matching your search. Try a wider search across the whole site.
                </p>
                <div className="flex flex-col sm:flex-row gap-3 items-center justify-center">
                  <button
                    onClick={() => setInPageQuery('')}
                    className="px-6 py-3 border border-gray-300 hover:border-gray-400 text-gray-700 font-semibold rounded-full transition-all"
                    data-testid="in-page-search-empty-clear"
                  >
                    Clear search
                  </button>
                  <Link
                    to={`/shop/search?q=${encodeURIComponent(inPageQuery.trim())}`}
                    className="px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-full transition-all"
                    data-testid="in-page-search-empty-global"
                  >
                    Search all of Tile Station →
                  </Link>
                </div>
              </div>
            ) : (
              <div className={`grid ${gridColsClass[gridCols]}`}>
                {displayedCollections.map((collection, idx) => (
                  <CollectionCard 
                    key={idx} 
                    collection={collection} 
                    useLifestyleImages={viewMode === 'lifestyle'}
                    onQuickView={setQuickViewCollection}
                    gridCols={gridCols}
                  />
                ))}
              </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex justify-center gap-2 mt-16">
                <button
                  onClick={() => updateFilter('page', Math.max(1, currentFilters.page - 1))}
                  disabled={currentFilters.page === 1}
                  className="px-4 py-2 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                {[...Array(Math.min(totalPages, 7))].map((_, i) => {
                  let pageNum;
                  if (totalPages <= 7) {
                    pageNum = i + 1;
                  } else if (currentFilters.page <= 4) {
                    pageNum = i + 1;
                  } else if (currentFilters.page >= totalPages - 3) {
                    pageNum = totalPages - 6 + i;
                  } else {
                    pageNum = currentFilters.page - 3 + i;
                  }
                  return (
                    <button
                      key={i}
                      onClick={() => updateFilter('page', pageNum)}
                      className={`w-10 h-10 flex items-center justify-center rounded-lg text-sm font-medium transition-all ${
                        currentFilters.page === pageNum
                          ? 'bg-gray-900 text-white'
                          : 'border border-gray-200 hover:border-gray-400'
                      }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
                <button
                  onClick={() => updateFilter('page', Math.min(totalPages, currentFilters.page + 1))}
                  disabled={currentFilters.page === totalPages}
                  className="px-4 py-2 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Trending Collections Carousel */}
      {trendingCollections.length > 0 && (
        <TrendingCarousel 
          collections={trendingCollections} 
          onQuickView={setQuickViewCollection}
        />
      )}

      {/* Recently Viewed */}
      <RecentlyViewedSection maxItems={6} />

      {/* You May Also Need - Cross-group recommendations */}
      <YouMayAlsoNeed currentGroup={currentFilters.group || 'tiles'} maxItems={6} />

      <ShopFooter />
      
      {/* Quick View Modal */}
      <QuickViewModal
        isOpen={!!quickViewCollection}
        onClose={() => setQuickViewCollection(null)}
        collection={quickViewCollection}
        onAddToCart={addToCart}
        onAddSample={addSample}
      />

      {/* Live Chat Widget */}
      <LiveChatWidget />

      {/* Custom Animations */}
      <style jsx>{`
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-fadeInUp {
          animation: fadeInUp 0.6s ease-out forwards;
        }
        .animation-delay-100 {
          animation-delay: 0.1s;
          opacity: 0;
        }
        .animation-delay-200 {
          animation-delay: 0.2s;
          opacity: 0;
        }
        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }
        .scrollbar-hide {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }
      `}</style>
    </div>
  );
};

export default TileCollectionsPage;
