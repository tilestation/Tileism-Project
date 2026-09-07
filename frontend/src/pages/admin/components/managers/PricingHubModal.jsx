/**
 * PricingHubModal — ONE place for everything money-related on the selected
 * products. Three sections, each a tab:
 *   ▸ Prices & Sale             (BulkFieldsModal body — set / adjust / edit each, Now / Was £)
 *   ▸ Pallets & Delivery        (PalletsDeliveryPanel — per-product pallet rates, pallet-only,
 *                                mandatory delivery £, parcel — one table, fill-all shortcut)
 *   ▸ Volume & Trade Discounts  (TierPricingModal body — quantity tiers, trade % / £, credit back)
 * The panels are the existing components rendered in `embedded` mode so their
 * save logic is untouched.
 */
import React, { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../../components/ui/dialog';
import { PoundSterling, Percent, Truck } from 'lucide-react';
import LivePricingStatus from './LivePricingStatus';

const TABS = [
  { key: 'prices',  label: 'Prices & Sale',            hint: 'Now / Was £ · SALE · CLEARANCE · cost · stock',       icon: PoundSterling, testid: 'pricing-hub-tab-prices' },
  { key: 'pallets', label: 'Pallets & Delivery',       hint: 'Pallet only · pallet rates · delivery £ — per item',  icon: Truck,         testid: 'pricing-hub-tab-pallets' },
  { key: 'tiers',   label: 'Volume & Trade Discounts', hint: 'Quantity tiers · trade % / £ · credit back',          icon: Percent,       testid: 'pricing-hub-tab-tiers' },
];

const PricingHubModal = ({ open, onOpenChange, initialTab = 'prices', count = 0, selectedList = [], pricesPanel, palletsPanel, tierPanel }) => {
  const [tab, setTab] = useState(initialTab);
  useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);
  const panel = { prices: pricesPanel, pallets: palletsPanel, tiers: tierPanel }[tab];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[92vh] overflow-y-auto" data-testid="pricing-hub-modal">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PoundSterling className="w-5 h-5 text-emerald-600" />
            Pricing — {count} product{count !== 1 ? 's' : ''}
            <span className="ml-2 text-xs font-normal text-gray-500">Prices, pallets, delivery and discounts — all in one place</span>
          </DialogTitle>
        </DialogHeader>
        {open && <LivePricingStatus selectedList={selectedList} />}
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
          {panel}
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PricingHubModal;
