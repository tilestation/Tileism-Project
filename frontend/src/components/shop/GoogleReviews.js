import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Star } from 'lucide-react';
import { safeArr } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const GoogleIcon = () => (
  <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none">
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
);

export const GoogleReviews = () => {
  const [config, setConfig] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef(null);
  const animRef = useRef(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await fetch(`${API_URL}/api/website-admin/homepage`);
        const data = await res.json();
        if (data?.google_reviews_visible && data.google_reviews?.length > 0) {
          setConfig({
            rating: data.google_reviews_rating || '4.9',
            reviews: data.google_reviews,
          });
        }
      } catch (e) {
        console.error('Failed to load reviews', e);
      } finally {
        setLoaded(true);
      }
    };
    fetchConfig();
  }, []);

  const animate = useCallback(() => {
    const el = scrollRef.current;
    if (!el || paused) {
      animRef.current = requestAnimationFrame(animate);
      return;
    }
    el.scrollLeft += 0.5;
    // Reset when halfway (we duplicate the reviews for seamless loop)
    if (el.scrollLeft >= el.scrollWidth / 2) {
      el.scrollLeft = 0;
    }
    animRef.current = requestAnimationFrame(animate);
  }, [paused]);

  useEffect(() => {
    if (!config) return;
    animRef.current = requestAnimationFrame(animate);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [config, animate]);

  if (!loaded || !config) return null;

  // Duplicate reviews for seamless infinite scroll
  const displayReviews = [...config.reviews, ...config.reviews];

  return (
    <section className="py-16 md:py-20 bg-white relative" data-testid="google-reviews">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-8 sm:mb-12">
          <div className="inline-flex items-center gap-2 mb-4">
            <GoogleIcon />
            <span className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Google Reviews</span>
          </div>
          <div className="flex items-center justify-center gap-3 mb-3">
            <span className="text-4xl sm:text-5xl font-black text-gray-900">{config.rating}</span>
            <div className="flex flex-col items-start">
              <div className="flex gap-0.5">
                {[1,2,3,4,5].map(s => (
                  <Star key={s} className={`w-6 h-6 ${s <= Math.round(parseFloat(config.rating)) ? 'fill-yellow-400 text-yellow-400' : 'text-gray-200'}`} />
                ))}
              </div>
              <span className="text-sm text-gray-500 mt-0.5">on Google</span>
            </div>
          </div>
        </div>
      </div>

      {/* Auto-scrolling carousel - full width */}
      <div
        ref={scrollRef}
        className="flex gap-4 sm:gap-6 overflow-hidden px-4 sm:px-6"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        style={{ scrollBehavior: 'auto' }}
        data-testid="reviews-carousel"
      >
        {displayReviews.map((review, i) => (
          <div
            key={`${review.id || i}-${i}`}
            className="flex-shrink-0 w-[280px] sm:w-[360px] bg-gray-50 rounded-2xl p-5 sm:p-6 border border-gray-100 hover:shadow-lg transition-shadow"
            data-testid={`review-card-${i % safeArr(config.reviews).length}`}
          >
            {/* Stars */}
            <div className="flex gap-0.5 mb-4">
              {[1,2,3,4,5].map(s => (
                <Star key={s} className="w-4 h-4 fill-yellow-400 text-yellow-400" />
              ))}
            </div>

            {/* Review text */}
            <p className="text-gray-700 text-[15px] leading-relaxed mb-5 line-clamp-4">
              "{review.text}"
            </p>

            {/* Reviewer */}
            <div className="flex items-center gap-3 pt-4 border-t border-gray-200">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center text-white font-bold text-sm shadow-sm">
                {(review.name || '?')[0].toUpperCase()}
              </div>
              <div>
                <p className="font-semibold text-gray-900 text-sm">{review.name}</p>
                {review.date && <p className="text-xs text-gray-400">{review.date}</p>}
              </div>
              <div className="ml-auto">
                <GoogleIcon />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};

export default GoogleReviews;
