import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, MapPin, User, Heart, ShoppingBag, ChevronRight, ChevronLeft, Phone, Mail, ArrowRight, Menu, X, Scissors, Calculator, Building2, Truck, Package, Star, Palette, Home, Eye, Award, Percent, Gift, Headphones, TrendingUp, Sparkles } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useCart } from '../../contexts/TileCartContext';
import { useWishlist } from '../../contexts/WishlistContext';
import { useSampleCart } from '../../contexts/SampleCartContext';
import { BrandMarquee } from '../../components/shop/BrandMarquee';
import { VideoShowroom } from '../../components/shop/VideoShowroom';
import { ShowroomTours } from '../../components/shop/ShowroomTours';
import { GoogleReviews } from '../../components/shop/GoogleReviews';
import { ProductCarousel } from '../../components/shop/ProductCarousel';
import AnnouncementRibbon from '../../components/shop/AnnouncementRibbon';
import PromoBanner from '../../components/shop/PromoBanner';
import { usePageTracking } from '../../hooks/usePageTracking';
import { useTradeUser } from '../../hooks/useTradeUser';
import LiveChatWidget from '../../components/shop/LiveChatWidget';
import WelcomePopup from '../../components/shop/WelcomePopup';
import SeoHead from '../../components/seo/SeoHead';
import { normaliseImageUrl } from '../../utils/safeStr';

// Lazy so the homepage doesn't join the TileCollectionsPage import cycle
const RecentlyViewedSection = React.lazy(() =>
  import('../../components/shop/CrossSellSections').then(m => ({ default: m.RecentlyViewedSection }))
);

const API_URL = process.env.REACT_APP_BACKEND_URL;

const ensureClearanceNav = (items) => {
  const arr = Array.isArray(items) ? items : [];
  if (arr.some(i => /clearance/i.test(i?.label || '') || /clearance=true/.test(i?.link_url || ''))) return arr;
  return [...arr, { id: 'clearance-auto', label: 'CLEARANCE', link_url: '/tiles?clearance=true', is_active: true, highlight: true, highlight_color: '#FF2A00' }];
};

// Top Utility Bar - Dynamic from Admin
const TopUtilityBar = () => {
  const [benefits, setBenefits] = useState([]);

  useEffect(() => {
    const fetchBenefits = async () => {
      try {
        const response = await fetch(`${API_URL}/api/website-admin/public/benefits-bar`);
        if (response.ok) {
          const data = await response.json();
          setBenefits(data);
        } else {
          // Use defaults on error
          setBenefits([
            { text: 'Pay in 3 ways with Klarna', link: '/shop/tile-cart' },
            { text: 'Free samples with free delivery', link: '/shop/sample-service' },
            { text: 'Free collection from all stores', link: '/shop/contact' },
            { text: 'Free delivery on orders over £499', link: '/shop/info/delivery' },
          ]);
        }
      } catch (error) {
        setBenefits([
          { text: 'Pay in 3 ways with Klarna', link: '/shop/tile-cart' },
          { text: 'Free samples with free delivery', link: '/shop/sample-service' },
          { text: 'Free collection from all stores', link: '/shop/contact' },
          { text: 'Free delivery on orders over £499', link: '/shop/info/delivery' },
        ]);
      }
    };
    fetchBenefits();
  }, []);

  if (benefits.length === 0) return null;

  return (
    <div className="bg-[#1a1a1a] text-white py-2 overflow-hidden">
      <div className="container mx-auto px-4">
        <div className="flex justify-center items-center gap-4 md:gap-8 text-xs md:text-sm flex-wrap">
          {benefits.map((benefit, idx) => (
            <Link 
              key={idx} 
              to={benefit.link} 
              className="hover:text-[#F7EA1C] transition whitespace-nowrap"
            >
              {benefit.text}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
};

// Header Component - Topps Tiles inspired
const ShopHeader = ({ cartCount: propCartCount }) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [showSearch, setShowSearch] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [navItems, setNavItems] = useState([]);
  const [isNavSticky, setIsNavSticky] = useState(false);
  const navigate = useNavigate();
  const { isTrade, getTradePrice, tradeCompanyName } = useTradeUser();
  
  const { cart, getCartItemCount } = useCart();
  const { wishlist } = useWishlist();
  const { sampleCount } = useSampleCart();
  
  const cartCount = propCartCount || getCartItemCount() || cart?.length || 0;
  const wishlistCount = wishlist?.length || 0;

  // Handle scroll to make nav sticky
  useEffect(() => {
    const handleScroll = () => {
      // Get the nav element's initial position (approximately after header)
      const scrollThreshold = 160; // Approximate height of header sections
      setIsNavSticky(window.scrollY > scrollThreshold);
    };
    
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const fetchNavigation = async () => {
      const fallbackNav = [
        { id: '1', label: 'NEW COLLECTIONS', link_url: '/tiles?new=true', highlight: true, highlight_color: '#333333' },
        { id: '2', label: 'ALL TILES', link_url: '/tiles', highlight: false },
        { id: '3', label: 'FLOORING', link_url: '/tiles?group=flooring', highlight: false },
        { id: '4', label: 'BATHROOM', link_url: '/shop/bathroom', highlight: false },
        { id: '5', label: 'UNDERFLOOR HEATING', link_url: '/tiles?group=underfloor-heating', highlight: false },
        { id: '6', label: 'MATERIALS', link_url: '/tiles?group=materials', highlight: false },
        { id: '7', label: 'TOOLS & ACCESSORIES', link_url: '/tiles?group=tools-accessories', highlight: false }
      ];
      
      try {
        const res = await fetch(`${API_URL}/api/website-admin/public/navigation/main`);
        if (res.ok) {
          const data = await res.json();
          // Use data if it has items, otherwise use fallback
          if (data && data.length > 0) {
            setNavItems(ensureClearanceNav(data));
          } else {
            setNavItems(ensureClearanceNav(fallbackNav));
          }
        } else {
          setNavItems(ensureClearanceNav(fallbackNav));
        }
      } catch (e) {
        setNavItems(ensureClearanceNav(fallbackNav));
      }
    };
    fetchNavigation();
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('tile_shop_token');
    if (token) {
      const customer = localStorage.getItem('tile_shop_customer');
      if (customer) {
        setIsLoggedIn(true);
        try {
          const customerData = JSON.parse(customer);
          setCustomerName(customerData.name?.split(' ')[0] || 'Account');
        } catch (e) {
          setCustomerName('Account');
        }
      }
    }
  }, []);

  const handleSearch = async (query) => {
    setSearchQuery(query);
    if (query.length > 1) {
      try {
        const res = await fetch(`${API_URL}/api/tiles/search?q=${encodeURIComponent(query)}&limit=5`);
        const data = await res.json();
        setSearchResults(data);
        setShowSearch(true);
      } catch (e) {
        console.error('Search error:', e);
      }
    } else {
      setSearchResults([]);
      setShowSearch(false);
    }
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      // Unified storefront search — `/tiles?search=…` only returned tile
      // collections so tools / grouts / accessories were invisible.
      navigate(`/shop/search?q=${encodeURIComponent(searchQuery)}`);
      setShowSearch(false);
    }
  };

  return (
    <>
    <PromoBanner />
    <AnnouncementRibbon />
    <header className="relative z-[60]">
      <TopUtilityBar />
      
      {/* Main Header - Dark gray background for logo visibility */}
      <div className="bg-[#4a4a4a] border-b border-gray-700">
        <div className="container mx-auto px-4 py-3 md:py-4">
          <div className="flex items-center justify-between gap-4">
            {/* Mobile Menu Button */}
            <button 
              className="lg:hidden p-2 text-white hover:text-[#F7EA1C]"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Menu"
              data-testid="mobile-menu-btn"
            >
              {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>

            {/* Logo */}
            <Link to="/shop" className="flex-shrink-0 group" data-testid="header-logo">
              <img
                src="/images/tilestation-logo.png"
                alt="Tile Station"
                className="h-20 sm:h-24 md:h-28 w-auto transition-transform duration-300 ease-in-out group-hover:scale-105"
              />
            </Link>

            {/* Search - Desktop */}
            <form onSubmit={handleSearchSubmit} className="flex-1 max-w-xl relative hidden md:block">
              <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-gray-400" />
                <Input
                  type="text"
                  placeholder="Search tiles, flooring, accessories..."
                  className="pl-12 pr-4 py-3 w-full bg-white/90 text-gray-900 border-0 rounded-full focus:ring-2 focus:ring-[#F7EA1C] focus:bg-white"
                  value={searchQuery}
                  onChange={(e) => handleSearch(e.target.value)}
                  onFocus={() => searchResults.length > 0 && setShowSearch(true)}
                  data-testid="search-input"
                />
              </div>
              
              {/* Search Results Dropdown */}
              {showSearch && searchResults.length > 0 && (
                <div className="absolute top-full left-0 right-0 bg-white border rounded-lg shadow-xl mt-2 z-50 text-gray-900 max-h-96 overflow-auto">
                  {searchResults.map((result, idx) => (
                    <Link
                      key={idx}
                      to={result.collection 
                        ? `/shop/collection/${encodeURIComponent(result.collection)}?product=${result.slug}`
                        : `/tiles/${result.slug}`
                      }
                      className="flex items-center gap-4 p-4 hover:bg-gray-50 border-b last:border-0"
                      onClick={() => setShowSearch(false)}
                    >
                      {normaliseImageUrl(result.image) && (
                        <img src={normaliseImageUrl(result.image)} alt="" className="w-16 h-16 object-cover rounded-lg" />
                      )}
                      <div className="flex-1">
                        <p className="font-medium">{result.name}</p>
                        <p className="text-[#F7EA1C] font-semibold">£{(isTrade ? getTradePrice(result.price) : result.price)?.toFixed(2)}{result.is_surface_product !== false ? '/m²' : '/each'}{isTrade && <span className="text-[10px] text-[#F7EA1C]/60 font-normal ml-1">ex. VAT</span>}</p>
                      </div>
                    </Link>
                  ))}
                  <Link
                    to={`/shop/search?q=${encodeURIComponent(searchQuery)}`}
                    className="block p-4 text-center text-[#333] hover:bg-gray-50 font-medium border-t"
                    onClick={() => setShowSearch(false)}
                  >
                    View all results for "{searchQuery}"
                  </Link>
                </div>
              )}
            </form>

            {/* Actions */}
            <div className="flex items-center gap-2 sm:gap-4 lg:gap-6">
              <Link to="/shop/contact" className="hidden lg:flex flex-col items-center text-white/80 hover:text-[#F7EA1C] transition" data-testid="stores-link">
                <MapPin className="h-6 w-6" />
                <span className="text-xs mt-1">Contact</span>
              </Link>
              {!isTrade && (isLoggedIn ? (
                <Link to="/shop/tile-account" className="hidden sm:flex flex-col items-center text-white/80 hover:text-[#F7EA1C] transition" data-testid="account-link">
                  <User className="h-6 w-6" />
                  <span className="text-xs mt-1">{customerName}</span>
                </Link>
              ) : (
                <Link to="/shop/tile-login" className="hidden sm:flex flex-col items-center text-white/80 hover:text-[#F7EA1C] transition" data-testid="login-link">
                  <User className="h-6 w-6" />
                  <span className="text-xs mt-1">Sign In</span>
                </Link>
              ))}
              {/* Visualize nav link intentionally removed (May 3 2026) — feature is hidden from customer-facing site until polish complete. Admins access it via /admin/visualizer. */}
              <Link to="/shop/tile-samples" className="flex flex-col items-center text-white/80 hover:text-[#F7EA1C] relative transition" data-testid="samples-link">
                <Scissors className="h-6 w-6" />
                <span className="text-xs mt-1 hidden sm:block">Samples</span>
                {sampleCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-green-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold">
                    {sampleCount}
                  </span>
                )}
              </Link>
              <Link to="/shop/tile-wishlist" className="flex flex-col items-center text-white/80 hover:text-[#F7EA1C] relative transition" data-testid="wishlist-link">
                <Heart className="h-6 w-6" />
                <span className="text-xs mt-1 hidden sm:block">Wishlist</span>
                {wishlistCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center">
                    {wishlistCount}
                  </span>
                )}
              </Link>
              <Link to="/shop/tile-cart" className="flex flex-col items-center text-white/80 hover:text-[#F7EA1C] relative transition" data-testid="cart-link">
                <ShoppingBag className="h-6 w-6" />
                <span className="text-xs mt-1 hidden sm:block">Basket</span>
                {cartCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-[#F7EA1C] text-[#333] text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold" data-testid="cart-count">
                    {Math.floor(Number(cartCount) || 0)}
                  </span>
                )}
              </Link>

              {/* TRADE Tab - far right, flat rectangular like Topps Tiles */}
              <Link
                to={isTrade ? "/shop/trade/account" : "/shop/trade/login"}
                className={`hidden sm:flex items-center gap-2.5 px-7 self-stretch font-bold tracking-wide transition-all duration-200 ${
                  isTrade
                    ? 'bg-[#F7EA1C] text-[#333333]'
                    : 'bg-[#F7EA1C] text-[#333333] hover:bg-[#e6d518]'
                }`}
                data-testid="trade-tab"
              >
                <Building2 className="w-5 h-5" />
                <div className="flex flex-col leading-tight">
                  <span className="text-xs font-bold opacity-70">Tile Station</span>
                  <span className="text-base font-black tracking-wider">{isTrade ? tradeCompanyName : 'TRADE'}</span>
                </div>
              </Link>
            </div>
          </div>

          {/* Mobile Search */}
          <form onSubmit={handleSearchSubmit} className="mt-3 md:hidden">
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                type="text"
                placeholder="Search tiles..."
                className="pl-10 pr-4 w-full bg-white/90 text-gray-900 rounded-full"
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
              />
            </div>
          </form>
        </div>
      </div>
    </header>
    
    {/* Navigation Bar - Yellow background, becomes fixed when scrolling past header */}
    <nav className={`bg-[#F7EA1C] text-gray-900 z-50 shadow-md transition-all duration-200 ${
      isNavSticky 
        ? 'fixed top-0 left-0 right-0 animate-in slide-in-from-top-2' 
        : 'relative'
    }`}>
      <div className="container mx-auto px-4">
        <ul className="hidden lg:flex items-center justify-center gap-0 text-sm font-semibold uppercase">
          {navItems.map(item => (
            <li key={item.id}>
              <Link 
                to={item.link_url || '/tiles'} 
                className={`block px-5 py-3 hover:bg-[#e5d918] transition-colors whitespace-nowrap`}
                style={item.highlight && item.highlight_color ? { color: item.highlight_color, fontWeight: 'bold' } : {}}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
    {/* Spacer to prevent content jump when nav becomes fixed */}
    {isNavSticky && <div className="h-[44px] hidden lg:block"></div>}

    {/* Mobile Menu Overlay */}
    {mobileMenuOpen && (
      <div className="lg:hidden fixed inset-0 z-[100] bg-black/50" onClick={() => setMobileMenuOpen(false)}>
        <div 
          className="absolute left-0 top-0 bottom-0 w-80 max-w-[85vw] bg-white shadow-xl overflow-y-auto"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-4 border-b bg-[#333333] text-white flex justify-between items-center">
            <span className="font-bold text-lg">Menu</span>
            <button onClick={() => setMobileMenuOpen(false)} className="p-2">
              <X className="h-6 w-6" />
            </button>
          </div>
          {/* Sign In / Account - above nav items */}
          <div className="border-b border-gray-200">
            {isTrade ? (
              <Link to="/shop/trade/account" onClick={() => setMobileMenuOpen(false)}
                className="flex items-center gap-3 px-6 py-3.5 text-gray-800 hover:bg-gray-50 font-medium">
                <User className="h-5 w-5" />
                <span>Trade Account</span>
              </Link>
            ) : isLoggedIn ? (
              <Link to="/shop/tile-account" onClick={() => setMobileMenuOpen(false)}
                className="flex items-center gap-3 px-6 py-3.5 text-gray-800 hover:bg-gray-50 font-medium">
                <User className="h-5 w-5" />
                <span>{customerName || 'My Account'}</span>
              </Link>
            ) : (
              <Link to="/shop/tile-login" onClick={() => setMobileMenuOpen(false)}
                className="flex items-center gap-3 px-6 py-3.5 text-gray-800 hover:bg-gray-50 font-medium">
                <User className="h-5 w-5" />
                <span>Sign In</span>
              </Link>
            )}
          </div>

          {/* Trade/Retail Switcher - Topps Tiles style, above nav items */}
          <div className="flex border-b border-gray-200" data-testid="mobile-brand-switcher-home">
            <Link
              to="/shop"
              onClick={() => setMobileMenuOpen(false)}
              className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-bold transition-colors ${
                !isTrade
                  ? 'bg-[#333333] text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              Tile Station
            </Link>
            <Link
              to={isTrade ? "/shop/trade/account" : "/shop/trade/login"}
              onClick={() => setMobileMenuOpen(false)}
              className={`flex-1 flex items-center justify-center gap-2 py-3 text-sm font-bold transition-colors ${
                isTrade
                  ? 'bg-[#F7EA1C] text-[#333333]'
                  : 'bg-[#F7EA1C]/60 text-[#333333]/70 hover:bg-[#F7EA1C]'
              }`}
            >
              Tile Station TRADE
            </Link>
          </div>

          {/* Nav Items */}
          <div className="py-0">
            {navItems.map(item => (
              <Link 
                key={item.id}
                to={item.link_url || '/tiles'} 
                onClick={() => setMobileMenuOpen(false)} 
                className="block px-6 py-3.5 text-gray-800 hover:bg-gray-50 border-b border-gray-100 font-medium uppercase"
                style={item.highlight && item.highlight_color ? { color: item.highlight_color } : {}}
              >
                {item.label}
              </Link>
            ))}
            <div className="border-t border-gray-200 mt-2 pt-2">
              <Link to="/shop/contact" onClick={() => setMobileMenuOpen(false)} className="flex items-center gap-3 px-6 py-3.5 text-gray-600 hover:bg-gray-50">
                <MapPin className="h-5 w-5" /> Contact Us
              </Link>
              {!isTrade && !isLoggedIn && (
                <Link to="/shop/register" onClick={() => setMobileMenuOpen(false)} className="flex items-center gap-3 px-6 py-3.5 text-gray-600 hover:bg-gray-50">
                  <User className="h-5 w-5" /> Create Account
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
};

// Hero Banner Carousel - Dynamic from Admin
const HeroBannerCarousel = () => {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [slides, setSlides] = useState([]);
  const [loading, setLoading] = useState(true);

  // Fallback slides
  const fallbackSlides = [
    {
      image: 'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=1600&q=80',
      badge: 'UP TO 1/3 OFF',
      title: 'THE SPRING COLLECTION',
      subtitle: 'Revitalise your home this spring with savings you\'ll love!',
      cta: 'Shop Now',
      link: '/tiles?sale=true'
    },
    {
      image: 'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?w=1600&q=80',
      badge: 'NEW ARRIVALS',
      title: 'OUTDOOR TILES',
      subtitle: 'Transform your garden with our stunning outdoor collection',
      cta: 'Explore Now',
      link: '/tiles?category=outdoor'
    },
    {
      image: 'https://images.unsplash.com/photo-1552321554-5fefe8c9ef14?w=1600&q=80',
      badge: 'FREE SAMPLES',
      title: 'TRY BEFORE YOU BUY',
      subtitle: 'Order up to 3 free samples delivered to your door',
      cta: 'Order Samples',
      link: '/shop/sample-service'
    }
  ];

  useEffect(() => {
    const fetchSlides = async () => {
      try {
        const response = await fetch(`${API_URL}/api/website-admin/public/hero-slides`);
        if (response.ok) {
          const data = await response.json();
          if (data && data.length > 0) {
            setSlides(data);
          } else {
            setSlides(fallbackSlides);
          }
        } else {
          setSlides(fallbackSlides);
        }
      } catch (error) {
        setSlides(fallbackSlides);
      } finally {
        setLoading(false);
      }
    };
    fetchSlides();
  }, []);

  useEffect(() => {
    if (slides.length > 1) {
      // 24 May 2026 — per-slide rotation speed (admin-configurable in
      // /admin/marketing-studio publish dialog). We pick the first
      // active slide that carries an explicit `rotation_seconds`; if
      // nothing's set, fall back to the historical 5s default so
      // admins who don't touch the control see unchanged behaviour.
      // Clamp to 2-30s on the frontend too as a defensive belt-and-
      // braces against bad data.
      const fromSlide = slides
        .map((s) => Number(s.rotation_seconds))
        .find((n) => Number.isFinite(n) && n >= 2 && n <= 30);
      const intervalMs = (fromSlide || 5) * 1000;
      const timer = setInterval(() => {
        setCurrentSlide((prev) => (prev + 1) % slides.length);
      }, intervalMs);
      return () => clearInterval(timer);
    }
  }, [slides]);

  const navigate = useNavigate();

  if (loading) {
    return (
      <section className="relative h-[50vh] sm:h-[60vh] md:h-[70vh] overflow-hidden bg-gray-200 animate-pulse" />
    );
  }

  // 24 May 2026 (v6 — user reported the crop is BACK on production
  // even with v5 deployed. Root cause: v5's "image-only" detection
  // was an `every()` gate AND only checked `theme === 'image-only'`.
  // Production hero_slides had a mix — one Marketing-Studio banner
  // plus 2 leftover seeded slides with theme=default — so the gate
  // failed and the whole section fell back to legacy h-[50vh] +
  // object-cover, re-cropping the banner exactly like v1).
  //
  // v6 fixes BOTH problems:
  //   1. Treat `source === 'marketing_studio'` as a synonym for
  //      image-only. Marketing-Studio always bakes the headline,
  //      CTA and lifestyle imagery INTO the asset, so the theme
  //      flag is now belt-and-braces, not the source of truth.
  //   2. Switch from `every()` to `some()` for the section-shell
  //      gate — even one baked-in slide should drive the better
  //      mobile shell. The per-slide object-fit logic below still
  //      uses the same predicate so themed slides paint correctly
  //      inside the new shell.
  const isBakedBanner = (s) =>
    s.theme === 'image-only' || s.source === 'marketing_studio';
  const anyBakedBanner = slides.length > 0 && slides.some(isBakedBanner);
  const allHaveMobileVariant = slides.length > 0 && slides.every((s) => !!s.mobile_image);
  const sectionHeightClass = anyBakedBanner
    ? (allHaveMobileVariant
        ? 'aspect-[3/4] sm:aspect-[1920/600] sm:max-h-[70vh]'
        : 'aspect-[2/1] sm:aspect-[1920/600] sm:max-h-[70vh]')
    : 'h-[50vh] sm:h-[60vh] md:h-[70vh]';

  return (
    <section className={`relative ${sectionHeightClass} overflow-hidden bg-slate-900`} data-testid="hero-carousel">
      {slides.map((slide, idx) => (
        <div
          key={idx}
          className={`absolute inset-0 transition-opacity duration-700 ${idx === currentSlide ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          onClick={() => slide.link && navigate(slide.link)}
          style={{ cursor: slide.link ? 'pointer' : 'default' }}
        >
          {!isBakedBanner(slide) && (
            <div className="absolute inset-0 z-10" style={{ background: slide.theme === 'sale' ? 'linear-gradient(to right, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.9) 35%, rgba(0,0,0,0.5) 60%, transparent 80%)' : 'linear-gradient(to right, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.4) 50%, transparent 80%)' }} />
          )}
          {/* 24 May 2026 (v4/v6) — blurred letterbox backdrop. Renders
              for baked-in marketing-studio banners on mobile only,
              when no portrait variant is uploaded. v6 widened the
              predicate from `theme === 'image-only'` to
              `isBakedBanner()` so legacy slides still tagged
              theme=sale/default but published via Marketing Studio
              get the proper treatment. */}
          {isBakedBanner(slide) && !slide.mobile_image && (
            <div
              aria-hidden
              className="absolute inset-0 sm:hidden"
              style={{
                backgroundImage: `url(${slide.image})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                filter: 'blur(36px) brightness(0.55) saturate(1.15)',
                transform: 'scale(1.15)',
              }}
              data-testid="hero-mobile-blur-backdrop"
            />
          )}
          {/* `<picture>` MUST be positioned (relative + z-[1]) so it
              paints ON TOP of the absolute-positioned blurred backdrop
              above. Without explicit positioning the picture is a
              static inline element and absolute siblings (the backdrop)
              would paint over the sharp banner. `block w-full h-full`
              gives the picture explicit dimensions so the img's
              `w-full h-full` has something concrete to size against. */}
          <picture className="relative z-[1] block w-full h-full">
            {slide.mobile_image && (
              <source media="(max-width: 639px)" srcSet={slide.mobile_image} />
            )}
            <img
              src={slide.image}
              alt={slide.title}
              className={`w-full h-full ${
                isBakedBanner(slide)
                  ? (slide.mobile_image
                      ? 'object-cover sm:object-contain'
                      : 'object-contain')
                  : 'object-cover'
              }`}
              loading={idx === 0 ? 'eager' : 'lazy'}
            />
          </picture>
          {/* SALE THEME */}
          {slide.theme === 'sale' && !isBakedBanner(slide) && (
            <div className="absolute inset-0 z-20 flex items-center pointer-events-none" style={{ WebkitFontSmoothing: 'antialiased', MozOsxFontSmoothing: 'grayscale', fontFamily: "'Inter', sans-serif", fontStyle: 'normal' }}>
              <div className="container mx-auto px-4">
                <div className="max-w-3xl" style={{ transform: 'translateZ(0)' }}>
                  {slide.badge && (
                    <div className="flex items-center gap-4 mb-4">
                      <span 
                        className="inline-block px-6 py-3 text-base sm:text-lg tracking-widest rounded animate-pulse"
                        style={{ 
                          backgroundColor: slide.badgeColor || '#DC2626', 
                          color: slide.badgeTextColor || '#FFF',
                          fontWeight: 900
                        }}
                      >
                        {slide.badge}
                      </span>
                    </div>
                  )}
                  {slide.title && (
                    <h1 
                      className="text-3xl sm:text-5xl md:text-7xl lg:text-8xl text-white mb-2 leading-[0.9] tracking-tight"
                      style={{ fontWeight: 900 }}
                    >
                      {slide.title}
                    </h1>
                  )}
                  {slide.discount && (
                    <div className="mb-3 sm:mb-4">
                      <span 
                        className="text-xl sm:text-2xl md:text-3xl lg:text-4xl tracking-tight"
                        style={{ color: '#FF2020', fontWeight: 900 }}
                      >
                        {slide.discount}
                      </span>
                    </div>
                  )}
                  {slide.subtitle && (
                    <p className="text-sm sm:text-lg md:text-xl lg:text-2xl text-white mb-4 sm:mb-6 max-w-xl leading-snug" style={{ fontWeight: 800 }}>
                      {slide.subtitle}
                    </p>
                  )}
                  {slide.cta && (
                    <span
                      className="inline-flex items-center px-6 sm:px-10 md:px-12 py-3 sm:py-5 md:py-6 text-sm sm:text-lg tracking-wide rounded-lg"
                      style={{
                        backgroundColor: slide.ctaColor || '#DC2626',
                        color: slide.ctaTextColor || '#FFF',
                        boxShadow: '0 4px 20px rgba(220,38,38,0.6)',
                        fontWeight: 900
                      }}
                      data-testid="hero-cta-btn"
                    >
                      {slide.cta}
                      <ArrowRight className="ml-2 h-5 w-5 sm:h-6 sm:w-6" />
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* DEFAULT THEME */}
          {(slide.theme === 'default' || (!slide.theme && slide.theme !== 'image-only' && slide.theme !== 'sale')) && !isBakedBanner(slide) && (
            <div className="absolute inset-0 z-20 flex items-center pointer-events-none" style={{ WebkitFontSmoothing: 'antialiased', MozOsxFontSmoothing: 'grayscale' }}>
              <div className="container mx-auto px-4">
                <div className="max-w-xl">
                  {slide.badge && (
                    <span 
                      className="inline-block px-4 py-2 text-sm font-bold rounded mb-4"
                      style={{ 
                        backgroundColor: slide.badgeColor || '#F7EA1C', 
                        color: slide.badgeTextColor || '#333',
                        textShadow: 'none'
                      }}
                    >
                      {slide.badge}
                    </span>
                  )}
                  {slide.title && (
                    <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-4 leading-tight" style={{ textShadow: '0 2px 4px rgba(0,0,0,0.7)' }}>
                      {slide.title}
                    </h1>
                  )}
                  {slide.subtitle && (
                    <p className="text-base md:text-lg text-white mb-6 md:mb-8" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.7)' }}>
                      {slide.subtitle}
                    </p>
                  )}
                  {slide.cta && (
                    <span 
                      className="inline-flex items-center font-bold px-8 py-4 text-lg rounded-md"
                      style={{
                        backgroundColor: slide.ctaColor || '#F7EA1C',
                        color: slide.ctaTextColor || '#333',
                        textShadow: 'none'
                      }}
                      data-testid="hero-cta-btn"
                    >
                      {slide.cta}
                      <ArrowRight className="ml-2 h-5 w-5" />
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
      
      {/* Carousel Controls */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 flex gap-2">
        {slides.map((_, idx) => (
          <button
            key={idx}
            onClick={() => setCurrentSlide(idx)}
            className={`w-3 h-3 rounded-full transition-all ${idx === currentSlide ? 'bg-[#F7EA1C] w-8' : 'bg-white/50 hover:bg-white/80'}`}
            aria-label={`Go to slide ${idx + 1}`}
          />
        ))}
      </div>
      
      {/* Arrow Controls */}
      <button 
        onClick={() => setCurrentSlide((prev) => (prev - 1 + slides.length) % slides.length)}
        className="absolute left-4 top-1/2 -translate-y-1/2 z-30 p-2 bg-white/20 hover:bg-white/40 rounded-full transition hidden md:block"
        aria-label="Previous slide"
      >
        <ChevronLeft className="h-6 w-6 text-white" />
      </button>
      <button 
        onClick={() => setCurrentSlide((prev) => (prev + 1) % slides.length)}
        className="absolute right-4 top-1/2 -translate-y-1/2 z-30 p-2 bg-white/20 hover:bg-white/40 rounded-full transition hidden md:block"
        aria-label="Next slide"
      >
        <ChevronRight className="h-6 w-6 text-white" />
      </button>
    </section>
  );
};

// CLEARANCE strip — bold fire section, renders only when live clearance stock exists
const ClearanceHomeSection = () => {
  const [items, setItems] = useState([]);

  useEffect(() => {
    fetch(`${API_URL}/api/clearance/products`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => setItems((d?.items || []).filter(i => i.published).slice(0, 4)))
      .catch(() => {});
  }, []);

  if (items.length === 0) return null;

  return (
    <section data-testid="home-clearance-section" className="relative overflow-hidden bg-[#0A0A0A] text-white">
      <div className="absolute inset-0 flex flex-col justify-between py-3 opacity-[0.05] pointer-events-none select-none" aria-hidden="true">
        <div className="clearance-marquee whitespace-nowrap font-black uppercase text-6xl tracking-tighter text-white">
          {Array(8).fill('WHILE STOCKS LAST · ').join('')}
        </div>
        <div className="clearance-marquee-reverse whitespace-nowrap font-black uppercase text-6xl tracking-tighter text-[#FF2A00]">
          {Array(8).fill('FINAL REDUCTIONS · ').join('')}
        </div>
      </div>
      <div className="relative z-10 container mx-auto px-4 py-10 md:py-14">
        <div className="flex flex-col lg:flex-row lg:items-center gap-8">
          <div className="lg:w-1/3">
            <div className="inline-flex items-center gap-2 bg-[#FF2A00] text-white text-[11px] md:text-xs font-black uppercase tracking-[0.3em] px-3.5 py-1.5 -rotate-1 mb-4">
              While stocks last
            </div>
            <h2 className="text-5xl md:text-6xl font-black tracking-tighter uppercase leading-none">
              <span className="text-[#e5d918] clearance-fire-text">Clearance</span>
            </h2>
            <p className="mt-3 text-base md:text-lg font-bold text-[#e5d918]">
              Massive reductions — once they're gone, they're gone.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                to="/tiles?clearance=true"
                data-testid="home-clearance-shop-btn"
                className="inline-flex items-center gap-2 px-6 py-3.5 bg-[#FF2A00] text-white font-black text-sm md:text-base uppercase tracking-wider hover:bg-[#e5d918] hover:text-[#0A0A0A] transition-colors duration-300 shadow-[0_0_18px_rgba(255,42,0,0.5)]"
              >
                Shop Clearance
                <ArrowRight className="w-5 h-5" strokeWidth={3} />
              </Link>
              <a
                href={`${API_URL}/api/clearance/leaflet/current.pdf`}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="home-clearance-pdf-btn"
                className="inline-flex items-center gap-2 px-6 py-3.5 border-2 border-[#e5d918] text-[#e5d918] font-black text-sm md:text-base uppercase tracking-wider hover:bg-[#e5d918] hover:text-[#0A0A0A] transition-colors duration-300"
              >
                Leaflet (PDF)
              </a>
            </div>
          </div>
          <div className="lg:w-2/3 grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
            {items.map(i => (
              <Link
                key={i.sku}
                to="/tiles?clearance=true"
                className="group bg-white rounded-lg overflow-hidden text-gray-900"
                data-testid={`home-clearance-card-${i.sku}`}
              >
                <div className="relative aspect-square bg-gray-100 overflow-hidden">
                  {i.image && (
                    <img src={i.image} alt={i.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy" />
                  )}
                  <div className="absolute top-2 left-2 clearance-badge px-2 py-1 bg-[#e5d918] border-2 border-[#FF2A00] rounded-sm rotate-2">
                    <span className="text-[10px] font-black text-[#FF2A00] tracking-widest uppercase">Clearance</span>
                  </div>
                  {i.discount_percentage ? (
                    <div className="absolute bottom-2 right-2 bg-[#0A0A0A] text-[#e5d918] text-[11px] font-black px-2 py-1">
                      {i.discount_percentage}% OFF
                    </div>
                  ) : null}
                </div>
                <div className="p-2.5">
                  <p className="text-xs font-semibold truncate">{i.name}</p>
                  <p className="text-sm font-black text-[#FF2A00] mt-0.5">
                    {i.was_price ? <span className="text-gray-400 line-through font-medium text-xs mr-1.5">£{Number(i.was_price).toFixed(2)}</span> : null}
                    £{Number(i.price || 0).toFixed(2)}{i.pricing_unit === 'unit' ? '' : '/m²'}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

// Shop Categories Section - Dynamic from Navigation & Structure
const ShopCategories = () => {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);

  // Fallback categories if API fails
  const fallbackCategories = [
    { name: 'Sale', subtitle: 'Up to 1/3 off', image: 'https://images.pexels.com/photos/11043324/pexels-photo-11043324.jpeg?auto=compress&cs=tinysrgb&w=600', link: '/tiles?sale=true', highlight: true },
    { name: 'Outdoor Tiles', subtitle: 'New styles added', image: 'https://images.pexels.com/photos/11315954/pexels-photo-11315954.jpeg?auto=compress&cs=tinysrgb&w=600', link: '/tiles?category=outdoor' },
    { name: 'Kitchen Tiles', subtitle: '', image: 'https://images.pexels.com/photos/10855206/pexels-photo-10855206.jpeg?auto=compress&cs=tinysrgb&w=600', link: '/tiles?category=kitchen' },
    { name: 'Bathroom Tiles', subtitle: '', image: 'https://images.unsplash.com/photo-1621215058889-885f3d5a143c?w=600&q=80', link: '/tiles?category=bathroom' },
    { name: 'Floor Tiles', subtitle: '', image: 'https://images.pexels.com/photos/30992346/pexels-photo-30992346.jpeg?auto=compress&cs=tinysrgb&w=600', link: '/tiles?type=floor' },
    { name: 'Wall Tiles', subtitle: '', image: 'https://images.pexels.com/photos/220680/pexels-photo-220680.jpeg?auto=compress&cs=tinysrgb&w=600', link: '/tiles?type=wall' },
    { name: 'XL Tiles', subtitle: '', image: 'https://images.pexels.com/photos/7031615/pexels-photo-7031615.jpeg?auto=compress&cs=tinysrgb&w=600', link: '/tiles?size=xl' },
    { name: 'Mosaic Tiles', subtitle: 'New styles added', image: 'https://images.pexels.com/photos/31189964/pexels-photo-31189964.jpeg?auto=compress&cs=tinysrgb&w=600', link: '/tiles?category=mosaic' },
  ];

  // Per-category image mapping for when API categories lack images
  const categoryImageMap = {
    'sale': 'https://images.pexels.com/photos/11043324/pexels-photo-11043324.jpeg?auto=compress&cs=tinysrgb&w=600',
    'outdoor tiles': 'https://images.pexels.com/photos/11315954/pexels-photo-11315954.jpeg?auto=compress&cs=tinysrgb&w=600',
    'outdoor': 'https://images.pexels.com/photos/11315954/pexels-photo-11315954.jpeg?auto=compress&cs=tinysrgb&w=600',
    'kitchen tiles': 'https://images.pexels.com/photos/10855206/pexels-photo-10855206.jpeg?auto=compress&cs=tinysrgb&w=600',
    'kitchen': 'https://images.pexels.com/photos/10855206/pexels-photo-10855206.jpeg?auto=compress&cs=tinysrgb&w=600',
    'bathroom tiles': 'https://images.unsplash.com/photo-1621215058889-885f3d5a143c?w=600&q=80',
    'bathroom': 'https://images.unsplash.com/photo-1621215058889-885f3d5a143c?w=600&q=80',
    'floor tiles': 'https://images.pexels.com/photos/30992346/pexels-photo-30992346.jpeg?auto=compress&cs=tinysrgb&w=600',
    'floor': 'https://images.pexels.com/photos/30992346/pexels-photo-30992346.jpeg?auto=compress&cs=tinysrgb&w=600',
    'wall tiles': 'https://images.pexels.com/photos/220680/pexels-photo-220680.jpeg?auto=compress&cs=tinysrgb&w=600',
    'wall': 'https://images.pexels.com/photos/220680/pexels-photo-220680.jpeg?auto=compress&cs=tinysrgb&w=600',
    'xl tiles': 'https://images.pexels.com/photos/7031615/pexels-photo-7031615.jpeg?auto=compress&cs=tinysrgb&w=600',
    'large format': 'https://images.pexels.com/photos/7031615/pexels-photo-7031615.jpeg?auto=compress&cs=tinysrgb&w=600',
    'mosaic tiles': 'https://images.pexels.com/photos/31189964/pexels-photo-31189964.jpeg?auto=compress&cs=tinysrgb&w=600',
    'mosaic': 'https://images.pexels.com/photos/31189964/pexels-photo-31189964.jpeg?auto=compress&cs=tinysrgb&w=600',
    'wall & floor': 'https://images.pexels.com/photos/6899359/pexels-photo-6899359.jpeg?auto=compress&cs=tinysrgb&w=600',
    'wall & floor tiles': 'https://images.unsplash.com/photo-1769736436809-eab3de70b175?w=600&q=80',
    'flooring': 'https://images.pexels.com/photos/5353880/pexels-photo-5353880.jpeg?auto=compress&cs=tinysrgb&w=600',
  };

  // Pool of unique fallback images for categories without a name match
  const categoryFallbackPool = [
    'https://images.pexels.com/photos/11043324/pexels-photo-11043324.jpeg?auto=compress&cs=tinysrgb&w=600',
    'https://images.pexels.com/photos/8031931/pexels-photo-8031931.jpeg?auto=compress&cs=tinysrgb&w=600',
    'https://images.unsplash.com/photo-1696861080288-0cc2f1cd48d5?w=600&q=80',
    'https://images.unsplash.com/photo-1731167709688-f038c02eda4c?w=600&q=80',
  ];

  useEffect(() => {
    const fetchHomepageCategories = async () => {
      try {
        const response = await fetch(`${API_URL}/api/website-admin/categories/homepage`);
        if (response.ok) {
          const data = await response.json();
          if (data && data.length > 0) {
            const transformed = data.map((cat, idx) => ({
              name: cat.name,
              subtitle: cat.subtitle || '',
              image: cat.image_url || categoryImageMap[cat.name.toLowerCase()] || categoryFallbackPool[idx % categoryFallbackPool.length],
              // Custom destination link wins; otherwise default category route.
              link: (cat.custom_url && cat.custom_url.trim()) || `/tiles?category=${cat.slug}`,
              isExternal: cat.custom_url ? /^https?:\/\//i.test(cat.custom_url) : false,
              highlight: cat.highlight || false
            }));
            setCategories(transformed);
          } else {
            setCategories(fallbackCategories);
          }
        } else {
          setCategories(fallbackCategories);
        }
      } catch (error) {
        console.error('Error fetching homepage categories:', error);
        setCategories(fallbackCategories);
      } finally {
        setLoading(false);
      }
    };

    fetchHomepageCategories();
  }, []);

  if (loading) {
    return (
      <section className="py-12 md:py-16 bg-gray-50">
        <div className="container mx-auto px-4">
          <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-8 text-center">Shop our categories</h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
            {[1,2,3,4,5,6,7,8].map(i => (
              <div key={i} className="aspect-square bg-gray-200 animate-pulse rounded-xl" />
            ))}
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="py-12 md:py-16 bg-gray-50">
      <div className="container mx-auto px-4">
        <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-8 text-center">Shop our categories</h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6" data-testid="homepage-category-grid">
          {categories.map((cat, idx) => {
            const sharedProps = {
              className: "group relative rounded-xl overflow-hidden aspect-square shadow-md hover:shadow-xl transition-shadow",
              "data-testid": `category-${cat.name.toLowerCase().replace(/\s+/g, '-')}`,
            };
            const inner = (
              <>
                <img 
                  src={cat.image} 
                  alt={cat.name}
                  className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 p-4 md:p-6">
                  {cat.highlight && (
                    <span className="inline-block px-2 py-1 bg-[#F7EA1C] text-[#333] text-xs font-bold rounded mb-2">
                      {cat.subtitle}
                    </span>
                  )}
                  {!cat.highlight && cat.subtitle && (
                    <span className="text-[#F7EA1C] text-sm font-medium block mb-1">{cat.subtitle}</span>
                  )}
                  <h3 className="text-white font-bold text-lg md:text-xl">{cat.name}</h3>
                  <span className="text-white/80 text-sm group-hover:text-[#F7EA1C] transition-colors flex items-center gap-1 mt-2">
                    Shop now <ChevronRight className="h-4 w-4" />
                  </span>
                </div>
              </>
            );
            // External (http/https) links must use a real <a> tag with new-tab
            // semantics; same-origin paths use <Link> to keep SPA navigation.
            return cat.isExternal ? (
              <a key={idx} href={cat.link} target="_blank" rel="noopener noreferrer" {...sharedProps}>
                {inner}
              </a>
            ) : (
              <Link key={idx} to={cat.link} {...sharedProps}>
                {inner}
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
};

// Shop by Style Section - Dynamic from Navigation & Structure → Filters → Style
const ShopByStyle = () => {
  const [styles, setStyles] = useState([]);
  const [loading, setLoading] = useState(true);

  // Fallback styles in case API returns empty
  const fallbackStyles = [
    { name: 'Wood Effect', image: 'https://images.pexels.com/photos/10130293/pexels-photo-10130293.jpeg?auto=compress&cs=tinysrgb&w=600', link: '/tiles?style=wood-effect' },
    { name: 'Marble Effect', image: 'https://images.pexels.com/photos/8146211/pexels-photo-8146211.jpeg?auto=compress&cs=tinysrgb&w=600', link: '/tiles?style=marble-effect' },
    { name: 'Stone Effect', image: 'https://images.pexels.com/photos/8122356/pexels-photo-8122356.jpeg?auto=compress&cs=tinysrgb&w=600', link: '/tiles?style=stone-effect' },
    { name: 'Patterned', image: 'https://images.pexels.com/photos/7047482/pexels-photo-7047482.jpeg?auto=compress&cs=tinysrgb&w=600', link: '/tiles?style=patterned' },
  ];

  // Per-style image mapping for when API styles lack images
  const styleImageMap = {
    'wood effect': 'https://images.pexels.com/photos/10130293/pexels-photo-10130293.jpeg?auto=compress&cs=tinysrgb&w=600',
    'marble effect': 'https://images.pexels.com/photos/8146211/pexels-photo-8146211.jpeg?auto=compress&cs=tinysrgb&w=600',
    'stone effect': 'https://images.pexels.com/photos/8122356/pexels-photo-8122356.jpeg?auto=compress&cs=tinysrgb&w=600',
    'patterned': 'https://images.pexels.com/photos/7047482/pexels-photo-7047482.jpeg?auto=compress&cs=tinysrgb&w=600',
    'concrete effect': 'https://images.pexels.com/photos/7031615/pexels-photo-7031615.jpeg?auto=compress&cs=tinysrgb&w=600',
    'terrazzo': 'https://images.unsplash.com/photo-1731167709688-f038c02eda4c?w=600&q=80',
  };

  useEffect(() => {
    const fetchHomepageStyles = async () => {
      try {
        const response = await fetch(`${API_URL}/api/filters/homepage-styles`);
        if (response.ok) {
          const data = await response.json();
          if (data && data.length > 0) {
            setStyles(data.map(s => ({
              name: s.name,
              image: s.image || styleImageMap[s.name.toLowerCase()] || `https://images.pexels.com/photos/10130293/pexels-photo-10130293.jpeg?auto=compress&cs=tinysrgb&w=600`,
              link: s.link
            })));
          } else {
            setStyles(fallbackStyles);
          }
        } else {
          setStyles(fallbackStyles);
        }
      } catch (error) {
        console.error('Error fetching homepage styles:', error);
        setStyles(fallbackStyles);
      } finally {
        setLoading(false);
      }
    };
    fetchHomepageStyles();
  }, []);

  // Don't render if no styles and not loading
  if (!loading && styles.length === 0) return null;

  return (
    <section className="py-12 md:py-16">
      <div className="container mx-auto px-4">
        <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-8 text-center">Shop by style</h2>
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
            {styles.map((style, idx) => (
              <Link
                key={idx}
                to={style.link}
                className="group text-center"
                data-testid={`style-${style.name.toLowerCase().replace(/\s+/g, '-')}`}
              >
                <div className="aspect-square rounded-xl overflow-hidden mb-4 shadow-md group-hover:shadow-xl transition-shadow">
                  <img 
                    src={style.image} 
                    alt={style.name}
                    className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-500"
                  />
                </div>
                <h3 className="font-semibold text-gray-900 group-hover:text-[#F7EA1C] transition-colors">{style.name}</h3>
                <span className="text-sm text-gray-500 group-hover:text-gray-700">Shop now</span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
};

// Shopping With Us USP Section - Topps Tiles style
const ShoppingWithUs = () => {
  const [usps, setUsps] = useState([]);
  const [loading, setLoading] = useState(true);

  // Map icon names to Lucide components
  const iconMap = {
    'Palette': <Palette className="h-8 w-8" />,
    'Package': <Package className="h-8 w-8" />,
    'MapPin': <MapPin className="h-8 w-8" />,
    'Truck': <Truck className="h-8 w-8" />,
    'Star': <Star className="h-8 w-8" />,
    'Heart': <Heart className="h-8 w-8" />,
    'ShieldCheck': <Star className="h-8 w-8" />, // Fallback
    'Clock': <Star className="h-8 w-8" />, // Fallback
    'CreditCard': <Star className="h-8 w-8" />, // Fallback
    'Gift': <Star className="h-8 w-8" />, // Fallback
    'Sparkles': <Star className="h-8 w-8" />, // Fallback
    'Award': <Star className="h-8 w-8" />, // Fallback
    'Zap': <Star className="h-8 w-8" />, // Fallback
  };

  useEffect(() => {
    const fetchFeatures = async () => {
      try {
        const res = await fetch(`${API_URL}/api/website-admin/feature-cards/public`);
        if (res.ok) {
          const data = await res.json();
          setUsps(data.map(item => ({
            ...item,
            icon: iconMap[item.icon] || <Star className="h-8 w-8" />
          })));
        }
      } catch (e) {
        console.error('Failed to fetch features:', e);
        // Use defaults on error
        setUsps([
          { icon: iconMap['Palette'], title: 'Design Your Dream Room', description: 'Tap into your creativity with help from our online visualiser tool.', link: '/shop/visualiser' },
          { icon: iconMap['Package'], title: 'Free Samples', description: 'Order free samples delivered to your door free of charge.', link: '/shop/sample-service' },
          { icon: iconMap['MapPin'], title: 'Our Showrooms', description: 'Chat with our specialists at our Tonbridge, Gravesend & Sydenham stores.', link: '/shop/contact' },
          { icon: iconMap['Truck'], title: 'Free Delivery', description: 'Free delivery on qualifying orders, or collect from store.', link: '/shop/info/delivery' },
          { icon: iconMap['Star'], title: 'Loved By Customers', description: 'Rated 4.9 stars from thousands of happy customers.', link: '/shop/reviews' },
        ]);
      } finally {
        setLoading(false);
      }
    };
    fetchFeatures();
  }, []);

  if (loading || usps.length === 0) {
    // Show skeleton or nothing while loading
    return null;
  }

  return (
    <section className="py-12 md:py-16 bg-gray-50">
      <div className="container mx-auto px-4">
        <h2 className="text-2xl md:text-3xl font-bold text-gray-900 mb-8 text-center">Shopping with us</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-6">
          {usps.map((usp, idx) => (
            <Link
              key={idx}
              to={usp.link}
              className="bg-white rounded-xl p-6 text-center shadow-sm hover:shadow-lg transition-shadow group"
            >
              <div className="w-16 h-16 bg-[#F7EA1C]/20 rounded-full flex items-center justify-center mx-auto mb-4 text-[#333] group-hover:bg-[#F7EA1C] transition-colors">
                {usp.icon}
              </div>
              <h3 className="font-bold text-gray-900 mb-2 group-hover:text-[#F7EA1C] transition-colors">{usp.title}</h3>
              <p className="text-sm text-gray-600">{usp.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
};

// Footer Component
const ShopFooter = () => {
  const [footer, setFooter] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/api/website-admin/footer-settings`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.settings && Object.keys(d.settings).length) setFooter(d.settings); })
      .catch(() => {});
  }, []);

  const desc = footer?.description || 'Premium quality tiles for your home. Visit our showrooms in Tonbridge, Gravesend and Sydenham.';
  const phone = footer?.phone || '01732 424242';
  const email = footer?.email || 'info@tilestation.co.uk';
  const quickLinks = footer?.quickLinks || [
    { text: 'All Tiles', url: '/tiles' },
    { text: 'Wall Tiles', url: '/tiles?type=wall' },
    { text: 'Floor Tiles', url: '/tiles?type=floor' },
    { text: 'Contact Us', url: '/shop/contact' },
    { text: 'Trade Accounts', url: '/shop/trade/register' },
  ];
  const customerServiceLinks = footer?.customerServiceLinks || [
    { text: 'Delivery Information', url: '/shop/info/delivery' },
    { text: 'Returns & Refunds', url: '/shop/info/returns' },
    { text: 'FAQs', url: '/shop/info/faq' },
    { text: 'Contact Us', url: '/shop/contact' },
  ];
  const showrooms = footer?.showrooms || [
    { name: 'Tonbridge', hours: 'Open 7 days a week' },
    { name: 'Gravesend', hours: 'Open 7 days a week' },
    { name: 'Sydenham', hours: 'Open 7 days a week' },
  ];
  const copyrightText = footer?.copyrightText || 'Tile Station Ltd. All rights reserved.';
  const legalLinks = footer?.legalLinks || [
    { text: 'Privacy Policy', url: '/shop/info/privacy' },
    { text: 'Terms & Conditions', url: '/shop/info/terms' },
  ];

  return (
    <footer className="bg-[#1a1a1a] text-white">
      <div className="container mx-auto px-4 py-12">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8">
          {/* About */}
          <div>
            <img 
              src="/images/tilestation-logo.png" 
              alt="Tile Station" 
              className="h-12 w-auto mb-4"
            />
            <p className="text-gray-400 text-sm">{desc}</p>
            <div className="mt-4 space-y-2 text-sm text-gray-400">
              <p className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-[#F7EA1C]" />
                <span>{phone}</span>
              </p>
              <p className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-[#F7EA1C]" />
                <span>{email}</span>
              </p>
            </div>
          </div>

          {/* Quick Links */}
          <div>
            <h4 className="font-bold mb-4 text-[#F7EA1C]">Quick Links</h4>
            <ul className="space-y-2 text-sm text-gray-400">
              {quickLinks.map((link, i) => (
                <li key={i}><Link to={link.url} className="hover:text-white transition">{link.text}</Link></li>
              ))}
            </ul>
          </div>

          {/* Customer Service */}
          <div>
            <h4 className="font-bold mb-4 text-[#F7EA1C]">Customer Service</h4>
            <ul className="space-y-2 text-sm text-gray-400">
              {customerServiceLinks.map((link, i) => (
                <li key={i}><Link to={link.url} className="hover:text-white transition">{link.text}</Link></li>
              ))}
            </ul>
          </div>

          {/* Showrooms */}
          <div>
            <h4 className="font-bold mb-4 text-[#F7EA1C]">Our Showrooms</h4>
            <ul className="space-y-3 text-sm text-gray-400">
              {showrooms.map((showroom, i) => (
                <li key={i}>
                  <p className="font-medium text-white">{showroom.name}</p>
                  <p>{showroom.hours}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="border-t border-gray-800 mt-8 pt-8">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4 text-sm text-gray-500">
            <p>&copy; {new Date().getFullYear()} {copyrightText}</p>
            <div className="flex gap-6">
              {legalLinks.map((link, i) => (
                <Link key={i} to={link.url} className="hover:text-white transition">{link.text}</Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
};

// Dynamic Trade CTA Banner - fetches settings from admin
const ICON_MAP_TRADE = { Percent, Gift, Award, Truck, Headphones, TrendingUp, Building2, Shield: Award };
const getTradeIcon = (name) => ICON_MAP_TRADE[name] || Gift;

const TradeCtaBanner = () => {
  const [s, setS] = useState(null);

  useEffect(() => {
    fetch(`${API_URL}/api/website-admin/public/trade-account-settings`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.settings && Object.keys(d.settings).length) setS(d.settings); })
      .catch(() => {});
  }, []);

  // Merge with defaults
  const banner = s?.banner || {};
  const enabled = banner.enabled !== false;
  if (!enabled) return null;

  const badge = banner.badge_text || 'For Trade Professionals';
  const headline = banner.headline || 'Open a Trade Account &';
  const highlight = banner.headline_highlight || 'Save More';
  const desc = banner.description || 'Join thousands of builders, tilers, and contractors who enjoy exclusive trade pricing, credit back rewards on every purchase, and priority service.';
  const ctaPrimary = banner.cta_primary_text || 'Open Trade Account';
  const ctaLink = banner.cta_primary_link || '/shop/trade/register';
  const ctaSecondary = banner.cta_secondary_text || 'Already have an account? Sign In';
  const ctaSecLink = banner.cta_secondary_link || '/shop/login';

  const pricingEnabled = s?.tiers_enabled === true;
  const tp = s?.trade_pricing || {};
  const saleDiscount = tp.sale_discount ?? 20;
  const stdDiscount = tp.standard_discount ?? 40;
  const saleCreditBack = tp.sale_credit_back ?? 3;
  const stdCreditBack = tp.standard_credit_back ?? 5;
  const tagline = tp.tagline || 'On Every Single Purchase';

  const bannerBenefits = (s?.banner_benefits || []).filter(b => b.enabled !== false);
  const defaultBenefits = [
    { icon: 'Percent', text: `Up to ${stdDiscount}% off Standard` },
    { icon: 'Gift', text: `Up to ${stdCreditBack}% Credit Back` },
    { icon: 'Truck', text: 'Priority Delivery' },
    { icon: 'Headphones', text: 'Dedicated Support' },
  ];
  const benefits = bannerBenefits.length > 0 ? bannerBenefits : defaultBenefits;

  return (
    <section className="py-16 bg-[#333333] relative overflow-hidden" data-testid="trade-cta-banner">
      <div className="absolute inset-0 opacity-10">
        <div className="absolute inset-0" style={{
          backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'60\' height=\'60\' viewBox=\'0 0 60 60\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cg fill=\'none\' fill-rule=\'evenodd\'%3E%3Cg fill=\'%23F7EA1C\' fill-opacity=\'0.4\'%3E%3Cpath d=\'M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z\'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")',
        }} />
      </div>
      <div className="container mx-auto px-4 relative z-10">
        <div className="grid md:grid-cols-2 gap-8 items-center max-w-5xl mx-auto">
          <div className="text-white">
            <div className="inline-flex items-center gap-2 bg-[#F7EA1C] text-[#333] px-3 py-1 rounded-full text-sm font-semibold mb-4">
              <Award className="w-4 h-4" />
              {badge}
            </div>
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              {headline} <span className="text-[#F7EA1C]">{highlight}</span>
            </h2>
            <p className="text-gray-300 mb-6">{desc}</p>
            <div className="grid grid-cols-2 gap-4 mb-6">
              {benefits.map((b, idx) => {
                const Icon = getTradeIcon(b.icon);
                return (
                  <div key={idx} className="flex items-center gap-2">
                    <div className="w-8 h-8 bg-[#F7EA1C]/20 rounded-lg flex items-center justify-center">
                      <Icon className="w-4 h-4 text-[#F7EA1C]" />
                    </div>
                    <span className="text-sm">{b.text}</span>
                  </div>
                );
              })}
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <Link to={ctaLink} className="inline-flex items-center justify-center gap-2 bg-[#F7EA1C] text-[#333] font-bold px-6 py-3 rounded-lg hover:bg-[#e5d91a] transition-colors">
                <Building2 className="w-5 h-5" />
                {ctaPrimary}
              </Link>
              <Link to={ctaSecLink} className="inline-flex items-center justify-center gap-2 border-2 border-white/30 text-white font-semibold px-6 py-3 rounded-lg hover:bg-white/10 transition-colors">
                {ctaSecondary}
              </Link>
            </div>
          </div>
          <div className="hidden md:block">
            <div className="space-y-3">
              {/* Discount Savings */}
              <div className="bg-white/10 backdrop-blur rounded-2xl p-5 border border-white/10">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-8 bg-[#F7EA1C] rounded-lg flex items-center justify-center">
                    <Percent className="w-4 h-4 text-[#333]" />
                  </div>
                  <h3 className="text-white font-bold text-sm tracking-wide uppercase">Trade Discounts</h3>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-gradient-to-br from-red-500/20 to-red-600/10 rounded-xl p-4 border border-red-500/20 text-center">
                    <p className="text-red-300 text-xs font-medium uppercase tracking-wider mb-1">Sale Prices</p>
                    <p className="text-white text-3xl font-black leading-none"><span className="text-sm font-semibold">Up to </span>{saleDiscount}<span className="text-lg">%</span></p>
                    <p className="text-red-300 text-xs mt-1">extra off</p>
                  </div>
                  <div className="bg-gradient-to-br from-[#F7EA1C]/20 to-[#F7EA1C]/5 rounded-xl p-4 border border-[#F7EA1C]/20 text-center">
                    <p className="text-[#F7EA1C]/80 text-xs font-medium uppercase tracking-wider mb-1">Standard</p>
                    <p className="text-white text-3xl font-black leading-none"><span className="text-sm font-semibold">Up to </span>{stdDiscount}<span className="text-lg">%</span></p>
                    <p className="text-[#F7EA1C]/80 text-xs mt-1">off retail</p>
                  </div>
                </div>
              </div>

              {/* Credit Back */}
              <div className="bg-white/10 backdrop-blur rounded-2xl p-5 border border-white/10">
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-8 h-8 bg-green-500 rounded-lg flex items-center justify-center">
                    <Gift className="w-4 h-4 text-white" />
                  </div>
                  <h3 className="text-white font-bold text-sm tracking-wide uppercase">Credit Back Rewards</h3>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-gradient-to-br from-green-500/20 to-green-600/10 rounded-xl p-4 border border-green-500/20 text-center">
                    <p className="text-green-300 text-xs font-medium uppercase tracking-wider mb-1">From Sale</p>
                    <p className="text-white text-3xl font-black leading-none"><span className="text-sm font-semibold">Up to </span>{saleCreditBack}<span className="text-lg">%</span></p>
                    <p className="text-green-300 text-xs mt-1">credit back</p>
                  </div>
                  <div className="bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 rounded-xl p-4 border border-emerald-500/20 text-center">
                    <p className="text-emerald-300 text-xs font-medium uppercase tracking-wider mb-1">Standard</p>
                    <p className="text-white text-3xl font-black leading-none"><span className="text-sm font-semibold">Up to </span>{stdCreditBack}<span className="text-lg">%</span></p>
                    <p className="text-emerald-300 text-xs mt-1">credit back</p>
                  </div>
                </div>
              </div>

              {/* Tagline */}
              <div className="bg-[#F7EA1C] rounded-xl py-3 px-4 text-center">
                <p className="text-[#333] font-black text-sm tracking-wide uppercase">
                  {tagline}
                </p>
              </div>

              {/* Bathroom Exclusive */}
              <a href="/shop/bathroom" className="block bg-gradient-to-r from-cyan-500/20 to-blue-500/10 rounded-2xl p-4 border border-cyan-400/20 hover:border-cyan-400/40 transition-colors group">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 bg-gradient-to-br from-cyan-400 to-blue-500 rounded-xl flex items-center justify-center flex-shrink-0">
                    <span className="text-white font-black text-lg">50%</span>
                  </div>
                  <div>
                    <p className="text-white font-bold text-sm">Exclusive: Bathroom Catalogue</p>
                    <p className="text-cyan-300/80 text-xs">50% off all bathroom products — Trade exclusive</p>
                  </div>
                  <ArrowRight className="w-4 h-4 text-cyan-300 ml-auto group-hover:translate-x-1 transition-transform" />
                </div>
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

// Main Homepage Component
const TileStationHome = () => {
  const [featuredTiles, setFeaturedTiles] = useState([]);
  const [featuredMode, setFeaturedMode] = useState('products');
  const [loading, setLoading] = useState(true);
  const [brandMarqueeSettings, setBrandMarqueeSettings] = useState({ visible: true });
  const navigate = useNavigate();
  const { isTrade, getTradePrice } = useTradeUser();
  
  // Track page views for analytics
  usePageTracking();

  useEffect(() => {
    const fetchData = async () => {
      try {
        const featuredRes = await fetch(`${API_URL}/api/tiles/featured?limit=8`);
        const data = await featuredRes.json();
        if (data.mode) {
          setFeaturedMode(data.mode);
          setFeaturedTiles(data.items || []);
        } else {
          // Legacy format: plain array
          setFeaturedTiles(Array.isArray(data) ? data : []);
        }
        
        // Fetch homepage content for section visibility settings
        const contentRes = await fetch(`${API_URL}/api/website-admin/homepage`);
        const content = await contentRes.json();
        if (content) {
          setBrandMarqueeSettings({
            visible: content.brand_marquee_visible !== false,
            title: content.brand_marquee_title,
            brands: content.brand_marquee_brands,
          });
        }
      } catch (e) {
        console.error('Error loading homepage:', e);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  return (
    <div className="min-h-screen bg-white">
      <SeoHead
        title="Tile Station — Premium Kitchen, Bathroom & Floor Tiles · Free UK Delivery"
        description="Shop premium kitchen, bathroom and floor tiles online with free UK delivery on orders over £500. Visit our Kent and London showrooms — Gravesend, Tonbridge, Sydenham. Trade pricing, free samples, expert advice."
        canonical="/"
        keywords="tiles uk, kitchen tiles, bathroom tiles, porcelain tiles, floor tiles, tile shop kent, tile shop london"
      />
      <ShopHeader />
      
      {/* Hero Banner Carousel */}
      <HeroBannerCarousel />

      {/* CLEARANCE strip — auto-hides when no live clearance stock */}
      <ClearanceHomeSection />

      {/* Shop Categories */}
      <ShopCategories />

      {/* Recently Viewed — same real collection cards as /tiles; hidden for first-time visitors */}
      <React.Suspense fallback={null}>
        <RecentlyViewedSection maxItems={6} />
      </React.Suspense>

      {/* Featured Collections / Products */}
      <section className="py-12 md:py-16">
        <div className="container mx-auto px-4">
          <div className="flex justify-between items-center mb-8">
            <h2 className="text-2xl md:text-3xl font-bold text-gray-900">
              {featuredMode === 'collections' ? 'Featured Collections' : 'Featured Tiles'}
            </h2>
            <Link to="/tiles" className="text-[#333] hover:text-[#F7EA1C] font-medium flex items-center gap-1">
              View All <ChevronRight className="h-4 w-4" />
            </Link>
          </div>
          
          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="animate-pulse">
                  <div className="bg-gray-200 aspect-square rounded-xl mb-3"></div>
                  <div className="h-4 bg-gray-200 rounded w-3/4 mb-2"></div>
                  <div className="h-4 bg-gray-200 rounded w-1/2"></div>
                </div>
              ))}
            </div>
          ) : featuredMode === 'collections' ? (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
              {featuredTiles.map((collection) => (
                <Link
                  key={collection.series_name}
                  to={`/tiles/collection/${encodeURIComponent(collection.series_name)}`}
                  className="group"
                  data-testid={`featured-collection-${collection.series_name}`}
                >
                  <div className="aspect-square bg-gray-100 rounded-xl overflow-hidden mb-3 relative shadow-sm group-hover:shadow-lg transition-shadow">
                    {normaliseImageUrl(collection.hero_image) ? (
                      <img
                        src={normaliseImageUrl(collection.hero_image)}
                        alt={collection.custom_title || collection.series_name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-400 bg-gray-200">
                        No Image
                      </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                    <div className="absolute bottom-0 left-0 right-0 p-3 translate-y-2 group-hover:translate-y-0 transition-transform">
                      <span className="text-xs text-white/80 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                        {collection.product_count} product{collection.product_count !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>
                  <h3 className="font-semibold text-gray-900 group-hover:text-[#F7EA1C] transition-colors text-sm md:text-base">
                    {collection.custom_title || collection.series_name}
                  </h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {collection.product_count} product{collection.product_count !== 1 ? 's' : ''}
                  </p>
                </Link>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
              {featuredTiles.map((tile) => (
                <Link
                  key={tile.id}
                  to={`/tiles/${tile.slug}`}
                  className="group"
                  data-testid={`featured-tile-${tile.id}`}
                >
                  <div className="aspect-square bg-gray-100 rounded-xl overflow-hidden mb-3 relative shadow-sm group-hover:shadow-lg transition-shadow">
                    {normaliseImageUrl(tile.images?.[0]) ? (
                      <img
                        src={normaliseImageUrl(tile.images[0])}
                        alt={tile.display_name}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-gray-400">
                        No Image
                      </div>
                    )}
                    <button className="absolute top-3 right-3 p-2 bg-white rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity">
                      <Heart className="h-4 w-4 text-gray-600 hover:text-red-500" />
                    </button>
                  </div>
                  <h3 className="font-medium text-gray-900 group-hover:text-[#F7EA1C] transition-colors line-clamp-2 text-sm md:text-base">
                    {tile.display_name}
                  </h3>
                  <p className="text-[#333] font-bold mt-1">
                    £{(isTrade ? getTradePrice(tile.price) : tile.price)?.toFixed(2)}{tile.is_surface_product !== false ? '/m²' : '/each'}
                    {isTrade && <span className="text-[10px] text-gray-400 font-normal ml-1">ex. VAT</span>}
                  </p>
                  {tile.size && (
                    <p className="text-sm text-gray-500">{tile.size}</p>
                  )}
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Shop by Style */}
      <ShopByStyle />

      {/* Shopping With Us USP */}
      <ShoppingWithUs />

      {/* Brand Marquee */}
      <BrandMarquee
        visible={brandMarqueeSettings.visible}
        title={brandMarqueeSettings.title}
        brands={brandMarqueeSettings.brands}
      />

      {/* Product Carousel */}
      <ProductCarousel title="Bestselling Tiles" limit={8} />

      {/* Video Showroom */}
      <VideoShowroom />

      {/* Showroom Tours (Multi-Video Playlist) */}
      <ShowroomTours />

      {/* Google Reviews */}
      <GoogleReviews />

      {/* Quick Links */}
      {/* Trade Account CTA Banner */}
      <TradeCtaBanner />

      <section className="py-12 bg-gray-50">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            <Link 
              to="/shop/calculator"
              className="flex items-center gap-4 bg-white p-6 rounded-xl shadow-sm hover:shadow-lg transition-shadow group"
            >
              <div className="w-14 h-14 bg-[#F7EA1C]/20 rounded-xl flex items-center justify-center flex-shrink-0 group-hover:bg-[#F7EA1C] transition-colors">
                <Calculator className="w-7 h-7 text-[#333]" />
              </div>
              <div>
                <h3 className="font-bold text-gray-900 group-hover:text-[#F7EA1C] transition-colors">Tile Calculator</h3>
                <p className="text-sm text-gray-500">Calculate how many tiles you need</p>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-400 ml-auto" />
            </Link>
            <Link 
              to="/shop/trade/register"
              className="flex items-center gap-4 bg-white p-6 rounded-xl shadow-sm hover:shadow-lg transition-shadow group"
            >
              <div className="w-14 h-14 bg-[#F7EA1C]/20 rounded-xl flex items-center justify-center flex-shrink-0 group-hover:bg-[#F7EA1C] transition-colors">
                <Building2 className="w-7 h-7 text-[#333]" />
              </div>
              <div>
                <h3 className="font-bold text-gray-900 group-hover:text-[#F7EA1C] transition-colors">Trade Account</h3>
                <p className="text-sm text-gray-500">Exclusive discounts & credit back</p>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-400 ml-auto" />
            </Link>
            <Link 
              to="/shop/register"
              className="flex items-center gap-4 bg-white p-6 rounded-xl shadow-sm hover:shadow-lg transition-shadow group"
            >
              <div className="w-14 h-14 bg-[#F7EA1C]/20 rounded-xl flex items-center justify-center flex-shrink-0 group-hover:bg-[#F7EA1C] transition-colors">
                <User className="w-7 h-7 text-[#333]" />
              </div>
              <div>
                <h3 className="font-bold text-gray-900 group-hover:text-[#F7EA1C] transition-colors">Create Account</h3>
                <p className="text-sm text-gray-500">Track orders & save favourites</p>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-400 ml-auto" />
            </Link>
          </div>
        </div>
      </section>

      <ShopFooter />
      
      {/* Live Chat Widget */}
      <LiveChatWidget />
      <WelcomePopup />
    </div>
  );
};

export default TileStationHome;
export { ShopHeader, ShopFooter };
