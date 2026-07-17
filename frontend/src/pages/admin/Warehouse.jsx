/*
 * Tonbridge Warehouse — dedicated stock page.
 *
 * • Any authenticated admin/staff user can VIEW warehouse stock.
 * • Only Super Admins or users with the `warehouse_manage` permission
 *   see the Adjust button.
 * • Every store can raise a "Request from Warehouse" that lands as a
 *   pending stock transfer in /admin/stock-transfers.
 * • Empty state until the user searches (we intentionally do NOT prefetch
 *   thousands of products — the search bar is the entry point).
 *
 * Feature contract signed off by owner on Jul 13, 2026.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Warehouse as WarehouseIcon, Search, Sliders, Send, RefreshCw, PackageOpen,
  ArrowUpDown, ChevronDown, ChevronUp, Info,
} from 'lucide-react';
import axios from 'axios';
import { getAuthHeader } from '../../lib/api';

import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from '../../components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../../components/ui/select';

const API = process.env.REACT_APP_BACKEND_URL + '/api';

// Debounce helper — keeps typing snappy but avoids hammering the server.
function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return '—'; }
}

const REASON_LABELS = {
  delivery_received: 'Delivery received',
  stocktake_correction: 'Stocktake correction',
  damage_writeoff: 'Damage / write-off',
  transfer_out: 'Transfer out to store',
  other: 'Other',
};

export default function Warehouse() {
  const [info, setInfo] = useState(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [showrooms, setShowrooms] = useState([]);

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 300);
  const [searching, setSearching] = useState(false);
  const [products, setProducts] = useState([]);

  const [adjustments, setAdjustments] = useState([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);

  // Adjust dialog
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustProduct, setAdjustProduct] = useState(null);
  const [adjustMode, setAdjustMode] = useState('set');
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustReason, setAdjustReason] = useState('delivery_received');
  const [adjustNote, setAdjustNote] = useState('');
  const [savingAdjust, setSavingAdjust] = useState(false);

  // Request dialog
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestProduct, setRequestProduct] = useState(null);
  const [requestStore, setRequestStore] = useState('');
  const [requestQty, setRequestQty] = useState('1');
  const [requestNote, setRequestNote] = useState('');
  const [savingRequest, setSavingRequest] = useState(false);

  const canManage = !!info?.can_manage;

  // ------------------------------------------------------------
  // Data fetching
  // ------------------------------------------------------------
  const loadInfo = useCallback(async () => {
    setLoadingInfo(true);
    try {
      const [infoRes, storesRes] = await Promise.all([
        axios.get(`${API}/warehouse/info`, { headers: getAuthHeader() }),
        axios.get(`${API}/showrooms`, { headers: getAuthHeader() }),
      ]);
      setInfo(infoRes.data);
      // Exclude the warehouse itself from the destination list.
      const stores = (storesRes.data || []).filter(s => !s.is_warehouse);
      setShowrooms(stores);
    } catch (e) {
      console.error('Failed to load warehouse info', e);
      toast.error('Failed to load warehouse info');
    } finally {
      setLoadingInfo(false);
    }
  }, []);

  const loadAdjustments = useCallback(async () => {
    try {
      const res = await axios.get(`${API}/warehouse/adjustments?limit=50`, { headers: getAuthHeader() });
      setAdjustments(res.data?.adjustments || []);
    } catch (e) {
      console.error('Failed to load adjustments', e);
    }
  }, []);

  const searchProducts = useCallback(async (q) => {
    const trimmed = (q || '').trim();
    if (!trimmed) {
      setProducts([]);
      return;
    }
    setSearching(true);
    try {
      const res = await axios.get(
        `${API}/warehouse/products?q=${encodeURIComponent(trimmed)}&limit=50`,
        { headers: getAuthHeader() },
      );
      setProducts(res.data?.products || []);
    } catch (e) {
      console.error('Search failed', e);
      toast.error('Search failed');
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => { loadInfo(); loadAdjustments(); }, [loadInfo, loadAdjustments]);
  useEffect(() => { searchProducts(debouncedQuery); }, [debouncedQuery, searchProducts]);

  // ------------------------------------------------------------
  // Adjust flow
  // ------------------------------------------------------------
  const openAdjust = (product) => {
    setAdjustProduct(product);
    setAdjustMode('set');
    setAdjustQty(String(product.warehouse_stock ?? 0));
    setAdjustReason('delivery_received');
    setAdjustNote('');
    setAdjustOpen(true);
  };

  const submitAdjust = async () => {
    if (!adjustProduct) return;
    const qty = parseInt(adjustQty, 10);
    if (isNaN(qty)) {
      toast.error('Enter a valid number');
      return;
    }
    setSavingAdjust(true);
    try {
      const res = await axios.post(
        `${API}/warehouse/adjust`,
        {
          product_id: adjustProduct.id,
          mode: adjustMode,
          quantity: qty,
          reason: adjustReason,
          note: adjustNote || null,
        },
        { headers: getAuthHeader() },
      );
      toast.success(
        `Stock updated: ${res.data.before_qty} → ${res.data.after_qty}`,
        { description: adjustProduct.name },
      );
      setAdjustOpen(false);
      // Refresh both search results and history
      await Promise.all([searchProducts(debouncedQuery), loadAdjustments()]);
    } catch (e) {
      const msg = e.response?.data?.detail || 'Failed to adjust stock';
      toast.error(msg);
    } finally {
      setSavingAdjust(false);
    }
  };

  // ------------------------------------------------------------
  // Request flow
  // ------------------------------------------------------------
  const openRequest = (product) => {
    setRequestProduct(product);
    setRequestStore('');
    setRequestQty('1');
    setRequestNote('');
    setRequestOpen(true);
  };

  const submitRequest = async () => {
    if (!requestProduct || !requestStore) {
      toast.error('Pick a destination store');
      return;
    }
    const qty = parseInt(requestQty, 10);
    if (isNaN(qty) || qty <= 0) {
      toast.error('Quantity must be a positive number');
      return;
    }
    setSavingRequest(true);
    try {
      await axios.post(
        `${API}/warehouse/request-transfer`,
        {
          to_showroom_id: requestStore,
          product_id: requestProduct.id,
          sku: requestProduct.sku,
          name: requestProduct.name,
          quantity: qty,
          notes: requestNote || null,
        },
        { headers: getAuthHeader() },
      );
      const storeName = showrooms.find(s => s.id === requestStore)?.name || 'store';
      toast.success(`Request raised — ${qty} × ${requestProduct.name} → ${storeName}`, {
        description: 'Track it in Stock Transfers.',
      });
      setRequestOpen(false);
    } catch (e) {
      const msg = e.response?.data?.detail || 'Failed to raise request';
      toast.error(msg);
    } finally {
      setSavingRequest(false);
    }
  };

  // ------------------------------------------------------------
  // Render
  // ------------------------------------------------------------
  const warehouseName = info?.warehouse?.name || 'Tonbridge Warehouse';
  const visibleHistory = useMemo(
    () => historyExpanded ? adjustments : adjustments.slice(0, 8),
    [adjustments, historyExpanded],
  );

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6" data-testid="warehouse-page">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 bg-slate-900 rounded-lg flex items-center justify-center">
            <WarehouseIcon className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900" data-testid="warehouse-title">
              {warehouseName}
            </h1>
            <p className="text-sm text-slate-500">
              Live warehouse stock — visible to every store.
              {!canManage && (
                <span className="ml-2 text-slate-400">
                  Adjustments are locked to authorised staff.
                </span>
              )}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { searchProducts(debouncedQuery); loadAdjustments(); }}
          data-testid="warehouse-refresh-btn"
        >
          <RefreshCw className="w-4 h-4 mr-1" /> Refresh
        </Button>
      </div>

      {/* Permission banner for viewers */}
      {!loadingInfo && !canManage && (
        <Card className="p-4 bg-blue-50 border-blue-200 flex items-start gap-3">
          <Info className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-blue-900">
            You have <strong>view-only</strong> access to warehouse stock. To request stock for your
            store, click <strong>Request from Warehouse</strong> on any product below — the request
            appears in Stock Transfers for the warehouse team to fulfil.
          </div>
        </Card>
      )}

      {/* Search */}
      <Card className="p-4">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
          <Input
            data-testid="warehouse-search-input"
            className="pl-9 h-10"
            placeholder="Search by product name, SKU or barcode…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <p className="text-xs text-slate-500 mt-2">
          Type at least one character to see live warehouse stock. Results cap at 50 rows.
        </p>
      </Card>

      {/* Results */}
      <Card className="overflow-hidden" data-testid="warehouse-results-card">
        {searching && (
          <div className="p-4 text-sm text-slate-500 flex items-center gap-2">
            <RefreshCw className="w-4 h-4 animate-spin" /> Searching…
          </div>
        )}
        {!searching && debouncedQuery && products.length === 0 && (
          <div className="p-10 text-center text-slate-500" data-testid="warehouse-empty-results">
            <PackageOpen className="w-10 h-10 mx-auto text-slate-300 mb-3" />
            <p className="text-sm">No products match &quot;<strong>{debouncedQuery}</strong>&quot;.</p>
          </div>
        )}
        {!debouncedQuery && (
          <div className="p-10 text-center text-slate-400" data-testid="warehouse-empty-state">
            <Search className="w-10 h-10 mx-auto mb-3" />
            <p className="text-sm">Start typing a product name or SKU to see warehouse stock.</p>
          </div>
        )}
        {products.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="warehouse-results-table">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left py-2 px-4">SKU</th>
                  <th className="text-left py-2 px-4">Product</th>
                  <th className="text-left py-2 px-4">Category</th>
                  <th className="text-right py-2 px-4">Stock</th>
                  <th className="text-left py-2 px-4">Last adjusted</th>
                  <th className="text-right py-2 px-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const stock = p.warehouse_stock ?? 0;
                  const isOut = stock === 0;
                  const isLow = stock > 0 && stock <= 5;
                  return (
                    <tr
                      key={p.id}
                      className="border-t border-slate-100 hover:bg-slate-50/50"
                      data-testid={`warehouse-row-${p.sku || p.id}`}
                    >
                      <td className="py-3 px-4 font-mono text-xs text-slate-600">{p.sku || '—'}</td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{p.name}</div>
                        {p.barcode && (
                          <div className="text-xs text-slate-400 font-mono">{p.barcode}</div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-slate-600">{p.category_name || '—'}</td>
                      <td className="py-3 px-4 text-right">
                        <Badge
                          variant={isOut ? 'destructive' : isLow ? 'outline' : 'secondary'}
                          className={
                            isOut
                              ? 'bg-red-100 text-red-800 hover:bg-red-100'
                              : isLow
                              ? 'bg-amber-100 text-amber-800 hover:bg-amber-100'
                              : 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100'
                          }
                          data-testid={`warehouse-stock-badge-${p.sku || p.id}`}
                        >
                          {stock} {p.unit || ''}
                        </Badge>
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-500">
                        {p.last_adjusted_at ? (
                          <>
                            <div>{formatDateTime(p.last_adjusted_at)}</div>
                            <div className="text-slate-400">{p.last_adjusted_by || ''}</div>
                          </>
                        ) : '—'}
                      </td>
                      <td className="py-3 px-4 text-right space-x-2 whitespace-nowrap">
                        {canManage && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openAdjust(p)}
                            data-testid={`warehouse-adjust-btn-${p.sku || p.id}`}
                          >
                            <Sliders className="w-3.5 h-3.5 mr-1" /> Adjust
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={stock === 0}
                          onClick={() => openRequest(p)}
                          data-testid={`warehouse-request-btn-${p.sku || p.id}`}
                          title={stock === 0 ? 'No stock available to request' : 'Request from Warehouse'}
                        >
                          <Send className="w-3.5 h-3.5 mr-1" /> Request
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* History */}
      <Card className="overflow-hidden" data-testid="warehouse-history-card">
        <div className="p-4 flex items-center justify-between border-b border-slate-100">
          <div className="flex items-center gap-2">
            <ArrowUpDown className="w-4 h-4 text-slate-500" />
            <h2 className="font-semibold text-slate-900">Recent adjustments</h2>
            <Badge variant="secondary" className="ml-1">{adjustments.length}</Badge>
          </div>
          {adjustments.length > 8 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHistoryExpanded(!historyExpanded)}
              data-testid="warehouse-history-toggle"
            >
              {historyExpanded ? (
                <><ChevronUp className="w-4 h-4 mr-1" /> Show less</>
              ) : (
                <><ChevronDown className="w-4 h-4 mr-1" /> Show all {adjustments.length}</>
              )}
            </Button>
          )}
        </div>
        {adjustments.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">
            No adjustments yet. When someone updates warehouse stock, it appears here.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase tracking-wide">
                <tr>
                  <th className="text-left py-2 px-4">When</th>
                  <th className="text-left py-2 px-4">Product</th>
                  <th className="text-right py-2 px-4">Before → After</th>
                  <th className="text-right py-2 px-4">Δ</th>
                  <th className="text-left py-2 px-4">Reason</th>
                  <th className="text-left py-2 px-4">Who</th>
                </tr>
              </thead>
              <tbody>
                {visibleHistory.map((a) => (
                  <tr key={a.id} className="border-t border-slate-100" data-testid={`warehouse-history-row-${a.id}`}>
                    <td className="py-2 px-4 text-xs text-slate-500 whitespace-nowrap">
                      {formatDateTime(a.created_at)}
                    </td>
                    <td className="py-2 px-4">
                      <div className="font-medium text-slate-900">{a.product_name}</div>
                      <div className="text-xs font-mono text-slate-400">{a.product_sku || ''}</div>
                    </td>
                    <td className="py-2 px-4 text-right text-slate-600 whitespace-nowrap">
                      {a.before_qty} → <strong>{a.after_qty}</strong>
                    </td>
                    <td className="py-2 px-4 text-right whitespace-nowrap">
                      <span className={a.delta > 0 ? 'text-emerald-700' : a.delta < 0 ? 'text-red-700' : 'text-slate-500'}>
                        {a.delta > 0 ? '+' : ''}{a.delta}
                      </span>
                    </td>
                    <td className="py-2 px-4">
                      <div className="text-slate-700">{REASON_LABELS[a.reason] || a.reason}</div>
                      {a.note && <div className="text-xs text-slate-400 italic">&ldquo;{a.note}&rdquo;</div>}
                    </td>
                    <td className="py-2 px-4 text-xs text-slate-500">
                      {a.actor_name || a.actor_email}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Adjust dialog */}
      <Dialog open={adjustOpen} onOpenChange={setAdjustOpen}>
        <DialogContent className="max-w-md" data-testid="warehouse-adjust-dialog">
          <DialogHeader>
            <DialogTitle>Adjust warehouse stock</DialogTitle>
            <DialogDescription>
              {adjustProduct?.name} · <span className="font-mono">{adjustProduct?.sku}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="rounded-md bg-slate-50 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Current warehouse stock</span>
                <span className="font-semibold">{adjustProduct?.warehouse_stock ?? 0}</span>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">Mode</label>
              <div className="grid grid-cols-2 gap-2 mt-1">
                <Button
                  type="button"
                  variant={adjustMode === 'set' ? 'default' : 'outline'}
                  onClick={() => setAdjustMode('set')}
                  data-testid="warehouse-adjust-mode-set"
                >Set to</Button>
                <Button
                  type="button"
                  variant={adjustMode === 'delta' ? 'default' : 'outline'}
                  onClick={() => setAdjustMode('delta')}
                  data-testid="warehouse-adjust-mode-delta"
                >Add / remove (±)</Button>
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">
                {adjustMode === 'set' ? 'New quantity' : 'Change (use minus for removal)'}
              </label>
              <Input
                type="number"
                value={adjustQty}
                onChange={(e) => setAdjustQty(e.target.value)}
                className="mt-1"
                data-testid="warehouse-adjust-qty-input"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">Reason</label>
              <Select value={adjustReason} onValueChange={setAdjustReason}>
                <SelectTrigger className="mt-1" data-testid="warehouse-adjust-reason-trigger">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(info?.reasons || []).map((r) => (
                    <SelectItem key={r.key} value={r.key} data-testid={`warehouse-adjust-reason-${r.key}`}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">Note (optional)</label>
              <Input
                value={adjustNote}
                onChange={(e) => setAdjustNote(e.target.value)}
                placeholder="e.g. Pallet from Kepstan #4231"
                className="mt-1"
                maxLength={500}
                data-testid="warehouse-adjust-note-input"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustOpen(false)}>Cancel</Button>
            <Button
              onClick={submitAdjust}
              disabled={savingAdjust}
              data-testid="warehouse-adjust-submit-btn"
            >
              {savingAdjust ? 'Saving…' : 'Save adjustment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Request dialog */}
      <Dialog open={requestOpen} onOpenChange={setRequestOpen}>
        <DialogContent className="max-w-md" data-testid="warehouse-request-dialog">
          <DialogHeader>
            <DialogTitle>Request from Warehouse</DialogTitle>
            <DialogDescription>
              {requestProduct?.name} · <span className="font-mono">{requestProduct?.sku}</span>
              <span className="ml-2 text-xs text-slate-500">
                (in stock: {requestProduct?.warehouse_stock ?? 0})
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">
                Destination store
              </label>
              <Select value={requestStore} onValueChange={setRequestStore}>
                <SelectTrigger className="mt-1" data-testid="warehouse-request-store-trigger">
                  <SelectValue placeholder="Select store…" />
                </SelectTrigger>
                <SelectContent>
                  {showrooms.map((s) => (
                    <SelectItem key={s.id} value={s.id} data-testid={`warehouse-request-store-${s.id}`}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">
                Quantity
              </label>
              <Input
                type="number"
                min="1"
                value={requestQty}
                onChange={(e) => setRequestQty(e.target.value)}
                className="mt-1"
                data-testid="warehouse-request-qty-input"
              />
            </div>

            <div>
              <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">
                Notes (optional)
              </label>
              <Input
                value={requestNote}
                onChange={(e) => setRequestNote(e.target.value)}
                placeholder="e.g. Needed for Wednesday customer collection"
                className="mt-1"
                maxLength={500}
                data-testid="warehouse-request-note-input"
              />
            </div>

            <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-900">
              This creates a <strong>pending stock transfer</strong> from the warehouse to your store.
              The warehouse team will process it in Stock Transfers.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRequestOpen(false)}>Cancel</Button>
            <Button
              onClick={submitRequest}
              disabled={savingRequest || !requestStore}
              data-testid="warehouse-request-submit-btn"
            >
              {savingRequest ? 'Sending…' : 'Send request'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
