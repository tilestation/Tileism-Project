/**
 * DataHygiene — admin maintenance dashboard (8 Jun 2026).
 *
 * Surfaces and fixes data drift that quietly poisons cross-store
 * reporting:
 *   1. Drifted labels       — same showroom_id, different stamped
 *                             showroom_name strings ("Tile Station
 *                             Tonbridge" vs "Tonbridge")
 *   2. Orphan showroom_name — name without an id
 *   3. Unmapped showroom_id — id pointing at a deleted showroom
 *   4. Near-duplicate showrooms — two showroom docs whose names
 *                                 normalise to the same key
 *
 * Super-admin only.
 */
import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import {
  AlertTriangle, CheckCircle2, RefreshCw, Wand2, Database, Building2,
} from 'lucide-react';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
const tokenHdr = () => {
  const t = localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
};

export default function DataHygiene() {
  const [scan, setScan] = useState(null);
  const [showrooms, setShowrooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fixing, setFixing] = useState(false);
  // Per-row picked target showroom_id, keyed by `${collection}:${record_id}`.
  const [picks, setPicks] = useState({});

  const refresh = async () => {
    setLoading(true);
    try {
      const [scanRes, srRes] = await Promise.all([
        axios.get(`${API}/admin/data-hygiene/scan`, { headers: tokenHdr() }),
        axios.get(`${API}/showrooms`, { headers: tokenHdr() }),
      ]);
      setScan(scanRes.data);
      // Sort showrooms alphabetically for the dropdown.
      const list = (srRes.data || []).slice().sort((a, b) =>
        (a.name || '').localeCompare(b.name || '')
      );
      setShowrooms(list);
    } catch (e) {
      toast.error(`Couldn't run hygiene scan: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const reassign = async (issueType, item) => {
    const key = `${item.collection}:${item.record_id}`;
    const targetId = picks[key];
    if (!targetId) {
      toast.error('Pick a target store first.');
      return;
    }
    const targetName = showrooms.find((s) => s.id === targetId)?.name || targetId;
    if (!window.confirm(`Re-assign this ${item.collection} record to "${targetName}"?`)) return;
    setFixing(true);
    try {
      const r = await axios.post(
        `${API}/admin/data-hygiene/fix`,
        {
          issue_type: issueType,
          scope: 'one',
          collection: item.collection,
          record_ids: [item.record_id],
          target_showroom_id: targetId,
        },
        { headers: tokenHdr() }
      );
      toast.success(`Re-assigned ${r.data?.modified || 0} record to "${targetName}"`);
      // Clear this pick + refresh
      setPicks((p) => {
        const next = { ...p };
        delete next[key];
        return next;
      });
      await refresh();
    } catch (e) {
      toast.error(`Re-assign failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setFixing(false);
    }
  };

  const fixGroup = async (group) => {
    if (!window.confirm(
      `Rename ${group.records.length} record(s) at "${group.stamped_name}" → "${group.canonical_name}"?\n\n` +
      `Affects: ${[...new Set(group.records.map((r) => r.collection))].join(', ')}`
    )) return;
    setFixing(true);
    try {
      // Backend fixes one collection at a time, so split the records by collection.
      const byColl = group.records.reduce((acc, r) => {
        (acc[r.collection] = acc[r.collection] || []).push(r.record_id);
        return acc;
      }, {});
      let totalModified = 0;
      for (const [collection, ids] of Object.entries(byColl)) {
        const r = await axios.post(
          `${API}/admin/data-hygiene/fix`,
          {
            issue_type: 'drifted_labels',
            scope: 'one',
            collection,
            showroom_id: group.showroom_id,
            stamped_name: group.stamped_name,
            record_ids: ids,
          },
          { headers: tokenHdr() }
        );
        totalModified += r.data?.modified || 0;
      }
      toast.success(`Renamed ${totalModified} record(s) to "${group.canonical_name}"`);
      await refresh();
    } catch (e) {
      toast.error(`Fix failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setFixing(false);
    }
  };

  const fixOne = async (item) => {
    if (!window.confirm(`Rename this ${item.collection} record from "${item.stamped_name}" → "${item.canonical_name}"?`)) return;
    setFixing(true);
    try {
      const r = await axios.post(
        `${API}/admin/data-hygiene/fix`,
        {
          issue_type: 'drifted_labels',
          scope: 'one',
          collection: item.collection,
          showroom_id: item.showroom_id,
          record_ids: [item.record_id],
        },
        { headers: tokenHdr() }
      );
      toast.success(`Renamed ${r.data?.modified || 0} record to "${item.canonical_name}"`);
      await refresh();
    } catch (e) {
      toast.error(`Fix failed: ${e?.response?.data?.detail || e.message}`);
    } finally {
      setFixing(false);
    }
  };

  const totals = scan?.summary || {};
  const allClean = useMemo(() => {
    if (!totals) return false;
    return (totals.drifted_labels || 0) === 0
      && (totals.orphan_showroom_name || 0) === 0
      && (totals.unmapped_showroom_id || 0) === 0
      && (totals.near_duplicate_showrooms || 0) === 0;
  }, [totals]);

  if (loading) {
    return <div className="p-6 text-muted-foreground" data-testid="data-hygiene-loading">Running hygiene scan…</div>;
  }

  return (
    <div className="p-6 space-y-6" data-testid="data-hygiene-page">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Database className="w-7 h-7" /> Data Hygiene
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Catches drift in showroom labels across users, quotes &amp; invoices
            — the kind that splits one Tonbridge store into two leaderboard
            rows. Fix once here, every report stays clean forever after.
          </p>
        </div>
        <Button onClick={refresh} variant="outline" size="sm" data-testid="data-hygiene-refresh-btn">
          <RefreshCw className="w-4 h-4 mr-2" /> Re-scan
        </Button>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryTile label="Drifted labels" value={totals.drifted_labels} testId="tile-drifted" />
        <SummaryTile label="Orphan names" value={totals.orphan_showroom_name} testId="tile-orphan" />
        <SummaryTile label="Unmapped IDs" value={totals.unmapped_showroom_id} testId="tile-unmapped" />
        <SummaryTile label="Duplicate stores" value={totals.near_duplicate_showrooms} testId="tile-dupes" />
      </div>

      {allClean && (
        <Card className="p-6 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 flex items-center gap-3" data-testid="all-clean-banner">
          <CheckCircle2 className="w-8 h-8 text-emerald-600" />
          <div>
            <div className="font-bold text-emerald-900 dark:text-emerald-100">All clean — no drift detected</div>
            <div className="text-sm text-emerald-800/80 dark:text-emerald-200/70">Stamped showroom labels match the canonical store names across every collection.</div>
          </div>
        </Card>
      )}

      {/* Section 1 — Drifted labels (grouped) */}
      {scan?.drifted_groups?.length > 0 && (
        <Card className="p-5" data-testid="drifted-section">
          <h2 className="font-bold text-lg mb-1 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-600" />
            Drifted Labels
            <Badge variant="secondary">{scan.drifted_groups.length} group(s) · {totals.drifted_labels} record(s)</Badge>
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Records stamped with a name that disagrees with the canonical store name. Fix per record or rename the whole group in one click.
          </p>
          <div className="space-y-4">
            {scan.drifted_groups.map((g) => (
              <div key={`${g.showroom_id}|${g.stamped_name}`} className="border rounded-lg p-4 bg-amber-50/40 dark:bg-amber-950/10" data-testid={`drifted-group-${g.showroom_id}`}>
                <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
                  <div className="text-sm">
                    <span className="font-mono bg-rose-100 dark:bg-rose-950/40 px-2 py-0.5 rounded text-rose-900 dark:text-rose-200">{g.stamped_name}</span>
                    <span className="mx-2 text-muted-foreground">→</span>
                    <span className="font-mono bg-emerald-100 dark:bg-emerald-950/40 px-2 py-0.5 rounded text-emerald-900 dark:text-emerald-200">{g.canonical_name}</span>
                    <span className="ml-3 text-xs text-muted-foreground">{g.records.length} record(s)</span>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => fixGroup(g)}
                    disabled={fixing}
                    data-testid={`fix-group-${g.showroom_id}-btn`}
                  >
                    <Wand2 className="w-4 h-4 mr-2" /> Fix all in group
                  </Button>
                </div>
                <div className="text-xs space-y-1 max-h-40 overflow-y-auto">
                  {g.records.map((r) => (
                    <div key={`${r.collection}-${r.record_id}`} className="flex items-center justify-between gap-2 py-1 border-b border-amber-200/30 last:border-0">
                      <span>
                        <Badge variant="outline" className="mr-2">{r.collection}</Badge>
                        <span className="font-mono">{r.label}</span>
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => fixOne({
                          ...r,
                          showroom_id: g.showroom_id,
                          stamped_name: g.stamped_name,
                          canonical_name: g.canonical_name,
                        })}
                        disabled={fixing}
                        data-testid={`fix-one-${r.collection}-${r.record_id}-btn`}
                      >
                        Fix
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Section 2 — Orphan showroom_name */}
      {scan?.orphan_showroom_name?.length > 0 && (
        <Card className="p-5" data-testid="orphan-section">
          <h2 className="font-bold text-lg mb-1 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-orange-600" />
            Orphan Showroom Names
            <Badge variant="secondary">{scan.orphan_showroom_name.length}</Badge>
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Records carrying a `showroom_name` but no `showroom_id` &mdash; can&apos;t be auto-resolved. Pick the correct store from the dropdown and re-assign in one click.
          </p>
          <div className="text-xs max-h-[28rem] overflow-y-auto space-y-1">
            {scan.orphan_showroom_name.slice(0, 200).map((o, i) => {
              const key = `${o.collection}:${o.record_id}`;
              return (
                <div key={`${o.collection}-${o.record_id}-${i}`} className="flex items-center flex-wrap gap-2 py-1.5 border-b last:border-0" data-testid={`orphan-row-${o.collection}-${o.record_id}`}>
                  <Badge variant="outline">{o.collection}</Badge>
                  <span className="font-mono">{o.label}</span>
                  <span className="text-muted-foreground">stamped:</span>
                  <span className="italic">&quot;{o.stamped_name}&quot;</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    <ReassignSelect
                      value={picks[key] || ''}
                      onChange={(v) => setPicks((p) => ({ ...p, [key]: v }))}
                      showrooms={showrooms}
                      testId={`orphan-pick-${o.collection}-${o.record_id}`}
                    />
                    <Button
                      size="sm"
                      onClick={() => reassign('orphan_showroom_name', o)}
                      disabled={fixing || !picks[key]}
                      data-testid={`orphan-reassign-${o.collection}-${o.record_id}-btn`}
                    >
                      Re-assign
                    </Button>
                  </span>
                </div>
              );
            })}
            {scan.orphan_showroom_name.length > 200 && (
              <div className="text-muted-foreground italic pt-2">…and {scan.orphan_showroom_name.length - 200} more.</div>
            )}
          </div>
        </Card>
      )}

      {/* Section 3 — Unmapped showroom_id */}
      {scan?.unmapped_showroom_id?.length > 0 && (
        <Card className="p-5" data-testid="unmapped-section">
          <h2 className="font-bold text-lg mb-1 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-rose-600" />
            Unmapped Showroom IDs
            <Badge variant="secondary">{scan.unmapped_showroom_id.length}</Badge>
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Records pointing at a showroom doc that no longer exists. Pick the correct live store and re-assign &mdash; the stamped name will follow the canonical name.
          </p>
          <div className="text-xs max-h-[28rem] overflow-y-auto space-y-1">
            {scan.unmapped_showroom_id.slice(0, 200).map((u, i) => {
              const key = `${u.collection}:${u.record_id}`;
              // Normalise to the same shape `reassign` expects.
              const row = {
                collection: u.collection,
                record_id: u.record_id,
                stamped_name: u.stamped_showroom_name,
              };
              return (
                <div key={`${u.collection}-${u.record_id}-${i}`} className="flex items-center flex-wrap gap-2 py-1.5 border-b last:border-0" data-testid={`unmapped-row-${u.collection}-${u.record_id}`}>
                  <Badge variant="outline">{u.collection}</Badge>
                  <span className="font-mono">{u.label}</span>
                  <span className="text-muted-foreground">id:</span>
                  <span className="font-mono text-rose-700 dark:text-rose-300">{u.stamped_showroom_id}</span>
                  {u.stamped_showroom_name && (
                    <span className="text-muted-foreground italic">&mdash; stamped &quot;{u.stamped_showroom_name}&quot;</span>
                  )}
                  <span className="ml-auto flex items-center gap-1.5">
                    <ReassignSelect
                      value={picks[key] || ''}
                      onChange={(v) => setPicks((p) => ({ ...p, [key]: v }))}
                      showrooms={showrooms}
                      testId={`unmapped-pick-${u.collection}-${u.record_id}`}
                    />
                    <Button
                      size="sm"
                      onClick={() => reassign('unmapped_showroom_id', row)}
                      disabled={fixing || !picks[key]}
                      data-testid={`unmapped-reassign-${u.collection}-${u.record_id}-btn`}
                    >
                      Re-assign
                    </Button>
                  </span>
                </div>
              );
            })}
            {scan.unmapped_showroom_id.length > 200 && (
              <div className="text-muted-foreground italic pt-2">…and {scan.unmapped_showroom_id.length - 200} more.</div>
            )}
          </div>
        </Card>
      )}

      {/* Section 4 — Near-duplicate showrooms */}
      {scan?.near_duplicate_showrooms?.length > 0 && (
        <Card className="p-5" data-testid="dupes-section">
          <h2 className="font-bold text-lg mb-1 flex items-center gap-2">
            <Building2 className="w-5 h-5 text-blue-600" />
            Possible Duplicate Stores
            <Badge variant="secondary">{scan.near_duplicate_showrooms.length}</Badge>
          </h2>
          <p className="text-sm text-muted-foreground mb-4">
            Showroom docs whose names normalise to the same key (e.g. &quot;Tonbridge&quot; vs &quot;Tile Station Tonbridge&quot;). Merge in <strong>Admin → Stores</strong> if any of these are the same physical location.
          </p>
          <div className="space-y-3">
            {scan.near_duplicate_showrooms.map((d) => (
              <div key={d.normalised_key} className="text-xs flex flex-wrap items-center gap-2 border rounded p-2">
                <span className="text-muted-foreground">Normalised:</span>
                <span className="font-mono">{d.normalised_key}</span>
                <span className="text-muted-foreground">→</span>
                {d.showrooms.map((s) => (
                  <Badge key={s.id} variant="outline" className="font-mono">{s.name}</Badge>
                ))}
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="text-xs text-muted-foreground pt-4 border-t">
        Last scanned: {scan?.scanned_at ? new Date(scan.scanned_at).toLocaleString('en-GB') : '—'}
      </div>
    </div>
  );
}

function SummaryTile({ label, value, testId }) {
  const v = value ?? 0;
  const ok = v === 0;
  return (
    <Card
      className={`p-4 ${ok ? 'border-emerald-200 bg-emerald-50/60 dark:bg-emerald-950/20' : 'border-amber-300 bg-amber-50/60 dark:bg-amber-950/20'}`}
      data-testid={testId}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-2xl font-bold tabular-nums ${ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>
        {v}
      </div>
    </Card>
  );
}

function ReassignSelect({ value, onChange, showrooms, testId }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-xs border rounded px-2 py-1 bg-background"
      data-testid={testId}
    >
      <option value="">Re-assign to…</option>
      {showrooms.map((s) => (
        <option key={s.id} value={s.id}>{s.name}</option>
      ))}
    </select>
  );
}
