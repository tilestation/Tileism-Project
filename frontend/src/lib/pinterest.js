/**
 * Pinterest Tag (conversion pixel) helper
 * ──────────────────────────────────────
 * Thin wrapper around `window.pintrk` (bootstrapped in `public/index.html`).
 * • Stays INERT (no-op) until the tag ID is set via env or admin settings.
 * • Tag ID source order: `REACT_APP_PINTEREST_TAG_ID` env, then the
 *   `website_settings.pinterest_tag_id` Mongo doc (admin-editable).
 * • Standard events follow Pinterest's e-commerce convention so they
 *   show up correctly in their Ads dashboard without any mapping work.
 */

const ENV_TAG_ID = process.env.REACT_APP_PINTEREST_TAG_ID || '';

/** Initialise the tag with whatever ID we can find. Idempotent. */
export function initPinterestTag(tagId) {
  const id = (tagId || ENV_TAG_ID || '').trim();
  if (!id || typeof window === 'undefined') return false;
  if (window.__PINTEREST_TAG_ID === id) return true;
  window.__PINTEREST_TAG_ID = id;  // setter in index.html boots the loader
  return true;
}

function safe(fn) {
  try { fn(); } catch { /* never throw from analytics */ }
}

/** Track a single page view — call on every route change. */
export function trackPinterestPage() {
  safe(() => window.pintrk && window.pintrk('page'));
}

/** Track an arbitrary Pinterest standard event. */
export function trackPinterestEvent(eventName, payload = {}) {
  safe(() => window.pintrk && window.pintrk('track', eventName, payload || {}));
}

/** Add-to-cart — fire from cart context, never from the button click directly
 * (we want to count only after the cart state actually accepts the item). */
export function pinterestAddToCart({ product_id, product_name, product_category, value, quantity = 1, currency = 'GBP' } = {}) {
  trackPinterestEvent('AddToCart', {
    value: Number(value) || 0,
    order_quantity: Number(quantity) || 1,
    currency,
    line_items: [{
      product_id: product_id || '',
      product_name: product_name || '',
      product_category: product_category || '',
      product_quantity: Number(quantity) || 1,
      product_price: Number(value) || 0,
    }],
  });
}

/** Checkout complete — fire from the order-success page or webhook handler. */
export function pinterestCheckout({ order_id, value, quantity = 1, currency = 'GBP', line_items = [] } = {}) {
  trackPinterestEvent('Checkout', {
    value: Number(value) || 0,
    order_quantity: Number(quantity) || 1,
    order_id: order_id || '',
    currency,
    line_items: (line_items || []).map(li => ({
      product_id: li.product_id || li.id || '',
      product_name: li.product_name || li.name || '',
      product_quantity: Number(li.quantity || 1),
      product_price: Number(li.price || 0),
    })),
  });
}

/** Lead/signup — for sample requests, newsletter, trade-account apply, etc. */
export function pinterestLead({ lead_type = 'sample', value = 0 } = {}) {
  trackPinterestEvent('Lead', {
    lead_type,
    value: Number(value) || 0,
    currency: 'GBP',
  });
}
