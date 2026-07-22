/**
 * Crash telemetry helper — used by every React ErrorBoundary in the app to
 * report unhandled crashes to /api/client-errors/log.
 *
 * WHY this exists: the app already has a mature crash pipeline (bot filter,
 * benign-message suppression, per-session rate limit, Telegram alert,
 * daily digest email, Live Visitors panel). What it did NOT have until now
 * was a single reliable entry point for React boundaries — the root Sentry
 * boundary was silently swallowing crashes on any route not individually
 * wrapped in StorefrontErrorBoundary (e.g. /shop/tile-cart, which cost us
 * an active trade session on 22 Jul 2026 when a bad refactor slipped in).
 *
 * All boundaries now funnel here. One place to touch when we add new
 * dimensions to the crash record (e.g. release SHA, feature-flag state).
 */

const API_URL = process.env.REACT_APP_BACKEND_URL;
const SESSION_KEY = 'customer_error_session'; // matches clientErrorWatch.js

/** Cheap session id — persists for the tab. Same key as clientErrorWatch so
 * one visit produces ONE session across toast/api/js crash events. */
export function getCrashSessionId() {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    // Private mode / no sessionStorage — one-shot id, no persistence.
    return `sess-oneoff-${Date.now().toString(36)}`;
  }
}

/** Classify the current viewer into one of four buckets. This is what
 * lets admins spot at-a-glance whether a crash cost them a paying trade
 * customer or just an anonymous browser. Ordering matters: admin wins
 * over trade wins over retail wins over guest. */
export function resolveUserTier() {
  try {
    if (typeof window === 'undefined') return 'guest';
    // Admin has priority — a logged-in admin browsing the storefront still
    // reports as "admin" so we can filter out our own crashes.
    if (localStorage.getItem('admin_token')) return 'admin';
    const raw = localStorage.getItem('tile_shop_customer');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.is_trade) return 'trade';
      if (parsed) return 'retail';
    }
  } catch {
    // localStorage may be blocked (private mode, iframe). Fall through.
  }
  return 'guest';
}

/** Best-effort customer email for the current viewer. Read from the same
 * canonical key used by useTradeUser / TradeLoginPage. Returns null when
 * anonymous — the backend will fall back to the ip_hash. */
export function resolveCustomerEmail() {
  try {
    const raw = localStorage.getItem('tile_shop_customer');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.email === 'string' && parsed.email) {
        return parsed.email;
      }
    }
  } catch { /* localStorage unavailable — anonymous is fine */ }
  return null;
}

/**
 * Report a React ErrorBoundary crash. Never throws — telemetry must not
 * break the user's fallback UI.
 *
 * @param {Error} error - the caught error
 * @param {object} errorInfo - React's { componentStack } companion
 * @param {object} opts - { boundary: 'root' | 'storefront' | 'safe-section', route: string }
 */
export function reportBoundaryCrash(error, errorInfo, opts = {}) {
  try {
    if (!API_URL) return; // no backend configured, nothing to do
    const boundary = opts.boundary || 'unknown';
    const route = opts.route || (typeof window !== 'undefined' ? window.location.pathname : 'ssr');
    const url = (typeof window !== 'undefined' ? window.location.href : 'ssr');
    const stack = String(error?.stack || errorInfo?.componentStack || '');
    const message = String(error?.message || error || 'Unknown error');
    const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '';

    const payload = {
      session_id: getCrashSessionId(),
      // `js` matches the existing enum used by clientErrorWatch — the admin
      // Customer Errors panel already colour-codes it red as "JS crash".
      error_type: 'js',
      message: message.slice(0, 600),
      page_url: url.slice(0, 400),
      severity: 'error',
      customer_email: resolveCustomerEmail(),
      user_agent: ua.slice(0, 300),
      user_tier: resolveUserTier(),
      stack: stack.slice(0, 2000),
      breadcrumbs: [
        { t: 'boundary', v: boundary, ts: Date.now() },
        { t: 'route', v: String(route).slice(0, 80), ts: Date.now() },
        errorInfo?.componentStack
          ? { t: 'component', v: String(errorInfo.componentStack).slice(0, 80), ts: Date.now() }
          : null,
      ].filter(Boolean),
    };

    // keepalive so an unload race (customer clicks Back on the crashed page)
    // still gets the report out. Fire-and-forget.
    fetch(`${API_URL}/api/client-errors/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify(payload),
    }).catch(() => { /* swallow — telemetry never breaks the UI */ });
  } catch {
    // Absolute belt-and-braces — reporting a crash MUST NOT crash.
  }
}
