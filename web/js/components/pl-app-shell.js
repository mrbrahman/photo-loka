import { notify } from '../utils.mjs';
import { authenticatedFetch } from '../authn.mjs';
import { getTheme, toggleTheme } from '../theme.mjs';
import { router } from '../router.mjs';

import sheet from "./styles/pl-app-shell.css" with { type: "css" };


class PlAppShell extends HTMLElement {

  #state = {
    collection_id: 1
  };

  #mainContent = null; #progressBar = null; #sidebar = null; #backdrop = null;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <div id="app-container">
        <sl-progress-bar id="progress-bar" class="hide"></sl-progress-bar>

        <nav id="nav-header">
          <sl-icon-button class="nav-item" id="hamburger-btn" name="list" label="Menu"></sl-icon-button>

          <a class="nav-item" id="nav-logo" href="/">
            <img id="logo" src="assets/R3-resized.png" alt="Relive!">
          </a>

          <a class="nav-item" id="nav-title" href="/">
            Rewind, Replay & Relive!
          </a>

          <input class="nav-item" id="nav-search-box" type="search" placeholder="Search your memories..."/>

          <sl-dropdown class="nav-item">
            <sl-icon-button slot="trigger" name="person-circle" label="Account"></sl-icon-button>
            <sl-menu>
              <sl-menu-item id="my-account-btn" disabled>
                <sl-icon slot="prefix" name="person-gear"></sl-icon>
                My Account
              </sl-menu-item>
              <sl-menu-item id="logout-btn">
                <sl-icon slot="prefix" name="box-arrow-right"></sl-icon>
                Logout
              </sl-menu-item>
            </sl-menu>
          </sl-dropdown>
        </nav>

        <div id="content-area">
          <nav id="sidebar">
            <div id="sidebar-nav">
              <!-- TODO: uncomment when multiple collections are supported
              <div class="sidebar-section-label">Collections</div>
              <a class="sidebar-item" data-route="/" data-collection-id="1">
                <sl-icon name="folder-fill"></sl-icon>
                <span>My Collection</span>
              </a>

              <sl-divider></sl-divider>
              -->

              <a class="sidebar-item" data-route="/">
                <sl-icon name="images"></sl-icon>
                <span>Photos</span>
              </a>
              <a class="sidebar-item" data-route="/map">
                <sl-icon name="geo-alt-fill"></sl-icon>
                <span>Map</span>
              </a>
              <a class="sidebar-item" data-route="/frames">
                <sl-icon name="display"></sl-icon>
                <span>Frames</span>
              </a>
              <a class="sidebar-item" data-route="/faces" disabled>
                <sl-icon name="person-circle"></sl-icon>
                <span>Faces</span>
              </a>
              <a class="sidebar-item" data-route="/trash" disabled>
                <sl-icon name="trash"></sl-icon>
                <span>Trash</span>
              </a>

              <div class="sidebar-spacer"></div>

              <sl-divider></sl-divider>

              <a class="sidebar-item" data-route="/settings" disabled>
                <sl-icon name="gear"></sl-icon>
                <span>Settings</span>
              </a>
              <a class="sidebar-item" id="theme-toggle">
                <sl-icon id="theme-icon" name="moon"></sl-icon>
                <span id="theme-label">Dark mode</span>
              </a>
            </div>
          </nav>

          <div id="sidebar-backdrop"></div>

          <main id="main-content"></main>
        </div>
      </div>
    `;
  }

  constructor() {
    super().attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
    this.#mainContent = this.shadowRoot.getElementById('main-content');
    this.#progressBar = this.shadowRoot.getElementById('progress-bar');
    this.#sidebar = this.shadowRoot.getElementById('sidebar');
    this.#backdrop = this.shadowRoot.getElementById('sidebar-backdrop');

    this.#attachEventListeners();
    this.#updateThemeToggle();
  }

  #attachEventListeners() {
    // Hamburger toggle
    const hamburgerBtn = this.shadowRoot.getElementById("hamburger-btn");
    hamburgerBtn.addEventListener('click', () => {
      hamburgerBtn.classList.add('spin');
      hamburgerBtn.addEventListener('animationend', () => hamburgerBtn.classList.remove('spin'), { once: true });
      this.#toggleSidebar();
    });

    // Backdrop click closes sidebar
    this.#backdrop.addEventListener('click', () => this.#closeSidebar());

    // Sidebar navigation — use the single global router
    this.#sidebar.querySelectorAll('.sidebar-item[data-route]:not([disabled])').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        router.navigate('/app' + item.dataset.route);
        this.#closeSidebar();
      });
    });

    // Logo and title navigation
    this.shadowRoot.getElementById('nav-logo').addEventListener('click', (e) => {
      e.preventDefault();
      router.navigate('/app');
    });
    this.shadowRoot.getElementById('nav-title').addEventListener('click', (e) => {
      e.preventDefault();
      router.navigate('/app');
    });

    // Search
    const searchBox = this.shadowRoot.getElementById('nav-search-box');
    searchBox.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') {
        const searchText = searchBox.value.trim();
        if (searchText) {
          router.navigate(`/app/search/${encodeURIComponent(searchText)}`);
          searchBox.blur();
        }
      }
    });

    // Logout
    this.shadowRoot.getElementById('logout-btn')
      .addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('pl-logout-request', { bubbles: true }));
      });

    // Theme toggle
    this.shadowRoot.getElementById('theme-toggle').addEventListener('click', () => {
      toggleTheme();
      this.#updateThemeToggle();
    });

    // Slideshow URL management — uses callHandler:false to update URL without re-triggering route
    this.handleSlideshowOpened = (evt) => {
      const base = window.location.hash.replace(/^#/, '').replace(/\/slideshow\/.*$/, '');
      router.navigate(`${base}/slideshow/${evt.detail.currentItemId}`, { callHandler: false, updateState: true });
    };

    this.handleSlideshowChanged = (evt) => {
      const base = window.location.hash.replace(/^#/, '').replace(/\/slideshow\/.*$/, '');
      const newHash = `#${base}/slideshow/${evt.detail.currentItemId}`;
      history.replaceState(null, '', newHash);
    };

    this.handleSlideshowClosed = () => {
      const base = window.location.hash.replace(/^#/, '').replace(/\/slideshow\/.*$/, '') || '/app';
      router.navigate(base, { callHandler: false, updateState: true });
    };

    document.addEventListener('pl-gallery-slideshow-opened', this.handleSlideshowOpened);
    document.addEventListener('pl-gallery-slideshow-changed', this.handleSlideshowChanged);
    document.addEventListener('pl-gallery-slideshow-closed', this.handleSlideshowClosed);
  }

  disconnectedCallback() {
    document.removeEventListener('pl-gallery-slideshow-opened', this.handleSlideshowOpened);
    document.removeEventListener('pl-gallery-slideshow-changed', this.handleSlideshowChanged);
    document.removeEventListener('pl-gallery-slideshow-closed', this.handleSlideshowClosed);
  }

  // --- Routing ---

  route(view, params = {}) {
    const { slideshowItemId, searchText } = params;

    if (!searchText) {
      this.shadowRoot.getElementById('nav-search-box').value = '';
    }

    // If a slideshow is open and no new slideshow requested, just close it
    // and reinstate the gallery underneath (handles back-button without re-fetching)
    const gallery = this.#mainContent.querySelector('pl-gallery');
    if (gallery?.isSlideshowOpen && !slideshowItemId) {
      gallery.closeSlideshow();
      return;
    }

    switch (view) {
      case 'gallery':
        this.#setActiveMenuItem('/');
        this.#loadGallery(() => authenticatedFetch('/api/getAll'), slideshowItemId, view);
        break;

      case 'search':
        this.#setActiveMenuItem(null);
        this.shadowRoot.getElementById('nav-search-box').value = searchText;
        this.#loadGallery(() => authenticatedFetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ collection_id: this.#state.collection_id, searchText })
        }), slideshowItemId, view);
        break;

      case 'map':
        this.#setActiveMenuItem('/map');
        this.#mainContent.innerHTML = '';
        this.#mainContent.style.overflowY = 'hidden';
        this.#mainContent.appendChild(document.createElement('pl-map'));
        break;

      case 'frames':
        this.#setActiveMenuItem('/frames');
        this.#mainContent.innerHTML = '';
        this.#mainContent.style.overflowY = 'auto';
        this.#mainContent.appendChild(document.createElement('pl-frame-manager'));
        break;
    }
  }

  // --- Sidebar ---

  #toggleSidebar() {
    this.#sidebar.classList.toggle('open');
    this.#backdrop.classList.toggle('open');
  }

  #closeSidebar() {
    this.#sidebar.classList.remove('open');
    this.#backdrop.classList.remove('open');
  }

  #setActiveMenuItem(route) {
    this.#sidebar.querySelectorAll('.sidebar-item').forEach(item => {
      item.classList.toggle('active', item.dataset.route === route);
    });
  }

  // --- Gallery ---

  async #loadGallery(fetchFn, slideshowItemId, routePath) {
    this.#showProgressBar();
    try {
      const res = await fetchFn();
      if (!res.ok) throw await res.json().catch(() => ({error: {message: `${res.status} ${res.statusText}`}}));
      const data = await res.json();
      this.#showGallery(data, slideshowItemId, routePath);
    } catch (err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    } finally {
      this.#hideProgressBar();
    }
  }

  #showGallery(data, slideshowItemId, routePath) {
    this.#mainContent.style.overflowY = 'hidden';

    if (data.length === 0) {
      this.#mainContent.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">No results found</div>';
      return;
    }

    const gallery = Object.assign(document.createElement('pl-gallery'), { data });
    gallery.dataset.view = routePath;
    this.#mainContent.innerHTML = '';
    this.#mainContent.appendChild(gallery);

    if (slideshowItemId) {
      requestAnimationFrame(() => gallery.openSlideshow(slideshowItemId));
    }

    const totalItems = data.map(x => x.items.length).reduce((a, c) => a + c, 0);
    notify(`Found ${data.length.toLocaleString()} albums containing ${totalItems.toLocaleString()} items`);
  }

  // --- Progress Bar ---

  #showProgressBar() {
    this.#progressBar.toggleAttribute("indeterminate");
    this.#progressBar.classList.remove("hide");
  }

  #hideProgressBar(timeout = 500) {
    setTimeout(() => {
      this.#progressBar.classList.add("hide");
      this.#progressBar.toggleAttribute("indeterminate");
    }, timeout);
  }

  #updateThemeToggle() {
    const isDark = getTheme() === 'dark';
    this.shadowRoot.getElementById('theme-icon').name = isDark ? 'sun' : 'moon';
    this.shadowRoot.getElementById('theme-label').textContent = isDark ? 'Light mode' : 'Dark mode';
  }
}

customElements.define('pl-app-shell', PlAppShell);

