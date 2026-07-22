import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import "@/index.css";
import App from "@/App";
import { reportBoundaryCrash } from "@/lib/crashTelemetry";

// Sentry — only activates when REACT_APP_SENTRY_DSN is set in .env.
// No-op otherwise, so this is safe to keep in production builds.
const SENTRY_DSN = process.env.REACT_APP_SENTRY_DSN;
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    environment: process.env.REACT_APP_SENTRY_ENV || "production",
    release: process.env.REACT_APP_SENTRY_RELEASE || "tile-station-frontend",
    integrations: [Sentry.browserTracingIntegration()],
    // 10 % of transactions traced — enough to catch slow pages without quota burn
    tracesSampleRate: 0.1,
    // Don't send PII by default; we filter on the backend if needed
    sendDefaultPii: false,
    // Drop noisy chunks (failed analytics, browser extensions)
    beforeSend(event) {
      const msg = event.exception?.values?.[0]?.value || "";
      if (/extension|chrome-extension|moz-extension|adsbygoogle/i.test(msg)) return null;
      return event;
    },
  });
}

// Build version - auto-updated
console.log('Tile Station Build: 2026-07-22-crash-telemetry');

/**
 * RootErrorBoundary — the last line of defence for the entire app.
 *
 * The previous `Sentry.ErrorBoundary` wrapper here only reported to Sentry
 * (which is a no-op without a DSN) and rendered a dead-end "Something went
 * wrong" screen. That's how the 22 Jul 2026 trade-cart ReferenceError went
 * silent — the crash never hit /api/client-errors/log so it never showed
 * up in the admin Customer Errors panel and no Telegram alert fired.
 *
 * This boundary:
 *   1. POSTs to /api/client-errors/log via crashTelemetry (deduped,
 *      rate-limited, redacted, tier-tagged, Telegram-alerted).
 *   2. Still forwards to Sentry when a DSN is configured.
 *   3. Renders the same recoverable fallback so existing UX is identical.
 *   4. Attempts ONE auto-retry after 1.5s to shrug off transient hydration
 *      races that would otherwise strand the user on the fallback.
 */
class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, retried: false };
    this._retryTimer = null;
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    // 1. Backend telemetry — feeds admin Customer Errors panel
    try {
      reportBoundaryCrash(error, errorInfo, {
        boundary: 'root',
        route: typeof window !== 'undefined' ? window.location.pathname : 'ssr',
      });
    } catch { /* never throw from a boundary */ }

    // 2. Sentry — preserves prior behaviour when DSN is configured
    try {
      Sentry.withScope((scope) => {
        scope.setTag('boundary', 'root');
        scope.setExtra('componentStack', errorInfo?.componentStack);
        Sentry.captureException(error);
      });
    } catch { /* Sentry may be uninitialised */ }

    // 3. Auto-retry once — hydration/StrictMode races often clear on retry.
    if (!this.state.retried) {
      this._retryTimer = setTimeout(() => {
        this.setState({ error: null, retried: true });
      }, 1500);
    }
  }

  componentWillUnmount() {
    if (this._retryTimer) clearTimeout(this._retryTimer);
  }

  reset = () => {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    this.setState({ error: null, retried: false });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 32, fontFamily: 'system-ui', maxWidth: 540, margin: '64px auto', textAlign: 'center' }} data-testid="root-error-boundary">
        <h1 style={{ fontSize: 22, marginBottom: 8 }}>Something went wrong</h1>
        <p style={{ color: '#666', marginBottom: 16 }}>We've been notified. Please try refreshing the page.</p>
        <button
          onClick={this.reset}
          style={{ padding: '8px 16px', background: '#1C1917', color: '#F7EA1C', border: 0, borderRadius: 8, cursor: 'pointer' }}
          data-testid="root-error-boundary-retry"
        >Try again</button>
        {process.env.NODE_ENV === 'development' && (
          <pre style={{ marginTop: 16, fontSize: 11, color: '#999', textAlign: 'left', overflow: 'auto' }}>{String(this.state.error?.message || this.state.error)}</pre>
        )}
      </div>
    );
  }
}

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>,
);

// Register service worker for PWA functionality
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then((registration) => {
        console.log('ServiceWorker registered: ', registration);
      })
      .catch((error) => {
        console.log('ServiceWorker registration failed: ', error);
      });
  });
}
