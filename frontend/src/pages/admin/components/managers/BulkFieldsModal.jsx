/**
 * BulkFieldsModal — 3-mode price / cost / stock editor for selected products.
 *
 *   ▸ SET       Overwrite every selected product with the same value.
 *               (Best for: standardising a collection to one flat price.)
 *
 *   ▸ ADJUST    Bump each product's existing value by a percentage or £ amount.
 *               (Best for: 5% collection-wide price rise, £2 cost decrease,
 *               15% sale — preserves the relative differences between SKUs.)
 *
 *   ▸ EDIT EACH Per-SKU inline table with editable inputs for List Price,
 *               Cost, Stock, and Sale %. Only rows the user touches get saved.
 *               (Best for: tweaking a small number of SKUs precisely.)
 *
 * All modes go through the same verified `bulk-update-unified` endpoint. Silent
 * verification failures are surfaced immediately.
 */

import React, { useMemo, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import {
  PoundSterling, Package, Percent, Save, RefreshCw, AlertTriangle, Plus, Minus, Equal, Edit3, TrendingUp, Undo2,
} from 'lucide-react';
import { useBulkUndo } from './useBulkUndo';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// --------------- helpers ---------------
const round2 = (n) => Math.round(n * 100) / 100;

const computeAdjusted = (currentValue, op, type, amount) => {
  const base = Number(currentValue || 0);
  const amt = Number(amount || 0);
  if (isNaN(amt) || amt === 0) return null;
  const signed = op === '-' ? -amt : amt;
  if (type === 'percent') return round2(base + (base * signed) / 100);
  return round2(base + signed);
};

// --------------- Set mode ---------------
const SetMode = ({ selectedList, values, setValues, checks, setChecks }) => {
  const avg = useMemo(() => {
    const avgOr = (arr) => {
      const nums = arr.filter(v => typeof v === 'number' && !isNaN(v) && v > 0);
      if (nums.length === 0) return null;
      return (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2);
    };
    return {
      price: avgOr(selectedList.map(p => Number(p.list_price || p.retail_price))),
      cost:  avgOr(selectedList.map(p => Number(p.cost_price))),
      stock: avgOr(selectedList.map(p => Number(p.warehouse_stock))),
    };
  }, [selectedList]);

  const toggle = (k) => setChecks(prev => ({ ...prev, [k]: !prev[k] }));
  const setVal = (k, v) => setValues(prev => ({ ...prev, [k]: v }));

  return (
    <div className="space-y-2">
      <FieldRow check={checks.price} onToggle={() => toggle('price')} label="List Price" icon={<PoundSterling className="w-4 h-4 text-emerald-600" />} avg={avg.price}
        input={<Input type="number" step="0.01" min="0" placeholder="e.g. 24.99" value={values.price} onChange={e => setVal('price', e.target.value)} disabled={!checks.price} data-testid="bulk-fields-price" />} unit="£" />
      <FieldRow check={checks.cost} onToggle={() => toggle('cost')} label="Cost Price" icon={<PoundSterling className="w-4 h-4 text-blue-600" />} avg={avg.cost}
        input={<Input type="number" step="0.01" min="0" placeholder="e.g. 12.50" value={values.cost} onChange={e => setVal('cost', e.target.value)} disabled={!checks.cost} data-testid="bulk-fields-cost" />} unit="£" />
      <FieldRow check={checks.stock} onToggle={() => toggle('stock')} label="Warehouse Stock" icon={<Package className="w-4 h-4 text-purple-600" />} avg={avg.stock}
        input={<Input type="number" step="1" min="0" placeholder="e.g. 100" value={values.stock} onChange={e => setVal('stock', e.target.value)} disabled={!checks.stock} data-testid="bulk-fields-stock" />} unit="pcs" />
      <FieldRow check={checks.sale} onToggle={() => toggle('sale')} label="Sale %" icon={<Percent className="w-4 h-4 text-rose-600" />} avg={null}
        input={<Input type="number" step="1" min="0" max="100" placeholder="e.g. 15" value={values.sale} onChange={e => setVal('sale', e.target.value)} disabled={!checks.sale} data-testid="bulk-fields-sale" />} unit="%" />
    </div>
  );
};

const FieldRow = ({ check, onToggle, label, icon, input, unit, avg }) => (
  <div className={`border rounded-lg p-2 flex items-center gap-3 ${check ? 'border-emerald-200 bg-emerald-50/40' : 'border-gray-200'}`}>
    <input type="checkbox" checked={check} onChange={onToggle} className="w-4 h-4 accent-emerald-600" />
    <div className="w-8 h-8 rounded-md flex items-center justify-center bg-white border border-gray-100">{icon}</div>
    <div className="flex-1 min-w-0">
      <div className="text-sm font-medium text-gray-800">{label}</div>
      {avg !== null && avg !== undefined && (
        <div className="text-[10px] text-gray-500">Current avg: {unit === '£' ? '£' : ''}{avg}{unit !== '£' ? ' ' + unit : ''}</div>
      )}
    </div>
    <div className="w-40 flex items-center gap-1">
      {input}
      <span className="text-xs text-gray-500 flex-shrink-0">{unit}</span>
    </div>
  </div>
);

// --------------- Adjust mode ---------------
const AdjustRow = ({ label, icon, unit, checked, onToggle, op, setOp, type, setType, amount, setAmount, avg, testKey }) => {
  const newAvg = amount && avg ? computeAdjusted(avg, op, type, amount) : null;
  return (
    <div className={`border rounded-lg p-2 ${checked ? 'border-emerald-200 bg-emerald-50/40' : 'border-gray-200'}`}>
      <div className="flex items-center gap-3">
        <input type="checkbox" checked={checked} onChange={onToggle} className="w-4 h-4 accent-emerald-600" data-testid={`bulk-adjust-check-${testKey}`} />
        <div className="w-8 h-8 rounded-md flex items-center justify-center bg-white border border-gray-100">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-gray-800">{label}</div>
          {avg && <div className="text-[10px] text-gray-500">Current avg: {unit === '£' ? '£' : ''}{avg}{unit !== '£' ? ' ' + unit : ''}</div>}
        </div>
      </div>
      {checked && (
        <div className="mt-2 flex items-center gap-1 pl-11">
          <div className="inline-flex rounded border border-gray-300 overflow-hidden text-xs">
            <button type="button" onClick={() => setOp('+')} className={`px-2 py-1 ${op === '+' ? 'bg-emerald-600 text-white' : 'bg-white'}`} data-testid={`bulk-adjust-op-plus-${testKey}`}>
              <Plus className="w-3 h-3" />
            </button>
            <button type="button" onClick={() => setOp('-')} className={`px-2 py-1 ${op === '-' ? 'bg-red-500 text-white' : 'bg-white'}`} data-testid={`bulk-adjust-op-minus-${testKey}`}>
              <Minus className="w-3 h-3" />
            </button>
          </div>
          <Input type="number" step="0.01" min="0" placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-20" data-testid={`bulk-adjust-amount-${testKey}`} />
          <div className="inline-flex rounded border border-gray-300 overflow-hidden text-xs">
            <button type="button" onClick={() => setType('percent')} className={`px-2 py-1 ${type === 'percent' ? 'bg-slate-800 text-white' : 'bg-white'}`} data-testid={`bulk-adjust-type-pct-${testKey}`}>%</button>
            <button type="button" onClick={() => setType('fixed')} className={`px-2 py-1 ${type === 'fixed' ? 'bg-slate-800 text-white' : 'bg-white'}`} data-testid={`bulk-adjust-type-flat-${testKey}`}>{unit === '£' ? '£' : unit}</button>
          </div>
          {newAvg !== null && (
            <div className="text-[11px] text-emerald-700 ml-2 flex items-center gap-1">
              <Equal className="w-3 h-3" /> New avg: <b>{unit === '£' ? '£' : ''}{newAvg}{unit !== '£' ? ' ' + unit : ''}</b>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const AdjustMode = ({ selectedList, adjust, setAdjust }) => {
  const avg = useMemo(() => {
    const avgOr = (arr) => {
      const nums = arr.filter(v => typeof v === 'number' && !isNaN(v) && v > 0);
      if (nums.length === 0) return null;
      return (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2);
    };
    return {
      price: avgOr(selectedList.map(p => Number(p.list_price || p.retail_price))),
      cost:  avgOr(selectedList.map(p => Number(p.cost_price))),
      stock: avgOr(selectedList.map(p => Number(p.warehouse_stock))),
      sale:  avgOr(selectedList.map(p => Number(p.sale_pct))),
    };
  }, [selectedList]);

  const set = (key, patch) => setAdjust(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));

  return (
    <div className="space-y-2">
      <div className="bg-blue-50 border border-blue-100 text-blue-700 text-[11px] p-2 rounded flex items-center gap-1.5">
        <TrendingUp className="w-3.5 h-3.5 flex-shrink-0" />
        Bumps each product&rsquo;s <b className="font-medium">own</b> value — relative differences are preserved.
      </div>
      <AdjustRow label="List Price" icon={<PoundSterling className="w-4 h-4 text-emerald-600" />} unit="£" avg={avg.price} testKey="price"
        checked={adjust.price.on} onToggle={() => set('price', { on: !adjust.price.on })}
        op={adjust.price.op} setOp={(v) => set('price', { op: v })}
        type={adjust.price.type} setType={(v) => set('price', { type: v })}
        amount={adjust.price.amount} setAmount={(v) => set('price', { amount: v })} />
      <AdjustRow label="Cost Price" icon={<PoundSterling className="w-4 h-4 text-blue-600" />} unit="£" avg={avg.cost} testKey="cost"
        checked={adjust.cost.on} onToggle={() => set('cost', { on: !adjust.cost.on })}
        op={adjust.cost.op} setOp={(v) => set('cost', { op: v })}
        type={adjust.cost.type} setType={(v) => set('cost', { type: v })}
        amount={adjust.cost.amount} setAmount={(v) => set('cost', { amount: v })} />
      <AdjustRow label="Warehouse Stock" icon={<Package className="w-4 h-4 text-purple-600" />} unit="pcs" avg={avg.stock} testKey="stock"
        checked={adjust.stock.on} onToggle={() => set('stock', { on: !adjust.stock.on })}
        op={adjust.stock.op} setOp={(v) => set('stock', { op: v })}
        type={adjust.stock.type} setType={(v) => set('stock', { type: v })}
        amount={adjust.stock.amount} setAmount={(v) => set('stock', { amount: v })} />
      <AdjustRow label="Sale %" icon={<Percent className="w-4 h-4 text-rose-600" />} unit="%" avg={avg.sale} testKey="sale"
        checked={adjust.sale.on} onToggle={() => set('sale', { on: !adjust.sale.on })}
        op={adjust.sale.op} setOp={(v) => set('sale', { op: v })}
        type={adjust.sale.type} setType={(v) => set('sale', { type: v })}
        amount={adjust.sale.amount} setAmount={(v) => set('sale', { amount: v })} />
    </div>
  );
};

// --------------- Edit each mode ---------------
const EditEachMode = ({ selectedList, edits, setEdits }) => {
  const setCell = (sku, field, v) => setEdits(prev => ({ ...prev, [sku]: { ...(prev[sku] || {}), [field]: v } }));
  return (
    <div className="space-y-2">
      <div className="bg-purple-50 border border-purple-100 text-purple-700 text-[11px] p-2 rounded flex items-center gap-1.5">
        <Edit3 className="w-3.5 h-3.5 flex-shrink-0" />
        Change any cell. Only rows you touch are saved. Left blank &rarr; unchanged.
      </div>
      <div className="max-h-[45vh] overflow-y-auto border border-gray-200 rounded-lg">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
            <tr>
              <th className="px-2 py-2 text-left font-medium text-gray-700">Product</th>
              <th className="px-2 py-2 text-left font-medium text-gray-700">List £</th>
              <th className="px-2 py-2 text-left font-medium text-gray-700">Cost £</th>
              <th className="px-2 py-2 text-left font-medium text-gray-700">Stock</th>
              <th className="px-2 py-2 text-left font-medium text-gray-700">Sale %</th>
            </tr>
          </thead>
          <tbody>
            {selectedList.map(p => {
              const sku = p.sku || p.supplier_code;
              const row = edits[sku] || {};
              const name = p.our_product_name || p.product_name || p.name || sku;
              return (
                <tr key={sku} className="border-b border-gray-100" data-testid={`bulk-edit-row-${sku}`}>
                  <td className="px-2 py-1 max-w-[220px]">
                    <div className="font-medium text-gray-900 line-clamp-1">{name}</div>
                    <div className="text-[10px] text-gray-500">{p.supplier} · {sku}</div>
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex items-baseline gap-1">
                      <span className="text-[10px] text-gray-400">£{Number(p.list_price || p.retail_price || 0).toFixed(2)}</span>
                    </div>
                    <Input type="number" step="0.01" min="0" placeholder="new" value={row.list_price ?? ''} onChange={(e) => setCell(sku, 'list_price', e.target.value)} className="h-7 text-xs" data-testid={`bulk-edit-price-${sku}`} />
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex items-baseline gap-1">
                      <span className="text-[10px] text-gray-400">£{Number(p.cost_price || 0).toFixed(2)}</span>
                    </div>
                    <Input type="number" step="0.01" min="0" placeholder="new" value={row.cost_price ?? ''} onChange={(e) => setCell(sku, 'cost_price', e.target.value)} className="h-7 text-xs" data-testid={`bulk-edit-cost-${sku}`} />
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex items-baseline gap-1">
                      <span className="text-[10px] text-gray-400">{Number(p.warehouse_stock || 0)}</span>
                    </div>
                    <Input type="number" step="1" min="0" placeholder="new" value={row.warehouse_stock ?? ''} onChange={(e) => setCell(sku, 'warehouse_stock', e.target.value)} className="h-7 text-xs" data-testid={`bulk-edit-stock-${sku}`} />
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex items-baseline gap-1">
                      <span className="text-[10px] text-gray-400">{Number(p.sale_pct || 0)}%</span>
                    </div>
                    <Input type="number" step="1" min="0" max="100" placeholder="new" value={row.sale_pct ?? ''} onChange={(e) => setCell(sku, 'sale_pct', e.target.value)} className="h-7 text-xs" data-testid={`bulk-edit-sale-${sku}`} />
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

// --------------- Main modal ---------------
const BulkFieldsModal = ({ open, onOpenChange, selectedList = [], onSuccess, themeColor = 'orange' }) => {
  const [mode, setMode] = useState('set');
  // Set mode state
  const [setValues, setSetValues] = useState({ price: '', cost: '', stock: '', sale: '' });
  const [setChecks, setSetChecks] = useState({ price: false, cost: false, stock: false, sale: false });
  // Adjust mode state
  const [adjust, setAdjust] = useState({
    price: { on: false, op: '+', type: 'percent', amount: '' },
    cost:  { on: false, op: '+', type: 'percent', amount: '' },
    stock: { on: false, op: '+', type: 'fixed',   amount: '' },
    sale:  { on: false, op: '+', type: 'fixed',   amount: '' },
  });
  // Edit each state — { [sku]: { list_price, cost_price, warehouse_stock, sale_pct } }
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const { snapshotFor, showUndoToast } = useBulkUndo();

  // Fields this modal ever touches — used to snapshot the pre-state so a
  // single Undo click can revert every mutation regardless of mode.
  const TOUCHED_FIELDS = ['list_price', 'retail_price', 'cost_price', 'warehouse_stock', 'sale_pct'];

  const themeBtn = {
    orange: 'bg-orange-600 hover:bg-orange-700 text-white',
    blue:   'bg-blue-600   hover:bg-blue-700   text-white',
    amber:  'bg-amber-600  hover:bg-amber-700  text-white',
    cyan:   'bg-cyan-600   hover:bg-cyan-700   text-white',
    red:    'bg-red-600    hover:bg-red-700    text-white',
    slate:  'bg-slate-700  hover:bg-slate-800  text-white',
    purple: 'bg-purple-600 hover:bg-purple-700 text-white',
  }[themeColor] || 'bg-orange-600 hover:bg-orange-700 text-white';

  const resetState = useCallback(() => {
    setSetValues({ price: '', cost: '', stock: '', sale: '' });
    setSetChecks({ price: false, cost: false, stock: false, sale: false });
    setAdjust({
      price: { on: false, op: '+', type: 'percent', amount: '' },
      cost:  { on: false, op: '+', type: 'percent', amount: '' },
      stock: { on: false, op: '+', type: 'fixed',   amount: '' },
      sale:  { on: false, op: '+', type: 'fixed',   amount: '' },
    });
    setEdits({});
  }, []);

  const changeCounts = useMemo(() => {
    if (mode === 'set') {
      const count = Object.values(setChecks).filter(Boolean).length;
      return { fields: count, rows: count > 0 ? selectedList.length : 0 };
    }
    if (mode === 'adjust') {
      const active = Object.values(adjust).filter(a => a.on && Number(a.amount || 0) > 0).length;
      return { fields: active, rows: active > 0 ? selectedList.length : 0 };
    }
    // edit
    const changedRows = Object.entries(edits).filter(([sku, v]) => v && Object.values(v).some(x => x !== '' && x !== null && x !== undefined));
    return { fields: 0, rows: changedRows.length };
  }, [mode, setChecks, adjust, edits, selectedList.length]);

  // Post one API call per SKU (needed when values differ per SKU)
  const saveOnePerSku = async (perSkuUpdates) => {
    let successCount = 0;
    const failures = [];
    for (const { sku, idField, updates } of perSkuUpdates) {
      if (!updates || Object.keys(updates).length === 0) continue;
      try {
        const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_ids: [sku], id_field: idField, updates, mode: 'replace' }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (Array.isArray(data.verification_failures) && data.verification_failures.length > 0) {
          failures.push({ sku, message: 'Verification failed', details: data.verification_failures });
        } else {
          successCount++;
        }
      } catch (err) {
        failures.push({ sku, message: err.message });
      }
    }
    return { successCount, failures };
  };

  const handleSave = async () => {
    if (selectedList.length === 0) return;
    setSaving(true);
    // Snapshot the pre-state of every SKU across the fields this modal touches.
    // Called BEFORE any DB write so Undo restores exactly what was there.
    const snapshot = snapshotFor(selectedList, TOUCHED_FIELDS);
    let successMsg = '';
    let hadFailures = false;
    try {
      if (mode === 'set') {
        const updates = {};
        if (setChecks.price && setValues.price !== '') { const n = parseFloat(setValues.price); if (isNaN(n) || n < 0) throw new Error('List price invalid'); updates.list_price = n; updates.retail_price = n; }
        if (setChecks.cost  && setValues.cost  !== '') { const n = parseFloat(setValues.cost);  if (isNaN(n) || n < 0) throw new Error('Cost price invalid'); updates.cost_price = n; }
        if (setChecks.stock && setValues.stock !== '') { const n = parseInt(setValues.stock, 10); if (isNaN(n) || n < 0) throw new Error('Stock invalid'); updates.warehouse_stock = n; }
        if (setChecks.sale  && setValues.sale  !== '') { const n = parseFloat(setValues.sale);  if (isNaN(n) || n < 0 || n > 100) throw new Error('Sale % must be 0-100'); updates.sale_pct = n; }
        if (Object.keys(updates).length === 0) throw new Error('Tick at least one field and enter a value');

        // Bulk endpoint — one call with shared updates
        const skuList = selectedList.filter(p => p.sku).map(p => p.sku);
        const supplierCodeList = selectedList.filter(p => !p.sku && p.supplier_code).map(p => p.supplier_code);
        let total = 0; const allFails = [];
        for (const [ids, idField] of [[skuList, 'sku'], [supplierCodeList, 'supplier_code']]) {
          if (ids.length === 0) continue;
          const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ product_ids: ids, id_field: idField, updates, mode: 'replace' }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = await res.json();
          total += data.updated_count || 0;
          if (Array.isArray(data.verification_failures)) allFails.push(...data.verification_failures);
        }
        if (allFails.length > 0) {
          hadFailures = true;
          toast.warning(`Updated ${total}, but ${allFails.length} verification failure(s) — see console`, { duration: 12000 });
          console.warn('[Bulk Fields] Verification failures:', allFails);
        } else {
          successMsg = `Updated ${total} product${total !== 1 ? 's' : ''}`;
        }
      }
      else if (mode === 'adjust') {
        const perSku = selectedList.map(p => {
          const sku = p.sku || p.supplier_code;
          const idField = p.sku ? 'sku' : 'supplier_code';
          const updates = {};
          if (adjust.price.on && adjust.price.amount) {
            const newV = computeAdjusted(p.list_price || p.retail_price || 0, adjust.price.op, adjust.price.type, adjust.price.amount);
            if (newV !== null && newV >= 0) { updates.list_price = newV; updates.retail_price = newV; }
          }
          if (adjust.cost.on && adjust.cost.amount) {
            const newV = computeAdjusted(p.cost_price || 0, adjust.cost.op, adjust.cost.type, adjust.cost.amount);
            if (newV !== null && newV >= 0) updates.cost_price = newV;
          }
          if (adjust.stock.on && adjust.stock.amount) {
            const newV = computeAdjusted(p.warehouse_stock || 0, adjust.stock.op, adjust.stock.type, adjust.stock.amount);
            if (newV !== null && newV >= 0) updates.warehouse_stock = Math.round(newV);
          }
          if (adjust.sale.on && adjust.sale.amount) {
            const newV = computeAdjusted(p.sale_pct || 0, adjust.sale.op, adjust.sale.type, adjust.sale.amount);
            if (newV !== null && newV >= 0) updates.sale_pct = Math.min(100, newV);
          }
          return { sku, idField, updates };
        });
        if (perSku.every(x => Object.keys(x.updates).length === 0)) throw new Error('Tick at least one field and enter an amount');
        const { successCount, failures } = await saveOnePerSku(perSku);
        if (failures.length === 0) successMsg = `Adjusted ${successCount} product${successCount !== 1 ? 's' : ''}`;
        else { hadFailures = true; toast.warning(`${successCount} adjusted, ${failures.length} failed — see console`, { duration: 12000 }); }
        if (failures.length > 0) console.warn('[Bulk Adjust] Failures:', failures);
      }
      else if (mode === 'edit') {
        const perSku = selectedList.map(p => {
          const sku = p.sku || p.supplier_code;
          const idField = p.sku ? 'sku' : 'supplier_code';
          const row = edits[sku] || {};
          const updates = {};
          if (row.list_price !== undefined && row.list_price !== '') {
            const n = parseFloat(row.list_price); if (!isNaN(n) && n >= 0) { updates.list_price = n; updates.retail_price = n; }
          }
          if (row.cost_price !== undefined && row.cost_price !== '') {
            const n = parseFloat(row.cost_price); if (!isNaN(n) && n >= 0) updates.cost_price = n;
          }
          if (row.warehouse_stock !== undefined && row.warehouse_stock !== '') {
            const n = parseInt(row.warehouse_stock, 10); if (!isNaN(n) && n >= 0) updates.warehouse_stock = n;
          }
          if (row.sale_pct !== undefined && row.sale_pct !== '') {
            const n = parseFloat(row.sale_pct); if (!isNaN(n) && n >= 0 && n <= 100) updates.sale_pct = n;
          }
          return { sku, idField, updates };
        }).filter(x => Object.keys(x.updates).length > 0);
        if (perSku.length === 0) throw new Error('Fill in at least one cell to save');
        const { successCount, failures } = await saveOnePerSku(perSku);
        if (failures.length === 0) successMsg = `Saved ${successCount} product${successCount !== 1 ? 's' : ''}`;
        else { hadFailures = true; toast.warning(`${successCount} saved, ${failures.length} failed — see console`, { duration: 12000 }); }
        if (failures.length > 0) console.warn('[Bulk Edit-each] Failures:', failures);
      }
      // Fire the shared 15s Undo toast when the save was fully successful.
      if (!hadFailures && successMsg) {
        showUndoToast({ snapshot, labelSummary: successMsg, onRestored: onSuccess });
      }
      onOpenChange(false);
      resetState();
      if (onSuccess) onSuccess();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const modeLabel = { set: 'Set all to same', adjust: 'Adjust each', edit: `Edit ${selectedList.length} rows` };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) { onOpenChange(o); if (!o) resetState(); } }}>
      <DialogContent className="max-w-2xl" data-testid="bulk-fields-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PoundSterling className="w-5 h-5 text-emerald-600" />
            Bulk Set / Adjust / Edit — {selectedList.length} product(s)
          </DialogTitle>
        </DialogHeader>

        {/* Mode tabs */}
        <div className="flex gap-1 border-b border-gray-200 -mx-1">
          {[
            { key: 'set',    label: 'Set all to same',  hint: 'Same price for every product',      icon: Equal },
            { key: 'adjust', label: 'Adjust each',      hint: 'Bump by % or £ — keeps differences', icon: TrendingUp },
            { key: 'edit',   label: 'Edit each',        hint: 'Per-SKU inline table',              icon: Edit3 },
          ].map(t => (
            <button
              key={t.key}
              onClick={() => setMode(t.key)}
              className={`flex-1 px-3 py-2 text-xs font-medium border-b-2 transition ${
                mode === t.key ? 'border-emerald-500 text-emerald-700 bg-emerald-50' : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
              data-testid={`bulk-mode-${t.key}`}
            >
              <div className="flex items-center justify-center gap-1.5">
                <t.icon className="w-3.5 h-3.5" />
                {t.label}
              </div>
              <div className="text-[10px] text-gray-400 mt-0.5">{t.hint}</div>
            </button>
          ))}
        </div>

        <div className="pt-2 max-h-[60vh] overflow-y-auto">
          {mode === 'set'    && <SetMode    selectedList={selectedList} values={setValues} setValues={setSetValues} checks={setChecks} setChecks={setSetChecks} />}
          {mode === 'adjust' && <AdjustMode selectedList={selectedList} adjust={adjust} setAdjust={setAdjust} />}
          {mode === 'edit'   && <EditEachMode selectedList={selectedList} edits={edits} setEdits={setEdits} />}
        </div>

        <div className="flex items-start gap-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded p-2 mt-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>
            {mode === 'set' && `Overwrites the existing value on ${selectedList.length} product(s). `}
            {mode === 'adjust' && `Adjusts each product's own value proportionally. `}
            {mode === 'edit' && `Only rows you touch are saved. `}
            Every save is verified — mismatches surface immediately.
          </span>
        </div>

        <DialogFooter>
          <span className="text-[11px] text-gray-500 mr-auto inline-flex items-center gap-1">
            Mode: <b>{modeLabel[mode]}</b>
            {mode === 'edit' && changeCounts.rows > 0 && <> · <b>{changeCounts.rows}</b> row(s) to save</>}
            <span className="ml-2 inline-flex items-center gap-1 text-slate-500">
              <Undo2 className="w-3 h-3" />
              <span>Undo available for 15s after Save</span>
            </span>
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving} className={themeBtn} data-testid="bulk-fields-save">
            {saving ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
            {mode === 'set'    && `Save to ${selectedList.length}`}
            {mode === 'adjust' && `Adjust ${selectedList.length}`}
            {mode === 'edit'   && `Save ${changeCounts.rows || selectedList.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default BulkFieldsModal;
