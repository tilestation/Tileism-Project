/**
 * UnderfloorHeatingManager — electric UFH mats/cables, thermostats, insulation boards.
 * Uses the shared ManagerPageShell.
 * URL: /admin/underfloor-heating
 */

import React from 'react';
import { Flame } from 'lucide-react';
import ManagerPageShell from './components/ManagerPageShell';

const isUFH = (p) => {
  const grp = String(p.product_group || '').toLowerCase();
  const mainCat = String(p.main_category || '').toLowerCase();
  const subCats = Array.isArray(p.sub_categories) ? p.sub_categories : [];
  if (['underfloor_heating', 'ufh'].includes(grp) || /underfloor|ufh/i.test(mainCat)) return true;
  return subCats.some(sc => /underfloor|ufh|thermostat|heating.*mat|heating.*cable/i.test(String(sc)));
};

const matchAny = (p, regex) => {
  const scs = Array.isArray(p.sub_categories) ? p.sub_categories : [];
  const name = String(p.our_product_name || p.product_name || p.name || '');
  return scs.some(sc => regex.test(String(sc))) || regex.test(name) || regex.test(String(p.type || ''));
};

const SUB_TABS = [
  { key: 'all',         label: 'All UFH',       match: () => true },
  { key: 'mat',         label: 'Heating Mats',  match: (p) => matchAny(p, /heating.*mat|floor.*mat|electric.*mat/i) },
  { key: 'cable',       label: 'Cables',        match: (p) => matchAny(p, /cable|loose wire/i) },
  { key: 'thermostat',  label: 'Thermostats',   match: (p) => matchAny(p, /thermostat|controller/i) },
  { key: 'insulation',  label: 'Insulation',    match: (p) => matchAny(p, /insulation|board|underlay/i) },
];

const COLUMNS = [
  { key: 'kit_size_m2', label: 'Coverage (m²)' },
  { key: 'voltage',     label: 'Voltage' },
  { key: 'watts_per_m2', label: 'W/m²' },
  { key: 'thermostat_included', label: 'Thermostat?' },
  { key: 'suitability', label: 'Suitability' },
];

const EDIT_FIELDS = [
  { key: 'kit_size_m2',         label: 'Coverage (m²)',      type: 'number' },
  { key: 'voltage',             label: 'Voltage',            type: 'select', options: ['230V', '110V'] },
  { key: 'watts_per_m2',        label: 'Watts / m²',         type: 'number' },
  { key: 'cable_length_m',      label: 'Cable Length (m)',   type: 'number' },
  { key: 'mat_type',            label: 'Mat / Cable Type',   type: 'select', options: ['Sticky-back mat', 'Loose wire', 'Water-based'] },
  { key: 'thermostat_included', label: 'Thermostat Included', type: 'select', options: ['Yes', 'No'] },
  { key: 'thermostat_type',     label: 'Thermostat Type',    hint: 'e.g., Touchscreen, Wi-Fi, Dial' },
  { key: 'warranty',            label: 'Warranty',           hint: 'e.g., 20 years' },
  { key: 'suitability',         label: 'Suitability',        hint: 'Under tiles / Under wood / Wet rooms' },
];

const UnderfloorHeatingManager = () => (
  <ManagerPageShell
    categoryKey="underfloor_heating"
    title="Underfloor Heating Manager"
    subtitle="Electric UFH mats & cables, thermostats, insulation"
    icon={Flame}
    theme="red"
    isMatch={isUFH}
    subTabs={SUB_TABS}
    columns={COLUMNS}
    editFields={EDIT_FIELDS}
    presetCategory="underfloor_heating"
    facetCategory="custom"
    tierPricingDefaults={{ default_unit: 'unit' }}
    bannerBullets={[
      'Search or filter for UFH products (mats, cables, thermostats, insulation).',
      'Click Edit — only UFH-relevant fields show (coverage m², voltage, W/m², thermostat).',
      'Use + Add New for a brand-new UFH kit (opens the Wizard).',
      'Publish complete kits + track warranty via the bulk actions.',
    ]}
  />
);

export default UnderfloorHeatingManager;
