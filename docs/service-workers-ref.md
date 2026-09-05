# Service Workers - Quick Guide

A reference for the service worker concepts used in Photo-Loka's PWA update mechanism (`web/sw.mjs` and `pl-app-shell.js`).

## What is a Service Worker?

A service worker (SW) is a JavaScript file that runs in the **browser's background**, separate from any web page. It can:

- Intercept and handle network requests from pages in its scope
- Cache responses for offline / fast access
- Run even when no page is open (for push notifications, background sync, etc.)

A SW has **no DOM access**. It cannot touch `document` or `window`. It communicates with pages via `postMessage` and observes their requests.

## Lifecycle

A SW goes through these states:

```
[no SW] -> installing -> installed -> activating -> activated -> [redundant]
```

Key events:

- **`install`** - Fires once when the SW is first registered or when a new sw.mjs is detected. Use it to precache assets.
- **`activate`** - Fires once after install, when the SW takes over from any previous version. Use it to clean up old caches.
- **`fetch`** - Fires for every network request from pages in the SW's scope. Use it to serve cached responses or implement custom strategies.
- **`message`** - Fires when a page sends a `postMessage` to the SW.

## Key APIs

### `event.waitUntil(promise)`

Used inside `install` and `activate` event handlers. Tells the browser "don't move the SW to the next state until this promise resolves." Critical because these events return immediately by default.

```js
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open('my-cache').then(cache => cache.addAll(urls))
  );
});
```

Without `waitUntil`, the SW could activate before caching finishes.

### `event.respondWith(response)`

Used inside `fetch` handlers. Tells the browser "use this response instead of going to the network." Takes a `Response` object or a promise that resolves to one.

```js
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});
```

### `self.skipWaiting()`

Called in the `install` handler. Normally a new SW waits in the "installed" state until all pages controlled by the old SW close. `skipWaiting()` bypasses that wait, letting the new SW activate immediately.

```js
self.addEventListener('install', event => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});
```

### `self.clients.claim()`

Called in the `activate` handler. Normally a newly activated SW only controls pages that are loaded after activation. `clients.claim()` makes it take control of any already-open pages immediately.

```js
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});
```

`skipWaiting()` + `clients.claim()` together = "activate the new SW now and have it take over open pages immediately."

### `self.clients`

The set of pages currently controlled by this SW. Useful for messaging open pages from the SW.

### Caches API

```js
caches.open(name)         // open or create a named cache
cache.add(url)            // fetch and store url
cache.addAll([...urls])   // fetch and store many; fails if any fail
cache.put(req, res)       // store an arbitrary response
cache.match(req)          // look up a cached response
caches.keys()             // list cache names
caches.delete(name)       // remove a cache
```

The Cache API stores `Request -> Response` pairs. Caches persist across browser restarts.

### `postMessage` between page and SW

The page can send messages to the SW:

```js
// Page side
sw.postMessage({ type: 'getVersion' }, [channel.port2]);
```

The SW responds via the message port:

```js
// SW side
self.addEventListener('message', event => {
  if (event.data?.type === 'getVersion') {
    event.ports[0]?.postMessage({ version: VERSION });
  }
});
```

This is how `pl-app-shell` asks `sw.mjs` for its version to display in the update banner.

## Page-Side APIs

These run in regular page JS (e.g., in `pl-app-shell`), not in `sw.mjs`.

### `navigator.serviceWorker.register(url)`

Registers a SW. Returns a Promise that resolves with a `ServiceWorkerRegistration`. The SW download/install happens in the background.

```js
const registration = await navigator.serviceWorker.register('/sw.mjs');
```

### `ServiceWorkerRegistration`

The page-side handle for a registered SW.

- `registration.installing` - SW currently installing (or null)
- `registration.waiting` - SW installed, waiting to activate (or null)
- `registration.active` - SW currently active (or null)
- `registration.update()` - check the server for a new sw.mjs. Returns a Promise.

### `navigator.serviceWorker.controller`

The SW currently controlling **this specific page** (or null).

This is **not** the same as `registration.active`. You can have an active SW that does NOT control your page (e.g., after a hard reload that bypasses the SW). The controller is null in that case even though `registration.active` is set.

### Lifecycle events on the page

```js
registration.addEventListener('updatefound', () => {
  // a new SW has started installing
  const newSw = registration.installing;
  newSw.addEventListener('statechange', () => {
    if (newSw.state === 'activated') { /* new SW is now active */ }
  });
});

navigator.serviceWorker.addEventListener('controllerchange', () => {
  // the SW controlling this page just changed
});
```

## How Updates Are Detected

When the browser is asked to register a SW (via `register()` or `update()`):

1. It fetches `sw.mjs` from the server.
2. It compares the bytes to the currently installed version.
3. If different, it treats it as a new SW and starts the install process.
4. If identical, nothing happens.

This is why bumping a `VERSION` constant (or any byte change) in `sw.mjs` triggers an update.

## Common Strategies

### Cache-first

Try cache. If miss, go to network. Best for offline-capable apps with stable assets.

```js
caches.match(req).then(cached => cached || fetch(req))
```

### Network-first

Always try network. Cache as fallback. Best for content that should always be fresh, like dynamic apps.

```js
fetch(req).catch(() => caches.match(req))
```

Photo-Loka uses **cache-first, keyed on the SW `VERSION`**, for app code
(HTML/JS/CSS/assets). App code is immutable within a VERSION (baked into the Go
binary on release, served from `../web` in dev), and every web change bumps
`VERSION`, so the version-scoped cache self-invalidates on each deploy/edit and
`activate` deletes the old cache. Code is cached on first fetch into
`photo-loka-${VERSION}`. API, media, and SSE requests (`/api/*`) stay
network-first. Stable CDN dependencies and the icon are precached at install.

### Stale-while-revalidate

Serve cached version immediately, but update cache in the background.

```js
caches.match(req).then(cached => {
  const fresh = fetch(req).then(res => {
    cache.put(req, res.clone());
    return res;
  });
  return cached || fresh;
});
```

## Gotchas

- **Hard reload bypasses the SW.** `Ctrl+Shift+R` makes the page load directly from the network without going through any SW. `navigator.serviceWorker.controller` will be null even if a SW is registered. Don't rely on `controller` if you want to handle this case.
- **Scope matters.** A SW only controls pages under its scope, which defaults to the directory the sw.mjs was served from. Putting `sw.mjs` at the root (`/sw.mjs`) gives it the widest scope.
- **HTTPS required.** SWs only work on HTTPS or `localhost`.
- **Async lifecycle.** Many things happen out of order. Always use the lifecycle events; don't assume timing.
- **No DOM in SWs.** Can't access `document`, `window`, or any UI APIs.
- **`updatefound` doesn't always fire when you expect.** It only fires for changes detected during the page's lifetime. If a new SW was already installing when the page loaded, the event may have already fired before you attached a listener.

## In This Codebase

- `web/sw.mjs` - the service worker. See its header comment for the update mechanism design.
- `web/js/components/pl-app-shell.js` (`#initServiceWorker`) - page-side update detection and banner.
- `.kiro/steering/dev-checklist.md` - rules for bumping the VERSION constant.

### Caching design and the two use cases

App code (HTML/JS/CSS/assets) is cached **cache-first, keyed on the SW
`VERSION`**, stored in a cache named `photo-loka-${VERSION}`. This is safe
because code is immutable within a VERSION: on release builds it is embedded in
the Go binary; on dev builds it is served from `../web`. `/api/*` (API, media,
SSE) is never cached and always goes to the network.

The single invariant that makes this work: **every change under `web/` bumps
`VERSION` in `sw.mjs`** (see `dev-checklist.md`). Because the cache name is
keyed on VERSION, a bump creates a fresh empty cache and the `activate` handler
deletes the previous version's cache. Two use cases fall out of this:

1. **Prod - new binary while a PWA tab is open.** A new release ships a new
   binary with a bumped VERSION, so `sw.mjs` changes. The open page detects it
   (1-min poll while visible, or on tab focus via `visibilitychange`), installs
   the new SW (`skipWaiting`), activates it (`clients.claim`, old cache
   deleted), and shows the "App update available (vX -> vY)" banner. Clicking it
   reloads; the reload repopulates `photo-loka-${newVERSION}` from the new
   binary. The swap is atomic - the page never mixes old and new code.

2. **Dev - edit/reload loop.** Each edit bumps VERSION too, so the cache key
   changes on every change. The old version's cache is discarded on activate and
   the edited files are fetched fresh from `../web` into the new cache. The same
   banner appears (via the 1-min poll or tab focus), so new code loads at the
   appropriate time without a manual hard reload. Caching never serves a stale
   edit, precisely because VERSION always changes.

In both cases the update *detection* is driven solely by the `sw.mjs` byte diff
(the VERSION bump), independent of code caching; caching only changes what a
reload fetches (cache vs network), never whether an update is noticed.

## Further Reading

- [MDN: Service Worker API](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)
- [MDN: Using Service Workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers)
- [Web.dev: Service Worker Lifecycle](https://web.dev/articles/service-worker-lifecycle)
