/**
 * MarginGuardBanner — red warning banner shown at the top of every Manager
 * listing products whose CURRENT trade price sells at a loss.
 *
 * Formula (per the shop's rule): trade price = list price after the stored
 * trade discount; profit = trade price − cost − credit back (% of trade price).
 * A product is flagged when profit < 0.
 */
import React, { useState } from 'react';
import { ShieldAlert, ChevronDown, ChevronUp, Percent, Eye, EyeOff } from 'lucide-react';
import { getProductKey, productDisplayName } from './useManagerBulk';

export const computeMarginGuard = (products, defaults = {}) => {
  const dTd = Number(defaults.tradeDiscount ?? 5);
  const dType = defaults.tradeType === 'fixed' ? 'fixed' : 'percent';
  const dCb = Number(defaults.creditBack ?? 2);
  const flagged = [];
  (products || []).forEach(p => {
    const list = Number(p.list_price ?? p.price ?? p.room_lot_price ?? p.retail_price ?? 0);
    const cost = Number(p.cost_price ?? p.wholesale_price ?? 0);
    if (!(list > 0) || !(cost > 0)) return;
    const td = p.trade_discount !== undefined && p.trade_discount !== null ? Number(p.trade_discount) : dTd;
    const type = p.trade_discount_type ? (String(p.trade_discount_type).toLowerCase() === 'fixed' ? 'fixed' : 'percent') : dType;
    const tradePrice = type === 'fixed' ? Math.max(0, list - td) : list * (1 - td / 100);
    const cbRate = p.credit_back_rate !== undefined && p.credit_back_rate !== null ? Number(p.credit_back_rate) : dCb;
    const cbAmt = tradePrice * (cbRate / 100);
    const profit = tradePrice - cost - cbAmt;
    if (profit >= 0) return;
    flagged.push({
      key: getProductKey(p),
      product: p,
      name: productDisplayName(p),
      sku: p.sku || p.supplier_code || '',
      supplier: p.supplier || '',
      list,
      cost,
      tradePrice,
      tradeLabel: type === 'fixed' ? `£${td.toFixed(2)} off` : `${td}% off`,
      cbAmt,
      cbRate,
      loss: -profit,
      belowCost: tradePrice < cost,
    });
  });
  flagged.sort((a, b) => b.loss - a.loss);
  return flagged;
};

const MarginGuardBanner = ({ flagged, active, onToggleShowOnly, onFixSelected }) => {
  const [open, setOpen] = useState(false);
  if (!flagged || flagged.length === 0) return null;
  const totalLoss = flagged.reduce((s, f) => s + f.loss, 0);
  return (
    <div className="rounded-lg border-2 border-red-300 bg-red-50 overflow-hidden" data-testid="margin-guard-banner">
      <div className="flex items-center gap-3 px-4 py-3">
        <ShieldAlert className="w-5 h-5 text-red-600 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-red-800 text-sm" data-testid="margin-guard-summary">
            Margin Guard: {flagged.length} product{flagged.length !== 1 ? 's' : ''} sell{flagged.length === 1 ? 's' : ''} at a loss at the current trade price
          </p>
          <p className="text-xs text-red-600">
            Trade price − cost − credit back is negative. Combined loss £{totalLoss.toFixed(2)}/unit across the list.
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleShowOnly}
          className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full border text-xs font-medium transition-colors ${active ? 'bg-red-600 border-red-600 text-white' : 'bg-white border-red-300 text-red-700 hover:bg-red-100'}`}
          title={active ? 'Showing only loss-making products — click to show all' : 'Filter the table to only these products'}
          data-testid="margin-guard-show-only"
        >
          {active ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          {active ? 'Show all' : 'Show only these'}
        </button>
        <button
          type="button"
          onClick={onFixSelected}
          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-red-600 hover:bg-red-700 text-white text-xs font-medium transition-colors"
          title="Select every flagged product and open Tier Pricing to fix"
          data-testid="margin-guard-fix-btn"
        >
          <Percent className="w-3.5 h-3.5" />
          Select &amp; fix pricing
        </button>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="text-red-600 hover:text-red-800 p-1"
          title={open ? 'Hide list' : 'Show list'}
          data-testid="margin-guard-expand"
        >
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>
      {open && (
        <div className="max-h-64 overflow-auto border-t border-red-200 bg-white">
          <table className="w-full text-xs">
            <thead className="bg-red-50 sticky top-0">
              <tr className="text-left text-red-800">
                <th className="px-3 py-1.5 font-medium">Product</th>
                <th className="px-2 py-1.5 font-medium text-right">List £</th>
                <th className="px-2 py-1.5 font-medium text-right">Trade</th>
                <th className="px-2 py-1.5 font-medium text-right">Trade £</th>
                <th className="px-2 py-1.5 font-medium text-right">Cost £</th>
                <th className="px-2 py-1.5 font-medium text-right">Credit Back</th>
                <th className="px-2 py-1.5 font-medium text-right">Loss / unit</th>
              </tr>
            </thead>
            <tbody>
              {flagged.map(f => (
                <tr key={f.key} className="border-b border-red-100" data-testid={`margin-guard-row-${f.sku}`}>
                  <td className="px-3 py-1.5 max-w-[280px]">
                    <div className="truncate font-medium text-gray-800" title={f.name}>{f.name}</div>
                    <div className="text-[10px] text-gray-400 truncate">{f.supplier} · {f.sku}</div>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono">£{f.list.toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-right text-gray-500">{f.tradeLabel}</td>
                  <td className="px-2 py-1.5 text-right font-mono font-semibold text-red-700">£{f.tradePrice.toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-right font-mono">£{f.cost.toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-orange-600">−£{f.cbAmt.toFixed(2)} ({f.cbRate}%)</td>
                  <td className="px-2 py-1.5 text-right font-mono font-bold text-red-600">
                    −£{f.loss.toFixed(2)}{f.belowCost && <span className="ml-1 text-[9px] font-semibold align-middle" title="Trade price is below cost even before credit back">⚠ below cost</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default MarginGuardBanner;
