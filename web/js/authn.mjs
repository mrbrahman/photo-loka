// Authentication utilities for token management

import { apiUrl, usesHeaderRefreshToken } from './api-base.mjs';

const TOKEN_KEY = 'accessToken';
const REFRESH_TOKEN_KEY = 'refreshToken';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

// Refresh token storage. In the browser the refresh token lives ONLY in an
// HttpOnly cookie set by the server -- it is never copied into JS-readable
// storage, so getRefreshToken returns null and the cookie rides along with
// requests automatically. In a packaged app (Capacitor) cross-origin cookies
// are not sent, so the app must carry the token itself: it persists the token
// returned in the login/refresh response body and sends it back via the
// X-Refresh-Token header. setRefreshToken is a no-op unless this build is the
// header-based (packaged) one, which keeps the browser's HttpOnly posture
// intact. Keeping this here makes authn.mjs the single owner of token
// persistence; the mobile build may swap the backing store (e.g. Capacitor
// Preferences) without changing call sites.
export function getRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setRefreshToken(token) {
  // Browser build: do not persist; the HttpOnly cookie is the sole store.
  if (!usesHeaderRefreshToken()) return;
  if (token) localStorage.setItem(REFRESH_TOKEN_KEY, token);
}

export function clearRefreshToken() {
  localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function isAuthenticated() {
  return !!getToken();
}

export async function login(username, password) {
  const response = await fetch(apiUrl('/api/authn/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Login failed');
  }

  const data = await response.json();
  setToken(data.accessToken);
  // Browser: HttpOnly cookie holds the refresh token; setRefreshToken no-ops.
  // Mobile: persist the body token for header-based refresh/logout.
  setRefreshToken(data.refreshToken);
  return data.user;
}

export async function logout() {
  try {
    await fetch(apiUrl('/api/authn/logout'), { method: 'POST', headers: refreshTokenHeader() });
  } catch (err) {
    console.error('Logout error:', err);
  }
  clearToken();
  clearRefreshToken();
}

// Build the X-Refresh-Token header when a stored refresh token exists. Empty in
// the browser (no stored token -> server reads the HttpOnly cookie instead).
function refreshTokenHeader() {
  const rt = getRefreshToken();
  return rt ? { 'X-Refresh-Token': rt } : {};
}

// Singleton refresh promise to prevent parallel refresh race conditions.
// When multiple 401s trigger simultaneously, only one refresh request is made.
let refreshPromise = null;

export async function refreshToken() {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const response = await fetch(apiUrl('/api/authn/refresh'), {
      method: 'POST',
      headers: refreshTokenHeader()
    });

    if (!response.ok) {
      clearToken();
      clearRefreshToken();
      throw new Error('Token refresh failed');
    }

    const data = await response.json();
    setToken(data.accessToken);
    // Refresh rotates the token; persist the new one (mobile). Browser ignores.
    setRefreshToken(data.refreshToken);
    return data.user;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

// Decode JWT payload to extract user info (client-side only, server verifies)
export function getUserInfo() {
  const token = getToken();
  if (!token) return null;

  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(atob(payload));
    return { userId: decoded.userId, username: decoded.username, role: decoded.role };
  } catch (e) {
    return null;
  }
}

export function isAdmin() {
  return getUserInfo()?.role === 'admin';
}

// Fetch wrapper that adds auth header and handles 401.
// The caller passes an already-resolved URL (via apiUrl()); this wrapper does
// not construct or rewrite URLs -- it only adds the Authorization header and
// retries once after a token refresh on 401.
export async function authenticatedFetch(url, options = {}) {
  const token = getToken();
  
  const headers = {
    ...options.headers,
    'Authorization': `Bearer ${token}`
  };

  let response = await fetch(url, { ...options, headers });

  // Try to refresh token on 401
  if (response.status === 401) {
    try {
      await refreshToken();
      // Retry with new token
      const newToken = getToken();
      headers['Authorization'] = `Bearer ${newToken}`;
      response = await fetch(url, { ...options, headers });
    } catch (err) {
      clearToken();
      clearRefreshToken();
      throw new Error('Session expired');
    }
  }

  return response;
}
