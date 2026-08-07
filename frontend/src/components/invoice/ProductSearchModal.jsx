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
import { Search, X, Store, PackageCheck, Plus, Flame } from 'lucide-react';
import { Input } from '../ui/input';
import { Button } from '../ui/button';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const ProductSearchModal = ({
  open,
  onClose,
  products = [],
  initialQuery = '',
  userShowroomId = null,
  onSelect,
  onAddMisc = null,
}) => {
  const [q, setQ] = useState(initialQuery || '');
  const inputRef = useRef(null);
  const [highlight, setHighlight] = useState(0);
  // topSellers = { sku: units_sold } — fetched once when modal opens so
  // empty-query results surface the shop's most-sold products first.
  const [topSellers, setTopSellers] = useState({});
  const [topSellersLoaded, setTopSellersLoaded] = useState(false);

  const authHeaders = () => {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

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

  // Fetch top sellers ONCE on first open — the ranking is stable enough
  // during a session that we don't need to re-hit the API on every open.
  // Start with a 90-day window (recency-weighted). If nothing sold in 90 days
  // (small shop / preview DB / new setup), fall back to all-time so the modal
  // still has SOMETHING to rank by.
  useEffect(() => {
    if (!open || topSellersLoaded) return;
    (async () => {
      const fetchWindow = async (days) => {
        const res = await fetch(`${API_URL}/api/products/epos/top-sellers?days=${days}&limit=200`, { headers: authHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      };
      try {
        let data = await fetchWindow(90);
        if (!data.ranking || data.ranking.length === 0) {
          data = await fetchWindow(3650); // all-time fallback (~10 years)
        }
        const map = {};
        (data.ranking || []).forEach(({ sku, units_sold }) => { map[String(sku).toLowerCase()] = units_sold; });
        setTopSellers(map);
      } catch {
        // Silent — if ranking fails, we just render products in their natural order.
      } finally {
        setTopSellersLoaded(true);
      }
    })();
  }, [open, topSellersLoaded]);

  // Strict word-based match — only against `name` and `sku`. No description
  // fuzz-matching, so "standard set" won't drag in unrelated products via their
  // marketing blurb.
  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    let list;
    if (!query) {
      list = products;
    } else {
      const words = query.split(/\s+/).filter(Boolean);
      list = products.filter((p) => {
        const name = (p.name || '').toLowerCase();
        const sku = (p.sku || '').toLowerCase();
        const hay = `${name} ${sku}`;
        // Every typed word must appear somewhere in the combined name+sku
        // string. Keeps the search intuitive (any order) but blocks description spam.
        return words.every((w) => hay.includes(w));
      });
    }

    // When no query is typed, prioritise the shop's bestsellers so staff hit
    // frequent items in one click. Products missing from the ranking keep
    // their natural order below.
    if (!query && Object.keys(topSellers).length > 0) {
      const rank = (sku) => topSellers[String(sku || '').toLowerCase()] ?? -1;
      return [...list].sort((a, b) => rank(b.sku) - rank(a.sku));
    }
    return list;
  }, [products, q, topSellers]);

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
              : (Object.keys(topSellers).length > 0
                  ? `${products.length} products • Bestsellers first`
                  : `${products.length} products available`)}
          </span>
          <span className="text-gray-400">↑↓ to navigate • Enter to add • Esc to close</span>
        </div>

        {/* Results list */}
        <div className="flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="text-center py-10 px-6" data-testid="product-search-empty">
              <PackageCheck className="w-8 h-8 mx-auto text-gray-300 mb-2" />
              <p className="text-sm text-gray-500 mb-4">
                No products match &ldquo;{q}&rdquo;
              </p>
              {onAddMisc && q.trim() && (
                <Button
                  onClick={() => onAddMisc(q.trim())}
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                  data-testid="product-search-add-misc"
                >
                  <Plus className="w-4 h-4 mr-1.5" />
                  Add &ldquo;{q.trim()}&rdquo; as Miscellaneous
                </Button>
              )}
              {onAddMisc && q.trim() && (
                <p className="text-[11px] text-gray-400 mt-2">
                  Adds a temporary line item with this name at £0 — set the price on the invoice row.
                </p>
              )}
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
                    className={`px-5 py-3 cursor-pointer flex items-start gap-4 transition-colors ${
                      highlighted ? 'bg-blue-50' : 'hover:bg-slate-50'
                    }`}
                    onMouseEnter={() => setHighlight(idx)}
                    onClick={() => onSelect?.(p)}
                    data-testid={`product-search-row-${p.sku || idx}`}
                  >
                    {/* Left — full product name (wraps, no truncate) + SKU */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 leading-snug break-words flex items-center gap-1.5 flex-wrap">
                        <span>{p.name || <span className="text-gray-400">— no name —</span>}</span>
                        {!q.trim() && topSellers[String(p.sku || '').toLowerCase()] > 0 && (
                          <span
                            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 text-[10px] font-medium"
                            data-testid={`top-seller-chip-${p.sku}`}
                            title={`Sold ${topSellers[String(p.sku).toLowerCase()]} units in the last 90 days`}
                          >
                            <Flame className="w-2.5 h-2.5" />
                            Top seller
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono mt-0.5">{p.sku || 'no-sku'}</div>
                    </div>

                    {/* Middle — stock */}
                    <div className="text-right shrink-0 min-w-[120px] pt-0.5">
                      <div className={`text-xs font-medium flex items-center gap-1 justify-end ${showroomStock > 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                        <Store className="w-3 h-3" />
                        This store: {showroomStock}
                      </div>
                      {otherStoresStock > 0 && (
                        <div className="text-[10px] text-purple-600">Other stores: {otherStoresStock}</div>
                      )}
                    </div>

                    {/* Right — price */}
                    <div className="text-right shrink-0 min-w-[80px] pt-0.5">
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
