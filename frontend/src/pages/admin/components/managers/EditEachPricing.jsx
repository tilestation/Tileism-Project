/**
 * EditEachPricing — the Prices & Sale "Edit each" table.
 * One row per product: Now £ · Was £ · SALE ☐ · CLEARANCE ☐ · Cost £ · Stock.
 * A "Quick fill" bar copies one value down a whole column, flips SALE /
 * CLEARANCE on every row, or builds a sale in one click (Was = today's price,
 * Now = X% off). Only rows that changed are saved — see BulkFieldsModal.
 */
import React, { useState } from 'react';
import { Input } from '../../../../components/ui/input';
import { Edit3, ArrowDown, Flame, Tag, Wand2, Eraser } from 'lucide-react';
import { productDisplayName } from './useManagerBulk';

const round2 = (n) => Math.round(n * 100) / 100;
const isClearanceLabel = (l) => String(l || '').trim().toLowerCase() === 'clearance';

// Current (saved) state of a product as the table needs it
export const rowCurrent = (p) => {
  const now = Number(p.list_price || p.retail_price || p.price || p.room_lot_price || 0);
  const was = Number(p.was_price || 0);
  return {
    now,
    was,
    saleOn: !!p.sale_active && was > now && now > 0,
    clearance: [...(p.labels || []), ...(p.custom_labels || [])].some(isClearanceLabel),
  };
};

// Effective (edited or current) SALE / CLEARANCE flags for a row
export const rowFlags = (p, row = {}) => {
  const cur = rowCurrent(p);
  return { sale: row.sale ?? cur.saleOn, clearance: row.clearance ?? cur.clearance };
};

export const rowHasChanges = (p, row) => {
  if (!row) return false;
  const cur = rowCurrent(p);
  if (['list_price', 'was_price', 'cost_price', 'warehouse_stock'].some(f => row[f] !== undefined && row[f] !== '')) return true;
  if (row.sale !== undefined && row.sale !== cur.saleOn) return true;
  if (row.clearance !== undefined && row.clearance !== cur.clearance) return true;
  return false;
};

// Field edit with the dependent rules: typing a Was ⇒ SALE on (0 ⇒ off); SALE off ⇒ Was cleared
export const applyRowEdit = (row = {}, field, value) => {
  const next = { ...row, [field]: value };
  if (field === 'was_price') {
    if (value !== '' && Number(value) > 0) next.sale = true;
    else if (value !== '' && Number(value) === 0) next.sale = false;
  }
  if (field === 'sale' && value === false) next.was_price = '';
  return next;
};

const Cell = ({ value, onChange, placeholder, testid, step = '0.01', className = '' }) => (
  <Input type="number" step={step} min="0" placeholder={placeholder} value={value ?? ''} onChange={(e) => onChange(e.target.value)} className={`h-7 text-xs ${className}`} data-testid={testid} />
);

const EditEachPricing = ({ selectedList, edits, setEdits }) => {
  const [fill, setFill] = useState({ list_price: '', was_price: '', cost_price: '', warehouse_stock: '', pct: '' });
  const setFillVal = (k, v) => setFill(prev => ({ ...prev, [k]: v }));
  const setCell = (sku, field, v) => setEdits(prev => ({ ...prev, [sku]: applyRowEdit(prev[sku], field, v) }));
  const skuOf = (p) => p.sku || p.supplier_code;

  const fillColumn = (field) => {
    const v = fill[field];
    if (v === '') return;
    setEdits(prev => {
      const next = { ...prev };
      selectedList.forEach(p => { next[skuOf(p)] = applyRowEdit(prev[skuOf(p)], field, v); });
      return next;
    });
  };
  const setFlagAll = (field, on) => setEdits(prev => {
    const next = { ...prev };
    selectedList.forEach(p => { next[skuOf(p)] = applyRowEdit(prev[skuOf(p)], field, on); });
    return next;
  });
  const makeSale = () => {
    const pct = Number(fill.pct);
    if (!(pct > 0 && pct < 100)) return;
    setEdits(prev => {
      const next = { ...prev };
      selectedList.forEach(p => {
        const { now } = rowCurrent(p);
        if (now > 0) next[skuOf(p)] = { ...(prev[skuOf(p)] || {}), was_price: now.toFixed(2), list_price: round2(now * (1 - pct / 100)).toFixed(2), sale: true };
      });
      return next;
    });
  };
  const clearEdits = () => setEdits({});

  return (
    <div className="space-y-2">
      <div className="bg-purple-50 border border-purple-100 text-purple-700 text-[11px] p-2 rounded flex items-start gap-1.5">
        <Edit3 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
        <span>
          Change any cell — only rows you touch are saved, blank = unchanged. <b>Now £</b> is what customers pay.
          <b> Was £</b> is the crossed-out price — typing one turns <b>SALE</b> on; untick SALE (or enter 0) to remove it.
          <b> CLEARANCE</b> is the flashing badge + Clearance page. Cost &amp; Stock are admin-only.
        </span>
      </div>

      {/* Quick fill */}
      <div className="border border-violet-200 rounded-lg bg-violet-50/60 p-2 space-y-2" data-testid="edit-quick-fill">
        <div className="flex items-center gap-2 text-xs font-semibold text-violet-900">
          <Wand2 className="w-3.5 h-3.5" /> Quick fill
          <span className="text-[10px] font-normal text-violet-700">— type once, press ↓ to copy into every row, then tweak the odd one</span>
          <button type="button" onClick={clearEdits} className="ml-auto inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-red-600" data-testid="edit-clear-all">
            <Eraser className="w-3 h-3" /> clear all edits
          </button>
        </div>
        <div className="flex flex-wrap items-end gap-2 text-[11px]">
          {[
            ['list_price', 'Now £', '24.99', '0.01', 'w-20'],
            ['was_price', 'Was £', '29.99', '0.01', 'w-20'],
            ['cost_price', 'Cost £', '12.50', '0.01', 'w-20'],
            ['warehouse_stock', 'Stock', '100', '1', 'w-16'],
          ].map(([field, label, ph, step, w]) => (
            <div key={field} className="flex items-end gap-1">
              <div>
                <div className="text-[10px] text-violet-800 mb-0.5">{label}</div>
                <Cell value={fill[field]} onChange={(v) => setFillVal(field, v)} placeholder={ph} step={step} className={`${w} bg-white`} testid={`fill-${field}`} />
              </div>
              <button type="button" onClick={() => fillColumn(field)} disabled={fill[field] === ''} className="h-7 px-1.5 rounded border border-violet-300 bg-white text-violet-700 hover:bg-violet-100 disabled:opacity-40" title={`Copy ${label} into every row`} data-testid={`fill-apply-${field}`}>
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-1 pl-2 border-l border-violet-200">
            <span className="inline-flex items-center gap-1 text-rose-700 font-semibold"><Tag className="w-3 h-3" /> SALE</span>
            <button type="button" onClick={() => setFlagAll('sale', true)} className="h-7 px-2 rounded border border-rose-300 bg-white text-rose-700 hover:bg-rose-50" data-testid="fill-sale-all-on">all on</button>
            <button type="button" onClick={() => setFlagAll('sale', false)} className="h-7 px-2 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50" data-testid="fill-sale-all-off">all off</button>
          </div>
          <div className="flex items-center gap-1 pl-2 border-l border-violet-200">
            <span className="inline-flex items-center gap-1 text-amber-700 font-semibold"><Flame className="w-3 h-3" /> CLEARANCE</span>
            <button type="button" onClick={() => setFlagAll('clearance', true)} className="h-7 px-2 rounded border border-amber-300 bg-white text-amber-800 hover:bg-amber-50" data-testid="fill-clearance-all-on">all on</button>
            <button type="button" onClick={() => setFlagAll('clearance', false)} className="h-7 px-2 rounded border border-gray-300 bg-white text-gray-600 hover:bg-gray-50" data-testid="fill-clearance-all-off">all off</button>
          </div>
          <div className="flex items-end gap-1 pl-2 border-l border-violet-200">
            <div>
              <div className="text-[10px] text-rose-800 mb-0.5">Sale maker — % off</div>
              <Cell value={fill.pct} onChange={(v) => setFillVal('pct', v)} placeholder="20" step="1" className="w-16 bg-white" testid="fill-pct" />
            </div>
            <button type="button" onClick={makeSale} disabled={!(Number(fill.pct) > 0 && Number(fill.pct) < 100)} className="h-7 px-2 rounded bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-40 font-medium" title="Was = today's price, Now = today's price minus this %, SALE on — for every row" data-testid="fill-make-sale">
              Was = today's price, Now = −{fill.pct || 'X'}%
            </button>
          </div>
        </div>
      </div>

      <div className="max-h-[42vh] overflow-auto border border-gray-200 rounded-lg">
        <table className="w-full min-w-[900px] text-xs">
          <thead className="bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
            <tr>
              <th className="px-2 py-2 text-left font-medium text-gray-700 w-[30%]">Product</th>
              <th className="px-2 py-2 text-left font-medium text-gray-700">Now £</th>
              <th className="px-2 py-2 text-left font-medium text-rose-700">Was £</th>
              <th className="px-2 py-2 text-center font-medium text-rose-700">SALE</th>
              <th className="px-2 py-2 text-center font-medium text-amber-700">CLEARANCE</th>
              <th className="px-2 py-2 text-left font-medium text-gray-700">Cost £</th>
              <th className="px-2 py-2 text-left font-medium text-gray-700">Stock</th>
            </tr>
          </thead>
          <tbody>
            {selectedList.map(p => {
              const sku = skuOf(p);
              const row = edits[sku] || {};
              const cur = rowCurrent(p);
              const flags = rowFlags(p, row);
              const changed = rowHasChanges(p, row);
              const name = productDisplayName(p);
              return (
                <tr key={sku} className={`border-b border-gray-100 align-top ${changed ? 'bg-amber-50/50' : ''}`} data-testid={`bulk-edit-row-${sku}`}>
                  <td className="px-2 py-1.5">
                    <div className="font-medium text-gray-900 whitespace-normal break-words leading-snug" title={name} data-testid={`bulk-edit-name-${sku}`}>{name}</div>
                    <div className="text-[10px] text-gray-500 flex items-center gap-1 flex-wrap">
                      <span>{p.supplier} · {sku}</span>
                      {cur.saleOn && <span className="px-1 rounded bg-rose-100 text-rose-700 font-bold text-[9px]">SALE</span>}
                      {cur.clearance && <span className="px-1 rounded bg-amber-100 text-amber-800 font-bold text-[9px]">CLEARANCE</span>}
                      {changed && <span className="text-amber-700 font-semibold">· changed</span>}
                    </div>
                  </td>
                  <td className="px-2 py-1">
                    <div className="text-[10px] text-gray-400">£{cur.now.toFixed(2)}</div>
                    <Cell value={row.list_price} onChange={(v) => setCell(sku, 'list_price', v)} placeholder="new" testid={`bulk-edit-price-${sku}`} />
                  </td>
                  <td className="px-2 py-1">
                    <div className="text-[10px] text-gray-400">
                      {cur.saleOn
                        ? <><s>£{cur.was.toFixed(2)}</s> <span className="text-rose-600 font-semibold">−{Math.round((cur.was - cur.now) / cur.was * 100)}%</span></>
                        : 'no sale'}
                    </div>
                    <Cell value={row.was_price} onChange={(v) => setCell(sku, 'was_price', v)} placeholder={flags.sale ? 'was' : '—'} className="border-rose-200 focus-visible:ring-rose-300" testid={`bulk-edit-was-${sku}`} />
                  </td>
                  <td className="px-2 py-1 text-center">
                    <input type="checkbox" checked={!!flags.sale} onChange={(e) => setCell(sku, 'sale', e.target.checked)} className="w-4 h-4 mt-4 accent-rose-600" title="SALE — needs a Was £ higher than Now £" data-testid={`bulk-edit-sale-${sku}`} />
                  </td>
                  <td className="px-2 py-1 text-center">
                    <input type="checkbox" checked={!!flags.clearance} onChange={(e) => setCell(sku, 'clearance', e.target.checked)} className="w-4 h-4 mt-4 accent-amber-600" title="CLEARANCE badge + Clearance page / leaflet" data-testid={`bulk-edit-clearance-${sku}`} />
                  </td>
                  <td className="px-2 py-1">
                    <div className="text-[10px] text-gray-400">£{Number(p.cost_price || 0).toFixed(2)}</div>
                    <Cell value={row.cost_price} onChange={(v) => setCell(sku, 'cost_price', v)} placeholder="new" testid={`bulk-edit-cost-${sku}`} />
                  </td>
                  <td className="px-2 py-1">
                    <div className="text-[10px] text-gray-400">{Number(p.warehouse_stock || 0)}</div>
                    <Cell value={row.warehouse_stock} onChange={(v) => setCell(sku, 'warehouse_stock', v)} placeholder="new" step="1" testid={`bulk-edit-stock-${sku}`} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default EditEachPricing;
