/**
 * BathroomManager — toilets, basins, baths, showers, taps.
 * Uses the shared ManagerPageShell for all layout / bulk actions.
 * URL: /admin/bathroom
 */

import React from 'react';
import { Bath } from 'lucide-react';
import ManagerPageShell from './components/ManagerPageShell';

const isBathroom = (p) => {
  const grp = String(p.product_group || '').toLowerCase();
  const mainCat = String(p.main_category || '').toLowerCase();
  const subCats = Array.isArray(p.sub_categories) ? p.sub_categories : [];
  if (grp === 'bathroom' || mainCat === 'bathroom') return true;
  return subCats.some(sc => /bathroom|toilet|basin|bath|shower|tap|faucet|vanity|mirror|towel|radiator/i.test(String(sc)));
};

const SUB_TABS = [
  { key: 'all',      label: 'All Bathroom', match: () => true },
  { key: 'toilet',   label: 'Toilets',       match: (p) => matchAny(p, /toilet/i) },
  { key: 'basin',    label: 'Basins',        match: (p) => matchAny(p, /basin|sink|vanity/i) },
  { key: 'bath',     label: 'Baths',         match: (p) => matchAny(p, /\bbath(?!room)/i) },
  { key: 'shower',   label: 'Showers',       match: (p) => matchAny(p, /shower|enclosure/i) },
  { key: 'tap',      label: 'Taps & Mixers', match: (p) => matchAny(p, /tap|mixer|faucet/i) },
  { key: 'accessory', label: 'Accessories',  match: (p) => matchAny(p, /towel|mirror|radiator|hook|accessory|holder/i) },
];

const matchAny = (p, regex) => {
  const scs = Array.isArray(p.sub_categories) ? p.sub_categories : [];
  const name = String(p.our_product_name || p.product_name || p.name || '');
  return scs.some(sc => regex.test(String(sc))) || regex.test(name) || regex.test(String(p.type || ''));
};

const COLUMNS = [
  { key: 'brand',      label: 'Brand' },
  { key: 'model',      label: 'Model' },
  { key: 'dimensions', label: 'Dimensions' },
  { key: 'material',   label: 'Material' },
  { key: 'color',      label: 'Colour',     render: (p) => p.color || (Array.isArray(p.colors) && p.colors[0]) || '—' },
];

const EDIT_FIELDS = [
  { key: 'brand',         label: 'Brand' },
  { key: 'model',         label: 'Model' },
  { key: 'dimensions',    label: 'Dimensions (W × H × D)', hint: 'e.g., 600×800×400 mm' },
  { key: 'flush_type',    label: 'Flush Type',              hint: 'Dual-flush, Rimless, Wall-hung' },
  { key: 'tank_capacity', label: 'Tank Capacity (L)',       type: 'number' },
  { key: 'material',      label: 'Material',                type: 'select', options: ['Ceramic', 'Vitreous China', 'Steel', 'Acrylic', 'Stone Resin', 'Brass', 'Stainless Steel'] },
  { key: 'finish',        label: 'Finish',                  type: 'select', options: ['Chrome', 'Matt Black', 'Brushed Brass', 'Nickel', 'Gunmetal', 'White'] },
  { key: 'color',         label: 'Colour' },
  { key: 'warranty',      label: 'Warranty',                hint: 'e.g., 10 years' },
  { key: 'suitability',   label: 'Suitability' },
];

const BathroomManager = () => (
  <ManagerPageShell
    categoryKey="bathroom"
    title="Bathroom Manager"
    subtitle="Toilets, basins, baths, showers, taps & accessories"
    icon={Bath}
    theme="cyan"
    isMatch={isBathroom}
    subTabs={SUB_TABS}
    columns={COLUMNS}
    editFields={EDIT_FIELDS}
    presetCategory="bathroom"
    facetCategory="custom"
    seriesQuickEdit
    tierPricingDefaults={{ default_unit: 'unit' }}
    bannerBullets={[
      'Search or filter to find a bathroom product (toilet, basin, bath, shower, tap, accessory).',
      'Click Edit on a row to open the shared Quick Edit Product modal — Display Name, Supplier Name, Prices, Stock & Product Images all in one place.',
      'Use + Add New for a brand-new bathroom item (opens the Wizard).',
      'Bulk price, images and AI descriptions all work from the shared bar at the bottom.',
    ]}
  />
);

export default BathroomManager;
