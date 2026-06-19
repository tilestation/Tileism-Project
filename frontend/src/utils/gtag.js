/**
 * Google Ads conversion-tracking helper (19 Jun 2026)
 *
 * The base `gtag.js` script is injected from `public/index.html` for the
 * Tile Station Ads account `AW-727553334`. THIS file owns the individual
 * conversion *events* that fire when a customer does something we care
 * about on the site.
 *
 * Add new conversions to `CONVERSIONS` below and call `trackConversion`
 * from wherever the user-action happens. Keeping every conversion ID in
 * one map avoids the classic mistake of pasting the wrong label into
 * three different React components.
 *
 * Resilience: if gtag.js failed to load (ad-blocker, network, consent
 * banner not yet accepted) we silently no-op instead of crashing the
 * click handler — direction clicks STILL navigate to Google Maps,
 * tracking is a best-effort overlay.
 */

const GOOGLE_ADS_ID = 'AW-727553334';

// Conversion label map — keyed by a human-readable name so callsites
// stay readable. Labels come straight from Google Ads → Goals →
// Conversions → click the action → Tag setup → "send_to" value.
const CONVERSIONS = {
  // Fires when a customer clicks the "Get Directions" button on
  // ContactPage.jsx — a strong intent-to-visit signal for footfall ads.
  get_directions: '2rYqCP2nmcIcELaq9toC',
};

export function trackConversion(name, { value = 1.0, currency = 'GBP' } = {}) {
  const label = CONVERSIONS[name];
  if (!label) {
    // Dev-time sanity check — caught by linter / console long before
    // anything reaches production.
    // eslint-disable-next-line no-console
    console.warn(`[gtag] Unknown conversion name: ${name}`);
    return;
  }
  if (typeof window === 'undefined' || typeof window.gtag !== 'function') {
    // gtag.js not loaded (ad-blocker, offline, SSR, etc.) — no-op.
    return;
  }
  try {
    window.gtag('event', 'conversion', {
      send_to: `${GOOGLE_ADS_ID}/${label}`,
      value,
      currency,
    });
  } catch (err) {
    // Never let an analytics error break the user's actual click.
    // eslint-disable-next-line no-console
    console.warn('[gtag] conversion fire failed', err);
  }
}
