/**
 * extractApiError(error)
 * ────────────────────────
 * Coerces an axios / fetch error into a human-readable string for
 * toast.error(). Handles the four shapes our FastAPI backend can
 * return for `detail`:
 *
 *   1. A plain string → return as-is
 *      `{ detail: "Email already registered" }`
 *
 *   2. A list of Pydantic validation errors → join their `msg` fields
 *      `{ detail: [{ loc: ["body","email"], msg: "field required", type: "value_error" }] }`
 *
 *   3. A nested object → JSON-stringify and truncate
 *      `{ detail: { error_code: "X", reason: "Y" } }`
 *
 *   4. No response (network error / CORS) → fall back to error.message
 *
 * Without this helper, toasts often render "Operation failed" or
 * "[object Object]" because the raw detail is unprintable.
 *
 * @param {unknown} error
 * @param {string} fallback Message when nothing usable is extractable
 * @returns {string} A safe-to-render toast message
 */
export function extractApiError(error, fallback = 'Something went wrong') {
  // Network / CORS / no response from server
  if (error === null || error === undefined) {
    return fallback;
  }

  // Plain string error
  if (typeof error === 'string') return error || fallback;

  if (typeof error !== 'object') {
    return fallback;
  }

  // Axios error — drill into response.data.detail
  const detail = error?.response?.data?.detail;

  if (typeof detail === 'string' && detail.trim()) {
    return detail.trim();
  }

  if (Array.isArray(detail) && detail.length > 0) {
    // FastAPI Pydantic validation errors → ["field 'email' is required", ...]
    const messages = detail.map((d) => {
      if (typeof d === 'string') return d;
      const loc = Array.isArray(d?.loc)
        ? d.loc.filter((x) => x !== 'body').join('.')
        : '';
      const msg = d?.msg || d?.message || JSON.stringify(d);
      return loc ? `${loc}: ${msg}` : msg;
    });
    return messages.join('; ');
  }

  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    // Final guard — try a few well-known keys then fall back to JSON
    if (detail.message) return String(detail.message);
    if (detail.error) return String(detail.error);
    try {
      return JSON.stringify(detail).slice(0, 200);
    } catch {
      return fallback;
    }
  }

  // No detail — try other useful fields
  if (error?.response?.data?.message) return String(error.response.data.message);
  if (error?.response?.statusText) return `${error.response.status}: ${error.response.statusText}`;
  if (error?.message) return error.message;

  return fallback;
}

export default extractApiError;
