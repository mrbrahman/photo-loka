import 'https://unpkg.com/navigo';

import { isAuthenticated, logout } from './authn.mjs';

const router = new Navigo('/', { hash: true });

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
