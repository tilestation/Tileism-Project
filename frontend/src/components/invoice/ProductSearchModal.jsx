/**
 * ProductSearchModal — full-screen popup replacement for the cramped inline
 * dropdown on the EPOS / Invoice line-items table.
 *
 * Fixes 3 gripes:
 *   1. Search is now STRICT: it only matches words against the product `name`
 *      and `sku`. Descriptions, supplier tags, and supplier product names are
 *      no longer considered — so "standard set" won't surface unrelated tiles.
 *   2. Description text is NOT shown in results (name-only cards).
 *   3. Big centered modal with proper spacing + scroll instead of a tight
 *      dropdown squeezed inside a table row.
 *
 * Props:
 *   open              — boolean, controls visibility
 *   onClose()         — called when the modal should close (Esc, backdrop, X)
 *   products          — full product list to search over
 *   initialQuery      — string to prefill the search box (usually item.sku)
 *   userShowroomId    — used to pick per-showroom stock counts
 *   onSelect(product) — called when a row is clicked; parent closes the modal
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Store, PackageCheck } from 'lucide-react';
import { Input } from '../ui/input';
import { Button } from '../ui/button';

const ProductSearchModal = ({
  open,
  onClose,
  products = [],
  initialQuery = '',
  userShowroomId = null,
  onSelect,
}) => {
  const [q, setQ] = useState(initialQuery || '');
  const inputRef = useRef(null);
  const [highlight, setHighlight] = useState(0);

  // Reset query + highlight whenever modal opens
  useEffect(() => {
    if (open) {
      setQ(initialQuery || '');
      setHighlight(0);
      // Focus on next tick so the input is mounted
      requestAnimationFrame(() => {
        try { inputRef.current?.focus(); inputRef.current?.select(); } catch { /* ignore */ }
      });
    }
  }, [open, initialQuery]);

  // Strict word-based match — only against `name` and `sku`. No description
  // fuzz-matching, so "standard set" won't drag in unrelated products via their
  // marketing blurb.
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return products;
    const words = query.split(/\s+/).filter(Boolean);
    return products.filter((p) => {
      const name = (p.name || '').toLowerCase();
      const sku = (p.sku || '').toLowerCase();
      const hay = `${name} ${sku}`;
      // Every typed word must appear somewhere in the combined name+sku string.
      // This keeps the search intuitive (any order) but blocks description spam.
      return words.every((w) => hay.includes(w));
    });
  }, [products, q]);

  const visible = filtered.slice(0, 100);

  // Keyboard navigation — arrow keys move highlight, Enter selects, Esc closes.
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose?.(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, visible.length - 1)); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = visible[highlight];
      if (pick) onSelect?.(pick);
    }
  }, [visible, highlight, onSelect, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/40 backdrop-blur-sm pt-16 px-4"
      onClick={onClose}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      data-testid="product-search-modal"
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-200 bg-slate-50">
          <Search className="w-4 h-4 text-slate-500" />
          <Input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setHighlight(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Search by product name or SKU…"
            className="h-9 text-sm border-slate-300"
            data-testid="product-search-modal-input"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            data-testid="product-search-modal-close"
            className="shrink-0"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Status */}
        <div className="px-5 py-2 text-[11px] text-gray-500 border-b border-gray-100 bg-white flex justify-between">
          <span>
            {q.trim()
              ? `${filtered.length} match${filtered.length === 1 ? '' : 'es'}${filtered.length > visible.length ? ` (showing first ${visible.length})` : ''}`
              : `${products.length} products available`}
          </span>
          <span className="text-gray-400">↑↓ to navigate • Enter to add • Esc to close</span>
        </div>

        {/* Results list */}
        <div className="flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="text-center py-12 text-sm text-gray-400" data-testid="product-search-empty">
              <PackageCheck className="w-8 h-8 mx-auto text-gray-300 mb-2" />
              No products match &ldquo;{q}&rdquo;
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {visible.map((p, idx) => {
                const highlighted = idx === highlight;
                const showroomStock =
                  userShowroomId && p.showroom_stock
                    ? (p.showroom_stock[userShowroomId] || 0)
                    : (p.stock ?? 0);
                const otherStoresStock = p.showroom_stock
                  ? Object.entries(p.showroom_stock)
                      .filter(([id]) => id !== userShowroomId)
                      .reduce((sum, [, qty]) => sum + qty, 0)
                  : 0;
                return (
                  <li
                    key={p.id || p.sku || idx}
                    className={`px-5 py-3 cursor-pointer flex items-center gap-4 transition-colors ${
                      highlighted ? 'bg-blue-50' : 'hover:bg-slate-50'
                    }`}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => onSelect?.(p)}
                    data-testid={`product-search-row-${p.sku || idx}`}
                  >
                    {/* Left — name + SKU only. NO description on purpose. */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate" title={p.name}>
                        {p.name || <span className="text-gray-400">— no name —</span>}
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono">{p.sku || 'no-sku'}</div>
                    </div>

                    {/* Middle — stock */}
                    <div className="text-right shrink-0 min-w-[130px]">
                      <div className={`text-xs font-medium flex items-center gap-1 justify-end ${showroomStock > 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                        <Store className="w-3 h-3" />
                        This store: {showroomStock}
                      </div>
                      {otherStoresStock > 0 && (
                        <div className="text-[10px] text-purple-600">Other stores: {otherStoresStock}</div>
                      )}
                    </div>

                    {/* Right — price */}
                    <div className="text-right shrink-0 min-w-[90px]">
                      <div className="text-sm font-semibold text-emerald-700">
                        £{(p.price || 0).toFixed(2)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

export default ProductSearchModal;
