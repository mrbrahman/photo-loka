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
// Note: only getCurrentPosition is shimmed (the one call pl-map makes). The
// web code also calls navigator.permissions.query({name:'geolocation'}) for
// loading-spinner UX; that is left alone and its try/catch falls through
// harmlessly if the WebView does not support it.

import { Geolocation } from '@capacitor/geolocation';

// Web PositionError codes (the values pl-map switches on).
const PERMISSION_DENIED = 1;
const POSITION_UNAVAILABLE = 2;
const TIMEOUT = 3;

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
}
