/**
 * Single source of truth for converting a cart item's stored canonical price
 * (retail inc-VAT) into the price we should DISPLAY for the current viewer.
 *
 * Why this exists: an item added to the cart while logged-out is stored as a
 * retail inc-VAT price; if the user then logs in as a trade customer we must
 * re-derive an ex-VAT trade price live, otherwise the cart shows a stale
 * retail figure relabelled "ex. VAT" and adds 20% on top — overcharging.
 *
 * Order of preference:
 *  1. item.retail_price_inc_vat   (canonical, written by addToCart)
 *  2. inferred from item.price + item.isTrade flag (legacy cart contents)
 *  3. item.price (last-ditch fallback — best effort)
 */

/**
 * Resolve the canonical retail inc-VAT price for a cart item, even for
 * legacy items written before retail_price_inc_vat was tracked.
 */
export function getRetailIncVat(item, fallbackTradeDiscount = 0) {
  if (!item) return 0;
  if (typeof item.retail_price_inc_vat === 'number' && !isNaN(item.retail_price_inc_vat)) {
    return item.retail_price_inc_vat;
  }
  const price = typeof item.price === 'number' && !isNaN(item.price) ? item.price : 0;
  // Legacy: item was added by a trade user — item.price is trade ex-VAT.
  if (item.isTrade) {
    const td = Number(item.trade_discount || fallbackTradeDiscount) || 0;
    if (td > 0 && td < 100) {
      return Math.round((price * 1.20 / (1 - td / 100)) * 100) / 100;
    }
    return Math.round(price * 1.20 * 100) / 100;
  }
  // Legacy non-trade or unknown: item.price is already retail inc-VAT.
  return price;
}

/**
 * Determine the volume-tier discount % that applies at the item's *current*
 * quantity. Walks `tier_thresholds` (m²-cutoffs) and returns the matching
 * `tier_discounts[i]`. Returns 0 if tier pricing is disabled, missing, or
 * if quantity hasn't crossed the first threshold.
 *
 * Example config:
 *   tier_thresholds: [50, 100, 200]
 *   tier_discounts:  [0, 5, 10, 15]   // [<50, 50-99, 100-199, 200+]
 *   quantity = 100.8  →  returns 10
 */
export function getActiveTierDiscount(item) {
  if (!item || item.tier_pricing_disabled) return 0;
  if ((item.pricing_unit || 'm2') !== 'm2') return 0;
  const thresholds = item.tier_thresholds;
  const discounts = item.tier_discounts;
  if (!Array.isArray(thresholds) || !Array.isArray(discounts)) return 0;
  if (thresholds.length === 0 || discounts.length === 0) return 0;
  const q = Number(item.quantity) || 0;
  // Walk thresholds; tier index = (# thresholds the quantity has met or exceeded)
  let tierIdx = 0;
  for (let i = 0; i < thresholds.length; i++) {
    if (q >= thresholds[i]) tierIdx = i + 1;
  }
  tierIdx = Math.min(tierIdx, discounts.length - 1);
  const pct = Number(discounts[tierIdx]) || 0;
  return pct > 0 && pct < 100 ? pct : 0;
}

/**
 * Return the price the user should SEE for this line item right now, given
 * their current trade status AND the item's current quantity.
 *
 * Pricing stack (compounds):
 *   1. Start from canonical retail inc-VAT
 *   2. Apply volume-tier discount (if quantity crosses a tier threshold)
 *   3. Apply trade discount (per-item override → account default)
 *   4. Strip VAT for trade users (ex-VAT display)
 *
 * Trade and volume-tier discounts stack — volume is product-level pricing,
 * trade is customer-level loyalty. They are NOT mutually exclusive.
 */
export function getEffectivePrice(item, isTrade, accountTradeDiscount = 0) {
  const retail = getRetailIncVat(item, accountTradeDiscount);
  // Apply volume-tier discount first — affects every viewer, trade or not.
  const tierPct = getActiveTierDiscount(item);
  let priced = retail * (1 - tierPct / 100);
  if (!isTrade) return Math.round(priced * 100) / 100;
  // Per-item trade discount ONLY (admin sets per product; fixed £ or %).
  // No blanket account default, and pallet-tier lines are already net bulk
  // rates so they get no extra trade discount.
  if (!item.pallet_tier) {
    const td = Number(item.trade_discount) || 0;
    if (td > 0) {
      const type = String(item.trade_discount_type || 'percent').toLowerCase();
      priced = type === 'fixed' ? Math.max(0, priced - td) : priced * (1 - td / 100);
    }
  }
  // Strip VAT for ex-VAT display.
  return Math.round((priced / 1.20) * 100) / 100;
}

/**
 * Total of all cart line items at the current effective price (sum of
 * effective_price × quantity). For non-trade users this equals the retail
 * inc-VAT product total; for trade users it equals the ex-VAT product total.
 */
export function getEffectiveSubtotal(cart, isTrade, accountTradeDiscount = 0) {
  if (!Array.isArray(cart) || cart.length === 0) return 0;
  const sum = cart.reduce((acc, item) => {
    const qty = typeof item.quantity === 'number' && !isNaN(item.quantity) ? item.quantity : 0;
    return acc + getEffectivePrice(item, isTrade, accountTradeDiscount) * qty;
  }, 0);
  return Math.round(sum * 100) / 100;
}
