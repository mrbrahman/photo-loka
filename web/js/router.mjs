import 'https://unpkg.com/navigo';

import { isAuthenticated, logout } from './authn.mjs';

const router = new Navigo('/', { hash: true });

/*
 * ARCHITECTURE NOTE: The 2-Router Design
 * 
 * This application uses a nested routing architecture involving two Navigo instances:
 * 1. The Global Router (here in router.mjs)
 * 2. The App Shell Router (inside pl-app-shell.js)
 * 
 * Navigo is typically designed as a singleton router. When using multiple instances,
 * both routers will listen to the same global window hashchange/popstate events.
 * This naturally creates a "race condition" where both routers evaluate every URL change.
 * 
 * WHY THIS WORKS SAFELY:
 * The potential pitfalls of this race condition are elegantly overcome through idempotency.
 * When the inner pl-app-shell navigates to a new route (e.g., '#/app/map'), the global
 * router's wildcard catch-all ('/app*') also fires. However, instead of re-rendering, 
 * the global router simply acts as a secure "bouncer":
 *   - It verifies the user is still authenticated.
 *   - It checks if the <pl-app-shell> already exists in the DOM.
 *   - If the shell exists, it does absolutely nothing, safely yielding control to the inner router.
 * 
 * BENEFITS:
 * - True component encapsulation: pl-app-shell remains self-contained and manages its own views.
 * - Clear separation of concerns: router.mjs handles auth and high-level layout, while the app 
 *   shell orchestrates its own micro-frontend state without needing to import this router module.
 */

export function initRouter() {
  // Login route - handles direct visits and post-auth redirects
  router.on('/login', () => {
    // If already authenticated, redirect to intended destination
    if (isAuthenticated()) {
      const params = new URLSearchParams(window.location.hash.split('?')[1]);
      const goto = params.get('goto') || '/app';
      router.navigate(goto);
      return;
    }

    // Show login page for unauthenticated direct visits
    const root = document.getElementById('app-root');
    root.innerHTML = '<pl-login-page></pl-login-page>';
  });

  router.on('/', () => {
    if (isAuthenticated()) {
      router.navigate('/app');
    } else {
      router.navigate('/login');
    }
  });

  // Protected routes - authentication is checked here
  router.on('/app*', () => {
    if (!isAuthenticated()) {
      const intendedRoute = window.location.hash.substring(2);
      router.navigate(`/login?goto=${encodeURIComponent(intendedRoute)}`);
      return;
    }

    const root = document.getElementById('app-root');
    let appShell = root.querySelector('pl-app-shell');

    if (!appShell) {
      appShell = document.createElement('pl-app-shell');
      root.innerHTML = '';
      root.appendChild(appShell);

      // Listen for logout requests from app-shell
      appShell.addEventListener('pl-logout-request', async () => {
        await logout();
        root.innerHTML = '';
        router.navigate('/login');
      });
    }
  });

  router.resolve();
}
