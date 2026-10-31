// Android hardware back-button -> close in-app overlays (Capacitor only).
//
// Problem: our overlays (slideshow, info panel, album-name editor, selection
// controls) AND Shoelace's dialog/drawer/dropdown all dismiss via the web
// CloseWatcher API. In a plain browser CloseWatcher catches the Android back
// gesture; inside a Capacitor WebView the native BridgeActivity intercepts the
// hardware back first, so CloseWatcher never fires and the app exits instead of
// closing the overlay.
//
// Fix (validated on-device): wrap window.CloseWatcher so every watcher the page
// creates -- ours and Shoelace's, since both do `new CloseWatcher()` -- is
// tracked in a LIFO stack. The @capacitor/app backButton listener then closes
// the topmost watcher via requestClose() (which fires its onclose, running the
// component's own close logic), falling back to history.back() and finally
// App.exitApp(). requestClose() was verified to trigger onclose, and wrapping
// preserves instanceof + onclose + destroy().
//
// Import this module for its side effects BEFORE importing main.mjs, so the
// wrapper is in place before any component constructs a CloseWatcher. Mobile
// only (loaded via mobile-boot); the browser build never imports it.

import { App } from '@capacitor/app';

// installCloseWatcherShim wraps the global CloseWatcher constructor to maintain
// a LIFO stack of live watchers. Idempotent and a no-op if CloseWatcher is
// unavailable (then overlays fall back to their own Escape handling and the
// back button uses history/exit only).
function installCloseWatcherShim() {
  if (typeof window === 'undefined') return () => false;
  const Native = window.CloseWatcher;
  if (typeof Native !== 'function') {
    // No CloseWatcher: nothing to track. handleBack() reports "not consumed".
    return () => false;
  }

  const stack = [];

  function Wrapped(options) {
    const w = new Native(options);
    const entry = { w };
    stack.push(entry);
    const remove = () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
    // Drop from the stack however it closes (back, Esc, programmatic, X button).
    w.addEventListener('close', remove);
    const origDestroy = w.destroy.bind(w);
    w.destroy = () => { remove(); origDestroy(); };
    return w;
  }
  // Preserve prototype so `instanceof CloseWatcher` and any prototype access
  // keep working (Shoelace and our code only touch instance members, but this
  // keeps the wrapper transparent).
  Wrapped.prototype = Native.prototype;
  window.CloseWatcher = Wrapped;

  // Close the topmost overlay. Returns true if one was closed (consumed the
  // back press), false if there was nothing to close.
  return function handleBack() {
    const entry = stack[stack.length - 1];
    if (!entry) return false;
    entry.w.requestClose(); // fires onclose -> component hides; 'close' event pops it
    return true;
  };
}

// initBackButton installs the CloseWatcher shim and registers the Capacitor
// backButton listener. Call once, before booting the web app.
export function initBackButton() {
  const handleBack = installCloseWatcherShim();
  // Exposed for debugging / potential reuse; also lets non-Capacitor callers
  // trigger the same close logic if ever needed.
  window.__plHandleBack = handleBack;

  // A "root" route is the app home where back should EXIT the app: the gallery
  // (#/app/c/<id> with nothing after the id), the bare #/app redirect, the
  // login page, or an empty hash. We decide from the hash rather than
  // history.back(): the hash router accumulates stale slideshow/search entries,
  // so walking raw history ping-pongs between a slide and the gallery instead
  // of exiting (observed bug).
  function isRootRoute() {
    const h = (location.hash || '').replace(/^#/, '');
    if (h === '' || h === '/' || h === '/app' || h.startsWith('/login')) return true;
    // #/app/c/<id> exactly (gallery root) -> root. Deeper (/slideshow, /search,
    // /trash, /map) has more segments and is NOT root.
    return /^\/app\/c\/[^/]+$/.test(h);
  }

  App.addListener('backButton', () => {
    // 1. Close the topmost open overlay (slideshow, info panel, sl-dialog, ...).
    if (handleBack()) return;
    // 2. On a deeper route (search/trash/map/admin), go back to the gallery
    //    home. Use replace so we do not grow the history we just chose not to
    //    walk. The router resolves #/app to the default collection gallery.
    if (!isRootRoute()) {
      location.replace(location.pathname + location.search + '#/app');
      return;
    }
    // 3. At a root route with nothing open -> leave the app.
    App.exitApp();
  });
}
