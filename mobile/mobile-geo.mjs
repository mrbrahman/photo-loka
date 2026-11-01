// Geolocation shim: route navigator.geolocation to @capacitor/geolocation
// (Capacitor only).
//
// Problem: pl-map's "zoom to my location" calls the web
// navigator.geolocation.getCurrentPosition(). In a browser that triggers the
// browser's own permission prompt. Inside a Capacitor WebView the web API is
// gated behind NATIVE Android location permissions AND a runtime permission
// request that the bare WebView does not perform -- so getCurrentPosition
// returns error code 1 ("permission denied") immediately, with no prompt.
//
// Fix (same pattern as mobile-back's CloseWatcher shim): wrap
// navigator.geolocation.getCurrentPosition so it delegates to the
// @capacitor/geolocation plugin, which requests the native runtime permission
// (the real Android prompt) and reads the position. The result/error are mapped
// back to the web PositionCallback / PositionErrorCallback shapes so the web
// code (web/js/components/pl-map.js) is unchanged -- it still just calls
// navigator.geolocation.getCurrentPosition and gets a web-shaped result.
//
// Requires the ACCESS_FINE_LOCATION / ACCESS_COARSE_LOCATION manifest
// permissions. Import for side effects BEFORE main.mjs. Mobile only; the
// browser build never loads this and keeps the native web geolocation.
//
// Note: shims BOTH navigator.geolocation.getCurrentPosition (the actual fetch)
// and navigator.permissions.query({name:'geolocation'}) (pl-map reads the
// permission state from it to decide when to show the "Fetching location..."
// feedback). Without the permissions shim the WebView's Permissions API
// reports an unhelpful/absent state and the feedback never shows even though
// the fetch works.

import { Geolocation } from '@capacitor/geolocation';

// Web PositionError codes (the values pl-map switches on).
const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;
const TIMEOUT = 3;

// Map a Capacitor permission state ('granted'|'denied'|'prompt'|
// 'prompt-with-rationale') to a web PermissionStatus.state ('granted'|'denied'
// |'prompt'). Prefer precise, fall back to coarse.
function toWebPermState(perm) {
  const s = perm.location !== 'prompt' && perm.location !== undefined ? perm.location
    : perm.coarseLocation ?? perm.location;
  if (s === 'granted') return 'granted';
  if (s === 'denied') return 'denied';
  return 'prompt';
}

export function installGeolocationShim() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition = async (success, error, options = {}) => {
    try {
      // Trigger the native runtime prompt / check current grant. If the user
      // denies, this resolves to a denied state and we report code 1.
      const perm = await Geolocation.requestPermissions();
      const granted = perm.location === 'granted' || perm.coarseLocation === 'granted';
      if (!granted) {
        error && error({ code: PERMISSION_DENIED, message: 'Location permission denied' });
        return;
      }

      const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: !!options.enableHighAccuracy,
        timeout: options.timeout ?? 10000,
        maximumAge: options.maximumAge ?? 0,
      });

      // Map the Capacitor Position to the web GeolocationPosition shape pl-map
      // reads (position.coords.latitude / longitude).
      success && success({
        coords: {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          altitude: pos.coords.altitude,
          altitudeAccuracy: pos.coords.altitudeAccuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
        },
        timestamp: pos.timestamp,
      });
    } catch (e) {
      // Distinguish a denial from other failures where we can; default to
      // POSITION_UNAVAILABLE. A timeout from the plugin surfaces here too.
      const msg = String(e && e.message || e);
      const code = /denied|permission/i.test(msg) ? PERMISSION_DENIED
        : /time(d)? ?out/i.test(msg) ? TIMEOUT
        : POSITION_UNAVAILABLE;
      error && error({ code, message: msg });
    }
  };

  // Shim navigator.permissions.query for geolocation so pl-map's feedback logic
  // (which reads the permission state) works. Non-geolocation queries fall
  // through to the original implementation. The returned PermissionStatus-like
  // object reports the real state from the plugin; addEventListener is a no-op
  // (the plugin has no permission-change event, so "show feedback after grant"
  // is skipped -- the important "granted -> feedback now" path still works, and
  // getCurrentPosition's own prompt drives the grant regardless).
  if (navigator.permissions && navigator.permissions.query) {
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = async (desc) => {
      if (!desc || desc.name !== 'geolocation') return origQuery(desc);
      let state = 'prompt';
      try { state = toWebPermState(await Geolocation.checkPermissions()); } catch (e) { /* default prompt */ }
      return { state, status: state, onchange: null, addEventListener() {}, removeEventListener() {} };
    };
  }
}
