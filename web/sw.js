// =============================================================================
// PWA Update Mechanism - Design Overview
// =============================================================================
// Goal: Installed PWAs should always run the latest frontend code, with the
// user notified when a new version is deployed.
//
// Strategy: Network-first service worker. The SW does NOT cache app code
// (HTML/JS/CSS) - those always come fresh from the server. The SW exists
// solely to (a) make the app installable, (b) precache a few heavy stable
// assets (CDN deps and icon), and (c) provide the lifecycle hooks that let
// the page detect when a new version is available.
//
// The VERSION constant below is the trigger. Bumping it causes the browser
// to detect this sw.js as different from the previously installed one,
// which kicks off the install/activate cycle. See dev-checklist.md for
// when to bump (patch / minor / major).
//
// Flow when an update is deployed:
//   1. User has app open with old SW (version X).
//   2. Page calls registration.update() periodically (10-min poll) and on
//      visibilitychange (tab back from background).
//   3. Browser fetches sw.js, sees byte difference, installs new SW (Y).
//      install handler calls skipWaiting() so the new SW activates ASAP.
//   4. activate handler calls clients.claim() so the new SW takes control
//      of the open page immediately.
//   5. Page's statechange listener sees state=='activated', asks the new SW
//      for its VERSION via postMessage, displays a banner: "App update
//      available (vX -> vY)".
//   6. User taps Update -> page blurs + shows "Updating..." -> location.reload()
//   7. Reload fetches fresh code from server (network-first), boots clean.
//
// First-install / hard-reload suppression:
//   The banner is gated on navigator.serviceWorker.controller being set
//   BEFORE registration. On a first-ever install (or hard reload that
//   bypasses the SW), there's no controller, so the initial activation
//   does not trigger the banner.
//
// Page-side logic lives in web/js/components/pl-app-shell.js (#initServiceWorker).
// =============================================================================

// Bump this version whenever you deploy frontend changes.
// The browser compares sw.js byte-for-byte; a changed VERSION triggers an update.
const VERSION = '3.1.2';

const CACHE_NAME = `photo-loka-${VERSION}`;

// Only cache heavy/stable assets that rarely change (CDN deps + app icon).
// App code is always fetched fresh from the network (network-first).
const urlsToCache = [
  '/assets/icon-454.png',
  'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/themes/light.css',
  'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/themes/dark.css',
  'https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&family=Roboto:wght@400;700&display=block',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet.markercluster@1.4.1/dist/leaflet.markercluster.js',
  'https://unpkg.com/navigo@8.11.1/lib/navigo.min.js',
  'https://cdn.jsdelivr.net/npm/cronstrue@2.50.0/+esm'
];

self.addEventListener('message', event => {
  if (event.data?.type === 'getVersion') {
    event.ports[0]?.postMessage({ version: VERSION });
  }
});

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(
        urlsToCache.map(url => cache.add(url))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // For precached CDN assets and the icon, serve from cache first (they are versioned/stable)
  if (urlsToCache.includes(event.request.url) || urlsToCache.includes(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        return cached || fetch(event.request);
      })
    );
    return;
  }

  // Everything else: network-first, no caching.
  // The app needs the server for all functionality anyway.
  event.respondWith(
    fetch(event.request).catch(() => {
      // Offline fallback for navigation requests: serve the cached icon page or nothing
      if (event.request.destination === 'document') {
        return caches.match('/assets/icon-454.png');
      }
    })
  );
});
