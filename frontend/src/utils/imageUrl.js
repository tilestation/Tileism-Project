/**
 * Image URL helpers (May 14, 2026)
 *
 * Production backend was updated to return image fields as objects:
 *   { url: "https://...", alt: "Tile alt text", alt_generated_at: "..." }
 *
 * Frontend code in 15+ places was passing these objects directly to
 * `<img src={obj}>` which React stringifies to `[object Object]` —
 * resulting in 100% broken images sitewide on production. Reported
 * three times before being correctly diagnosed.
 *
 * These helpers accept BOTH the legacy string form AND the new object
 * form, so the frontend keeps working regardless of which version of
 * the backend it talks to.
 */

/**
 * Coerce an image value (string OR {url, alt, ...}) to a URL string.
 * Returns '' when no usable URL is present.
 */
export function imageUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value.url) return value.url;
  return '';
}

/**
 * Pick the first image url from an `images` array of mixed shapes.
 * `images` may be undefined, an array of strings, an array of objects,
 * or a mixed array. Returns '' if none usable.
 */
export function firstImageUrl(images) {
  if (!Array.isArray(images) || images.length === 0) return '';
  for (const img of images) {
    const u = imageUrl(img);
    if (u) return u;
  }
  return '';
}

/**
 * Pick the alt text from an image value when the backend supplies one,
 * otherwise fall back to the provided default.
 */
export function imageAlt(value, fallback = '') {
  if (value && typeof value === 'object' && value.alt) return value.alt;
  return fallback;
}
