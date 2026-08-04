/**
 * FlooringManager — LVT, laminate, engineered wood, vinyl.
 *
 * Now a thin wrapper around ManagerPageShell. All state, product-fetch,
 * bulk operations, filters, edit modal, drafts, config, presets, CSV import,
 * tier pricing and colour assignment live inside the shared shell.
 *
 * URL: /admin/flooring
 */

import React from 'react';
import { Grid3X3 } from 'lucide-react';
import ManagerPageShell from './components/ManagerPageShell';

const _floorSubTest = (p, re) => {
  if (re.test(String(p.type || ''))) return true;
  if ((p.sub_categories || []).some(s => re.test(String(s)))) return true;
  const name = String(p.our_product_name || p.product_name || p.name || '');
  return re.test(name);
};

const FLOOR_SUB_TABS = [
  { key: 'all',      label: 'All Flooring', match: () => true },
  { key: 'lvt',      label: 'LVT',      match: (p) => _floorSubTest(p, /lvt|luxury vinyl/i) },
  { key: 'laminate', label: 'Laminate', match: (p) => _floorSubTest(p, /laminate/i) },
  { key: 'wood',     label: 'Wood',     match: (p) => _floorSubTest(p, /wood|engineered/i) },
  { key: 'vinyl',    label: 'Vinyl',    match: (p) => _floorSubTest(p, /vinyl/i) },
];

const isFlooring = (p) => {
  const grp = String(p.product_group || '').toLowerCase();
  const mainCat = String(p.main_category || '').toLowerCase();
  const subCats = Array.isArray(p.sub_categories) ? p.sub_categories : [];
  if (grp === 'flooring' || mainCat === 'flooring') return true;
  return subCats.some(sc => /flooring|lvt|laminate|engineered|vinyl|luxury vinyl/i.test(String(sc)));
};

const FlooringManager = () => (
  <ManagerPageShell
    categoryKey="flooring"
    title="Flooring Manager"
    subtitle="LVT, laminate, engineered wood, vinyl"
    icon={Grid3X3}
    theme="amber"
    isMatch={isFlooring}
    subTabs={FLOOR_SUB_TABS}
    facetCategory="tiles"
    columns={[
      { key: 'size',       label: 'Size' },
      { key: 'thickness',  label: 'Thickness' },
      { key: 'wear_layer', label: 'Wear Layer' },
      { key: 'finish',     label: 'Finish' },
      { key: 'color',      label: 'Colour', render: (p) => p.color || (Array.isArray(p.colors) && p.colors[0]) || '—' },
    ]}
    editFields={[
      { key: 'size',              label: 'Size',                 hint: 'e.g., 1220x180mm' },
      { key: 'thickness',         label: 'Thickness',            hint: 'e.g., 8mm' },
      { key: 'wear_layer',        label: 'Wear Layer',           hint: 'e.g., 0.5mm' },
      { key: 'finish',            label: 'Finish' },
      { key: 'click_system',      label: 'Click System',         hint: 'e.g., Uniclic, DropLock, Angle-Angle' },
      { key: 'underlay_included', label: 'Underlay Included',    hint: 'yes / no / bundled' },
      { key: 'material',          label: 'Material',             hint: 'LVT, Laminate, Engineered Wood, Vinyl' },
      { key: 'color',             label: 'Colour' },
      { key: 'pack_coverage',     label: 'Pack Coverage (m²)',   hint: 'e.g., 2.20' },
      { key: 'suitability',       label: 'Suitability',          hint: 'Indoor / Wet room / Underfloor Heat' },
      { key: 'made_in',           label: 'Made In' },
    ]}
    presetCategory="flooring"
    tierPricingDefaults={{ default_unit: 'm2', trade_discount_default: 5, trade_discount_type: 'percent' }}
    bannerBullets={[
      'Search or filter to find a floor (LVT, Laminate, Wood, Vinyl).',
      'Click Edit on a row to change fields — only flooring-relevant ones show.',
      'Use + Add New Flooring for a brand-new product (opens the Wizard).',
      'Tier pricing, publish, stock & refund flows still work through the shared backend.',
    ]}
  />
);

export default FlooringManager;
