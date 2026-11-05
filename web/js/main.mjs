// Theme (also loaded via <script> in index.html for early init, but import here
// ensures the module is in the graph for any component that needs toggleTheme)
import './theme.mjs';

// Import Shoelace components
import 'shoelace/components/icon/icon.js';
import 'shoelace/components/icon-button/icon-button.js';
import 'shoelace/components/rating/rating.js';
import 'shoelace/components/alert/alert.js';
import 'shoelace/components/dropdown/dropdown.js';
import 'shoelace/components/menu-item/menu-item.js';
import 'shoelace/components/menu/menu.js';
import 'shoelace/components/progress-bar/progress-bar.js';
import 'shoelace/components/dialog/dialog.js';
import 'shoelace/components/input/input.js';
import 'shoelace/components/button/button.js';
import 'shoelace/components/select/select.js';
import 'shoelace/components/option/option.js';
import 'shoelace/components/details/details.js';
import 'shoelace/components/badge/badge.js';
import 'shoelace/components/divider/divider.js';
import 'shoelace/components/popup/popup.js';
import 'shoelace/components/switch/switch.js';


// Import app components
import './components/pl-login-page.js';
import './components/pl-app-shell.js';
import './components/pl-thumb.js';
import './components/pl-album.js';
import './components/pl-album-name.js';
import './components/pl-day-section.js';
import './components/pl-gallery.js';
import './components/pl-gallery-controls.js';
import './components/pl-slide-media.js';
import './components/pl-slide.js';
import './components/pl-slideshow.js';
import './components/pl-map.js';
import './components/pl-item-info.js';
import './components/pl-face-thumb.js';
import './components/pl-frame-item.js';
import './components/pl-frame-manager.js';
import './components/pl-admin-settings.js';
import './components/pl-admin-indexer.js';
import './components/pl-admin-dashboard.js';
import './components/pl-admin-collections.js';
import './components/pl-admin-jobs.js';
import './components/pl-admin-users.js';
import './components/pl-collection-form.js';
import './components/pl-upload.js';

import { initRouter, router } from './router.mjs';

// PWA install prompt handling
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

// Service worker -> page navigation: when a push notification is clicked and a
// PWA window is already running, the service worker focuses it and posts a
// navigate message (hash-route navigation of a live window via client.navigate
// is unreliable across browsers, so we route through the app's own router).
// The url is a hash route like '/#/app/c/1/search/...'; Navigo (hash mode)
// wants the path without the leading '/#'.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate' && e.data.url) {
      router.navigate(e.data.url.replace(/^\/#/, ''));
    }
  });
}

// Event listeners for component communication
document.addEventListener('DOMContentLoaded', () => {
  // Initialize router after DOM is ready
  initRouter();
});
