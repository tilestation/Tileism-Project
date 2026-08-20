/**
 * PerProductOverridesPanel — expandable table shown inside the TierPricingModal.
 * Lets admins override the global Trade Discount / Credit Back / Disable-Tier for
 * INDIVIDUAL products in the selection while keeping the rest on the global setting.
 *
 * Storage shape: overrides = { 'supplier|||sku': { trade_discount, credit_back_rate, disabled } }
 * A missing key = "use global setting from the modal above".
 */
import React, { useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Badge } from '../../../../components/ui/badge';
import { Layers, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';

const productKey = (p) => `${p.supplier || ''}|||${p.sku || p.supplier_code || ''}`;

const PerProductOverridesPanel = ({ products, overrides, setOverrides, tradeFixedSuffix, isTradeFixed }) => {
  const [open, setOpen] = useState(false);

  const overrideCount = Object.keys(overrides || {}).filter(k => {
    const o = overrides[k];
    return o && (o.trade_discount !== undefined || o.credit_back_rate !== undefined || o.disabled !== undefined);
  }).length;

  const setField = (key, field, value) => {
    setOverrides(prev => {
      const next = { ...(prev || {}) };
      const row = { ...(next[key] || {}) };
      if (value === '' || value === null || value === undefined) delete row[field];
      else row[field] = value;
      if (Object.keys(row).length === 0) delete next[key];
      else next[key] = row;
      return next;
    });
  };

  const setDisabled = (key, checked) => {
    setOverrides(prev => {
      const next = { ...(prev || {}) };
      const row = { ...(next[key] || {}) };
      if (checked) row.disabled = true;
      else delete row.disabled;
      if (Object.keys(row).length === 0) delete next[key];
      else next[key] = row;
      return next;
    });
  };

  const clearRow = (key) => {
    setOverrides(prev => {
      const next = { ...(prev || {}) };
      delete next[key];
      return next;
    });
  };

  const clearAll = () => {
    if (!window.confirm('Clear ALL per-product overrides? They will fall back to the global settings on Save.')) return;
    setOverrides({});
  };

  return (
    <div className="border border-amber-200 rounded-lg overflow-hidden" data-testid="per-product-overrides-panel">
      <button
        type="button"
        className={`w-full flex items-center justify-between px-3 py-2 text-sm font-medium ${open ? 'bg-amber-100' : 'bg-amber-50 hover:bg-amber-100'}`}
        onClick={() => setOpen(!open)}
        data-testid="per-product-overrides-toggle"
      >
        <span className="flex items-center gap-2 text-amber-800">
          <Layers className="w-4 h-4" />
          Per-Product Overrides
          {overrideCount > 0 && (
            <Badge className="bg-amber-600 text-white text-[10px] py-0 px-1.5">{overrideCount} customised</Badge>
          )}
        </span>
        <span className="flex items-center gap-2 text-xs text-amber-700">
          {open ? 'Hide' : 'Customise per product'}
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </span>
      </button>

      {open && (
        <div className="bg-white">
          <div className="flex items-center justify-between px-3 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900">
            <span>
              Leave a field blank to <b>inherit the global setting above</b>. Overrides win on Save.
            </span>
            {overrideCount > 0 && (
              <Button size="xs" variant="ghost" className="h-6 text-[11px] text-red-600 hover:text-red-700 hover:bg-red-50" onClick={clearAll} data-testid="per-product-clear-all">
                <RotateCcw className="w-3 h-3 mr-1" /> Clear all
              </Button>
            )}
          </div>
          <div className="max-h-64 overflow-auto">
            <table className="w-full min-w-[860px] text-xs">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr className="text-left text-gray-500">
                  <th className="px-2 py-1.5 font-medium">Product</th>
                  <th className="px-2 py-1.5 font-medium text-right w-20">Cost £</th>
                  <th className="px-2 py-1.5 font-medium text-right w-20">List £</th>
                  <th className="px-2 py-1.5 font-medium text-right w-24" title="Amount taken OFF the list price for trade customers — NOT the trade price itself">Trade Disc</th>
                  <th className="px-2 py-1.5 font-medium text-right w-20">Discounted</th>
                  <th className="px-2 py-1.5 font-medium text-right w-20" title="Full pallet £ per unit for this product (blank = global setting)">Pallet £</th>
                  <th className="px-2 py-1.5 font-medium text-right w-20" title="Half pallet £ per unit for this product (blank = global setting)">½ Pallet £</th>
                  <th className="px-2 py-1.5 font-medium text-right w-16">Credit %</th>
                  <th className="px-2 py-1.5 font-medium text-center w-14">Disable Tier</th>
                  <th className="px-2 py-1.5 font-medium text-center w-12">Reset</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const key = productKey(p);
                  const o = overrides?.[key] || {};
                  const hasAny = ['trade_discount', 'credit_back_rate', 'disabled', 'cost_price', 'list_price', 'pallet_price', 'half_pallet_price'].some(f => o[f] !== undefined);
                  const listPrice = Number(p.list_price ?? p.price ?? p.room_lot_price ?? p.retail_price ?? 0);
                  const costPrice = Number(p.cost_price ?? p.wholesale_price ?? 0);
                  // Edited values win over the stored ones for the live preview maths
                  const effList = o.list_price !== undefined && o.list_price !== '' ? Number(o.list_price) : listPrice;
                  const effCost = o.cost_price !== undefined && o.cost_price !== '' ? Number(o.cost_price) : costPrice;
                  const effectiveTrade = o.trade_discount !== undefined ? Number(o.trade_discount) : null;
                  // Live-compute the discounted price so the admin can see what N% off actually costs.
                  const discountedPrice = (() => {
                    if (o.disabled) return null;    // No tier discount = no preview
                    if (effList <= 0) return null;  // No base price = no meaningful preview
                    if (effectiveTrade === null || Number.isNaN(effectiveTrade)) return null;
                    if (isTradeFixed) return Math.max(0, effList - effectiveTrade);
                    return Math.max(0, effList * (1 - effectiveTrade / 100));
                  })();
                  const belowCost = discountedPrice !== null && effCost > 0 && discountedPrice < effCost;
                  const margin = discountedPrice !== null && effCost > 0 && discountedPrice > 0
                    ? ((discountedPrice - effCost) / discountedPrice) * 100
                    : null;
                  return (
                    <tr key={key} className={`border-b ${hasAny ? 'bg-amber-50/60' : ''}`} data-testid={`override-row-${p.sku || p.supplier_code}`}>
                      <td className="px-2 py-1.5 max-w-[220px]">
                        <div className="truncate font-medium text-gray-800" title={p.product_name || p.display_name || p.our_product_name || p.name}>
                          {p.product_name || p.display_name || p.our_product_name || p.name || '—'}
                        </div>
                        <div className="text-[10px] text-gray-400 truncate">{p.supplier} · {p.sku || p.supplier_code}</div>
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Input
                          type="number"
                          step="0.01"
                          value={o.cost_price ?? ''}
                          onChange={(e) => { const v = e.target.value; setField(key, 'cost_price', v === '' ? '' : Number(v)); }}
                          placeholder={costPrice > 0 ? costPrice.toFixed(2) : '—'}
                          className="h-7 text-[11px] w-16 text-right font-mono"
                          data-testid={`override-cost-${p.sku || p.supplier_code}`}
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Input
                          type="number"
                          step="0.01"
                          value={o.list_price ?? ''}
                          onChange={(e) => { const v = e.target.value; setField(key, 'list_price', v === '' ? '' : Number(v)); }}
                          placeholder={listPrice > 0 ? listPrice.toFixed(2) : '—'}
                          className="h-7 text-[11px] w-16 text-right font-mono"
                          data-testid={`override-list-${p.sku || p.supplier_code}`}
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <div className="flex items-center justify-end gap-0.5">
                          <Input
                            type="number"
                            step="0.01"
                            value={o.trade_discount ?? ''}
                            onChange={(e) => {
                              const v = e.target.value;
                              setField(key, 'trade_discount', v === '' ? '' : Number(v));
                            }}
                            placeholder="—"
                            className="h-7 text-xs w-16 text-right"
                            data-testid={`override-trade-${p.sku || p.supplier_code}`}
                          />
                          <span className="text-[10px] text-gray-500 w-8">{isTradeFixed ? tradeFixedSuffix.replace('£/', '£/') : '%'}</span>
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right text-[11px] font-mono" data-testid={`override-discounted-${p.sku || p.supplier_code}`}>
                        {discountedPrice !== null ? (
                          <div>
                            <div className={`font-semibold ${belowCost ? 'text-red-600' : 'text-emerald-700'}`}>£{discountedPrice.toFixed(2)}</div>
                            {belowCost ? (
                              <div className="text-[9px] text-red-600 font-semibold" title={`Selling £${discountedPrice.toFixed(2)} against cost £${effCost.toFixed(2)} loses £${(effCost - discountedPrice).toFixed(2)}/unit`}>
                                ⚠ £{(effCost - discountedPrice).toFixed(2)} below cost
                              </div>
                            ) : margin !== null && (
                              <div className={`text-[9px] ${margin >= 20 ? 'text-emerald-600' : margin >= 5 ? 'text-amber-600' : 'text-red-600'}`} title="Margin = (price − cost) ÷ price">
                                {margin.toFixed(0)}% margin
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Input
                          type="number"
                          step="0.01"
                          value={o.pallet_price ?? ''}
                          onChange={(e) => { const v = e.target.value; setField(key, 'pallet_price', v === '' ? '' : Number(v)); }}
                          placeholder={Number(p.pallet_price) > 0 ? Number(p.pallet_price).toFixed(2) : '—'}
                          className="h-7 text-[11px] w-16 text-right font-mono"
                          data-testid={`override-pallet-${p.sku || p.supplier_code}`}
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <Input
                          type="number"
                          step="0.01"
                          value={o.half_pallet_price ?? ''}
                          onChange={(e) => { const v = e.target.value; setField(key, 'half_pallet_price', v === '' ? '' : Number(v)); }}
                          placeholder={Number(p.half_pallet_price) > 0 ? Number(p.half_pallet_price).toFixed(2) : '—'}
                          className="h-7 text-[11px] w-16 text-right font-mono"
                          data-testid={`override-halfpallet-${p.sku || p.supplier_code}`}
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <div className="flex items-center justify-end gap-0.5">
                          <Input
                            type="number"
                            step="0.1"
                            value={o.credit_back_rate ?? ''}
                            onChange={(e) => {
                              const v = e.target.value;
                              setField(key, 'credit_back_rate', v === '' ? '' : Number(v));
                            }}
                            placeholder="—"
                            className="h-7 text-xs w-14 text-right"
                            data-testid={`override-credit-${p.sku || p.supplier_code}`}
                          />
                          <span className="text-[10px] text-gray-500">%</span>
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        <input
                          type="checkbox"
                          checked={!!o.disabled}
                          onChange={(e) => setDisabled(key, e.target.checked)}
                          className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                          data-testid={`override-disable-${p.sku || p.supplier_code}`}
                        />
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {hasAny && (
                          <Button
                            size="xs"
                            variant="ghost"
                            className="h-6 w-6 p-0 text-gray-400 hover:text-red-600 hover:bg-red-50"
                            onClick={() => clearRow(key)}
                            title="Clear this row's overrides"
                            data-testid={`override-reset-${p.sku || p.supplier_code}`}
                          >
                            <RotateCcw className="w-3 h-3" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export { productKey };
export default PerProductOverridesPanel;
