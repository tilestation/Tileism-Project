/**
 * DeliveryChargeModal — bulk-set item-level delivery rules on selected products.
 *
 * Two independent rules:
 * 1. Mandatory delivery charge — £ charged once per order (never free), waived
 *    only when the order's OTHER (non-marked) items alone cross the
 *    free-delivery threshold. If several marked items are in one order the
 *    highest single charge applies.
 * 2. Parcel delivery — small non-palletised items (drill bits, tools). When an
 *    order contains ONLY parcel items the parcel rate replaces the standard
 *    pallet delivery fee.
 */
import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Truck, Package, RefreshCw, Save, Trash2 } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const DeliveryChargeModal = ({ open, onOpenChange, selectedProducts = [], onSaved }) => {
  const [chargeEnabled, setChargeEnabled] = useState(false);
  const [chargeAmount, setChargeAmount] = useState('');
  const [parcelEnabled, setParcelEnabled] = useState(false);
  const [parcelFee, setParcelFee] = useState('');
  const [saving, setSaving] = useState(false);

  // Prefill from the first selected product each time the modal opens
  useEffect(() => {
    if (!open) return;
    const first = selectedProducts[0] || {};
    setChargeEnabled(!!first.delivery_charge_required);
    setChargeAmount(first.delivery_charge != null && first.delivery_charge !== 0 ? String(first.delivery_charge) : '');
    setParcelEnabled(!!first.parcel_delivery);
    setParcelFee(first.parcel_fee != null && first.parcel_fee !== 0 ? String(first.parcel_fee) : '');
  }, [open, selectedProducts]);

  const callApi = async (body) => {
    const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-delivery-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        products: selectedProducts.map(p => ({ supplier: p.supplier, sku: p.sku || p.supplier_code })),
        ...body,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  const handleSave = async () => {
    if (chargeEnabled && (!chargeAmount || Number(chargeAmount) <= 0)) {
      toast.error('Enter a delivery charge amount (£) or turn the charge off');
      return;
    }
    setSaving(true);
    try {
      const data = await callApi({
        delivery_charge_required: chargeEnabled,
        ...(chargeEnabled ? { delivery_charge: Number(chargeAmount) } : {}),
        parcel_delivery: parcelEnabled,
        ...(parcelEnabled && parcelFee !== '' ? { parcel_fee: Number(parcelFee) } : {}),
      });
      toast.success(`Delivery settings saved for ${data.updated_count} product${data.updated_count !== 1 ? 's' : ''}`);
      onOpenChange(false);
      onSaved?.();
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!window.confirm(`Remove ALL delivery settings from ${selectedProducts.length} selected product(s)?`)) return;
    setSaving(true);
    try {
      const data = await callApi({ clear: true });
      toast.success(`Delivery settings removed from ${data.updated_count} product${data.updated_count !== 1 ? 's' : ''}`);
      onOpenChange(false);
      onSaved?.();
    } catch (err) {
      toast.error(`Clear failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="w-5 h-5 text-amber-600" />
            Delivery Rules — {selectedProducts.length} product{selectedProducts.length !== 1 ? 's' : ''}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Mandatory delivery charge */}
          <div className={`border rounded-lg p-4 ${chargeEnabled ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={chargeEnabled}
                onChange={(e) => setChargeEnabled(e.target.checked)}
                className="w-5 h-5 mt-0.5 rounded border-amber-300 text-amber-600 focus:ring-amber-500"
                data-testid="delivery-charge-enabled-checkbox"
              />
              <div className="flex-1">
                <span className="font-semibold text-gray-800 flex items-center gap-2">
                  <Truck className="w-4 h-4 text-amber-600" />
                  Mandatory delivery charge
                </span>
                <p className="text-xs text-gray-500 mt-0.5">
                  Charged once per order, no matter the spend. Waived only when the order&apos;s <b>other</b> items alone cross the free-delivery threshold. If several marked items are ordered together, the <b>highest single charge</b> applies.
                </p>
              </div>
            </label>
            {chargeEnabled && (
              <div className="mt-3 pl-8">
                <label className="text-xs text-amber-800 font-medium">Delivery charge (£ per order)</label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={chargeAmount}
                  onChange={(e) => setChargeAmount(e.target.value)}
                  placeholder="e.g., 15.00"
                  className="mt-1 h-9 w-40 font-mono"
                  data-testid="delivery-charge-amount-input"
                />
              </div>
            )}
          </div>

          {/* Parcel delivery */}
          <div className={`border rounded-lg p-4 ${parcelEnabled ? 'border-sky-300 bg-sky-50' : 'border-gray-200'}`}>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={parcelEnabled}
                onChange={(e) => setParcelEnabled(e.target.checked)}
                className="w-5 h-5 mt-0.5 rounded border-sky-300 text-sky-600 focus:ring-sky-500"
                data-testid="parcel-delivery-enabled-checkbox"
              />
              <div className="flex-1">
                <span className="font-semibold text-gray-800 flex items-center gap-2">
                  <Package className="w-4 h-4 text-sky-600" />
                  Ships as parcel (non-palletised)
                </span>
                <p className="text-xs text-gray-500 mt-0.5">
                  Small items (drill bits, hand tools) sent by courier instead of a pallet. When the <b>whole order</b> is parcel items, the parcel rate below replaces the standard pallet delivery fee.
                </p>
              </div>
            </label>
            {parcelEnabled && (
              <div className="mt-3 pl-8">
                <label className="text-xs text-sky-800 font-medium">Parcel rate (£ per order — optional)</label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={parcelFee}
                  onChange={(e) => setParcelFee(e.target.value)}
                  placeholder="e.g., 4.99"
                  className="mt-1 h-9 w-40 font-mono"
                  data-testid="parcel-fee-input"
                />
                <p className="text-[10px] text-gray-400 mt-1">Blank = standard delivery fee still applies to parcel-only orders.</p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <Button
            variant="ghost"
            onClick={handleClear}
            disabled={saving}
            className="text-red-600 hover:text-red-700 hover:bg-red-50"
            data-testid="delivery-settings-clear-btn"
          >
            <Trash2 className="w-4 h-4 mr-1.5" /> Remove settings
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-amber-600 hover:bg-amber-700 text-white"
              data-testid="delivery-settings-save-btn"
            >
              {saving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
              Save for {selectedProducts.length}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DeliveryChargeModal;
