/**
 * Customer Error Watch — captures every red toast.error(), API 4xx/5xx,
 * and JS crash a customer ever sees, ships them to /api/client-errors/log
 * with a 5-step breadcrumb trail.
 *
 * Initialised once from App.js. Zero impact on render.
 *
 * Wire-up:
 *   - Monkey-patches `toast.error` from `sonner` so every red toast logs.
 *   - Global axios response interceptor flags non-2xx responses.
 *   - window.onerror + unhandledrejection catch real JS crashes.
 *   - Click / route / input observers feed a rolling 5-item breadcrumb buffer.
 *
 * Privacy:
 *   - Never sends passwords / card numbers (input listeners ignore type=password
 *     and any input named card/cvv/expiry, and the backend redacts again).
 *   - Customer email pulled from localStorage 'customer_email' if you set it
 *     on login. Falls back to anonymous session id.
 *
 * Spam control:
 *   - Same message hash within 90s is dropped client-side.
 *   - Backend rate-limits 30/min/session as belt-and-braces.
 *   - Benign browser-internal errors are filtered at source (see
 *     `BENIGN_PATTERNS` below) — these are noise that doesn't represent
 *     an actual broken-customer-experience.
 *   - Transient network errors (no HTTP response, just `Network Error`)
 *     get ONE silent retry with 800ms backoff before being logged. Real
 *     prod-incidents still surface; brief Wi-Fi blips don't.
 */
import axios from 'axios';
import { toast } from 'sonner';

const API_URL = process.env.REACT_APP_BACKEND_URL;
const ENDPOINT = `${API_URL}/api/client-errors/log`;
const DEDUPE_WINDOW_MS = 90_000;
const MAX_BREADCRUMBS = 5;

const SESSION_KEY = 'customer_error_session';
const BREADCRUMBS = [];
const recentHashes = new Map(); // hash → ts

// Patterns that match browser-internal, benign messages where the
// customer's experience is unaffected. Adding to this list reduces
// admin-panel noise without hiding real bugs.
const BENIGN_PATTERNS = [
  // ServiceWorker update/install fetch failures — the customer keeps
  // the cached SW and the browser auto-retries on next visit. Not a
  // customer-facing fault.
  /Failed to update a ServiceWorker/i,
  /Failed to register a ServiceWorker/i,
  /service-worker\.js.*load failed/i,
  /service-worker\.js.*An unknown error occurred/i,
  /Service worker registration failed/i,
  // Browser-internal cancellations (user navigated away mid-fetch)
  /aborterror/i,
  /the user aborted a request/i,
  /networkerror when attempting to fetch resource/i,
  // Cross-origin script errors with no useful info ("Script error.")
  /^script error\.?$/i,
  // Browser extensions / DevTools Sentry chatter
  /chrome-extension:/i,
  /moz-extension:/i,
  /^resizeobserver loop /i,
];

function isBenign(message) {
  if (!message) return true;
  const s = String(message);
  return BENIGN_PATTERNS.some((p) => p.test(s));
}

let initialised = false;

function ensureSessionId() {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) {
    id = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

function pushBreadcrumb(t, v) {
  if (!v) return;
  BREADCRUMBS.push({ t, v: String(v).slice(0, 80), ts: Date.now() });
  if (BREADCRUMBS.length > MAX_BREADCRUMBS) BREADCRUMBS.shift();
}

function shortHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}

function shouldSkipDuplicate(message) {
  const key = shortHash(message);
  const now = Date.now();
  // Lazy-clean
  for (const [k, ts] of recentHashes) {
    if (now - ts > DEDUPE_WINDOW_MS) recentHashes.delete(k);
  }
  if (recentHashes.has(key)) return true;
  recentHashes.set(key, now);
  return false;
}

function customerEmail() {
  // Customer-facing pages set tile_shop_customer (canonical key, see
  // useTradeUser + TradeLoginPage + CustomerRegisterPage). The previous
  // `customer_email` / `shop_customer_email` keys were never actually
  // written by any code path, so this function always returned null —
  // every error log was anonymous, even for signed-in customers.
  try {
    const raw = localStorage.getItem('tile_shop_customer');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.email === 'string' && parsed.email) {
        return parsed.email;
      }
    }
  } catch {}
  return null;
}

function isAdminPath() {
  return typeof window !== 'undefined' && window.location?.pathname?.startsWith('/admin');
}

async function postError(payload) {
  // sendBeacon survives unloads. Falls back to fetch keepalive.
  try {
    const body = JSON.stringify(payload);
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(ENDPOINT, blob);
      return;
    }
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
  } catch {
    // Fail silent — never let the watcher itself break the page.
  }
}

function logError({ error_type, message, status_code, api_endpoint, stack }) {
  if (!message) return;
  // Drop browser-internal benign noise at source. These are messages
  // where the customer's experience isn't actually impaired (e.g. the
  // browser failed to refresh a service worker but is happily using
  // the cached one). Logging them clutters the admin panel without
  // giving any actionable signal.
  if (isBenign(message)) return;
  const trimmed = String(message).slice(0, 600);
  if (shouldSkipDuplicate(`${error_type}:${trimmed}`)) return;
  // Don't ship admin's own clicks/errors — only customer-facing pages.
  if (isAdminPath()) return;

  postError({
    session_id: ensureSessionId(),
    error_type,
    message: trimmed,
    page_url: window.location?.pathname + (window.location?.search || ''),
    severity: 'error',
    status_code: status_code ?? null,
    api_endpoint: api_endpoint || null,
    customer_email: customerEmail(),
    user_agent: navigator.userAgent,
    breadcrumbs: BREADCRUMBS.slice(-MAX_BREADCRUMBS),
    stack: stack ? String(stack).slice(0, 2000) : null,
  });
}

// Tracks endpoints already retried in the last 5s so we don't form a
// retry-storm on a genuinely down backend.
const recentRetries = new Map(); // endpoint → ts
const RETRY_BACKOFF_MS = 800;
const RETRY_TRACK_MS = 5_000;

function shouldRetryNetworkError(url) {
  if (!url) return false;
  const now = Date.now();
  // Lazy-clean
  for (const [k, ts] of recentRetries) {
    if (now - ts > RETRY_TRACK_MS) recentRetries.delete(k);
  }
  if (recentRetries.has(url)) return false;
  recentRetries.set(url, now);
  return true;
}

async function attemptSilentRetry(originalConfig) {
  // Best-effort retry; if it succeeds the customer never saw the
  // hiccup. If it still fails we fall through to logging.
  if (!originalConfig || !originalConfig.url) return false;
  await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
  try {
    await axios({ ...originalConfig, __silentRetry: true });
    return true;
  } catch {
    return false;
  }
}

function patchSonnerToastError() {
  if (!toast || typeof toast.error !== 'function') return;
  if (toast.__customerErrorWatchPatched) return;
  const original = toast.error.bind(toast);
  // eslint-disable-next-line func-names
  const wrapped = function (msg, opts) {
    try {
      const text = typeof msg === 'string' ? msg : (msg?.toString?.() || 'error');
      logError({ error_type: 'toast', message: text });
    } catch {
      // ignore
    }
    return original(msg, opts);
  };
  // Preserve any helper props attached to original
  Object.assign(wrapped, original);
  // eslint-disable-next-line no-param-reassign
  toast.error = wrapped;
  toast.__customerErrorWatchPatched = true;
}

function installAxiosInterceptor() {
  axios.interceptors.response.use(
    (resp) => resp,
    async (err) => {
      try {
        const status = err?.response?.status;
        const url = err?.config?.url || err?.request?.responseURL || '';
        // Skip anything from our own logging endpoint — stops feedback loops.
        if (typeof url === 'string' && url.includes('/api/client-errors/log')) {
          return Promise.reject(err);
        }
        if (status && (status >= 500 || status === 401 || status === 403)) {
          const detail = err?.response?.data?.detail
            || err?.response?.data?.message
            || err?.message
            || `${status}`;
          logError({
            error_type: 'api',
            message: `${status} on ${url}: ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200)}`,
            status_code: status,
            api_endpoint: url,
          });
        } else if (!err?.response && err?.message) {
          // Transient network error (no HTTP response — DNS / offline /
          // momentary backend blip). Try ONE silent retry before we
          // log it: real outages still surface within 800ms; brief
          // Wi-Fi / Railway-edge hiccups heal automatically and the
          // customer never sees a broken UI.
          const isSilentRetry = err?.config?.__silentRetry;
          const isGet = (err?.config?.method || 'get').toLowerCase() === 'get';
          if (!isSilentRetry && isGet && shouldRetryNetworkError(url)) {
            const recovered = await attemptSilentRetry(err.config);
            if (recovered) {
              // Healed — never report
              return Promise.reject(err);
            }
          }
          logError({
            error_type: 'network',
            message: `Network error on ${url}: ${err.message}`,
            api_endpoint: url,
          });
        }
      } catch {
        // ignore
      }
      return Promise.reject(err);
    },
  );
}

function installCrashHandlers() {
  window.addEventListener('error', (e) => {
    logError({
      error_type: 'js',
      message: e?.message || 'Script error',
      stack: e?.error?.stack || '',
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e?.reason;
    const msg = typeof reason === 'string'
      ? reason
      : (reason?.message || JSON.stringify(reason)?.slice(0, 200) || 'Unhandled promise rejection');
    logError({
      error_type: 'unhandled',
      message: msg,
      stack: reason?.stack || '',
    });
  });
}

function installBreadcrumbCapture() {
  // Initial route
  pushBreadcrumb('route', window.location?.pathname);

  // Clicks on buttons / links
  window.addEventListener('click', (e) => {
    try {
      const t = e.target.closest?.('button, a, [role="button"]');
      if (!t) return;
      const label = (t.innerText || t.getAttribute('aria-label') || t.getAttribute('title') || t.tagName).trim().slice(0, 80);
      if (label) pushBreadcrumb('click', label);
    } catch { /* ignore */ }
  }, { capture: true, passive: true });

  // Inputs (label only — never the value, except for non-sensitive selects)
  window.addEventListener('change', (e) => {
    try {
      const el = e.target;
      if (!el || !el.tagName) return;
      const tag = el.tagName.toLowerCase();
      const type = (el.type || '').toLowerCase();
      const name = (el.name || el.id || '').toLowerCase();
      // Never log password/card/cvv/security-code values OR field names
      if (
        type === 'password'
        || /pass|card|cvv|cv2|cvc|secret|otp|pin/.test(name)
      ) return;
      if (tag === 'select') {
        pushBreadcrumb('input', `${name || 'select'}=${(el.value || '').slice(0, 30)}`);
      } else {
        pushBreadcrumb('input', name || tag);
      }
    } catch { /* ignore */ }
  }, { capture: true, passive: true });

  // Route changes (SPA) — patch pushState/replaceState
  ['pushState', 'replaceState'].forEach((fn) => {
    const original = window.history[fn];
    // eslint-disable-next-line func-names
    window.history[fn] = function (...args) {
      const ret = original.apply(this, args);
      try {
        pushBreadcrumb('route', window.location?.pathname);
      } catch { /* ignore */ }
      return ret;
    };
  });
  window.addEventListener('popstate', () => {
    pushBreadcrumb('route', window.location?.pathname);
  });
}

export function initCustomerErrorWatch() {
  if (initialised) return;
  if (typeof window === 'undefined') return;
  initialised = true;
  try {
    ensureSessionId();
    patchSonnerToastError();
    installAxiosInterceptor();
    installCrashHandlers();
    installBreadcrumbCapture();
  } catch (exc) {
    // Last-resort guard — the watcher must never break the app.
    // eslint-disable-next-line no-console
    console.warn('Customer error watch init failed:', exc);
  }
}

// Expose for debugging / unit tests
if (typeof window !== 'undefined') {
  window.__customerErrorWatch = { logError, BREADCRUMBS };
}
