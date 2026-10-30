// Server URL base for all API, media, and SSE requests.
//
// Every server URL in the app is constructed through apiUrl(). In the browser,
// the app is served from the same origin as the API, so the base is '' and
// apiUrl('/api/foo') returns the relative '/api/foo' (unchanged behavior). In a
// packaged app (Capacitor WebView) the page origin is not the server, so a
// mobile-only bootstrap sets window.__API_BASE__ to the user-entered server URL
// (e.g. 'http://192.168.1.50:9000') before the app boots, and apiUrl() prefixes
// it. The base value is read at call time so the mobile layer can set it at
// runtime (the server URL is user-entered, not known at build time).
//
// The base must not end with a trailing slash; paths passed in must start with
// '/'. apiUrl normalizes a single trailing slash on the base defensively.

export function apiBase() {
  const b = (typeof window !== 'undefined' && window.__API_BASE__) || '';
  return b.endsWith('/') ? b.slice(0, -1) : b;
}

export function apiUrl(path) {
  return apiBase() + path;
}

// Whether this build must carry the refresh token itself (header-based) rather
// than relying on the server's HttpOnly refreshToken cookie. True only when a
// server base is configured, i.e. a packaged app (Capacitor WebView) talking
// cross-origin, where the cookie is not sent. In the browser this is false, so
// the refresh token stays strictly in the HttpOnly cookie and is never copied
// into JS-readable storage.
export function usesHeaderRefreshToken() {
  return apiBase() !== '';
}

