/**
 * SamplesTab — Attribute Studio tab to disable/re-enable sample requests for
 * the selected products. Sets `samples_hidden` on both supplier_products and
 * the live tiles collection (bulk-update-unified mirrors automatically); the
 * PDP hides the "Order a Sample" button when samples_hidden is true.
 */
import React, { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../components/ui/button';
import { FlaskConical, Ban, RotateCcw } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

export const SamplesTab = ({ selectedList = [], onSuccess }) => {
  const [saving, setSaving] = useState(false);
  const disabledCount = selectedList.filter(p => p.samples_hidden).length;

  const apply = async (hide) => {
    if (selectedList.length === 0) return toast.error('No products selected');
    setSaving(true);
    try {
      const idsSku = selectedList.filter(p => p.sku).map(p => p.sku);
      const idsCode = selectedList.filter(p => !p.sku && p.supplier_code).map(p => p.supplier_code);
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
      toast.success(hide
        ? `Sample requests disabled on ${updated} product(s) — the "Order a Sample" button is now hidden for them`
        : `Sample requests re-enabled on ${updated} product(s)`);
      if (onSuccess) onSuccess({ updated });
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
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
      <div className="text-xs text-gray-500" data-testid="samples-status-line">
        {disabledCount} of {selectedList.length} selected currently have samples <span className="font-semibold text-rose-600">disabled</span>.
      </div>
      <div className="flex items-center gap-2">
        <Button
          onClick={() => apply(true)}
          disabled={saving}
          className="bg-rose-600 hover:bg-rose-700 text-white"
          data-testid="samples-disable-btn"
        >
          <Ban className="w-4 h-4 mr-1.5" />
          Disable sample requests ({selectedList.length})
        </Button>
        <Button
          onClick={() => apply(false)}
          disabled={saving}
          variant="outline"
          className="border-emerald-300 text-emerald-700 hover:bg-emerald-50"
          data-testid="samples-enable-btn"
        >
          <RotateCcw className="w-4 h-4 mr-1.5" />
          Re-enable samples
        </Button>
      </div>
    </div>
  );
};

export default SamplesTab;
