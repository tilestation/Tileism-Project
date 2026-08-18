/**
 * PerBoxAutoFill — computes Tiles Per Box from tile size + m² per box
 * (or M² Per Box from size + tiles per box) and saves it in one click.
 * Shown inside Attribute Studio on the numeric per-box tabs.
 */
import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../../components/ui/button';
import { Zap, RefreshCw } from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// "300 x 600mm" / "30x60cm" / "120X120" / "1.2x2.4m" → tile area in m²
export const parseTileAreaM2 = (sizeStr) => {
  if (!sizeStr) return null;
  const s = String(sizeStr).toLowerCase().replace(/,/g, '.');
  const m = s.match(/(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const a = parseFloat(m[1]);
  const b = parseFloat(m[2]);
  if (!a || !b) return null;
  let unit = s.includes('mm') ? 'mm' : s.includes('cm') ? 'cm' : /\d\s*m\b/.test(s) ? 'm' : null;
  if (!unit) unit = (a > 150 || b > 150) ? 'mm' : 'cm';   // tile-trade convention: unit-less "120x120" means cm
  const div = unit === 'mm' ? 1000 : unit === 'cm' ? 100 : 1;
  const area = (a / div) * (b / div);
  return area > 0 ? area : null;
};

export const PerBoxAutoFill = ({ attr, selectedList = [], onSuccess }) => {
  const [overwrite, setOverwrite] = useState(false);
  const [saving, setSaving] = useState(false);

  const rows = useMemo(() => selectedList.map(p => {
    const size = p.size || p.dimensions || (p.attributes && p.attributes.size) || '';
    const area = parseTileAreaM2(size);
    const sqm = Number(p.sqm_per_box || p.box_m2_coverage || 0) || null;
    const tiles = Number(p.tiles_per_box || 0) || null;
    let computed = null;
    if (attr.key === 'tiles_per_box' && area && sqm) {
      const raw = sqm / area;
      if (raw >= 0.5 && raw <= 500) computed = Math.round(raw);
    } else if (attr.key === 'sqm_per_box' && area && tiles) {
      computed = Math.round(tiles * area * 1000) / 1000;
    }
    const current = attr.key === 'tiles_per_box' ? tiles : sqm;
    const missing = !area
      ? 'size'
      : attr.key === 'tiles_per_box'
        ? (!sqm ? 'm² per box' : null)
        : (!tiles ? 'tiles per box' : null);
    return {
      id: p.sku || p.supplier_code,
      idField: p.sku ? 'sku' : 'supplier_code',
      name: p.our_product_name || p.product_name || p.name || p.sku,
      size, computed, current, missing,
    };
  }), [selectedList, attr.key]);

  const fillable = rows.filter(r => r.id && r.computed != null && (overwrite || !r.current));
  const skipped = rows.filter(r => r.computed == null);
  const alreadySet = rows.filter(r => r.computed != null && r.current && !overwrite);

  const run = async () => {
    if (fillable.length === 0) return;
    setSaving(true);
    try {
      const groups = new Map();
      fillable.forEach(r => {
        const gk = `${r.idField}|${r.computed}`;
        if (!groups.has(gk)) groups.set(gk, { idField: r.idField, value: r.computed, ids: [] });
        groups.get(gk).ids.push(r.id);
      });
      let updated = 0;
      const failures = [];
      for (const g of groups.values()) {
        const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_ids: g.ids, id_field: g.idField, updates: { [attr.key]: g.value }, mode: 'replace' }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        updated += d.updated_count || 0;
        failures.push(...(d.verification_failures || []));
      }
      if (failures.length > 0) {
        toast.warning(`Auto-filled ${updated} product(s), but ${failures.length} verification failure(s) — check console`, { duration: 12000 });
        console.warn('[Per Box Auto-Fill] verification failures:', failures);
      } else {
        toast.success(`Auto-filled ${attr.label.toLowerCase()} on ${updated} product(s) — 100% verified`);
      }
      onSuccess && onSuccess();
    } catch (e) {
      toast.error(`Auto-fill failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50/50 px-3 py-2" data-testid="per-box-autofill">
      <div className="flex items-center gap-2 flex-wrap">
        <Zap className="w-3.5 h-3.5 text-sky-600 flex-shrink-0" />
        <span className="text-xs font-semibold text-sky-900">Auto-fill from tile size</span>
        <span className="text-[10px] text-sky-600">
          {attr.key === 'tiles_per_box' ? 'm² per box ÷ tile area' : 'tiles per box × tile area'} —{' '}
          <b data-testid="autofill-count">{fillable.length}</b> of {selectedList.length} computable
          {alreadySet.length > 0 && ` (${alreadySet.length} already set)`}
          {skipped.length > 0 && ` · ${skipped.length} missing ${[...new Set(skipped.map(r => r.missing))].join('/')}`}
        </span>
        <label className="inline-flex items-center gap-1 text-[10px] text-sky-700 ml-auto">
          <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} data-testid="autofill-overwrite" />
          overwrite existing
        </label>
        <Button
          size="sm"
          onClick={run}
          disabled={saving || fillable.length === 0}
          className="bg-sky-600 hover:bg-sky-700 text-white h-7 text-xs"
          data-testid="autofill-run-btn"
        >
          {saving ? <RefreshCw className="w-3 h-3 mr-1 animate-spin" /> : <Zap className="w-3 h-3 mr-1" />}
          Auto-fill {fillable.length}
        </Button>
      </div>
      {fillable.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5" data-testid="autofill-preview">
          {fillable.slice(0, 6).map(r => (
            <span key={r.id} className="text-[10px] text-sky-800">
              <span className="text-sky-500">{r.name?.slice(0, 28)}</span> {r.size} → <b>{r.computed}</b>
            </span>
          ))}
          {fillable.length > 6 && <span className="text-[10px] text-sky-500">…and {fillable.length - 6} more</span>}
        </div>
      )}
    </div>
  );
};

export default PerBoxAutoFill;
