import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ShoppingBag, User, Search, Menu, X, Heart, MapPin, Building2, Scissors, Phone, Mail } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useShopAuth } from '../../contexts/ShopAuthContext';
import { useCart } from '../../contexts/TileCartContext';
import { useTradeUser } from '../../hooks/useTradeUser';
import AnnouncementRibbon from './AnnouncementRibbon';
import { OrganizationSchema, LocalBusinessSchema } from '../seo/StructuredData';
import { normaliseImageUrl } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

export const ShopLayout = () => {
  const { customer, logout, isAuthenticated } = useShopAuth();
  const { isTrade, tradeCompanyName } = useTradeUser();
  const cart = useCart?.() || {};
  const cartCount = cart?.items?.length || 0;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [showSearch, setShowSearch] = useState(false);
  const [navItems, setNavItems] = useState([]);
  const [isNavSticky, setIsNavSticky] = useState(false);
  const [footerData, setFooterData] = useState(null);
  const navRef = useRef(null);
  const navOffsetRef = useRef(0);
  const location = useLocation();
  const navigate = useNavigate();

  // Fetch nav items and footer. The public footer lives at
  // `/api/website-admin/footer-settings` (returns `{settings: {...}}` —
  // populated by the admin Homepage Manager). The legacy
  // `/homepage/footer` URL doesn't exist; hitting it used to silently
  // fail and fall through to the hardcoded defaults, which is why admins
  // saw their saved phone/email not reflecting on the live site.
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [navRes, footerRes] = await Promise.all([
          fetch(`${API_URL}/api/website-admin/homepage/navigation`).then(r => r.json()).catch(() => []),
          fetch(`${API_URL}/api/website-admin/footer-settings`).then(r => r.json()).catch(() => null),
        ]);
        setNavItems(Array.isArray(navRes) ? navRes.filter(i => i.enabled !== false) : []);
        // Admin page stores under `settings`; normalise so the render
        // code can simply read `footerData.phone` etc. Also remap the
        // admin's `{text, url}` link shape to the `{label, url}` shape
        // the UI expects.
        const settings = (footerRes && footerRes.settings) || {};
        setFooterData({
          description: settings.description,
          phone: settings.phone,
          email: settings.email,
          hours: settings.hours,
          quickLinks: (settings.quickLinks || []).map(l => ({
            label: l.text || l.label,
            url: l.url,
          })),
          customerService: (settings.customerServiceLinks || []).map(l => ({
            label: l.text || l.label,
            url: l.url,
          })),
        });
      } catch (e) {
        console.error('Failed to fetch layout data:', e);
      }
    };
    fetchData();
  }, []);

  // Sticky nav
  useEffect(() => {
    if (navRef.current) {
      navOffsetRef.current = navRef.current.offsetTop;
    }
    const handleScroll = () => {
      setIsNavSticky(window.scrollY > navOffsetRef.current);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Close mobile menu on navigate
  useEffect(() => {
    setMobileMenuOpen(false);
    setShowSearch(false);
  }, [location.pathname]);

  // Search
  const searchTimeout = useRef(null);
  const handleSearch = useCallback((value) => {
    setSearchQuery(value);
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (!value.trim()) { setSearchResults([]); setShowSearch(false); return; }
    searchTimeout.current = setTimeout(async () => {
      try {
        const res = await fetch(`${API_URL}/api/tiles/search?q=${encodeURIComponent(value)}&limit=5`);
        const data = await res.json();
        setSearchResults(data.results || data || []);
        setShowSearch(true);
      } catch { setSearchResults([]); }
    }, 300);
  }, []);

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      // Unified storefront search — tiles, tools, accessories + everything
      // else. `/tiles?search=…` only covered tile collections and left
      // non-tile products invisible to customers.
      navigate(`/shop/search?q=${encodeURIComponent(searchQuery)}`);
      setShowSearch(false);
    }
  };

  const customerName = customer?.name?.split(' ')[0] || 'Account';

  return (
    <div className="min-h-screen bg-gray-50">
      <OrganizationSchema />
      <LocalBusinessSchema />
      <AnnouncementRibbon />
      {/* Top Utility Bar */}
      <div className="bg-[#333333] text-white text-center py-2 text-xs sm:text-sm">
        <div className="container mx-auto px-4 flex items-center justify-center gap-2 sm:gap-6 flex-wrap">
          <span className="font-medium">Free UK Delivery on Orders Over £500</span>
          <span className="hidden sm:inline text-white/40">|</span>
          <span className="hidden sm:inline">Click & Collect Available</span>
          {footerData?.phone && (
            <>
              <span className="hidden md:inline text-white/40">|</span>
              <a
                href={`tel:${String(footerData.phone).replace(/\s+/g, '')}`}
                className="hidden md:flex items-center gap-1 hover:text-[#F7EA1C] transition"
              >
                <Phone className="h-3 w-3" /> {footerData.phone}
              </a>
            </>
          )}
        </div>
      </div>

      {/* Main Header - Dark gray background */}
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
                className="h-16 sm:h-20 md:h-24 w-auto transition-transform duration-300 ease-in-out group-hover:scale-105"
                onError={(e) => {
                  e.target.style.display = 'none';
                  e.target.nextSibling.style.display = 'flex';
                }}
              />
              <div className="hidden items-center gap-2">
                <span className="text-lg font-bold text-white">Tile Station</span>
              </div>
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
                      {result.image && (
                        <img src={normaliseImageUrl(result.image)} alt="" className="w-16 h-16 object-cover rounded-lg" />
                      )}
                      <div className="flex-1">
                        <p className="font-medium">{result.name}</p>
                        {result.price && (
                          <p className="text-[#F7EA1C] font-semibold">£{result.price?.toFixed(2)}</p>
                        )}
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
              {!isTrade && (isAuthenticated ? (
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
              <Link to="/shop/tile-samples" className="flex flex-col items-center text-white/80 hover:text-[#F7EA1C] relative transition" data-testid="samples-link">
                <Scissors className="h-6 w-6" />
                <span className="text-xs mt-1 hidden sm:block">Samples</span>
              </Link>
              <Link to="/shop/tile-wishlist" className="flex flex-col items-center text-white/80 hover:text-[#F7EA1C] relative transition" data-testid="wishlist-link">
                <Heart className="h-6 w-6" />
                <span className="text-xs mt-1 hidden sm:block">Wishlist</span>
              </Link>
              <Link to="/shop/tile-cart" className="flex flex-col items-center text-white/80 hover:text-[#F7EA1C] relative transition" data-testid="cart-link">
                <ShoppingBag className="h-6 w-6" />
                <span className="text-xs mt-1 hidden sm:block">Basket</span>
                {cartCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-[#F7EA1C] text-[#333] text-xs w-5 h-5 rounded-full flex items-center justify-center font-bold" data-testid="cart-count">
                    {cartCount}
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

      {/* Navigation Bar - Yellow background */}
      <nav
        ref={navRef}
        className={`bg-[#F7EA1C] text-gray-900 z-50 shadow-md transition-all duration-200 ${
          isNavSticky ? 'fixed top-0 left-0 right-0 animate-in slide-in-from-top-2' : 'relative'
        }`}
      >
        <div className="container mx-auto px-4">
          <ul className="hidden lg:flex items-center justify-center gap-0 text-sm font-semibold uppercase">
            {navItems.length > 0 ? (
              navItems.map((item) => (
                <li key={item.id || item.label}>
                  <Link
                    to={item.link_url || '/tiles'}
                    className="block px-5 py-3 hover:bg-[#e5d918] transition-colors whitespace-nowrap"
                    style={item.highlight && item.highlight_color ? { color: item.highlight_color, fontWeight: 'bold' } : {}}
                  >
                    {item.label}
                  </Link>
                </li>
              ))
            ) : (
              <>
                <li><Link to="/shop" className="block px-5 py-3 hover:bg-[#e5d918] transition-colors">Home</Link></li>
                <li><Link to="/tiles" className="block px-5 py-3 hover:bg-[#e5d918] transition-colors">All Tiles</Link></li>
                <li><Link to="/tiles?clearance=true" className="block px-5 py-3 hover:bg-[#e5d918] transition-colors text-red-600 font-bold">Clearance Sale</Link></li>
                <li><Link to="/shop/contact" className="block px-5 py-3 hover:bg-[#e5d918] transition-colors">Contact Us</Link></li>
              </>
            )}
          </ul>
        </div>
      </nav>
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
              ) : isAuthenticated ? (
                <Link to="/shop/tile-account" onClick={() => setMobileMenuOpen(false)}
                  className="flex items-center gap-3 px-6 py-3.5 text-gray-800 hover:bg-gray-50 font-medium">
                  <User className="h-5 w-5" />
                  <span>{customerName}</span>
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
            <div className="flex border-b border-gray-200" data-testid="mobile-brand-switcher">
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
              {(navItems.length > 0 ? navItems : [
                { label: 'Home', link_url: '/shop' },
                { label: 'All Tiles', link_url: '/tiles' },
                { label: 'Clearance Sale', link_url: '/tiles?clearance=true', highlight: true, highlight_color: '#dc2626' },
                { label: 'Contact Us', link_url: '/shop/contact' },
              ]).map((item) => (
                <Link
                  key={item.id || item.label}
                  to={item.link_url || '/tiles'}
                  className="block px-6 py-3.5 text-gray-800 hover:bg-gray-50 border-b border-gray-100 font-medium"
                  onClick={() => setMobileMenuOpen(false)}
                  style={item.highlight && item.highlight_color ? { color: item.highlight_color, fontWeight: 'bold' } : {}}
                >
                  {item.label}
                </Link>
              ))}
              <div className="border-t border-gray-200 mt-2 pt-2">
                <Link to="/shop/track" className="block px-6 py-3 text-gray-600 hover:bg-gray-50" onClick={() => setMobileMenuOpen(false)}>
                  Track Order
                </Link>
                {!isTrade && !isAuthenticated && (
                  <Link to="/shop/register" className="block px-6 py-3 text-gray-600 hover:bg-gray-50" onClick={() => setMobileMenuOpen(false)}>
                    Create Account
                  </Link>
                )}
                {(isAuthenticated && !isTrade) && (
                  <button className="block w-full text-left px-6 py-3 text-red-600 hover:bg-gray-50" onClick={() => { logout(); setMobileMenuOpen(false); }}>
                    Logout
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="min-h-[60vh]">
        <Outlet />
      </main>

      {/* Footer */}
      <footer className="bg-[#333333] text-white mt-16">
        <div className="container mx-auto px-4 py-12">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            <div>
              <img src="/images/tilestation-logo.png" alt="Tile Station" className="h-16 mb-4" onError={(e) => { e.target.style.display = 'none'; }} />
              <p className="text-gray-400 text-sm">
                {footerData?.description || 'Your one-stop shop for luxury tiles and bathroom products. Quality products at competitive prices.'}
              </p>
            </div>

            <div>
              <h3 className="font-bold text-lg mb-4">Quick Links</h3>
              <ul className="space-y-2 text-sm text-gray-400">
                {(footerData?.quickLinks || [
                  { label: 'All Products', url: '/tiles' },
                  { label: 'Clearance Sale', url: '/tiles?clearance=true' },
                  { label: 'Contact Us', url: '/shop/contact' },
                ]).map((link, i) => (
                  <li key={i}><Link to={link.url} className="hover:text-[#F7EA1C] transition">{link.label}</Link></li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="font-bold text-lg mb-4">Customer Service</h3>
              <ul className="space-y-2 text-sm text-gray-400">
                {(footerData?.customerService || [
                  { label: 'Delivery Information', url: '/shop/info/delivery' },
                  { label: 'Returns & Refunds', url: '/shop/info/returns' },
                  { label: 'FAQs', url: '/shop/info/faq' },
                  { label: 'Track Your Order', url: '/shop/track' },
                  { label: 'Privacy Policy', url: '/shop/info/privacy' },
                  { label: 'Terms & Conditions', url: '/shop/info/terms' },
                ]).map((link, i) => (
                  <li key={i}><Link to={link.url} className="hover:text-[#F7EA1C] transition">{link.label}</Link></li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="font-bold text-lg mb-4">Contact Us</h3>
              <ul className="space-y-3 text-sm text-gray-400">
                {footerData?.email && (
                  <li className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-[#F7EA1C]" />
                    <a
                      href={`mailto:${footerData.email}`}
                      className="hover:text-[#F7EA1C] transition"
                    >
                      {footerData.email}
                    </a>
                  </li>
                )}
                {footerData?.phone && (
                  <li className="flex items-center gap-2">
                    <Phone className="h-4 w-4 text-[#F7EA1C]" />
                    <a
                      href={`tel:${String(footerData.phone).replace(/\s+/g, '')}`}
                      className="hover:text-[#F7EA1C] transition"
                    >
                      {footerData.phone}
                    </a>
                  </li>
                )}
                {footerData?.hours && (
                  <li className="text-gray-500">{footerData.hours}</li>
                )}
              </ul>
            </div>
          </div>

          <div className="border-t border-gray-700 mt-8 pt-8 text-center text-sm text-gray-500">
            <p>&copy; {new Date().getFullYear()} Tile Station. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default ShopLayout;
