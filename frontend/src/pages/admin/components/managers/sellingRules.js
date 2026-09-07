/**
 * sellingRules — shared helpers for the two "how can this item be bought / shipped"
 * rules that are set PER PRODUCT:
 *   ▸ Pallets   — Half + Full pallet qty & £ rate, "Pallet only" (no single m² / units)
 *   ▸ Delivery  — mandatory delivery charge £ (never free) and parcel shipping
 * Used by the Pricing hub table (many products) and the Quick Edit card (one product).
 * Pallet fields save via bulk-tier-update, delivery via bulk-delivery-settings —
 * both accept per-row values and mirror to the live tiles.
 */
const API_URL = process.env.REACT_APP_BACKEND_URL;

export const PALLET_FIELDS = ['pallet_enabled', 'pallet_qty_unit', 'm2_per_pallet', 'pallet_price', 'm2_per_half_pallet', 'half_pallet_price', 'pallet_only'];
export const DELIVERY_FIELDS = ['delivery_charge_required', 'delivery_charge', 'parcel_delivery', 'parcel_fee'];
export const RULE_FIELDS = [...PALLET_FIELDS, ...DELIVERY_FIELDS];

export const ruleKey = (p) => `${p.supplier || ''}|||${p.sku || p.supplier_code || ''}`;

const numOrBlank = (v) => (v === null || v === undefined || v === '' || Number(v) === 0 ? '' : String(v));
const num = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));

export const rowFromProduct = (p, defaultUnit = 'm2') => ({
  pallet_enabled: !!p.pallet_enabled,
  pallet_qty_unit: p.pallet_qty_unit || (p.pricing_unit === 'unit' ? 'unit' : defaultUnit),
  m2_per_pallet: numOrBlank(p.m2_per_pallet),
  pallet_price: numOrBlank(p.pallet_price),
  m2_per_half_pallet: numOrBlank(p.m2_per_half_pallet),
  half_pallet_price: numOrBlank(p.half_pallet_price),
  pallet_only: !!(p.pallet_enabled && p.pallet_only),
  delivery_charge_required: !!p.delivery_charge_required,
  delivery_charge: numOrBlank(p.delivery_charge),
  parcel_delivery: !!p.parcel_delivery,
  parcel_fee: numOrBlank(p.parcel_fee),
});

// Apply one field edit with the dependent-toggle rules (pallet off ⇒ pallet-only off, etc.)
export const applyRuleField = (row, field, value) => {
  const next = { ...row, [field]: value };
  if (field === 'pallet_enabled' && !value) next.pallet_only = false;
  if (field === 'pallet_only' && value) next.pallet_enabled = true;
  if (field === 'delivery_charge_required' && !value) next.delivery_charge = '';
  if (field === 'parcel_delivery' && !value) next.parcel_fee = '';
  return next;
};

const pick = (row, fields) => JSON.stringify(fields.map(f => row[f]));
export const palletChanged = (row, seed) => pick(row, PALLET_FIELDS) !== pick(seed, PALLET_FIELDS);
export const deliveryChanged = (row, seed) => pick(row, DELIVERY_FIELDS) !== pick(seed, DELIVERY_FIELDS);
export const rulesChanged = (row, seed) => palletChanged(row, seed) || deliveryChanged(row, seed);

export const validateRules = (row, label) => {
  if (row.pallet_enabled && (!(Number(row.m2_per_pallet) > 0) || !(Number(row.pallet_price) > 0))) {
    return `${label}: pallet is on — enter the full pallet quantity and £ rate (or turn the pallet off)`;
  }
  if (row.delivery_charge_required && !(Number(row.delivery_charge) > 0)) {
    return `${label}: enter the mandatory delivery charge (£) or untick it`;
  }
  return null;
};

export const palletPayload = (p, row) => {
  const base = { supplier: p.supplier, sku: p.sku || p.supplier_code };
  if (!row.pallet_enabled) return { ...base, pallet_enabled: false };
  const out = { ...base, pallet_enabled: true, pallet_qty_unit: row.pallet_qty_unit, pallet_only: !!row.pallet_only };
  ['m2_per_pallet', 'pallet_price', 'm2_per_half_pallet', 'half_pallet_price'].forEach(f => {
    const v = num(row[f]);
    if (v !== undefined) out[f] = v;
  });
  return out;
};

export const deliveryPayload = (p, row) => ({
  supplier: p.supplier,
  sku: p.sku || p.supplier_code,
  delivery_charge_required: !!row.delivery_charge_required,
  ...(row.delivery_charge_required ? { delivery_charge: Number(row.delivery_charge) } : {}),
  parcel_delivery: !!row.parcel_delivery,
  ...(row.parcel_delivery ? { parcel_fee: row.parcel_fee === '' ? 0 : Number(row.parcel_fee) } : {}),
});

const put = async (path, body) => {
  const res = await fetch(`${API_URL}/api/supplier-sync/products/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// Saves pallet rows (bulk-tier-update, per-row) and delivery rows (bulk-delivery-settings, per-row).
export const saveSellingRules = async ({ palletProducts = [], deliveryProducts = [] }) => {
  const out = { pallet: 0, delivery: 0 };
  if (palletProducts.length) out.pallet = (await put('bulk-tier-update', { products: palletProducts })).updated_count || 0;
  if (deliveryProducts.length) out.delivery = (await put('bulk-delivery-settings', { products: deliveryProducts })).updated_count || 0;
  return out;
};
