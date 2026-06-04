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
import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import {
  Crown, Trophy, Flame, TrendingUp, Award, Megaphone,
  Clock, Target, Calendar, ArrowUpRight, ArrowDownRight,
  Send, X, Sparkles, BarChart3,
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
  const salesSorted = useMemo(() => {
    if (!data?.progress?.length) return [];
    return [...data.progress].sort((a, b) => b.sales_value_gbp - a.sales_value_gbp);
  }, [data]);

  if (loading) {
    return <div className="p-6 text-center text-muted-foreground" data-testid="competition-loading">Loading competition dashboard…</div>;
  }
  if (!data) {
    return <div className="p-6 text-center text-rose-500">Couldn't load — try refresh.</div>;
  }

  const {
    month, days_elapsed, days_total, days_left,
    champion, target, progress, head_to_head, showrooms,
    showroom_winners, active_streaks, personal_best_chasers,
    comebacks, active_highlight, total_staff,
  } = data;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto space-y-5" data-testid="competition-dashboard">
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

          {/* Race-to-target — neutral muted card readable in either theme */}
          <div className="lg:col-span-2 p-4 rounded-2xl bg-card border border-border">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wider font-bold text-emerald-700 dark:text-emerald-300">
                <Target className="w-3.5 h-3.5" />
                Race to target
              </div>
              {target?.value ? (
                <div className="text-xs text-emerald-700 dark:text-emerald-300">
                  Goal: <span className="font-bold">{target.metric === 'sales_gbp' ? '£' : ''}{Number(target.value).toLocaleString('en-GB')}</span>{' '}
                  {target.metric === 'sales_gbp' ? 'sales' : 'conversions'}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground italic">No team target set</div>
              )}
            </div>
            {target?.value && progress.length > 0 ? (
              <div className="space-y-2" data-testid="competition-race">
                {progress.slice(0, 10).map((s, idx) => (
                  <div key={`race-${s.user_key}-${idx}`}>
                    <div className="flex items-center justify-between text-xs mb-0.5">
                      <span className="font-semibold flex items-center gap-1.5">
                        <span className="text-muted-foreground w-5 font-mono">{idx < 3 ? MEDALS[idx] : `#${idx + 1}`}</span>
                        {s.name}
                        <span className="text-muted-foreground font-normal">· {s.showroom_name}</span>
                      </span>
                      <span className={`tabular-nums ${s.pct >= 100 ? 'text-emerald-700 dark:text-emerald-300 font-bold' : 'text-muted-foreground'}`}>
                        {target.metric === 'sales_gbp' ? '£' : ''}{Number(s.current).toLocaleString('en-GB')} · {s.pct}% {s.pct >= 100 && '✓'}
                      </span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all ${s.pct >= 100 ? 'bg-emerald-500' : s.on_track ? 'bg-fuchsia-500' : 'bg-amber-500'}`}
                        style={{ width: `${Math.min(100, s.pct)}%` }}
                      />
                    </div>
                    {!s.on_track && s.projected_eom > 0 && (
                      <div className="text-[10px] text-amber-700 dark:text-amber-400/80 mt-0.5">
                        Projected end-of-month: {target.metric === 'sales_gbp' ? '£' : ''}{Number(s.projected_eom).toLocaleString('en-GB')} ({Math.round((s.projected_eom / target.value) * 100)}%)
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground py-3 text-center" data-testid="competition-no-target">
                {target?.value
                  ? 'No staff progress yet.'
                  : 'Set a monthly target on the Star Staff page to see live race progress here.'}
              </div>
            )}
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

      {/* SECTION 5 (PROMOTED) — Dual leaderboards visible
          immediately after the hero (3 Jun 2026 — user couldn't
          find the sales leaderboard; it was buried after the
          showroom comparison + streaks). Moved up so they're the
          first detailed view after the hero. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" data-testid="competition-dual-leaderboards">
        <Card className="p-4">
          <SectionHeader icon={Crown} title={`Quote-conversion leaderboard · ${month}`} accent="amber" />
          <table className="w-full text-sm" data-testid="competition-conv-table">
            <thead className="text-xs text-muted-foreground uppercase tracking-wider"><tr><th className="text-left py-1.5">#</th><th className="text-left">Staff</th><th className="text-right">Won</th><th className="text-right">Rate</th></tr></thead>
            <tbody>
              {(progress.length ? progress : head_to_head).length === 0 ? (
                <tr><td colSpan={4} className="py-4 text-center text-muted-foreground italic text-xs">No quotes converted yet this month.</td></tr>
              ) : (progress.length ? progress : head_to_head).map((s, idx) => (
                <tr key={`fc-${s.user_key}-${idx}`} className="border-t border-border/40">
                  <td className="py-1.5 font-mono font-bold w-8">{idx < 3 ? MEDALS[idx] : idx + 1}</td>
                  <td><span className="font-bold">{s.name}</span> <span className="text-xs text-muted-foreground">· {s.showroom_name}</span></td>
                  <td className="text-right font-bold text-amber-700 dark:text-amber-300 tabular-nums">{s.quotes_converted}</td>
                  <td className="text-right tabular-nums text-emerald-700 dark:text-emerald-300">{s.conversion_rate}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card className="p-4">
          <SectionHeader icon={Trophy} title={`Sales leaderboard · ${month}`} accent="emerald">
            <span className="text-[10px] text-muted-foreground">(Special-Order only)</span>
          </SectionHeader>
          <table className="w-full text-sm" data-testid="competition-sales-table">
            <thead className="text-xs text-muted-foreground uppercase tracking-wider"><tr><th className="text-left py-1.5">#</th><th className="text-left">Staff</th><th className="text-right">£ Sold</th><th className="text-right">#</th></tr></thead>
            <tbody>
              {salesSorted.length === 0 ? (
                <tr><td colSpan={4} className="py-4 text-center text-muted-foreground italic text-xs">No Special-Order sales yet this month.</td></tr>
              ) : salesSorted.map((s, idx) => (
                <tr key={`fs-${s.user_key}-${idx}`} className="border-t border-border/40">
                  <td className="py-1.5 font-mono font-bold w-8">{idx < 3 ? MEDALS[idx] : idx + 1}</td>
                  <td><span className="font-bold">{s.name}</span> <span className="text-xs text-muted-foreground">· {s.showroom_name}</span></td>
                  <td className="text-right font-bold text-yellow-700 dark:text-yellow-300 tabular-nums">£{Number(s.sales_value_gbp).toLocaleString('en-GB', { maximumFractionDigits: 0 })}</td>
                  <td className="text-right tabular-nums">{s.sales_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

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

      {/* SECTION 3 — Showroom vs showroom */}
      {showrooms.length > 0 && (
        <Card className="p-4">
          <SectionHeader icon={BarChart3} title="Showroom vs showroom" accent="fuchsia">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {showroom_winners?.conversions && (
                <span className="px-2 py-1 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-700 dark:text-amber-300 font-bold">👑 Most wins: {showroom_winners.conversions.showroom_name}</span>
              )}
              {showroom_winners?.sales_gbp && (
                <span className="px-2 py-1 rounded-full bg-yellow-500/15 border border-yellow-500/40 text-yellow-700 dark:text-yellow-300 font-bold">💷 Top £: {showroom_winners.sales_gbp.showroom_name}</span>
              )}
              {showroom_winners?.conversion_rate && (
                <span className="px-2 py-1 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-700 dark:text-emerald-300 font-bold">🎯 Best rate: {showroom_winners.conversion_rate.showroom_name}</span>
              )}
            </div>
          </SectionHeader>
          <div className="space-y-2">
            {showrooms.map((r) => {
              const maxConv = Math.max(...showrooms.map((x) => x.quotes_converted), 1);
              const maxSales = Math.max(...showrooms.map((x) => x.sales_value_gbp), 1);
              const convPct = (r.quotes_converted / maxConv) * 100;
              const salesPct = (r.sales_value_gbp / maxSales) * 100;
              return (
                <div key={r.showroom_name} data-testid={`showroom-row-${r.showroom_name}`} className="p-3 rounded-lg border border-border bg-muted/20">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-bold">{r.showroom_name} <span className="text-xs text-muted-foreground font-normal">· {r.staff_count} staff</span></div>
                    <div className="text-xs text-muted-foreground">{r.conversion_rate}% rate</div>
                  </div>
                  <div className="space-y-1.5">
                    <div>
                      <div className="flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-0.5">
                        <span>Quotes won</span>
                        <span className="text-amber-700 dark:text-amber-300 tabular-nums">{r.quotes_converted}</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-amber-500 transition-all" style={{ width: `${convPct}%` }} />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-[10px] uppercase tracking-wider text-muted-foreground font-bold mb-0.5">
                        <span>Special-Order sales</span>
                        <span className="text-yellow-700 dark:text-yellow-300 tabular-nums">£{Number(r.sales_value_gbp).toLocaleString('en-GB', { maximumFractionDigits: 0 })}</span>
                      </div>
                      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                        <div className="h-full bg-yellow-500 transition-all" style={{ width: `${salesPct}%` }} />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

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
        </Card>
      )}

      <div className="text-xs text-muted-foreground text-center">
        <Clock className="w-3 h-3 inline mr-1" />
        Showing {total_staff} staff across all showrooms · auto-refresh every 60 s
      </div>
    </div>
  );
}
