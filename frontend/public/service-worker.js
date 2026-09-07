/**
 * Tile Station service worker — minimal push-notification only build.
 *
 * History (May 14, 2026): the prior version implemented a network-first
 * cache strategy that intercepted every same-origin GET. It caused two
 * production incidents in two days — broken images on search results
 * (`Failed to convert value to 'Response'`) and stale chunk-loads after
 * each Railway deploy. The shell-caching never delivered measurable
 * value (the site is fully online-only) so the entire cache/fetch
 * machinery has been removed. What's left is the push-notification
 * subscription endpoint, which is the SW's only real job.
 *
 * What this file does:
 *   1. Installs cleanly and replaces any previously active SW on first
 *      load after a deploy (skipWaiting + self.clients.claim).
 *   2. Purges any caches left over from the old network-first build
 *      so users don't keep serving stale chunks from their browser
 *      cache.
 *   3. Forwards Web Push payloads to the Notification API.
 *   4. Focuses / opens the right tab when a notification is clicked.
 *
 * What this file deliberately does NOT do:
 *   • Intercept fetch events. The browser handles assets natively;
 *     the CDN handles caching. No more "ghost" stale chunks.
 *   • Provide an offline page. The site requires network anyway
 *     (catalogue, checkout, account) — a fake offline shell only
 *     ever masked real connectivity issues.
 */

// Bumping this string is what releases the new SW. Build-time tools may
// rewrite it, but a static literal is enough for our deploy cadence —
// the worker file URL itself changes on each Railway build because
// CRA fingerprints assets, which triggers the browser's stale-check.
const SW_VERSION = 'push-only-2026-05-14';

self.addEventListener('install', (event) => {
  // Take over immediately — we want the buggy previous SW evicted on
  // the first navigation after deploy, not after a tab-cycle.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Wipe every cache the old `tilestation-v*` SW created so users
    // don't keep getting stale chunks/images from their browser cache.
    try {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n.startsWith('tilestation-') || n.startsWith('workbox-'))
          .map((n) => caches.delete(n)),
      );
    } catch (_) { /* best-effort */ }

    // Become the active controller for all open tabs.
    if (self.clients && self.clients.claim) {
      try { await self.clients.claim(); } catch (_) { /* noop */ }
    }

    // eslint-disable-next-line no-console
    console.log(`[SW] Activated ${SW_VERSION} — push-only build`);
  })());
});

// ─── Message channel ────────────────────────────────────────────────
// Kept so the existing `navigator.serviceWorker.controller.postMessage('skipWaiting')`
// callers from older client code don't throw. Both commands are no-ops
// now that the SW doesn't cache anything — but the keys are preserved
// for backward compatibility.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
  // `clearCache` is now redundant (we don't cache anything) but we
  // still acknowledge it so older clients don't see unhandled-message
  // warnings in the console.
});

// ─── Web Push Notifications ─────────────────────────────────────────
// Fired when the push service delivers a message from the backend.
// Payload shape: {title, body, url, icon, image, tag}
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { title: 'Tile Station', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Tile Station';
  const options = {
    body: payload.body || '',
    icon: payload.icon || '/icon-192.png',
    badge: '/icon-192.png',
    image: payload.image || undefined,
    tag: payload.tag || 'tilestation-push',
    data: { url: payload.url || '/' },
    requireInteraction: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Open / focus the right tab when a notification is clicked.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const c of clientList) {
        try {
          const u = new URL(c.url);
          if (u.origin === self.location.origin && 'focus' in c) {
            c.navigate(target).catch(() => {});
            return c.focus();
          }
        } catch (_) { /* ignore */ }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
      return null;
    }),
  );
});
