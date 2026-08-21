/**
 * Formats a cart item's quantity with tile-retail context.
 *
 * Tile stores sell in multiple units (m², per piece, per box). A plain "2"
 * in the basket is confusing — customers can't tell if they've bought
 * 2 m², 2 tiles, or 2 boxes.
 *
 * Output examples:
 *   pricing_unit='m2',   quantity=2.16, sqm_per_box=0.72 → "2.16 m² · 3 boxes"
 *   pricing_unit='m2',   quantity=2,                     → "2 m²"
 *   pricing_unit='unit', quantity=4                      → "4 pcs"
 *   (no unit metadata)                                   → "2"
 */
export function formatCartQuantity(item) {
  const q = Number(item?.quantity ?? 0);
  if (!q || isNaN(q)) return '0';

  const pricingUnit = item?.pricing_unit || 'm2';

  if (pricingUnit === 'unit') {
    return `${_trim(q)} pcs`;
  }

  // m² path — show box estimate when we know boxes-per-m²
  const perBox = Number(item?.sqm_per_box) || 0;
  if (perBox > 0) {
    // Guard against floating-point imprecision:
    // 2.16 / 0.72 = 3.0000000000000004 in JS → ceil would give 4. Subtract a
    // tiny epsilon before ceil so exact multiples stay exact.
    const boxes = Math.ceil((q / perBox) - 1e-9);
    return `${_trim(q)} m² · ${boxes} box${boxes === 1 ? '' : 'es'}`;
  }

  return `${_trim(q)} m²`;
}

/** Short label for the stepper (tight inline spaces). */
export function formatCartQuantityShort(item) {
  const q = Number(item?.quantity ?? 0);
  if (!q || isNaN(q)) return '0';
  const pricingUnit = item?.pricing_unit || 'm2';
  if (pricingUnit === 'unit') return `${_trim(q)} pcs`;
  return `${_trim(q)} m²`;
}

// Strip trailing zeros and the decimal point if whole (2.00 → 2, 2.16 → 2.16)
function _trim(n) {
  const f = Number(n).toFixed(2);
  return f.replace(/\.?0+$/, '');
}


/**
 * Returns the quantity step size for +/- buttons, in the item's unit.
 *   m² tile with sqm_per_box → step by sqm_per_box (one box's worth)
 *   per-unit product → step by 1
 *   legacy / no metadata → step by 1
 */
export function getCartStepSize(item) {
  const pricingUnit = item?.pricing_unit || 'm2';
  if (pricingUnit === 'unit') return 1;
  const perBox = Number(item?.sqm_per_box) || 0;
  return perBox > 0 ? perBox : 1;
}

/**
 * Computes the next valid quantity given a delta (+1/-1 click or raw typed value).
 *   - Clamps to >=step (never zero, remove button does that job separately)
 *   - Rounds to the nearest whole step (so 2.87 → 2.88 for 0.72/box, i.e. 4 boxes)
 *   - Handles float-imprecision exact multiples (2.16/0.72 computes cleanly)
 */
export function snapCartQuantity(item, newQuantity) {
  const step = getCartStepSize(item);
  const min = getCartMinQuantity(item);
  let snapped;
  if (step <= 0) {
    snapped = Math.max(1, Math.round(Number(newQuantity) || 0));
  } else {
    const q = Number(newQuantity) || 0;
    // Round to nearest step multiple (never below one step)
    snapped = q <= step ? round2(step) : round2(Math.round(q / step) * step);
  }
  return min > 0 ? Math.max(round2(min), snapped) : snapped;
}

/**
 * Minimum quantity for a cart line. Pallet-rate lines (half/full pallet)
 * can never drop below the pallet quantity captured at add time — otherwise
 * the pallet price would apply to a sub-pallet quantity.
 */
export function getCartMinQuantity(item) {
  if (item?.pallet_tier) {
    const m = Number(item.pallet_min_qty) || 0;
    if (m > 0) return m;
  }
  return 0;
}

// Round to 2 decimal places (avoids 2.8800000000000003)
function round2(n) {
  return Math.round(n * 100) / 100;
}


/**
 * Detects a "just below the next tier" upsell opportunity.
 *
 * Returns null when:
 *   - Item has no tier config, or tiers are disabled
 *   - Per-unit product (tiers are m²-only in this store)
 *   - Already at the top tier
 *   - Next tier is >2 boxes away (gap too big to nudge for)
 *   - Savings would be trivial (<£2)
 *
 * Otherwise returns:
 *   {
 *     boxesNeeded: 1,                   // how many boxes to add
 *     sqmNeeded: 0.72,                  // how many m² that is
 *     newQuantity: 10.08,               // target quantity
 *     nextDiscountPercent: 10,          // tier discount at target
 *     currentDiscountPercent: 5,        // tier discount right now
 *     savingsOnOrder: 3.24,             // £ saved on the whole line
 *   }
 */
export function getTierUpsell(item) {
  if (!item) return null;
  if (item.tier_pricing_disabled) return null;
  if ((item.pricing_unit || 'm2') !== 'm2') return null;

  const thresholds = item.tier_thresholds;
  const discounts = item.tier_discounts;
  if (!Array.isArray(thresholds) || !Array.isArray(discounts)) return null;
  if (thresholds.length === 0 || discounts.length < 2) return null;

  const q = Number(item.quantity) || 0;
  const sqmPerBox = Number(item.sqm_per_box) || 0;
  if (sqmPerBox <= 0) return null;

  // Find next threshold above current quantity
  const nextIdx = thresholds.findIndex(t => q < t);
  if (nextIdx < 0) return null; // already at top tier

  const nextThreshold = thresholds[nextIdx];
  const sqmNeeded = round2(nextThreshold - q);
  if (sqmNeeded <= 0) return null;

  const boxesNeeded = Math.ceil((sqmNeeded - 1e-9) / sqmPerBox);
  if (boxesNeeded <= 0 || boxesNeeded > 2) return null; // only nudge within 2 boxes

  // Determine current tier discount (discount at index matching current tier)
  // discounts[0] = tier 1 (0 → thresholds[0]), discounts[1] = tier 2, etc.
  // Current tier index is the number of thresholds crossed, capped at len(discounts)-1
  let currentTierIdx = 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (q >= thresholds[i]) currentTierIdx = i + 1;
  }
  currentTierIdx = Math.min(currentTierIdx, discounts.length - 1);
  const nextTierIdx = Math.min(nextIdx + 1, discounts.length - 1);

  const currentDiscount = Number(discounts[currentTierIdx]) || 0;
  const nextDiscount = Number(discounts[nextTierIdx]) || 0;
  if (nextDiscount <= currentDiscount) return null; // no actual improvement

  // Exact # of boxes to step → exact target quantity (box-snapped)
  const targetQty = round2(q + boxesNeeded * sqmPerBox);
  const basePrice = Number(item.list_price || item.was_price || item.price) || 0;
  const pricePerM2 = basePrice;
  if (pricePerM2 <= 0) return null;

  // Savings = quantity * (price * (current - next)%)
  const savingsOnOrder = round2(
    targetQty * pricePerM2 * (nextDiscount - currentDiscount) / 100
  );
  if (savingsOnOrder < 2) return null; // too small to bother

  return {
    boxesNeeded,
    sqmNeeded: round2(boxesNeeded * sqmPerBox),
    newQuantity: targetQty,
    nextDiscountPercent: nextDiscount,
    currentDiscountPercent: currentDiscount,
    savingsOnOrder,
  };
}
