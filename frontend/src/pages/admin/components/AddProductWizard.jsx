/**
 * AddProductWizard — category-aware step-by-step "Add New Product" modal.
 *
 * Layer 3 of the product-management redesign (see PRD Aug 3 entry):
 *   Layer 1 — Unified backend (supplier_products / tiles / products)
 *   Layer 2 — Category Managers (/admin/materials, /admin/tiles, …)
 *   Layer 3 — Add Product Wizard  ← this component
 *
 * Steps:
 *   1. Category picker (skipped when opened from a Manager with presetCategory)
 *   2. Product basics (name, supplier, SKU, cost, price, photos)
 *   3. Category-specific fields (only fields relevant to the chosen category)
 *   4. Review + Save
 *
 * Save path: POST /api/supplier-sync/products/create — the "wizard" server
 * endpoint that upserts to supplier_products with all the fields the admin
 * filled in, then leaves the product in draft state until an admin explicitly
 * publishes it via the existing publish flow.
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../../../components/ui/dialog';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';
import {
  Package, Layers, Square, Bath, Flame, Wrench,
  ArrowRight, ArrowLeft, Check, X, Save, RefreshCw, Plus, AlertCircle,
} from 'lucide-react';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Category catalogue. `pricing_unit` sets a smart default so downstream views
// (tier pricing modal, storefront pallet selector) render with the right labels.
const CATEGORIES = [
  {
    key: 'tiles', label: 'Tiles',
    description: 'Wall & floor tiles, mosaics, borders',
    icon: Square, color: 'bg-blue-500', pricing_unit: 'm2',
    product_group: 'tiles', main_category: 'Tiles',
  },
  {
    key: 'materials', label: 'Materials',
    description: 'Adhesives, grouts, sealants, cleaning',
    icon: Package, color: 'bg-orange-500', pricing_unit: 'unit',
    product_group: 'materials', main_category: 'Materials',
  },
  {
    key: 'flooring', label: 'Flooring',
    description: 'LVT, laminate, engineered wood, vinyl',
    icon: Layers, color: 'bg-emerald-500', pricing_unit: 'm2',
    product_group: 'flooring', main_category: 'Flooring',
  },
  {
    key: 'bathroom', label: 'Bathroom',
    description: 'Toilets, basins, baths, showers, taps',
    icon: Bath, color: 'bg-cyan-500', pricing_unit: 'unit',
    product_group: 'bathroom', main_category: 'Bathroom',
  },
  {
    key: 'underfloor_heating', label: 'Underfloor Heating',
    description: 'Electric UFH kits, thermostats, insulation',
    icon: Flame, color: 'bg-red-500', pricing_unit: 'unit',
    product_group: 'underfloor_heating', main_category: 'Underfloor Heating',
  },
  {
    key: 'tools', label: 'Tools & Accessories',
    description: 'Cutters, trowels, spacers, levellers',
    icon: Wrench, color: 'bg-slate-600', pricing_unit: 'unit',
    product_group: 'tools', main_category: 'Tools',
  },
];

// Category-specific field sets. Each returns a list of {name, label, type, hint?, options?}.
const FIELD_SETS = {
  tiles: [
    { name: 'size', label: 'Size', hint: 'e.g., 600x600, 300x600, 60x60cm' },
    { name: 'thickness', label: 'Thickness', hint: 'e.g., 10mm' },
    { name: 'material', label: 'Material', options: ['Porcelain', 'Ceramic', 'Natural Stone', 'Glass', 'Mosaic'] },
    { name: 'finish', label: 'Finish', options: ['Matt', 'Polished', 'Satin', 'Textured', 'Semi-polished', 'Rustic'] },
    { name: 'slip_rating', label: 'Slip Rating', options: ['R9', 'R10', 'R11', 'R12', 'R13'] },
    { name: 'edge', label: 'Edge', options: ['Rectified', 'Non-rectified', 'Bevelled'] },
    { name: 'type', label: 'Tile Type', options: ['Floor Tile', 'Wall Tile', 'Floor & Wall', 'Mosaic', 'Feature', 'Border'] },
    { name: 'color', label: 'Colour', hint: 'e.g., Grey, White, Beige' },
    { name: 'suitability', label: 'Suitability', hint: 'e.g., Indoor / Outdoor / Wet Area' },
    { name: 'made_in', label: 'Made In', hint: 'Country of origin' },
  ],
  materials: [
    { name: 'bag_weight_kg', label: 'Bag Weight (kg)', type: 'number', step: '0.5' },
    { name: 'coverage_m2_per_bag', label: 'Coverage (m²/bag)', type: 'number', step: '0.1' },
    { name: 'setting_time_hours', label: 'Setting Time (hours)', type: 'number', step: '0.5' },
    { name: 'pot_life_minutes', label: 'Pot Life (minutes)', type: 'number' },
    { name: 'application_thickness_mm', label: 'Application Thickness (mm)', hint: 'e.g., 3-15 or 6' },
    { name: 'voc_rating', label: 'VOC Rating', hint: 'e.g., Low, EC1 Plus' },
    { name: 'color', label: 'Colour', hint: 'e.g., Grey, White, Beige' },
    { name: 'bag_colour', label: 'Bag Colour', hint: 'Pink / Red / Green (identification)' },
    { name: 'suitability', label: 'Suitability', hint: 'Indoor / Outdoor / Wet room / UFH' },
  ],
  flooring: [
    { name: 'plank_length_mm', label: 'Plank Length (mm)', type: 'number' },
    { name: 'plank_width_mm', label: 'Plank Width (mm)', type: 'number' },
    { name: 'plank_thickness_mm', label: 'Plank Thickness (mm)', type: 'number', step: '0.1' },
    { name: 'wear_layer_mm', label: 'Wear Layer (mm)', type: 'number', step: '0.1' },
    { name: 'click_system', label: 'Click System', hint: 'e.g., 5G, Uniclic, Angle-Angle' },
    { name: 'material', label: 'Material', options: ['LVT', 'Laminate', 'Engineered Wood', 'Vinyl', 'Solid Wood', 'SPC'] },
    { name: 'finish', label: 'Finish', options: ['Matt', 'Satin', 'Lacquered', 'Oiled', 'Brushed', 'Embossed'] },
    { name: 'waterproof', label: '100% Waterproof?', type: 'select', options: ['Yes', 'No', 'Water-resistant'] },
    { name: 'color', label: 'Colour', hint: 'e.g., Oak, Grey, Walnut' },
    { name: 'made_in', label: 'Made In' },
  ],
  bathroom: [
    { name: 'brand', label: 'Brand' },
    { name: 'model', label: 'Model' },
    { name: 'dimensions', label: 'Dimensions (W × H × D)', hint: 'e.g., 600×800×400 mm' },
    { name: 'flush_type', label: 'Flush Type', hint: 'e.g., Dual-flush, Rimless, Wall-hung' },
    { name: 'tank_capacity', label: 'Tank Capacity (L)', type: 'number', step: '0.1' },
    { name: 'material', label: 'Material', options: ['Ceramic', 'Vitreous China', 'Steel', 'Acrylic', 'Stone Resin'] },
    { name: 'color', label: 'Colour', hint: 'e.g., White, Matt Black, Chrome' },
    { name: 'warranty', label: 'Warranty', hint: 'e.g., 10 years' },
    { name: 'suitability', label: 'Suitability' },
  ],
  underfloor_heating: [
    { name: 'kit_size_m2', label: 'Kit Size (m²)', type: 'number', step: '0.5' },
    { name: 'voltage', label: 'Voltage', options: ['230V', '110V'] },
    { name: 'thermostat_included', label: 'Thermostat Included?', type: 'select', options: ['Yes', 'No'] },
    { name: 'warranty', label: 'Warranty', hint: 'e.g., 20 years' },
    { name: 'suitability', label: 'Suitability', hint: 'e.g., Under tiles, Under wood, Wet rooms' },
  ],
  tools: [
    { name: 'brand', label: 'Brand' },
    { name: 'model', label: 'Model' },
    { name: 'material', label: 'Material', hint: 'e.g., Stainless steel, Rubber, Plastic' },
    { name: 'dimensions', label: 'Dimensions' },
    { name: 'suitability', label: 'Use With', hint: 'e.g., Tile / Grout / Adhesive / Sealant' },
    { name: 'warranty', label: 'Warranty' },
  ],
};

const UNIVERSAL_FIELDS = [
  { name: 'product_name', label: 'Product Name', required: true },
  { name: 'supplier', label: 'Supplier', required: true },
  { name: 'sku', label: 'SKU', required: true, hint: 'Must be unique per supplier' },
  { name: 'list_price', label: 'List Price (£)', type: 'number', step: '0.01', required: true },
  { name: 'cost_price', label: 'Cost Price (£)', type: 'number', step: '0.01', hint: 'Optional but recommended for margin tracking' },
  { name: 'description', label: 'Short Description', type: 'textarea' },
];

const AddProductWizard = ({ open, onOpenChange, presetCategory = null, onSuccess }) => {
  const [step, setStep] = useState(presetCategory ? 2 : 1);
  const [categoryKey, setCategoryKey] = useState(presetCategory);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);

  // Reset when reopened
  useEffect(() => {
    if (open) {
      setStep(presetCategory ? 2 : 1);
      setCategoryKey(presetCategory);
      setForm({});
    }
  }, [open, presetCategory]);

  const category = useMemo(() => CATEGORIES.find(c => c.key === categoryKey), [categoryKey]);
  const categoryFields = useMemo(() => (category ? FIELD_SETS[category.key] || [] : []), [category]);

  const setField = useCallback((name, value) => {
    setForm(prev => ({ ...prev, [name]: value }));
  }, []);

  const universalMissing = useMemo(() => {
    return UNIVERSAL_FIELDS.filter(f => f.required && (!form[f.name] || String(form[f.name]).trim() === '')).map(f => f.label);
  }, [form]);

  const canGoStep3 = universalMissing.length === 0;

  const handleSave = async () => {
    if (!category || universalMissing.length > 0) {
      toast.error(`Fill in required fields: ${universalMissing.join(', ')}`);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        product_group: category.product_group,
        main_category: category.main_category,
        pricing_unit: category.pricing_unit,
        // Trim strings & coerce numeric fields
        list_price: form.list_price ? Number(form.list_price) : undefined,
        cost_price: form.cost_price ? Number(form.cost_price) : undefined,
      };
      // Remove empty/null values so backend defaults kick in
      Object.keys(payload).forEach(k => {
        if (payload[k] === '' || payload[k] === null || payload[k] === undefined) delete payload[k];
      });

      const res = await fetch(`${API_URL}/api/supplier-sync/products/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.status === 409) {
        const err = await res.json();
        toast.error(err.detail || 'This SKU already exists for that supplier — use the edit flow instead.');
        setSaving(false);
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      toast.success(`Created ${data.product_name || data.sku} — draft mode. Publish when ready.`);
      onOpenChange(false);
      if (onSuccess) onSuccess(data);
    } catch (err) {
      console.error('AddProductWizard save failed', err);
      toast.error(`Failed to create product: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[92vh] overflow-y-auto" data-testid="add-product-wizard">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="w-5 h-5 text-orange-600" />
            Add New Product
            {category && (
              <Badge variant="outline" className={`ml-2 text-xs ${category.color} text-white border-0`}>
                {category.label}
              </Badge>
            )}
          </DialogTitle>
          <p className="text-xs text-gray-500">
            {step === 1 && 'Step 1 of 3 — Pick the category'}
            {step === 2 && `Step 2 of 3 — Product basics`}
            {step === 3 && `Step 3 of 3 — ${category?.label} specifics`}
          </p>
        </DialogHeader>

        {/* Progress dots */}
        <div className="flex items-center gap-2 py-2">
          {[1, 2, 3].map(n => (
            <div key={n} className="flex-1 flex items-center gap-2">
              <div className={`h-1.5 flex-1 rounded-full ${step >= n ? 'bg-orange-500' : 'bg-gray-200'}`} />
              {n < 3 && <div className={`w-2 h-2 rounded-full ${step > n ? 'bg-orange-500' : 'bg-gray-200'}`} />}
            </div>
          ))}
        </div>

        {/* STEP 1: Category picker */}
        {step === 1 && (
          <div className="py-2">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {CATEGORIES.map(cat => {
                const Icon = cat.icon;
                const selected = categoryKey === cat.key;
                return (
                  <button
                    key={cat.key}
                    onClick={() => setCategoryKey(cat.key)}
                    className={`text-left border-2 rounded-lg p-4 transition ${
                      selected ? 'border-orange-500 bg-orange-50 ring-2 ring-orange-200' : 'border-gray-200 hover:border-gray-300 bg-white'
                    }`}
                    data-testid={`wizard-cat-${cat.key}`}
                  >
                    <div className={`w-10 h-10 rounded-lg ${cat.color} text-white flex items-center justify-center mb-2`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="font-medium text-sm text-gray-900">{cat.label}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{cat.description}</div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* STEP 2: Universal fields */}
        {step === 2 && (
          <div className="py-2 space-y-3">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 text-xs text-blue-800 flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>These 6 fields are the same for every product type. Required fields are marked with *.</span>
            </div>
            {UNIVERSAL_FIELDS.map(f => (
              <WizardField key={f.name} field={f} value={form[f.name] || ''} onChange={(v) => setField(f.name, v)} />
            ))}
            {universalMissing.length > 0 && (
              <div className="text-xs text-amber-600 flex items-center gap-1">
                <AlertCircle className="w-3 h-3" />
                Missing: {universalMissing.join(', ')}
              </div>
            )}
          </div>
        )}

        {/* STEP 3: Category-specific fields */}
        {step === 3 && category && (
          <div className="py-2 space-y-3">
            <div className={`${category.color} text-white rounded-lg p-3 flex items-center gap-2`}>
              <category.icon className="w-4 h-4" />
              <span className="text-sm font-medium">{category.label} specifics</span>
              <span className="text-xs opacity-80 ml-auto">All optional — you can fill later from the Manager</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {categoryFields.map(f => (
                <WizardField key={f.name} field={f} value={form[f.name] || ''} onChange={(v) => setField(f.name, v)} />
              ))}
            </div>
            <div className="text-xs text-gray-500 mt-3">
              <strong>What happens next:</strong> The product is created in <em>draft</em> state. Tier pricing, images and additional attributes can be set from the {category.label} Manager. Nothing is published to the storefront until you explicitly publish it.
            </div>
          </div>
        )}

        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <div className="flex gap-2">
            {step > 1 && !presetCategory && (
              <Button variant="outline" onClick={() => setStep(s => s - 1)} disabled={saving} data-testid="wizard-back">
                <ArrowLeft className="w-4 h-4 mr-1" /> Back
              </Button>
            )}
            {step > 1 && presetCategory && step > 2 && (
              <Button variant="outline" onClick={() => setStep(s => s - 1)} disabled={saving} data-testid="wizard-back">
                <ArrowLeft className="w-4 h-4 mr-1" /> Back
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
              <X className="w-4 h-4 mr-1" /> Cancel
            </Button>
            {step === 1 && (
              <Button
                onClick={() => setStep(2)}
                disabled={!categoryKey}
                className="bg-orange-600 hover:bg-orange-700 text-white"
                data-testid="wizard-next-to-basics"
              >
                Next <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            )}
            {step === 2 && (
              <Button
                onClick={() => setStep(3)}
                disabled={!canGoStep3}
                className="bg-orange-600 hover:bg-orange-700 text-white"
                data-testid="wizard-next-to-specifics"
              >
                Next <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            )}
            {step === 3 && (
              <Button
                onClick={handleSave}
                disabled={saving}
                className="bg-orange-600 hover:bg-orange-700 text-white"
                data-testid="wizard-save"
              >
                {saving ? <RefreshCw className="w-4 h-4 mr-1 animate-spin" /> : <Save className="w-4 h-4 mr-1" />}
                Create Product
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const WizardField = ({ field, value, onChange }) => {
  const { name, label, type = 'text', hint, options, step, required } = field;
  const Field = (
    options && !type.includes('select') ? (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-orange-500 focus:border-transparent"
        data-testid={`wizard-field-${name}`}
      >
        <option value="">— select —</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    ) : type === 'select' ? (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-orange-500 focus:border-transparent"
        data-testid={`wizard-field-${name}`}
      >
        <option value="">— select —</option>
        {(options || []).map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    ) : type === 'textarea' ? (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-orange-500 focus:border-transparent"
        data-testid={`wizard-field-${name}`}
      />
    ) : (
      <Input
        type={type}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`wizard-field-${name}`}
      />
    )
  );
  return (
    <div>
      <label className="block text-xs font-medium text-gray-700 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {Field}
      {hint && <p className="text-[11px] text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
};

export default AddProductWizard;
