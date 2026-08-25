/**
 * BulkAIDescriptionsModal — generate SEO-friendly descriptions for selected
 * products. Two scopes:
 *  - series (default): ONE unified description per series covering every
 *    colour/size (POST /api/products/generate-series-description), written to
 *    ALL products in that series so the PDP never calls out a single size.
 *  - product: one description per product (POST /api/products/generate-description).
 * Writes results back via `bulk-update-unified` (verified saves).
 */

import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Sparkles, RefreshCw, CheckCircle, AlertCircle, X, Layers, Box } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const MODES = [
  { key: 'generate', label: 'Fresh (default)', hint: 'Ignore existing description and write new' },
  { key: 'regenerate', label: 'Regenerate variant', hint: 'A different angle from what\'s currently saved' },
  { key: 'shorter', label: 'Shorter', hint: 'Trim the existing description' },
  { key: 'longer', label: 'Longer', hint: 'Expand the existing description' },
];

const getSeriesOf = (p) =>
  String(p.series || p.range_name || p.series_name || '').trim();

const BulkAIDescriptionsModal = ({ open, onOpenChange, selectedList = [], onSuccess, themeColor = 'orange' }) => {
  const [scope, setScope] = useState('series');
  const [mode, setMode] = useState('generate');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, success: 0, failed: 0, productsWritten: 0 });
  const [currentLabel, setCurrentLabel] = useState('');
  const [errors, setErrors] = useState([]);   // [{sku, message}]
  const [cancelled, setCancelled] = useState(false);

  const themeBtn = {
    orange: 'bg-orange-600 hover:bg-orange-700 text-white',
    blue:   'bg-blue-600   hover:bg-blue-700   text-white',
    purple: 'bg-purple-600 hover:bg-purple-700 text-white',
    slate:  'bg-slate-700  hover:bg-slate-800  text-white',
  }[themeColor] || 'bg-orange-600 hover:bg-orange-700 text-white';

  // Preview how the selection groups by series
  const seriesPreview = useMemo(() => {
    const bySeries = new Map();
    let loose = 0;
    for (const p of selectedList) {
      const s = getSeriesOf(p);
      if (s) bySeries.set(s, (bySeries.get(s) || 0) + 1);
      else loose += 1;
    }
    return { groups: [...bySeries.entries()], loose };
  }, [selectedList]);

  const saveDescription = async (items, desc) => {
    // bulk-update-unified takes one id_field for the whole call — split by field
    const bySku = items.filter(p => p.sku).map(p => p.sku);
    const byCode = items.filter(p => !p.sku && p.supplier_code).map(p => p.supplier_code);
    let written = 0;
    for (const [ids, idField] of [[bySku, 'sku'], [byCode, 'supplier_code']]) {
      if (ids.length === 0) continue;
      const saveRes = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product_ids: ids, id_field: idField, updates: { description: desc }, mode: 'replace' }),
      });
      if (!saveRes.ok) throw new Error(`Save HTTP ${saveRes.status}`);
      const saveData = await saveRes.json();
      if (Array.isArray(saveData.verification_failures) && saveData.verification_failures.length > 0) {
        throw new Error('Verification failed (description didn\'t stick)');
      }
      written += ids.length;
    }
    return written;
  };

  const run = async () => {
    if (selectedList.length === 0) return;
    setRunning(true);
    setCancelled(false);
    setErrors([]);

    const token = localStorage.getItem('token');
    const authHeaders = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    // Build jobs: one per series group (+ one per loose product), or one per product
    let jobs;
    if (scope === 'series') {
      const bySeries = new Map();
      const loose = [];
      for (const p of selectedList) {
        const s = getSeriesOf(p);
        if (s) {
          if (!bySeries.has(s)) bySeries.set(s, []);
          bySeries.get(s).push(p);
        } else loose.push(p);
      }
      jobs = [
        ...[...bySeries.entries()].map(([s, items]) => ({ type: 'series', series: s, items })),
        ...loose.map(p => ({ type: 'product', items: [p] })),
      ];
    } else {
      jobs = selectedList.map(p => ({ type: 'product', items: [p] }));
    }

    setProgress({ current: 0, total: jobs.length, success: 0, failed: 0, productsWritten: 0 });

    let success = 0, failed = 0, productsWritten = 0;

    for (let i = 0; i < jobs.length; i++) {
      if (cancelled) break;
      const job = jobs[i];
      const label = job.type === 'series'
        ? `${job.series} (${job.items.length} products)`
        : (job.items[0].product_name || job.items[0].display_name || job.items[0].sku || 'product');
      setCurrentLabel(label);
      setProgress(pr => ({ ...pr, current: i + 1 }));

      try {
        let desc = '';
        if (job.type === 'series') {
          const skus = job.items.map(p => p.sku || p.supplier_code).filter(Boolean);
          const genRes = await fetch(`${API_URL}/api/products/generate-series-description`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
              series_name: job.series,
              product_skus: skus,
              seo_keywords: [...new Set(job.items.flatMap(p => p.sub_categories || []))].join(', '),
            }),
          });
          if (!genRes.ok) {
            const err = await genRes.json().catch(() => ({}));
            throw new Error(err.detail || `AI HTTP ${genRes.status}`);
          }
          const gen = await genRes.json();
          desc = gen.description || '';
        } else {
          const p = job.items[0];
          const genRes = await fetch(`${API_URL}/api/products/generate-description`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
              name: p.product_name || p.display_name || p.our_product_name || p.name || p.sku,
              category: p.main_category || '',
              material: p.material || '',
              finish: p.finish || '',
              size: p.size || '',
              colors: p.colors || (p.color ? [p.color] : []),
              suitability: p.suitability || '',
              slip_rating: p.slip_rating || '',
              seo_keywords: (p.sub_categories || []).join(', '),
              current_description: p.description || '',
              mode,
            }),
          });
          if (!genRes.ok) {
            const err = await genRes.json().catch(() => ({}));
            throw new Error(err.detail || `AI HTTP ${genRes.status}`);
          }
          const gen = await genRes.json();
          desc = gen.description || gen.text || gen.result || '';
        }
        if (!desc || desc.trim().length < 10) throw new Error('AI returned empty description');

        const written = await saveDescription(job.items, desc);
        productsWritten += written;
        success += 1;
        setProgress(pr => ({ ...pr, success: pr.success + 1, productsWritten: pr.productsWritten + written }));
      } catch (err) {
        failed += 1;
        setProgress(pr => ({ ...pr, failed: pr.failed + 1 }));
        setErrors(e => [...e, { sku: job.type === 'series' ? job.series : (job.items[0].sku || job.items[0].supplier_code), message: String(err.message) }]);
      }
    }

    setRunning(false);
    setCurrentLabel('');
    if (!cancelled) {
      toast.success(`Descriptions written to ${productsWritten} product(s) — ${success} generated, ${failed} failed`);
      if (onSuccess) onSuccess();
    }
  };

  const percent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!running) onOpenChange(o); }}>
      <DialogContent className="max-w-lg" data-testid="bulk-ai-descriptions-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-purple-600" />
            AI Descriptions for {selectedList.length} product(s)
          </DialogTitle>
          <p className="text-xs text-gray-500">
            Uses the built-in AI generator (via Emergent LLM key) to write SEO-friendly descriptions. Each save is verified.
          </p>
        </DialogHeader>

        {!running && progress.current === 0 && (
          <div className="space-y-3">
            {/* Scope: whole series vs per product */}
            <div className="space-y-2">
              <label className="block text-xs font-medium text-gray-700">Write descriptions for</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setScope('series')}
                  className={`text-left p-2 border rounded-lg text-sm transition ${
                    scope === 'series' ? 'border-purple-500 bg-purple-50' : 'border-gray-200 hover:border-gray-300'
                  }`}
                  data-testid="bulk-ai-scope-series"
                >
                  <div className="font-medium text-gray-800 flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5" /> Whole series (recommended)
                  </div>
                  <div className="text-[10px] text-gray-500 mt-0.5">
                    ONE description covering every colour &amp; size, saved to all products in the series — never calls out a single size
                  </div>
                </button>
                <button
                  onClick={() => setScope('product')}
                  className={`text-left p-2 border rounded-lg text-sm transition ${
                    scope === 'product' ? 'border-purple-500 bg-purple-50' : 'border-gray-200 hover:border-gray-300'
                  }`}
                  data-testid="bulk-ai-scope-product"
                >
                  <div className="font-medium text-gray-800 flex items-center gap-1.5">
                    <Box className="w-3.5 h-3.5" /> Each product
                  </div>
                  <div className="text-[10px] text-gray-500 mt-0.5">
                    A unique description per product, mentioning its exact size/colour
                  </div>
                </button>
              </div>
              {scope === 'series' && (
                <div className="text-[11px] text-gray-600 bg-purple-50/60 border border-purple-100 rounded p-2" data-testid="bulk-ai-series-preview">
                  {seriesPreview.groups.length > 0 ? (
                    <>
                      {seriesPreview.groups.map(([s, n]) => (
                        <div key={s}><span className="font-medium">{s}</span> — 1 description shared by {n} product(s)</div>
                      ))}
                      {seriesPreview.loose > 0 && (
                        <div>{seriesPreview.loose} product(s) without a series — individual descriptions</div>
                      )}
                    </>
                  ) : (
                    <div>No series found on the selection — all {selectedList.length} will get individual descriptions</div>
                  )}
                </div>
              )}
            </div>

            {scope === 'product' && (
              <div className="space-y-2">
                <label className="block text-xs font-medium text-gray-700">Mode</label>
                <div className="grid grid-cols-2 gap-2">
                  {MODES.map(m => (
                    <button
                      key={m.key}
                      onClick={() => setMode(m.key)}
                      className={`text-left p-2 border rounded-lg text-sm transition ${
                        mode === m.key ? 'border-purple-500 bg-purple-50' : 'border-gray-200 hover:border-gray-300'
                      }`}
                      data-testid={`bulk-ai-mode-${m.key}`}
                    >
                      <div className="font-medium text-gray-800">{m.label}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">{m.hint}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {(running || progress.current > 0) && (
          <div className="space-y-3">
            {/* Progress bar */}
            <div>
              <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                <span className="truncate pr-2">{running && currentLabel ? `Writing: ${currentLabel}` : 'Progress'}</span>
                <span className="flex-shrink-0">{progress.current} / {progress.total}  ({percent}%)</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="h-2 bg-purple-600 rounded-full transition-all"
                  style={{ width: `${percent}%` }}
                  data-testid="bulk-ai-progress-bar"
                />
              </div>
            </div>
            {/* Stats */}
            <div className="flex items-center gap-4 text-sm">
              <span className="flex items-center gap-1 text-emerald-700">
                <CheckCircle className="w-3.5 h-3.5" /> {progress.success} success
              </span>
              <span className="flex items-center gap-1 text-red-600">
                <AlertCircle className="w-3.5 h-3.5" /> {progress.failed} failed
              </span>
              {progress.productsWritten > 0 && (
                <span className="text-gray-500 text-xs">{progress.productsWritten} product(s) updated</span>
              )}
            </div>
            {/* Errors */}
            {errors.length > 0 && (
              <div className="max-h-32 overflow-y-auto border border-red-100 rounded p-2 text-[11px] bg-red-50">
                {errors.map((e, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="font-mono text-red-800 flex-shrink-0">{e.sku}</span>
                    <span className="text-red-700 truncate">{e.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {running ? (
            <Button variant="outline" onClick={() => setCancelled(true)}>
              <X className="w-4 h-4 mr-1" /> Cancel remaining
            </Button>
          ) : progress.current > 0 ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={run} className={themeBtn} data-testid="bulk-ai-start">
                <Sparkles className="w-4 h-4 mr-1" /> Generate
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default BulkAIDescriptionsModal;
