/**
 * SamplesTab — Attribute Studio tab to disable/re-enable sample requests.
 * Bulk buttons act on the whole selection; the list below gives a per-product
 * toggle so individual tiles in a collection can differ. Sets `samples_hidden`
 * on both supplier_products and live tiles (bulk-update-unified mirrors);
 * the PDP hides "Order a Sample" when samples_hidden is true.
 */
import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../components/ui/button';
import { FlaskConical, Ban, RotateCcw } from 'lucide-react';
import { productDisplayName } from './useManagerBulk';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const saveFlag = async (products, hide) => {
  const idsSku = products.filter(p => p.sku).map(p => p.sku);
  const idsCode = products.filter(p => !p.sku && p.supplier_code).map(p => p.supplier_code);
  let updated = 0;
  for (const [ids, idField] of [[idsSku, 'sku'], [idsCode, 'supplier_code']]) {
    if (ids.length === 0) continue;
    const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_ids: ids, id_field: idField, updates: { samples_hidden: hide }, mode: 'replace' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    updated += data.updated_count || 0;
  }
  return updated;
};

export const SamplesTab = ({ selectedList = [], onSuccess }) => {
  const [saving, setSaving] = useState(false);
  // Local truth map so toggles reflect instantly without a refetch
  const [flags, setFlags] = useState({});
  useEffect(() => {
    const m = {};
    selectedList.forEach(p => { m[p.sku || p.supplier_code] = !!p.samples_hidden; });
    setFlags(m);
  }, [selectedList]);

  const disabledCount = Object.values(flags).filter(Boolean).length;

  const applyAll = async (hide) => {
    if (selectedList.length === 0) return toast.error('No products selected');
    setSaving(true);
    try {
      const updated = await saveFlag(selectedList, hide);
      setFlags(prev => {
        const next = { ...prev };
        selectedList.forEach(p => { next[p.sku || p.supplier_code] = hide; });
        return next;
      });
      toast.success(hide
        ? `Sample requests disabled on ${updated} product(s)`
        : `Sample requests re-enabled on ${updated} product(s)`);
      if (onSuccess) onSuccess({ updated });
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const toggleOne = async (p) => {
    const key = p.sku || p.supplier_code;
    const next = !flags[key];
    setFlags(prev => ({ ...prev, [key]: next })); // optimistic
    try {
      await saveFlag([p], next);
      toast.success(`${productDisplayName(p)} — samples ${next ? 'disabled' : 'enabled'}`);
      if (onSuccess) onSuccess({ updated: 1 });
    } catch (err) {
      setFlags(prev => ({ ...prev, [key]: !next })); // revert
      toast.error(`Save failed: ${err.message}`);
    }
  };

  return (
    <div className="space-y-3" data-testid="samples-tab">
      <div className="rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2.5 flex items-center gap-2.5">
        <FlaskConical className="w-4 h-4 text-rose-500 flex-shrink-0" />
        <div className="text-sm text-gray-600">
          Customers can normally order a sample from the product page. Disable it for products you never send samples for (adhesives, trims, special orders…).
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-gray-500" data-testid="samples-status-line">
          {disabledCount} of {selectedList.length} selected currently have samples <span className="font-semibold text-rose-600">disabled</span>.
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => applyAll(true)}
            disabled={saving}
            className="bg-rose-600 hover:bg-rose-700 text-white"
            data-testid="samples-disable-btn"
          >
            <Ban className="w-3.5 h-3.5 mr-1.5" />
            Disable all ({selectedList.length})
          </Button>
          <Button
            size="sm"
            onClick={() => applyAll(false)}
            disabled={saving}
            variant="outline"
            className="border-emerald-300 text-emerald-700 hover:bg-emerald-50"
            data-testid="samples-enable-btn"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            Re-enable all
          </Button>
        </div>
      </div>

      {/* Per-product toggles — individual products in a collection can differ */}
      <div className="rounded-lg border border-gray-200 overflow-hidden">
        <div className="px-3 py-1.5 bg-gray-50 text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
          Per product — flip individual tiles
        </div>
        <div className="max-h-[38vh] overflow-y-auto divide-y divide-gray-100" data-testid="samples-product-list">
          {selectedList.map((p) => {
            const key = p.sku || p.supplier_code;
            const off = !!flags[key];
            return (
              <div key={key} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-gray-50" data-testid={`samples-row-${key}`}>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-gray-900 truncate">{productDisplayName(p)}</div>
                  <div className="text-[11px] text-gray-500 truncate">{key}{p.size ? ` · ${p.size}` : ''}</div>
                </div>
                <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${off ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}>
                  {off ? 'Samples OFF' : 'Samples ON'}
                </span>
                <button
                  type="button"
                  onClick={() => toggleOne(p)}
                  className={`relative inline-block w-9 h-5 rounded-full transition flex-shrink-0 ${off ? 'bg-rose-500' : 'bg-emerald-400'}`}
                  title={off ? 'Re-enable samples for this product' : 'Disable samples for this product'}
                  data-testid={`samples-toggle-${key}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${off ? 'translate-x-4' : ''}`}></span>
                </button>
              </div>
            );
          })}
          {selectedList.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-gray-400">No products selected</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SamplesTab;
