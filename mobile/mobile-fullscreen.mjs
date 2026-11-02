// Fullscreen API polyfill -> Android immersive-sticky (Capacitor only).
//
// The shared slideshow (web/js/components/pl-slideshow.js) asks for real
// fullscreen with element.requestFullscreen() and ends the slideshow when it
// sees a `fullscreenchange` that exits.
//
// The modern Android System WebView DOES expose a native Fullscreen API, but
// Capacitor's default WebChromeClient does not implement immersive mode for it:
// native requestFullscreen() fires the events yet leaves the status +
// navigation bars on screen (and it needs a user gesture). So the native path
// is useless for our goal of true edge-to-edge slides. We deliberately take it
// over with the PLImmersive bridge instead.
//
// This shim polyfills the Fullscreen API on top of the native PLImmersive
// bridge (MainActivity, via WindowInsetsController -> immersive-sticky):
//   - element.requestFullscreen() -> PLImmersive.enter() (hide both system
//     bars, swipe reveals them transiently), set document.fullscreenElement,
//     dispatch `fullscreenchange`.
//   - document.exitFullscreen()    -> PLImmersive.exit() (restore the bars),
//     clear document.fullscreenElement, dispatch `fullscreenchange`.
// The web slideshow code is unchanged -- it drives real fullscreen through the
// standard API, which now has a native meaning in the app. On stop (back
// button, close, last slide), the slideshow calls exitFullscreen(), so the
// bars are always restored however the slideshow ends.
//
// Import for side effects BEFORE main.mjs. Mobile only; the browser keeps its
// native Fullscreen API. No-op if the native bridge is missing.

export function installFullscreenShim() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const bridge = window.PLImmersive;
  // Install only in the app (PLImmersive present). We intentionally override
  // the WebView's native Fullscreen API: it does not hide the system bars, so
  // our immersive bridge must be the one that drives fullscreen here. The
  // browser has no PLImmersive, so its real Fullscreen API is left untouched.
  if (!bridge) return;

  let fsElement = null;

  // The real Fullscreen API dispatches `fullscreenchange` on the element that
  // entered/left fullscreen, and it bubbles up to document. The slideshow
  // listens on the element (this.addEventListener('fullscreenchange', ...)),
  // so we must fire on the element with bubbles:true, not on document alone --
  // otherwise the element listener never runs and exit is never detected.
  const fireChange = (target) => {
    (target || document).dispatchEvent(
      new Event('fullscreenchange', { bubbles: true })
    );
  };

  // document.fullscreenElement: web code reads this to know if it is fullscreen.
  // The native accessor may be non-configurable on the Document instance; fall
  // back to defining it on the prototype if the instance define is rejected.
  try {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fsElement,
    });
  } catch (e) {
    try {
      Object.defineProperty(Document.prototype, 'fullscreenElement', {
        configurable: true,
        get: () => fsElement,
      });
    } catch (e2) { /* ignore */ }
  }

  // element.requestFullscreen(): enter immersive, remember the element, notify.
  Element.prototype.requestFullscreen = function () {
    try { bridge.enter(); } catch (e) { /* ignore */ }
    fsElement = this;
    // fullscreenchange must fire after the current task, like the real API,
    // on the element that went fullscreen (bubbles to document).
    const target = this;
    setTimeout(() => fireChange(target), 0);
    return Promise.resolve();
  };

  // document.exitFullscreen(): leave immersive, clear, notify.
  document.exitFullscreen = function () {
    try { bridge.exit(); } catch (e) { /* ignore */ }
    if (fsElement) {
      const prev = fsElement;
      fsElement = null;
      setTimeout(() => fireChange(prev), 0);
    }
    return Promise.resolve();
  };
}
