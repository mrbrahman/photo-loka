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
const VERSION = '4.37.2';

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

// =============================================================================
// Web Push notifications
// =============================================================================
// The server (on a finished indexing batch) delivers a JSON payload
// { title, body, collectionId, query }. We render it as a notification; on
// click we open/focus the PWA on the collection-scoped search route built from
// collectionId + query (the server emits what to search, the client owns the
// route format). See internal/push and internal/pipeline/batch_notify.go.

self.addEventListener('push', event => {
  // Parse the server JSON payload. Tolerate a non-JSON payload (e.g. a plain
  // string from the DevTools "Push" test button) by falling back to a generic
  // notification, so a manual test still renders something.
  let p = {};
  if (event.data) {
    try {
      p = event.data.json();
    } catch {
      p = { title: 'Photo-Loka', body: event.data.text() };
    }
  }

  event.waitUntil(
    self.registration.showNotification(p.title || 'Photo-Loka', {
      body: p.body || '',
      icon: '/assets/icon-454.png',
      badge: '/assets/icon-454.png',
      // Coalesce per collection: a newer batch for the same collection replaces
      // the previous notification instead of stacking (they all click through
      // to the same date(indexed_at) search anyway).
      tag: p.collectionId != null ? `batch-${p.collectionId}` : 'photo-loka',
      // Carry the structured fields through to the click handler.
      data: { collectionId: p.collectionId, query: p.query }
    })
    .catch(err => console.error('[sw] showNotification failed', err))
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const { collectionId, query } = data;
  if (!collectionId || !query) return;

  // Hash route the app understands; encode the query (it contains spaces,
  // quotes, parens from the raw: syntax) for the path segment.
  const url = `/#/app/c/${collectionId}/search/${encodeURIComponent(query)}`;
  event.waitUntil(focusOrOpen(url));
});

// focusOrOpen brings an already-running PWA window to the front and navigates
// it via the app's own router (reliable for a hash route), or opens a fresh
// window when none is running. Navigating an existing window purely by hash
// change via client.navigate is unreliable across browsers, so for a live
// window we postMessage it and let the in-app router handle the route; the
// page-side listener lives in main.mjs.
async function focusOrOpen(url) {
  const clientsArr = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  });
  // Prefer an existing same-origin app window.
  for (const client of clientsArr) {
    if (new URL(client.url).origin === self.location.origin) {
      await client.focus();
      client.postMessage({ type: 'navigate', url });
      return;
    }
  }
  // Nothing running: open fresh on the target route (the app reads the hash on
  // boot and routes to it).
  if (self.clients.openWindow) {
    await self.clients.openWindow(url);
  }
}

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

  // PWA share target: the OS share sheet POSTs selected files here as
  // multipart/form-data (see manifest "share_target"). Intercept it, stash the
  // files in IndexedDB, and redirect into the app's share-upload route, which
  // reads them back and runs the normal upload flow. Must come before the
  // GET-only guard below since this is a POST.
  if (request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleShareTarget(request));
    return;
  }

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


// =============================================================================
// PWA Share Target
// =============================================================================
// When the user shares image/video files to Photo-Loka from the Android share
// sheet (e.g. from a file manager), the OS POSTs them here as multipart form
// data. We cannot hand File objects straight to a freshly-navigated page, so we
// stash them in IndexedDB and redirect to the app's share-upload route; the
// upload page reads them back (see web/js/share-inbox.mjs) and runs the normal
// createUploadSession -> uploadFile -> finalizeUpload flow.
//
// NOTE: the service worker is registered as a classic worker (no `import`), so
// the IndexedDB helpers are inlined here and mirrored (contract-compatible) in
// web/js/share-inbox.mjs for the page side. Keep the DB name / store / key in
// sync between the two files.

const SHARE_DB_NAME = 'photo-loka-share';
const SHARE_STORE = 'inbox';
const SHARE_KEY = 'pending';

async function handleShareTarget(request) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files').filter(f => f && f.size !== undefined);
    if (files.length > 0) {
      await swShareInboxPut(files);
    }
  } catch (err) {
    // Even if stashing fails, still navigate into the app so the user is not
    // left on a blank POST response.
    // eslint-disable-next-line no-console
    console.error('[sw] share-target: failed to stash files', err);
  }
  // 303 so the browser issues a GET for the redirect target. The hash route is
  // where the app resolves the active collection and picks up the files.
  return Response.redirect('/#/app/share-upload', 303);
}

function swOpenShareDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SHARE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(SHARE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function swShareInboxPut(files) {
  const db = await swOpenShareDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SHARE_STORE, 'readwrite');
      tx.objectStore(SHARE_STORE).put(files, SHARE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
