/**
 * Barebones service worker.
 *
 * Its only job is to exist with a fetch handler so browsers treat Vantik as an
 * installable PWA and surface the install prompt automatically. It does no
 * caching, so there is no offline support and no risk of serving stale assets
 * after a deploy. Add caching strategies here if offline support is wanted.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Intentionally a no-op passthrough to the network. The mere presence of a
  // fetch handler is what satisfies the browser's PWA installability criteria.
});
