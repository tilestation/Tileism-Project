/**
 * useManagerBulk — shared hook for multi-select + bulk ops in every Category Manager.
 *
 * Purpose: give MaterialsManager, TilesManager, and (later) Flooring/Bathroom/UFH/Tools
 * a common foundation for the exact bulk workflows that live in the legacy
 * Bulk Category Editor — but shipped natively inside each Manager.
 *
 * Exposes:
 *   - selectedProducts (Set of productKey strings)
 *   - Selection helpers: toggle, selectAll, clearAll, isSelected
 *   - Simple bulk ops that hit the shared backend endpoints:
 *     - bulkPublish / bulkUnpublish
 *     - bulkArchive
 *     - bulkAssignCategory (product_group)
 *     - bulkDelete
 *     - bulkUpdate (raw fields — used by AssignColours / AssignTierPricing / etc.)
 *   - Save Results state (last bulk save result, including verification failures)
 *
 * All ops go through the SAME `/api/supplier-sync/products/bulk-update-unified` /
 * bulk-assign-category endpoints the legacy editor uses, so verification, publish
 * flow, tier pricing, refunds — everything — keeps working.
 */

import { useState, useCallback } from 'react';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Must match getProductKey in SupplierProducts.js exactly for cross-page compat
export const getProductKey = (p) => `${p.supplier || 'unknown'}|||${p.sku || p.supplier_code || p._id}`;

export function useManagerBulk({ products = [], onRefresh }) {
  const [selectedProducts, setSelectedProducts] = useState(new Set());
  const [bulkSaving, setBulkSaving] = useState(false);
  const [lastBulkResult, setLastBulkResult] = useState(null);
  const [showBulkResult, setShowBulkResult] = useState(false);

  const toggleProduct = useCallback((product) => {
    const key = getProductKey(product);
    setSelectedProducts(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const selectAll = useCallback((visibleProducts) => {
    setSelectedProducts(new Set(visibleProducts.map(p => getProductKey(p))));
  }, []);

  const clearAll = useCallback(() => setSelectedProducts(new Set()), []);

  const isSelected = useCallback((product) => selectedProducts.has(getProductKey(product)), [selectedProducts]);

  const getSelectedList = useCallback(() => {
    return products.filter(p => selectedProducts.has(getProductKey(p)));
  }, [products, selectedProducts]);

  // Group selected products by their identifier field for the bulk-update-unified endpoint
  const splitByIdField = useCallback((selectedList) => {
    const bySku = selectedList.filter(p => p.sku).map(p => p.sku);
    const bySupplierCode = selectedList.filter(p => !p.sku && p.supplier_code).map(p => p.supplier_code);
    return { bySku, bySupplierCode };
  }, []);

  // Generic bulk-update helper — used by assign colour, tier pricing, publish etc.
  // Returns aggregated {updated, failed, verificationFailures} so the caller can toast + show Save Results.
  const bulkUpdate = useCallback(async (updates, { mode = 'replace', label } = {}) => {
    const selectedList = getSelectedList();
    if (selectedList.length === 0) {
      toast.error('No products selected');
      return null;
    }
    setBulkSaving(true);
    try {
      const { bySku, bySupplierCode } = splitByIdField(selectedList);
      let totalUpdated = 0;
      let totalAutoPublished = 0;
      const verificationFailures = [];
      for (const [ids, idField] of [[bySku, 'sku'], [bySupplierCode, 'supplier_code']]) {
        if (ids.length === 0) continue;
        const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-update-unified`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_ids: ids, id_field: idField, updates, mode }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        totalUpdated += data.updated_count || data.supplier_products_updated || 0;
        totalAutoPublished += data.auto_published || 0;
        if (Array.isArray(data.verification_failures)) {
          verificationFailures.push(...data.verification_failures);
        }
      }
      const result = {
        updated: totalUpdated,
        total: selectedList.length,
        autoPublished: totalAutoPublished,
        verificationFailures,
        label: label || 'Bulk update',
        timestamp: Date.now(),
      };
      setLastBulkResult(result);
      if (verificationFailures.length > 0) {
        toast.warning(`⚠️ ${verificationFailures.length} field(s) didn't save correctly — check Save Results`, { duration: 12000 });
        setShowBulkResult(true);
        console.warn('[Manager Bulk] Verification failures:', verificationFailures);
      } else {
        toast.success(`${label || 'Updated'}: ${totalUpdated} product(s)`);
        if (totalAutoPublished > 0) {
          toast.info(`${totalAutoPublished} auto-published to storefront`);
        }
      }
      if (onRefresh) onRefresh();
      return result;
    } catch (err) {
      console.error('[Manager Bulk] Update failed', err);
      toast.error(`Bulk update failed: ${err.message}`);
      return null;
    } finally {
      setBulkSaving(false);
    }
  }, [getSelectedList, splitByIdField, onRefresh]);

  // Bulk Publish — mark selected products live on the storefront
  const bulkPublish = useCallback(async () => {
    if (selectedProducts.size === 0) return toast.error('No products selected');
    if (!window.confirm(`Publish ${selectedProducts.size} product(s) to the storefront?`)) return;
    await bulkUpdate({ published: true, visibility: 'online', show_on_website: true }, { label: 'Published' });
  }, [selectedProducts.size, bulkUpdate]);

  // Bulk Unpublish — hide from storefront but keep in DB
  const bulkUnpublish = useCallback(async () => {
    if (selectedProducts.size === 0) return toast.error('No products selected');
    if (!window.confirm(`Unpublish ${selectedProducts.size} product(s) — they'll be hidden from the storefront?`)) return;
    await bulkUpdate({ published: false, visibility: 'hidden', show_on_website: false }, { label: 'Unpublished' });
  }, [selectedProducts.size, bulkUpdate]);

  // Bulk Archive — set inactive
  const bulkArchive = useCallback(async () => {
    if (selectedProducts.size === 0) return toast.error('No products selected');
    if (!window.confirm(`Archive ${selectedProducts.size} product(s)? They'll be marked inactive.`)) return;
    await bulkUpdate({ status: 'archived', published: false, visibility: 'hidden' }, { label: 'Archived' });
  }, [selectedProducts.size, bulkUpdate]);

  // Bulk Delete — permanent removal (marks deleted_at + hidden from all queries)
  const bulkDelete = useCallback(async () => {
    if (selectedProducts.size === 0) return toast.error('No products selected');
    const first = window.confirm(`Delete ${selectedProducts.size} product(s) permanently? This can't be undone from the UI.`);
    if (!first) return;
    const second = window.prompt(`Type "DELETE" (all caps) to confirm removing ${selectedProducts.size} product(s):`);
    if (second !== 'DELETE') { toast.error('Confirmation phrase not entered — cancelled'); return; }
    await bulkUpdate({
      status: 'deleted',
      published: false,
      visibility: 'hidden',
      deleted_at: new Date().toISOString(),
    }, { label: 'Deleted' });
  }, [selectedProducts.size, bulkUpdate]);

  // Bulk Assign Category — routes selected products to a specific Manager
  const bulkAssignCategory = useCallback(async (productGroup) => {
    if (selectedProducts.size === 0) return toast.error('No products selected');
    const label = {
      tiles: 'Tiles', materials: 'Materials', flooring: 'Flooring',
      bathroom: 'Bathroom', underfloor_heating: 'Underfloor Heating', tools: 'Tools & Accessories',
    }[productGroup] || productGroup;
    if (!window.confirm(`Reassign ${selectedProducts.size} product(s) to "${label}" Manager?`)) return;
    setBulkSaving(true);
    try {
      const selectedList = getSelectedList();
      const { bySku, bySupplierCode } = splitByIdField(selectedList);
      let updated = 0;
      for (const [ids, idField] of [[bySku, 'sku'], [bySupplierCode, 'supplier_code']]) {
        if (ids.length === 0) continue;
        const res = await fetch(`${API_URL}/api/supplier-sync/products/bulk-assign-category`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ product_ids: ids, id_field: idField, product_group: productGroup }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        updated += data.modified_count || 0;
      }
      toast.success(`Assigned ${updated} product(s) to ${label}`);
      if (onRefresh) onRefresh();
    } catch (err) {
      toast.error(`Reassign failed: ${err.message}`);
    } finally {
      setBulkSaving(false);
    }
  }, [selectedProducts.size, getSelectedList, splitByIdField, onRefresh]);

  return {
    // Selection state
    selectedProducts,
    setSelectedProducts,
    toggleProduct,
    selectAll,
    clearAll,
    isSelected,
    getSelectedList,
    // Bulk ops
    bulkUpdate,
    bulkPublish,
    bulkUnpublish,
    bulkArchive,
    bulkDelete,
    bulkAssignCategory,
    // UI state
    bulkSaving,
    lastBulkResult,
    setLastBulkResult,
    showBulkResult,
    setShowBulkResult,
  };
}

export default useManagerBulk;
