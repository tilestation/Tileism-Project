/**
 * PricingHubModal — ONE place for everything money-related on the selected
 * products. Two tabs:
 *   ▸ Prices, Cost, Stock & Sale   (BulkFieldsModal body — set / adjust / edit each, WAS/NOW)
 *   ▸ Tier Discounts, Trade & Pallets (TierPricingModal body — tiers, trade %, credit back,
 *                                       half/full pallet rates, pallet-only, per-product overrides)
 * The two panels are the existing modals rendered in `embedded` mode so their
 * save logic is untouched.
 */
import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../../components/ui/dialog';
import { PoundSterling, Percent } from 'lucide-react';

const TABS = [
  { key: 'prices', label: 'Prices, Cost, Stock & Sale', hint: 'Now / Was price · cost · stock', icon: PoundSterling, testid: 'pricing-hub-tab-prices' },
  { key: 'tiers',  label: 'Tier Discounts, Trade & Pallets', hint: 'Quantity tiers · trade % · half / full pallets', icon: Percent, testid: 'pricing-hub-tab-tiers' },
];

const PricingHubModal = ({ open, onOpenChange, initialTab = 'prices', count = 0, pricesPanel, tierPanel }) => {
  const [tab, setTab] = useState(initialTab);
  useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[92vh] overflow-y-auto" data-testid="pricing-hub-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PoundSterling className="w-5 h-5 text-emerald-600" />
            Pricing — {count} product{count !== 1 ? 's' : ''}
          </DialogTitle>
        </DialogHeader>
        <div className="flex gap-1 border-b border-gray-200">
          {TABS.map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`flex-1 px-3 py-2 text-sm font-semibold border-b-2 transition-colors ${tab === t.key ? 'border-emerald-500 text-emerald-700 bg-emerald-50' : 'border-transparent text-gray-500 hover:text-gray-800'}`}
              data-testid={t.testid}
              aria-selected={tab === t.key}
            >
              <span className="flex items-center justify-center gap-1.5"><t.icon className="w-4 h-4" />{t.label}</span>
              <span className="block text-[10px] font-normal text-gray-400 mt-0.5">{t.hint}</span>
            </button>
          ))}
        </div>
        <div className="pt-1" data-testid={`pricing-hub-panel-${tab}`}>
          {tab === 'prices' ? pricesPanel : tierPanel}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PricingHubModal;
