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
  X, CheckSquare, Trash2, Archive, Globe, Eye, EyeOff, Percent, Palette, Layers, Grid3X3, Package, PoundSterling, Sparkles, Image as ImageIcon, Tag, Sliders, LayoutGrid, Star, ChevronUp, ListFilter, GripVertical, ExternalLink, Flame,
} from 'lucide-react';
import { productDisplayName } from './useManagerBulk';

const ManagerBulkBar = ({
  selectedCount,
  selectedList = null,
  missingSelected = [],
  onUnselectProduct,
  onUnselectKey,
  showSelectedOnly = false,
  onToggleShowSelectedOnly,
  onClearAll,
  onSelectAll,
  onBulkPublish,
  onBulkUnpublish,
  onBulkStock,
  onBulkArchive,
  onBulkDelete,
  onBulkFeature,
  onOpenFeaturedOrder,
  onJumpToProduct,
  onOpenTierPricing,
  onOpenSeriesMove,
  onOpenAssignColours,
  onOpenBulkCategory,
  onOpenBulkFields,
  onOpenBulkSpecs,
  onOpenAIDescriptions,
  onOpenBulkImages,
  onOpenReassignCategory,
  onOpenShopTabs,
  onOpenPreview,
  onOpenSaleLabels,
  onMarkClearance,
  saving = false,
  themeColor = 'orange',
  hideActions = [],
}) => {
  const [assignCategoryOpen, setAssignCategoryOpen] = useState(false);
  const [featureOpen, setFeatureOpen] = useState(false);
  const [selectionOpen, setSelectionOpen] = useState(false);
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
      {/* Selection info — click the count to open the Selected panel */}
      <div className="flex items-center gap-2 pr-2 border-r border-white/20 relative">
        <button
          type="button"
          onClick={() => setSelectionOpen(v => !v)}
          className="flex items-center gap-1.5 hover:bg-white/15 rounded-lg px-1.5 py-1 transition"
          data-testid="bar-selection-toggle"
          title="See exactly which products are ticked"
        >
          <CheckSquare className="w-4 h-4" />
          <span className="text-sm font-semibold">{selectedCount} selected</span>
          <ChevronUp className={`w-3.5 h-3.5 opacity-70 transition-transform ${selectionOpen ? 'rotate-180' : ''}`} />
        </button>
        {onSelectAll && (
          <button
            onClick={onSelectAll}
            className="text-[11px] underline underline-offset-2 opacity-80 hover:opacity-100"
            data-testid="bar-select-all"
          >
            select all
          </button>
        )}
        {onToggleShowSelectedOnly && (
          <button
            type="button"
            onClick={onToggleShowSelectedOnly}
            className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-md transition ${showSelectedOnly ? 'bg-white text-gray-900 font-semibold' : 'bg-white/15 hover:bg-white/25'}`}
            data-testid="bar-show-selected-only"
            title="Show only the ticked products in the list below"
          >
            <ListFilter className="w-3 h-3" />
            {showSelectedOnly ? 'Showing selected' : 'Show selected'}
          </button>
        )}

        {/* Selected products panel */}
        {selectionOpen && Array.isArray(selectedList) && (
          <div
            className="absolute bottom-full mb-2 left-0 bg-white text-gray-900 rounded-xl shadow-2xl border border-gray-200 w-[380px] max-h-[50vh] overflow-hidden flex flex-col z-50"
            data-testid="bar-selection-panel"
          >
            <div className="px-3 py-2 flex items-center justify-between border-b bg-gray-50 rounded-t-xl">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Selected products ({selectedList.length + missingSelected.length})</span>
              <button onClick={() => setSelectionOpen(false)} className="text-gray-400 hover:text-gray-700" data-testid="bar-selection-close">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="overflow-y-auto divide-y divide-gray-100">
              {selectedList.map((p) => {
                const img = (Array.isArray(p.images) ? p.images.filter(Boolean)[0] : null) || p.image;
                const pname = productDisplayName(p);
                return (
                  <div key={`${p.supplier}|${p.sku || p.supplier_code}`} className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-gray-50" data-testid={`bar-selected-item-${p.sku || p.supplier_code}`}>
                    <div className="w-8 h-8 rounded bg-gray-100 overflow-hidden flex-shrink-0">
                      {img ? <img src={img} alt="" className="w-full h-full object-cover" /> : null}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-gray-900 truncate flex items-center gap-1">
                        {p.is_featured && <Star className="w-3 h-3 text-amber-500 fill-amber-400 flex-shrink-0" />}
                        {pname}
                      </div>
                      <div className="text-[11px] text-gray-500 truncate">{p.supplier} · {p.sku || p.supplier_code}</div>
                    </div>
                    {onUnselectProduct && (
                      <button
                        type="button"
                        onClick={() => onUnselectProduct(p)}
                        className="text-gray-300 hover:text-red-500 transition flex-shrink-0"
                        title="Untick this product"
                        data-testid={`bar-unselect-${p.sku || p.supplier_code}`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
              {/* Ticked on another page/category — click to open its Manager with the product highlighted */}
              {missingSelected.map((m) => (
                <div key={m.key} className="flex items-center gap-2.5 px-3 py-1.5 bg-amber-50/60 hover:bg-amber-100/70 transition" data-testid={`bar-selected-missing-${m.sku}`}>
                  <button
                    type="button"
                    onClick={() => onJumpToProduct && onJumpToProduct(m)}
                    disabled={!onJumpToProduct}
                    className="flex items-center gap-2.5 min-w-0 flex-1 text-left"
                    title={m.path ? `Open ${m.sku} in its Manager` : `Find ${m.sku} in All Products`}
                    data-testid={`bar-jump-${m.sku}`}
                  >
                    <div className="w-8 h-8 rounded bg-amber-100 overflow-hidden flex items-center justify-center flex-shrink-0">
                      {m.image ? <img src={m.image} alt="" className="w-full h-full object-cover" /> : <Package className="w-3.5 h-3.5 text-amber-500" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-gray-800 truncate flex items-center gap-1">
                        {m.name || m.sku}
                        <ExternalLink className="w-3 h-3 text-amber-500 flex-shrink-0" />
                      </div>
                      <div className="text-[11px] text-amber-700 truncate">
                        {m.supplier} · {m.pathLabel ? `open in ${m.pathLabel}` : 'not in this Manager — click to locate'}
                      </div>
                    </div>
                  </button>
                  {onUnselectKey && (
                    <button
                      type="button"
                      onClick={() => onUnselectKey(m.key)}
                      className="text-gray-300 hover:text-red-500 transition flex-shrink-0"
                      title="Untick this product"
                      data-testid={`bar-unselect-missing-${m.sku}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
              {selectedList.length === 0 && missingSelected.length === 0 && (
                <div className="px-3 py-4 text-center text-xs text-gray-400">
                  Ticked products aren't loaded on this page/filter
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Stock status — marks all selected In/Out of Stock immediately */}
      {!hidden.has('stock') && onBulkStock && (
        <select
          value=""
          onChange={(e) => { const v = e.target.value; if (v) onBulkStock(v); }}
          disabled={saving}
          className="px-2.5 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium text-white cursor-pointer border-0 outline-none [&>option]:text-gray-900"
          data-testid="bar-stock-status"
          title="Mark all selected products In Stock / Out of Stock — updates the website immediately"
        >
          <option value="" disabled>Stock…</option>
          <option value="in_stock">In Stock</option>
          <option value="low_stock">Low Stock</option>
          <option value="out_of_stock">Out of Stock</option>
          <option value="always_in_stock">Always In Stock</option>
        </select>
      )}

      {/* Content actions */}
      {!hidden.has('colours') && onOpenAssignColours && (
        <button
          type="button"
          onClick={onOpenAssignColours}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
          data-testid="bar-assign-colours"
          title="Attribute Studio — Colour, Finish, Size, Made In buckets + Sub-Categories & Custom Specs, all in one box"
        >
          <Palette className="w-3.5 h-3.5" />
          Attribute Studio
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
      {/* Tier Pricing now lives inside the Pricing hub (second tab) */}
      {!hidden.has('tierPricing') && onOpenTierPricing && !onOpenBulkFields && (
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
      {!hidden.has('seriesMove') && onOpenSeriesMove && (
        <button
          type="button"
          onClick={onOpenSeriesMove}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
          data-testid="bar-series-move"
          title="Move all selected products into one series (re-groups the storefront card)"
        >
          <LayoutGrid className="w-3.5 h-3.5" />
          Series
        </button>
      )}
      {!hidden.has('bulkFields') && onOpenBulkFields && (
        <button
          type="button"
          onClick={onOpenBulkFields}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
          data-testid="bar-bulk-fields"
          title="Everything pricing in one place: Now / Was (sale & clearance) price, cost, stock · pallets, pallet-only & delivery charges per item · tier discounts, trade %"
        >
          <PoundSterling className="w-3.5 h-3.5" />
          Pricing
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
      {!hidden.has('clearance') && onMarkClearance && (
        <button
          type="button"
          onClick={onMarkClearance}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#e5d918] text-red-700 hover:bg-yellow-300 transition text-[13px] font-black uppercase tracking-wide"
          data-testid="bar-mark-clearance"
          title="Mark selected as CLEARANCE — nothing goes live until you publish from the Clearance Hub"
        >
          <Flame className="w-3.5 h-3.5" strokeWidth={3} />
          Clearance
        </button>
      )}
      {/* Landing page preview — see it before publishing */}
      {!hidden.has('preview') && onOpenPreview && (
        <button
          type="button"
          onClick={onOpenPreview}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 transition text-[13px] font-medium"
          data-testid="bar-preview"
          title="Preview the selected products' landing pages before publishing"
        >
          <Eye className="w-3.5 h-3.5" />
          Preview
        </button>
      )}

      {/* Feature on Homepage — pins selected products to the front page */}
      {!hidden.has('feature') && onBulkFeature && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setFeatureOpen(v => !v)}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-400/90 hover:bg-amber-400 text-gray-900 transition text-[13px] font-semibold shadow"
            data-testid="bar-feature"
            title="Show the selected products prominently in the Featured section on the website front page"
          >
            <Star className="w-3.5 h-3.5" />
            Feature
          </button>
          {featureOpen && (
            <div className="absolute bottom-full mb-2 left-0 bg-white text-gray-900 rounded-lg shadow-xl border border-gray-200 py-1 w-64 z-50">
              <div className="px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase tracking-wide border-b">Homepage Featured section</div>
              <button
                onClick={() => { onBulkFeature(true); setFeatureOpen(false); }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-amber-50 flex items-center gap-2"
                data-testid="bar-feature-add"
              >
                <Star className="w-3.5 h-3.5 text-amber-500" />
                Feature on Homepage
              </button>
              <button
                onClick={() => { onBulkFeature(false); setFeatureOpen(false); }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 flex items-center gap-2 text-gray-600"
                data-testid="bar-feature-remove"
              >
                <X className="w-3.5 h-3.5" />
                Remove from Homepage
              </button>
              {onOpenFeaturedOrder && (
                <button
                  onClick={() => { onOpenFeaturedOrder(); setFeatureOpen(false); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-amber-50 flex items-center gap-2 text-gray-700 border-t"
                  data-testid="bar-feature-reorder"
                >
                  <GripVertical className="w-3.5 h-3.5 text-amber-500" />
                  Reorder Homepage…
                </button>
              )}
            </div>
          )}
        </div>
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
