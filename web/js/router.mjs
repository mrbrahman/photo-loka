import 'https://unpkg.com/navigo';

import { isAuthenticated, authenticatedFetch } from './authn.mjs';
import { notify, showProgressBar, hideProgressBar } from './utils.mjs';

export const router = new Navigo('/', { hash: true });

export const state = {
  collection_id: 1,
  galleryData: null,
  prevLink: null
};

// Helper to ensure app shell is rendered
function ensureShell() {
  const root = document.getElementById('app-root');
  let appShell = root.querySelector('pl-app-shell');
  
  if (!appShell) {
    root.innerHTML = '<pl-app-shell></pl-app-shell>';
    appShell = root.querySelector('pl-app-shell');
    router.updatePageLinks();
  }
  
  return appShell;
}

// Helper to show gallery
function showGallery(data) {
  state.galleryData = data;
  const appShell = ensureShell();
  appShell.style.overflowY = 'hidden';
  
  if (data.length === 0) {
    appShell.innerHTML = '<div style="padding: 2rem; text-align: center;">No results found</div>';
    return;
  }

  const gallery = Object.assign(document.createElement('pl-gallery'), { data });
  appShell.innerHTML = '';
  appShell.appendChild(gallery);

  const totalItems = data.map(x => x.items.length).reduce((a, c) => a + c, 0);
  notify(`Found ${data.length.toLocaleString()} albums containing ${totalItems.toLocaleString()} items`);
}

export function initRouter() {
  // Global authentication guard - protects all routes except login
  // This prevents the need to add auth checks in every route handler
  router.hooks({
    before: (done, match) => {
      // Public routes that don't require authentication
      if (match.url === '/login' || match.url.startsWith('/login?')) {
        done();
        return;
      }
      
      // Block unauthorized access to protected routes
      if (!isAuthenticated()) {
        // done(false) prevents the route handler from executing
        done(false);
        
        // Render login page directly instead of using router.navigate('/login?goto=...')
        // This approach prevents double-rendering and avoids re-triggering this hook,
        // which would happen if we used router.navigate() from within the hook itself.
        // We then manually update the URL below to reflect the login state.
        const root = document.getElementById('app-root');
        root.innerHTML = '<pl-login-page></pl-login-page>';
        
        // Store intended destination in URL for post-login redirect
        // Using window.history.replaceState instead of router.navigate to avoid
        // triggering another navigation cycle and re-entering this hook
        const intendedRoute = match.url === '/' ? '' : match.url;
        if (intendedRoute) {
          window.history.replaceState(null, '', `#/login?goto=${encodeURIComponent(intendedRoute)}`);
        } else {
          window.history.replaceState(null, '', '#/login');
        }
        return;
      }
      
      // User is authenticated, allow route to proceed
      done();
    }
  });

  // Login route - handles direct visits and post-auth redirects
  router.on('/login', () => {
    // If already authenticated, redirect to intended destination
    if (isAuthenticated()) {
      const params = new URLSearchParams(window.location.hash.split('?')[1]);
      const goto = params.get('goto');
      router.navigate(goto || '/');
      return;
    }
    
    // Show login page for unauthenticated direct visits
    const root = document.getElementById('app-root');
    root.innerHTML = '<pl-login-page></pl-login-page>';
  });

  // Not found route
  router.notFound(() => {
    const root = document.getElementById('app-root');
    if (isAuthenticated()) {
      const appShell = ensureShell();
      appShell.innerHTML = `
        <div style="padding: 2rem; text-align: center;">
          <h1>404 - Page Not Found</h1>
          <p>The page you're looking for doesn't exist.</p>
          <a href="/" data-navigo>Go Home</a>
        </div>
      `;
      router.updatePageLinks();
    } else {
      root.innerHTML = `
        <div style="padding: 2rem; text-align: center;">
          <h1>404 - Page Not Found</h1>
          <p>The page you're looking for doesn't exist.</p>
          <a href="/login">Login</a>
        </div>
      `;
    }
  });

  // Protected routes - authentication is enforced by global hook above
  router.on('/', async () => {
    if (document.querySelector('pl-slideshow')) {
      document.querySelector('pl-slideshow').remove();
      const shell = ensureShell();
      shell.shadowRoot.getElementById('nav-header').style.opacity = 1;
      shell.style.opacity = 1;
      return;
    }

    showProgressBar();

    try {
      const res = await authenticatedFetch('/api/getAll');
      if (!res.ok) throw `${res.status} ${res.statusText}`;
      const result = await res.json();
      showGallery(result);
    } catch (err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    } finally {
      hideProgressBar();
    }
  });

  router.on('/search/:searchText', async (params) => {
    if (document.querySelector('pl-slideshow')) {
      document.querySelector('pl-slideshow').remove();
      const shell = ensureShell();
      shell.shadowRoot.getElementById('nav-header').style.opacity = 1;
      shell.style.opacity = 1;
      return;
    }

    showProgressBar();

    try {
      const res = await authenticatedFetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          collection_id: state.collection_id, 
          searchText: params.data.searchText 
        })
      });
      
      if (!res.ok) throw `${res.status} ${res.statusText}`;
      const result = await res.json();
      showGallery(result);
    } catch (err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    } finally {
      hideProgressBar();
    }
  });

  router.on('/map', () => {
    const appShell = ensureShell();
    const mapComponent = document.createElement('pl-map');
    
    appShell.innerHTML = '';
    appShell.style.overflowY = 'hidden';
    appShell.appendChild(mapComponent);
  });

  router.on('/frames', () => {
    const appShell = ensureShell();
    const framesManager = document.createElement('pl-frame-manager');
    
    appShell.innerHTML = '';
    appShell.style.overflowY = 'auto';
    appShell.appendChild(framesManager);
  });

  router.on('/slideshow/:startFrom', (params) => {
    state.prevLink = router.lastResolved();
    
    const shell = ensureShell();
    shell.shadowRoot.getElementById('nav-header').style.opacity = 0;
    shell.style.opacity = 0;

    const slideshow = Object.assign(document.createElement('pl-slideshow'), {
      data: state.galleryData,
      startFrom: params.data.startFrom,
      buffer: 1
    });

    document.getElementById('app-root').appendChild(slideshow);
  });

  router.resolve();
}
