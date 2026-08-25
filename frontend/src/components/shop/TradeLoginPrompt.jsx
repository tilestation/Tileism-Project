/**
 * TradeLoginPrompt - PROTECTED CRITICAL COMPONENT
 * 
 * DO NOT REMOVE OR CONDITIONALLY HIDE THIS COMPONENT
 * based on tier pricing, product settings, or any admin config.
 * 
 * This component MUST be visible to all non-logged-in visitors
 * on every product page (Collection and Individual).
 * 
 * Visibility rules:
 *   - SHOW when user is NOT logged in (no shop_token/tile_shop_token)
 *   - HIDE when user IS logged in as a trade customer
 *   - NEVER hide based on tier_pricing_disabled or any product flag
 */
import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Users, Percent, Zap, Truck, ArrowRight } from 'lucide-react';
import { Button } from '../ui/button';

/**
 * Full Trade Login box used on Collection Detail pages.
 * Premium dark panel with a pulsing red glow, shine sweep and trade benefits —
 * designed to make tradesmen WANT to open an account.
 */
export const TradeLoginBox = ({ isLoggedIn }) => {
  if (isLoggedIn) return null;

  return (
    <div
      data-testid="trade-customer-box"
      className="relative overflow-hidden rounded-xl bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 p-4 border border-red-500/60"
      style={{ animation: 'tradeGlow 2.2s ease-in-out infinite' }}
    >
      {/* shine sweep */}
      <div
        className="pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/10 to-transparent"
        style={{ animation: 'tradeShine 3.2s ease-in-out infinite' }}
      />

      <div className="flex items-center justify-between gap-2 mb-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-10 h-10 rounded-full bg-red-500/15 ring-1 ring-red-400/50 flex items-center justify-center flex-shrink-0">
            <Users className="w-5 h-5 text-red-400" />
          </div>
          <div className="min-w-0">
            <p className="font-bold text-white leading-tight">In the trade?</p>
            <p className="text-[13px] text-amber-300 font-semibold" style={{ animation: 'tradeBlinkText 1.6s ease-in-out infinite' }}>
              You&rsquo;re paying too much on this price!
            </p>
          </div>
        </div>
        <span className="flex items-center gap-1.5 bg-red-600 text-white text-[10px] font-extrabold tracking-widest px-2 py-1 rounded-full flex-shrink-0">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-white" />
          </span>
          TRADE
        </span>
      </div>

      {/* Trade benefits */}
      <ul className="space-y-1.5 mb-3">
        <li className="flex items-center gap-2 text-[13px] text-gray-100">
          <Percent className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
          <span><b className="text-amber-300">Trade-only prices</b> on every tile, every order</span>
        </li>
        <li className="flex items-center gap-2 text-[13px] text-gray-100">
          <Zap className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
          <span>Exclusive deals &amp; first pick of new stock</span>
        </li>
        <li className="flex items-center gap-2 text-[13px] text-gray-100">
          <Truck className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
          <span>Fast reorders, VAT invoices &amp; priority support</span>
        </li>
      </ul>

      <div className="flex gap-2">
        <Link
          to="/shop/trade/register"
          className="flex-1 px-3 py-2.5 rounded-lg text-sm font-bold text-center text-slate-900 bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-400 transition shadow-lg shadow-amber-500/25 flex items-center justify-center gap-1.5"
          data-testid="trade-signup-link"
        >
          Open FREE Trade Account <ArrowRight className="w-4 h-4" />
        </Link>
        <Link
          to="/shop/trade/login"
          className="px-4 py-2.5 rounded-lg text-sm font-semibold text-center text-white border border-white/25 hover:bg-white/10 transition"
          data-testid="trade-login-link"
        >
          Trade Login
        </Link>
      </div>
      <p className="text-[10px] text-gray-400 text-center mt-2">Takes 2 minutes &bull; No fees &bull; Instant online discounts</p>
    </div>
  );
};

/**
 * Compact Trade Login prompt used on Individual Product (Tile Detail) pages.
 * Matching dark attention-grabbing styling in a slim banner.
 */
export const TradeLoginBanner = ({ isTrade }) => {
  const navigate = useNavigate();

  if (isTrade) return null;

  return (
    <div
      data-testid="trade-login-banner"
      className="relative overflow-hidden rounded-lg mt-3 p-3 bg-gradient-to-r from-slate-900 to-slate-800 border border-red-500/60"
      style={{ animation: 'tradeGlow 2.2s ease-in-out infinite' }}
    >
      <div
        className="pointer-events-none absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/10 to-transparent"
        style={{ animation: 'tradeShine 3.2s ease-in-out infinite' }}
      />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
          </span>
          <div className="min-w-0">
            <p className="text-white text-sm font-bold leading-tight">In the trade? Unlock trade-only prices</p>
            <p className="text-amber-300 text-xs font-medium" style={{ animation: 'tradeBlinkText 1.6s ease-in-out infinite' }}>
              Trade-only prices &bull; exclusive deals &bull; priority support
            </p>
          </div>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <Button
            size="sm"
            className="bg-gradient-to-r from-amber-400 to-amber-500 hover:from-amber-300 hover:to-amber-400 text-slate-900 font-bold shadow-lg shadow-amber-500/25"
            onClick={() => navigate('/shop/trade/register')}
            data-testid="trade-banner-signup"
          >
            Open FREE Account
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white"
            onClick={() => navigate('/shop/trade/login?redirect=' + encodeURIComponent(window.location.pathname))}
            data-testid="trade-banner-login"
          >
            Login
          </Button>
        </div>
      </div>
    </div>
  );
};
