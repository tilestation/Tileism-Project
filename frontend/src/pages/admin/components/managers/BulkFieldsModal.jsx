/**
 * BulkFieldsModal — set the same value on Price, Cost, Stock across selected
 * products in one shot. Uses the same 100%-verification `bulk-update-unified`
 * endpoint every save-path uses, so any silent mismatch surfaces immediately.
 *
 * Fields (each with its own "apply" checkbox so you can pick a subset):
 *   • List Price (list_price / retail_price)
 *   • Cost Price (cost_price)
 *   • Warehouse Stock (warehouse_stock)
 *   • Sale % (sale_pct)
 */

import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import {
  PoundSterling, Package, Percent, Save, RefreshCw, AlertTriangle,
} from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const BulkFieldsModal = ({ open, onOpenChange, selectedList = [], onSuccess, themeColor = 'orange' }) => {
  const [applyPrice, setApplyPrice] = useState(false);
  const [applyCost, setApplyCost] = useState(false);
  const [applyStock, setApplyStock] = useState(false);
  const [applySale, setApplySale] = useState(false);
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [stock, setStock] = useState('');
  const [salePct, setSalePct] = useState('');
  const [saving, setSaving] = useState(false);

  const themeBtn = {
    orange: 'bg-orange-600 hover:bg-orange-700 text-white',
    blue:   'bg-blue-600   hover:bg-blue-700   text-white',
    purple: 'bg-purple-600 hover:bg-purple-700 text-white',
    slate:  'bg-slate-700  hover:bg-slate-800  text-white',
  }[themeColor] || 'bg-orange-600 hover:bg-orange-700 text-white';

  const anyChecked = applyPrice || applyCost || applyStock || applySale;

  const handleSave = async () => {
    if (!anyChecked) { toast.error('Tick at least one field to update'); return; }
    if (selectedList.length === 0) return;

    setSaving(true);
    try {
      // Build updates payload
      const updates = {};
      if (applyPrice && price !== '') {
        const n = parseFloat(price);
        if (isNaN(n) || n < 0) throw new Error('List price must be a positive number');
        updates.list_price = n;
        updates.retail_price = n;
      }
      if (applyCost && cost !== '') {
        const n = parseFloat(cost);
        if (isNaN(n) || n < 0) throw new Error('Cost price must be a positive number');
        updates.cost_price = n;
      }
      if (applyStock && stock !== '') {
        const n = parseInt(stock, 10);
        if (isNaN(n) || n < 0) throw new Error('Stock must be a positive integer');
        updates.warehouse_stock = n;
      }
      if (applySale && salePct !== '') {
        const n = parseFloat(salePct);
        if (isNaN(n) || n < 0 || n > 100) throw new Error('Sale % must be between 0 and 100');
        updates.sale_pct = n;
      }
      if (Object.keys(updates).length === 0) throw new Error('Enter at least one value');

      const idsSku = [];
      const idsSupplierCode = [];
      selectedList.forEach(p => {
        if (p.sku) idsSku.push(p.sku);
        else if (p.supplier_code) idsSupplierCode.push(p.supplier_code);
      });

      let totalUpdated = 0;
      const allFailures = [];
      for (const [ids, idField] of [[idsSku, 'sku'], [idsSupplierCode, 'supplier_code']]) {
        if (ids.length === 0) continue;
        const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_ids: ids, id_field: idField, updates, mode: 'replace' }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        totalUpdated += data.updated_count || 0;
        if (Array.isArray(data.verification_failures) && data.verification_failures.length > 0) {
          allFailures.push(...data.verification_failures);
        }
      }

      if (allFailures.length > 0) {
        toast.warning(`Updated ${totalUpdated} products, but ${allFailures.length} verification failure(s) — see console`, { duration: 12000 });
        console.warn('[Bulk Fields] Verification failures:', allFailures);
      } else {
        toast.success(`Updated ${totalUpdated} product(s)`);
      }
      onOpenChange(false);
      if (onSuccess) onSuccess({ updated: totalUpdated });
      // Reset
      setApplyPrice(false); setApplyCost(false); setApplyStock(false); setApplySale(false);
      setPrice(''); setCost(''); setStock(''); setSalePct('');
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  // Preview: average current values of the selected list, for at-a-glance context
  const previewStats = useMemo(() => {
    const avgOr = (arr) => {
      const nums = arr.filter(v => typeof v === 'number' && !isNaN(v));
      if (nums.length === 0) return null;
      return (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2);
    };
    return {
      avgPrice: avgOr(selectedList.map(p => Number(p.list_price || p.retail_price))),
      avgCost:  avgOr(selectedList.map(p => Number(p.cost_price))),
      avgStock: avgOr(selectedList.map(p => Number(p.warehouse_stock))),
    };
  }, [selectedList]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="bulk-fields-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PoundSterling className="w-5 h-5 text-emerald-600" />
            Bulk Set Price / Cost / Stock
          </DialogTitle>
          <p className="text-xs text-gray-500">
            Set one or more fields on {selectedList.length} selected product(s). Each save is verified — silent failures are flagged.
          </p>
        </DialogHeader>

        <div className="space-y-3">
          <FieldRow
            check={applyPrice}
            onToggle={() => setApplyPrice(v => !v)}
            label="List Price"
            icon={<PoundSterling className="w-4 h-4 text-emerald-600" />}
            avg={previewStats.avgPrice}
            input={
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="e.g. 24.99"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                disabled={!applyPrice}
                data-testid="bulk-fields-price"
              />
            }
            unit="£"
          />
          <FieldRow
            check={applyCost}
            onToggle={() => setApplyCost(v => !v)}
            label="Cost Price"
            icon={<PoundSterling className="w-4 h-4 text-blue-600" />}
            avg={previewStats.avgCost}
            input={
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="e.g. 12.50"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                disabled={!applyCost}
                data-testid="bulk-fields-cost"
              />
            }
            unit="£"
          />
          <FieldRow
            check={applyStock}
            onToggle={() => setApplyStock(v => !v)}
            label="Warehouse Stock"
            icon={<Package className="w-4 h-4 text-purple-600" />}
            avg={previewStats.avgStock}
            input={
              <Input
                type="number"
                step="1"
                min="0"
                placeholder="e.g. 100"
                value={stock}
                onChange={(e) => setStock(e.target.value)}
                disabled={!applyStock}
                data-testid="bulk-fields-stock"
              />
            }
            unit="pcs"
          />
          <FieldRow
            check={applySale}
            onToggle={() => setApplySale(v => !v)}
            label="Sale %"
            icon={<Percent className="w-4 h-4 text-rose-600" />}
            avg={null}
            input={
              <Input
                type="number"
                step="1"
                min="0"
                max="100"
                placeholder="e.g. 15"
                value={salePct}
                onChange={(e) => setSalePct(e.target.value)}
                disabled={!applySale}
                data-testid="bulk-fields-sale"
              />
            }
            unit="%"
          />
        </div>

        {anyChecked && (
          <div className="mt-2 flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded p-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>This overwrites the existing value on {selectedList.length} product(s). Verification runs on every save — mismatches surface immediately.</span>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button
            onClick={handleSave}
            disabled={saving || !anyChecked}
            className={themeBtn}
            data-testid="bulk-fields-save"
          >
            {saving ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
            Save to {selectedList.length} product(s)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const FieldRow = ({ check, onToggle, label, icon, input, unit, avg }) => (
  <div className={`border rounded-lg p-2 flex items-center gap-3 ${check ? 'border-emerald-200 bg-emerald-50/40' : 'border-gray-200'}`}>
    <input
      type="checkbox"
      checked={check}
      onChange={onToggle}
      className="w-4 h-4 accent-emerald-600"
    />
    <div className="w-8 h-8 rounded-md flex items-center justify-center bg-white border border-gray-100">{icon}</div>
    <div className="flex-1 min-w-0">
      <div className="text-sm font-medium text-gray-800">{label}</div>
      {avg !== null && avg !== undefined && (
        <div className="text-[10px] text-gray-500">Current avg: {unit === '£' ? '£' : ''}{avg} {unit !== '£' ? unit : ''}</div>
      )}
    </div>
    <div className="w-40 flex items-center gap-1">
      {input}
      <span className="text-xs text-gray-500 flex-shrink-0">{unit}</span>
    </div>
  </div>
);

export default BulkFieldsModal;
