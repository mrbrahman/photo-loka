// Import Shoelace components
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/icon/icon.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/icon-button/icon-button.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/rating/rating.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/alert/alert.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/dropdown/dropdown.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/menu-item/menu-item.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/menu/menu.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/progress-bar/progress-bar.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/dialog/dialog.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/input/input.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/button/button.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/select/select.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/option/option.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/details/details.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/badge/badge.js';

// Import app components
import './components/pl-login-page.js';
import './components/pl-app-shell.js';
import './components/pl-thumb.js';
import './components/pl-album.js';
import './components/pl-album-name.js';
import './components/pl-gallery.js';
import './components/pl-gallery-controls.js';
import './components/pl-slide.js';
import './components/pl-slideshow.js';
import './components/pl-map.js';
import './components/pl-carousel.js';
import './components/pl-frame-item.js';
import './components/pl-frame-manager.js';

import { initRouter } from './router.mjs';

// PWA install prompt handling
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

// Event listeners for component communication
document.addEventListener('DOMContentLoaded', () => {
  // Initialize router after DOM is ready
  initRouter();
});
