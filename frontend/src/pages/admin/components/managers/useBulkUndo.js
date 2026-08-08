/**
 * useBulkUndo — shared 15-second Undo pattern for every bulk-edit modal.
 *
 * Any modal that mutates supplier_products in bulk (Bulk Fields / Sale Labels
 * / Tier Pricing / Specs+Filters) can call `fireUndo({selectedList, fieldKeys, computeAfter})`
 * BEFORE its save to snapshot the pre-state, then fire the sonner Undo toast
 * AFTER a successful save.
 *
 *   selectedList  – array of product objects (must contain sku or supplier_code)
 *   fieldKeys     – array of dotted field paths to snapshot (['list_price', 'sale_pct'])
 *   labelSummary  – short human sentence for the success toast ("Adjusted 5 products")
 *   onRestored    – callback fired after Undo succeeds (typically fetchProducts)
 *
 * Snapshot format: { sku: { field1: value, field2: value, ... } }
 * Undo path: POST /api/supplier-sync/products/bulk-update-unified once per SKU
 * with `mode: 'replace'` and the SKU's pre-state.
 *
 * Why per-SKU: each product had its own pre-state, so the single-updates-dict
 * bulk endpoint can't reverse the change in one call.
 */

import { useCallback } from 'react';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Snapshot the pre-state of every SKU across a list of fields. Called BEFORE
// the destructive save so the values captured are truly "before".
export const buildBulkSnapshot = (selectedList, fieldKeys) => {
  const snapshot = {};
  for (const p of selectedList || []) {
    const sku = p.sku || p.supplier_code;
    if (!sku) continue;
    const before = {};
    for (const k of fieldKeys) {
      const v = p[k];
      // Preserve arrays and null vs undefined so replace-mode restores exactly.
      before[k] = Array.isArray(v) ? [...v] : (v === undefined ? null : v);
    }
    snapshot[sku] = { idField: p.sku ? 'sku' : 'supplier_code', before };
  }
  return snapshot;
};

// Restore each SKU by pushing its pre-state through bulk-update-unified.
export const restoreBulkSnapshot = async (snapshot) => {
  if (!snapshot || Object.keys(snapshot).length === 0) return { ok: 0, failed: 0 };
  let ok = 0; let failed = 0;
  const token = localStorage.getItem('token');
  for (const [sku, entry] of Object.entries(snapshot)) {
    try {
      const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          product_ids: [sku],
          id_field: entry.idField || 'sku',
          updates: entry.before,
          mode: 'replace',
          update_mode: 'replace',
        }),
      });
      if (res.ok) ok++; else failed++;
    } catch {
      failed++;
    }
  }
  return { ok, failed };
};

// The main hook exposed to modals. Returns { snapshot, showUndoToast }.
export const useBulkUndo = () => {
  const snapshotFor = useCallback((selectedList, fieldKeys) => {
    return buildBulkSnapshot(selectedList, fieldKeys);
  }, []);

  const showUndoToast = useCallback(({ snapshot, labelSummary, onRestored }) => {
    if (!snapshot || Object.keys(snapshot).length === 0) {
      // No snapshot to undo — just show a plain success toast.
      toast.success(labelSummary);
      return;
    }
    toast.success(labelSummary, {
      duration: 15000,
      action: {
        label: 'Undo',
        onClick: async () => {
          const { ok, failed } = await restoreBulkSnapshot(snapshot);
          if (failed === 0) toast.success(`Undo complete — ${ok} product${ok !== 1 ? 's' : ''} reverted`);
          else toast.warning(`Undo finished with ${failed} failure${failed !== 1 ? 's' : ''} (${ok} reverted)`);
          if (onRestored) onRestored();
        },
      },
    });
  }, []);

  return { snapshotFor, showUndoToast };
};

export default useBulkUndo;
