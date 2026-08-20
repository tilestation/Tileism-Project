/**
 * PerProductOverridesPanel — expandable table shown inside the TierPricingModal.
 * Lets admins override pricing for INDIVIDUAL products in the selection while
 * keeping the rest on the global setting.
 *
 * Trade £ column = the FINAL price a trade customer pays (NOT a discount amount).
 * The equivalent £-off discount is computed automatically on save.
 * Margin = (ex-VAT trade price − cost − credit back) ÷ ex-VAT trade price.
 *
 * Pallet pricing lives in a per-row expander (keeps the main table tidy):
 * qty unit dropdown (m²/units) + full & half pallet quantities and £ rates,
 * with live per-pallet profit using the same ex-VAT formula.
 *
 * Storage shape: overrides = { 'supplier|||sku': { trade_price, credit_back_rate, disabled,
 *   cost_price, list_price, pallet_price, half_pallet_price, m2_per_pallet, m2_per_half_pallet, pallet_qty_unit } }
 * A missing key = "use global setting from the modal above".
 */
import React, { useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Badge } from '../../../../components/ui/badge';
import { Layers, ChevronDown, ChevronUp, ChevronRight, RotateCcw, Truck } from 'lucide-react';

const productKey = (p) => `${p.supplier || ''}|||${p.sku || p.supplier_code || ''}`;

const OVERRIDE_FIELDS = ['trade_price', 'credit_back_rate', 'disabled', 'cost_price', 'list_price',
  'pallet_price', 'half_pallet_price', 'm2_per_pallet', 'm2_per_half_pallet', 'pallet_qty_unit'];

const eff = (ov, prod) => (ov !== undefined && ov !== '' ? Number(ov) : (prod != null ? Number(prod) : null));

// Per-pallet profit: rate is inc-VAT per unit/m² → ÷1.2, minus cost, minus credit back (% of ex-VAT)
const palletProfit = (rate, qty, cost, cbRate) => {
  if (!(rate > 0) || !(qty > 0) || !(cost > 0)) return null;
  const exRate = rate / 1.2;
  const perUnit = exRate - cost - exRate * (cbRate / 100);
  return { profit: perUnit * qty, margin: (perUnit / exRate) * 100, total: rate * qty };
};

const PerProductOverridesPanel = ({ products, overrides, setOverrides, globalCreditBack = 2, pricingUnit = 'm2' }) => {
  const [open, setOpen] = useState(false);
  const [expandedPallets, setExpandedPallets] = useState(() => new Set());

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

  const togglePallet = (key) => {
    setExpandedPallets(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const numInput = (key, field, current, placeholder, sku, testPrefix, width = 'w-24') => (
    <Input
      type="number"
      step="0.01"
      value={current ?? ''}
      onChange={(e) => { const v = e.target.value; setField(key, field, v === '' ? '' : Number(v)); }}
      placeholder={placeholder}
      className={`h-9 text-sm ${width} text-right font-mono`}
      data-testid={`${testPrefix}-${sku}`}
    />
  );

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
          <div className="max-h-80 overflow-auto">
            <table className="w-full min-w-[880px] text-sm">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr className="text-left text-gray-500 text-xs">
                  <th className="px-2 py-2 font-medium">Product</th>
                  <th className="px-2 py-2 font-medium text-right w-28">Cost £</th>
                  <th className="px-2 py-2 font-medium text-right w-28">List £</th>
                  <th className="px-2 py-2 font-medium text-right w-32" title="The FINAL price a trade customer pays per unit/m² — the £ discount off list is computed automatically">Trade £ (final)</th>
                  <th className="px-2 py-2 font-medium text-right w-32" title="Profit = ex-VAT trade price (÷1.2) − cost (ex-VAT) − credit back (% of ex-VAT). Margin % = profit ÷ ex-VAT price">Profit / Margin</th>
                  <th className="px-2 py-2 font-medium text-right w-24">Credit %</th>
                  <th className="px-2 py-2 font-medium text-center w-24" title="Half + Full pallet quantities, rates and profit — click to expand">Pallet</th>
                  <th className="px-2 py-2 font-medium text-center w-16">Disable Tier</th>
                  <th className="px-2 py-2 font-medium text-center w-12">Reset</th>
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const key = productKey(p);
                  const sku = p.sku || p.supplier_code;
                  const o = overrides?.[key] || {};
                  const hasAny = OVERRIDE_FIELDS.some(f => o[f] !== undefined);
                  const listPrice = Number(p.list_price ?? p.price ?? p.room_lot_price ?? p.retail_price ?? 0);
                  const costPrice = Number(p.cost_price ?? p.wholesale_price ?? 0);
                  const effList = o.list_price !== undefined && o.list_price !== '' ? Number(o.list_price) : listPrice;
                  const effCost = o.cost_price !== undefined && o.cost_price !== '' ? Number(o.cost_price) : costPrice;
                  const tradePrice = o.trade_price !== undefined && o.trade_price !== '' ? Number(o.trade_price) : null;
                  const cbRate = o.credit_back_rate !== undefined && o.credit_back_rate !== ''
                    ? Number(o.credit_back_rate)
                    : ((globalCreditBack === '' || globalCreditBack == null) ? 2 : Number(globalCreditBack));
                  // Shop margin formula: trade price is inc-VAT → ÷1.2 for ex-VAT,
                  // minus cost (ex-VAT), minus credit back (% of the ex-VAT price).
                  const hasPreview = tradePrice !== null && !Number.isNaN(tradePrice) && tradePrice > 0 && !o.disabled;
                  const exVat = hasPreview ? tradePrice / 1.2 : 0;
                  const cbAmt = hasPreview ? exVat * (cbRate / 100) : 0;
                  const profit = hasPreview && effCost > 0 ? exVat - effCost - cbAmt : null;
                  const margin = profit !== null && exVat > 0 ? (profit / exVat) * 100 : null;
                  const belowCost = hasPreview && effCost > 0 && exVat < effCost;
                  const offList = hasPreview && effList > 0 ? Math.max(0, effList - tradePrice) : null;

                  // Pallet effective values (override wins, product value as fallback/placeholder)
                  const effPalletRate = eff(o.pallet_price, p.pallet_price);
                  const effHalfRate = eff(o.half_pallet_price, p.half_pallet_price);
                  const effPalletQty = eff(o.m2_per_pallet, p.m2_per_pallet);
                  const effHalfQty = eff(o.m2_per_half_pallet, p.m2_per_half_pallet);
                  const qtyUnit = o.pallet_qty_unit || p.pallet_qty_unit || (pricingUnit === 'unit' ? 'unit' : 'm2');
                  const unitLabel = qtyUnit === 'unit' ? 'units' : 'm²';
                  const fullCalc = palletProfit(effPalletRate, effPalletQty, effCost, cbRate);
                  const halfCalc = palletProfit(effHalfRate, effHalfQty, effCost, cbRate);
                  const palletExpanded = expandedPallets.has(key);
                  const hasPalletData = effPalletRate > 0 || effHalfRate > 0 || effPalletQty > 0;

                  return (
                    <React.Fragment key={key}>
                      <tr className={`${palletExpanded ? '' : 'border-b'} ${hasAny ? 'bg-amber-50/60' : ''}`} data-testid={`override-row-${sku}`}>
                        <td className="px-2 py-2 max-w-[240px]">
                          <div className="truncate font-medium text-gray-800" title={p.product_name || p.display_name || p.our_product_name || p.name}>
                            {p.product_name || p.display_name || p.our_product_name || p.name || '—'}
                          </div>
                          <div className="text-[11px] text-gray-400 truncate">{p.supplier} · {sku}</div>
                        </td>
                        <td className="px-2 py-2 text-right">
                          {numInput(key, 'cost_price', o.cost_price, costPrice > 0 ? costPrice.toFixed(2) : '—', sku, 'override-cost')}
                        </td>
                        <td className="px-2 py-2 text-right">
                          {numInput(key, 'list_price', o.list_price, listPrice > 0 ? listPrice.toFixed(2) : '—', sku, 'override-list')}
                        </td>
                        <td className="px-2 py-2 text-right">
                          {numInput(key, 'trade_price', o.trade_price, 'final £', sku, 'override-trade', 'w-28')}
                          {offList !== null && offList > 0 && (
                            <div className="text-[10px] text-gray-400 mt-0.5" data-testid={`override-offlist-${sku}`}>
                              = £{offList.toFixed(2)} off list
                            </div>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right font-mono" data-testid={`override-discounted-${sku}`}>
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
                          <div className="flex items-center justify-end gap-1">
                            <Input
                              type="number"
                              step="0.1"
                              value={o.credit_back_rate ?? ''}
                              onChange={(e) => {
                                const v = e.target.value;
                                setField(key, 'credit_back_rate', v === '' ? '' : Number(v));
                              }}
                              placeholder={String((globalCreditBack === '' || globalCreditBack == null) ? 2 : globalCreditBack)}
                              className="h-9 text-sm w-16 text-right"
                              data-testid={`override-credit-${sku}`}
                            />
                            <span className="text-xs text-gray-500">%</span>
                          </div>
                        </td>
                        <td className="px-2 py-2 text-center">
                          <button
                            type="button"
                            onClick={() => togglePallet(key)}
                            className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-md border text-[11px] font-medium transition-colors ${palletExpanded ? 'bg-green-600 border-green-600 text-white' : hasPalletData ? 'bg-green-50 border-green-300 text-green-700 hover:bg-green-100' : 'bg-white border-gray-200 text-gray-400 hover:bg-gray-50'}`}
                            title="Half + Full pallet quantities, rates and profit"
                            data-testid={`override-pallet-toggle-${sku}`}
                          >
                            <Truck className="w-3 h-3" />
                            {hasPalletData ? (effPalletRate > 0 ? `£${Number(effPalletRate).toFixed(2)}` : 'set') : '—'}
                            {palletExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          </button>
                        </td>
                        <td className="px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={!!o.disabled}
                            onChange={(e) => setDisabled(key, e.target.checked)}
                            className="w-4 h-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                            data-testid={`override-disable-${sku}`}
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
                              data-testid={`override-reset-${sku}`}
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </td>
                      </tr>
                      {palletExpanded && (
                        <tr className="border-b bg-green-50/60" data-testid={`override-pallet-row-${sku}`}>
                          <td colSpan={9} className="px-4 py-2.5">
                            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
                              <label className="flex items-center gap-1.5 text-green-800 font-medium">
                                Qty in
                                <select
                                  value={qtyUnit}
                                  onChange={(e) => setField(key, 'pallet_qty_unit', e.target.value)}
                                  className="h-8 px-1.5 border border-green-300 rounded-md bg-white text-xs"
                                  data-testid={`override-pallet-unit-${sku}`}
                                >
                                  <option value="m2">m²</option>
                                  <option value="unit">units / bags</option>
                                </select>
                              </label>
                              <div className="flex items-center gap-1.5">
                                <span className="text-green-800 font-medium">Full pallet:</span>
                                {numInput(key, 'm2_per_pallet', o.m2_per_pallet, Number(p.m2_per_pallet) > 0 ? String(p.m2_per_pallet) : 'qty', sku, 'override-pallet-qty', 'w-20')}
                                <span className="text-gray-500">{unitLabel} ×</span>
                                {numInput(key, 'pallet_price', o.pallet_price, Number(p.pallet_price) > 0 ? Number(p.pallet_price).toFixed(2) : '£/rate', sku, 'override-pallet', 'w-24')}
                                <span className="text-gray-500">£/{qtyUnit === 'unit' ? 'unit' : 'm²'}</span>
                                <span className="font-mono ml-1" data-testid={`override-pallet-profit-${sku}`}>
                                  {fullCalc ? (
                                    <span className={fullCalc.profit >= 0 ? 'text-emerald-700 font-semibold' : 'text-red-600 font-semibold'} title={`Pallet total £${fullCalc.total.toFixed(2)} inc VAT · profit = qty × (rate÷1.2 − cost − CB)`}>
                                      = £{fullCalc.profit.toFixed(2)} profit · {fullCalc.margin.toFixed(0)}%
                                    </span>
                                  ) : (
                                    <span className="text-gray-400">set qty + rate</span>
                                  )}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <span className="text-green-800 font-medium">½ pallet:</span>
                                {numInput(key, 'm2_per_half_pallet', o.m2_per_half_pallet, Number(p.m2_per_half_pallet) > 0 ? String(p.m2_per_half_pallet) : 'qty', sku, 'override-halfpallet-qty', 'w-20')}
                                <span className="text-gray-500">{unitLabel} ×</span>
                                {numInput(key, 'half_pallet_price', o.half_pallet_price, Number(p.half_pallet_price) > 0 ? Number(p.half_pallet_price).toFixed(2) : '£/rate', sku, 'override-halfpallet', 'w-24')}
                                <span className="text-gray-500">£/{qtyUnit === 'unit' ? 'unit' : 'm²'}</span>
                                <span className="font-mono ml-1" data-testid={`override-halfpallet-profit-${sku}`}>
                                  {halfCalc ? (
                                    <span className={halfCalc.profit >= 0 ? 'text-emerald-700 font-semibold' : 'text-red-600 font-semibold'} title={`½ pallet total £${halfCalc.total.toFixed(2)} inc VAT · profit = qty × (rate÷1.2 − cost − CB)`}>
                                      = £{halfCalc.profit.toFixed(2)} profit · {halfCalc.margin.toFixed(0)}%
                                    </span>
                                  ) : (
                                    <span className="text-gray-400">set qty + rate</span>
                                  )}
                                </span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
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
