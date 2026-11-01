// Mobile bootstrap (Capacitor only). Runs before the web app boots.
//
// The web frontend talks to the API via relative paths, resolved against
// window.__API_BASE__ (see web/js/api-base.mjs). In the browser that base is ''
// (same-origin). In the packaged app the page origin is the WebView
// (http://localhost), not the server, so we must know the user's server URL
// and set window.__API_BASE__ before any app code runs.
//
// Flow:
//   1. Read the stored server URL from Capacitor Preferences.
//   2. If present   -> set window.__API_BASE__ and boot the normal app.
//   3. If absent    -> show the <pl-server-setup> intake screen; on submit it
//      stores the URL and calls back here to boot.
//
// This file lives under mobile/ and is only loaded by mobile/index.html, so the
// browser build (web/) never sees it and stays origin-pure.

import { Preferences } from '@capacitor/preferences';
import { initBackButton } from './mobile-back.mjs';
import { installGeolocationShim } from './mobile-geo.mjs';
import './pl-server-setup.mjs';

const SERVER_URL_KEY = 'serverUrl';

export async function getStoredServerUrl() {
  const { value } = await Preferences.get({ key: SERVER_URL_KEY });
  return value || null;
}

export async function setStoredServerUrl(url) {
  await Preferences.set({ key: SERVER_URL_KEY, value: url });
}

export async function clearStoredServerUrl() {
  await Preferences.remove({ key: SERVER_URL_KEY });
}

// Normalize a user-entered base: trim, drop a trailing slash. api-base.apiBase()
// also strips a trailing slash defensively, but we store it clean.
function normalizeUrl(url) {
  const u = url.trim();
  return u.endsWith('/') ? u.slice(0, -1) : u;
}

// Boot the real web app: set the global base, then dynamically import main.mjs
// (which wires components and starts the router). Dynamic import ensures no app
// code runs until the base is set.
//
// The path is relative to THIS module's runtime URL. After bundling, this file
// emits to www/js/mobile-boot.mjs and main.mjs sits beside it at www/js/main.mjs,
// so the sibling './main.mjs' is correct. It is marked external in build.sh so
// esbuild leaves it as a runtime import (main.mjs is bundled separately).
async function bootApp(baseUrl) {
  window.__API_BASE__ = baseUrl;
  await import('./main.mjs');
}

// Entry point, invoked at the bottom of mobile/index.html.
export async function boot() {
  // Install the CloseWatcher shim + hardware back-button handler BEFORE any app
  // code (main.mjs) runs, so every CloseWatcher a component creates is tracked.
  initBackButton();
  // Route navigator.geolocation through @capacitor/geolocation so the map's
  // "zoom to my location" gets a native permission prompt (also before main.mjs).
  installGeolocationShim();

  const stored = await getStoredServerUrl();
  if (stored) {
    await bootApp(stored);
    return;
  }

  // No server configured yet: show the intake screen. It emits
  // 'pl-server-configured' with the validated, normalized URL.
  const root = document.getElementById('app-root');
  const setup = document.createElement('pl-server-setup');
  setup.addEventListener('pl-server-configured', async (e) => {
    const url = normalizeUrl(e.detail.url);
    await setStoredServerUrl(url);
    root.innerHTML = '';
    await bootApp(url);
  });
  root.innerHTML = '';
  root.appendChild(setup);
}
