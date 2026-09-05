// =============================================================================
// PWA Update Mechanism - Design Overview
// =============================================================================
// Goal: Installed PWAs should always run the latest frontend code, with the
// user notified when a new version is deployed.
//
// Strategy: Cache-first service worker keyed on VERSION. App code (HTML/JS/CSS/
// assets) is cached per VERSION and served cache-first for speed and offline;
// it is safe because code is immutable within a VERSION and every web change
// bumps VERSION (so the version-scoped cache self-invalidates and activate
// deletes the old one). API/media/SSE requests are always network-first. The SW
// also (a) makes the app installable, (b) precaches a few heavy stable assets
// (CDN deps and icon), and (c) provides the lifecycle hooks that let the page
// detect when a new version is available.
//
// The VERSION constant below is the trigger. Bumping it causes the browser
// to detect this sw.mjs as different from the previously installed one,
// which kicks off the install/activate cycle. See dev-checklist.md for
// when to bump (patch / minor / major).
//
// Flow when an update is deployed:
//   1. User has app open with old SW (version X).
//   2. Page calls registration.update() periodically (10-min poll) and on
//      visibilitychange (tab back from background).
//   3. Browser fetches sw.mjs, sees byte difference, installs new SW (Y).
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
// The browser compares sw.mjs byte-for-byte; a changed VERSION triggers an update.
const VERSION = '4.11.4';

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

// Same-origin app code that is safe to cache-first. It is immutable within a
// VERSION (baked into the Go binary / served from ../web in dev), and every web
// change bumps VERSION -- so the version-scoped CACHE_NAME self-invalidates on
// every deploy/edit. Allowlist by path so anything unexpected (esp. /api/*)
// fails safe to the network.
function isCacheableCode(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  if (p.startsWith('/api/')) return false;  // dynamic: API, media, SSE
  if (p === '/sw.mjs') return false;         // never intercept the SW itself
  return (
    p === '/' ||
    p === '/index.html' ||
    p === '/frame.html' ||
    p === '/manifest.json' ||
    p.startsWith('/js/') ||
    p.startsWith('/css/') ||
    p.startsWith('/assets/')
  );
}

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
  const { request } = event;
  const url = new URL(request.url);

  // Only GET responses are cacheable; let everything else pass through.
  if (request.method !== 'GET') return;

  // For precached CDN assets and the icon, serve from cache first (they are versioned/stable)
  if (urlsToCache.includes(request.url) || urlsToCache.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then(cached => {
        return cached || fetch(request);
      })
    );
    return;
  }

  // Same-origin app code (HTML/JS/CSS/assets): cache-first, populated on first
  // fetch into the VERSION-scoped cache. A cache hit is always correct because
  // code is immutable within a VERSION; a new VERSION creates a fresh cache and
  // activate deletes the old one, so a deploy swaps code atomically on reload.
  if (isCacheableCode(url)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(request).then(cached => {
          if (cached) return cached;
          return fetch(request).then(resp => {
            if (resp.ok && resp.status === 200) {
              cache.put(request, resp.clone());
            }
            return resp;
          });
        })
      )
    );
    return;
  }

  // Everything else (API, media, SSE): network-first, no caching.
  // The app needs the server for all functionality anyway.
  // Use cache:'no-store' to bypass the browser's HTTP cache on mobile.
  event.respondWith(
    fetch(request, { cache: 'no-store' }).catch(() => {
      // Offline fallback for navigation requests: serve the cached icon page or nothing
      if (request.destination === 'document') {
        return caches.match('/assets/icon-454.png');
      }
    })
  );
});
