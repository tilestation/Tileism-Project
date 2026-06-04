/**
 * StarStaffPage — full leaderboard + monthly competition control
 * panel, including target setter + optional cash bonus tracker.
 *
 * Built 3 Jun 2026 in response to the user request stack:
 *   2. Show top-converting staff prominently with 👏 applause
 *   3. Showroom + company leaderboard
 *   4. Monthly competition (top-3 emojis + targets + optional cash)
 *   + Daily-streak tracking
 *   + Per-staff conversion rate vs personal avg
 *
 * Per user clarification 3 Jun 2026:
 *   - Show ALL staff 1..N (no Top-5 cutoff)
 *   - Sales = invoices with order_type = "Special Order" ONLY
 *     (tiles, bathroom, flooring, underfloor heating)
 *   - "Store Order" (material/tools) EXCLUDED
 *   - Quote attribution: CREATOR wins on conversion
 *   - Bonus: optional, admin-set
 */
import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import {
  Crown, Trophy, Target, Flame, TrendingUp, Award,
  PoundSterling, Save, RefreshCw, Star,
} from 'lucide-react';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Button } from '../../components/ui/button';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
const tokenHdr = () => {
  const t = localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
};

const MEDAL_BY_RANK = { 0: '👑', 1: '🥈', 2: '🥉' };

export default function StarStaffPage() {
  const [board, setBoard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [targetValue, setTargetValue] = useState('');
  const [targetMetric, setTargetMetric] = useState('conversions');
  const [savingTarget, setSavingTarget] = useState(false);
  const [bonusForm, setBonusForm] = useState({ user_key: '', name: '', amount_gbp: '', note: '' });
  const [savingBonus, setSavingBonus] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await axios.get(`${API}/staff-leaderboard/full`, { headers: tokenHdr() });
      setBoard(r.data);
      const tt = r.data?.team_target?.value;
      if (tt !== undefined && tt !== null) setTargetValue(String(tt));
      if (r.data?.team_target?.metric) setTargetMetric(r.data.team_target.metric);
    } catch (e) {
      toast.error(`Couldn't load leaderboard: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const saveTarget = async () => {
    setSavingTarget(true);
    try {
      const value = targetValue === '' ? null : Number(targetValue);
      await axios.post(
        `${API}/staff-leaderboard/target`,
        { metric: targetMetric, team_target: value },
        { headers: tokenHdr() },
      );
      toast.success('Monthly target saved');
      await refresh();
    } catch (e) {
      toast.error(`Couldn't save target: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setSavingTarget(false);
    }
  };

  const recordBonus = async () => {
    if (!bonusForm.user_key || !bonusForm.amount_gbp) {
      toast.error('Pick a staff member and enter a bonus amount.');
      return;
    }
    setSavingBonus(true);
    try {
      await axios.post(
        `${API}/staff-leaderboard/bonus`,
        {
          user_key: bonusForm.user_key,
          name: bonusForm.name || undefined,
          amount_gbp: Number(bonusForm.amount_gbp),
          note: bonusForm.note || undefined,
        },
        { headers: tokenHdr() },
      );
      toast.success(`Bonus recorded for ${bonusForm.name || bonusForm.user_key}`);
      setBonusForm({ user_key: '', name: '', amount_gbp: '', note: '' });
      await refresh();
    } catch (e) {
      toast.error(`Couldn't record bonus: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setSavingBonus(false);
    }
  };

  // Sort by conversions (primary) — the backend already does this,
  // but we also build a sales-sorted view for the second leaderboard.
  const salesSorted = useMemo(() => {
    if (!board?.staff) return [];
    return [...board.staff].sort((a, b) => b.sales_value_gbp - a.sales_value_gbp);
  }, [board]);

  if (loading) {
    return (
      <div className="p-6 text-center text-muted-foreground" data-testid="star-staff-loading">
        Loading leaderboard…
      </div>
    );
  }
  if (!board) {
    return (
      <div className="p-6 text-center text-rose-500" data-testid="star-staff-error">
        Couldn't load the leaderboard. Try refreshing.
      </div>
    );
  }

  const { month, staff, showroom_leaders, team_target = {}, bonuses = {} } = board;
  const targetCount = team_target?.value || null;

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-7xl mx-auto" data-testid="star-staff-page">
      {/* Hero — top-3 podium */}
      <Card className="p-5 bg-gradient-to-br from-amber-100 to-amber-50 dark:from-amber-950/80 dark:via-emerald-950/70 dark:to-slate-900 border-amber-300 dark:border-amber-500/30">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-2 text-amber-700 dark:text-amber-300 text-[11px] uppercase tracking-[0.25em] font-bold">
              <Star className="w-4 h-4" />
              Star staff · {month}
            </div>
            <h1 className="text-2xl md:text-3xl font-extrabold text-amber-900 dark:text-amber-100 mt-1">
              Quote-conversion & Special-Order sales champions
            </h1>
            <p className="text-xs text-amber-800/70 dark:text-amber-200/70 mt-1.5 max-w-2xl">
              Quote winner = the staff member who <strong>created</strong> the quote (regardless of who converted it).
              Sales rank counts <strong>Special-Order invoices only</strong> (tiles, bathroom, flooring, underfloor heating).
              Store-order material/tools are excluded.
            </p>
          </div>
          <Button onClick={refresh} variant="outline" size="sm" data-testid="star-staff-refresh">
            <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Refresh
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-5">
          {staff.slice(0, 3).map((s, idx) => (
            <Card
              key={`${s.user_id || s.name}-${idx}`}
              data-testid={`star-staff-podium-${idx}`}
              className={`p-4 border-2 ${
                idx === 0 ? 'border-amber-400 bg-amber-500/10' :
                idx === 1 ? 'border-slate-300/40 bg-slate-300/5' :
                'border-orange-400/40 bg-orange-500/10'
              }`}
            >
              <div className="text-3xl">{MEDAL_BY_RANK[idx]}</div>
              <div className="text-xl font-extrabold text-foreground mt-1">{s.name}</div>
              <div className="text-xs text-muted-foreground">{s.showroom_name}</div>
              <div className="mt-3 flex items-baseline gap-1.5">
                <span className="text-3xl font-extrabold text-amber-700 dark:text-amber-300 tabular-nums">{s.quotes_converted}</span>
                <span className="text-xs text-muted-foreground">quotes won</span>
              </div>
              {s.conversion_rate > 0 && (
                <div className="text-xs text-emerald-700 dark:text-emerald-300 font-bold mt-1">
                  {s.conversion_rate}% conversion rate
                  {s.rate_vs_avg_delta !== null && s.rate_vs_avg_delta !== undefined && (
                    <span className={s.rate_vs_avg_delta >= 0 ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300'}>
                      {' '}({s.rate_vs_avg_delta >= 0 ? '+' : ''}{s.rate_vs_avg_delta}% vs avg)
                    </span>
                  )}
                </div>
              )}
              {s.streak_days >= 2 && (
                <div className="text-xs text-orange-700 dark:text-orange-300 font-bold mt-1 flex items-center gap-1">
                  <Flame className="w-3 h-3" />
                  {s.streak_days}-day streak
                </div>
              )}
              {idx === 0 && (
                <div className="mt-2 text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-300 font-bold">
                  👏 Hand of applause
                </div>
              )}
            </Card>
          ))}
          {staff.length === 0 && (
            <div className="md:col-span-3 text-center py-8 text-muted-foreground" data-testid="star-staff-empty">
              No quote conversions yet this month. The first converter gets the crown 👑
            </div>
          )}
        </div>
      </Card>

      {/* Monthly target panel */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Target className="w-4 h-4 text-emerald-500" />
          <h2 className="font-bold text-foreground">Monthly team target</h2>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <label htmlFor="target-metric" className="text-xs text-muted-foreground">Metric</label>
            <select
              id="target-metric"
              value={targetMetric}
              onChange={(e) => setTargetMetric(e.target.value)}
              data-testid="star-staff-target-metric"
              className="bg-background border border-input rounded px-2 py-1.5 text-sm"
            >
              <option value="conversions">Quote conversions (count)</option>
              <option value="sales_gbp">Special-Order sales (£)</option>
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="target-value" className="text-xs text-muted-foreground">
              Target {targetMetric === 'sales_gbp' ? '(£)' : '(count)'}
            </label>
            <Input
              id="target-value"
              type="number"
              min="0"
              step={targetMetric === 'sales_gbp' ? 100 : 1}
              value={targetValue}
              onChange={(e) => setTargetValue(e.target.value)}
              placeholder={targetMetric === 'sales_gbp' ? '50000' : '30'}
              className="w-32"
              data-testid="star-staff-target-value"
            />
          </div>
          <Button
            onClick={saveTarget}
            disabled={savingTarget}
            data-testid="star-staff-target-save"
          >
            <Save className="w-3.5 h-3.5 mr-1.5" />
            {savingTarget ? 'Saving…' : 'Save target'}
          </Button>
          {team_target?.value !== undefined && team_target?.value !== null && (
            <div className="text-xs text-muted-foreground">
              Current: <span className="font-bold text-emerald-500">
                {team_target.metric === 'sales_gbp' ? `£${Number(team_target.value).toLocaleString('en-GB')}` : team_target.value}
              </span>{' '}({team_target.metric === 'sales_gbp' ? 'sales' : 'conversions'})
            </div>
          )}
        </div>
      </Card>

      {/* Dual leaderboards: conversions + sales */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Crown className="w-4 h-4 text-amber-400" />
            <h2 className="font-bold text-foreground">Quote conversions — {month}</h2>
          </div>
          <table className="w-full text-sm" data-testid="leaderboard-conversions-table">
            <thead className="text-xs text-muted-foreground uppercase tracking-wider">
              <tr><th className="text-left py-1.5">#</th><th className="text-left">Staff</th><th className="text-left">Showroom</th><th className="text-right">Won</th><th className="text-right">Rate</th><th className="text-right">Streak</th><th className="text-right">vs Avg</th></tr>
            </thead>
            <tbody>
              {staff.map((s, idx) => (
                <tr
                  key={`conv-${s.user_id || s.name}-${idx}`}
                  data-testid={`leaderboard-conv-row-${idx}`}
                  className="border-t border-border/40 hover:bg-muted/30"
                >
                  <td className="py-1.5 font-mono font-bold w-8">
                    {idx < 3 ? MEDAL_BY_RANK[idx] : idx + 1}
                  </td>
                  <td className="font-bold text-foreground">{s.name}</td>
                  <td className="text-muted-foreground text-xs">{s.showroom_name}</td>
                  <td className="text-right font-bold text-amber-500 tabular-nums">{s.quotes_converted}</td>
                  <td className="text-right tabular-nums text-emerald-500">{s.conversion_rate > 0 ? `${s.conversion_rate}%` : '—'}</td>
                  <td className="text-right tabular-nums">
                    {s.streak_days >= 2 ? (
                      <span className="text-orange-400 inline-flex items-center gap-0.5">
                        <Flame className="w-3 h-3" />{s.streak_days}d
                      </span>
                    ) : '—'}
                  </td>
                  <td className="text-right tabular-nums text-xs">
                    {s.rate_vs_avg_delta === null || s.rate_vs_avg_delta === undefined ? '—' : (
                      <span className={s.rate_vs_avg_delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                        {s.rate_vs_avg_delta >= 0 ? '+' : ''}{s.rate_vs_avg_delta}%
                        {s.rate_vs_avg_delta >= 0 ? ' 📈' : ' 📉'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Trophy className="w-4 h-4 text-yellow-400" />
            <h2 className="font-bold text-foreground">Special-Order sales — {month}</h2>
            <span className="text-[10px] text-muted-foreground">(tiles · bathroom · flooring · UFH)</span>
          </div>
          <table className="w-full text-sm" data-testid="leaderboard-sales-table">
            <thead className="text-xs text-muted-foreground uppercase tracking-wider">
              <tr><th className="text-left py-1.5">#</th><th className="text-left">Staff</th><th className="text-left">Showroom</th><th className="text-right">£ Sold</th><th className="text-right">Invoices</th></tr>
            </thead>
            <tbody>
              {salesSorted.map((s, idx) => (
                <tr
                  key={`sales-${s.user_id || s.name}-${idx}`}
                  data-testid={`leaderboard-sales-row-${idx}`}
                  className="border-t border-border/40 hover:bg-muted/30"
                >
                  <td className="py-1.5 font-mono font-bold w-8">
                    {idx < 3 ? MEDAL_BY_RANK[idx] : idx + 1}
                  </td>
                  <td className="font-bold text-foreground">{s.name}</td>
                  <td className="text-muted-foreground text-xs">{s.showroom_name}</td>
                  <td className="text-right font-bold text-yellow-500 tabular-nums">
                    £{s.sales_value_gbp.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                  </td>
                  <td className="text-right tabular-nums">{s.sales_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      {/* Showroom leaders */}
      {Object.keys(showroom_leaders || {}).length > 0 && (
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Award className="w-4 h-4 text-rose-400" />
            <h2 className="font-bold text-foreground">Per-showroom leaders</h2>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {Object.entries(showroom_leaders).map(([showroom, leader]) => (
              <div
                key={showroom}
                data-testid={`showroom-leader-${showroom}`}
                className="p-3 rounded-lg border border-border bg-muted/30"
              >
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold">{showroom}</div>
                <div className="text-sm font-bold text-foreground mt-0.5 flex items-center gap-1">
                  <Crown className="w-3 h-3 text-amber-400" /> {leader.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {leader.quotes_converted} won · £{leader.sales_value_gbp.toLocaleString('en-GB', { maximumFractionDigits: 0 })}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Optional cash bonus tracker */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <PoundSterling className="w-4 h-4 text-emerald-500" />
          <h2 className="font-bold text-foreground">Cash bonus (optional)</h2>
          <span className="text-[10px] text-muted-foreground">(record-only — payroll integration later)</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-2 items-end">
          <div className="space-y-1 md:col-span-2">
            <label htmlFor="bonus-staff" className="text-xs text-muted-foreground">Staff member</label>
            <select
              id="bonus-staff"
              value={bonusForm.user_key}
              onChange={(e) => {
                const key = e.target.value;
                const found = staff.find((s) => (s.user_id || `name:${s.name.toLowerCase()}`) === key);
                setBonusForm((f) => ({ ...f, user_key: key, name: found?.name || '' }));
              }}
              data-testid="star-staff-bonus-user"
              className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm"
            >
              <option value="">-- choose --</option>
              {staff.map((s, idx) => {
                const key = s.user_id || `name:${s.name.toLowerCase()}`;
                return (
                  <option key={`bonus-opt-${idx}`} value={key}>
                    {s.name} ({s.showroom_name}) · {s.quotes_converted} won
                  </option>
                );
              })}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="bonus-amount" className="text-xs text-muted-foreground">Amount (£)</label>
            <Input
              id="bonus-amount"
              type="number"
              min="0"
              step="10"
              value={bonusForm.amount_gbp}
              onChange={(e) => setBonusForm((f) => ({ ...f, amount_gbp: e.target.value }))}
              placeholder="100"
              data-testid="star-staff-bonus-amount"
            />
          </div>
          <div className="space-y-1 md:col-span-1">
            <label htmlFor="bonus-note" className="text-xs text-muted-foreground">Note (optional)</label>
            <Input
              id="bonus-note"
              type="text"
              value={bonusForm.note}
              onChange={(e) => setBonusForm((f) => ({ ...f, note: e.target.value }))}
              placeholder="June champion"
              maxLength={200}
              data-testid="star-staff-bonus-note"
            />
          </div>
          <Button
            onClick={recordBonus}
            disabled={savingBonus || !bonusForm.user_key || !bonusForm.amount_gbp}
            data-testid="star-staff-bonus-save"
          >
            {savingBonus ? 'Saving…' : 'Record bonus'}
          </Button>
        </div>
        {Object.keys(bonuses).length > 0 && (
          <div className="mt-3 pt-3 border-t border-border/40">
            <div className="text-xs uppercase tracking-wider text-muted-foreground font-bold mb-2">
              Bonuses recorded this month
            </div>
            <div className="space-y-1">
              {Object.entries(bonuses).map(([k, b]) => (
                <div
                  key={k}
                  data-testid={`star-staff-bonus-entry-${k}`}
                  className="flex items-center justify-between text-sm py-1"
                >
                  <div>
                    <span className="font-bold">{b.name || k}</span>
                    {b.note && <span className="text-xs text-muted-foreground ml-2">· {b.note}</span>}
                  </div>
                  <div className="font-bold text-emerald-500 tabular-nums">£{Number(b.amount_gbp).toLocaleString('en-GB')}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* Target progress for each staff (if target set) */}
      {targetCount && (
        <Card className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-4 h-4 text-fuchsia-500" />
            <h2 className="font-bold text-foreground">Progress vs {team_target.metric === 'sales_gbp' ? '£' : ''}{Number(targetCount).toLocaleString('en-GB')} {team_target.metric === 'sales_gbp' ? 'sales target' : 'conversion target'}</h2>
          </div>
          <div className="space-y-2">
            {staff.map((s, idx) => {
              const current = team_target.metric === 'sales_gbp' ? s.sales_value_gbp : s.quotes_converted;
              const pct = Math.min(100, Math.round((current / targetCount) * 100));
              return (
                <div key={`progress-${s.user_id || s.name}-${idx}`} data-testid={`progress-row-${idx}`}>
                  <div className="flex items-center justify-between text-xs mb-0.5">
                    <span className="font-semibold">{s.name}</span>
                    <span className={pct >= 100 ? 'text-emerald-500 font-bold' : 'text-muted-foreground'}>
                      {team_target.metric === 'sales_gbp' ? '£' : ''}{Number(current).toLocaleString('en-GB')} · {pct}%
                      {pct >= 100 && ' ✓'}
                    </span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full ${pct >= 100 ? 'bg-emerald-500' : 'bg-fuchsia-500'} transition-all`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
