import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, X, Sparkles, Percent, Truck, Shield, Building2, MessageSquare, Mail, Star, ArrowRight, Lock, CheckCircle } from 'lucide-react';
import { ShopHeader, ShopFooter } from './TileStationHome';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const ICON_MAP = {
  sparkles: Sparkles, percent: Percent, truck: Truck, shield: Shield,
  building: Building2, message: MessageSquare, mail: Mail, star: Star,
};

export default function BathroomPage() {
  const [content, setContent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  const navigate = useNavigate();

  // Check if user is logged in (shop customer or trade — both store on the
  // SAME canonical keys: tile_shop_token + tile_shop_customer; written by
  // TradeLoginPage / CustomerRegisterPage / etc. The previous version of
  // this code read `shopToken`/`shopUser` which are NEVER written anywhere
  // in the codebase, so signed-in users were always treated as logged out.
  const readUser = () => {
    const token = localStorage.getItem('tile_shop_token');
    const userStr = localStorage.getItem('tile_shop_customer');
    if (token && userStr) {
      try { return { ...JSON.parse(userStr), token }; } catch { return null; }
    }
    return null;
  };
  const [user, setUser] = useState(readUser);

  // Reactively pick up sign-in/sign-out events from other tabs (`storage`)
  // and same-tab auth changes (`trade-auth-change` — fired by login pages).
  useEffect(() => {
    const refresh = () => setUser(readUser());
    window.addEventListener('storage', refresh);
    window.addEventListener('trade-auth-change', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('trade-auth-change', refresh);
    };
  }, []);

  const isTrade = !!(user?.is_trade || user?.account_type === 'trade');
  const discount = isTrade ? (content?.trade_discount || '50') : (content?.public_discount || '35');

  useEffect(() => {
    const fetchContent = async () => {
      try {
        const res = await fetch(`${API_URL}/api/bathroom/page`);
        const data = await res.json();
        setContent(data);
      } catch (e) {
        console.error('Failed to load bathroom page', e);
      } finally {
        setLoading(false);
      }
    };
    fetchContent();
  }, []);

  const handleDownload = async () => {
    if (!user) {
      setShowSignIn(true);
      return;
    }

    setDownloading(true);
    try {
      const userType = isTrade ? 'trade' : 'public';
      const res = await fetch(
        `${API_URL}/api/bathroom/catalogue/download?user_id=${encodeURIComponent(user.email || user.id || '')}&user_type=${userType}`
      );
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = content?.catalogue_filename || 'bathroom-catalogue.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download error:', err);
    } finally {
      setDownloading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-3 border-amber-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!content) return null;

  const features = content.features || [];
  const channels = content.how_to_order_channels || [];

  return (
    <div className="min-h-screen bg-white" data-testid="bathroom-page">
      <ShopHeader />

      {/* Hero Section */}
      <section className="relative bg-slate-900 overflow-hidden" data-testid="bathroom-hero">
        {/* Background pattern */}
        <div className="absolute inset-0 opacity-[0.04]">
          <div className="absolute inset-0" style={{
            backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
            backgroundSize: '32px 32px',
          }} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 min-h-[auto] lg:min-h-[600px]">
          {/* Mobile Image (shown above text on small screens) */}
          <div className="relative block lg:hidden h-56 sm:h-72">
            {content.video_url ? (
              <video
                src={content.video_url}
                className="absolute inset-0 w-full h-full object-cover"
                autoPlay muted loop playsInline
              />
            ) : content.video_thumbnail_url || content.hero_image_url ? (
              <img
                src={content.video_thumbnail_url || content.hero_image_url}
                alt="Bath Station"
                className="absolute inset-0 w-full h-full object-cover"
                fetchpriority="high" decoding="sync" loading="eager"
              />
            ) : null}
          </div>

          {/* Left - Content */}
          <div className="relative z-10 flex items-center">
            <div className="px-5 sm:px-10 lg:px-16 xl:px-20 py-10 md:py-24 max-w-2xl mx-auto">
              <div className="inline-flex items-center gap-2 bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm font-semibold px-4 py-1.5 rounded-full mb-6">
                <Sparkles className="w-4 h-4" />
                Exclusive
              </div>

              <h1 className="text-3xl sm:text-4xl lg:text-6xl font-black text-white tracking-tight mb-4" style={{ fontFamily: "'Inter', sans-serif" }}>
                {content.hero_title || 'Bath Station'}
              </h1>

              <p className="text-lg md:text-2xl text-slate-300 font-medium mb-3">
                {content.hero_subtitle || 'Luxury Bathrooms at Unbeatable Prices'}
              </p>

              <p className="text-slate-400 text-base mb-6 leading-relaxed max-w-lg">
                {content.hero_description}
              </p>

              {/* Dual Discount Cards — stack on mobile */}
              <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 mb-8">
                <div className="flex items-center gap-3 bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-3 sm:p-4 flex-1">
                  <div className="w-12 h-12 sm:w-14 sm:h-14 bg-gradient-to-br from-green-400 to-emerald-500 rounded-xl flex items-center justify-center flex-shrink-0">
                    <span className="text-lg sm:text-xl font-black text-white">{content.public_discount || '35'}%</span>
                  </div>
                  <div>
                    <p className="text-white font-bold text-sm sm:text-base">Public Discount</p>
                    <p className="text-slate-400 text-xs sm:text-sm">All customers</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 bg-amber-500/10 backdrop-blur border border-amber-500/20 rounded-2xl p-3 sm:p-4 flex-1">
                  <div className="w-12 h-12 sm:w-14 sm:h-14 bg-gradient-to-br from-amber-400 to-orange-500 rounded-xl flex items-center justify-center flex-shrink-0">
                    <span className="text-lg sm:text-xl font-black text-white">{content.trade_discount || '50'}%</span>
                  </div>
                  <div>
                    <p className="text-amber-300 font-bold text-sm sm:text-base">Trade Exclusive</p>
                    <p className="text-slate-400 text-xs sm:text-sm">Trade accounts only</p>
                  </div>
                </div>
              </div>

              {/* Download CTA only */}
              <button
                onClick={handleDownload}
                disabled={downloading}
                className="inline-flex items-center gap-3 bg-[#F7EA1C] hover:bg-yellow-400 text-[#333] font-bold px-8 py-4 rounded-full shadow-lg hover:shadow-xl transition-all transform hover:scale-105 disabled:opacity-50"
                data-testid="download-catalogue-btn"
              >
                {downloading ? (
                  <div className="w-5 h-5 border-2 border-gray-600 border-t-transparent rounded-full animate-spin" />
                ) : user ? (
                  <Download className="w-5 h-5" />
                ) : (
                  <Lock className="w-5 h-5" />
                )}
                {user ? 'Download Catalogue' : 'Sign In to Download'}
              </button>
            </div>
          </div>

          {/* Right - Video / Image (flush, no shadow, no rounding) */}
          <div className="relative hidden lg:block">
            {content.video_url ? (
              <video
                src={content.video_url}
                className="absolute inset-0 w-full h-full object-cover"
                autoPlay
                muted
                loop
                playsInline
                data-testid="bathroom-hero-video"
              />
            ) : content.video_thumbnail_url || content.hero_image_url ? (
              <img
                src={content.video_thumbnail_url || content.hero_image_url}
                alt="Bath Station"
                className="absolute inset-0 w-full h-full object-cover"
                fetchpriority="high"
                decoding="sync"
                loading="eager"
              />
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center">
                <Sparkles className="w-16 h-16 text-slate-600" />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Features Grid */}
      {features.length > 0 && (
        <section className="py-16 bg-slate-50" data-testid="bathroom-features">
          <div className="container mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              {features.map((f, i) => {
                const IconComp = ICON_MAP[f.icon] || Sparkles;
                return (
                  <div key={i} className="bg-white rounded-xl p-6 text-center border border-slate-100 hover:shadow-md transition-shadow" data-testid={`feature-${i}`}>
                    <div className="w-12 h-12 bg-amber-50 rounded-xl flex items-center justify-center mx-auto mb-4">
                      <IconComp className="w-6 h-6 text-amber-600" />
                    </div>
                    <h3 className="font-bold text-slate-900 mb-1">{f.title}</h3>
                    <p className="text-sm text-slate-500">{f.description}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* How to Order Section */}
      <section className="py-16 md:py-20 bg-white" data-testid="how-to-order">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-black text-slate-900 tracking-tight mb-3" style={{ fontFamily: "'Inter', sans-serif" }}>
              {content.how_to_order_title || 'How to Order Bathrooms'}
            </h2>
            <p className="text-slate-500 text-lg max-w-2xl mx-auto">
              {content.how_to_order_intro || 'Our bathroom ordering facility is currently unavailable online. You can place your order through any of the following channels:'}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-4xl mx-auto">
            {channels.map((ch, i) => {
              const IconComp = ICON_MAP[ch.icon] || Building2;
              return (
                <div key={i} className="relative bg-slate-50 rounded-2xl p-8 text-center border border-slate-100 hover:border-amber-200 hover:shadow-lg transition-all group" data-testid={`order-channel-${i}`}>
                  <div className="w-16 h-16 bg-gradient-to-br from-amber-400 to-orange-500 rounded-2xl flex items-center justify-center mx-auto mb-5 group-hover:scale-110 transition-transform">
                    <IconComp className="w-7 h-7 text-white" />
                  </div>
                  <h3 className="font-bold text-lg text-slate-900 mb-2">{ch.title}</h3>
                  <p className="text-slate-500 text-sm leading-relaxed">{ch.description}</p>
                </div>
              );
            })}
          </div>

          {/* Trade Credit Back Notice */}
          {content.trade_credit_back_text && (
            <div className="mt-10 max-w-2xl mx-auto">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 flex items-start gap-4" data-testid="trade-credit-notice">
                <div className="w-10 h-10 bg-amber-500 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Star className="w-5 h-5 text-white" />
                </div>
                <div>
                  <p className="font-semibold text-amber-900 mb-1">Trade Benefit</p>
                  <p className="text-amber-800 text-sm">{content.trade_credit_back_text}</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Content Sections */}
      {content.content_sections?.length > 0 && content.content_sections.map((section, i) => (
        <section key={i} className={`py-16 ${i % 2 === 0 ? 'bg-slate-50' : 'bg-white'}`}>
          <div className="container mx-auto px-4 sm:px-6 lg:px-8">
            <div className={`grid grid-cols-1 md:grid-cols-2 gap-12 items-center ${i % 2 !== 0 ? 'md:[direction:rtl] md:[&>*]:[direction:ltr]' : ''}`}>
              {section.image_url && (
                <div className="rounded-2xl overflow-hidden">
                  <img src={section.image_url} alt={section.title} className="w-full h-auto object-cover" />
                </div>
              )}
              <div>
                <h2 className="text-2xl md:text-3xl font-bold text-slate-900 mb-4">{section.title}</h2>
                <p className="text-slate-500 leading-relaxed">{section.text}</p>
              </div>
            </div>
          </div>
        </section>
      ))}

      {/* Review Quote */}
      {content.review_quote && (
        <section className="py-16 bg-slate-900" data-testid="bathroom-review">
          <div className="container mx-auto px-4 sm:px-6 lg:px-8 text-center max-w-3xl">
            <div className="flex justify-center gap-1 mb-6">
              {[1,2,3,4,5].map(s => (
                <Star key={s} className="w-6 h-6 fill-yellow-400 text-yellow-400" />
              ))}
            </div>
            <blockquote className="text-xl md:text-2xl text-white font-medium italic leading-relaxed mb-6">
              "{content.review_quote}"
            </blockquote>
            {content.review_author && (
              <p className="text-slate-400 font-semibold">— {content.review_author}</p>
            )}
          </div>
        </section>
      )}

      {/* CTA Section */}
      <section className="py-16 md:py-20 bg-gradient-to-r from-amber-500 to-orange-500" data-testid="bathroom-cta">
        <div className="container mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl md:text-4xl font-black text-white tracking-tight mb-4" style={{ fontFamily: "'Inter', sans-serif" }}>
            {content.cta_title || 'Transform Your Bathroom Today'}
          </h2>
          <p className="text-white/80 text-lg max-w-xl mx-auto mb-8">
            {content.cta_description}
          </p>
          <button
            onClick={handleDownload}
            disabled={downloading}
            className="inline-flex items-center gap-3 bg-white hover:bg-slate-100 text-slate-900 font-bold px-10 py-4 rounded-full shadow-xl hover:shadow-2xl transition-all transform hover:scale-105"
            data-testid="bathroom-cta-download"
          >
            {user ? <Download className="w-5 h-5" /> : <Lock className="w-5 h-5" />}
            {user ? 'Download Catalogue' : 'Sign In to Download'}
          </button>
        </div>
      </section>

      {/* Sign In Modal */}
      {showSignIn && (
        <div className="fixed inset-0 z-50 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center p-4" data-testid="signin-modal">
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8 relative">
            <button onClick={() => setShowSignIn(false)} className="absolute top-4 right-4 text-slate-400 hover:text-slate-600">
              <X className="w-5 h-5" />
            </button>
            <div className="text-center">
              <div className="w-14 h-14 bg-amber-50 rounded-xl flex items-center justify-center mx-auto mb-4">
                <Lock className="w-7 h-7 text-amber-600" />
              </div>
              <h3 className="text-xl font-bold text-slate-900 mb-2">Sign In to Download</h3>
              <p className="text-slate-500 mb-6">
                Create a free account or sign in to download our bathroom catalogue with exclusive pricing.
              </p>
              <div className="space-y-3">
                <button
                  onClick={() => { setShowSignIn(false); navigate('/shop/login'); }}
                  className="w-full bg-slate-900 hover:bg-slate-800 text-white font-semibold py-3 px-6 rounded-xl transition-colors"
                  data-testid="signin-modal-login"
                >
                  Sign In
                </button>
                <button
                  onClick={() => { setShowSignIn(false); navigate('/shop/register'); }}
                  className="w-full bg-slate-100 hover:bg-slate-200 text-slate-900 font-semibold py-3 px-6 rounded-xl transition-colors"
                  data-testid="signin-modal-register"
                >
                  Create Free Account
                </button>
              </div>

              <div className="mt-5 pt-5 border-t border-slate-100">
                <button
                  onClick={() => { setShowSignIn(false); navigate('/shop/trade/register'); }}
                  className="w-full bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white font-bold py-3.5 px-6 rounded-xl transition-all flex items-center justify-center gap-2"
                  data-testid="signin-modal-trade"
                >
                  <Sparkles className="w-4 h-4" />
                  Apply for Trade — Get {content?.trade_discount || '50'}% Off
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ShopFooter />
    </div>
  );
}
