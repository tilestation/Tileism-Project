/**
 * TierPricingModal - Modal for managing tier pricing configuration
 * Supports dynamic tier count (add/remove tiers)
 * Supports Trade discount as percent (%) OR flat £/m² amount
 * Supports Half + Full pallet pricing block (bulk apply)
 */

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../../../../components/ui/dialog';
import { Button } from '../../../../components/ui/button';
import {
  Percent,
  RefreshCw,
  Save,
  XCircle,
  Plus,
  Trash2,
  Truck,
  PoundSterling,
} from 'lucide-react';
import PerProductOverridesPanel from './PerProductOverridesPanel';

const TierPricingModal = ({
  open,
  onOpenChange,
  selectedProducts,
  pricingSizeFilter,
  tierPricingConfig,
  setTierPricingConfig,
  tierPricingSaving,
  onSave,
  getProductsFilteredBySize,
  getSelectedProductsPricing,
  getFilterDisplayLabel,
  overrideListPrice,
  overrideCostPrice,
  tierProductScope,
  selectedPricingUnit = 'm2', // 'm2' | 'unit' | 'mixed'
  // NEW — per-product overrides. Optional. When present, per-row overrides win on save.
  productOverrides = null,          // { 'supplier|||sku': { trade_discount, credit_back_rate, disabled, ... } }
  setProductOverrides = null,       // (updater) => void
  selectedProductsList = null,      // full array of selected product objects (for the panel)
}) => {
  const filterLabel = getFilterDisplayLabel ? getFilterDisplayLabel(pricingSizeFilter) : pricingSizeFilter;

  const getScopedProductCount = () => {
    const filtered = getProductsFilteredBySize(pricingSizeFilter);
    if (tierProductScope && tierProductScope.size > 0) {
      return filtered.filter(p => tierProductScope.has(`${p.supplier}|||${p.sku}`)).length;
    }
    return pricingSizeFilter !== 'all' ? filtered.length : selectedProducts.size;
  };

  const scopedCount = getScopedProductCount();
  const isScoped = tierProductScope && tierProductScope.size > 0;

  // Dynamic tier helpers
  const thresholds = tierPricingConfig.thresholds || [10, 50, 100];
  const discounts = tierPricingConfig.discounts || [0, 5, 10, 15];
  const tierCount = discounts.length; // Number of tiers (thresholds.length + 1)

  // Trade discount type — 'percent' (default) or 'fixed' (flat £/m²)
  const tradeType = tierPricingConfig.trade_discount_type === 'fixed' ? 'fixed' : 'percent';
  const isTradeFixed = tradeType === 'fixed';
  // Unit-aware "per m²" vs "per unit" for the Trade Discount fixed mode.
  const isUnitPricing = selectedPricingUnit === 'unit';
  const tradeFixedSuffix = isUnitPricing ? '£/unit' : '£/m²';
  const tradeFixedLabel = isUnitPricing ? '(£/unit)' : '(£/m²)';

  const addTier = () => {
    const lastThreshold = thresholds[thresholds.length - 1] || 100;
    const lastDiscount = discounts[discounts.length - 1] || 15;
    setTierPricingConfig(prev => ({
      ...prev,
      thresholds: [...(prev.thresholds || [10, 50, 100]), lastThreshold + 50],
      discounts: [...(prev.discounts || [0, 5, 10, 15]), lastDiscount + 3],
    }));
  };

  const removeTier = (tierIndex) => {
    if (tierCount <= 2) return; // Minimum 2 tiers
    setTierPricingConfig(prev => {
      const newThresholds = [...(prev.thresholds || [10, 50, 100])];
      const newDiscounts = [...(prev.discounts || [0, 5, 10, 15])];
      // Remove threshold at tierIndex - 1 (thresholds are between tiers)
      if (tierIndex > 0 && tierIndex <= newThresholds.length) {
        newThresholds.splice(tierIndex - 1, 1);
      }
      newDiscounts.splice(tierIndex, 1);
      return { ...prev, thresholds: newThresholds, discounts: newDiscounts };
    });
  };

  const updateThreshold = (index, value) => {
    setTierPricingConfig(prev => {
      const newThresholds = [...(prev.thresholds || [10, 50, 100])];
      newThresholds[index] = parseInt(value) || 0;
      return { ...prev, thresholds: newThresholds };
    });
  };

  const updateDiscount = (index, value) => {
    setTierPricingConfig(prev => {
      const newDiscounts = [...(prev.discounts || [0, 5, 10, 15])];
      newDiscounts[index] = parseFloat(value) || 0;
      return { ...prev, discounts: newDiscounts };
    });
  };

  const setTradeType = (nextType) => {
    setTierPricingConfig(prev => ({
      ...prev,
      trade_discount_type: nextType,
      // Reset the numeric value to a sensible default for the new mode so
      // the user isn't left with e.g. "5" applied as £5/m² when they meant 5%
      trade_discount_default: nextType === 'fixed' ? 2 : 5,
    }));
  };

  // Half + Full pallet helpers
  const palletEnabled = !!tierPricingConfig.pallet_enabled;
  const setPalletField = (field, value) => {
    setTierPricingConfig(prev => ({ ...prev, [field]: value }));
  };
  // Unit-aware labels for the pallet block. Materials sold per bag → "bags per pallet";
  // tiles / flooring → "m² per pallet". Mixed selections default to m² with a warning.
  const palletIsUnit = selectedPricingUnit === 'unit';
  const palletIsMixed = selectedPricingUnit === 'mixed';
  const palletQtyLabel = palletIsUnit ? 'units / bags' : 'm²';
  const palletPriceLabel = palletIsUnit ? '£ per unit' : '£ per m²';
  const palletQtyPlaceholderFull = palletIsUnit ? 'e.g., 60' : 'e.g., 32.00';
  const palletQtyPlaceholderHalf = palletIsUnit ? 'e.g., 30' : 'auto: ½ of full';
  const palletPricePlaceholderFull = palletIsUnit ? 'e.g., 12.50' : 'e.g., 28.00';
  const palletPricePlaceholderHalf = palletIsUnit ? 'e.g., 13.20' : 'e.g., 30.00';
  const palletStorefrontHint = palletIsUnit
    ? 'On the storefront, customers see a Half Pallet / Full Pallet chip. Selecting one auto-sets the basket quantity to the matching unit count and applies the £/unit rate.'
    : 'On the storefront, customers see a Half Pallet / Full Pallet chip. Selecting one auto-sets the basket m² to the matching threshold and applies the £/m² rate.';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Percent className="w-5 h-5 text-amber-600" />
            Set Tier Discounts
          </DialogTitle>
        </DialogHeader>

        {/* Status Banner */}
        {selectedProducts.size > 0 && (
          <div className={`p-3 rounded-lg ${isScoped ? 'bg-amber-100 border border-amber-300' : pricingSizeFilter !== 'all' ? 'bg-purple-100 border border-purple-300' : 'bg-amber-100 border border-amber-300'}`}>
            <div className="flex items-center justify-between">
              <div>
                <p className={`font-semibold ${isScoped ? 'text-amber-800' : pricingSizeFilter !== 'all' ? 'text-purple-800' : 'text-amber-800'}`}>
                  {isScoped
                    ? `${scopedCount} selected product${scopedCount !== 1 ? 's' : ''}`
                    : pricingSizeFilter !== 'all'
                      ? `${filterLabel} products only`
                      : 'All selected products'}
                </p>
                <p className="text-sm text-gray-600">
                  {scopedCount} product{scopedCount !== 1 ? 's' : ''} will be updated
                </p>
              </div>
              {isScoped && (
                <span className="px-2 py-1 bg-amber-600 text-white text-xs rounded-full">Scoped</span>
              )}
              {!isScoped && pricingSizeFilter !== 'all' && (
                <span className="px-2 py-1 bg-purple-600 text-white text-xs rounded-full">Size Filter Active</span>
              )}
            </div>
          </div>
        )}

        <div className="space-y-6 py-4">
          {/* Disable Tier Pricing */}
          {selectedProducts.size > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tierPricingConfig.disabled || false}
                  onChange={(e) => setTierPricingConfig(prev => ({ ...prev, disabled: e.target.checked }))}
                  className="w-4 h-4 rounded border-red-300 text-red-600 focus:ring-red-500"
                  data-testid="tier-pricing-disable-checkbox"
                />
                <div>
                  <span className="font-medium text-red-800">Disable Tier Discounts</span>
                  <p className="text-xs text-red-600">Selected products will use list price only (no quantity discounts). Trade discount, credit back and Half + Full Pallet pricing still apply.</p>
                </div>
              </label>
            </div>
          )}

          {/* Tier Settings */}
          {!tierPricingConfig.disabled && (
            <>
              {/* Tier Thresholds */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="font-medium text-sm text-gray-700">Quantity Thresholds ({isUnitPricing ? 'units' : 'm²'})</h4>
                  <span className="text-xs text-gray-400">{tierCount} tiers</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {thresholds.map((threshold, i) => (
                    <div key={i} className="flex items-center gap-1">
                      <div className="relative">
                        <label className="text-[10px] text-gray-400 absolute -top-3.5 left-1">Tier {i + 2} starts at</label>
                        <input
                          type="number"
                          value={threshold}
                          onChange={(e) => updateThreshold(i, e.target.value)}
                          className="w-20 px-2 py-2 border border-gray-300 rounded-lg text-sm text-center"
                          data-testid={`threshold-${i}`}
                        />
                      </div>
                      {thresholds.length > 1 && (
                        <button
                          onClick={() => removeTier(i + 1)}
                          className="p-1 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition"
                          title={`Remove Tier ${i + 2}`}
                          data-testid={`remove-tier-${i + 1}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={addTier}
                    className="flex items-center gap-1 px-3 py-2 border-2 border-dashed border-gray-300 rounded-lg text-sm text-gray-500 hover:border-amber-400 hover:text-amber-600 hover:bg-amber-50 transition"
                    data-testid="add-tier-btn"
                  >
                    <Plus className="w-4 h-4" />
                    Add Tier
                  </button>
                </div>
              </div>

              {/* Tier Discounts */}
              <div>
                <h4 className="font-medium text-sm text-gray-700 mb-3">Tier Discounts (%)</h4>
                <div className="flex flex-wrap gap-2">
                  {discounts.map((discount, i) => {
                    const rangeStart = i === 0 ? 0 : thresholds[i - 1] || 0;
                    const rangeEnd = i < thresholds.length ? thresholds[i] : null;
                    const qtyUnit = isUnitPricing ? ' units' : 'm²';
                    const rangeLabel = rangeEnd !== null
                      ? `Tier ${i + 1} (${rangeStart}-${rangeEnd}${qtyUnit})`
                      : `Tier ${i + 1} (${rangeStart}${qtyUnit}+)`;
                    return (
                      <div key={i} className="relative">
                        <label className="text-[10px] text-gray-400 block mb-0.5 truncate max-w-[100px]" title={rangeLabel}>
                          {rangeLabel}
                        </label>
                        <div className="relative">
                          <input
                            type="number"
                            step="0.5"
                            value={discount}
                            onChange={(e) => updateDiscount(i, e.target.value)}
                            className="w-20 px-2 py-2 pr-7 border border-gray-300 rounded-lg text-sm text-center"
                            data-testid={`discount-${i}`}
                          />
                          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">%</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* Trade & Credit Back */}
          <div className={`grid ${selectedProducts.size > 0 ? 'grid-cols-1' : 'grid-cols-3'} gap-4`}>
            {selectedProducts.size === 0 && (
              <div>
                <label className="text-xs text-gray-500">Custom Quote Threshold ({isUnitPricing ? 'units' : 'm²'})</label>
                <input
                  type="number"
                  value={tierPricingConfig.custom_quote_threshold || 150}
                  onChange={(e) => setTierPricingConfig(prev => ({ ...prev, custom_quote_threshold: parseInt(e.target.value) || 150 }))}
                  className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                />
                <p className="text-xs text-gray-400 mt-1">Show &quot;Request Quote&quot; above this</p>
              </div>
            )}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-gray-500">
                  Trade Discount {isTradeFixed ? tradeFixedLabel : '(%)'}
                </label>
                {/* % / £ segmented toggle */}
                <div className="inline-flex rounded-md border border-gray-300 overflow-hidden text-[11px]">
                  <button
                    type="button"
                    onClick={() => setTradeType('percent')}
                    className={`px-2 py-1 flex items-center gap-1 transition ${
                      !isTradeFixed ? 'bg-amber-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'
                    }`}
                    data-testid="trade-discount-type-percent"
                    title="Trade discount as a percentage (%) of the tier price"
                  >
                    <Percent className="w-3 h-3" /> %
                  </button>
                  <button
                    type="button"
                    onClick={() => setTradeType('fixed')}
                    className={`px-2 py-1 flex items-center gap-1 border-l border-gray-300 transition ${
                      isTradeFixed ? 'bg-amber-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'
                    }`}
                    data-testid="trade-discount-type-fixed"
                    title="Trade discount as a flat £ amount off per m²"
                  >
                    <PoundSterling className="w-3 h-3" /> £
                  </button>
                </div>
              </div>
              <div className="relative">
                <input
                  type="number"
                  step={isTradeFixed ? '0.01' : '1'}
                  value={
                    tierPricingConfig.trade_discount_default !== undefined && tierPricingConfig.trade_discount_default !== null
                      ? tierPricingConfig.trade_discount_default
                      : (isTradeFixed ? 2 : 5)
                  }
                  onChange={(e) => setTierPricingConfig(prev => ({
                    ...prev,
                    trade_discount_default: isTradeFixed ? (parseFloat(e.target.value) || 0) : (parseInt(e.target.value) || 0),
                  }))}
                  className="w-full px-3 py-2 pr-8 border border-gray-300 rounded-lg text-sm"
                  data-testid="trade-discount-input"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400">
                  {isTradeFixed ? tradeFixedSuffix : '%'}
                </span>
              </div>
              <p className="text-xs text-gray-400 mt-1">
                {isTradeFixed
                  ? `Flat £ per ${isUnitPricing ? 'unit' : 'm²'} deducted from the tier-discounted price for trade accounts. Stacks on top of the volume discount.`
                  : (selectedProducts.size > 0 ? 'Extra % off for trade accounts on these products (stacks on volume tier)' : 'Extra % off for trade accounts (stacks on volume tier)')
                }
              </p>
            </div>
            <div>
              <label className="text-xs text-gray-500">Credit Back Rate (%)</label>
              <div className="relative mt-1">
                <input
                  type="number"
                  step="0.5"
                  value={tierPricingConfig.credit_back_default || 2}
                  onChange={(e) => setTierPricingConfig(prev => ({ ...prev, credit_back_default: parseFloat(e.target.value) || 2 }))}
                  className="w-full px-3 py-2 pr-8 border border-gray-300 rounded-lg text-sm"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400">%</span>
              </div>
              <p className="text-xs text-gray-400 mt-1">% credited back on trade orders (deducted from profit)</p>
            </div>
          </div>

          {/* Half + Full Pallet Pricing (independent of tier-disabled) */}
          {selectedProducts.size > 0 && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-4" data-testid="pallet-pricing-block">
              <label className="flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={palletEnabled}
                  onChange={(e) => setPalletField('pallet_enabled', e.target.checked)}
                  className="w-5 h-5 mt-0.5 rounded border-green-300 text-green-600 focus:ring-green-500"
                  data-testid="pallet-enabled-checkbox"
                />
                <div className="flex-1">
                  <span className="font-semibold text-green-800 flex items-center gap-2">
                    <Truck className="w-4 h-4" />
                    Half + Full Pallet Pricing
                  </span>
                  <p className="text-xs text-green-600 mt-0.5">
                    Bulk pricing for pallet quantities. Applied independently of tier discounts — works whether tier pricing is enabled or disabled above.
                  </p>
                </div>
              </label>

              {palletEnabled && (
                <div className="mt-4 space-y-3">
                  {palletIsMixed && (
                    <div className="text-xs bg-amber-100 border border-amber-300 text-amber-900 p-2 rounded">
                      ⚠️ Your selection mixes m² (surface) and unit (bag / each) products. Split them and edit each group separately — the labels below default to <strong>m²</strong>.
                    </div>
                  )}
                  <p className="text-xs text-green-700 font-medium">
                    Pallet quantities ({palletQtyLabel}) and {palletPriceLabel} rates — leave Half blank to default to ½ of Full.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-green-800 font-medium">Full Pallet ({palletQtyLabel})</label>
                      <input
                        type="number"
                        step={palletIsUnit ? '1' : '0.01'}
                        value={tierPricingConfig.m2_per_pallet ?? ''}
                        onChange={(e) => setPalletField('m2_per_pallet', e.target.value === '' ? null : parseFloat(e.target.value))}
                        placeholder={palletQtyPlaceholderFull}
                        className="w-full mt-1 px-3 py-2 border border-green-200 bg-white rounded-lg text-sm"
                        data-testid="pallet-m2-per-pallet-input"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-green-800 font-medium">Full Pallet — {palletPriceLabel}</label>
                      <input
                        type="number"
                        step="0.01"
                        value={tierPricingConfig.pallet_price ?? ''}
                        onChange={(e) => setPalletField('pallet_price', e.target.value === '' ? null : parseFloat(e.target.value))}
                        placeholder={palletPricePlaceholderFull}
                        className="w-full mt-1 px-3 py-2 border border-green-200 bg-white rounded-lg text-sm"
                        data-testid="pallet-full-price-input"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-green-800 font-medium">Half Pallet ({palletQtyLabel})</label>
                      <input
                        type="number"
                        step={palletIsUnit ? '1' : '0.01'}
                        value={tierPricingConfig.m2_per_half_pallet ?? ''}
                        onChange={(e) => setPalletField('m2_per_half_pallet', e.target.value === '' ? null : parseFloat(e.target.value))}
                        placeholder={palletQtyPlaceholderHalf}
                        className="w-full mt-1 px-3 py-2 border border-green-200 bg-white rounded-lg text-sm"
                        data-testid="pallet-m2-per-half-input"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-green-800 font-medium">Half Pallet — {palletPriceLabel}</label>
                      <input
                        type="number"
                        step="0.01"
                        value={tierPricingConfig.half_pallet_price ?? ''}
                        onChange={(e) => setPalletField('half_pallet_price', e.target.value === '' ? null : parseFloat(e.target.value))}
                        placeholder={palletPricePlaceholderHalf}
                        className="w-full mt-1 px-3 py-2 border border-green-200 bg-white rounded-lg text-sm"
                        data-testid="pallet-half-price-input"
                      />
                    </div>
                  </div>
                  <p className="text-[11px] text-green-600">
                    {palletStorefrontHint}
                  </p>
                </div>
              )}
            </div>
          )}

          {!tierPricingConfig.disabled && (
            <>
              {/* Quick Save for Filtered */}
              {selectedProducts.size > 0 && (pricingSizeFilter !== 'all' || isScoped) && (
                <div className={`${isScoped ? 'bg-amber-100 border-2 border-amber-400' : 'bg-purple-100 border-2 border-purple-400'} rounded-lg p-4`}>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className={`font-semibold ${isScoped ? 'text-amber-800' : 'text-purple-800'}`}>
                        Save for {isScoped ? `${scopedCount} selected product${scopedCount !== 1 ? 's' : ''}` : `${filterLabel} only`}
                      </p>
                      <p className={`text-sm ${isScoped ? 'text-amber-600' : 'text-purple-600'}`}>
                        {scopedCount} product{scopedCount !== 1 ? 's' : ''} will be updated with: {discounts.join('%, ')}% discounts
                      </p>
                    </div>
                    <Button
                      onClick={onSave}
                      disabled={tierPricingSaving}
                      className={`${isScoped ? 'bg-amber-600 hover:bg-amber-700' : 'bg-purple-600 hover:bg-purple-700'} text-white px-6 py-2`}
                    >
                      {tierPricingSaving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                      Save {isScoped ? `${scopedCount} Products` : filterLabel}
                    </Button>
                  </div>
                </div>
              )}

              {/* Live Preview */}
              <div className="bg-gray-50 p-4 rounded-lg">
                {(() => {
                  const pricing = getSelectedProductsPricing(pricingSizeFilter);
                  const basePrice = overrideListPrice ? parseFloat(overrideListPrice) : pricing.avgListPrice;
                  const costPrice = overrideCostPrice ? parseFloat(overrideCostPrice) : pricing.avgCostPrice;
                  const usingOverride = overrideListPrice || overrideCostPrice;
                  const hasMultiplePrices = !usingOverride && pricing.minListPrice !== pricing.maxListPrice;
                  const exVatPrice = basePrice / 1.2;
                  const vatAmount = basePrice - exVatPrice;
                  const creditBackRate = tierPricingConfig.credit_back_default || 2;
                  const creditBackAmount = exVatPrice * (creditBackRate / 100);
                  const netProfit = exVatPrice - costPrice - creditBackAmount;
                  const filteredCount = isScoped ? scopedCount : (pricing.count || selectedProducts.size);

                  return (
                    <>
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="font-medium text-sm text-gray-700">
                          Live Preview
                          {usingOverride ? (
                            <span className="text-blue-600 ml-1">(Using entered prices: £{basePrice.toFixed(2)})</span>
                          ) : filteredCount > 0 ? (
                            <span className="text-green-600 ml-1">
                              (Using actual prices from {filteredCount} {pricingSizeFilter !== 'all' ? filterLabel : ''} product{filteredCount > 1 ? 's' : ''})
                            </span>
                          ) : null}
                        </h4>
                      </div>

                      {/* Pricing Breakdown */}
                      <div className="bg-white border border-gray-200 rounded-lg p-3 mb-3">
                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between">
                            <span className="text-gray-600">Final Sold Price (inc VAT)</span>
                            <span className="font-semibold text-blue-600">£{basePrice.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between text-purple-600">
                            <span>÷ 1.2 (Ex-VAT)</span>
                            <span className="font-semibold">£{exVatPrice.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between text-gray-400 text-xs">
                            <span>VAT Amount</span>
                            <span>£{vatAmount.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between text-red-600">
                            <span>- Cost Price</span>
                            <span>-£{costPrice.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between text-orange-600 border-b pb-2">
                            <span>- Credit Back ({creditBackRate}%)</span>
                            <span>-£{creditBackAmount.toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between pt-1">
                            <span className="font-bold text-gray-800">Net Profit</span>
                            <span className={`font-bold text-lg ${netProfit > 0 ? 'text-green-600' : 'text-red-600'}`}>
                              £{netProfit.toFixed(2)}
                            </span>
                          </div>
                          {exVatPrice > 0 && (
                            <div className="text-xs text-gray-500 text-right">
                              Margin: {((netProfit / exVatPrice) * 100).toFixed(0)}%
                            </div>
                          )}
                        </div>
                        {hasMultiplePrices && (
                          <div className="text-xs text-gray-400 mt-2 pt-2 border-t">
                            Price Range: £{pricing.minListPrice.toFixed(2)} - £{pricing.maxListPrice.toFixed(2)}
                          </div>
                        )}
                      </div>

                      {/* Dynamic Tier Pricing Table */}
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-gray-500 border-b">
                              <th className="text-left py-2">Tier</th>
                              <th className="text-left py-2">Quantity</th>
                              <th className="text-right py-2">Discount</th>
                              <th className="text-right py-2">Sold Price</th>
                              <th className="text-right py-2 text-purple-600">Ex-VAT</th>
                              <th className="text-right py-2 text-red-600">-Cost</th>
                              <th className="text-right py-2 text-orange-600">-CB</th>
                              <th className="text-right py-2 text-green-700">Profit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {discounts.map((discount, i) => {
                              const tradeValue = tierPricingConfig.trade_discount_default ?? (isTradeFixed ? 2 : 5);
                              const creditBackRateVal = tierPricingConfig.credit_back_default || 2;
                              // Volume tier price (inc VAT)
                              const volumePriceIncVat = basePrice * (1 - discount / 100);
                              // Apply trade discount — stacked on volume tier
                              const soldPrice = isTradeFixed
                                ? Math.max(0, volumePriceIncVat - tradeValue)
                                : volumePriceIncVat * (1 - tradeValue / 100);
                              const tierExVat = soldPrice / 1.2;
                              const tierCreditBack = tierExVat * (creditBackRateVal / 100);
                              const tierNetProfit = tierExVat - costPrice - tierCreditBack;
                              const rangeStart = i === 0 ? 0 : thresholds[i - 1] || 0;
                              const rangeEnd = i < thresholds.length ? thresholds[i] : null;
                              const qtyUnit = isUnitPricing ? ' units' : 'm²';
                              const qtyLabel = rangeEnd !== null
                                ? `${rangeStart} - ${rangeEnd}${qtyUnit}`
                                : `${rangeStart}${qtyUnit}+`;
                              const discountLabel = isTradeFixed
                                ? `${discount}% + £${Number(tradeValue).toFixed(2)}`
                                : `${discount + tradeValue}%`;
                              return (
                                <tr key={i} className="border-b">
                                  <td className="py-2">Tier {i + 1}</td>
                                  <td>{qtyLabel}</td>
                                  <td className="text-right">{discountLabel}</td>
                                  <td className="text-right font-medium text-blue-600">£{soldPrice.toFixed(2)}</td>
                                  <td className="text-right text-purple-600 font-medium">£{tierExVat.toFixed(2)}</td>
                                  <td className="text-right text-red-500">-£{costPrice.toFixed(2)}</td>
                                  <td className="text-right text-orange-500">-£{tierCreditBack.toFixed(2)}</td>
                                  <td className={`text-right font-bold ${tierNetProfit > 0 ? 'text-green-600' : 'text-red-600'}`}>
                                    £{tierNetProfit.toFixed(2)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      <div className="mt-2 text-xs text-gray-500 text-right">
                        * Profit = Ex-VAT - Cost - Credit Back ({creditBackRate}%)
                      </div>
                    </>
                  );
                })()}
              </div>
            </>
          )}

          {/* Disabled Message */}
          {tierPricingConfig.disabled && (
            <div className="bg-gray-100 rounded-lg p-6 text-center">
              <XCircle className="w-12 h-12 text-gray-400 mx-auto mb-3" />
              <p className="text-gray-600 font-medium">Tier Quantity Discounts Disabled</p>
              <p className="text-sm text-gray-500 mt-1">Selected products will show list price only — no quantity-based tier discounts.</p>
              <p className="text-sm text-green-600 mt-1">Trade discount, credit back and Half + Full Pallet settings above still apply.</p>
            </div>
          )}

          {/* Per-Product Overrides (optional) — only shown when parent provides productOverrides + setter */}
          {productOverrides && setProductOverrides && Array.isArray(selectedProductsList) && selectedProductsList.length > 0 && (
            <PerProductOverridesPanel
              products={selectedProductsList}
              overrides={productOverrides}
              setOverrides={setProductOverrides}
              tradeFixedSuffix={tradeFixedSuffix}
              isTradeFixed={isTradeFixed}
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={onSave}
            disabled={tierPricingSaving}
            className={tierPricingConfig.disabled ? "bg-red-600 hover:bg-red-700" : "bg-amber-600 hover:bg-amber-700"}
            data-testid="tier-pricing-save-btn"
          >
            {tierPricingSaving ? <RefreshCw className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            {(() => {
              if (selectedProducts.size === 0) return 'Save Global Settings';
              const sizeLabel = pricingSizeFilter !== 'all' ? ` (${filterLabel})` : '';
              if (tierPricingConfig.disabled) {
                return `Disable for ${scopedCount} Product${scopedCount !== 1 ? 's' : ''}${sizeLabel}`;
              }
              return `Save for ${scopedCount} Product${scopedCount !== 1 ? 's' : ''}${sizeLabel}`;
            })()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default TierPricingModal;
