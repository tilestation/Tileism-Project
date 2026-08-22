/**
 * TilesManager — dedicated admin section for wall & floor tiles, mosaics, borders.
 *
 * Now a thin wrapper around ManagerPageShell. All bulk operations, filters,
 * edit modal, drafts, config, presets, CSV import, tier pricing and colour
 * assignment live inside the shared shell.
 *
 * URL: /admin/tiles
 */

import React from 'react';
import { Square } from 'lucide-react';
import ManagerPageShell from './components/ManagerPageShell';

const _tileSubTest = (p, re) => {
  if (re.test(String(p.type || ''))) return true;
  if ((p.sub_categories || []).some(s => re.test(String(s)))) return true;
  const name = String(p.our_product_name || p.product_name || p.name || '');
  return re.test(name);
};

const TILE_SUB_TABS = [
  { key: 'all',     label: 'All Tiles', match: () => true },
  { key: 'floor',   label: 'Floor',   match: (p) => _tileSubTest(p, /floor/i) },
  { key: 'wall',    label: 'Wall',    match: (p) => _tileSubTest(p, /wall/i) },
  { key: 'mosaic',  label: 'Mosaic',  match: (p) => _tileSubTest(p, /mosaic/i) },
  { key: 'feature', label: 'Feature', match: (p) => _tileSubTest(p, /feature|border|decor/i) },
];

const isTile = (p) => {
  const grp = String(p.product_group || '').toLowerCase();
  const mainCat = String(p.main_category || '').toLowerCase();
  const subCats = Array.isArray(p.sub_categories) ? p.sub_categories : [];
  if (grp === 'tiles' || mainCat === 'tiles') return true;
  return subCats.some(sc => /tile|mosaic|border/i.test(String(sc)));
};

const TilesManager = () => (
  <ManagerPageShell
    categoryKey="tiles"
    title="Tiles Manager"
    subtitle="Wall & floor tiles, mosaics, borders"
    icon={Square}
    theme="blue"
    isMatch={isTile}
    subTabs={TILE_SUB_TABS}
    facetCategory="tiles"
    seriesQuickEdit
    columns={[
      { key: 'size',        label: 'Size' },
      { key: 'thickness',   label: 'Thickness' },
      { key: 'material',    label: 'Material' },
      { key: 'finish',      label: 'Finish' },
      { key: 'slip_rating', label: 'Slip' },
      { key: 'color',       label: 'Colour', render: (p) => p.color || (Array.isArray(p.colors) && p.colors[0]) || '—' },
    ]}
    editFields={[
      { key: 'size',        label: 'Size',      hint: 'e.g., 600x600, 300x600' },
      { key: 'thickness',   label: 'Thickness', hint: 'e.g., 10mm' },
      { key: 'material',    label: 'Material', type: 'select',
        options: ['Porcelain', 'Ceramic', 'Natural Stone', 'Glass', 'Mosaic'] },
      { key: 'finish',      label: 'Finish', type: 'select',
        options: ['Matt', 'Polished', 'Satin', 'Textured', 'Semi-polished', 'Rustic'] },
      { key: 'slip_rating', label: 'Slip Rating', type: 'select',
        options: ['R9', 'R10', 'R11', 'R12', 'R13'] },
      { key: 'edge',        label: 'Edge', type: 'select',
        options: ['Rectified', 'Non-rectified', 'Bevelled'] },
      { key: 'type',        label: 'Tile Type', type: 'select',
        options: ['Floor Tile', 'Wall Tile', 'Floor & Wall', 'Mosaic', 'Feature', 'Border'] },
      { key: 'color',       label: 'Colour',      hint: 'e.g., Grey, White, Beige' },
      { key: 'suitability', label: 'Suitability', hint: 'Indoor / Outdoor / Wet area' },
      { key: 'made_in',     label: 'Made In', type: 'select',
        options: ['Italy','Spain','Portugal','Poland','Turkey','India','Vietnam','China','UK','Europe','Other'] },
    ]}
    presetCategory="tiles"
    tierPricingDefaults={{ default_unit: 'm2', trade_discount_default: 5, trade_discount_type: 'percent' }}
    bannerBullets={[
      'Search or filter to find a tile (Floor, Wall, Mosaic, Feature).',
      'Click Edit on a row to open the shared Quick Edit Product modal — Display Name, Supplier Name, Prices, Stock & Product Images all in one place.',
      'Use + Add New Tile for a brand-new product (opens the 3-step Wizard).',
      'Tier pricing, publish, stock & refund flows still work through the shared backend.',
      "Products save with 100% verification — any field that didn't stick is flagged immediately.",
    ]}
  />
);

export default TilesManager;
