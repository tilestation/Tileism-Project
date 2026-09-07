/**
 * SellingRulesCard — the Pallets + Delivery rules for ONE set of values, laid out
 * as two side-by-side boxes. Used by the Quick Edit drawer (single product) and as
 * the "Fill all rows" bar in the Pricing hub's Pallets & Delivery table.
 */
import React from 'react';
import { Input } from '../../../../components/ui/input';
import { Truck, Package, Layers } from 'lucide-react';
import { applyRuleField } from './sellingRules';

const Num = ({ value, onChange, placeholder, testid, disabled, step = '0.01', className = '' }) => (
  <Input type="number" step={step} min="0" value={value ?? ''} onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder} disabled={disabled} className={`h-8 text-xs font-mono ${className}`} data-testid={testid} />
);

const SellingRulesCard = ({ value, onChange, testPrefix = 'rules', palletFooter = null, deliveryFooter = null }) => {
  const set = (field, v) => onChange(applyRuleField(value, field, v));
  const isUnit = value.pallet_qty_unit === 'unit';
  const qtyLabel = isUnit ? 'units' : 'm²';
  const on = value.pallet_enabled;

  return (
    <div className="grid md:grid-cols-2 gap-3 text-xs" data-testid={`${testPrefix}-card`}>
      {/* Pallets */}
      <div className={`rounded-lg border p-3 space-y-2 ${on ? 'bg-green-50 border-green-200' : 'bg-white border-gray-200'}`}>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={on} onChange={(e) => set('pallet_enabled', e.target.checked)} className="w-4 h-4 accent-green-600" data-testid={`${testPrefix}-pallet-on`} />
          <Truck className="w-4 h-4 text-green-700" />
          <span className="font-semibold text-green-900">Sell by the pallet</span>
          <span className="ml-auto text-[10px] text-gray-500">{on ? 'Half / Full pallet chips shown on the website' : 'Off — single m² / units only'}</span>
        </label>
        {on && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-green-900 font-medium">Quantities in</span>
              <div className="inline-flex rounded border border-green-300 overflow-hidden">
                {[['m2', 'm²'], ['unit', 'units / bags']].map(([val, label]) => (
                  <button key={val} type="button" onClick={() => set('pallet_qty_unit', val)}
                    className={`px-2 py-1 ${value.pallet_qty_unit === val ? 'bg-green-600 text-white' : 'bg-white text-gray-600 hover:bg-green-50'}`}
                    data-testid={`${testPrefix}-unit-${val}`}>{label}</button>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[10px] text-green-800 font-medium mb-0.5">Full pallet ({qtyLabel})</div>
                <Num value={value.m2_per_pallet} onChange={(v) => set('m2_per_pallet', v)} placeholder={isUnit ? 'e.g. 60' : 'e.g. 32'} step={isUnit ? '1' : '0.01'} testid={`${testPrefix}-full-qty`} />
              </div>
              <div>
                <div className="text-[10px] text-green-800 font-medium mb-0.5">Full pallet — £ per {isUnit ? 'unit' : 'm²'}</div>
                <Num value={value.pallet_price} onChange={(v) => set('pallet_price', v)} placeholder="e.g. 28.00" testid={`${testPrefix}-full-price`} />
              </div>
              <div>
                <div className="text-[10px] text-green-800 font-medium mb-0.5">Half pallet ({qtyLabel})</div>
                <Num value={value.m2_per_half_pallet} onChange={(v) => set('m2_per_half_pallet', v)} placeholder="auto: ½ of full" step={isUnit ? '1' : '0.01'} testid={`${testPrefix}-half-qty`} />
              </div>
              <div>
                <div className="text-[10px] text-green-800 font-medium mb-0.5">Half pallet — £ per {isUnit ? 'unit' : 'm²'}</div>
                <Num value={value.half_pallet_price} onChange={(v) => set('half_pallet_price', v)} placeholder="optional" testid={`${testPrefix}-half-price`} />
              </div>
            </div>
            <label className={`flex items-start gap-2 cursor-pointer rounded-md border p-2 ${value.pallet_only ? 'bg-amber-50 border-amber-300' : 'bg-white border-green-200'}`}>
              <input type="checkbox" checked={!!value.pallet_only} onChange={(e) => set('pallet_only', e.target.checked)} className="w-4 h-4 mt-0.5 accent-amber-600" data-testid={`${testPrefix}-pallet-only`} />
              <span>
                <span className="font-semibold text-amber-900 inline-flex items-center gap-1"><Layers className="w-3 h-3" /> Pallet only — no individual {qtyLabel}</span>
                <span className="block text-[10px] text-amber-800 mt-0.5">Customers can ONLY buy Half or Full pallets. Ideal for clearance stock to shift in bulk.</span>
              </span>
            </label>
          </>
        )}
        {palletFooter}
      </div>

      {/* Delivery */}
      <div className={`rounded-lg border p-3 space-y-2 ${value.delivery_charge_required || value.parcel_delivery ? 'bg-amber-50/60 border-amber-200' : 'bg-white border-gray-200'}`}>
        <div className="flex items-center gap-2 font-semibold text-amber-900">
          <Truck className="w-4 h-4 text-amber-700" /> Delivery
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 cursor-pointer flex-1">
            <input type="checkbox" checked={!!value.delivery_charge_required} onChange={(e) => set('delivery_charge_required', e.target.checked)} className="w-4 h-4 accent-amber-600" data-testid={`${testPrefix}-delivery-on`} />
            <span className="font-medium text-gray-800">Mandatory delivery charge</span>
          </label>
          <div className="flex items-center gap-1">
            <span className="text-gray-500">£</span>
            <Num value={value.delivery_charge} onChange={(v) => set('delivery_charge', v)} placeholder="e.g. 15.00" disabled={!value.delivery_charge_required} testid={`${testPrefix}-delivery-amount`} className="w-24" />
          </div>
        </div>
        <p className="text-[10px] text-gray-500 leading-snug">Charged once per order, never free — even over the free-delivery threshold. Several marked items together: the highest single charge applies.</p>
        <div className="flex items-center gap-2 pt-1 border-t border-amber-100">
          <label className="flex items-center gap-2 cursor-pointer flex-1">
            <input type="checkbox" checked={!!value.parcel_delivery} onChange={(e) => set('parcel_delivery', e.target.checked)} className="w-4 h-4 accent-sky-600" data-testid={`${testPrefix}-parcel-on`} />
            <Package className="w-3.5 h-3.5 text-sky-600" />
            <span className="font-medium text-gray-800">Ships as parcel</span>
          </label>
          <div className="flex items-center gap-1">
            <span className="text-gray-500">£</span>
            <Num value={value.parcel_fee} onChange={(v) => set('parcel_fee', v)} placeholder="std rate" disabled={!value.parcel_delivery} testid={`${testPrefix}-parcel-fee`} className="w-24" />
          </div>
        </div>
        <p className="text-[10px] text-gray-500 leading-snug">Small non-palletised items (tools, trims). When the whole order is parcels, this rate replaces the pallet delivery fee — blank = standard fee.</p>
        {deliveryFooter}
      </div>
    </div>
  );
};

export default SellingRulesCard;
