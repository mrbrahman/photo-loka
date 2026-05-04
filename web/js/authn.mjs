// Authentication utilities for token management

const TOKEN_KEY = 'accessToken';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated() {
  return !!getToken();
}

export async function login(username, password) {
  const response = await fetch('/api/authn/login', {
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
  return data.user;
}

export async function logout() {
  try {
    await fetch('/api/authn/logout', { method: 'POST' });
  } catch (err) {
    console.error('Logout error:', err);
  }
  clearToken();
}

export async function refreshToken() {
  const response = await fetch('/api/authn/refresh', { method: 'POST' });
  
  if (!response.ok) {
    clearToken();
    throw new Error('Token refresh failed');
  }

  const data = await response.json();
  setToken(data.accessToken);
  return data.user;
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

// Fetch wrapper that adds auth header and handles 401
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
      throw new Error('Session expired');
    }
  }

  return response;
}
