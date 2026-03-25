// Theme management - detection, toggle, persistence, Shoelace stylesheet swap

const STORAGE_KEY = 'rr-theme';
const DARK = 'dark';
const LIGHT = 'light';

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? DARK : LIGHT;
}

function getStoredTheme() {
  return localStorage.getItem(STORAGE_KEY);
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);

  // Shoelace dark theme requires the sl-theme-dark class on a container
  document.documentElement.classList.toggle('sl-theme-dark', theme === DARK);

  // Swap Shoelace theme stylesheet
  const lightLink = document.getElementById('sl-theme-light');
  const darkLink = document.getElementById('sl-theme-dark');
  if (lightLink) lightLink.disabled = (theme === DARK);
  if (darkLink) darkLink.disabled = (theme === LIGHT);

  // Update meta theme-color
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === DARK ? '#1e1e2e' : '#66b3ff';
}

// Initialize (may already be set by inline script in index.html to prevent flash)
const stored = getStoredTheme();
const initial = stored || getSystemTheme();
applyTheme(initial);

// Listen for OS preference changes (only if user hasn't explicitly chosen)
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  if (!getStoredTheme()) {
    applyTheme(e.matches ? DARK : LIGHT);
  }
});

export function getTheme() {
  return document.documentElement.getAttribute('data-theme') || LIGHT;
}

export function toggleTheme() {
  const next = getTheme() === DARK ? LIGHT : DARK;
  localStorage.setItem(STORAGE_KEY, next);
  applyTheme(next);
  return next;
}
