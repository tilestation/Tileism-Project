/**
 * ToolsManager — cutters, trowels, spacers, mixers, levellers, cleaning tools.
 * Uses the shared ManagerPageShell.
 * URL: /admin/tools
 */

import React from 'react';
import { Wrench } from 'lucide-react';
import ManagerPageShell from './components/ManagerPageShell';

const isTools = (p) => {
  const grp = String(p.product_group || '').toLowerCase();
  const mainCat = String(p.main_category || '').toLowerCase();
  const subCats = Array.isArray(p.sub_categories) ? p.sub_categories : [];
  if (grp === 'tools' || /tools|accessor/i.test(mainCat)) return true;
  return subCats.some(sc => /tool|cutter|trowel|spacer|leveller|mixer|bucket|sponge|scraper/i.test(String(sc)));
};

const matchAny = (p, regex) => {
  const scs = Array.isArray(p.sub_categories) ? p.sub_categories : [];
  const name = String(p.our_product_name || p.product_name || p.name || '');
  return scs.some(sc => regex.test(String(sc))) || regex.test(name) || regex.test(String(p.type || ''));
};

const SUB_TABS = [
  { key: 'all',       label: 'All Tools',    match: () => true },
  { key: 'cutter',    label: 'Cutters',      match: (p) => matchAny(p, /cutter|blade|saw|nipper/i) },
  { key: 'trowel',    label: 'Trowels',      match: (p) => matchAny(p, /trowel|float/i) },
  { key: 'spacer',    label: 'Spacers & Levellers', match: (p) => matchAny(p, /spacer|leveller|wedge|clip/i) },
  { key: 'mixer',     label: 'Mixers & Buckets',    match: (p) => matchAny(p, /mixer|bucket|paddle/i) },
  { key: 'clean',     label: 'Cleaning',    match: (p) => matchAny(p, /sponge|scraper|cloth|brush|rag/i) },
  { key: 'other',     label: 'Other',       match: (p) => !matchAny(p, /cutter|blade|saw|nipper|trowel|float|spacer|leveller|wedge|clip|mixer|bucket|paddle|sponge|scraper|cloth|brush|rag/i) },
];

const COLUMNS = [
  { key: 'brand',      label: 'Brand' },
  { key: 'model',      label: 'Model' },
  { key: 'material',   label: 'Material' },
  { key: 'dimensions', label: 'Size' },
  { key: 'suitability', label: 'Use With' },
];

const EDIT_FIELDS = [
  { key: 'brand',        label: 'Brand' },
  { key: 'model',        label: 'Model' },
  { key: 'material',     label: 'Material',        hint: 'Stainless steel, Rubber, Plastic, Diamond' },
  { key: 'dimensions',   label: 'Size / Dimensions', hint: 'e.g., 20cm, 8mm blade' },
  { key: 'capacity',     label: 'Capacity',        hint: 'e.g., 15L bucket, 2mm spacer' },
  { key: 'suitability',  label: 'Use With',        hint: 'Tile / Grout / Adhesive / Sealant' },
  { key: 'pack_qty',     label: 'Pack Quantity',   type: 'number' },
  { key: 'warranty',     label: 'Warranty' },
];

const ToolsManager = () => (
  <ManagerPageShell
    categoryKey="tools"
    title="Tools Manager"
    subtitle="Cutters, trowels, spacers, mixers, cleaning tools"
    icon={Wrench}
    theme="slate"
    isMatch={isTools}
    subTabs={SUB_TABS}
    columns={COLUMNS}
    editFields={EDIT_FIELDS}
    presetCategory="tools"
    facetCategory="custom"
    tierPricingDefaults={{ default_unit: 'unit' }}
    bannerBullets={[
      'Search or filter for tools (cutters, trowels, spacers, mixers, cleaning).',
      'Click Edit — only tools-relevant fields show (brand, size, capacity, use with).',
      'Use + Add New for a brand-new tool (opens the Wizard).',
      'Sub-tabs auto-group by purpose so pricing is quicker across a batch.',
    ]}
  />
);

export default ToolsManager;
