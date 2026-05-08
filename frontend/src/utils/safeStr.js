/**
 * Defensive string + array helpers — used by the storefront PDP and
 * collection pages to make every transformation crash-proof.
 *
 * The collection detail page has 90+ `.match()`, `.includes()`,
 * `.split()`, `.toLowerCase()` calls. Production data has decades of
 * legacy migrations layered on top of each other — so any one of those
 * fields can be `null`, `undefined`, an object, a number, or even an
 * array on a bad day. A single unsafe call crashes the whole page and
 * bubbles to the error boundary ("We couldn't load this collection").
 *
 * Use these helpers wherever the input comes from `selectedProduct.*`,
 * an API response, or anything that can change shape over time.
 */

/** Coerce anything to a non-null string. */
export const safeStr = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.length > 0 ? safeStr(v[0]) : '';
  if (typeof v === 'object') {
    // Common image/media object shapes from past CDN migrations
    return safeStr(v.src || v.url || v.large || v.thumbnail || v.path || v.href || '');
  }
  return '';
};

/** Lowercase, never throws. */
export const safeLower = (v) => safeStr(v).toLowerCase();

/** RegExp.match wrapper — coerces input + always returns an array (possibly empty). */
export const safeMatch = (v, re) => {
  const s = safeStr(v);
  if (!s || !re) return [];
  try { return s.match(re) || []; } catch { return []; }
};

/** String.includes wrapper — coerces input. */
export const safeIncludes = (v, needle) => {
  if (needle === null || needle === undefined) return false;
  return safeStr(v).includes(String(needle));
};

/** String.split wrapper — coerces input + always returns an array. */
export const safeSplit = (v, sep) => {
  const s = safeStr(v);
  if (!s) return [];
  try { return s.split(sep); } catch { return [s]; }
};

/** Coerce to array. Wraps single non-arrays so .map() etc. never crash. */
export const safeArr = (v) => {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  return [v];
};

/** Number coercion — returns 0 on bad input rather than NaN. */
export const safeNum = (v, fallback = 0) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Render a number with fixed precision, never NaN. */
export const safeToFixed = (v, digits = 2, fallback = '0.00') => {
  const n = safeNum(v, NaN);
  return Number.isFinite(n) ? n.toFixed(digits) : fallback;
};

/**
 * Normalise a raw image entry to a string URL.
 * Accepts: string, {src}, {url}, {large}, {thumbnail}, {path}, {href}.
 * Returns an empty string for unrecognised shapes (caller filters those out).
 */
export const normaliseImageUrl = (img) => {
  if (typeof img === 'string') return img;
  if (img && typeof img === 'object') {
    return safeStr(img.src || img.url || img.large || img.thumbnail || img.path || img.href || '');
  }
  return '';
};

/** Normalise an image array to a clean array of string URLs. */
export const normaliseImageList = (arr) =>
  safeArr(arr).map(normaliseImageUrl).filter(Boolean);
