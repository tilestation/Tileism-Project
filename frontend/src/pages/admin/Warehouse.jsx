/*
 * Tonbridge Warehouse — stock page with per-batch tracking + PIN gate.
 *
 * Every mutation (adjust total, add batch, edit batch, delete batch,
 * quick-add product, set product default location) requires a fresh PIN
 * session token. The token is minted by /api/warehouse/pin-session, lasts
 * 15 minutes, and is cached in sessionStorage. When it's missing or
 * expired the user is prompted via <PinPromptDialog> before the mutation
 * fires. Every warehouse_adjustments row therefore records BOTH the JWT
 * user AND the PIN holder — so an audit reads "Hafiz (via PIN of Rehan)".
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Warehouse as WarehouseIcon, Search, Sliders, Send, RefreshCw, PackageOpen,
  ArrowUpDown, ChevronDown, ChevronUp, Info, Plus, Edit2, Trash2,
  Package, Image as ImageIcon, Layers, ExternalLink, MapPin, Lock,
  User as UserIcon, ShieldCheck, History,
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
import {
  Tabs, TabsList, TabsTrigger, TabsContent,
} from '../../components/ui/tabs';

const API = process.env.REACT_APP_BACKEND_URL + '/api';
const PIN_STORAGE_KEY = 'warehousePinSession';

// ---------------------------------------------------------------------------
// PIN session — cached in sessionStorage
// ---------------------------------------------------------------------------

function readPinSession() {
  try {
    const raw = sessionStorage.getItem(PIN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Give ourselves a 30s buffer before the server-side clock says expired
    if (!parsed?.session_token || !parsed?.expires_at) return null;
    const expMs = new Date(parsed.expires_at).getTime();
    if (isNaN(expMs) || expMs - 30_000 <= Date.now()) return null;
    return parsed;
  } catch { return null; }
}

function writePinSession(session) {
  if (!session) {
    sessionStorage.removeItem(PIN_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(session));
}

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
    return new Date(iso).toLocaleString('en-GB', {
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
  batch_added: 'Batch added',
  batch_edited: 'Batch edited',
  batch_removed: 'Batch removed',
};

const BATCH_REASONS = [
  { key: 'delivery_received', label: 'Delivery received' },
  { key: 'stocktake_correction', label: 'Stocktake correction' },
  { key: 'damage_writeoff', label: 'Damage / write-off' },
  { key: 'transfer_out', label: 'Transfer out to store' },
  { key: 'other', label: 'Other' },
];

// ---------------------------------------------------------------------------
// Small subcomponents
// ---------------------------------------------------------------------------

function StockBadge({ stock, unit }) {
  const s = stock ?? 0;
  const cls = s === 0
    ? 'bg-red-100 text-red-800 hover:bg-red-100'
    : s <= 5
    ? 'bg-amber-100 text-amber-800 hover:bg-amber-100'
    : 'bg-emerald-100 text-emerald-800 hover:bg-emerald-100';
  return <Badge className={`${cls} text-sm px-2.5 py-0.5`}>{s} {unit || ''}</Badge>;
}

function CoverageLine({ product }) {
  if (product.coverage_m2 != null) {
    return (
      <div className="text-xs text-slate-500 mt-0.5">
        {product.coverage_m2.toFixed(2)} m² total
        {product.tile_width && product.tile_height && (
          <span className="ml-1 text-slate-400">
            · {product.tile_width}×{product.tile_height}mm
          </span>
        )}
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Batch card — replaces the dense table row. One card per batch.
// ---------------------------------------------------------------------------

function BatchCard({ batch, canManage, onEdit, onDelete }) {
  return (
    <div
      className="bg-white rounded-lg border-2 border-slate-200 p-4 hover:border-slate-300 transition"
      data-testid={`warehouse-batch-card-${batch.id}`}
    >
      {/* Top row: batch number + location + total */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-900 text-white font-mono text-sm font-semibold">
            <Layers className="w-4 h-4" />
            {batch.batch_number}
          </div>
          {batch.location ? (
            <div
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-blue-100 text-blue-900 font-medium text-sm"
              data-testid={`warehouse-batch-location-${batch.id}`}
            >
              <MapPin className="w-4 h-4" />
              {batch.location}
            </div>
          ) : (
            <div className="inline-flex items-center gap-1 px-3 py-1 rounded-lg bg-slate-100 text-slate-400 text-sm italic">
              <MapPin className="w-4 h-4" />
              Unslotted
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-emerald-700 tabular-nums" data-testid={`warehouse-batch-total-${batch.id}`}>
            {batch.total_pieces}
          </div>
          <div className="text-xs text-slate-500 uppercase tracking-wide">pieces</div>
        </div>
      </div>

      {/* Middle: maths breakdown */}
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="bg-slate-50 rounded p-2">
          <div className="text-lg font-semibold text-slate-900">{batch.boxes}</div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Boxes</div>
        </div>
        <div className="bg-slate-50 rounded p-2">
          <div className="text-lg font-semibold text-slate-900">{batch.tiles_per_box}</div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Tiles / box</div>
        </div>
        <div className="bg-slate-50 rounded p-2">
          <div className="text-lg font-semibold text-slate-900">{batch.extra_pieces}</div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Loose pcs</div>
        </div>
      </div>

      {/* Notes (visible, no truncation) */}
      {batch.notes && (
        <div className="mt-3 text-sm text-slate-700 bg-amber-50 border border-amber-200 rounded p-2">
          <span className="font-semibold text-amber-900">Notes: </span>{batch.notes}
        </div>
      )}

      {/* Bottom: meta + actions */}
      <div className="mt-3 flex items-center justify-between flex-wrap gap-2 pt-3 border-t border-slate-100">
        <div className="text-xs text-slate-500">
          Logged {formatDateTime(batch.created_at)}
          <span className="mx-1">·</span>
          by {batch.created_by_name || batch.created_by_email}
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button
              size="sm" variant="outline"
              onClick={() => onEdit(batch)}
              data-testid={`warehouse-batch-edit-btn-${batch.id}`}
            >
              <Edit2 className="w-3.5 h-3.5 mr-1.5" /> Edit
            </Button>
            <Button
              size="sm" variant="outline"
              className="border-red-200 text-red-700 hover:bg-red-50"
              onClick={() => onDelete(batch)}
              data-testid={`warehouse-batch-delete-btn-${batch.id}`}
            >
              <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Remove
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function BatchesPanel({ product, canManage, onAddBatch, onEditBatch, onDeleteBatch }) {
  const batches = product.batches || [];
  return (
    <div className="bg-slate-50/70 border-t-2 border-slate-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <Layers className="w-4 h-4" />
          Batches ({batches.length})
        </div>
        {canManage && (
          <Button
            size="sm"
            onClick={() => onAddBatch(product)}
            data-testid={`warehouse-add-batch-btn-${product.sku || product.id}`}
          >
            <Plus className="w-4 h-4 mr-1" /> Add batch
          </Button>
        )}
      </div>
      {batches.length === 0 ? (
        <div className="text-sm text-slate-500 py-6 text-center bg-white border-2 border-dashed border-slate-200 rounded">
          No batches yet. {canManage && (
            <button
              className="underline text-slate-700 hover:text-slate-900"
              onClick={() => onAddBatch(product)}
            >
              Click here to log the first shipment.
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {batches.map((b) => (
            <BatchCard
              key={b.id}
              batch={b}
              canManage={canManage}
              onEdit={(batch) => onEditBatch(product, batch)}
              onDelete={(batch) => onDeleteBatch(product, batch)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PIN prompt — a promise-based imperative dialog
// ---------------------------------------------------------------------------

function PinPromptDialog({ open, onClose, onSuccess }) {
  const [pin, setPin] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setPin(''); setErr('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const submit = async () => {
    if (!pin.trim()) { setErr('Enter your staff PIN'); return; }
    setVerifying(true); setErr('');
    try {
      const res = await axios.post(
        `${API}/warehouse/pin-session`,
        { pin: pin.trim() },
        { headers: getAuthHeader() },
      );
      writePinSession(res.data);
      toast.success(`PIN verified — ${res.data.staff_name}`);
      onSuccess(res.data);
    } catch (e) {
      const msg = e.response?.data?.detail || 'PIN verification failed';
      setErr(msg);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm" data-testid="warehouse-pin-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="w-5 h-5 text-slate-700" />
            Enter your staff PIN
          </DialogTitle>
          <DialogDescription>
            Warehouse changes are audited. Enter your PIN to authorise this action —
            the PIN holder is recorded on every adjustment.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            className="text-center text-2xl tracking-[0.5em] font-mono h-14"
            placeholder="••••"
            maxLength={6}
            data-testid="warehouse-pin-input"
          />
          {err && (
            <div
              className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2 text-center leading-snug"
              data-testid="warehouse-pin-error"
            >
              {err}
            </div>
          )}
          <div className="text-xs text-slate-500 text-center">
            Once verified, further changes in this browser tab are unlocked for 15 minutes.
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={verifying}>Cancel</Button>
          <Button onClick={submit} disabled={verifying || !pin} data-testid="warehouse-pin-submit-btn">
            {verifying ? 'Verifying…' : 'Verify PIN'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function Warehouse() {
  const [info, setInfo] = useState(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [showrooms, setShowrooms] = useState([]);

  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, 300);
  const [searching, setSearching] = useState(false);
  const [products, setProducts] = useState([]);
  const [expanded, setExpanded] = useState({});

  const [adjustments, setAdjustments] = useState([]);
  const [historyExpanded, setHistoryExpanded] = useState(false);

  // PIN gate
  const [pinPromptOpen, setPinPromptOpen] = useState(false);
  const [pinSession, setPinSession] = useState(readPinSession());
  // Queued action to run once PIN is validated
  const pendingActionRef = useRef(null);

  // Dialog state
  const [addStockOpen, setAddStockOpen] = useState(false);
  const [addBatchState, setAddBatchState] = useState(null);
  const [editBatchState, setEditBatchState] = useState(null);
  const [deleteBatchState, setDeleteBatchState] = useState(null);
  const [adjustState, setAdjustState] = useState(null);
  const [editAdjState, setEditAdjState] = useState(null);
  const [reverseAdjState, setReverseAdjState] = useState(null);
  const [timelineAdjState, setTimelineAdjState] = useState(null);
  const [requestState, setRequestState] = useState(null);

  const canManage = !!info?.can_manage;

  /** ensureFreshPin(cb) — call cb(session) if PIN is fresh; otherwise open PIN
   * dialog first and cb runs after successful verify. */
  const ensureFreshPin = useCallback((cb) => {
    const s = readPinSession();
    if (s) {
      setPinSession(s);
      cb(s);
    } else {
      pendingActionRef.current = cb;
      setPinPromptOpen(true);
    }
  }, []);

  const onPinVerified = useCallback((session) => {
    setPinSession(session);
    setPinPromptOpen(false);
    const cb = pendingActionRef.current;
    pendingActionRef.current = null;
    if (cb) cb(session);
  }, []);

  const clearPin = () => {
    writePinSession(null);
    setPinSession(null);
    toast.info('PIN session cleared');
  };

  const loadInfo = useCallback(async () => {
    setLoadingInfo(true);
    try {
      const [infoRes, storesRes] = await Promise.all([
        axios.get(`${API}/warehouse/info`, { headers: getAuthHeader() }),
        axios.get(`${API}/showrooms`, { headers: getAuthHeader() }),
      ]);
      setInfo(infoRes.data);
      setShowrooms((storesRes.data || []).filter(s => !s.is_warehouse));
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

  const refreshAll = useCallback(async () => {
    await Promise.all([searchProducts(debouncedQuery), loadAdjustments()]);
  }, [searchProducts, debouncedQuery, loadAdjustments]);

  const warehouseName = info?.warehouse?.name || 'Tonbridge Warehouse';
  const visibleHistory = useMemo(
    () => historyExpanded ? adjustments : adjustments.slice(0, 8),
    [adjustments, historyExpanded],
  );

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6" data-testid="warehouse-page">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
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
        <div className="flex gap-2 items-center">
          {canManage && pinSession && (
            <div
              className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-800"
              data-testid="warehouse-pin-status"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              PIN: {pinSession.staff_name}
              <button
                onClick={clearPin}
                className="ml-1 underline hover:no-underline"
                data-testid="warehouse-pin-clear"
              >
                lock
              </button>
            </div>
          )}
          {canManage && (
            <Button
              onClick={() => ensureFreshPin(() => setAddStockOpen(true))}
              className="bg-slate-900 hover:bg-slate-800"
              data-testid="warehouse-add-stock-btn"
            >
              <Plus className="w-4 h-4 mr-1" /> Add stock
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={refreshAll} data-testid="warehouse-refresh-btn">
            <RefreshCw className="w-4 h-4 mr-1" /> Refresh
          </Button>
        </div>
      </div>

      {!loadingInfo && !canManage && (
        <Card className="p-4 bg-blue-50 border-blue-200 flex items-start gap-3">
          <Info className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-blue-900">
            You have <strong>view-only</strong> access to warehouse stock. To request stock for your
            store, click <strong>Request from Warehouse</strong> on any product below.
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
          Type at least one character to see live warehouse stock. Click a product to see its batches.
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
            {canManage && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => ensureFreshPin(() => setAddStockOpen(true))}
                data-testid="warehouse-empty-add-btn"
              >
                <Plus className="w-4 h-4 mr-1" /> Add a new product
              </Button>
            )}
          </div>
        )}
        {!debouncedQuery && (
          <div className="p-10 text-center text-slate-400" data-testid="warehouse-empty-state">
            <Search className="w-10 h-10 mx-auto mb-3" />
            <p className="text-sm">Start typing a product name or SKU to see warehouse stock.</p>
          </div>
        )}
        {products.length > 0 && (
          <div className="divide-y divide-slate-100" data-testid="warehouse-results-list">
            {products.map((p) => {
              const isOpen = !!expanded[p.id];
              return (
                <div key={p.id} data-testid={`warehouse-row-${p.sku || p.id}`}>
                  <div
                    className="flex items-center gap-3 py-3 px-4 hover:bg-slate-50/70 cursor-pointer"
                    onClick={() => setExpanded({ ...expanded, [p.id]: !isOpen })}
                    data-testid={`warehouse-row-toggle-${p.sku || p.id}`}
                  >
                    <div className="w-6 text-slate-400">
                      <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? '' : '-rotate-90'}`} />
                    </div>
                    <div className="w-12 h-12 bg-slate-100 rounded flex items-center justify-center overflow-hidden flex-shrink-0">
                      {p.image ? (
                        <img src={p.image} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <ImageIcon className="w-5 h-5 text-slate-300" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-slate-900 truncate">{p.name}</div>
                      <div className="text-xs text-slate-500 font-mono flex flex-wrap items-center gap-1.5 mt-0.5">
                        <span>{p.sku || '—'}</span>
                        {p.category_name && <span className="text-slate-400">· {p.category_name}</span>}
                        {p.warehouse_location && (
                          <span
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 rounded text-blue-900 font-medium"
                            data-testid={`warehouse-product-location-${p.sku || p.id}`}
                          >
                            <MapPin className="w-3 h-3" /> {p.warehouse_location}
                          </span>
                        )}
                      </div>
                      <CoverageLine product={p} />
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="flex items-center gap-2 justify-end">
                        <Badge variant="secondary" className="text-xs">
                          {p.batch_count} batch{p.batch_count === 1 ? '' : 'es'}
                        </Badge>
                        <StockBadge stock={p.warehouse_stock} unit={p.unit} />
                      </div>
                      {p.last_adjusted_at && (
                        <div className="text-xs text-slate-400 mt-1">
                          Last: {formatDateTime(p.last_adjusted_at)}
                        </div>
                      )}
                    </div>
                    <div className="flex gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                      {canManage && (
                        <Button
                          size="sm" variant="outline"
                          onClick={() => ensureFreshPin(() => setAdjustState({ product: p }))}
                          data-testid={`warehouse-adjust-btn-${p.sku || p.id}`}
                        >
                          <Sliders className="w-3.5 h-3.5 mr-1.5" /> Adjust
                        </Button>
                      )}
                      <Button
                        size="sm" variant="ghost"
                        disabled={(p.warehouse_stock ?? 0) === 0}
                        onClick={() => setRequestState({ product: p })}
                        data-testid={`warehouse-request-btn-${p.sku || p.id}`}
                        title={(p.warehouse_stock ?? 0) === 0 ? 'No stock to request' : 'Request from warehouse'}
                      >
                        <Send className="w-3.5 h-3.5 mr-1" /> Request
                      </Button>
                    </div>
                  </div>
                  {isOpen && (
                    <BatchesPanel
                      product={p}
                      canManage={canManage}
                      onAddBatch={(product) => ensureFreshPin(() => setAddBatchState({ product }))}
                      onEditBatch={(product, batch) => ensureFreshPin(() => setEditBatchState({ product, batch }))}
                      onDeleteBatch={(product, batch) => ensureFreshPin(() => setDeleteBatchState({ product, batch }))}
                    />
                  )}
                </div>
              );
            })}
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
              variant="ghost" size="sm"
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
                  <th className="text-right py-2 px-4 w-24">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visibleHistory.map((a) => (
                  <tr
                    key={a.id}
                    className={`border-t border-slate-100 ${a.reversed ? 'bg-slate-50/60' : ''}`}
                    data-testid={`warehouse-history-row-${a.id}`}
                  >
                    <td className="py-2 px-4 text-xs text-slate-500 whitespace-nowrap">
                      {formatDateTime(a.created_at)}
                    </td>
                    <td className="py-2 px-4">
                      <div className={`font-medium ${a.reversed ? 'text-slate-400 line-through' : 'text-slate-900'}`}>
                        {a.product_name}
                      </div>
                      <div className="text-xs font-mono text-slate-400">{a.product_sku || ''}</div>
                    </td>
                    <td className={`py-2 px-4 text-right whitespace-nowrap ${a.reversed ? 'text-slate-400 line-through' : 'text-slate-600'}`}>
                      {a.before_qty} → <strong>{a.after_qty}</strong>
                    </td>
                    <td className="py-2 px-4 text-right whitespace-nowrap">
                      <span className={`${a.reversed ? 'line-through text-slate-400' : a.delta > 0 ? 'text-emerald-700' : a.delta < 0 ? 'text-red-700' : 'text-slate-500'}`}>
                        {a.delta > 0 ? '+' : ''}{a.delta}
                      </span>
                    </td>
                    <td className="py-2 px-4">
                      <div className={`${a.reversed ? 'text-slate-400 line-through' : 'text-slate-700'}`}>
                        {REASON_LABELS[a.reason] || a.reason}
                      </div>
                      {a.note && <div className="text-xs text-slate-400 italic">&ldquo;{a.note}&rdquo;</div>}
                      {a.reversed && (
                        <div
                          className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-red-100 text-red-800 border border-red-200"
                          title={`Reversed at ${formatDateTime(a.reversed_at)} by ${a.reversed_by_pin || a.reversed_by_email || 'unknown'}`}
                          data-testid={`warehouse-history-reversed-${a.id}`}
                        >
                          Reversed
                        </div>
                      )}
                      {a.last_edited_at && !a.reversed && (
                        <div
                          className="inline-flex items-center gap-1 mt-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-800 border border-amber-200"
                          title={`Edited at ${formatDateTime(a.last_edited_at)} by ${a.last_edited_by_pin || 'unknown'}`}
                          data-testid={`warehouse-history-edited-${a.id}`}
                        >
                          Edited
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-4 text-xs text-slate-500">
                      <div>{a.actor_name || a.actor_email}</div>
                      {a.authorised_by_pin && (
                        <div className="text-emerald-700 flex items-center gap-1 mt-0.5">
                          <UserIcon className="w-3 h-3" />
                          PIN: {a.authorised_by_pin}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-4">
                      {/* Row-level actions — every click is PIN-gated. */}
                      {/* Reversed rows are read-only history — a compensating */}
                      {/* row already lives elsewhere in the audit trail. */}
                      {a.reversed ? (
                        <div className="flex items-center justify-end gap-1">
                          {(a.edit_history?.length > 0 || a.reversed) && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-slate-500 hover:text-indigo-700 hover:bg-indigo-50"
                              title="View timeline"
                              onClick={() => setTimelineAdjState(a)}
                              data-testid={`warehouse-history-timeline-${a.id}`}
                            >
                              <History className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {/* Delete still works on reversed rows so the owner */}
                          {/* can clean up an old compensating chain. */}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-slate-500 hover:text-red-700 hover:bg-red-50"
                            title="Delete this row (also cleans up the linked compensating row)"
                            onClick={() => ensureFreshPin(() => setReverseAdjState(a))}
                            data-testid={`warehouse-history-reverse-${a.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-1">
                          {/* Timeline — only shown when there's something to */}
                          {/* see (edited or has a reversal back-link). Keeps */}
                          {/* the actions column tidy for plain rows. */}
                          {(a.edit_history?.length > 0 || a.reverses_adjustment_id) && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-slate-500 hover:text-indigo-700 hover:bg-indigo-50 relative"
                              title={a.edit_history?.length > 1
                                ? `View timeline — ${a.edit_history.length} edits`
                                : (a.edit_history?.length === 1
                                    ? 'View timeline — 1 edit'
                                    : 'View timeline — reversal record')}
                              onClick={() => setTimelineAdjState(a)}
                              data-testid={`warehouse-history-timeline-${a.id}`}
                            >
                              <History className="h-3.5 w-3.5" />
                              {a.edit_history?.length > 1 && (
                                <span className="absolute -top-1 -right-1 h-3.5 min-w-[14px] px-0.5 rounded-full bg-indigo-600 text-white text-[9px] font-bold leading-[14px] text-center">
                                  {a.edit_history.length}
                                </span>
                              )}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-slate-500 hover:text-amber-700 hover:bg-amber-50"
                            title="Edit reason / note"
                            onClick={() => ensureFreshPin(() => setEditAdjState(a))}
                            data-testid={`warehouse-history-edit-${a.id}`}
                          >
                            <Edit2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-slate-500 hover:text-red-700 hover:bg-red-50"
                            title="Delete this adjustment"
                            onClick={() => ensureFreshPin(() => setReverseAdjState(a))}
                            data-testid={`warehouse-history-reverse-${a.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                          {a.product_id && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                              title="Open Adjust dialog for this product"
                              onClick={() => ensureFreshPin(() => setAdjustState({
                                product: {
                                  id: a.product_id,
                                  name: a.product_name,
                                  sku: a.product_sku,
                                  warehouse_stock: a.after_qty,
                                },
                              }))}
                              data-testid={`warehouse-history-adjust-${a.id}`}
                            >
                              <ArrowUpDown className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Dialogs */}
      <PinPromptDialog
        open={pinPromptOpen}
        onClose={() => { setPinPromptOpen(false); pendingActionRef.current = null; }}
        onSuccess={onPinVerified}
      />
      <AddStockDialog
        open={addStockOpen}
        pinSession={pinSession}
        onOpenChange={setAddStockOpen}
        onDone={() => { setAddStockOpen(false); refreshAll(); }}
      />
      <AddBatchDialog
        state={addBatchState}
        pinSession={pinSession}
        onOpenChange={(o) => { if (!o) setAddBatchState(null); }}
        onDone={() => { setAddBatchState(null); refreshAll(); }}
      />
      <EditBatchDialog
        state={editBatchState}
        pinSession={pinSession}
        onOpenChange={(o) => { if (!o) setEditBatchState(null); }}
        onDone={() => { setEditBatchState(null); refreshAll(); }}
      />
      <DeleteBatchDialog
        state={deleteBatchState}
        pinSession={pinSession}
        onOpenChange={(o) => { if (!o) setDeleteBatchState(null); }}
        onDone={() => { setDeleteBatchState(null); refreshAll(); }}
      />
      <AdjustDialog
        state={adjustState}
        reasons={info?.reasons || []}
        pinSession={pinSession}
        onOpenChange={(o) => { if (!o) setAdjustState(null); }}
        onDone={() => { setAdjustState(null); refreshAll(); }}
      />
      <RequestDialog
        state={requestState}
        showrooms={showrooms}
        onOpenChange={(o) => { if (!o) setRequestState(null); }}
        onDone={() => setRequestState(null)}
      />
      <EditAdjustmentDialog
        state={editAdjState}
        pinSession={pinSession}
        onOpenChange={(o) => { if (!o) setEditAdjState(null); }}
        onDone={() => { setEditAdjState(null); refreshAll(); }}
      />
      <ReverseAdjustmentDialog
        state={reverseAdjState}
        pinSession={pinSession}
        onOpenChange={(o) => { if (!o) setReverseAdjState(null); }}
        onDone={() => { setReverseAdjState(null); refreshAll(); }}
      />
      <TimelineDialog
        state={timelineAdjState}
        allAdjustments={adjustments}
        onOpenChange={(o) => { if (!o) setTimelineAdjState(null); }}
      />
    </div>
  );
}

// ===========================================================================
// AddStockDialog
// ===========================================================================

function AddStockDialog({ open, pinSession, onOpenChange, onDone }) {
  const [tab, setTab] = useState('existing');
  const [pickedProduct, setPickedProduct] = useState(null);

  useEffect(() => {
    if (!open) {
      setTab('existing');
      setPickedProduct(null);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="warehouse-add-stock-dialog">
        <DialogHeader>
          <DialogTitle>Add stock to warehouse</DialogTitle>
          <DialogDescription>
            Log a new batch of tiles. Pick an existing product or create one on the fly.
          </DialogDescription>
        </DialogHeader>

        {!pickedProduct ? (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="w-full grid grid-cols-2">
              <TabsTrigger value="existing" data-testid="warehouse-tab-existing">
                <Search className="w-4 h-4 mr-1" /> Search existing
              </TabsTrigger>
              <TabsTrigger value="new" data-testid="warehouse-tab-new">
                <Plus className="w-4 h-4 mr-1" /> Create new
              </TabsTrigger>
            </TabsList>
            <TabsContent value="existing" className="pt-4">
              <ExistingProductPicker onPick={setPickedProduct} />
            </TabsContent>
            <TabsContent value="new" className="pt-4">
              <QuickAddProductForm pinSession={pinSession} onCreated={setPickedProduct} />
            </TabsContent>
          </Tabs>
        ) : (
          <BatchForm
            product={pickedProduct}
            pinSession={pinSession}
            onSuccess={onDone}
            onBack={() => setPickedProduct(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ExistingProductPicker({ onPick }) {
  const [q, setQ] = useState('');
  const debouncedQ = useDebounced(q, 250);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!debouncedQ) { setItems([]); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await axios.get(
          `${API}/warehouse/products?q=${encodeURIComponent(debouncedQ)}&limit=20`,
          { headers: getAuthHeader() },
        );
        if (!cancelled) setItems(res.data?.products || []);
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [debouncedQ]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
        <Input
          autoFocus
          className="pl-9"
          placeholder="Search product name or SKU…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="warehouse-existing-search-input"
        />
      </div>
      <div className="border rounded-md divide-y max-h-72 overflow-y-auto">
        {loading && <div className="p-3 text-sm text-slate-500">Searching…</div>}
        {!loading && debouncedQ && items.length === 0 && (
          <div className="p-3 text-sm text-slate-500">
            No products match. Switch to <strong>Create new</strong> above.
          </div>
        )}
        {items.map((p) => (
          <button
            key={p.id}
            type="button"
            className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center gap-3"
            onClick={() => onPick(p)}
            data-testid={`warehouse-existing-pick-${p.sku || p.id}`}
          >
            <div className="w-10 h-10 bg-slate-100 rounded flex items-center justify-center overflow-hidden flex-shrink-0">
              {p.image ? <img src={p.image} alt="" className="w-full h-full object-cover" /> : <Package className="w-4 h-4 text-slate-300" />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate">{p.name}</div>
              <div className="text-xs font-mono text-slate-500">{p.sku}</div>
            </div>
            <StockBadge stock={p.warehouse_stock} unit={p.unit} />
          </button>
        ))}
      </div>
    </div>
  );
}

function QuickAddProductForm({ onCreated, pinSession }) {
  const [name, setName] = useState('');
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState('');
  const [category, setCategory] = useState('');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [tilesPerBox, setTilesPerBox] = useState('');
  const [location, setLocation] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const upload = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await axios.post(`${API}/upload-image`, fd, {
        headers: { ...getAuthHeader(), 'Content-Type': 'multipart/form-data' },
      });
      setImageUrl(res.data.url);
      toast.success('Image uploaded');
    } catch (e) {
      toast.error('Upload failed');
    } finally { setUploading(false); }
  };

  const submit = async () => {
    if (!name.trim() || !sku.trim()) {
      toast.error('Name and SKU are required');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        sku: sku.trim(),
        barcode: barcode.trim() || null,
        category_name: category.trim() || null,
        tile_width: width ? parseFloat(width) : null,
        tile_height: height ? parseFloat(height) : null,
        tiles_per_box: tilesPerBox ? parseInt(tilesPerBox, 10) : null,
        image_url: imageUrl || null,
        warehouse_location: location.trim() || null,
        pin_session_token: pinSession?.session_token,
      };
      const res = await axios.post(`${API}/warehouse/products/quick-add`, payload, {
        headers: getAuthHeader(),
      });
      toast.success('Product created — now log the first batch');
      onCreated(res.data.product);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to create product');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">Name *</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Marble Effect 600x600"
            data-testid="warehouse-new-name" />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">SKU *</label>
          <Input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="e.g. WH-MARBLE-600"
            data-testid="warehouse-new-sku" />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">Category</label>
          <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Tiles"
            data-testid="warehouse-new-category" />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">Barcode</label>
          <Input value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="Optional"
            data-testid="warehouse-new-barcode" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">Tile width (mm)</label>
          <Input type="number" value={width} onChange={(e) => setWidth(e.target.value)} placeholder="600"
            data-testid="warehouse-new-width" />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">Tile height (mm)</label>
          <Input type="number" value={height} onChange={(e) => setHeight(e.target.value)} placeholder="600"
            data-testid="warehouse-new-height" />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">Tiles / box</label>
          <Input type="number" value={tilesPerBox} onChange={(e) => setTilesPerBox(e.target.value)} placeholder="4"
            data-testid="warehouse-new-tpb" />
        </div>
      </div>

      {width && height && (
        <div className="text-xs text-slate-500 -mt-2">
          Auto-calculated coverage: <strong>{((parseFloat(width) * parseFloat(height)) / 1000000).toFixed(3)} m²</strong> per tile
        </div>
      )}

      <div>
        <label className="text-xs font-medium text-slate-700 uppercase tracking-wide flex items-center gap-1">
          <MapPin className="w-3 h-3" /> Default warehouse location
        </label>
        <Input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="e.g. Rack A3-12, Yard Bay 4, Container 7"
          data-testid="warehouse-new-location"
          maxLength={100}
        />
        <p className="text-xs text-slate-400 mt-1">
          Where this product usually lives. New batches inherit this — you can override per batch.
        </p>
      </div>

      <div>
        <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">Product image</label>
        <div className="flex items-center gap-3 mt-1">
          <label className="cursor-pointer">
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => upload(e.target.files?.[0])}
              data-testid="warehouse-new-image-input"
            />
            <span className="inline-flex items-center px-3 py-2 border border-slate-300 rounded-md text-sm bg-white hover:bg-slate-50">
              <ImageIcon className="w-4 h-4 mr-1" /> {imageUrl ? 'Change image' : 'Upload image'}
            </span>
          </label>
          {uploading && <span className="text-xs text-slate-500">Uploading…</span>}
          {imageUrl && (
            <img src={imageUrl} alt="preview" className="w-12 h-12 object-cover rounded border" />
          )}
        </div>
        <p className="text-xs text-slate-400 mt-1">
          One image per product (tile pattern doesn&apos;t change per batch).
        </p>
      </div>

      <DialogFooter>
        <div className="text-xs text-slate-500 mr-auto flex items-center gap-1">
          <ExternalLink className="w-3 h-3" />
          <a href="/admin/products" target="_blank" rel="noreferrer" className="underline">
            Manage full product details on Products page
          </a>
        </div>
        <Button onClick={submit} disabled={saving} data-testid="warehouse-new-submit-btn">
          {saving ? 'Creating…' : 'Create product & add batch'}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ===========================================================================
// BatchForm
// ===========================================================================

function BatchForm({ product, pinSession, onSuccess, onBack }) {
  const [batchNumber, setBatchNumber] = useState('');
  const [boxes, setBoxes] = useState('0');
  const [tilesPerBox, setTilesPerBox] = useState(String(product.tiles_per_box || ''));
  const [extraPieces, setExtraPieces] = useState('0');
  const [location, setLocation] = useState(product.warehouse_location || '');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const b = parseInt(boxes, 10) || 0;
  const tpb = parseInt(tilesPerBox, 10) || 0;
  const extra = parseInt(extraPieces, 10) || 0;
  const totalPieces = b * tpb + extra;
  const totalM2 = product.tile_m2_per_piece ? totalPieces * product.tile_m2_per_piece : null;

  const submit = async () => {
    if (!batchNumber.trim()) { toast.error('Batch number is required'); return; }
    if (!tpb) { toast.error('Tiles per box must be at least 1'); return; }
    setSaving(true);
    try {
      await axios.post(`${API}/warehouse/batches`, {
        product_id: product.id,
        batch_number: batchNumber.trim(),
        boxes: b,
        tiles_per_box: tpb,
        extra_pieces: extra,
        location: location.trim() || null,
        notes: notes || null,
        pin_session_token: pinSession?.session_token,
      }, { headers: getAuthHeader() });
      toast.success(`Batch logged: +${totalPieces} pcs of ${product.name}`);
      onSuccess();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to create batch');
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 p-3 bg-slate-50 rounded border border-slate-200">
        <div className="w-12 h-12 bg-white rounded flex items-center justify-center overflow-hidden">
          {product.image ? <img src={product.image} alt="" className="w-full h-full object-cover" /> : <Package className="w-5 h-5 text-slate-300" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{product.name}</div>
          <div className="text-xs font-mono text-slate-500">{product.sku}</div>
        </div>
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>Change</Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">Batch number *</label>
          <Input
            value={batchNumber}
            onChange={(e) => setBatchNumber(e.target.value)}
            placeholder="e.g. BATCH-2026-04-A or supplier lot #"
            data-testid="warehouse-batch-number-input"
            autoFocus
          />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">Boxes</label>
          <Input type="number" min="0" value={boxes} onChange={(e) => setBoxes(e.target.value)}
            data-testid="warehouse-batch-boxes-input" />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">Tiles per box *</label>
          <Input type="number" min="1" value={tilesPerBox} onChange={(e) => setTilesPerBox(e.target.value)}
            data-testid="warehouse-batch-tpb-input" />
        </div>
        <div className="col-span-2">
          <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">Extra loose pieces</label>
          <Input type="number" min="0" value={extraPieces} onChange={(e) => setExtraPieces(e.target.value)}
            data-testid="warehouse-batch-extra-input" />
          <p className="text-xs text-slate-400 mt-1">
            Use this for part-boxes — e.g. 2 loose tiles left over from an opened box.
          </p>
        </div>
      </div>

      <div className="rounded-md bg-emerald-50 border border-emerald-200 p-3 text-sm">
        <div className="flex justify-between">
          <span className="text-emerald-900">Total pieces in this batch</span>
          <span className="font-bold text-emerald-900" data-testid="warehouse-batch-total-preview">
            {totalPieces} pcs
          </span>
        </div>
        {totalM2 != null && (
          <div className="flex justify-between mt-1">
            <span className="text-emerald-800 text-xs">Coverage</span>
            <span className="text-emerald-800 text-xs">≈ {totalM2.toFixed(2)} m²</span>
          </div>
        )}
        <div className="text-xs text-emerald-700 mt-1">
          {b} box{b === 1 ? '' : 'es'} × {tpb || 0}/box + {extra} loose = {totalPieces}
        </div>
      </div>

      <div>
        <label className="text-xs font-medium text-slate-700 uppercase tracking-wide flex items-center gap-1">
          <MapPin className="w-3 h-3" /> Location {product.warehouse_location && <span className="text-slate-400 normal-case font-normal">(default: {product.warehouse_location})</span>}
        </label>
        <Input
          value={location} onChange={(e) => setLocation(e.target.value)}
          placeholder="e.g. Rack A3-12, Yard Bay 4"
          maxLength={100}
          data-testid="warehouse-batch-location-input"
        />
      </div>

      <div>
        <label className="text-xs font-medium text-slate-700 uppercase tracking-wide">Notes (optional)</label>
        <Input
          value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Kepstan pallet #4231, arrived 15/07"
          maxLength={500}
          data-testid="warehouse-batch-notes-input"
        />
      </div>

      <DialogFooter>
        <Button onClick={submit} disabled={saving} data-testid="warehouse-batch-submit-btn">
          {saving ? 'Saving…' : 'Log batch'}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ===========================================================================
// AddBatchDialog
// ===========================================================================

function AddBatchDialog({ state, pinSession, onOpenChange, onDone }) {
  const open = !!state;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="warehouse-add-batch-dialog">
        <DialogHeader>
          <DialogTitle>Add batch</DialogTitle>
          <DialogDescription>Log a new shipment/dye lot for this product.</DialogDescription>
        </DialogHeader>
        {state && <BatchForm product={state.product} pinSession={pinSession} onSuccess={onDone} />}
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// EditBatchDialog
// ===========================================================================

function EditBatchDialog({ state, pinSession, onOpenChange, onDone }) {
  const open = !!state;
  const [batchNumber, setBatchNumber] = useState('');
  const [boxes, setBoxes] = useState('0');
  const [tilesPerBox, setTilesPerBox] = useState('1');
  const [extraPieces, setExtraPieces] = useState('0');
  const [location, setLocation] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('stocktake_correction');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (state?.batch) {
      setBatchNumber(state.batch.batch_number || '');
      setBoxes(String(state.batch.boxes ?? 0));
      setTilesPerBox(String(state.batch.tiles_per_box ?? 1));
      setExtraPieces(String(state.batch.extra_pieces ?? 0));
      setLocation(state.batch.location || '');
      setNotes(state.batch.notes || '');
      setReason('stocktake_correction');
    }
  }, [state]);

  const b = parseInt(boxes, 10) || 0;
  const tpb = parseInt(tilesPerBox, 10) || 0;
  const extra = parseInt(extraPieces, 10) || 0;
  const newTotal = b * tpb + extra;

  const submit = async () => {
    setSaving(true);
    try {
      await axios.put(`${API}/warehouse/batches/${state.batch.id}`, {
        batch_number: batchNumber.trim(),
        boxes: b,
        tiles_per_box: tpb,
        extra_pieces: extra,
        location: location.trim(),
        notes,
        reason,
        pin_session_token: pinSession?.session_token,
      }, { headers: getAuthHeader() });
      toast.success(`Batch updated: ${newTotal} pcs`);
      onDone();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to update batch');
    } finally { setSaving(false); }
  };

  if (!state) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="warehouse-edit-batch-dialog">
        <DialogHeader>
          <DialogTitle>Edit batch</DialogTitle>
          <DialogDescription>
            {state.product.name} · <span className="font-mono">{state.batch.batch_number}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-slate-700">Batch number</label>
            <Input value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)}
              data-testid="warehouse-edit-batch-number" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-slate-700">Boxes</label>
              <Input type="number" min="0" value={boxes} onChange={(e) => setBoxes(e.target.value)}
                data-testid="warehouse-edit-batch-boxes" />
            </div>
            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-slate-700">Tiles/box</label>
              <Input type="number" min="1" value={tilesPerBox} onChange={(e) => setTilesPerBox(e.target.value)}
                data-testid="warehouse-edit-batch-tpb" />
            </div>
            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-slate-700">Extra pcs</label>
              <Input type="number" min="0" value={extraPieces} onChange={(e) => setExtraPieces(e.target.value)}
                data-testid="warehouse-edit-batch-extra" />
            </div>
          </div>
          <div className="rounded-md bg-slate-50 p-2 text-sm flex justify-between">
            <span className="text-slate-500">New total</span>
            <span className="font-semibold" data-testid="warehouse-edit-batch-total">{newTotal} pcs</span>
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-slate-700">Reason</label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {BATCH_REASONS.map(r => (
                  <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-slate-700 flex items-center gap-1">
              <MapPin className="w-3 h-3" /> Location
            </label>
            <Input
              value={location} onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Rack A3-12"
              maxLength={100}
              data-testid="warehouse-edit-batch-location"
            />
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-slate-700">Notes</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving} data-testid="warehouse-edit-batch-submit-btn">
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// DeleteBatchDialog
// ===========================================================================

function DeleteBatchDialog({ state, pinSession, onOpenChange, onDone }) {
  const open = !!state;
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) setReason(''); }, [open]);

  const submit = async () => {
    setSaving(true);
    try {
      await axios.delete(
        `${API}/warehouse/batches/${state.batch.id}?reason=${encodeURIComponent(reason || 'No reason given')}`,
        {
          headers: {
            ...getAuthHeader(),
            'X-Warehouse-Pin': pinSession?.session_token || '',
          },
        },
      );
      toast.success(`Batch ${state.batch.batch_number} removed`);
      onDone();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to remove batch');
    } finally { setSaving(false); }
  };

  if (!state) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="warehouse-delete-batch-dialog">
        <DialogHeader>
          <DialogTitle>Remove batch?</DialogTitle>
          <DialogDescription>
            You&apos;re about to remove <strong>{state.batch.batch_number}</strong> ({state.batch.total_pieces} pcs)
            from {state.product.name}. This is a soft delete — the audit log keeps a record.
          </DialogDescription>
        </DialogHeader>
        <div>
          <label className="text-xs font-medium uppercase tracking-wide text-slate-700">Reason</label>
          <Input
            autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Sold out to Job #4523, or damaged pallet"
            data-testid="warehouse-delete-batch-reason"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="destructive" onClick={submit} disabled={saving}
            data-testid="warehouse-delete-batch-submit-btn"
          >
            {saving ? 'Removing…' : 'Remove batch'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// AdjustDialog
// ===========================================================================

function AdjustDialog({ state, reasons, pinSession, onOpenChange, onDone }) {
  const open = !!state;
  const [mode, setMode] = useState('set');
  const [qty, setQty] = useState('0');
  const [reason, setReason] = useState('delivery_received');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (state) {
      setMode('set');
      setQty(String(state.product.warehouse_stock ?? 0));
      setReason('delivery_received');
      setNote('');
    }
  }, [state]);

  if (!state) return null;
  const p = state.product;

  const submit = async () => {
    const n = parseInt(qty, 10);
    if (isNaN(n)) { toast.error('Enter a valid number'); return; }
    setSaving(true);
    try {
      const res = await axios.post(`${API}/warehouse/adjust`, {
        product_id: p.id, mode, quantity: n,
        reason, note: note || null,
        pin_session_token: pinSession?.session_token,
      }, { headers: getAuthHeader() });
      toast.success(`Stock: ${res.data.before_qty} → ${res.data.after_qty}`, {
        description: 'Note: this bypasses batches — best used for stocktake corrections.',
      });
      onDone();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to adjust');
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="warehouse-adjust-dialog">
        <DialogHeader>
          <DialogTitle>Quick adjust total</DialogTitle>
          <DialogDescription>
            {p.name} · <span className="font-mono">{p.sku}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md bg-amber-50 border border-amber-200 p-2 text-xs text-amber-900">
            This adjusts the aggregated total directly and does NOT touch batches.
            For a new shipment, use <strong>Add batch</strong> instead.
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={mode === 'set' ? 'default' : 'outline'}
              onClick={() => setMode('set')}
              data-testid="warehouse-adjust-mode-set"
            >Set to</Button>
            <Button
              type="button"
              variant={mode === 'delta' ? 'default' : 'outline'}
              onClick={() => setMode('delta')}
              data-testid="warehouse-adjust-mode-delta"
            >Add / remove (±)</Button>
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-slate-700">
              {mode === 'set' ? 'New quantity' : 'Change (± value)'}
            </label>
            <Input
              type="number" value={qty} onChange={(e) => setQty(e.target.value)}
              data-testid="warehouse-adjust-qty-input"
            />
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-slate-700">Reason</label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger data-testid="warehouse-adjust-reason-trigger"><SelectValue /></SelectTrigger>
              <SelectContent>
                {reasons.map(r => (
                  <SelectItem key={r.key} value={r.key} data-testid={`warehouse-adjust-reason-${r.key}`}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-slate-700">Note</label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
              data-testid="warehouse-adjust-note-input" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving} data-testid="warehouse-adjust-submit-btn">
            {saving ? 'Saving…' : 'Save adjustment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// RequestDialog
// ===========================================================================

function RequestDialog({ state, showrooms, onOpenChange, onDone }) {
  const open = !!state;
  const [store, setStore] = useState('');
  const [qty, setQty] = useState('1');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (state) { setStore(''); setQty('1'); setNote(''); }
  }, [state]);

  if (!state) return null;
  const p = state.product;

  const submit = async () => {
    if (!store) { toast.error('Pick a destination store'); return; }
    const n = parseInt(qty, 10);
    if (isNaN(n) || n <= 0) { toast.error('Quantity must be positive'); return; }
    setSaving(true);
    try {
      await axios.post(`${API}/warehouse/request-transfer`, {
        to_showroom_id: store,
        product_id: p.id,
        sku: p.sku,
        name: p.name,
        quantity: n,
        notes: note || null,
      }, { headers: getAuthHeader() });
      const storeName = showrooms.find(s => s.id === store)?.name || 'store';
      toast.success(`Requested ${n} × ${p.name} → ${storeName}`);
      onDone();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to raise request');
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="warehouse-request-dialog">
        <DialogHeader>
          <DialogTitle>Request from Warehouse</DialogTitle>
          <DialogDescription>
            {p.name} · in stock: {p.warehouse_stock ?? 0}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-slate-700">Destination store</label>
            <Select value={store} onValueChange={setStore}>
              <SelectTrigger data-testid="warehouse-request-store-trigger">
                <SelectValue placeholder="Select store…" />
              </SelectTrigger>
              <SelectContent>
                {showrooms.map(s => (
                  <SelectItem key={s.id} value={s.id} data-testid={`warehouse-request-store-${s.id}`}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-slate-700">Quantity</label>
            <Input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)}
              data-testid="warehouse-request-qty-input" />
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-slate-700">Notes</label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
              data-testid="warehouse-request-note-input" />
          </div>
          <div className="rounded-md bg-amber-50 border border-amber-200 p-2 text-xs text-amber-900">
            This raises a pending stock transfer. Warehouse team picks/packs from Stock Transfers.
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !store} data-testid="warehouse-request-submit-btn">
            {saving ? 'Sending…' : 'Send request'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


// ===========================================================================
// EditAdjustmentDialog — FULL editor. Every field can be corrected.
// ===========================================================================
// The owner asked (23 Jul 2026) for every field to be changeable — including
// product name, before/after quantities and delta. Behaviour:
//   • Reason / Note — pure metadata, no stock math impact.
//   • Before / After — recomputes delta, and re-normalises the product's
//     current warehouse stock by (new_delta − old_delta) so the running
//     total matches the row's new numbers.
//   • Product name — updates the linked product globally (propagates to
//     every other page that shows the product).
// Every changed field is snapshotted in the row's `edit_history` array
// so nothing is truly lost — the trail keeps the diff.

function EditAdjustmentDialog({ state, pinSession, onOpenChange, onDone }) {
  const open = !!state;
  const [productName, setProductName] = useState('');
  const [beforeQty, setBeforeQty] = useState('');
  const [afterQty, setAfterQty] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (state) {
      setProductName(state.product_name || '');
      setBeforeQty(String(state.before_qty ?? 0));
      setAfterQty(String(state.after_qty ?? 0));
      setReason(state.reason || '');
      setNote(state.note || '');
    }
  }, [state]);

  if (!state) return null;

  // Live-computed diff so the user sees exactly what will change before saving.
  const beforeNum = parseInt(beforeQty, 10);
  const afterNum = parseInt(afterQty, 10);
  const numericValid = Number.isFinite(beforeNum) && Number.isFinite(afterNum);
  const newDelta = numericValid ? (afterNum - beforeNum) : (state.delta ?? 0);
  const oldDelta = state.delta ?? 0;
  const deltaShift = newDelta - oldDelta;
  const numericChanged = numericValid && (beforeNum !== state.before_qty || afterNum !== state.after_qty);
  const nameChanged = productName.trim() && productName.trim() !== state.product_name;
  const anythingChanged = numericChanged || nameChanged
    || (reason.trim() && reason.trim() !== state.reason)
    || (note !== state.note);

  const submit = async () => {
    if (!reason.trim()) { toast.error('Reason cannot be empty'); return; }
    if (!numericValid) { toast.error('Before / After must be valid numbers'); return; }
    setSaving(true);
    try {
      const body = {
        pin_session_token: pinSession?.session_token,
        reason: reason.trim(),
        note,
        before_qty: beforeNum,
        after_qty: afterNum,
        product_name: productName.trim() || null,
      };
      await axios.patch(
        `${API}/warehouse/adjustments/${state.id}`,
        body,
        { headers: getAuthHeader() },
      );
      toast.success('Adjustment updated', {
        description: `PIN: ${pinSession?.staff_name}`,
      });
      onDone();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to update');
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="warehouse-edit-adjustment-dialog">
        <DialogHeader>
          <DialogTitle>Edit adjustment — full editor</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{state.product_sku}</span>
            <span className="block text-xs text-slate-500 mt-1">
              Original: {state.before_qty} → <strong>{state.after_qty}</strong>{'  '}
              <span className={state.delta > 0 ? 'text-emerald-700' : 'text-red-700'}>
                ({state.delta > 0 ? '+' : ''}{state.delta})
              </span>
              {'  '}· {formatDateTime(state.created_at)}
            </span>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md bg-amber-50 border border-amber-200 p-2 text-xs text-amber-900">
            Every field below is editable. Changes to quantities or product
            name are logged with your PIN and the previous values are kept in
            the row&apos;s <strong>edit history</strong>. To wipe out the
            adjustment entirely, use <strong>Reverse</strong> instead.
          </div>

          {/* Product name — global change */}
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-slate-700">
              Product name
              {nameChanged && (
                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 border border-orange-200 normal-case tracking-normal font-semibold">
                  will update everywhere
                </span>
              )}
            </label>
            <Input
              value={productName}
              onChange={(e) => setProductName(e.target.value)}
              maxLength={200}
              data-testid="warehouse-edit-adjustment-product-name-input"
            />
          </div>

          {/* Before / After */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-slate-700">Before qty</label>
              <Input
                type="number"
                value={beforeQty}
                onChange={(e) => setBeforeQty(e.target.value)}
                data-testid="warehouse-edit-adjustment-before-input"
              />
            </div>
            <div>
              <label className="text-xs font-medium uppercase tracking-wide text-slate-700">After qty</label>
              <Input
                type="number"
                value={afterQty}
                onChange={(e) => setAfterQty(e.target.value)}
                data-testid="warehouse-edit-adjustment-after-input"
              />
            </div>
          </div>

          {/* Live delta preview */}
          <div className="flex items-center justify-between text-xs bg-slate-50 border border-slate-200 rounded px-3 py-2">
            <span className="text-slate-500">New delta</span>
            <span
              className={`font-mono font-semibold ${newDelta > 0 ? 'text-emerald-700' : newDelta < 0 ? 'text-red-700' : 'text-slate-500'}`}
              data-testid="warehouse-edit-adjustment-new-delta"
            >
              {newDelta > 0 ? '+' : ''}{newDelta}
              {numericChanged && (
                <span className="ml-2 text-[10px] text-slate-500 font-normal">
                  (was {oldDelta > 0 ? '+' : ''}{oldDelta} · stock will shift by {deltaShift > 0 ? '+' : ''}{deltaShift})
                </span>
              )}
            </span>
          </div>

          {/* Reason */}
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-slate-700">Reason</label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={200}
              data-testid="warehouse-edit-adjustment-reason-input"
            />
          </div>

          {/* Note */}
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-slate-700">Note</label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={500}
              data-testid="warehouse-edit-adjustment-note-input"
            />
          </div>

          {pinSession?.staff_name && (
            <div className="text-xs text-slate-500">
              Authorised by PIN: <strong className="text-slate-700">{pinSession.staff_name}</strong>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={saving || !reason.trim() || !anythingChanged}
            data-testid="warehouse-edit-adjustment-submit-btn"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


// ===========================================================================
// ReverseAdjustmentDialog — hard-delete the row (soft-delete on the backend)
// ===========================================================================
// 23 Jul 2026 rework: the previous implementation booked a compensating row
// which caused "Reversed adj X" rows to multiply every time the owner
// clicked the trash icon. New semantics: the row is soft-deleted, the
// stock is rolled back to as-if the row never happened, and the row
// disappears from the Recent Adjustments panel entirely. When a row is
// part of a previously-reversed pair, both rows are cleaned up together.

function ReverseAdjustmentDialog({ state, pinSession, onOpenChange, onDone }) {
  const open = !!state;
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (state) setNote('');
  }, [state]);

  if (!state) return null;

  // Preview the stock change the delete will apply — helps the user
  // understand what's about to happen before they commit.
  const isCompensating = !!state.reverses_adjustment_id;
  const isReversedOriginal = !!state.reversed && !!state.reversed_adjustment_id;
  const stockRollback = (isCompensating)
    ? -(state.delta || 0)
    : (isReversedOriginal ? 0 : -(state.delta || 0));

  const submit = async () => {
    setSaving(true);
    try {
      const res = await axios.post(
        `${API}/warehouse/adjustments/${state.id}/reverse`,
        { pin_session_token: pinSession?.session_token, note: note || null },
        { headers: getAuthHeader() },
      );
      const removed = res.data.deleted_ids?.length || 1;
      toast.success(
        removed > 1
          ? `Deleted ${removed} linked rows`
          : 'Adjustment deleted',
        { description: `PIN: ${pinSession?.staff_name}` }
      );
      onDone();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to delete');
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="warehouse-reverse-adjustment-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-700">
            <Trash2 className="w-5 h-5" />
            Delete this adjustment?
          </DialogTitle>
          <DialogDescription>
            {state.product_name} · <span className="font-mono">{state.product_sku}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-900">
            <div className="font-semibold mb-1">This row will be removed from Recent adjustments.</div>
            <div className="text-xs">
              Change: <span className="font-mono">{state.before_qty} → {state.after_qty}</span>{' '}
              (<span className={state.delta > 0 ? 'text-emerald-700' : 'text-red-700'}>
                {state.delta > 0 ? '+' : ''}{state.delta}
              </span>)
            </div>
            <div className="mt-2 text-xs">
              {stockRollback === 0
                ? 'Stock is unchanged — this row was part of a previously-reversed pair; both rows will be cleaned up together.'
                : `Stock will change by ${stockRollback > 0 ? '+' : ''}${stockRollback} to undo this row's effect.`}
            </div>
            {isCompensating && (
              <div className="mt-2 text-xs">
                Deleting a compensating row will also un-mark the original as reversed.
              </div>
            )}
          </div>
          <div>
            <label className="text-xs font-medium uppercase tracking-wide text-slate-700">
              Note (optional — why are you deleting?)
            </label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Duplicate entry — batch was double-counted"
              maxLength={500}
              data-testid="warehouse-reverse-adjustment-note-input"
            />
          </div>
          {pinSession?.staff_name && (
            <div className="text-xs text-slate-500">
              Authorised by PIN: <strong className="text-slate-700">{pinSession.staff_name}</strong>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={saving}
            className="bg-red-600 hover:bg-red-700 text-white"
            data-testid="warehouse-reverse-adjustment-submit-btn"
          >
            {saving ? 'Deleting…' : 'Delete adjustment'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ===========================================================================
// TimelineDialog — full lifecycle of an adjustment
// ===========================================================================
// Turns the audit trail from "I know it changed" into "I know exactly what
// changed, when, and by whom" in a single glance. Sources of truth (all
// already stored on the doc — no new API):
//   • state.created_at + original fields → the "Booked" event
//   • state.edit_history[]              → each edit event with field-level diff
//   • state.reversed / reversed_at      → the "Reversed" event
//   • state.reversed_adjustment_id      → link to the compensating row
//   • state.reverses_adjustment_id      → link to the original this row reverses
// Events are rendered chronologically with red strikethrough for old values
// and green highlight for new values, plus the PIN name of whoever did it.

function TimelineDialog({ state, allAdjustments, onOpenChange }) {
  const open = !!state;
  if (!state) return null;

  const FIELD_LABELS = {
    reason: 'Reason',
    note: 'Note',
    before_qty: 'Before qty',
    after_qty: 'After qty',
    delta: 'Delta',
    product_name: 'Product name',
  };

  const formatVal = (k, v) => {
    if (v == null || v === '') return <em className="text-slate-400">(empty)</em>;
    if (k === 'delta' && typeof v === 'number') return (v > 0 ? '+' : '') + v;
    return String(v);
  };

  // Build an ordered event list. Sort by timestamp so any interleaving reads
  // chronologically without callers having to care about ordering rules.
  const events = [];

  events.push({
    kind: 'booked',
    ts: state.created_at,
    who: state.authorised_by_pin || state.actor_name || state.actor_email,
    payload: {
      product_name: state.edit_history?.[0]?.previous_values?.product_name ?? state.product_name,
      reason: state.edit_history?.[0]?.previous_values?.reason ?? state.reason,
      note: state.edit_history?.[0]?.previous_values?.note ?? state.note,
      before_qty: state.edit_history?.[0]?.previous_values?.before_qty ?? state.before_qty,
      after_qty: state.edit_history?.[0]?.previous_values?.after_qty ?? state.after_qty,
      delta: state.edit_history?.[0]?.previous_values?.delta ?? state.delta,
    },
    mode: state.mode,
  });

  (state.edit_history || []).forEach((e, idx) => {
    events.push({
      kind: 'edited',
      ts: e.edited_at,
      who: e.edited_by_pin || e.edited_by_email,
      previous: e.previous_values || {},
      next: e.new_values || {},
      index: idx + 1,
    });
  });

  if (state.reversed) {
    events.push({
      kind: 'reversed',
      ts: state.reversed_at,
      who: state.reversed_by_pin || state.reversed_by_email,
      compensating_id: state.reversed_adjustment_id,
    });
  }

  events.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  // Resolve linked compensating / original row (for the little "See row" links)
  const compensating = state.reversed_adjustment_id
    ? allAdjustments.find(r => r.id === state.reversed_adjustment_id)
    : null;
  const reverses = state.reverses_adjustment_id
    ? allAdjustments.find(r => r.id === state.reverses_adjustment_id)
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto" data-testid="warehouse-timeline-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="w-5 h-5 text-indigo-600" />
            Adjustment timeline
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium">{state.product_name}</span> · <span className="font-mono text-xs">{state.product_sku}</span>
            <span className="block text-xs text-slate-500 mt-0.5">
              {events.length} event{events.length === 1 ? '' : 's'} · row id <span className="font-mono">{state.id.slice(0, 8)}</span>
            </span>
          </DialogDescription>
        </DialogHeader>

        {(reverses || compensating) && (
          <div className="mb-2 rounded-md bg-indigo-50 border border-indigo-200 p-2 text-xs text-indigo-900 space-y-1">
            {reverses && (
              <div>
                This row reverses adjustment <span className="font-mono">{reverses.id.slice(0, 8)}</span>{' '}
                (<em>{reverses.reason}</em>, delta {reverses.delta > 0 ? '+' : ''}{reverses.delta}) from {formatDateTime(reverses.created_at)}.
              </div>
            )}
            {compensating && (
              <div>
                Compensating row <span className="font-mono">{compensating.id.slice(0, 8)}</span>{' '}
                (delta {compensating.delta > 0 ? '+' : ''}{compensating.delta}) was booked on {formatDateTime(compensating.created_at)}.
              </div>
            )}
          </div>
        )}

        <div className="relative pl-4">
          {/* Vertical timeline line */}
          <div className="absolute left-[7px] top-2 bottom-2 w-px bg-slate-200" />

          {events.map((ev, i) => (
            <div key={i} className="relative pb-4 last:pb-0" data-testid={`warehouse-timeline-event-${i}`}>
              {/* Timeline dot */}
              <div
                className={`absolute left-[-1px] top-1.5 w-4 h-4 rounded-full border-2 border-white
                  ${ev.kind === 'booked' ? 'bg-emerald-500' :
                    ev.kind === 'edited' ? 'bg-amber-500' :
                    ev.kind === 'reversed' ? 'bg-red-500' : 'bg-slate-400'}
                `}
              />
              <div className="pl-5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-xs font-bold uppercase tracking-wide
                    ${ev.kind === 'booked' ? 'text-emerald-700' :
                      ev.kind === 'edited' ? 'text-amber-700' :
                      ev.kind === 'reversed' ? 'text-red-700' : 'text-slate-500'}
                  `}>
                    {ev.kind === 'booked' && (ev.mode === 'batch' ? 'Booked via batch' : ev.mode === 'reverse' ? 'Booked as reversal' : 'Booked')}
                    {ev.kind === 'edited' && `Edit #${ev.index}`}
                    {ev.kind === 'reversed' && 'Reversed'}
                  </span>
                  <span className="text-xs text-slate-500">{formatDateTime(ev.ts)}</span>
                  {ev.who && (
                    <span className="text-xs text-emerald-700 flex items-center gap-1">
                      <UserIcon className="w-3 h-3" /> PIN: {ev.who}
                    </span>
                  )}
                </div>

                {ev.kind === 'booked' && (
                  <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs bg-slate-50 rounded px-3 py-2 border border-slate-200">
                    {Object.entries(ev.payload).map(([k, v]) => (
                      <div key={k} className="flex gap-1.5">
                        <span className="text-slate-500 min-w-[80px]">{FIELD_LABELS[k]}:</span>
                        <span className="text-slate-800 font-medium truncate">{formatVal(k, v)}</span>
                      </div>
                    ))}
                  </div>
                )}

                {ev.kind === 'edited' && (
                  <div className="mt-1.5 space-y-1">
                    {Object.keys(ev.next).map((k) => (
                      <div key={k} className="text-xs bg-slate-50 rounded px-3 py-1.5 border border-slate-200">
                        <div className="text-slate-500 font-medium mb-0.5">{FIELD_LABELS[k] || k}</div>
                        <div className="flex items-start gap-2 flex-wrap">
                          <span className="text-red-700 line-through">{formatVal(k, ev.previous[k])}</span>
                          <span className="text-slate-400">→</span>
                          <span className="text-emerald-700 font-semibold">{formatVal(k, ev.next[k])}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {ev.kind === 'reversed' && (
                  <div className="mt-1.5 text-xs bg-red-50 border border-red-200 rounded px-3 py-2 text-red-900">
                    Row struck out; a compensating adjustment (delta{' '}
                    {compensating ? (
                      <span className="font-mono font-semibold">
                        {compensating.delta > 0 ? '+' : ''}{compensating.delta}
                      </span>
                    ) : 'n/a'}) was booked at the same time.
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="warehouse-timeline-close-btn">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

