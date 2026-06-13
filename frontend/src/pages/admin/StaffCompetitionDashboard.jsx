/**
 * StaffCompetitionDashboard — 7-section, full-company competition
 * view. Built 3 Jun 2026.
 *
 * Sections (per user-confirmed spec):
 *   1. Live competition status — champion hero + race-to-target +
 *      time-left countdown + projected end-of-month winner.
 *   2. Head-to-head top-3 matchup grid.
 *   3. Showroom vs showroom totals (charts + winner badges).
 *   4. Streaks, personal-best chasers, comeback kings.
 *   5. Full ranked tables (conversions + sales).
 *   6. Hall of Fame archive (past-month champions).
 *   7. Manual "Highlight a hero" broadcast tool (super-admin).
 *
 * Backend endpoints used:
 *   GET  /api/staff-leaderboard/competition  (everything except history)
 *   GET  /api/staff-leaderboard/hall-of-fame (past-month archive)
 *   POST /api/staff-leaderboard/highlight    (super-admin broadcast)
 *   DELETE /api/staff-leaderboard/highlight  (super-admin clear)
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Crown, Trophy, Flame, TrendingUp, Award, Megaphone,
  Clock, Target, Calendar, ArrowUpRight, ArrowDownRight,
  Send, X, Sparkles, BarChart3, Eye, CheckCircle2, Download, FileText,
} from 'lucide-react';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { useAuth } from '../../contexts/AuthContext';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
const tokenHdr = () => {
  const t = localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
};

const MEDALS = ['👑', '🥈', '🥉'];

function SectionHeader({ icon: Icon, title, accent = 'amber', children }) {
  const dot = {
    amber: 'bg-amber-400',
    emerald: 'bg-emerald-400',
    fuchsia: 'bg-fuchsia-400',
    rose: 'bg-rose-400',
    cyan: 'bg-cyan-400',
  }[accent];
  return (
    <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-6 rounded-full ${dot}`} />
        <Icon className="w-4 h-4" />
        <h2 className="text-base md:text-lg font-extrabold tracking-tight">{title}</h2>
      </div>
      {children}
    </div>
  );
}

export default function StaffCompetitionDashboard() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'super_admin';
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [highlightForm, setHighlightForm] = useState({ user_key: '', name: '', showroom_name: '', message: '', duration_hours: 24 });
  const [broadcasting, setBroadcasting] = useState(false);
  // Audit drawer (6 Jun 2026) — click a leaderboard row to see the
  // staff member's this-month quotes + invoices, so the sales £
  // and conversion-count can be verified at a glance.
  const [drawerStaff, setDrawerStaff] = useState(null);
  const [drawerData, setDrawerData] = useState(null);
  // 13 Jun 2026 — Quick-access staff photo manager dialog. The full
  // user-edit page (/admin/users) still works, but admins were
  // missing the entry point — so the leaderboard now has a one-click
  // "Manage Photos" button right in the Sales card header.
  const [photoMgrOpen, setPhotoMgrOpen] = useState(false);
  const [drawerLoading, setDrawerLoading] = useState(false);

  const openDrawer = async (staff) => {
    if (!staff) return;
    setDrawerStaff(staff);
    setDrawerData(null);
    setDrawerLoading(true);
    try {
      const key = staff.user_key || (staff.name ? `sp:${staff.name.toLowerCase()}` : '');
      if (!key) {
        toast.error('Cannot resolve staff member.');
        setDrawerStaff(null);
        return;
      }
      const res = await axios.get(
        `${API}/staff-leaderboard/staff/${encodeURIComponent(key)}/recent?limit=200`,
        { headers: tokenHdr() },
      );
      setDrawerData(res.data);
    } catch (e) {
      toast.error(`Couldn't load recent activity: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setDrawerLoading(false);
    }
  };

  const closeDrawer = () => { setDrawerStaff(null); setDrawerData(null); };

  const refresh = async () => {
    setLoading(true);
    try {
      const [comp, hof] = await Promise.all([
        axios.get(`${API}/staff-leaderboard/competition`, { headers: tokenHdr() }),
        axios.get(`${API}/staff-leaderboard/hall-of-fame?limit=24`, { headers: tokenHdr() }),
      ]);
      setData(comp.data);
      setHistory(hof.data?.history || []);
    } catch (e) {
      toast.error(`Couldn't load competition: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); const t = setInterval(refresh, 60000); return () => clearInterval(t); }, []);

  const broadcastHighlight = async () => {
    if (!highlightForm.name.trim() || !highlightForm.message.trim()) {
      toast.error('Pick a staff member and write a message.');
      return;
    }
    setBroadcasting(true);
    try {
      await axios.post(
        `${API}/staff-leaderboard/highlight`,
        {
          user_key: highlightForm.user_key || undefined,
          name: highlightForm.name,
          showroom_name: highlightForm.showroom_name || undefined,
          message: highlightForm.message,
          duration_hours: Number(highlightForm.duration_hours) || 24,
        },
        { headers: tokenHdr() },
      );
      toast.success(`Broadcast live — every admin page now shows: "${highlightForm.message}"`, { duration: 5000 });
      setHighlightForm({ user_key: '', name: '', showroom_name: '', message: '', duration_hours: 24 });
      await refresh();
    } catch (e) {
      toast.error(`Couldn't broadcast: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setBroadcasting(false);
    }
  };

  const clearHighlight = async () => {
    try {
      await axios.delete(`${API}/staff-leaderboard/highlight`, { headers: tokenHdr() });
      toast.success('Highlight cleared from banner.');
      await refresh();
    } catch (e) {
      toast.error(`Couldn't clear: ${e?.response?.data?.detail || e.message}`);
    }
  };

  // Pre-computed groups for the sections.
  // 6 Jun 2026 — `progress` is only populated when a team target is
  // set; we want the full staff list whether or not a target exists,
  // so source from `staff` (added to the API response on the same
  // date). Falls back to `progress` for older API versions in the
  // wild during the deploy window.
  const fullStaff = useMemo(() => {
    if (!data) return [];
    const list = (data.staff && data.staff.length) ? data.staff : (data.progress || []);
    return list;
  }, [data]);

  const conversionSorted = useMemo(() => {
    const sorted = [...fullStaff].sort((a, b) => (b.quotes_converted || 0) - (a.quotes_converted || 0));
    // 13 Jun 2026 — "Catch the person above you" motivator. For each
    // ranked staff, attach how many quote-wins they need to overtake
    // the row above. #1 gets `lead_over_below` instead so the top
    // dog has defensive motivation ("don't let X catch you").
    return sorted.map((s, idx) => {
      if ((s.quotes_converted || 0) === 0) return s; // unranked
      if (idx === 0) {
        const below = sorted[1];
        if (below && (below.quotes_converted || 0) > 0) {
          return {
            ...s,
            quotes_lead_over_below: (s.quotes_converted || 0) - (below.quotes_converted || 0),
            quotes_lead_over_below_name: below.name,
          };
        }
        return s;
      }
      const above = sorted[idx - 1];
      return {
        ...s,
        quotes_gap_to_above: Math.max(0, (above.quotes_converted || 0) - (s.quotes_converted || 0)) + 1,
        quotes_gap_to_above_name: above.name,
      };
    });
  }, [fullStaff]);

  const salesSorted = useMemo(() => {
    // 6 Jun 2026 — user feedback: "higher volume of sales do matter
    // but number of sales are as important — staff put effort to
    // close small sales too". Sort by composite score (70% £
    // normalized + 30% # normalized) so a staff with consistently
    // big sales is rewarded a bit more than pure quantity, but
    // closers still rank well. Falls back to raw £ if the backend
    // hasn't sent composite (older deploys).
    const sorted = [...fullStaff].sort((a, b) => {
      const aScore = a.sales_composite_score ?? null;
      const bScore = b.sales_composite_score ?? null;
      if (aScore !== null && bScore !== null) return bScore - aScore;
      return (b.sales_value_gbp || 0) - (a.sales_value_gbp || 0);
    });
    // 13 Jun 2026 — "Catch the person above you" — show each staff
    // the exact £ gap to overtake the row above them. #1 sees their
    // lead over #2 (defensive framing). Tiny psychological lever
    // shown to be the strongest motivator in sales gamification.
    return sorted.map((s, idx) => {
      if ((s.sales_value_gbp || 0) === 0) return s; // unranked
      if (idx === 0) {
        const below = sorted[1];
        if (below && (below.sales_value_gbp || 0) > 0) {
          return {
            ...s,
            sales_lead_over_below_gbp: (s.sales_value_gbp || 0) - (below.sales_value_gbp || 0),
            sales_lead_over_below_name: below.name,
          };
        }
        return s;
      }
      const above = sorted[idx - 1];
      return {
        ...s,
        sales_gap_to_above_gbp: Math.max(0, (above.sales_value_gbp || 0) - (s.sales_value_gbp || 0)) + 1,
        sales_gap_to_above_name: above.name,
      };
    });
  }, [fullStaff]);

  if (loading) {
    return <div className="p-6 text-center text-muted-foreground" data-testid="competition-loading">Loading competition dashboard…</div>;
  }
  if (!data) {
    return <div className="p-6 text-center text-rose-500">Couldn&apos;t load — try refresh.</div>;
  }

  const {
    month, days_elapsed, days_total, days_left,
    champion, target, progress, progress_sales = [], progress_conversions = [],
    head_to_head, showrooms,
    showroom_winners, active_streaks, personal_best_chasers,
    comebacks, active_highlight, total_staff, weekly_climber,
  } = data;

  // 13 Jun 2026 — Time-aware motivational copy. The text changes by
  // where we are in the month, so the dashboard feels alive instead
  // of static. Tone shifts from "fresh start" → "halfway" → "final
  // push" → "last day".
  const motivationalLine = (() => {
    if (!days_total) return null;
    const pct = (days_elapsed / days_total) * 100;
    if (days_elapsed <= 2) return { emoji: '🌅', text: `Fresh ${month.split(' ')[0]} — first sale of the month sets the tone. Who's it going to be?` };
    if (days_left === 0) return { emoji: '🏁', text: `Final day of ${month.split(' ')[0]} — every quote closed in the next few hours counts double.` };
    if (days_left === 1) return { emoji: '⏳', text: `24 hours left — one more sale could change the ranking. Push it.` };
    if (days_left <= 3) return { emoji: '🔥', text: `Final ${days_left} days — anything is still possible. Don't ease up now.` };
    if (days_left <= 7) return { emoji: '⚡', text: `Last week of the month — sprint finish. Every quote, every call.` };
    if (pct >= 45 && pct <= 55) return { emoji: '⛰️', text: `Halfway through ${month.split(' ')[0]} — what's your second-half push?` };
    if (pct >= 70) return { emoji: '🎯', text: `Final stretch — ${days_left} days to lock in your numbers.` };
    return { emoji: '💪', text: `${days_left} days left in the month — there's plenty of room to climb.` };
  })();

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5" data-testid="competition-dashboard">
      {/* SECTION 5 (PROMOTED TO TOP) — Top 3 podium + Sales
          leaderboard (13 Jun 2026 — user request: "swap, put Sales
          Leaderboard on top of the page"). Sales is the headline
          metric so it goes BEFORE the hero card. */}
      <TopThreePodium staff={salesSorted} onPick={openDrawer} />

      <Card className="p-5 border-2 border-emerald-500/40 bg-gradient-to-br from-emerald-50/30 via-card to-card dark:from-emerald-950/20 dark:via-card dark:to-card shadow-md shadow-emerald-500/5" data-testid="competition-sales-standalone">
        <SectionHeader icon={Trophy} title={`Sales leaderboard · ${month}`} accent="emerald">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-muted-foreground">(Special-Order only)</span>
            {isSuperAdmin && (
              <button
                type="button"
                onClick={() => setPhotoMgrOpen(true)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/30 text-indigo-700 dark:text-indigo-300 text-[10px] font-bold hover:bg-indigo-500/20 transition-colors"
                data-testid="manage-staff-photos-btn"
                title="Upload profile photos that show on the podium and rows"
              >
                📷 Manage photos
              </button>
            )}
          </div>
        </SectionHeader>
        <p className="text-[11px] text-muted-foreground italic mb-2">
          Ranked by <span className="font-bold">composite score</span> — 70% volume (as <span className="font-bold">% of your store target</span>, so smaller stores compete fairly) + 30% number of sales (consistent closers earn credit too).
        </p>
        <table className="w-full text-sm" data-testid="competition-sales-table">
          <thead className="text-xs text-muted-foreground uppercase tracking-wider"><tr><th className="text-left py-1.5">#</th><th className="text-left">Staff</th><th className="text-right">£ Sold</th><th className="text-right">Sales</th><th className="text-right">Score</th></tr></thead>
          <tbody>
            {salesSorted.length === 0 ? (
              <tr><td colSpan={5} className="py-4 text-center text-muted-foreground italic text-xs">No Special-Order sales yet this month.</td></tr>
            ) : salesSorted.map((s, idx) => {
              const pctTarget = s.personal_pct_of_target ?? 0;
              const hasTarget = (s.personal_sales_target || 0) > 0;
              const pillTone =
                pctTarget >= 100 ? 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800'
                : pctTarget >= 75  ? 'bg-fuchsia-100 text-fuchsia-800 border-fuchsia-200 dark:bg-fuchsia-900/30 dark:text-fuchsia-300 dark:border-fuchsia-800'
                : pctTarget >= 50  ? 'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800'
                :                    'bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-900/30 dark:text-rose-300 dark:border-rose-800';
              const expectedPct = days_total > 0 ? (days_elapsed / days_total) * 100 : 0;
              const paceRatio = (hasTarget && expectedPct > 0) ? (pctTarget / expectedPct) : null;
              let paceIcon = null;
              if (paceRatio !== null) {
                const tone =
                  paceRatio >= 1.0 ? 'text-emerald-600 dark:text-emerald-400'
                  : paceRatio >= 0.8 ? 'text-amber-600 dark:text-amber-400'
                  :                    'text-rose-600 dark:text-rose-400';
                const arrow =
                  paceRatio >= 1.0 ? '↑'
                  : paceRatio >= 0.8 ? ''
                  :                    '↓';
                const status =
                  paceRatio >= 1.0 ? 'Ahead of pace'
                  : paceRatio >= 0.8 ? 'On pace'
                  :                    'Behind pace';
                paceIcon = (
                  <span
                    className={`inline-flex items-center gap-0.5 text-xs leading-none ${tone}`}
                    data-testid={`competition-sales-pace-${s.name}`}
                    title={`${status} — expected ~${expectedPct.toFixed(1)}% by day ${days_elapsed} of ${days_total}, currently at ${pctTarget}% (${Math.round(paceRatio * 100)}% of expected)`}
                  >
                    ⏱{arrow}
                  </span>
                );
              }
              return (
              <tr
                key={`fs-${s.user_key}-${idx}`}
                className="border-t border-border/40 cursor-pointer hover:bg-emerald-50/40 dark:hover:bg-emerald-900/10 transition-colors"
                onClick={() => openDrawer(s)}
                data-testid={`competition-sales-row-${s.name}`}
                title={hasTarget
                  ? `Click to see ${s.name}'s recent invoices · ${pctTarget}% of £${Number(s.personal_sales_target).toLocaleString('en-GB')} ${s.showroom_name} target · Composite ${s.sales_composite_score ?? '—'}`
                  : `Click to see ${s.name}'s recent invoices · Composite ${s.sales_composite_score ?? '—'}`}
              >
                <td className="py-1.5 font-mono font-bold w-12">
                  <span className="inline-flex items-center gap-1">
                    <span>{idx < 3 ? MEDALS[idx] : idx + 1}</span>
                    <RankDelta change={s.sales_rank_change} testId={`competition-sales-rank-delta-${s.name}`} />
                  </span>
                </td>
                <td>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <StaffAvatar name={s.name} photoUrl={s.photo_url} size={26} testId={`sales-row-avatar-${s.name}`} />
                    <span className="font-bold">{s.name}</span>
                    <span className="text-xs text-muted-foreground">· {s.showroom_name}</span>
                    {hasTarget ? (
                      <span
                        className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full border text-[10px] font-bold leading-none tabular-nums ${pillTone}`}
                        data-testid={`competition-sales-pct-${s.name}`}
                        title={`${pctTarget}% of £${Number(s.personal_sales_target).toLocaleString('en-GB')} (${s.showroom_name} target)`}
                      >
                        🎯 {pctTarget}%{pctTarget >= 100 && ' ✓'}
                      </span>
                    ) : (
                      <span
                        className="inline-flex items-center px-1.5 py-0.5 rounded-full border border-dashed border-muted-foreground/30 text-[10px] text-muted-foreground italic leading-none"
                        title={`${s.showroom_name} has no monthly target set yet`}
                      >
                        no target
                      </span>
                    )}
                    {paceIcon}
                    <GapToOvertake s={s} mode="sales" testIdBase={`sales-gap-${s.name}`} />
                  </div>
                </td>
                <td className="text-right font-bold text-yellow-700 dark:text-yellow-300 tabular-nums">£{Number(s.sales_value_gbp).toLocaleString('en-GB', { maximumFractionDigits: 0 })}</td>
                <td className="text-right tabular-nums">{s.sales_count}</td>
                <td className="text-right tabular-nums text-emerald-700 dark:text-emerald-300 font-bold">{(s.sales_composite_score ?? 0).toFixed(1)}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {/* SECTION 1 — Live competition status */}
      <Card className="p-5 bg-gradient-to-br from-amber-100 to-amber-50 dark:from-amber-950/80 dark:via-emerald-950/70 dark:to-slate-900 border-amber-300 dark:border-amber-500/30">
        <SectionHeader icon={Sparkles} title={`Staff Competition · ${month}`} accent="amber">
          <div className="flex items-center gap-2 text-xs text-amber-900 dark:text-amber-200/80">
            <Calendar className="w-3.5 h-3.5" />
            Day {days_elapsed} of {days_total} · <span className="font-bold text-amber-700 dark:text-amber-200" data-testid="competition-days-left">{days_left} days left</span>
          </div>
        </SectionHeader>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Champion hero — dark tinted card so light/dark text both
              read clearly. */}
          <div className="lg:col-span-1 p-4 rounded-2xl bg-gradient-to-br from-amber-600 to-orange-700 dark:from-amber-500/20 dark:to-amber-500/15 border-2 border-amber-500 dark:border-amber-400/40 text-white dark:text-amber-100">
            {champion ? (
              <div data-testid="competition-champion">
                <div className="text-5xl">👑</div>
                <div className="text-xs text-amber-100 dark:text-amber-300 font-bold uppercase tracking-[0.2em] mt-2">Current champion</div>
                <div className="text-2xl font-extrabold mt-1" data-testid="competition-champion-name">{champion.name}</div>
                <div className="text-xs opacity-90">{champion.showroom_name}</div>
                <div className="mt-3 flex flex-wrap gap-3 text-xs">
                  <div><span className="font-bold">{champion.quotes_converted}</span> won</div>
                  {champion.conversion_rate > 0 && <div className="text-emerald-100 dark:text-emerald-300">{champion.conversion_rate}% rate</div>}
                  {champion.streak_days >= 2 && (
                    <div className="text-orange-100 dark:text-orange-300 inline-flex items-center gap-1"><Flame className="w-3 h-3" />{champion.streak_days}d</div>
                  )}
                </div>
                <div className="mt-3 text-xs font-semibold">👏 Hand of applause</div>
              </div>
            ) : (
              <div className="text-sm" data-testid="competition-no-champion">
                No conversions yet — the first to convert a quote this month takes the crown.
              </div>
            )}
          </div>

          {/* Two-section race-to-target — SALES vs QUOTES, kept
              visually distinct so staff at different stores never
              see a confusing aggregate target. (6 Jun 2026 — user
              feedback: "All targets need to set against their stores",
              "Targets are looking all mixed up Quotes and Sales".) */}
          <div className="lg:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-3">

            {/* SALES race — per-store £ target, one row per staff */}
            <div className="p-4 rounded-2xl bg-card border border-border" data-testid="race-sales-card">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-bold text-yellow-700 dark:text-yellow-300">
                  <Target className="w-3.5 h-3.5" />
                  Race to sales target
                </div>
                <div className="text-[10px] text-muted-foreground italic">per store · £</div>
              </div>
              {progress_sales.length > 0 ? (
                <div className="space-y-2" data-testid="race-sales">
                  {progress_sales.slice(0, 10).map((s, idx) => (
                    <div key={`rs-${s.user_key}-${idx}`}>
                      <div className="flex items-center justify-between text-xs mb-0.5">
                        <span className="font-semibold flex items-center gap-1.5 min-w-0">
                          <span className="text-muted-foreground w-5 font-mono shrink-0">{idx < 3 ? MEDALS[idx] : `#${idx + 1}`}</span>
                          <span className="truncate">{s.name}</span>
                          <span className="text-muted-foreground font-normal truncate">· {s.showroom_name}</span>
                        </span>
                        <span className={`tabular-nums shrink-0 ${s.pct >= 100 ? 'text-emerald-700 dark:text-emerald-300 font-bold' : 'text-muted-foreground'}`}>
                          £{Number(s.current).toLocaleString('en-GB', { maximumFractionDigits: 0 })} · {s.pct}% {s.pct >= 100 && '✓'}
                        </span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all ${s.pct >= 100 ? 'bg-emerald-500' : s.on_track ? 'bg-yellow-500' : 'bg-amber-500'}`}
                          style={{ width: `${Math.min(100, s.pct)}%` }}
                        />
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        of £{Number(s.target).toLocaleString('en-GB', { maximumFractionDigits: 0 })} ({s.showroom_name} target)
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground py-3 text-center" data-testid="race-sales-empty">
                  Set monthly sales targets per store on the dashboard to see live progress here.
                </div>
              )}
            </div>

            {/* QUOTES race — team conversions count target (optional) */}
            <div className="p-4 rounded-2xl bg-card border border-border" data-testid="race-quotes-card">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-bold text-amber-700 dark:text-amber-300">
                  <Trophy className="w-3.5 h-3.5" />
                  Race to quote-wins target
                </div>
                <div className="text-[10px] text-muted-foreground italic">team · count</div>
              </div>
              {progress_conversions.length > 0 ? (
                <div className="space-y-2" data-testid="race-quotes">
                  {progress_conversions.slice(0, 10).map((s, idx) => (
                    <div key={`rq-${s.user_key}-${idx}`}>
                      <div className="flex items-center justify-between text-xs mb-0.5">
                        <span className="font-semibold flex items-center gap-1.5 min-w-0">
                          <span className="text-muted-foreground w-5 font-mono shrink-0">{idx < 3 ? MEDALS[idx] : `#${idx + 1}`}</span>
                          <span className="truncate">{s.name}</span>
                          <span className="text-muted-foreground font-normal truncate">· {s.showroom_name}</span>
                        </span>
                        <span className={`tabular-nums shrink-0 ${s.pct >= 100 ? 'text-emerald-700 dark:text-emerald-300 font-bold' : 'text-muted-foreground'}`}>
                          {s.current} · {s.pct}% {s.pct >= 100 && '✓'}
                        </span>
                      </div>
                      <div className="h-2 bg-muted rounded-full overflow-hidden">
                        <div
                          className={`h-full transition-all ${s.pct >= 100 ? 'bg-emerald-500' : s.on_track ? 'bg-amber-500' : 'bg-rose-400'}`}
                          style={{ width: `${Math.min(100, s.pct)}%` }}
                        />
                      </div>
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        of {s.target} won (team target)
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground py-3 text-center" data-testid="race-quotes-empty">
                  Set a team conversions target on the Star Staff page to enable this race.
                </div>
              )}
            </div>
          </div>
        </div>
        {active_highlight && (
          <div
            className="mt-4 p-3 rounded-xl bg-rose-100 dark:bg-rose-500/10 border border-rose-300 dark:border-rose-400/40 flex items-start gap-2"
            data-testid="competition-active-highlight"
          >
            <Megaphone className="w-4 h-4 text-rose-700 dark:text-rose-300 mt-0.5" />
            <div className="text-sm">
              <span className="font-extrabold text-rose-700 dark:text-rose-200">{active_highlight.name}</span>
              {active_highlight.showroom_name && <span className="text-rose-700/80 dark:text-rose-200/80"> · {active_highlight.showroom_name}</span>}
              <span className="text-rose-800 dark:text-rose-100"> — {active_highlight.message}</span>
              <span className="ml-2">🎉</span>
              <span className="block text-[10px] text-rose-700/70 dark:text-rose-300/70 mt-1">Broadcasting until {new Date(active_highlight.expires_at).toLocaleString('en-GB')}</span>
            </div>
            {isSuperAdmin && (
              <button type="button" onClick={clearHighlight} className="ml-auto text-rose-700/70 hover:text-rose-900 dark:text-rose-300/70 dark:hover:text-rose-100" data-testid="competition-clear-highlight">
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </Card>

      {/* 13 Jun 2026 — Motivational banner + weekly climber callout.
          Sits between the hero card and the dual leaderboards so it
          catches attention at the top of the page without pushing
          the actual data down too far. */}
      {(motivationalLine || weekly_climber) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="competition-motivation-row">
          {motivationalLine && (
            <div
              className="p-4 rounded-2xl bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent border border-emerald-500/30 flex items-center gap-3"
              data-testid="competition-motivation-banner"
            >
              <div className="text-3xl shrink-0" aria-hidden="true">{motivationalLine.emoji}</div>
              <div>
                <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-700 dark:text-emerald-300 mb-0.5">Today&apos;s rally</div>
                <div className="text-sm font-semibold text-foreground leading-snug">{motivationalLine.text}</div>
              </div>
            </div>
          )}
          {weekly_climber && (
            <div
              className="p-4 rounded-2xl bg-gradient-to-br from-fuchsia-500/15 via-purple-500/10 to-transparent border border-fuchsia-500/40 flex items-center gap-3"
              data-testid="competition-weekly-climber"
            >
              <div className="text-3xl shrink-0" aria-hidden="true">🚀</div>
              <div>
                <div className="text-[10px] uppercase tracking-wider font-bold text-fuchsia-700 dark:text-fuchsia-300 mb-0.5">Biggest mover this week</div>
                <div className="text-sm font-semibold text-foreground leading-snug">
                  <span className="font-extrabold">{weekly_climber.name}</span>
                  <span className="text-muted-foreground"> · {weekly_climber.showroom_name}</span>
                  <span className="ml-1">jumped <span className="font-extrabold text-fuchsia-700 dark:text-fuchsia-300">{weekly_climber.places_climbed} place{weekly_climber.places_climbed === 1 ? '' : 's'}</span> · now #{weekly_climber.current_rank} 👏</span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* SECTION 5 (PROMOTED) block moved to the very top of the
          page — see above. Quote-conversion leaderboard follows
          here as a separate, less prominent card. */}

      {/* Quote-conversion leaderboard — separate, below Sales. */}
      <Card className="p-4" data-testid="competition-conv-standalone">
        <SectionHeader icon={Crown} title={`Quote-conversion leaderboard · ${month}`} accent="amber" />
        <table className="w-full text-sm" data-testid="competition-conv-table">
          <thead className="text-xs text-muted-foreground uppercase tracking-wider"><tr><th className="text-left py-1.5">#</th><th className="text-left">Staff</th><th className="text-right">Won</th><th className="text-right">Rate</th></tr></thead>
          <tbody>
            {conversionSorted.length === 0 ? (
              <tr><td colSpan={4} className="py-4 text-center text-muted-foreground italic text-xs">No quotes converted yet this month.</td></tr>
            ) : conversionSorted.map((s, idx) => (
              <tr
                key={`fc-${s.user_key}-${idx}`}
                className="border-t border-border/40 cursor-pointer hover:bg-amber-50/40 dark:hover:bg-amber-900/10 transition-colors"
                onClick={() => openDrawer(s)}
                data-testid={`competition-conv-row-${s.name}`}
                title={`Click to see ${s.name}'s recent activity`}
              >
                <td className="py-1.5 font-mono font-bold w-12">
                  <span className="inline-flex items-center gap-1">
                    <span>{idx < 3 ? MEDALS[idx] : idx + 1}</span>
                    <RankDelta change={s.quotes_rank_change} testId={`competition-conv-rank-delta-${s.name}`} />
                  </span>
                </td>
                <td>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <StaffAvatar name={s.name} photoUrl={s.photo_url} size={26} testId={`conv-row-avatar-${s.name}`} />
                    <span className="font-bold">{s.name}</span>
                    <span className="text-xs text-muted-foreground">· {s.showroom_name}</span>
                    <GapToOvertake s={s} mode="quotes" testIdBase={`conv-gap-${s.name}`} />
                  </div>
                </td>
                <td className="text-right font-bold text-amber-700 dark:text-amber-300 tabular-nums">{s.quotes_converted}</td>
                <td className="text-right tabular-nums text-emerald-700 dark:text-emerald-300">{s.conversion_rate}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* SECTION 2 — Head-to-head top-3 */}
      {head_to_head.length > 0 && (
        <Card className="p-4">
          <SectionHeader icon={Trophy} title="Top-3 head-to-head" accent="emerald" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {head_to_head.map((s, idx) => (
              <Card key={`h2h-${s.user_key}-${idx}`} data-testid={`h2h-card-${idx}`} className={`p-4 border-2 ${idx === 0 ? 'border-amber-400/60 bg-amber-500/5' : idx === 1 ? 'border-slate-400/40' : 'border-orange-400/40 bg-orange-500/5'}`}>
                <div className="text-3xl">{MEDALS[idx]}</div>
                <div className="text-lg font-extrabold mt-1">{s.name}</div>
                <div className="text-xs text-muted-foreground">{s.showroom_name}</div>
                <div className="mt-3 grid grid-cols-2 gap-y-1.5 text-xs">
                  <div className="text-muted-foreground">Quotes won</div>
                  <div className="font-bold text-right tabular-nums text-amber-600 dark:text-amber-300">{s.quotes_converted}</div>
                  <div className="text-muted-foreground">Conv rate</div>
                  <div className="font-bold text-right tabular-nums text-emerald-600 dark:text-emerald-300">{s.conversion_rate}%</div>
                  <div className="text-muted-foreground">Sales £</div>
                  <div className="font-bold text-right tabular-nums text-yellow-700 dark:text-yellow-300">£{Number(s.sales_value_gbp).toLocaleString('en-GB', { maximumFractionDigits: 0 })}</div>
                  <div className="text-muted-foreground">Streak</div>
                  <div className="font-bold text-right tabular-nums">
                    {s.streak_days >= 2 ? <span className="text-orange-600 dark:text-orange-300 inline-flex items-center gap-0.5"><Flame className="w-3 h-3" />{s.streak_days}d</span> : '—'}
                  </div>
                  <div className="text-muted-foreground">vs avg</div>
                  <div className="font-bold text-right tabular-nums text-xs">
                    {s.rate_vs_avg_delta === null || s.rate_vs_avg_delta === undefined ? '—' : (
                      <span className={s.rate_vs_avg_delta >= 0 ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300'}>
                        {s.rate_vs_avg_delta >= 0 ? '+' : ''}{s.rate_vs_avg_delta}%
                      </span>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </Card>
      )}

      {/* SECTION 3 — Showroom league removed 8 Jun 2026 (per user
          request: "hide from here / remove this feature"). Race
          progress at the staff level above is the primary view; the
          store-vs-store roll-up was redundant and drew attention to
          stale data drift. Logic preserved on the backend so other
          views can still consume `showrooms` / `showroom_winners`. */}

      {/* SECTION 4 — Streaks, PB chasers, comebacks */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card className="p-4">
          <SectionHeader icon={Flame} title="Active streaks" accent="rose" />
          {active_streaks.length === 0 ? (
            <div className="text-xs text-muted-foreground italic py-2" data-testid="active-streaks-empty">No 3+ day streaks yet.</div>
          ) : (
            <ul className="space-y-1.5" data-testid="active-streaks-list">
              {active_streaks.slice(0, 5).map((s, idx) => (
                <li key={`streak-${s.user_key}-${idx}`} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <Flame className="w-3 h-3 text-orange-600 dark:text-orange-400" />
                    <span className="font-bold">{s.name}</span>
                    <span className="text-muted-foreground text-xs">{s.showroom_name}</span>
                  </span>
                  <span className="font-extrabold text-orange-600 dark:text-orange-400 tabular-nums">{s.streak_days}d 🔥</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <SectionHeader icon={ArrowUpRight} title="Personal-best chasers" accent="emerald" />
          {personal_best_chasers.length === 0 ? (
            <div className="text-xs text-muted-foreground italic py-2" data-testid="pb-chasers-empty">No-one above their personal avg yet.</div>
          ) : (
            <ul className="space-y-1.5" data-testid="pb-chasers-list">
              {personal_best_chasers.slice(0, 5).map((s, idx) => (
                <li key={`pb-${s.user_key}-${idx}`} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <TrendingUp className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                    <span className="font-bold">{s.name}</span>
                  </span>
                  <span className="font-bold text-emerald-600 dark:text-emerald-400 tabular-nums text-xs">+{s.rate_vs_avg_delta}% 📈</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-4">
          <SectionHeader icon={ArrowDownRight} title="Comeback kings" accent="cyan" />
          {comebacks.length === 0 ? (
            <div className="text-xs text-muted-foreground italic py-2" data-testid="comebacks-empty">No comeback stories this month yet.</div>
          ) : (
            <ul className="space-y-1.5" data-testid="comebacks-list">
              {comebacks.slice(0, 5).map((s, idx) => (
                <li key={`cb-${s.user_key}-${idx}`} className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <span className="font-bold">{s.name}</span>
                    <span className="text-muted-foreground text-xs">{s.showroom_name}</span>
                  </span>
                  <span className="text-xs text-cyan-700 dark:text-cyan-300">0 → {s.quotes_converted}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* SECTION 6 — Hall of fame */}
      <Card className="p-4">
        <SectionHeader icon={Award} title="Hall of fame" accent="amber">
          <div className="text-xs text-muted-foreground">Tracking starts June 2026 · snapshots taken at the 1st of each month</div>
        </SectionHeader>
        {history.length === 0 ? (
          <div className="text-xs text-muted-foreground italic py-4 text-center" data-testid="hof-empty">
            No past months recorded yet — the first snapshot will be on the 1st of next month.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-3" data-testid="hof-grid">
            {history.map((h) => (
              <div key={h.month} data-testid={`hof-${h.month}`} className="p-3 rounded-lg border border-border bg-muted/30">
                <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">{h.month}</div>
                {h.champion ? (
                  <>
                    <div className="text-base font-extrabold mt-0.5">👑 {h.champion.name}</div>
                    <div className="text-xs text-muted-foreground">{h.champion.showroom_name}</div>
                    <div className="mt-1 text-xs">
                      <span className="text-amber-700 dark:text-amber-300 font-bold">{h.champion.quotes_converted}</span> won
                      {h.champion.conversion_rate > 0 && (<span className="text-emerald-700 dark:text-emerald-300"> · {h.champion.conversion_rate}%</span>)}
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-muted-foreground italic mt-1">No champion (no conversions).</div>
                )}
                {h.sales_champion && h.sales_champion.name !== h.champion?.name && (
                  <div className="mt-2 pt-2 border-t border-border/40 text-xs">
                    💷 <span className="font-bold">{h.sales_champion.name}</span> · <span className="text-yellow-700 dark:text-yellow-300 font-bold">£{Number(h.sales_champion.sales_value_gbp).toLocaleString('en-GB', { maximumFractionDigits: 0 })}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* SECTION 7 — Highlight a hero (super-admin) */}
      {isSuperAdmin && (
        <Card className="p-4 border-rose-300 dark:border-rose-500/30 bg-rose-50 dark:bg-gradient-to-br dark:from-rose-950/30 dark:to-slate-900/60">
          <SectionHeader icon={Megaphone} title="Highlight a hero · 24 h banner broadcast" accent="rose" />
          <p className="text-xs text-muted-foreground mb-3">
            Celebrate a non-monthly milestone (huge quote closed, customer 5★ review, etc.). Replaces any active highlight; appears as the FIRST slide on the leaderboard banner across every admin page.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
            <Input
              type="text"
              placeholder="Staff name *"
              value={highlightForm.name}
              onChange={(e) => setHighlightForm((f) => ({ ...f, name: e.target.value }))}
              data-testid="highlight-name"
              className="md:col-span-3"
              maxLength={80}
            />
            <Input
              type="text"
              placeholder="Showroom (optional)"
              value={highlightForm.showroom_name}
              onChange={(e) => setHighlightForm((f) => ({ ...f, showroom_name: e.target.value }))}
              data-testid="highlight-showroom"
              className="md:col-span-2"
              maxLength={80}
            />
            <Input
              type="text"
              placeholder="Message — e.g. just closed biggest quote ever — £18,420!"
              value={highlightForm.message}
              onChange={(e) => setHighlightForm((f) => ({ ...f, message: e.target.value.slice(0, 240) }))}
              data-testid="highlight-message"
              className="md:col-span-5"
              maxLength={240}
            />
            <Input
              type="number"
              min="1"
              max="168"
              value={highlightForm.duration_hours}
              onChange={(e) => setHighlightForm((f) => ({ ...f, duration_hours: e.target.value }))}
              data-testid="highlight-hours"
              className="md:col-span-1"
              title="Hours to broadcast"
            />
            <Button
              onClick={broadcastHighlight}
              disabled={broadcasting || !highlightForm.name || !highlightForm.message}
              data-testid="highlight-broadcast"
              className="md:col-span-1"
            >
              <Send className="w-3.5 h-3.5 mr-1" /> {broadcasting ? 'Sending…' : 'Send'}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground mt-2 italic">
            Message length: {highlightForm.message.length}/240 · Duration: {highlightForm.duration_hours} hours
          </p>

          {/* Live preview — pixel-matches LeaderboardBanner's
              highlight slide so the super-admin sees exactly how
              the broadcast will render across every admin page
              BEFORE they hit Send. Updates in real-time as they
              type. (4 Jun 2026 — user-requested preview pane.) */}
          <div className="mt-4" data-testid="highlight-preview-wrap">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-bold text-muted-foreground mb-1.5">
              <Eye className="w-3 h-3" />
              Preview · this is what every admin will see at the top of every page
            </div>
            <div className="rounded-lg overflow-hidden border border-emerald-700/40 shadow-md">
              {(highlightForm.name.trim() || highlightForm.message.trim()) ? (
                <div
                  data-testid="highlight-preview"
                  className="bg-gradient-to-r from-emerald-950 via-emerald-900 to-amber-950 text-emerald-50 text-xs md:text-sm"
                >
                  <div className="flex items-center justify-center gap-2 px-3 md:px-6 py-1.5">
                    <Trophy className="w-4 h-4 text-amber-300 flex-shrink-0 animate-pulse" />
                    <div className="truncate text-center leading-snug">
                      <span className="font-extrabold text-amber-200" data-testid="highlight-preview-name">
                        {highlightForm.name.trim() || 'Staff name'}
                      </span>
                      {highlightForm.showroom_name.trim() && (
                        <span className="text-amber-200/80"> · {highlightForm.showroom_name.trim()}</span>
                      )}
                      <span className="text-emerald-200">
                        {' '}— {highlightForm.message.trim() || 'Your message will appear here…'}
                      </span>
                      <span className="ml-2">🎉</span>
                    </div>
                    <div className="hidden md:flex items-center gap-1 ml-2 flex-shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-300" />
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-200/30" />
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-200/30" />
                    </div>
                    <span className="hidden md:inline-flex items-center gap-1 ml-2 px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-300/40 text-[10px] uppercase tracking-wider font-bold text-amber-100">
                      See full board ›
                    </span>
                  </div>
                </div>
              ) : (
                <div
                  data-testid="highlight-preview-empty"
                  className="bg-muted/40 text-muted-foreground text-xs italic px-4 py-3 text-center"
                >
                  Start typing a staff name or message above — the live banner preview will appear here.
                </div>
              )}
            </div>
            {(highlightForm.name.trim() || highlightForm.message.trim()) && (
              <div className="text-[10px] text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                <span>👁 Broadcasts to every super-admin / admin / manager / staff browser tab.</span>
                <span>⏱ Disappears automatically after {highlightForm.duration_hours || 24} h.</span>
                <span>🔄 Replaces any active highlight.</span>
              </div>
            )}
          </div>
        </Card>
      )}

      <div className="text-xs text-muted-foreground text-center">
        <Clock className="w-3 h-3 inline mr-1" />
        Showing {total_staff} staff across all showrooms · auto-refresh every 60 s
      </div>

      {/* Staff recent-activity drawer (6 Jun 2026) — click a row
          to verify the £ Sold + # Won counts against the actual
          quotes/invoices that fed them. Read-only audit trail. */}
      {drawerStaff && (
        <StaffRecentDrawer
          staff={drawerStaff}
          data={drawerData}
          loading={drawerLoading}
          onClose={closeDrawer}
        />
      )}

      {/* 13 Jun 2026 — Quick-access photo manager. Super-admin only.
          Lists every staff with their current photo + inline upload. */}
      {photoMgrOpen && isSuperAdmin && (
        <StaffPhotoManagerDialog
          staff={fullStaff}
          onClose={() => setPhotoMgrOpen(false)}
          onUpdated={refresh}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Drawer component — kept inside the same file because it shares
// styling tokens and there's no plan to reuse it elsewhere yet.
// ─────────────────────────────────────────────────────────────────
function StaffRecentDrawer({ staff, data, loading, onClose }) {
  const navigate = useNavigate();
  const quotes = data?.quotes || [];
  const invoices = data?.invoices || [];
  const totalQuotes = data?.total_quotes ?? quotes.length;
  const totalInvoices = data?.total_invoices ?? invoices.length;

  const fmtDate = (iso) => {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      });
    } catch { return iso; }
  };

  const fmtGBP = (n) => `£${Number(n || 0).toLocaleString('en-GB', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

  // 6 Jun 2026 — deep-link rows to the canonical history pages
  // (each carries the deep-link search-param shim added on the
  // same date). Close the drawer first so the admin lands on
  // the new page with the drawer out of the way.
  const goToQuote = (quote_no) => {
    if (!quote_no) return;
    onClose();
    navigate(`/admin/quotation-history?search=${encodeURIComponent(quote_no)}`);
  };
  const goToInvoice = (invoice_no) => {
    if (!invoice_no) return;
    onClose();
    navigate(`/admin/invoice-history?search=${encodeURIComponent(invoice_no)}`);
  };

  return (
    <div className="fixed inset-0 z-[60] flex" data-testid="staff-recent-drawer">
      <div className="flex-1 bg-black/40" onClick={onClose} />
      <aside className="w-full max-w-xl bg-background border-l border-border overflow-y-auto shadow-2xl">
        <header className="sticky top-0 bg-background border-b border-border p-4 flex items-start justify-between gap-3 z-10">
          <div className="flex-1">
            <div className="text-xs text-muted-foreground uppercase tracking-wider">Recent activity</div>
            <div className="text-xl font-extrabold mt-0.5">{staff.name}</div>
            {staff.showroom_name && (
              <div className="text-xs text-muted-foreground">{staff.showroom_name}</div>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground" data-testid="staff-recent-drawer-close">
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="p-4 space-y-5">
          {/* 13 Jun 2026 — Monthly 1-to-1 PDF reports. Promoted out
              of the cramped drawer header into its own card with
              self-explanatory plain-English labels (was: two near-
              identical pill buttons that confused managers about
              which month was which). */}
          <MonthlyReportCard staff={staff} />
          {/* Top-of-drawer totals match the leaderboard so the admin
              can cross-check at a glance. */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md border border-amber-200 dark:border-amber-700/40 bg-amber-50/50 dark:bg-amber-900/20 p-2 text-center">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Quotes won</div>
              <div className="text-lg font-extrabold text-amber-700 dark:text-amber-300 tabular-nums">{staff.quotes_converted ?? 0}</div>
              <div className="text-[10px] text-muted-foreground">of {staff.quotes_created ?? 0} created</div>
            </div>
            <div className="rounded-md border border-emerald-200 dark:border-emerald-700/40 bg-emerald-50/50 dark:bg-emerald-900/20 p-2 text-center">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Rate</div>
              <div className="text-lg font-extrabold text-emerald-700 dark:text-emerald-300 tabular-nums">{staff.conversion_rate ?? 0}%</div>
            </div>
            <div className="rounded-md border border-yellow-200 dark:border-yellow-700/40 bg-yellow-50/50 dark:bg-yellow-900/20 p-2 text-center">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">£ Sold</div>
              <div className="text-lg font-extrabold text-yellow-700 dark:text-yellow-300 tabular-nums">£{Number(staff.sales_value_gbp || 0).toLocaleString('en-GB', { maximumFractionDigits: 0 })}</div>
              <div className="text-[10px] text-muted-foreground">{staff.sales_count ?? 0} invoices</div>
            </div>
          </div>

          {loading ? (
            <div className="py-12 text-center text-muted-foreground text-sm">Loading recent activity…</div>
          ) : (
            <>
              {/* Quotes table */}
              <section data-testid="staff-recent-quotes">
                <div className="flex items-center justify-between mb-1.5">
                  <h3 className="text-xs uppercase tracking-wider font-bold text-amber-700 dark:text-amber-300">
                    Recent quotes
                  </h3>
                  <span className="text-[10px] text-muted-foreground">
                    Showing {quotes.length} of {totalQuotes} this month
                  </span>
                </div>
                {quotes.length === 0 ? (
                  <div className="py-4 text-center text-xs italic text-muted-foreground border border-dashed border-border rounded-md">
                    No quotes from {staff.name} this month.
                  </div>
                ) : (
                  <table className="w-full text-xs border border-border rounded-md overflow-hidden">
                    <thead className="bg-muted/40 text-muted-foreground uppercase tracking-wider text-[10px]">
                      <tr>
                        <th className="text-left py-1.5 px-2">Quote #</th>
                        <th className="text-left">Customer</th>
                        <th className="text-right">Total</th>
                        <th className="text-center">Status</th>
                        <th className="text-right pr-2">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quotes.map((q) => (
                        <tr
                          key={q.id || q.quotation_no}
                          className="border-t border-border/40 cursor-pointer hover:bg-amber-50/40 dark:hover:bg-amber-900/10 transition-colors"
                          onClick={() => goToQuote(q.quotation_no)}
                          data-testid={`staff-recent-quote-row-${q.quotation_no}`}
                          title={`Open ${q.quotation_no} in Quotation History`}
                        >
                          <td className="py-1.5 px-2 font-mono text-emerald-700 dark:text-emerald-300 underline-offset-2 group-hover:underline">{q.quotation_no || '—'}</td>
                          <td className="truncate max-w-[140px]">{q.customer_name}</td>
                          <td className="text-right tabular-nums">{fmtGBP(q.total)}</td>
                          <td className="text-center">
                            {q.converted ? (
                              <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300 font-semibold">
                                <CheckCircle2 className="w-3 h-3" /> Converted
                              </span>
                            ) : q.status === 'expired' ? (
                              <span className="text-rose-700 dark:text-rose-300 font-semibold">Expired</span>
                            ) : (
                              <span className="text-amber-700 dark:text-amber-300">{q.status || 'Active'}</span>
                            )}
                          </td>
                          <td className="text-right pr-2 text-muted-foreground tabular-nums">{fmtDate(q.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              {/* Invoices table */}
              <section data-testid="staff-recent-invoices">
                <div className="flex items-center justify-between mb-1.5">
                  <h3 className="text-xs uppercase tracking-wider font-bold text-yellow-700 dark:text-yellow-300">
                    Recent Special-Order invoices
                  </h3>
                  <span className="text-[10px] text-muted-foreground">
                    Showing {invoices.length} of {totalInvoices} this month
                  </span>
                </div>
                {invoices.length === 0 ? (
                  <div className="py-4 text-center text-xs italic text-muted-foreground border border-dashed border-border rounded-md">
                    No Special-Order invoices from {staff.name} this month.
                  </div>
                ) : (
                  <table className="w-full text-xs border border-border rounded-md overflow-hidden">
                    <thead className="bg-muted/40 text-muted-foreground uppercase tracking-wider text-[10px]">
                      <tr>
                        <th className="text-left py-1.5 px-2">Invoice #</th>
                        <th className="text-left">Customer</th>
                        <th className="text-right">Total</th>
                        <th className="text-right pr-2">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoices.map((inv) => (
                        <tr
                          key={inv.id || inv.invoice_no}
                          className="border-t border-border/40 cursor-pointer hover:bg-yellow-50/40 dark:hover:bg-yellow-900/10 transition-colors"
                          onClick={() => goToInvoice(inv.invoice_no)}
                          data-testid={`staff-recent-invoice-row-${inv.invoice_no}`}
                          title={`Open ${inv.invoice_no} in Invoice History`}
                        >
                          <td className="py-1.5 px-2 font-mono text-emerald-700 dark:text-emerald-300">{inv.invoice_no || '—'}</td>
                          <td className="truncate max-w-[160px]">{inv.customer_name}</td>
                          <td className="text-right tabular-nums font-bold text-yellow-700 dark:text-yellow-300">{fmtGBP(inv.total)}</td>
                          <td className="text-right pr-2 text-muted-foreground tabular-nums">{fmtDate(inv.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <p className="text-[10px] text-muted-foreground italic">
                Tip: this drawer reads from the same source as the leaderboard — if a number looks off, check whether the staff member typed their name consistently on the EPOS form.
              </p>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

/**
 * RankDelta — small ▲/▼ badge showing leaderboard-position change
 * vs the previous day's snapshot.
 *   change > 0  → moved UP the table (rank improved)
 *   change < 0  → dropped down
 *   change == 0 → unchanged (no badge — keeps the table calm)
 *   change null → no prior snapshot (new staff, or first day)
 */
function RankDelta({ change, testId }) {
  if (change === null || change === undefined || change === 0) return null;
  const up = change > 0;
  const tone = up
    ? 'text-emerald-600 dark:text-emerald-400'
    : 'text-rose-600 dark:text-rose-400';
  const title = up
    ? `Moved up ${Math.abs(change)} place${Math.abs(change) === 1 ? '' : 's'} since yesterday`
    : `Dropped ${Math.abs(change)} place${Math.abs(change) === 1 ? '' : 's'} since yesterday`;
  return (
    <span
      className={`inline-flex items-center text-[10px] font-bold leading-none ${tone}`}
      title={title}
      data-testid={testId}
    >
      {up ? '▲' : '▼'}{Math.abs(change)}
    </span>
  );
}

function GapToOvertake({ s, mode, testIdBase }) {
  // SALES leaderboard
  if (mode === 'sales') {
    if (s.sales_gap_to_above_gbp) {
      return (
        <span
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-bold leading-none text-emerald-700 dark:text-emerald-300 tabular-nums"
          title={`Sell £${Number(s.sales_gap_to_above_gbp).toLocaleString('en-GB')} more to overtake ${s.sales_gap_to_above_name}`}
          data-testid={`${testIdBase}-pill`}
        >
          ↑ £{Number(s.sales_gap_to_above_gbp).toLocaleString('en-GB', { maximumFractionDigits: 0 })} to pip {s.sales_gap_to_above_name}
        </span>
      );
    }
    if (s.sales_lead_over_below_gbp) {
      return (
        <span
          className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-[10px] font-bold leading-none text-amber-700 dark:text-amber-300 tabular-nums"
          title={`Leading ${s.sales_lead_over_below_name} by £${Number(s.sales_lead_over_below_gbp).toLocaleString('en-GB')} — don't ease up!`}
          data-testid={`${testIdBase}-lead-pill`}
        >
          🏆 +£{Number(s.sales_lead_over_below_gbp).toLocaleString('en-GB', { maximumFractionDigits: 0 })} ahead
        </span>
      );
    }
    return null;
  }
  // QUOTES leaderboard
  if (s.quotes_gap_to_above) {
    return (
      <span
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-bold leading-none text-emerald-700 dark:text-emerald-300 ml-1.5"
        title={`Win ${s.quotes_gap_to_above} more quote${s.quotes_gap_to_above === 1 ? '' : 's'} to overtake ${s.quotes_gap_to_above_name}`}
        data-testid={`${testIdBase}-pill`}
      >
        ↑ {s.quotes_gap_to_above} to pip {s.quotes_gap_to_above_name}
      </span>
    );
  }
  if (s.quotes_lead_over_below) {
    return (
      <span
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-[10px] font-bold leading-none text-amber-700 dark:text-amber-300 ml-1.5"
        title={`Leading ${s.quotes_lead_over_below_name} by ${s.quotes_lead_over_below} won quote${s.quotes_lead_over_below === 1 ? '' : 's'}`}
        data-testid={`${testIdBase}-lead-pill`}
      >
        🏆 +{s.quotes_lead_over_below} ahead
      </span>
    );
  }
  return null;
}

/**
 * StaffAvatar — circular profile picture if uploaded, otherwise
 * initials in a coloured circle. Used by the podium + (optionally)
 * inline in leaderboard rows in the future.
 */
function StaffAvatar({ name, photoUrl, size = 48, testId }) {
  const initials = (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';
  // Deterministic background tint based on the name (so the same staff
  // always gets the same fallback colour).
  const palette = ['bg-emerald-500/80', 'bg-amber-500/80', 'bg-rose-500/80', 'bg-fuchsia-500/80', 'bg-sky-500/80', 'bg-indigo-500/80'];
  const idx = Math.abs([...name || ''].reduce((a, c) => a + c.charCodeAt(0), 0)) % palette.length;
  const dim = { width: size, height: size };
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={name}
        style={dim}
        className="rounded-full object-cover border-2 border-white/40 dark:border-slate-700/40 shadow"
        data-testid={testId}
        loading="lazy"
      />
    );
  }
  return (
    <div
      style={dim}
      className={`rounded-full flex items-center justify-center text-white font-bold shadow ${palette[idx]}`}
      data-testid={testId}
    >
      <span style={{ fontSize: Math.round(size * 0.4) }}>{initials}</span>
    </div>
  );
}

/**
 * TopThreePodium — visual podium for the top 3 of the SALES board.
 * 1st place is centred + elevated; 2nd and 3rd flank it. Clicking
 * any plinth opens that staff's recent-activity drawer. Renders
 * nothing when no staff has any sales yet (keeps the page calm
 * during quiet days).
 */
function TopThreePodium({ staff, onPick }) {
  const top = (staff || []).filter((s) => (s.sales_value_gbp || 0) > 0).slice(0, 3);
  if (top.length === 0) return null;
  // Order on-screen: [#2, #1, #3] so the gold winner stands centre.
  const layout = [top[1], top[0], top[2]].filter(Boolean);
  return (
    <div className="grid grid-cols-3 gap-3 items-end" data-testid="top-three-podium">
      {layout.map((s) => {
        const rank = top.indexOf(s) + 1;
        const isFirst = rank === 1;
        const isSecond = rank === 2;
        const accent = isFirst
          ? 'border-amber-400 bg-gradient-to-br from-amber-50 via-yellow-50 to-amber-100 dark:from-amber-950/30 dark:via-yellow-950/20 dark:to-amber-900/20 shadow-amber-400/30'
          : isSecond
            ? 'border-slate-300 bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900/40 dark:to-slate-800/40 shadow-slate-400/20'
            : 'border-orange-400/60 bg-gradient-to-br from-orange-50 to-amber-50 dark:from-orange-950/30 dark:to-amber-950/20 shadow-orange-400/20';
        const trophy = isFirst ? '🏆' : isSecond ? '🥈' : '🥉';
        const height = isFirst ? 'pt-8 pb-6' : 'pt-5 pb-4';
        const avatarSize = isFirst ? 76 : 60;
        return (
          <button
            key={`podium-${s.user_key}`}
            type="button"
            onClick={() => onPick && onPick(s)}
            className={`text-left rounded-2xl border-2 ${accent} ${height} px-4 shadow-lg hover:shadow-xl transition-shadow cursor-pointer`}
            data-testid={`podium-rank-${rank}`}
            title={`#${rank} · click to see ${s.name}'s recent invoices`}
          >
            <div className="flex flex-col items-center gap-2">
              <div className="text-3xl">{trophy}</div>
              <StaffAvatar
                name={s.name}
                photoUrl={s.photo_url}
                size={avatarSize}
                testId={`podium-avatar-${rank}`}
              />
              <div className={`font-extrabold ${isFirst ? 'text-xl' : 'text-base'} text-center leading-tight`}>{s.name}</div>
              <div className="text-[11px] text-muted-foreground text-center">{s.showroom_name}</div>
              <div className={`tabular-nums font-bold ${isFirst ? 'text-2xl text-amber-700 dark:text-amber-300' : 'text-lg text-emerald-700 dark:text-emerald-300'}`}>
                £{Number(s.sales_value_gbp).toLocaleString('en-GB', { maximumFractionDigits: 0 })}
              </div>
              <div className="text-[10px] text-muted-foreground">
                {s.sales_count} sale{s.sales_count === 1 ? '' : 's'} · score {(s.sales_composite_score ?? 0).toFixed(1)}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/**
 * StaffPhotoManagerDialog — quick photo-management modal opened from
 * the Sales card. Lists every staff with their current photo +
 * inline Upload / Remove buttons. Super-admin only.
 *
 * Replaces "go to /admin/users → find user → edit → scroll up →
 * upload" with a one-click flow right from the leaderboard.
 */
function StaffPhotoManagerDialog({ staff, onClose, onUpdated }) {
  const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
  const [busyUid, setBusyUid] = useState(null);
  const [localPhotos, setLocalPhotos] = useState(() => {
    const map = {};
    (staff || []).forEach((s) => {
      if (s.user_id) map[s.user_id] = s.photo_url || null;
    });
    return map;
  });
  const fileInputs = useRef({});

  const eligible = useMemo(
    () => (staff || [])
      .filter((s) => s.user_id) // can only upload for resolved users
      .sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    [staff]
  );

  const compress = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        const ratio = Math.max(size / img.width, size / img.height);
        const w = img.width * ratio;
        const h = img.height * ratio;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  const handleFile = async (uid, file) => {
    if (!file || !file.type.startsWith('image/')) {
      toast.error('Please pick an image file.');
      return;
    }
    setBusyUid(uid);
    try {
      const dataUrl = await compress(file);
      const token = localStorage.getItem('token');
      const r = await fetch(`${API}/staff/${uid}/photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ photo_data_url: dataUrl }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast.error(`Upload failed: ${j?.detail || r.status}`);
        return;
      }
      setLocalPhotos((p) => ({ ...p, [uid]: dataUrl }));
      toast.success('Photo uploaded.');
      onUpdated?.();
    } catch (e) {
      toast.error(`Upload failed: ${e.message}`);
    } finally {
      setBusyUid(null);
    }
  };

  const handleRemove = async (uid, name) => {
    if (!window.confirm(`Remove ${name}'s photo?`)) return;
    setBusyUid(uid);
    try {
      const token = localStorage.getItem('token');
      const r = await fetch(`${API}/staff/${uid}/photo`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast.error(`Remove failed: ${j?.detail || r.status}`);
        return;
      }
      setLocalPhotos((p) => ({ ...p, [uid]: null }));
      toast.success('Photo removed.');
      onUpdated?.();
    } catch (e) {
      toast.error(`Remove failed: ${e.message}`);
    } finally {
      setBusyUid(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid="staff-photo-manager"
    >
      <div
        className="bg-background rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-xl font-bold">📷 Staff Profile Photos</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Photos show on the podium and next to every name on the leaderboards.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground rounded p-1"
            data-testid="staff-photo-manager-close"
            aria-label="Close"
          >✕</button>
        </div>
        <div className="overflow-y-auto p-4 space-y-2">
          {eligible.length === 0 && (
            <div className="text-sm text-muted-foreground italic text-center py-8">
              No resolved staff users found.
            </div>
          )}
          {eligible.map((s) => {
            const uid = s.user_id;
            const photo = localPhotos[uid];
            const isBusy = busyUid === uid;
            return (
              <div
                key={uid}
                className="flex items-center gap-3 p-2 rounded-lg border bg-muted/20 hover:bg-muted/40 transition-colors"
                data-testid={`photo-mgr-row-${s.name}`}
              >
                <StaffAvatar name={s.name} photoUrl={photo} size={48} />
                <div className="flex-1 min-w-0">
                  <div className="font-bold truncate">{s.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{s.showroom_name || '—'}</div>
                </div>
                <input
                  ref={(el) => { fileInputs.current[uid] = el; }}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    handleFile(uid, e.target.files?.[0]);
                    e.target.value = '';
                  }}
                  data-testid={`photo-mgr-file-${s.name}`}
                />
                <button
                  type="button"
                  onClick={() => fileInputs.current[uid]?.click()}
                  disabled={isBusy}
                  className="px-3 py-1.5 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold disabled:opacity-50"
                  data-testid={`photo-mgr-upload-${s.name}`}
                >
                  {isBusy ? '…' : (photo ? 'Replace' : 'Upload')}
                </button>
                {photo && (
                  <button
                    type="button"
                    onClick={() => handleRemove(uid, s.name)}
                    disabled={isBusy}
                    className="px-2 py-1.5 rounded-md text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30 text-xs font-semibold disabled:opacity-50"
                    data-testid={`photo-mgr-remove-${s.name}`}
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="p-3 border-t text-[11px] text-muted-foreground text-center">
          Images auto-compressed to 256×256 · 500KB max
        </div>
      </div>
    </div>
  );
}

/**
 * MonthlyReportCard — clear, plain-English UI for downloading a
 * staff member's 1-to-1 PDF report. Replaces the original twin-pill
 * design that managers found confusing (two near-identical buttons
 * tucked into the drawer header).
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ Monthly 1-to-1 Report                                   │
 *   │ A printable PDF with this staff member's sales, quotes  │
 *   │ and conversion stats for the chosen month.              │
 *   │                                                         │
 *   │  ┌──────────────────────┐  ┌──────────────────────────┐ │
 *   │  │ This month (so far)  │  │ Last month (final)       │ │
 *   │  │ January 2026         │  │ December 2025            │ │
 *   │  │  ↓ Download PDF      │  │  ↓ Download PDF          │ │
 *   │  └──────────────────────┘  └──────────────────────────┘ │
 *   └─────────────────────────────────────────────────────────┘
 */
function MonthlyReportCard({ staff }) {
  const now = new Date();
  const currentMonth = {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    label: now.toLocaleString('en-GB', { month: 'long', year: 'numeric' }),
  };
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const previousMonth = {
    year: prevDate.getFullYear(),
    month: prevDate.getMonth() + 1,
    label: prevDate.toLocaleString('en-GB', { month: 'long', year: 'numeric' }),
  };

  return (
    <section
      className="rounded-lg border border-border bg-muted/30 p-4"
      data-testid="monthly-report-card"
    >
      <div className="flex items-start gap-2 mb-1">
        <FileText className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
        <div>
          <h3 className="text-sm font-bold leading-tight">Monthly 1-to-1 Report</h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            A printable PDF with {staff.name}&rsquo;s sales, quotes and conversion stats. Pick a month below.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
        <MonthlyReportTile
          staff={staff}
          target={currentMonth}
          tag="This month (so far)"
          accent="emerald"
          testidSuffix="current"
        />
        <MonthlyReportTile
          staff={staff}
          target={previousMonth}
          tag="Last month (final)"
          accent="slate"
          testidSuffix="previous"
        />
      </div>
    </section>
  );
}

/**
 * MonthlyReportTile — single download card used twice by
 * MonthlyReportCard. Self-contained so each tile owns its own busy
 * state without one click greying out the other.
 */
function MonthlyReportTile({ staff, target, tag, accent, testidSuffix }) {
  const [busy, setBusy] = useState(false);

  const handleDownload = async () => {
    setBusy(true);
    try {
      const token = localStorage.getItem('token');
      const key = staff.user_key || staff.user_id || staff.name;
      const url = `${process.env.REACT_APP_BACKEND_URL}/api/staff-leaderboard/staff/${encodeURIComponent(key)}/monthly-report.pdf?year=${target.year}&month=${target.month}`;
      const resp = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try { const j = await resp.json(); detail = j?.detail || detail; } catch { /* binary */ }
        toast.error(`Report failed: ${detail}`);
        return;
      }
      const blob = await resp.blob();
      const dlUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = dlUrl;
      const safeName = (staff.name || 'staff').replace(/[^A-Za-z0-9._-]+/g, '_');
      a.download = `report_${safeName}_${target.year}-${String(target.month).padStart(2, '0')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(dlUrl);
      toast.success(`Report downloaded — ${target.label}.`);
    } catch (e) {
      toast.error(`Report failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const styles = accent === 'emerald'
    ? 'border-emerald-300 bg-emerald-50/60 hover:bg-emerald-100/80 dark:border-emerald-700/60 dark:bg-emerald-900/20 dark:hover:bg-emerald-900/40'
    : 'border-slate-300 bg-white hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900/40 dark:hover:bg-slate-900/60';
  const tagColor = accent === 'emerald'
    ? 'text-emerald-700 dark:text-emerald-300'
    : 'text-slate-600 dark:text-slate-300';

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={busy}
      className={`group relative text-left rounded-md border p-3 transition-colors disabled:opacity-50 disabled:cursor-wait ${styles}`}
      data-testid={`monthly-report-${testidSuffix}-${staff.name}`}
      title={`Download ${target.label} report for ${staff.name}`}
    >
      <div className={`text-[10px] font-bold uppercase tracking-wider ${tagColor}`}>
        {tag}
      </div>
      <div className="text-sm font-extrabold mt-0.5 leading-tight">{target.label}</div>
      <div className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-semibold text-foreground/80 group-hover:text-foreground">
        <Download className="w-3.5 h-3.5" />
        {busy ? 'Generating PDF…' : 'Download PDF'}
      </div>
    </button>
  );
}
