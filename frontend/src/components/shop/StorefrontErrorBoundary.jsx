import React from 'react';
import * as Sentry from '@sentry/react';

/**
 * Per-route error boundary for the storefront.
 *
 * Customer-facing crashes used to bubble up to the root Sentry
 * boundary which renders "Something went wrong" with no context.
 * That's a dead-end UX. This boundary:
 *   • Renders a recoverable fallback that links back to the shop
 *   • Reports the actual error name + stack to Sentry with a tag
 *     so we can filter for storefront crashes specifically
 *   • POSTs the error to /api/client-errors/log so it shows up in
 *     the admin Customer Issues panel without needing Sentry creds
 *   • Auto-retries ONCE after 1.5s (handles transient race-condition
 *     crashes during data hydration — common with React 19 strict mode)
 *   • Prints the stack in development
 *
 * Wrap individual pages where a crash on ONE product/collection
 * shouldn't take down the rest of the user's session.
 */
const API_URL = process.env.REACT_APP_BACKEND_URL;

export class StorefrontErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, retried: false };
    this._autoRetryTimer = null;
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    // 1. Report to Sentry with structured context (admin/dev visibility)
    try {
      Sentry.withScope((scope) => {
        scope.setTag('boundary', 'storefront');
        scope.setTag('route', this.props.routeName || 'unknown');
        scope.setExtra('componentStack', errorInfo?.componentStack);
        scope.setExtra('url', typeof window !== 'undefined' ? window.location.href : 'ssr');
        Sentry.captureException(error);
      });
    } catch (_) {
      // Sentry may not be initialised in dev — silently no-op.
    }

    // 2. Report to backend Customer Issues panel via the existing
    //    /api/client-errors/log endpoint. Best-effort — never throws.
    try {
      const url = typeof window !== 'undefined' ? window.location.href : 'ssr';
      const sessionId = (typeof window !== 'undefined' && (window.localStorage?.getItem?.('session_id') || ''))
        || `boundary-${Date.now()}`;
      fetch(`${API_URL}/api/client-errors/log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          session_id: sessionId,
          error_type: error?.name || 'BoundaryCrash',
          message: String(error?.message || error || 'Unknown error'),
          stack: String(error?.stack || ''),
          url,
          breadcrumbs: [
            { type: 'route', value: this.props.routeName || 'unknown' },
            { type: 'componentStack', value: errorInfo?.componentStack || '' },
          ],
        }),
      }).catch(() => { /* swallow */ });
    } catch (_) {
      // never let telemetry break the fallback
    }

    if (typeof console !== 'undefined') {
      // eslint-disable-next-line no-console
      console.error('[storefront] crash on route', this.props.routeName, error, errorInfo);
    }

    // 3. Auto-retry ONCE after 1.5s. This handles transient errors
    //    during data hydration (e.g. an API field arrives in the wrong
    //    shape on first render but is normalised on the second). If the
    //    error fires again after retry, we stop retrying and show the
    //    fallback for real.
    if (!this.state.retried && !this.props.disableAutoRetry) {
      this._autoRetryTimer = setTimeout(() => {
        this.setState({ error: null, retried: true });
      }, 1500);
    }
  }

  componentWillUnmount() {
    if (this._autoRetryTimer) clearTimeout(this._autoRetryTimer);
  }

  reset = () => {
    if (this._autoRetryTimer) {
      clearTimeout(this._autoRetryTimer);
      this._autoRetryTimer = null;
    }
    this.setState({ error: null, retried: false });
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="min-h-[60vh] flex items-center justify-center px-4 py-16 bg-gray-50">
        <div className="max-w-md w-full text-center bg-white rounded-xl shadow-sm p-8 border border-gray-200">
          <div className="text-5xl mb-3" aria-hidden="true">😕</div>
          <h2 className="text-xl font-semibold text-gray-900 mb-2">
            We couldn't load this collection
          </h2>
          <p className="text-sm text-gray-600 mb-5 leading-relaxed">
            Sorry — something went wrong on our end. Our team has been notified.
            In the meantime, try refreshing or browse our other tile collections.
          </p>
          <div className="flex flex-col sm:flex-row gap-2 justify-center">
            <button
              type="button"
              onClick={this.reset}
              className="px-4 py-2.5 rounded-lg bg-gray-900 text-white text-sm font-medium hover:bg-gray-800"
              data-testid="storefront-error-retry"
            >
              Try again
            </button>
            <a
              href="/shop/collections"
              className="px-4 py-2.5 rounded-lg bg-white border border-gray-300 text-gray-800 text-sm font-medium hover:bg-gray-50"
              data-testid="storefront-error-browse-all"
            >
              Browse all collections
            </a>
          </div>
          <p className="text-xs text-gray-400 mt-5">
            Need help right away? Call us on{' '}
            <a href="tel:01732424242" className="underline">01732 424242</a>{' '}
            or pop into any showroom.
          </p>
          {process.env.NODE_ENV === 'development' && (
            <pre className="text-[10px] text-left text-rose-700 mt-4 overflow-auto max-h-32 bg-rose-50 p-2 rounded">
              {String(this.state.error?.message || this.state.error)}
              {'\n\n'}
              {this.state.error?.stack || ''}
            </pre>
          )}
        </div>
      </div>
    );
  }
}

/**
 * SafeSection — lightweight per-section boundary for use INSIDE a page
 * already wrapped in StorefrontErrorBoundary. If one panel crashes
 * (e.g. price block), the rest of the page (image gallery, description,
 * tier table) keeps rendering. Used to make the PDP fault-tolerant.
 *
 * Renders nothing on crash by default — pass `fallback` to override.
 */
export class SafeSection extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    try {
      Sentry.withScope?.((scope) => {
        scope.setTag('boundary', 'storefront-section');
        scope.setTag('section', this.props.name || 'unknown');
        scope.setExtra('componentStack', errorInfo?.componentStack);
        Sentry.captureException(error);
      });
    } catch (_) { /* ignore */ }

    if (typeof console !== 'undefined') {
      // eslint-disable-next-line no-console
      console.warn('[SafeSection] crash in', this.props.name, error?.message);
    }
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return null; // section silently disappears, page keeps working
    }
    return this.props.children;
  }
}

export default StorefrontErrorBoundary;

