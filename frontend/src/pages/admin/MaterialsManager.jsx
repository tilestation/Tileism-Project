/**
 * MaterialsManager — adhesives, grouts, sealants, cleaning products, primers.
 *
 * Now a thin wrapper around ManagerPageShell. All bulk operations, filters,
 * edit modal, drafts, config, presets, CSV import, tier pricing and colour
 * assignment live inside the shared shell.
 *
 * URL: /admin/materials
 * Fields shown per product (material-specific): Bag Weight, Coverage,
 * Setting Time, Pot Life, Application Thickness, VOC, Bag Colour + Colour.
 */

import React from 'react';
import { Package } from 'lucide-react';
import { Badge } from '../../components/ui/badge';
import ManagerPageShell from './components/ManagerPageShell';

const MATERIAL_SUBCATS = [
  'adhesive', 'adhesives', 'flexible adhesive', 'rapid adhesive',
  'grout', 'grouts', 'wall grout', 'floor grout', 'epoxy grout',
  'sealant', 'sealants', 'silicone',
  'cleaning', 'cleaner', 'cleaning & maintenance',
  'primer', 'primers',
  'levelling compound', 'self-levelling',
];

const MATERIAL_SUB_TABS = [
  { key: 'all',        label: 'All Materials', match: () => true },
  { key: 'adhesives',  label: 'Adhesives',
    match: (p) => (p.sub_categories || []).some(s => /adhesive|primer/i.test(String(s))) },
  { key: 'grouts',     label: 'Grouts',
    match: (p) => (p.sub_categories || []).some(s => /grout/i.test(String(s))) },
  { key: 'sealants',   label: 'Sealants',
    match: (p) => (p.sub_categories || []).some(s => /sealant|silicone/i.test(String(s))) },
  { key: 'cleaning',   label: 'Cleaning',
    match: (p) => (p.sub_categories || []).some(s => /clean/i.test(String(s))) },
  { key: 'other',      label: 'Other',
    match: (p) => (p.sub_categories || []).some(s => /levelling|primer|underlay/i.test(String(s))) },
];

const isMaterial = (p) => {
  const group = String(p.product_group || '').toLowerCase();
  const mainCat = String(p.main_category || '').toLowerCase();
  const subCats = Array.isArray(p.sub_categories) ? p.sub_categories : [];
  if (group === 'materials' || mainCat === 'materials') return true;
  return subCats.some(sc => MATERIAL_SUBCATS.some(m => String(sc).toLowerCase().includes(m)));
};

const MaterialsManager = () => (
  <ManagerPageShell
    categoryKey="materials"
    title="Materials Manager"
    subtitle="Adhesives, grouts, sealants, cleaning & primers"
    icon={Package}
    theme="orange"
    isMatch={isMaterial}
    subTabs={MATERIAL_SUB_TABS}
    facetCategory="materials"
    columns={[
      { key: 'color',      label: 'Colour',   render: (p) => p.color || (Array.isArray(p.colors) && p.colors[0]) || '—' },
      { key: 'coverage',   label: 'Coverage', render: (p) => {
        const v = p.coverage_m2_per_bag ?? p.coverage;
        return v ? `${v} m²` : '—';
      } },
      { key: 'bag_weight', label: 'Bag Wt.',  render: (p) => {
        const v = p.bag_weight_kg ?? p.bag_weight;
        return v ? `${v} kg` : '—';
      } },
      { key: 'setting_time', label: 'Setting', render: (p) => {
        const v = p.setting_time_hours ?? p.setting_time;
        return v ? `${v} h` : '—';
      } },
      { key: 'suitability', label: 'Suitability' },
      { key: 'sub_categories', label: 'Sub-cat', render: (p) => {
        const scs = (p.sub_categories || []).filter(sc =>
          MATERIAL_SUBCATS.some(m => String(sc).toLowerCase().includes(m))
        );
        if (scs.length === 0) return '—';
        return (
          <div className="flex flex-wrap gap-0.5">
            {scs.slice(0, 2).map((sc, i) => <Badge key={i} variant="outline" className="text-[10px] py-0 px-1">{sc}</Badge>)}
            {scs.length > 2 && <span className="text-gray-400">+{scs.length - 2}</span>}
          </div>
        );
      } },
    ]}
    editFields={[
      { key: 'color',                    label: 'Colour',                     hint: 'e.g. Grey / White / Beige' },
      { key: 'bag_colour',               label: 'Bag Colour',                 hint: 'Pink / Red / Green (for identification)' },
      { key: 'bag_weight_kg',            label: 'Bag Weight (kg)',            type: 'number' },
      { key: 'coverage_m2_per_bag',      label: 'Coverage (m² per bag)',      type: 'number' },
      { key: 'setting_time_hours',       label: 'Setting Time (hours)',       type: 'number' },
      { key: 'pot_life_minutes',         label: 'Pot Life (minutes)',         type: 'number' },
      { key: 'application_thickness_mm', label: 'Application Thickness (mm)', hint: 'e.g. 3-15 or 6' },
      { key: 'voc_rating',               label: 'VOC Rating',                 hint: 'e.g. Low, EC1 Plus' },
      { key: 'suitability',              label: 'Suitability',                hint: 'Indoor / Outdoor / Wet room / Underfloor heating' },
    ]}
    presetCategory="materials"
    tierPricingDefaults={{ default_unit: 'unit', trade_discount_default: 2, trade_discount_type: 'fixed' }}
    bannerBullets={[
      'Search or filter to find a material (Adhesives, Grouts, Sealants, Cleaning).',
      'Click Edit on a row to change fields — only material-relevant ones show.',
      'Use + Add New Material for a brand-new product (opens the 3-step Wizard).',
      'Tier pricing, publish, stock & refund flows still work through the shared backend.',
      "Products save with 100% verification — any field that didn't stick is flagged immediately.",
    ]}
  />
);

export default MaterialsManager;
