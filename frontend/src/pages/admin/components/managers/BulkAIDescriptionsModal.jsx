/**
 * BulkAIDescriptionsModal — generate SEO-friendly product descriptions for
 * every selected product in one background sweep. Uses the existing single
 * `POST /api/products/generate-description` endpoint (which already uses the
 * EMERGENT_LLM_KEY under the hood) and writes results back via `bulk-update-unified`.
 *
 * Progress bar shows current-of-total with success + failure counts. Fires
 * one request per product to avoid a giant single-call prompt.
 */

import React, { useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Sparkles, RefreshCw, CheckCircle, AlertCircle, X } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const MODES = [
  { key: 'generate', label: 'Fresh (default)', hint: 'Ignore existing description and write new' },
  { key: 'regenerate', label: 'Regenerate variant', hint: 'A different angle from what\'s currently saved' },
  { key: 'shorter', label: 'Shorter', hint: 'Trim the existing description' },
  { key: 'longer', label: 'Longer', hint: 'Expand the existing description' },
];

const BulkAIDescriptionsModal = ({ open, onOpenChange, selectedList = [], onSuccess, themeColor = 'orange' }) => {
  const [mode, setMode] = useState('generate');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, success: 0, failed: 0 });
  const [errors, setErrors] = useState([]);   // [{sku, message}]
  const [cancelled, setCancelled] = useState(false);

  const themeBtn = {
    orange: 'bg-orange-600 hover:bg-orange-700 text-white',
    blue:   'bg-blue-600   hover:bg-blue-700   text-white',
    purple: 'bg-purple-600 hover:bg-purple-700 text-white',
    slate:  'bg-slate-700  hover:bg-slate-800  text-white',
  }[themeColor] || 'bg-orange-600 hover:bg-orange-700 text-white';

  const run = async () => {
    if (selectedList.length === 0) return;
    setRunning(true);
    setCancelled(false);
    setErrors([]);
    setProgress({ current: 0, total: selectedList.length, success: 0, failed: 0 });

    const token = localStorage.getItem('token');

    for (let i = 0; i < selectedList.length; i++) {
      if (cancelled) break;
      const p = selectedList[i];
      const sku = p.sku || p.supplier_code;
      const idField = p.sku ? 'sku' : 'supplier_code';
      setProgress(pr => ({ ...pr, current: i + 1 }));

      try {
        // 1) Ask AI for a description
        const genRes = await fetch(`${API_URL}/api/products/generate-description`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            name: p.product_name || p.display_name || p.our_product_name || p.name || sku,
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
        const desc = gen.description || gen.text || gen.result || '';
        if (!desc || desc.trim().length < 10) throw new Error('AI returned empty description');

        // 2) Write back with bulk-update-unified (single product, but same verified path)
        const saveRes = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_ids: [sku],
            id_field: idField,
            updates: { description: desc },
            mode: 'replace',
          }),
        });
        if (!saveRes.ok) throw new Error(`Save HTTP ${saveRes.status}`);
        const saveData = await saveRes.json();
        if (Array.isArray(saveData.verification_failures) && saveData.verification_failures.length > 0) {
          throw new Error('Verification failed (description didn\'t stick)');
        }
        setProgress(pr => ({ ...pr, success: pr.success + 1 }));
      } catch (err) {
        setProgress(pr => ({ ...pr, failed: pr.failed + 1 }));
        setErrors(e => [...e, { sku, message: String(err.message) }]);
      }
    }

    setRunning(false);
    if (!cancelled) {
      toast.success(`Descriptions written: ${progress.success + (progress.failed === 0 ? 1 : 0)} success / ${progress.failed} failed`);
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
            Uses the built-in AI generator (via Emergent LLM key) to write SEO-friendly product descriptions. Each save is verified.
          </p>
        </DialogHeader>

        {!running && progress.current === 0 && (
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

        {(running || progress.current > 0) && (
          <div className="space-y-3">
            {/* Progress bar */}
            <div>
              <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
                <span>Progress</span>
                <span>{progress.current} / {progress.total}  ({percent}%)</span>
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
                <Sparkles className="w-4 h-4 mr-1" /> Generate {selectedList.length}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default BulkAIDescriptionsModal;
