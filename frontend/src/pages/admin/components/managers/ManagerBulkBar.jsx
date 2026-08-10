/**
 * ManagerBulkBar — floating quick-actions bar for every Category Manager.
 *
 * Mirrors the legacy Quick Actions Bar from /admin/supplier-products but scoped
 * to the actions relevant to a single Manager. Categories can hide/show buttons
 * by passing `hideActions={['setPricing', ...]}` when they don't apply.
 */

import React, { useState } from 'react';
import { Button } from '../../../../components/ui/button';
import {
  X, CheckSquare, Trash2, Archive, Globe, EyeOff, Percent, Palette, Layers, Grid3X3, Package, PoundSterling, Sparkles, Image as ImageIcon, Tag, Sliders, LayoutGrid,
} from 'lucide-react';

const ManagerBulkBar = ({
  selectedCount,
  onClearAll,
  onSelectAll,
  onBulkPublish,
  onBulkUnpublish,
  onBulkArchive,
  onBulkDelete,
  onOpenTierPricing,
  onOpenAssignColours,
  onOpenBulkCategory,
  onOpenBulkFields,
  onOpenBulkSpecs,
  onOpenAIDescriptions,
  onOpenBulkImages,
  onOpenReassignCategory,
  onOpenShopTabs,
  onOpenSaleLabels,
  saving = false,
  themeColor = 'orange',
  hideActions = [],
}) => {
  const [assignCategoryOpen, setAssignCategoryOpen] = useState(false);
  if (selectedCount === 0) return null;

  const themes = {
    orange: 'from-orange-600 to-orange-500',
    blue: 'from-blue-600 to-blue-500',
    emerald: 'from-emerald-600 to-emerald-500',
    cyan: 'from-cyan-600 to-cyan-500',
    red: 'from-red-600 to-red-500',
    slate: 'from-slate-700 to-slate-600',
  };

  const hidden = new Set(hideActions);

  return (
    <div
      className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-gradient-to-r ${themes[themeColor] || themes.orange} text-white rounded-xl shadow-2xl px-4 py-2 flex items-center gap-2 flex-wrap max-w-[95vw]`}
      data-testid="manager-bulk-bar"
    >
      {/* Selection info */}
      <div className="flex items-center gap-2 pr-2 border-r border-white/20">
        <CheckSquare className="w-4 h-4" />
        <span className="text-sm font-semibold">{selectedCount} selected</span>
        {onSelectAll && (
          <button
            onClick={onSelectAll}
            className="text-[11px] underline underline-offset-2 opacity-80 hover:opacity-100"
            data-testid="bar-select-all"
          >
            select all
          </button>
        )}
      </div>

      {/* Content actions */}
      {!hidden.has('colours') && onOpenAssignColours && (
        <button
          type="button"
          onClick={onOpenAssignColours}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
          data-testid="bar-assign-colours"
          title="Assign colours to selected products (with per-value scoping)"
        >
          <Palette className="w-3.5 h-3.5" />
          Colours
        </button>
      )}
      {!hidden.has('category') && onOpenBulkCategory && (
        <button
          type="button"
          onClick={onOpenBulkCategory}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
          data-testid="bar-open-bulk-category"
          title="Bulk edit categories, sub-categories, filters (rooms, materials, styles, features)"
        >
          <Layers className="w-3.5 h-3.5" />
          Categories &amp; Filters
        </button>
      )}
      {!hidden.has('tierPricing') && onOpenTierPricing && (
        <button
          type="button"
          onClick={onOpenTierPricing}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
          data-testid="bar-tier-pricing"
          title="Tier discounts, % / £ trade, Half + Full pallet"
        >
          <Percent className="w-3.5 h-3.5" />
          Tier Pricing
        </button>
      )}
      {!hidden.has('bulkFields') && onOpenBulkFields && (
        <button
          type="button"
          onClick={onOpenBulkFields}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
          data-testid="bar-bulk-fields"
          title="Set list price / cost / stock / sale % on all selected"
        >
          <PoundSterling className="w-3.5 h-3.5" />
          Price / Cost / Stock
        </button>
      )}
      {!hidden.has('aiDescriptions') && onOpenAIDescriptions && (
        <button
          type="button"
          onClick={onOpenAIDescriptions}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
          data-testid="bar-ai-descriptions"
          title="Generate SEO-friendly product descriptions with AI"
        >
          <Sparkles className="w-3.5 h-3.5" />
          AI Descriptions
        </button>
      )}
      {!hidden.has('bulkImages') && onOpenBulkImages && (
        <button
          type="button"
          onClick={onOpenBulkImages}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
          data-testid="bar-bulk-images"
          title="Drag &amp; drop images per SKU across the selection"
        >
          <ImageIcon className="w-3.5 h-3.5" />
          Images
        </button>
      )}
      {!hidden.has('saleLabels') && onOpenSaleLabels && (
        <button
          type="button"
          onClick={onOpenSaleLabels}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
          data-testid="bar-sale-labels"
          title="Apply Sale % + Labels (Sale, Clearance, New Arrival, Best Seller, Limited Stock)"
        >
          <Tag className="w-3.5 h-3.5" />
          Sale / Labels
        </button>
      )}
      {!hidden.has('specs') && onOpenBulkSpecs && (
        <button
          type="button"
          onClick={onOpenBulkSpecs}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
          data-testid="bar-specs-filters"
          title="Bulk-edit any Filter, Spec Field or Sub-Category you configured for this Manager"
        >
          <Sliders className="w-3.5 h-3.5" />
          Specs / Filters
        </button>
      )}

      {/* Publish actions */}
      {!hidden.has('publish') && onBulkPublish && (
        <button
          type="button"
          onClick={onBulkPublish}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 transition text-[13px] font-medium shadow"
          data-testid="bar-publish"
          title="Publish selected products to the live storefront"
        >
          <Globe className="w-3.5 h-3.5" />
          Publish
        </button>
      )}
      {!hidden.has('unpublish') && onBulkUnpublish && (
        <button
          type="button"
          onClick={onBulkUnpublish}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
          data-testid="bar-unpublish"
          title="Hide selected products from the storefront"
        >
          <EyeOff className="w-3.5 h-3.5" />
          Unpublish
        </button>
      )}

      {/* Shop Tabs assignment — where selected products appear on the website */}
      {!hidden.has('shopTabs') && onOpenShopTabs && (
        <button
          type="button"
          onClick={onOpenShopTabs}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
          data-testid="bar-shop-tabs"
          title="Choose which shop tabs the selected products appear under (multiple allowed)"
        >
          <LayoutGrid className="w-3.5 h-3.5" />
          Shop Tabs
        </button>
      )}

      {/* Category reassignment (mid-flight product-group change) */}
      {!hidden.has('reassign') && onOpenReassignCategory && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setAssignCategoryOpen(v => !v)}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
            data-testid="bar-reassign-category"
            title="Move to a different Manager"
          >
            <Grid3X3 className="w-3.5 h-3.5" />
            Reassign
          </button>
          {assignCategoryOpen && (
            <div className="absolute bottom-full mb-2 left-0 bg-white text-gray-900 rounded-lg shadow-xl border border-gray-200 py-1 w-56 z-50">
              <div className="px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide border-b">Reassign to…</div>
              {[
                { g: 'tiles', label: '⬛ Tiles Manager', color: 'text-blue-600' },
                { g: 'materials', label: '📦 Materials Manager', color: 'text-orange-600' },
                { g: 'flooring', label: '🪵 Flooring Manager', color: 'text-emerald-600' },
                { g: 'bathroom', label: '🛁 Bathroom Manager', color: 'text-cyan-600' },
                { g: 'underfloor_heating', label: '🔥 UFH Manager', color: 'text-red-600' },
                { g: 'tools', label: '🔧 Tools Manager', color: 'text-slate-600' },
              ].map(opt => (
                <button
                  key={opt.g}
                  onClick={() => { onOpenReassignCategory(opt.g); setAssignCategoryOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-100 ${opt.color}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Destructive actions */}
      {!hidden.has('archive') && onBulkArchive && (
        <button
          type="button"
          onClick={onBulkArchive}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
          data-testid="bar-archive"
          title="Archive selected (marks inactive, hides from storefront)"
        >
          <Archive className="w-3.5 h-3.5" />
          Archive
        </button>
      )}
      {!hidden.has('delete') && onBulkDelete && (
        <button
          type="button"
          onClick={onBulkDelete}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/90 hover:bg-red-500 transition text-[13px] font-medium"
          data-testid="bar-delete"
          title="Delete selected (permanent — asks for confirmation)"
        >
          <Trash2 className="w-3.5 h-3.5" />
          Delete
        </button>
      )}

      {/* Clear selection */}
      <div className="ml-1 pl-2 border-l border-white/20">
        <button
          type="button"
          onClick={onClearAll}
          className="text-white/70 hover:text-white transition"
          data-testid="bar-clear"
          title="Clear selection"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

export default ManagerBulkBar;
