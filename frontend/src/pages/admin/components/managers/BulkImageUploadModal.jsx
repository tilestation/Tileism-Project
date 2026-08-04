/**
 * BulkImageUploadModal — drag-drop images per SKU across selected products.
 *
 * Workflow:
 *   1. Modal opens showing each selected product in its own row with a drop-zone.
 *   2. Admin drags 1-N images onto a row (or clicks Choose files).
 *   3. Images upload immediately (parallel) to /api/products/upload-image and
 *      the returned URLs are staged in the modal.
 *   4. Admin picks "Replace" (overwrite images[] on the product) OR "Append"
 *      (add on top of existing images[]).
 *   5. On "Save all", we call bulk-update-unified with the new images[] per product.
 *   6. Success / failure per product surfaced inline.
 */

import React, { useState, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Badge } from '../../../../components/ui/badge';
import {
  Upload, Image as ImageIcon, X, RefreshCw, Save, CheckCircle, AlertCircle, Copy,
} from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const uploadOne = async (file, token) => {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${API_URL}/api/products/upload-image`, {
    method: 'POST',
    body: fd,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.url;
};

const BulkImageUploadModal = ({ open, onOpenChange, selectedList = [], onSuccess, themeColor = 'orange' }) => {
  const themeBtn = {
    orange: 'bg-orange-600 hover:bg-orange-700 text-white',
    blue:   'bg-blue-600   hover:bg-blue-700   text-white',
    amber:  'bg-amber-600  hover:bg-amber-700  text-white',
    cyan:   'bg-cyan-600   hover:bg-cyan-700   text-white',
    red:    'bg-red-600    hover:bg-red-700    text-white',
    slate:  'bg-slate-700  hover:bg-slate-800  text-white',
    purple: 'bg-purple-600 hover:bg-purple-700 text-white',
  }[themeColor] || 'bg-orange-600 hover:bg-orange-700 text-white';

  // stagedByKey: { sku -> {urls: [], uploading: n, error: string|null, savedStatus: 'idle'|'saved'|'failed'} }
  const [stagedByKey, setStagedByKey] = useState({});
  const [mode, setMode] = useState('append');        // 'append' | 'replace'
  const [applyToAllFiles, setApplyToAllFiles] = useState(null);  // {name, url} — used with "Apply to all"
  const [savingAll, setSavingAll] = useState(false);
  const dropRefs = useRef({});

  const productKey = (p) => p.sku || p.supplier_code;

  const addStaged = (key, urls) => {
    setStagedByKey(prev => ({
      ...prev,
      [key]: {
        urls: [...(prev[key]?.urls || []), ...urls],
        uploading: (prev[key]?.uploading || 0),
        error: null,
        savedStatus: 'idle',
      },
    }));
  };

  const removeStaged = (key, url) => {
    setStagedByKey(prev => ({
      ...prev,
      [key]: { ...prev[key], urls: (prev[key]?.urls || []).filter(u => u !== url) },
    }));
  };

  const handleFiles = useCallback(async (key, filesList) => {
    const files = Array.from(filesList).filter(f => f.type.startsWith('image/'));
    if (files.length === 0) return;
    const token = localStorage.getItem('token');
    setStagedByKey(prev => ({
      ...prev,
      [key]: { ...(prev[key] || {}), uploading: (prev[key]?.uploading || 0) + files.length, urls: prev[key]?.urls || [], error: null },
    }));
    const results = await Promise.allSettled(files.map(f => uploadOne(f, token)));
    const uploaded = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const failed = results.filter(r => r.status === 'rejected').length;
    setStagedByKey(prev => ({
      ...prev,
      [key]: {
        urls: [...(prev[key]?.urls || []), ...uploaded],
        uploading: Math.max(0, (prev[key]?.uploading || 0) - files.length),
        error: failed > 0 ? `${failed} upload(s) failed` : null,
        savedStatus: 'idle',
      },
    }));
    if (failed) toast.error(`${failed} image(s) failed to upload for ${key}`);
  }, []);

  const handleApplyToAll = useCallback(async (fileList) => {
    // Upload once, then set that URL as the first URL of every selected product's staged list.
    const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
    if (files.length === 0) return;
    const token = localStorage.getItem('token');
    try {
      const urls = await Promise.all(files.map(f => uploadOne(f, token)));
      setApplyToAllFiles(urls);
      setStagedByKey(prev => {
        const next = { ...prev };
        selectedList.forEach(p => {
          const k = productKey(p);
          next[k] = {
            urls: [...(prev[k]?.urls || []), ...urls],
            uploading: 0,
            error: null,
            savedStatus: 'idle',
          };
        });
        return next;
      });
      toast.success(`Applied ${urls.length} image(s) to all ${selectedList.length} products`);
    } catch (err) {
      toast.error(`Apply-to-all failed: ${err.message}`);
    }
  }, [selectedList]);

  const productsWithChanges = selectedList.filter(p => (stagedByKey[productKey(p)]?.urls?.length || 0) > 0);

  const handleSaveAll = async () => {
    if (productsWithChanges.length === 0) {
      toast.error('Nothing staged — drag an image onto at least one product');
      return;
    }
    setSavingAll(true);
    let successCount = 0;
    let failedCount = 0;
    for (const p of productsWithChanges) {
      const key = productKey(p);
      const staged = stagedByKey[key];
      if (!staged || staged.urls.length === 0) continue;
      try {
        const newImages = mode === 'replace' ? staged.urls : [...(p.images || []), ...staged.urls];
        const idField = p.sku ? 'sku' : 'supplier_code';
        const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            product_ids: [key],
            id_field: idField,
            updates: { images: newImages, image_url: newImages[0] || null },
            mode: 'replace',
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (Array.isArray(data.verification_failures) && data.verification_failures.length > 0) {
          throw new Error('Verification failed');
        }
        setStagedByKey(prev => ({ ...prev, [key]: { ...prev[key], savedStatus: 'saved' } }));
        successCount++;
      } catch (err) {
        setStagedByKey(prev => ({ ...prev, [key]: { ...prev[key], savedStatus: 'failed', error: String(err.message) } }));
        failedCount++;
      }
    }
    setSavingAll(false);
    if (failedCount === 0) toast.success(`Images saved for ${successCount} product(s)`);
    else toast.warning(`${successCount} saved, ${failedCount} failed — see per-row indicators`);
    if (onSuccess && successCount > 0) onSuccess({ success: successCount, failed: failedCount });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!savingAll) onOpenChange(o); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto" data-testid="bulk-images-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-purple-600" />
            Bulk Image Upload — {selectedList.length} product(s)
          </DialogTitle>
          <p className="text-xs text-gray-500">
            Drag images onto each product below. Or drop a single set to &ldquo;Apply to all&rdquo; and then tweak per-row.
          </p>
        </DialogHeader>

        {/* Global controls */}
        <div className="flex items-center gap-3 bg-gray-50 border border-gray-200 rounded p-2">
          <div className="text-xs font-medium text-gray-700">Save mode:</div>
          <label className="flex items-center gap-1 text-xs cursor-pointer">
            <input type="radio" checked={mode === 'append'} onChange={() => setMode('append')} data-testid="bulk-images-mode-append" />
            Append (keep existing)
          </label>
          <label className="flex items-center gap-1 text-xs cursor-pointer">
            <input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} data-testid="bulk-images-mode-replace" />
            Replace (overwrite existing)
          </label>
          <div className="ml-auto flex items-center gap-2">
            <label className="text-xs text-purple-600 hover:text-purple-700 cursor-pointer flex items-center gap-1" data-testid="bulk-images-apply-to-all">
              <Copy className="w-3.5 h-3.5" />
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => handleApplyToAll(e.target.files)}
              />
              Apply to all
            </label>
          </div>
        </div>

        {/* Per-product rows */}
        <div className="space-y-2 mt-3 max-h-[50vh] overflow-y-auto">
          {selectedList.map(p => {
            const key = productKey(p);
            const staged = stagedByKey[key] || { urls: [], uploading: 0 };
            const existingImg = p.image_url || (Array.isArray(p.images) && p.images[0]);
            const name = p.our_product_name || p.product_name || p.name || key;
            return (
              <div
                key={key}
                className={`border rounded-lg p-2 flex items-start gap-3 ${
                  staged.savedStatus === 'saved' ? 'border-emerald-300 bg-emerald-50'
                    : staged.savedStatus === 'failed' ? 'border-red-300 bg-red-50'
                    : 'border-gray-200 bg-white'
                }`}
                data-testid={`bulk-images-row-${key}`}
              >
                <div className="w-16 h-16 rounded bg-gray-100 border border-gray-200 flex-shrink-0 overflow-hidden">
                  {staged.urls[0] ? (
                    <img src={staged.urls[0]} alt="" className="w-full h-full object-cover" />
                  ) : existingImg ? (
                    <img src={existingImg} alt="" className="w-full h-full object-cover opacity-50" />
                  ) : (
                    <ImageIcon className="w-6 h-6 text-gray-300 m-5" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 line-clamp-1">{name}</div>
                  <div className="text-xs text-gray-500">{p.supplier} · {key}</div>
                  {staged.urls.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {staged.urls.map(u => (
                        <div key={u} className="relative w-8 h-8 rounded border border-gray-200 overflow-hidden">
                          <img src={u} alt="" className="w-full h-full object-cover" />
                          <button
                            onClick={() => removeStaged(key, u)}
                            className="absolute -top-1 -right-1 bg-white border border-gray-200 rounded-full w-3.5 h-3.5 flex items-center justify-center hover:bg-red-100"
                            title="Remove"
                          >
                            <X className="w-2.5 h-2.5 text-red-500" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {staged.error && <div className="text-[11px] text-red-600 mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" />{staged.error}</div>}
                </div>
                <div className="flex flex-col items-end gap-1">
                  <label
                    className="text-[11px] text-gray-600 border border-dashed border-gray-300 rounded px-2 py-1 hover:border-purple-400 hover:text-purple-600 cursor-pointer flex items-center gap-1"
                    onDragOver={(e) => { e.preventDefault(); }}
                    onDrop={(e) => { e.preventDefault(); handleFiles(key, e.dataTransfer.files); }}
                    ref={el => dropRefs.current[key] = el}
                    data-testid={`bulk-images-drop-${key}`}
                  >
                    <Upload className="w-3 h-3" />
                    Drop or choose
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => handleFiles(key, e.target.files)}
                    />
                  </label>
                  {staged.uploading > 0 && <span className="text-[10px] text-gray-500 flex items-center gap-0.5"><RefreshCw className="w-2.5 h-2.5 animate-spin" />{staged.uploading} uploading</span>}
                  {staged.savedStatus === 'saved' && <Badge className="bg-emerald-100 text-emerald-700 text-[10px]"><CheckCircle className="w-2.5 h-2.5 mr-0.5" /> Saved</Badge>}
                  {staged.savedStatus === 'failed' && <Badge className="bg-red-100 text-red-700 text-[10px]"><AlertCircle className="w-2.5 h-2.5 mr-0.5" /> Failed</Badge>}
                </div>
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <span className="text-xs text-gray-500 mr-auto" data-testid="bulk-images-summary">
            {productsWithChanges.length} product(s) with staged images
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={savingAll}>
            {savingAll ? 'Saving…' : 'Close'}
          </Button>
          <Button
            onClick={handleSaveAll}
            disabled={savingAll || productsWithChanges.length === 0}
            className={themeBtn}
            data-testid="bulk-images-save"
          >
            {savingAll ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
            Save to {productsWithChanges.length} product(s)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default BulkImageUploadModal;
