import 'navigo';

import { isAuthenticated, isAdmin, logout } from './authn.mjs';

const router = new Navigo('/', { hash: true });

const STORAGE_KEY = 'pl-active-collection';

function getStoredCollectionId() {
  return localStorage.getItem(STORAGE_KEY);
}

function setStoredCollectionId(id) {
  localStorage.setItem(STORAGE_KEY, id);
}

function ensureAppShell() {
  const root = document.getElementById('app-root');
  let appShell = root.querySelector('pl-app-shell');

  if (!appShell) {
    appShell = document.createElement('pl-app-shell');
    root.innerHTML = '';
    root.appendChild(appShell);

    appShell.addEventListener('pl-logout-request', async () => {
      await logout();
      root.innerHTML = '';
      router.navigate('/login');
    });
  }

  return appShell;
}

function authGuard() {
  if (!isAuthenticated()) {
    const intendedRoute = window.location.hash.substring(2);
    router.navigate(`/login?goto=${encodeURIComponent(intendedRoute)}`);
    return false;
  }
  return true;
}

function adminGuard() {
  if (!isAuthenticated()) {
    const intendedRoute = window.location.hash.substring(2);
    router.navigate(`/login?goto=${encodeURIComponent(intendedRoute)}`);
    return false;
  }
  if (!isAdmin()) {
    router.navigate('/app');
    return false;
  }
  return true;
}

/**
 * Resolves the collection id from the route param, updates localStorage.
 */
function resolveCollectionId(match) {
  let id = match.data.collectionId;
  setStoredCollectionId(id);
  return parseInt(id);
}

export function initRouter() {
  router.on('/login', () => {
    if (isAuthenticated()) {
      const params = new URLSearchParams(window.location.hash.split('?')[1]);
      router.navigate(params.get('goto') || '/app');
      return;
    }
    document.getElementById('app-root').innerHTML = '<pl-login-page></pl-login-page>';
  });

  router.on('/', () => {
    router.navigate(isAuthenticated() ? '/app' : '/login');
  });

  // --- /app redirect: resolve collection and redirect to /app/c/:id ---

  router.on('/app', () => {
    if (!authGuard()) return;
    let shell = ensureAppShell();
    // Wait for collections to be loaded, then redirect
    shell.resolveDefaultCollectionId().then(id => {
      router.navigate(`/app/c/${id}`);
    });
  });

  // --- App routes with collection id ---

  router.on('/app/c/:collectionId', (match) => {
    if (!authGuard()) return;
    let collectionId = resolveCollectionId(match);
    ensureAppShell().route('gallery', { collectionId });
  });

  router.on('/app/c/:collectionId/slideshow/:itemId', (match) => {
    if (!authGuard()) return;
    let collectionId = resolveCollectionId(match);
    ensureAppShell().route('gallery', { collectionId, slideshowItemId: match.data.itemId });
  });

  router.on('/app/c/:collectionId/search/:searchText', (match) => {
    if (!authGuard()) return;
    let collectionId = resolveCollectionId(match);
    ensureAppShell().route('search', { collectionId, searchText: match.data.searchText });
  });

  router.on('/app/c/:collectionId/search/:searchText/slideshow/:itemId', (match) => {
    if (!authGuard()) return;
    let collectionId = resolveCollectionId(match);
    ensureAppShell().route('search', {
      collectionId,
      searchText: match.data.searchText,
      slideshowItemId: match.data.itemId
    });
  });

  router.on('/app/c/:collectionId/trash', (match) => {
    if (!authGuard()) return;
    let collectionId = resolveCollectionId(match);
    ensureAppShell().route('trash', { collectionId });
  });

  router.on('/app/c/:collectionId/trash/slideshow/:itemId', (match) => {
    if (!authGuard()) return;
    let collectionId = resolveCollectionId(match);
    ensureAppShell().route('trash', { collectionId, slideshowItemId: match.data.itemId });
  });

  router.on('/app/c/:collectionId/map', (match) => {
    if (!authGuard()) return;
    let collectionId = resolveCollectionId(match);
    ensureAppShell().route('map', { collectionId });
  });

  // --- Admin routes ---

  router.on('/admin', () => {
    if (!adminGuard()) return;
    ensureAppShell().route('dashboard', { mode: 'admin' });
  });

  router.on('/admin/dashboard', () => {
    if (!adminGuard()) return;
    ensureAppShell().route('dashboard', { mode: 'admin' });
  });

  router.on('/admin/settings', () => {
    if (!adminGuard()) return;
    ensureAppShell().route('settings', { mode: 'admin' });
  });

  router.on('/admin/frames', () => {
    if (!adminGuard()) return;
    ensureAppShell().route('frames', { mode: 'admin' });
  });

  router.on('/admin/indexer', () => {
    if (!adminGuard()) return;
    ensureAppShell().route('indexer', { mode: 'admin' });
  });

  router.on('/admin/jobs', () => {
    if (!adminGuard()) return;
    ensureAppShell().route('jobs', { mode: 'admin' });
  });

  router.on('/admin/collections', () => {
    if (!adminGuard()) return;
    ensureAppShell().route('collections', { mode: 'admin' });
  });

  router.on('/admin/users', () => {
    if (!adminGuard()) return;
    ensureAppShell().route('users', { mode: 'admin' });
  });

  router.resolve();
}

export { router, getStoredCollectionId, setStoredCollectionId };
