/**
 * ClearanceHub — /admin/clearance
 * One place to run clearance: every product marked "Clearance" (from any
 * Manager or the Bulk Editor) lands here automatically. Build + publish the
 * PDF leaflet, remove items, jump to the owning Manager to edit attributes.
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Flame, Download, Globe, Trash2, ExternalLink, RefreshCw, FileText, Info, EyeOff,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Badge } from '../../components/ui/badge';
import ManagerTabsBar from './components/managers/ManagerTabsBar';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const tokenHdr = () => {
  const t = localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
};

const GROUP_TO_PATH = {
  tiles: '/admin/tiles',
  'wall-and-floor-tiles': '/admin/tiles',
  'wall-tiles': '/admin/tiles',
  'floor-tiles-only': '/admin/tiles',
  materials: '/admin/materials',
  flooring: '/admin/flooring',
  bathroom: '/admin/bathroom',
  underfloor_heating: '/admin/underfloor-heating',
  'underfloor-heating': '/admin/underfloor-heating',
  tools: '/admin/tools',
  'tools-accessories': '/admin/tools',
};

export default function ClearanceHub() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [checked, setChecked] = useState(new Set());
  const [layout, setLayout] = useState('poster');
  const [busy, setBusy] = useState(false);
  const [publishedConfig, setPublishedConfig] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r1, r2] = await Promise.all([
        fetch(`${API_URL}/api/clearance/products`),
        fetch(`${API_URL}/api/clearance/leaflet/config`),
      ]);
      if (r1.ok) {
        const d = await r1.json();
        setItems(d.items || []);
        setChecked(new Set((d.items || []).map(i => i.sku)));
      }
      if (r2.ok) setPublishedConfig(await r2.json());
    } catch (e) {
      toast.error(`Failed to load clearance products: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (sku) => setChecked(prev => {
    const n = new Set(prev);
    if (n.has(sku)) n.delete(sku); else n.add(sku);
    return n;
  });

  const selectedSkus = useMemo(() => items.filter(i => checked.has(i.sku)).map(i => i.sku), [items, checked]);

  const removeFromClearance = async (skus) => {
    if (!skus.length) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/clearance/mark`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...tokenHdr() },
        body: JSON.stringify({ product_ids: skus.map(sku => ({ sku })), on: false }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`${skus.length} product${skus.length !== 1 ? 's' : ''} removed from Clearance`);
      await load();
    } catch (e) {
      toast.error(`Remove failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const publishSkus = async (skus) => {
    if (!skus.length) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/clearance/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...tokenHdr() },
        body: JSON.stringify({ skus }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = await res.json();
      toast.success(r.message || 'Published');
      await load();
    } catch (e) {
      toast.error(`Publish failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const unpublishSkus = async (skus) => {
    if (!skus.length) return;
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/clearance/unpublish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...tokenHdr() },
        body: JSON.stringify({ skus }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = await res.json();
      toast.success(r.message || 'Taken off the storefront');
      await load();
    } catch (e) {
      toast.error(`Unpublish failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const downloadLeaflet = async () => {
    if (!selectedSkus.length) { toast.error('Tick at least one product for the leaflet'); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/clearance/leaflet/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...tokenHdr() },
        body: JSON.stringify({ skus: selectedSkus, layout }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      toast.success('Leaflet PDF ready');
    } catch (e) {
      toast.error(`PDF failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const publishLeaflet = async () => {
    if (!selectedSkus.length) { toast.error('Tick at least one product for the leaflet'); return; }
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/api/clearance/leaflet/publish`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...tokenHdr() },
        body: JSON.stringify({ skus: selectedSkus, layout }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Leaflet published — the storefront download button now serves this selection', {
        description: 'Prices & stock stay live: the PDF regenerates on every download',
      });
      const r2 = await fetch(`${API_URL}/api/clearance/leaflet/config`);
      if (r2.ok) setPublishedConfig(await r2.json());
    } catch (e) {
      toast.error(`Publish failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-6 space-y-4" data-testid="clearance-hub-page">
      <div className="-mx-6 -mt-6 mb-2">
        <ManagerTabsBar active="clearance" />
      </div>

      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-gray-900 flex items-center gap-2">
            <span className="clearance-badge inline-flex items-center gap-1.5 px-3 py-1 bg-[#e5d918] border-2 border-[#FF2A00] rounded-sm rotate-1">
              <Flame className="w-5 h-5 text-[#FF2A00]" strokeWidth={3} />
              <span className="clearance-fire-text text-[#FF2A00] uppercase tracking-widest text-lg">Clearance Hub</span>
            </span>
          </h1>
          <p className="text-sm text-gray-500 mt-2">
            {items.length} product{items.length !== 1 ? 's' : ''} marked Clearance · marking never publishes anything — edit in the Managers, then hit <span className="font-bold text-emerald-700">Publish</span> here when YOU are ready
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`${API_URL}/api/clearance/leaflet/current.pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-gray-500 underline underline-offset-2 hover:text-gray-800"
            data-testid="hub-view-live-leaflet"
          >
            View live website leaflet
          </a>
          <Button size="sm" variant="outline" onClick={load} disabled={loading} data-testid="hub-refresh-btn">
            <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </div>

      {/* Leaflet builder bar */}
      <div className="bg-[#0A0A0A] text-white rounded-xl p-4 flex flex-col md:flex-row md:items-center gap-4" data-testid="leaflet-builder-bar">
        <div className="flex items-center gap-2 font-black uppercase tracking-wider text-[#e5d918]">
          <FileText className="w-5 h-5" /> Leaflet Builder
        </div>
        <div className="flex items-center gap-1 bg-white/10 rounded-lg p-1" data-testid="leaflet-layout-toggle">
          <button
            type="button"
            onClick={() => setLayout('poster')}
            className={`px-3 py-1.5 rounded-md text-xs font-bold uppercase transition-colors ${layout === 'poster' ? 'bg-[#e5d918] text-black' : 'text-white/70 hover:text-white'}`}
            data-testid="leaflet-layout-poster"
          >
            Poster · 4 / page
          </button>
          <button
            type="button"
            onClick={() => setLayout('compact')}
            className={`px-3 py-1.5 rounded-md text-xs font-bold uppercase transition-colors ${layout === 'compact' ? 'bg-[#e5d918] text-black' : 'text-white/70 hover:text-white'}`}
            data-testid="leaflet-layout-compact"
          >
            Compact · 8 / page
          </button>
        </div>
        <span className="text-xs text-white/60">{selectedSkus.length} of {items.length} products ticked</span>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={busy || selectedSkus.length === 0}
            onClick={downloadLeaflet}
            className="bg-[#FF2A00] hover:bg-red-700 text-white font-bold"
            data-testid="leaflet-download-btn"
          >
            <Download className="w-4 h-4 mr-1.5" /> Download PDF
          </Button>
          <Button
            size="sm"
            disabled={busy || selectedSkus.length === 0}
            onClick={publishLeaflet}
            className="bg-[#e5d918] hover:bg-yellow-300 text-black font-bold"
            data-testid="leaflet-publish-btn"
          >
            <Globe className="w-4 h-4 mr-1.5" /> Publish to Website
          </Button>
        </div>
      </div>

      {publishedConfig?.published_at && (
        <div className="text-xs text-gray-500 flex items-center gap-1.5" data-testid="leaflet-published-info">
          <Info className="w-3.5 h-3.5" />
          Website leaflet: {publishedConfig.skus?.length || 'all'} product{(publishedConfig.skus?.length || 2) !== 1 ? 's' : ''} · {publishedConfig.layout} layout · published {String(publishedConfig.published_at).slice(0, 16).replace('T', ' ')}
        </div>
      )}

      {/* Bulk actions on selection */}
      {selectedSkus.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {items.some(i => checked.has(i.sku) && !i.published) && (
            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white"
              disabled={busy}
              onClick={() => publishSkus(items.filter(i => checked.has(i.sku) && !i.published).map(i => i.sku))}
              data-testid="hub-bulk-publish-btn">
              <Globe className="w-3.5 h-3.5 mr-1" /> Publish {items.filter(i => checked.has(i.sku) && !i.published).length} draft{items.filter(i => checked.has(i.sku) && !i.published).length !== 1 ? 's' : ''}
            </Button>
          )}
          {selectedSkus.length < items.length && (
            <Button size="sm" variant="outline" className="border-red-300 text-red-600 hover:bg-red-50"
              disabled={busy} onClick={() => removeFromClearance(selectedSkus)} data-testid="hub-bulk-remove-btn">
              <Trash2 className="w-3.5 h-3.5 mr-1" /> Remove {selectedSkus.length} from Clearance
            </Button>
          )}
        </div>
      )}

      {/* Product table */}
      <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
        {loading ? (
          <div className="p-10 text-center text-gray-400 text-sm">Loading clearance products…</div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center" data-testid="hub-empty-state">
            <Flame className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <p className="font-semibold text-gray-700">No clearance products yet</p>
            <p className="text-sm text-gray-500 mt-1 max-w-md mx-auto">
              Select products in any Manager (<Link to="/admin/tiles" className="underline">Tiles</Link>,{' '}
              <Link to="/admin/flooring" className="underline">Flooring</Link>…) or{' '}
              <Link to="/admin/supplier-products" className="underline">All Products</Link> and hit the yellow{' '}
              <span className="font-bold text-red-600">Clearance</span> button — they land here as drafts.
              Edit them, then publish manually when YOU are ready.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="px-3 py-2 w-8 text-center">
                  <input
                    type="checkbox"
                    className="w-4 h-4"
                    checked={checked.size === items.length && items.length > 0}
                    onChange={(e) => setChecked(e.target.checked ? new Set(items.map(i => i.sku)) : new Set())}
                    data-testid="hub-select-all"
                  />
                </th>
                <th className="px-3 py-2 text-left font-medium text-gray-600">Product</th>
                <th className="px-3 py-2 text-left font-medium text-gray-600">Size</th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">Was</th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">Now</th>
                <th className="px-3 py-2 text-center font-medium text-gray-600">% Off</th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">Stock</th>
                <th className="px-3 py-2 text-center font-medium text-gray-600">Live</th>
                <th className="px-3 py-2 text-right font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map(i => (
                <tr key={i.sku} className="hover:bg-amber-50/40" data-testid={`hub-row-${i.sku}`}>
                  <td className="px-3 py-2 text-center">
                    <input type="checkbox" className="w-4 h-4" checked={checked.has(i.sku)} onChange={() => toggle(i.sku)} data-testid={`hub-check-${i.sku}`} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      {i.image
                        ? <img src={i.image} alt="" className="w-10 h-10 rounded object-cover flex-shrink-0" />
                        : <div className="w-10 h-10 rounded bg-gray-100 flex-shrink-0" />}
                      <div className="min-w-0">
                        <div className="font-medium text-gray-900 truncate max-w-[320px]">{i.name}</div>
                        <div className="text-[11px] text-gray-500">{i.sku}{i.supplier ? ` · ${i.supplier}` : ''}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{i.size || '—'}</td>
                  <td className="px-3 py-2 text-right text-gray-400 line-through whitespace-nowrap">
                    {i.was_price ? `£${Number(i.was_price).toFixed(2)}` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-black text-red-600 whitespace-nowrap">
                    £{Number(i.price || 0).toFixed(2)}{i.pricing_unit === 'unit' ? '' : '/m²'}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {i.discount_percentage
                      ? <Badge className="bg-black text-[#e5d918] border-0 font-bold">{i.discount_percentage}%</Badge>
                      : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right text-gray-600 whitespace-nowrap">
                    {Number(i.stock_m2 || 0) > 0 ? `${Number(i.stock_m2).toLocaleString()} m²` : <span className="text-red-500 font-medium">0</span>}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {i.published
                      ? <Badge className="bg-emerald-100 text-emerald-700 border-0">Live</Badge>
                      : <Badge className="bg-gray-100 text-gray-500 border-0">Draft</Badge>}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {i.published ? (
                      <button
                        type="button"
                        onClick={() => unpublishSkus([i.sku])}
                        disabled={busy}
                        className="inline-flex items-center gap-1 text-xs text-orange-600 hover:text-orange-800 mr-3"
                        title="Take OFF the live storefront (keeps the draft + Clearance label)"
                        data-testid={`hub-unpublish-${i.sku}`}
                      >
                        <EyeOff className="w-3 h-3" /> Unpublish
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => publishSkus([i.sku])}
                        disabled={busy}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:text-emerald-800 mr-3"
                        title="Publish this draft to the live storefront"
                        data-testid={`hub-publish-${i.sku}`}
                      >
                        <Globe className="w-3 h-3" /> Publish
                      </button>
                    )}
                    <Link
                      to={GROUP_TO_PATH[i.product_group] || '/admin/supplier-products'}
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mr-3"
                      title="Edit attributes, pricing and images in the owning Manager"
                      data-testid={`hub-edit-${i.sku}`}
                    >
                      <ExternalLink className="w-3 h-3" /> Manager
                    </Link>
                    <button
                      type="button"
                      onClick={() => removeFromClearance([i.sku])}
                      disabled={busy}
                      className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-700"
                      title="Remove from clearance (keeps the product live, just removes the label)"
                      data-testid={`hub-remove-${i.sku}`}
                    >
                      <Trash2 className="w-3 h-3" /> Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
