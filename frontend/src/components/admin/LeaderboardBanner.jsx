/**
 * LeaderboardBanner — top-of-page strip that cycles through monthly
 * staff achievement headlines. Built 3 Jun 2026 in response to:
 *
 *   "Show the staff member prominently on dashboard who's converting
 *    more quotes and give them a hand of applause 👏  ... visible
 *    like a small banner maybe which is visible on all pages on the
 *    top somewhere."
 *
 * Cycles every 6s through (when data exists):
 *   1. 👑 Quote-conversion company leader + rate + emoji
 *   2. 💷 Special-order sales company leader + £
 *   3. 🥈 Runner-up gap ("Tom 3 behind 🥈")
 *   4. 🔥 Top streak ("Sarah on a 12-day conversion streak")
 *
 * Backend: GET /api/staff-leaderboard/banner (cached 30s).
 * Dismissible per-session via the × — re-appears on the next admin
 * tab open / page refresh, so it can't be permanently hidden by
 * accident.
 *
 * "Sales" in this banner means INVOICES with order_type = "Special
 * Order" only (tiles/bathroom/flooring/underfloor heating).
 * "Store Order" (material/tools) is excluded — per user 3 Jun 2026.
 */
import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Link, useNavigate } from 'react-router-dom';
import { Crown, Trophy, X, TrendingUp, Flame, ChevronRight } from 'lucide-react';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

const ROTATE_MS = 6000;
const POLL_MS = 60000;

export default function LeaderboardBanner() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [slide, setSlide] = useState(0);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem('leaderboardBannerDismissed') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let alive = true;
    const fetchOnce = async () => {
      try {
        const r = await axios.get(`${API}/staff-leaderboard/banner`);
        if (alive) setData(r.data || null);
      } catch (_e) {
        // Banner is a sugar feature — if the API blips, hide it silently.
        if (alive) setData(null);
      }
    };
    fetchOnce();
    const t = setInterval(fetchOnce, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // Build the rotating slides ONLY for views that have real data —
  // an empty company means we don't show "leading with 0 conversions".
  const slides = useMemo(() => {
    if (!data) return [];
    const out = [];
    // Manual super-admin "Highlight a hero" broadcast — appears as
    // the FIRST slide and disappears automatically when expires_at
    // passes. Pre-empts the auto cycle.
    if (data.highlight) {
      out.push({
        key: 'highlight',
        kind: 'highlight',
        icon: <Trophy className="w-4 h-4 text-amber-300" />,
        copy: (
          <>
            <span className="font-extrabold text-amber-200">{data.highlight.name}</span>
            {data.highlight.showroom_name && (
              <span className="text-amber-200/80"> · {data.highlight.showroom_name}</span>
            )}
            <span className="text-emerald-200"> — {data.highlight.message}</span>
            <span className="ml-2">🎉</span>
          </>
        ),
      });
    }
    const c = data.conv_leader;
    if (c && c.quotes_converted > 0) {
      out.push({
        key: 'conv',
        kind: 'conversion',
        icon: <Crown className="w-4 h-4 text-amber-300" />,
        copy: (
          <>
            <span className="font-extrabold text-amber-200">{c.name}</span>
            {c.showroom_name && c.showroom_name !== 'Unassigned' && (
              <span className="text-amber-200/80"> from {c.showroom_name}</span>
            )}
            <span className="text-emerald-200"> is leading {data.month} quote conversions —{' '}</span>
            <span className="font-bold text-white">{c.quotes_converted} won</span>
            {c.conversion_rate > 0 && (
              <span className="text-emerald-300"> · {c.conversion_rate}% rate 📈</span>
            )}
            <span className="ml-2">👏</span>
          </>
        ),
      });
    }
    const s = data.sales_leader;
    if (s && s.sales_value_gbp > 0) {
      out.push({
        key: 'sales',
        kind: 'sales',
        icon: <Trophy className="w-4 h-4 text-yellow-300" />,
        copy: (
          <>
            <span className="font-extrabold text-yellow-200">{s.name}</span>
            {s.showroom_name && s.showroom_name !== 'Unassigned' && (
              <span className="text-yellow-200/80"> from {s.showroom_name}</span>
            )}
            <span className="text-emerald-200"> tops {data.month} Special-Order sales —{' '}</span>
            <span className="font-bold text-white">
              £{s.sales_value_gbp.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </span>
            <span className="text-emerald-300/80"> · {s.sales_count} invoices</span>
            <span className="ml-2">💷</span>
          </>
        ),
      });
    }
    if (data.conv_runner_up && data.conv_gap > 0 && data.conv_gap <= 5) {
      out.push({
        key: 'gap',
        kind: 'gap',
        icon: <TrendingUp className="w-4 h-4 text-rose-300" />,
        copy: (
          <>
            <span className="font-extrabold text-rose-200">{data.conv_runner_up.name}</span>
            <span className="text-rose-100"> is just </span>
            <span className="font-bold text-white">{data.conv_gap}</span>
            <span className="text-rose-100"> behind for the {data.month} crown</span>
            <span className="ml-2">🥈</span>
          </>
        ),
      });
    }
    if (data.top_streak && data.top_streak.streak_days >= 3) {
      out.push({
        key: 'streak',
        kind: 'streak',
        icon: <Flame className="w-4 h-4 text-orange-300" />,
        copy: (
          <>
            <span className="font-extrabold text-orange-200">{data.top_streak.name}</span>
            <span className="text-orange-100"> on a </span>
            <span className="font-bold text-white">{data.top_streak.streak_days}-day</span>
            <span className="text-orange-100"> conversion streak</span>
            <span className="ml-2">🔥</span>
          </>
        ),
      });
    }
    return out;
  }, [data]);

  useEffect(() => {
    if (slides.length <= 1) return undefined;
    const t = setInterval(() => {
      setSlide((s) => (s + 1) % slides.length);
    }, ROTATE_MS);
    return () => clearInterval(t);
  }, [slides.length]);

  if (dismissed || slides.length === 0) return null;

  const current = slides[slide % slides.length];
  // 3 Jun 2026 — Whole banner is clickable → routes to the
  // /admin/staff-competition dashboard. Users were finding the
  // banner but missing the detailed view (sidebar entries were
  // buried). Now the banner itself is the discoverable shortcut.
  return (
    <div
      data-testid="leaderboard-banner"
      data-slide-kind={current.kind}
      className="bg-gradient-to-r from-emerald-950 via-emerald-900 to-amber-950 border-b border-emerald-700/40 text-emerald-50 text-xs md:text-sm shadow-md cursor-pointer hover:from-emerald-900 hover:via-emerald-800 hover:to-amber-900 transition-colors"
      role="link"
      tabIndex={0}
      onClick={(e) => {
        // Ignore clicks that originated from the dismiss button so
        // it can still close the banner without nav-ing away.
        if (e.target.closest('[data-banner-skip-click]')) return;
        navigate('/admin/staff-competition');
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          navigate('/admin/staff-competition');
        }
      }}
      title="Click to open the Staff Competition dashboard"
    >
      <div className="flex items-center justify-center gap-2 px-3 md:px-6 py-1.5">
        <div className="flex-shrink-0 animate-pulse">{current.icon}</div>
        <div
          key={current.key}
          className="truncate text-center leading-snug animate-fadeIn"
          style={{ animation: 'fadeIn 400ms ease-out both' }}
        >
          {current.copy}
        </div>
        {slides.length > 1 && (
          <div className="hidden md:flex items-center gap-1 ml-2 flex-shrink-0">
            {slides.map((s, i) => (
              <span
                key={s.key}
                className={`w-1.5 h-1.5 rounded-full ${i === slide ? 'bg-amber-300' : 'bg-amber-200/30'}`}
              />
            ))}
          </div>
        )}
        {/* "Open dashboard" affordance — a chevron hints the banner
            is clickable so users actually try clicking it. */}
        <Link
          to="/admin/staff-competition"
          data-banner-skip-click
          data-testid="leaderboard-banner-open"
          className="hidden md:inline-flex items-center gap-1 ml-2 px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-300/40 text-[10px] uppercase tracking-wider font-bold text-amber-100 hover:bg-amber-500/30 transition-colors"
          onClick={(e) => e.stopPropagation()}
        >
          See full board <ChevronRight className="w-3 h-3" />
        </Link>
        <button
          type="button"
          aria-label="Dismiss leaderboard banner"
          data-banner-skip-click
          data-testid="leaderboard-banner-dismiss"
          onClick={(e) => {
            e.stopPropagation();
            try { sessionStorage.setItem('leaderboardBannerDismissed', '1'); } catch { /* ignore */ }
            setDismissed(true);
          }}
          className="ml-1 p-0.5 rounded hover:bg-white/10 text-emerald-200/70 hover:text-emerald-100 flex-shrink-0"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
