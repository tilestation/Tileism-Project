/**
 * PerProductOverridesPanel — expandable table shown inside the TierPricingModal.
 * Lets admins override pricing for INDIVIDUAL products in the selection while
 * keeping the rest on the global setting.
 *
 * Trade £ column = the FINAL price a trade customer pays (NOT a discount amount).
 * The equivalent £-off discount is computed automatically on save.
 * Margin = (trade price − cost − credit back) ÷ trade price.
 *
 * Storage shape: overrides = { 'supplier|||sku': { trade_price, credit_back_rate, disabled, cost_price, list_price, pallet_price, half_pallet_price } }
 * A missing key = "use global setting from the modal above".
 */
import React, { useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Badge } from '../../../../components/ui/badge';
import { Layers, ChevronDown, ChevronUp, RotateCcw } from 'lucide-react';

const productKey = (p) => `${p.supplier || ''}|||${p.sku || p.supplier_code || ''}`;

const OVERRIDE_FIELDS = ['trade_price', 'credit_back_rate', 'disabled', 'cost_price', 'list_price', 'pallet_price', 'half_pallet_price'];

const PerProductOverridesPanel = ({ products, overrides, setOverrides, globalCreditBack = 2 }) => {
  const [open, setOpen] = useState(false);

  const overrideCount = Object.keys(overrides || {}).filter(k => {
    const o = overrides[k];
    return o && OVERRIDE_FIELDS.some(f => o[f] !== undefined);
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
              Leave a field blank to <b>inherit the global setting above</b>. <b>Trade £</b> is the final price a trade customer pays — the discount is worked out for you.
            </span>
            {overrideCount > 0 && (
              <Button size="xs" variant="ghost" className="h-6 text-[11px] text-red-600 hover:text-red-700 hover:bg-red-50" onClick={clearAll} data-testid="per-product-clear-all">
                <RotateCcw className="w-3 h-3 mr-1" /> Clear all
              </Button>
            )}
          </div>
          <div className="max-h-72 overflow-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr className="text-left text-gray-500 text-xs">
                  <th className="px-2 py-2 font-medium">Product</th>
                  <th className="px-2 py-2 font-medium text-right w-28">Cost £</th>
                  <th className="px-2 py-2 font-medium text-right w-28">List £</th>
                  <th className="px-2 py-2 font-medium text-right w-32" title="The FINAL price a trade customer pays per unit/m² — the £ discount off list is computed automatically">Trade £ (final)</th>
                  <th className="px-2 py-2 font-medium text-right w-32" title="Profit = ex-VAT trade price (÷1.2) − cost (ex-VAT) − credit back (% of ex-VAT). Margin % = profit ÷ ex-VAT price">Profit / Margin</th>
                  <th className="px-2 py-2 font-medium text-right w-28" title="Full pallet £ per unit for this product (blank = global setting)">Pallet £</th>
                  <th className="px-2 py-2 font-medium text-right w-28" title="Half pallet £ per unit for this product (blank = global setting)">½ Pallet £</th>
                  <th className="px-2 py-2 font-medium text-right w-24">Credit %</th>
                  <th className="px-2 py-2 font-medium text-center w-16">Disable Tier</th>
                  <th className="px-2 py-2 font-medium text-center w-12">Reset</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const key = productKey(p);
                  const o = overrides?.[key] || {};
                  const hasAny = OVERRIDE_FIELDS.some(f => o[f] !== undefined);
                  const listPrice = Number(p.list_price ?? p.price ?? p.room_lot_price ?? p.retail_price ?? 0);
                  const costPrice = Number(p.cost_price ?? p.wholesale_price ?? 0);
                  // Edited values win over the stored ones for the live preview maths
                  const effList = o.list_price !== undefined && o.list_price !== '' ? Number(o.list_price) : listPrice;
                  const effCost = o.cost_price !== undefined && o.cost_price !== '' ? Number(o.cost_price) : costPrice;
                  const tradePrice = o.trade_price !== undefined && o.trade_price !== '' ? Number(o.trade_price) : null;
                  const cbRate = o.credit_back_rate !== undefined && o.credit_back_rate !== ''
                    ? Number(o.credit_back_rate)
                    : Number(globalCreditBack ?? 2);
                  // Shop margin formula: trade price is inc-VAT → ÷1.2 for ex-VAT,
                  // minus cost (ex-VAT), minus credit back (% of the ex-VAT price).
                  const hasPreview = tradePrice !== null && !Number.isNaN(tradePrice) && tradePrice > 0 && !o.disabled;
                  const exVat = hasPreview ? tradePrice / 1.2 : 0;
                  const cbAmt = hasPreview ? exVat * (cbRate / 100) : 0;
                  const profit = hasPreview && effCost > 0 ? exVat - effCost - cbAmt : null;
                  const margin = profit !== null && exVat > 0 ? (profit / exVat) * 100 : null;
                  const belowCost = hasPreview && effCost > 0 && exVat < effCost;
                  const offList = hasPreview && effList > 0 ? Math.max(0, effList - tradePrice) : null;
                  return (
                    <tr key={key} className={`border-b ${hasAny ? 'bg-amber-50/60' : ''}`} data-testid={`override-row-${p.sku || p.supplier_code}`}>
                      <td className="px-2 py-2 max-w-[240px]">
                        <div className="truncate font-medium text-gray-800" title={p.product_name || p.display_name || p.our_product_name || p.name}>
                          {p.product_name || p.display_name || p.our_product_name || p.name || '—'}
                        </div>
                        <div className="text-[11px] text-gray-400 truncate">{p.supplier} · {p.sku || p.supplier_code}</div>
                      </td>
                      <td className="px-2 py-2 text-right">
                        <Input
                          type="number"
                          step="0.01"
                          value={o.cost_price ?? ''}
                          onChange={(e) => { const v = e.target.value; setField(key, 'cost_price', v === '' ? '' : Number(v)); }}
                          placeholder={costPrice > 0 ? costPrice.toFixed(2) : '—'}
                          className="h-9 text-sm w-24 text-right font-mono"
                          data-testid={`override-cost-${p.sku || p.supplier_code}`}
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <Input
                          type="number"
                          step="0.01"
                          value={o.list_price ?? ''}
                          onChange={(e) => { const v = e.target.value; setField(key, 'list_price', v === '' ? '' : Number(v)); }}
                          placeholder={listPrice > 0 ? listPrice.toFixed(2) : '—'}
                          className="h-9 text-sm w-24 text-right font-mono"
                          data-testid={`override-list-${p.sku || p.supplier_code}`}
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <Input
                          type="number"
                          step="0.01"
                          value={o.trade_price ?? ''}
                          onChange={(e) => { const v = e.target.value; setField(key, 'trade_price', v === '' ? '' : Number(v)); }}
                          placeholder="final £"
                          className="h-9 text-sm w-28 text-right font-mono"
                          data-testid={`override-trade-${p.sku || p.supplier_code}`}
                        />
                        {offList !== null && offList > 0 && (
                          <div className="text-[10px] text-gray-400 mt-0.5" data-testid={`override-offlist-${p.sku || p.supplier_code}`}>
                            = £{offList.toFixed(2)} off list
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right font-mono" data-testid={`override-discounted-${p.sku || p.supplier_code}`}>
                        {profit !== null ? (
                          <div>
                            <div className={`font-semibold ${profit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                              £{profit.toFixed(2)} · {margin.toFixed(0)}%
                            </div>
                            <div
                              className={`text-[10px] ${belowCost ? 'text-red-600 font-semibold' : 'text-gray-500'}`}
                              title={`Ex-VAT £${exVat.toFixed(2)} − cost £${effCost.toFixed(2)} − credit back £${cbAmt.toFixed(2)} (${cbRate}% of ex-VAT)`}
                            >
                              {belowCost
                                ? `⚠ ex-VAT £${exVat.toFixed(2)} below cost`
                                : `ex-VAT £${exVat.toFixed(2)} − CB £${cbAmt.toFixed(2)}`}
                            </div>
                          </div>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <Input
                          type="number"
                          step="0.01"
                          value={o.pallet_price ?? ''}
                          onChange={(e) => { const v = e.target.value; setField(key, 'pallet_price', v === '' ? '' : Number(v)); }}
                          placeholder={Number(p.pallet_price) > 0 ? Number(p.pallet_price).toFixed(2) : '—'}
                          className="h-9 text-sm w-24 text-right font-mono"
                          data-testid={`override-pallet-${p.sku || p.supplier_code}`}
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <Input
                          type="number"
                          step="0.01"
                          value={o.half_pallet_price ?? ''}
                          onChange={(e) => { const v = e.target.value; setField(key, 'half_pallet_price', v === '' ? '' : Number(v)); }}
                          placeholder={Number(p.half_pallet_price) > 0 ? Number(p.half_pallet_price).toFixed(2) : '—'}
                          className="h-9 text-sm w-24 text-right font-mono"
                          data-testid={`override-halfpallet-${p.sku || p.supplier_code}`}
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Input
                            type="number"
                            step="0.1"
                            value={o.credit_back_rate ?? ''}
                            onChange={(e) => {
                              const v = e.target.value;
                              setField(key, 'credit_back_rate', v === '' ? '' : Number(v));
                            }}
                            placeholder={String(globalCreditBack ?? 2)}
                            className="h-9 text-sm w-16 text-right"
                            data-testid={`override-credit-${p.sku || p.supplier_code}`}
                          />
                          <span className="text-xs text-gray-500">%</span>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={!!o.disabled}
                          onChange={(e) => setDisabled(key, e.target.checked)}
                          className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                          data-testid={`override-disable-${p.sku || p.supplier_code}`}
                        />
                      </td>
                      <td className="px-2 py-2 text-center">
                        {hasAny && (
                          <Button
                            size="xs"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-gray-400 hover:text-red-600 hover:bg-red-50"
                            onClick={() => clearRow(key)}
                            title="Clear this row's overrides"
                            data-testid={`override-reset-${p.sku || p.supplier_code}`}
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
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
