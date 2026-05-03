import 'https://unpkg.com/navigo';

import { isAuthenticated, logout } from './authn.mjs';

const router = new Navigo('/', { hash: true });

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

  router.on('/app', () => {
    if (!authGuard()) return;
    ensureAppShell().route('gallery');
  });

  router.on('/app/slideshow/:itemId', (match) => {
    if (!authGuard()) return;
    ensureAppShell().route('gallery', { slideshowItemId: match.data.itemId });
  });

  router.on('/app/search/:searchText', (match) => {
    if (!authGuard()) return;
    ensureAppShell().route('search', { searchText: match.data.searchText });
  });

  router.on('/app/search/:searchText/slideshow/:itemId', (match) => {
    if (!authGuard()) return;
    ensureAppShell().route('search', {
      searchText: match.data.searchText,
      slideshowItemId: match.data.itemId
    });
  });

  router.on('/app/trash', () => {
    if (!authGuard()) return;
    ensureAppShell().route('trash');
  });

  router.on('/app/trash/slideshow/:itemId', (match) => {
    if (!authGuard()) return;
    ensureAppShell().route('trash', { slideshowItemId: match.data.itemId });
  });

  router.on('/app/map', () => {
    if (!authGuard()) return;
    ensureAppShell().route('map');
  });

  router.on('/app/frames', () => {
    if (!authGuard()) return;
    ensureAppShell().route('frames');
  });

  router.resolve();
}

export { router };

