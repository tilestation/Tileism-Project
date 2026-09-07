/**
 * PalletsDeliveryPanel — the Pricing hub's "Pallets & Delivery" tab.
 * ONE table, one row per selected product, every row independently editable:
 *   Pallet on · Full qty × £ · Half qty × £ · Pallet only · Mandatory delivery £ · Parcel fee
 * "Fill all rows at once" copies one set of values to every row (then untick the odd one).
 * Only rows that changed are saved. Pallet fields → bulk-tier-update (per-row),
 * delivery fields → bulk-delivery-settings (per-row); both mirror to the live tiles.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Truck, Package, Layers, Save, RefreshCw, RotateCcw, Wand2, ChevronDown, ChevronRight, FileText, Undo2 } from 'lucide-react';
import { useBulkUndo } from './useBulkUndo';
import { productDisplayName } from './useManagerBulk';
import { clearDeliveryTermsCache } from '../../../../lib/deliveryTerms';
import SellingRulesCard from './SellingRulesCard';
import {
  RULE_FIELDS, ruleKey, rowFromProduct, applyRuleField, rulesChanged, palletChanged, deliveryChanged,
  validateRules, palletPayload, deliveryPayload, saveSellingRules,
} from './sellingRules';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const Cell = ({ value, onChange, placeholder, disabled, testid, step = '0.01', width = 'w-[68px]' }) => (
  <Input type="number" step={step} min="0" value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
    disabled={disabled} className={`h-7 px-1.5 text-xs font-mono ${width}`} data-testid={testid} />
);

const TermsNote = () => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    fetch(`${API_URL}/api/shop/delivery-terms`).then(r => r.json()).then(d => setText(d.text || '')).catch(() => {});
  }, [open]);
  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}/api/shop/delivery-terms`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      clearDeliveryTermsCache();
      toast.success('Delivery terms note updated across the storefront');
    } catch (err) { toast.error(`Save failed: ${err.message}`); } finally { setSaving(false); }
  };
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button type="button" onClick={() => setOpen(v => !v)} className="w-full flex items-center gap-2 px-3 py-1.5 bg-gray-50 hover:bg-gray-100 text-left text-xs font-medium text-gray-700" data-testid="rules-terms-toggle">
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <FileText className="w-3.5 h-3.5 text-gray-500" />
        Free-delivery small print
        <span className="text-[10px] text-gray-400 font-normal">— shown on product pages, basket & checkout (whole website, not per product)</span>
      </button>
      {open && (
        <div className="p-3 space-y-2">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs resize-y" placeholder="* Some items are excluded from free delivery…" data-testid="delivery-terms-textarea" />
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={save} disabled={saving} data-testid="delivery-terms-save-btn">
              {saving ? <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Save className="w-3.5 h-3.5 mr-1.5" />} Save note
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

const PalletsDeliveryPanel = ({ selectedList = [], onSuccess, onClose, defaultUnit = 'm2' }) => {
  const [rows, setRows] = useState({});
  const seedRef = useRef({});
  const [saving, setSaving] = useState(false);
  const [fillOpen, setFillOpen] = useState(selectedList.length > 1);
  const [fill, setFill] = useState(() => ({ ...rowFromProduct({}, defaultUnit), pallet_enabled: true, delivery_charge_required: true }));
  const { snapshotFor, showUndoToast } = useBulkUndo();

  const keysJoined = selectedList.map(ruleKey).join('|');
  useEffect(() => {
    const seed = {};
    selectedList.forEach(p => { seed[ruleKey(p)] = rowFromProduct(p, defaultUnit); });
    seedRef.current = seed;
    setRows(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysJoined, defaultUnit]);

  const setCell = (key, field, value) => setRows(prev => ({ ...prev, [key]: applyRuleField(prev[key], field, value) }));
  const resetRow = (key) => setRows(prev => ({ ...prev, [key]: seedRef.current[key] }));

  const dirtyKeys = useMemo(
    () => Object.keys(rows).filter(k => seedRef.current[k] && rulesChanged(rows[k], seedRef.current[k])),
    [rows]
  );
  const counts = useMemo(() => {
    const list = Object.values(rows);
    return {
      palletOnly: list.filter(r => r.pallet_enabled && r.pallet_only).length,
      delivery: list.filter(r => r.delivery_charge_required).length,
      parcel: list.filter(r => r.parcel_delivery).length,
    };
  }, [rows]);

  const applyFillPallets = () => {
    setRows(prev => {
      const next = {};
      Object.entries(prev).forEach(([k, r]) => {
        const row = { ...r, pallet_enabled: fill.pallet_enabled, pallet_only: fill.pallet_enabled && fill.pallet_only };
        if (fill.pallet_enabled) {
          row.pallet_qty_unit = fill.pallet_qty_unit;
          ['m2_per_pallet', 'pallet_price', 'm2_per_half_pallet', 'half_pallet_price'].forEach(f => { if (fill[f] !== '') row[f] = fill[f]; });
        }
        next[k] = row;
      });
      return next;
    });
    toast.success(`Pallet settings copied to ${selectedList.length} rows — untick any row that should differ`);
  };
  const applyFillDelivery = () => {
    setRows(prev => {
      const next = {};
      Object.entries(prev).forEach(([k, r]) => {
        const row = { ...r, delivery_charge_required: fill.delivery_charge_required, parcel_delivery: fill.parcel_delivery };
        row.delivery_charge = fill.delivery_charge_required ? (fill.delivery_charge !== '' ? fill.delivery_charge : r.delivery_charge) : '';
        row.parcel_fee = fill.parcel_delivery ? (fill.parcel_fee !== '' ? fill.parcel_fee : r.parcel_fee) : '';
        next[k] = row;
      });
      return next;
    });
    toast.success(`Delivery settings copied to ${selectedList.length} rows — untick any row that should differ`);
  };

  const handleSave = async () => {
    if (dirtyKeys.length === 0) { toast.error('Nothing changed yet — edit a row or use "Fill all rows at once"'); return; }
    const byKey = new Map(selectedList.map(p => [ruleKey(p), p]));
    for (const k of dirtyKeys) {
      const err = validateRules(rows[k], productDisplayName(byKey.get(k)) || k);
      if (err) { toast.error(err); return; }
    }
    setSaving(true);
    try {
      const changedProducts = dirtyKeys.map(k => byKey.get(k));
      const snapshot = snapshotFor(changedProducts, RULE_FIELDS);
      const palletProducts = dirtyKeys.filter(k => palletChanged(rows[k], seedRef.current[k])).map(k => palletPayload(byKey.get(k), rows[k]));
      const deliveryProducts = dirtyKeys.filter(k => deliveryChanged(rows[k], seedRef.current[k])).map(k => deliveryPayload(byKey.get(k), rows[k]));
      await saveSellingRules({ palletProducts, deliveryProducts });
      const summary = `Pallet & delivery rules saved on ${dirtyKeys.length} product${dirtyKeys.length !== 1 ? 's' : ''}`;
      showUndoToast({ snapshot, labelSummary: summary, onRestored: onSuccess });
      onSuccess?.();
      onClose?.();
    } catch (err) {
      toast.error(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="pallets-delivery-panel">
      <div className="bg-emerald-50 border border-emerald-100 text-emerald-900 text-[11px] p-2 rounded flex items-start gap-1.5">
        <Layers className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
        <span>
          <b>Every row is its own product.</b> Tick <b>Pallet only</b> or a <b>Delivery £</b> on just the items you want — the others stay as they are.
          Use <b>Fill all rows at once</b> to type once and copy to every row, then untick the odd one. Only rows you change are saved.
        </span>
      </div>

      {/* Fill all rows */}
      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <button type="button" onClick={() => setFillOpen(v => !v)} className="w-full flex items-center gap-2 px-3 py-2 bg-slate-50 hover:bg-slate-100 text-left text-xs font-semibold text-slate-700" data-testid="rules-fill-toggle">
          {fillOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <Wand2 className="w-3.5 h-3.5 text-violet-600" />
          Fill all rows at once
          <span className="text-[10px] text-slate-400 font-normal">— type once → copy to every row below</span>
        </button>
        {fillOpen && (
          <div className="p-3 bg-white">
            <SellingRulesCard
              value={fill}
              onChange={setFill}
              testPrefix="rules-fill"
              palletFooter={
                <Button size="sm" onClick={applyFillPallets} className="bg-green-600 hover:bg-green-700 text-white h-7 text-xs w-full" data-testid="rules-fill-apply-pallets">
                  <Wand2 className="w-3.5 h-3.5 mr-1" /> Apply pallet settings to all {selectedList.length} rows
                </Button>
              }
              deliveryFooter={
                <Button size="sm" onClick={applyFillDelivery} className="bg-amber-600 hover:bg-amber-700 text-white h-7 text-xs w-full" data-testid="rules-fill-apply-delivery">
                  <Wand2 className="w-3.5 h-3.5 mr-1" /> Apply delivery settings to all {selectedList.length} rows
                </Button>
              }
            />
          </div>
        )}
      </div>

      {/* Per-product table */}
      <div className="max-h-[44vh] overflow-auto border border-gray-200 rounded-lg">
        <table className="w-full min-w-[1000px] text-xs">
          <thead className="bg-gray-50 border-b border-gray-200 sticky top-0 z-10">
            <tr className="text-left text-gray-600">
              <th className="px-2 py-2 font-medium w-[24%]">Product</th>
              <th className="px-2 py-2 font-medium text-center text-green-800">Pallet</th>
              <th className="px-2 py-2 font-medium text-green-800">Full pallet <span className="font-normal text-gray-400">qty × £</span></th>
              <th className="px-2 py-2 font-medium text-green-800">Half pallet <span className="font-normal text-gray-400">qty × £</span></th>
              <th className="px-2 py-2 font-medium text-center text-amber-800">Pallet only</th>
              <th className="px-2 py-2 font-medium text-amber-800">Delivery £ <span className="font-normal text-gray-400">mandatory</span></th>
              <th className="px-2 py-2 font-medium text-sky-800">Parcel <span className="font-normal text-gray-400">fee £</span></th>
              <th className="px-2 py-2 w-8" />
            </tr>
          </thead>
          <tbody>
            {selectedList.map(p => {
              const key = ruleKey(p);
              const row = rows[key];
              if (!row) return null;
              const sku = p.sku || p.supplier_code;
              const dirty = seedRef.current[key] && rulesChanged(row, seedRef.current[key]);
              const isUnit = row.pallet_qty_unit === 'unit';
              const on = row.pallet_enabled;
              return (
                <tr key={key} className={`border-b border-gray-100 align-top ${dirty ? 'bg-amber-50/50' : ''}`} data-testid={`rules-row-${sku}`}>
                  <td className="px-2 py-1.5">
                    <div className="font-medium text-gray-900 whitespace-normal break-words leading-snug" title={productDisplayName(p)}>{productDisplayName(p)}</div>
                    <div className="text-[10px] text-gray-500 flex items-center gap-1 flex-wrap">
                      <span>{p.supplier} · {sku}</span>
                      {on && row.pallet_only && <span className="px-1 rounded bg-amber-100 text-amber-800 border border-amber-300 font-bold uppercase text-[9px]" data-testid={`rules-tag-pallet-only-${sku}`}>Pallet only</span>}
                      {row.delivery_charge_required && Number(row.delivery_charge) > 0 && <span className="px-1 rounded bg-rose-50 text-rose-700 border border-rose-200 font-bold text-[9px]" data-testid={`rules-tag-delivery-${sku}`}>£{Number(row.delivery_charge).toFixed(2)} delivery</span>}
                      {dirty && <span className="text-amber-700 font-semibold">· changed</span>}
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <input type="checkbox" checked={on} onChange={(e) => setCell(key, 'pallet_enabled', e.target.checked)} className="w-4 h-4 accent-green-600 mt-1" data-testid={`rules-pallet-on-${sku}`} />
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1">
                      <Cell value={row.m2_per_pallet} onChange={(v) => setCell(key, 'm2_per_pallet', v)} placeholder="qty" disabled={!on} step={isUnit ? '1' : '0.01'} testid={`rules-full-qty-${sku}`} />
                      <select value={row.pallet_qty_unit} onChange={(e) => setCell(key, 'pallet_qty_unit', e.target.value)} disabled={!on} className="h-7 text-[10px] border border-gray-200 rounded bg-white px-0.5" data-testid={`rules-unit-${sku}`}>
                        <option value="m2">m²</option>
                        <option value="unit">units</option>
                      </select>
                      <span className="text-gray-400">×</span>
                      <Cell value={row.pallet_price} onChange={(v) => setCell(key, 'pallet_price', v)} placeholder="£" disabled={!on} testid={`rules-full-price-${sku}`} width="w-[76px]" />
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1">
                      <Cell value={row.m2_per_half_pallet} onChange={(v) => setCell(key, 'm2_per_half_pallet', v)} placeholder="auto ½" disabled={!on} step={isUnit ? '1' : '0.01'} testid={`rules-half-qty-${sku}`} />
                      <span className="text-gray-400">×</span>
                      <Cell value={row.half_pallet_price} onChange={(v) => setCell(key, 'half_pallet_price', v)} placeholder="£" disabled={!on} testid={`rules-half-price-${sku}`} width="w-[76px]" />
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <input type="checkbox" checked={!!row.pallet_only} disabled={!on} onChange={(e) => setCell(key, 'pallet_only', e.target.checked)} className="w-4 h-4 accent-amber-600 mt-1 disabled:opacity-30" title={on ? 'Customers can ONLY buy Half / Full pallets' : 'Turn the pallet on first'} data-testid={`rules-pallet-only-${sku}`} />
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1">
                      <input type="checkbox" checked={!!row.delivery_charge_required} onChange={(e) => setCell(key, 'delivery_charge_required', e.target.checked)} className="w-4 h-4 accent-amber-600" title="Mandatory delivery charge — never free" data-testid={`rules-delivery-on-${sku}`} />
                      <Cell value={row.delivery_charge} onChange={(v) => setCell(key, 'delivery_charge', v)} placeholder="£" disabled={!row.delivery_charge_required} testid={`rules-delivery-amount-${sku}`} width="w-[76px]" />
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1">
                      <input type="checkbox" checked={!!row.parcel_delivery} onChange={(e) => setCell(key, 'parcel_delivery', e.target.checked)} className="w-4 h-4 accent-sky-600" title="Ships as a parcel (non-palletised)" data-testid={`rules-parcel-on-${sku}`} />
                      <Cell value={row.parcel_fee} onChange={(v) => setCell(key, 'parcel_fee', v)} placeholder="std" disabled={!row.parcel_delivery} testid={`rules-parcel-fee-${sku}`} width="w-[76px]" />
                    </div>
                  </td>
                  <td className="px-1 py-1.5 text-center">
                    {dirty && (
                      <button type="button" onClick={() => resetRow(key)} className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Undo this row's edits" data-testid={`rules-reset-${sku}`}>
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <TermsNote />

      <div className="flex items-center justify-end gap-2 pt-3 mt-2 border-t border-gray-200">
        <span className="text-[11px] text-gray-500 mr-auto inline-flex items-center gap-2 flex-wrap" data-testid="rules-summary">
          <span className="inline-flex items-center gap-1"><Layers className="w-3 h-3 text-amber-600" /> <b>{counts.palletOnly}</b> pallet-only</span>
          <span className="inline-flex items-center gap-1"><Truck className="w-3 h-3 text-rose-600" /> <b>{counts.delivery}</b> delivery £</span>
          <span className="inline-flex items-center gap-1"><Package className="w-3 h-3 text-sky-600" /> <b>{counts.parcel}</b> parcel</span>
          <span>· <b>{dirtyKeys.length}</b> changed</span>
          <span className="inline-flex items-center gap-1 text-slate-500"><Undo2 className="w-3 h-3" /> Undo available for 15s after Save</span>
        </span>
        <Button variant="outline" onClick={() => onClose?.()} disabled={saving}>Cancel</Button>
        <Button onClick={handleSave} disabled={saving || dirtyKeys.length === 0} className="bg-emerald-600 hover:bg-emerald-700 text-white" data-testid="rules-save">
          {saving ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
          Save {dirtyKeys.length || ''} changed
        </Button>
      </div>
    </div>
  );
};

export default PalletsDeliveryPanel;
