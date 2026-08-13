/**
 * SyncReviewMode — full-screen fast-review overlay for newly discovered
 * supplier products in the Sync Hub. Large image cards with cost, size and
 * one-click Add / Ignore so the owner can blast through 70+ finds in minutes.
 */
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { X, Plus, Package, Zap, Check, Ban, Tag, Loader2 } from 'lucide-react';
import { Button } from '../../../components/ui/button';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const fmtMoney = (v) => (v === null || v === undefined || v === '' ? null : `£${Number(v).toFixed(2)}`);

const StockBadge = ({ product }) => {
  if (product.stock_m2 !== null && product.stock_m2 !== undefined) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-xs font-semibold">{product.stock_m2} m²</span>;
  }
  if (product.stock_quantity !== null && product.stock_quantity !== undefined) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 text-xs font-semibold">{product.stock_quantity} pcs</span>;
  }
  return <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs font-semibold">No stock data</span>;
};

export default function SyncReviewMode({ supplier, products, onClose }) {
  const [items, setItems] = useState(products || []);
  const [added, setAdded] = useState(0);
  const [ignored, setIgnored] = useState(0);
  const [processing, setProcessing] = useState(new Set());
  const [clearanceIds, setClearanceIds] = useState(new Set());

  const total = (products || []).length;
  const remaining = items.length;

  const markBusy = (id, busy) => {
    setProcessing((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id); else next.delete(id);
      return next;
    });
  };

  const removeCard = (id) => setItems((prev) => prev.filter((p) => p.id !== id));

  const addProduct = async (product) => {
    markBusy(product.id, true);
    try {
      const res = await fetch(
        `${API_URL}/api/sync-staging/${encodeURIComponent(supplier)}/add-new-product/${product.id}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_clearance: clearanceIds.has(product.id) }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      removeCard(product.id);
      setAdded((n) => n + 1);
    } catch (err) {
      toast.error(`Add failed for ${product.sku}: ${err.message}`);
    } finally {
      markBusy(product.id, false);
    }
  };

  const ignoreProduct = async (product) => {
    markBusy(product.id, true);
    try {
      const res = await fetch(`${API_URL}/api/sync-staging/ignore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: product.sku, supplier, reason: 'Ignored in Review Mode' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      removeCard(product.id);
      setIgnored((n) => n + 1);
    } catch (err) {
      toast.error(`Ignore failed for ${product.sku}: ${err.message}`);
    } finally {
      markBusy(product.id, false);
    }
  };

  const toggleClearance = (id) => {
    setClearanceIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return createPortal(
    <div className="fixed inset-0 z-[10000] bg-slate-950/95 overflow-y-auto" data-testid="review-mode-overlay">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur border-b border-slate-700 px-4 sm:px-6 py-3">
        <div className="flex items-center justify-between gap-3 flex-wrap max-w-[1600px] mx-auto">
          <div className="flex items-center gap-3">
            <Zap className="w-5 h-5 text-yellow-400" />
            <div>
              <h2 className="text-white font-bold text-lg leading-tight">Review Mode — {supplier}</h2>
              <p className="text-slate-400 text-xs">One-click Add or Ignore each new find</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3 text-sm" data-testid="review-progress">
              <span className="text-slate-300"><b className="text-white">{remaining}</b> left</span>
              <span className="text-emerald-400 flex items-center gap-1"><Check className="w-3.5 h-3.5" /><b>{added}</b> added</span>
              <span className="text-rose-400 flex items-center gap-1"><Ban className="w-3.5 h-3.5" /><b>{ignored}</b> ignored</span>
            </div>
            {/* Progress bar */}
            <div className="hidden sm:block w-36 h-2 rounded-full bg-slate-700 overflow-hidden">
              <div
                className="h-full bg-yellow-400 transition-all duration-300"
                style={{ width: total > 0 ? `${((total - remaining) / total) * 100}%` : '0%' }}
              />
            </div>
            <Button
              onClick={onClose}
              className="bg-white text-slate-900 hover:bg-slate-200 font-semibold h-8"
              data-testid="review-mode-close-btn"
            >
              <X className="w-4 h-4 mr-1" /> Done
            </Button>
          </div>
        </div>
      </div>

      {/* Card grid */}
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6">
        {remaining === 0 ? (
          <div className="text-center py-24" data-testid="review-mode-complete">
            <div className="w-16 h-16 rounded-full bg-emerald-500/20 flex items-center justify-center mx-auto mb-4">
              <Check className="w-8 h-8 text-emerald-400" />
            </div>
            <h3 className="text-white text-2xl font-bold mb-2">All reviewed!</h3>
            <p className="text-slate-400 mb-6">{added} added to the catalogue · {ignored} ignored for good</p>
            <Button onClick={onClose} className="bg-yellow-400 text-slate-900 hover:bg-yellow-300 font-bold" data-testid="review-mode-finish-btn">
              Back to Sync Hub
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {items.map((product) => {
              const busy = processing.has(product.id);
              const cost = fmtMoney(product.cost_price ?? product.price);
              const isClearance = clearanceIds.has(product.id);
              return (
                <div
                  key={product.id}
                  className="bg-white rounded-xl overflow-hidden shadow-lg flex flex-col"
                  data-testid={`review-card-${product.sku || product.id}`}
                >
                  {/* Image */}
                  <div className="h-48 bg-slate-100 relative">
                    {product.image ? (
                      <img src={product.image} alt={product.name} className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Package className="w-12 h-12 text-slate-300" />
                      </div>
                    )}
                    {cost && (
                      <span className="absolute top-2 right-2 px-2.5 py-1 rounded-lg bg-slate-900/85 text-yellow-300 text-sm font-bold" data-testid={`review-cost-${product.sku || product.id}`}>
                        Cost {cost}
                      </span>
                    )}
                    {isClearance && (
                      <span className="absolute top-2 left-2 px-2 py-0.5 rounded bg-red-600 text-white text-[10px] font-bold uppercase tracking-wide">Clearance</span>
                    )}
                  </div>

                  {/* Details */}
                  <div className="p-3 flex-1 flex flex-col">
                    <h3 className="font-semibold text-slate-900 text-sm leading-snug line-clamp-2 min-h-[2.4em]">{product.name || 'Unnamed product'}</h3>
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      {product.sku && <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 text-xs font-mono">{product.sku}</span>}
                      {product.size && <span className="px-2 py-0.5 rounded-full bg-sky-100 text-sky-800 text-xs font-semibold">{product.size}</span>}
                      <StockBadge product={product} />
                    </div>
                    {product.category && <p className="text-xs text-slate-400 mt-1.5 capitalize">{product.category}</p>}

                    <button
                      type="button"
                      onClick={() => toggleClearance(product.id)}
                      className={`mt-2 self-start inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ${
                        isClearance
                          ? 'bg-red-50 border-red-300 text-red-700'
                          : 'bg-white border-slate-200 text-slate-400 hover:text-slate-600 hover:border-slate-300'
                      }`}
                      data-testid={`review-clearance-toggle-${product.sku || product.id}`}
                    >
                      <Tag className="w-3 h-3" />
                      {isClearance ? 'Adding as Clearance' : 'Mark as Clearance'}
                    </button>

                    {/* Actions */}
                    <div className="flex gap-2 mt-3">
                      <Button
                        variant="outline"
                        className="flex-1 h-10 border-slate-300 text-slate-600 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-300 font-semibold"
                        disabled={busy}
                        onClick={() => ignoreProduct(product)}
                        data-testid={`review-ignore-${product.sku || product.id}`}
                      >
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Ban className="w-4 h-4 mr-1.5" /> Ignore</>}
                      </Button>
                      <Button
                        className="flex-[1.4] h-10 bg-emerald-600 hover:bg-emerald-700 text-white font-bold"
                        disabled={busy || !product.has_stock}
                        title={!product.has_stock ? 'No stock data — edit stock in the Sync Hub list first' : undefined}
                        onClick={() => addProduct(product)}
                        data-testid={`review-add-${product.sku || product.id}`}
                      >
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Plus className="w-4 h-4 mr-1.5" /> Add</>}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
