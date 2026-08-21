/**
 * VolumePricingTable - PROTECTED CRITICAL COMPONENT
 * 
 * Renders the "Volume Pricing - Buy More, Save More" tier table
 * on Collection Detail pages. This is a core revenue-driving UI element.
 * 
 * Visibility rules:
 *   - SHOW when tierPricing array has data (length > 0)
 *   - HIDE when tierPricing is null, empty, or disabled
 *   - NEVER hide based on trade status (trade users see adjusted prices)
 */
import React from 'react';
import { Percent } from 'lucide-react';

const VolumePricingTable = ({
  tierPricing,
  isSurfaceProduct,
  isTrade,
  tradeDiscount = 0,
  selectedProduct,
  getEffectiveSqmQuantity,
}) => {
  if (!tierPricing || tierPricing.length === 0) return null;

  return (
    <div data-testid="volume-pricing-table" className="border-2 border-amber-300 rounded-lg overflow-hidden shadow-sm">
      <div className="bg-gradient-to-r from-amber-500 to-amber-600 px-4 py-3 flex items-center gap-2">
        <Percent className="w-5 h-5 text-white" />
        <span className="font-bold text-white text-base">
          {isTrade ? 'Trade Volume Pricing - Buy More, Save More' : 'Volume Pricing - Buy More, Save More'}
        </span>
      </div>
      <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left px-4 py-2 font-medium text-gray-600">Quantity</th>
            <th className="text-right px-4 py-2 font-medium text-gray-600">
              {isTrade 
                ? (isSurfaceProduct ? 'Trade Price/m²' : 'Trade Price/each')
                : (isSurfaceProduct ? 'Price/m²' : 'Price/each')
              }
            </th>
            <th className="text-right px-4 py-2 font-medium text-gray-600">Savings</th>
          </tr>
        </thead>
        <tbody>
          {tierPricing.map((tier, idx) => {
            const effQty = getEffectiveSqmQuantity();
            const isCurrentTier = effQty >= tier.min_qty &&
              (tier.max_qty === null || tier.max_qty === undefined || effQty < tier.max_qty);

            const selectedBasePrice = selectedProduct?.room_lot_price || selectedProduct?.price || 0;
            
            // For trade tiers, the first tier's price_per_m2 already has trade discount applied
            // so it won't match selectedBasePrice. Undo trade discount for comparison.
            const tierBasePrice = tierPricing[0]?.price_per_m2 || tierPricing[0]?.price || 0;
            const effectiveTierBase = (isTrade && tradeDiscount > 0) 
              ? tierBasePrice / (1 - tradeDiscount / 100)
              : tierBasePrice;
            const tiersMatchProduct = Math.abs(effectiveTierBase - selectedBasePrice) < 0.5;
            
            let tierDisplayPrice;
            if (tiersMatchProduct) {
              // Backend calculated correct prices for this product
              tierDisplayPrice = tier.price_per_m2 || tier.price || 0;
            } else {
              // Recalculate for the selected product's base price
              const volumeDiscount = tier.discount_percent || 0;
              let price = selectedBasePrice * (1 - volumeDiscount / 100);
              // Apply trade discount on top of volume discount
              if (isTrade && tradeDiscount > 0) {
                price = price * (1 - tradeDiscount / 100);
              }
              tierDisplayPrice = Math.round(price * 100) / 100;
            }

            // Calculate total savings % for trade users (volume + trade combined)
            const volumeDiscount = tier.discount_percent || 0;
            // Trade savings label: derive from the ACTUAL displayed price vs retail base
            // when backend tiers are used verbatim (keeps price + label consistent for
            // fixed-£ discounts); otherwise compound the rates.
            const totalDiscount = (isTrade && tradeDiscount > 0)
              ? (tiersMatchProduct && selectedBasePrice > 0
                  ? Math.round((1 - tierDisplayPrice / selectedBasePrice) * 100)
                  : Math.round((1 - (1 - volumeDiscount / 100) * (1 - tradeDiscount / 100)) * 100))
              : volumeDiscount;

            return (
              <tr key={idx} className={isCurrentTier ? 'bg-amber-50' : ''}>
                <td className="px-4 py-2 border-t">
                  {(() => {
                    const raw = tier.label || `${tier.min_qty}+ ${isSurfaceProduct ? 'm²' : 'units'}`;
                    // Unit products: backend tier labels are m²-based — relabel as units.
                    return isSurfaceProduct ? raw : raw.replace(/\s*m²/g, ' units');
                  })()}
                  {isCurrentTier && (
                    <span className="ml-2 bg-amber-500 text-white text-xs px-2 py-0.5 rounded">Your Price</span>
                  )}
                </td>
                <td className="px-4 py-2 border-t text-right font-medium">
                  £{(isTrade ? tierDisplayPrice / 1.20 : tierDisplayPrice).toFixed(2)}
                  {isTrade && <span className="text-[10px] text-gray-400 font-normal ml-1">ex. VAT</span>}
                </td>
                <td className="px-4 py-2 border-t text-right text-green-600">
                  {isTrade ? (
                    totalDiscount > 0 ? `Extra ${totalDiscount}% Off` : '-'
                  ) : (
                    volumeDiscount > 0 ? `Extra ${volumeDiscount}% Off` : (tier.savings_label === 'List Price' ? '-' : '-')
                  )}
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

export default VolumePricingTable;
