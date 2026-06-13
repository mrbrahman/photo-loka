import { isAdmin } from '../authn.mjs';
import { getTheme, toggleTheme } from '../theme.mjs';
import { router, getStoredCollectionId, setStoredCollectionId } from '../router.mjs';
import { getCollections } from '../api/collections-api.mjs';

import sheet from "./styles/pl-app-shell.css" with { type: "css" };


class PlAppShell extends HTMLElement {

  #state = {
    collections: [],    // [{collection_id, collection_name, default_collection, apply_folder_pattern}]
    collection_id: null
  };

  #mode = 'app'; // 'app' | 'admin'

  #mainContent = null; #progressBar = null; #sidebar = null; #backdrop = null;
  #progressCount = 0;
  #collectionsReady = null; // Promise that resolves when collections are loaded
  #swRegistration = null;
  #updatePollInterval = null;
  #pageVersion = null; // version of the SW that was active when this page loaded

  // --- Shell template (nav-header + content area with empty sidebar-nav) ---

  static shellTemplate = document.createElement('template');
  static {
    this.shellTemplate.innerHTML = // html
      `
      <div id="app-container">
        <sl-progress-bar id="progress-bar" class="hide"></sl-progress-bar>

        <div id="update-banner" class="hide">
          <span>New version available</span>
          <sl-button id="update-btn" size="small">Update</sl-button>
        </div>

        <nav id="nav-header">
          <sl-icon-button class="nav-item" id="hamburger-btn" name="list" label="Menu"></sl-icon-button>

          <a class="nav-item" id="nav-logo" href="/">
            <img id="logo" src="assets/icon-454.png" alt="Photo-Loka">
          </a>

          <a class="nav-item" id="nav-title" href="/">
            <span class="brand-name">Photo-</span><span class="brand-accent">Loka</span>
          </a>

          <input class="nav-item" id="nav-search-box" type="search" placeholder="Search your memories..."/>

          <sl-dropdown class="nav-item" id="user-dropdown">
            <sl-icon-button slot="trigger" name="person-circle" label="Account"></sl-icon-button>
            <sl-menu>
              <sl-menu-item id="my-account-btn" disabled>
                <sl-icon slot="prefix" name="person-gear"></sl-icon>
                My Account
              </sl-menu-item>
              <sl-menu-item id="admin-btn" class="admin-only" style="display:none">
                <sl-icon slot="prefix" name="shield-lock"></sl-icon>
                Administration
              </sl-menu-item>
              <sl-menu-item id="theme-toggle-btn">
                <sl-icon slot="prefix" id="theme-icon" name="moon"></sl-icon>
                <span id="theme-label">Dark mode</span>
              </sl-menu-item>
              <sl-divider></sl-divider>
              <sl-menu-item id="logout-btn">
                <sl-icon slot="prefix" name="box-arrow-right"></sl-icon>
                Logout
              </sl-menu-item>
            </sl-menu>
          </sl-dropdown>
        </nav>

        <div id="content-area">
          <nav id="sidebar">
            <div id="sidebar-nav"></div>
          </nav>

          <div id="sidebar-backdrop"></div>

          <main id="main-content"></main>
        </div>
      </div>
    `;
  }

  // --- App sidebar template ---

  static appSidebarTemplate = document.createElement('template');
  static {
    this.appSidebarTemplate.innerHTML = // html
      `
      <div id="collection-picker">
        <span id="collection-label" style="display:none"></span>
        <sl-select id="collection-select" size="small" style="display:none">
        </sl-select>
      </div>

      <a class="sidebar-item" data-route="/">
        <sl-icon name="images"></sl-icon>
        <span>Photos</span>
      </a>
      <a class="sidebar-item" data-route="/map">
        <sl-icon name="geo-alt-fill"></sl-icon>
        <span>Map</span>
      </a>
      <a class="sidebar-item" data-route="/faces" disabled>
        <sl-icon name="person-circle"></sl-icon>
        <span>Faces</span>
      </a>
      <a class="sidebar-item" data-route="/trash">
        <sl-icon name="trash"></sl-icon>
        <span>Trash</span>
      </a>
    `;
  }

  // --- Admin sidebar template ---

  static adminSidebarTemplate = document.createElement('template');
  static {
    this.adminSidebarTemplate.innerHTML = // html
      `
      <a class="sidebar-item" id="back-to-app">
        <sl-icon name="arrow-left"></sl-icon>
        <span>Back to App</span>
      </a>

      <sl-divider></sl-divider>

      <!-- Dashboard: collection stats, media type breakdown, system health overview -->
      <a class="sidebar-item" data-route="/dashboard">
        <sl-icon name="speedometer2"></sl-icon>
        <span>Dashboard</span>
      </a>
      <a class="sidebar-item" data-route="/settings">
        <sl-icon name="gear"></sl-icon>
        <span>Settings</span>
      </a>
      <a class="sidebar-item" data-route="/frames">
        <sl-icon name="display"></sl-icon>
        <span>Frames</span>
      </a>
      <!-- Indexer: live status, pause/resume, concurrency, errors -->
      <a class="sidebar-item" data-route="/indexer">
        <sl-icon name="arrow-repeat"></sl-icon>
        <span>Indexer</span>
      </a>
      <!-- Jobs: all scheduled cron jobs and file watchers -->
      <a class="sidebar-item" data-route="/jobs">
        <sl-icon name="clock-history"></sl-icon>
        <span>Jobs</span>
      </a>
      <!-- Collections: indexing, file watchers, scheduled jobs per collection -->
      <a class="sidebar-item" data-route="/collections">
        <sl-icon name="folder2-open"></sl-icon>
        <span>Collections</span>
      </a>
      <a class="sidebar-item" data-route="/users">
        <sl-icon name="people"></sl-icon>
        <span>Users</span>
      </a>
    `;
  }

  constructor() {
    super().attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.shellTemplate.content.cloneNode(true));
    this.#mainContent = this.shadowRoot.getElementById('main-content');
    this.#progressBar = this.shadowRoot.getElementById('progress-bar');
    this.#sidebar = this.shadowRoot.getElementById('sidebar');
    this.#backdrop = this.shadowRoot.getElementById('sidebar-backdrop');

    // Insert app sidebar by default
    this.#applySidebar('app');

    this.#attachEventListeners();
    this.#updateThemeToggle();

    // Show Administration link only for admin users
    if (isAdmin()) {
      this.shadowRoot.getElementById('admin-btn').style.display = '';
    }

    // Fetch collections from server
    this.#collectionsReady = this.#fetchCollections();

    // Service worker registration and update detection
    this.#initServiceWorker();
  }

  async #fetchCollections() {
    try {
      const collections = await getCollections();
      this.#state.collections = collections;
      this.#renderCollectionPicker();
    } catch (err) {
      // If fetch fails, fall back to a single default
      this.#state.collections = [{ collection_id: 1, collection_name: 'Default', default_collection: 1, apply_folder_pattern: '' }];
    }
  }

  /**
   * Resolves the default collection id (from localStorage or server default).
   * Called by the router when navigating to /app without a collection id.
   * Returns a promise that resolves to the collection_id to use.
   */
  async resolveDefaultCollectionId() {
    await this.#collectionsReady;

    const stored = getStoredCollectionId();
    if (stored && this.#state.collections.find(c => c.collection_id === parseInt(stored))) {
      return parseInt(stored);
    }

    const defaultCol = this.#state.collections.find(c => c.default_collection === 1);
    return defaultCol ? defaultCol.collection_id : this.#state.collections[0]?.collection_id || 1;
  }

  #renderCollectionPicker() {
    const picker = this.shadowRoot.getElementById('collection-picker');
    if (!picker) return; // admin mode, no picker

    const label = this.shadowRoot.getElementById('collection-label');
    const select = this.shadowRoot.getElementById('collection-select');

    if (this.#state.collections.length <= 1) {
      // Single collection: show as bold label
      select.style.display = 'none';
      label.style.display = '';
      label.textContent = this.#state.collections[0]?.collection_name || '';
      return;
    }

    // Multiple collections: show dropdown
    label.style.display = 'none';
    select.style.display = '';
    select.innerHTML = '';

    for (const col of this.#state.collections) {
      const option = document.createElement('sl-option');
      option.value = String(col.collection_id);
      option.textContent = col.collection_name;
      select.appendChild(option);
    }

    // Set current value
    if (this.#state.collection_id) {
      select.value = String(this.#state.collection_id);
    }

    // Listen for changes
    select.addEventListener('sl-change', this.#handleCollectionChange);
  }

  #handleCollectionChange = (evt) => {
    const newId = parseInt(evt.target.value);
    if (newId === this.#state.collection_id) return;

    this.#state.collection_id = newId;
    setStoredCollectionId(newId);

    // Navigate to the same view but with the new collection
    const currentHash = window.location.hash.replace(/^#/, '');
    // Replace the collection id in the current URL
    const newPath = currentHash.replace(/\/app\/c\/\d+/, `/app/c/${newId}`);
    router.navigate(newPath);
  };

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
          router.navigate(`/app/c/${this.#state.collection_id}/search/${encodeURIComponent(searchText)}`);
          searchBox.blur();
        }
      }
    });

    // Logout
    this.shadowRoot.getElementById('logout-btn')
      .addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('pl-logout-request', { bubbles: true }));
      });

    // Administration link
    this.shadowRoot.getElementById('admin-btn')
      .addEventListener('click', () => {
        router.navigate('/admin');
      });

    // Theme toggle (now in user dropdown)
    this.shadowRoot.getElementById('theme-toggle-btn').addEventListener('click', () => {
      toggleTheme();
      this.#updateThemeToggle();
    });

    // Slideshow URL management
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

    // Global progress bar events (any component can trigger via showProgress/hideProgress utils)
    document.addEventListener('pl-progress-show', this.#handleProgressShow);
    document.addEventListener('pl-progress-hide', this.#handleProgressHide);
  }

  disconnectedCallback() {
    document.removeEventListener('pl-gallery-slideshow-opened', this.handleSlideshowOpened);
    document.removeEventListener('pl-gallery-slideshow-changed', this.handleSlideshowChanged);
    document.removeEventListener('pl-gallery-slideshow-closed', this.handleSlideshowClosed);
    document.removeEventListener('pl-progress-show', this.#handleProgressShow);
    document.removeEventListener('pl-progress-hide', this.#handleProgressHide);
    document.removeEventListener('visibilitychange', this.#handleVisibilityChange);
    if (this.#updatePollInterval) clearInterval(this.#updatePollInterval);
  }

  // --- Mode / Sidebar ---

  #setMode(mode) {
    if (this.#mode === mode) return;
    this.#applySidebar(mode);
  }

  #applySidebar(mode) {
    this.#mode = mode;
    const sidebarNav = this.shadowRoot.getElementById('sidebar-nav');
    sidebarNav.innerHTML = '';

    if (mode === 'admin') {
      sidebarNav.appendChild(this.constructor.adminSidebarTemplate.content.cloneNode(true));
    } else {
      sidebarNav.appendChild(this.constructor.appSidebarTemplate.content.cloneNode(true));
      // Re-render collection picker if collections are loaded
      if (this.#state.collections.length > 0) {
        this.#renderCollectionPicker();
      }
    }

    this.#attachSidebarListeners();
  }

  #attachSidebarListeners() {
    const sidebarNav = this.shadowRoot.getElementById('sidebar-nav');

    // "Back to App" link (admin mode only)
    const backBtn = sidebarNav.querySelector('#back-to-app');
    if (backBtn) {
      backBtn.addEventListener('click', (e) => {
        e.preventDefault();
        router.navigate('/app');
        this.#closeSidebar();
      });
    }

    // Standard sidebar items with data-route
    sidebarNav.querySelectorAll('.sidebar-item[data-route]:not([disabled])').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        let prefix;
        if (this.#mode === 'admin') {
          prefix = '/admin';
        } else {
          prefix = `/app/c/${this.#state.collection_id}`;
        }
        router.navigate(prefix + item.dataset.route);
        this.#closeSidebar();
      });
    });
  }

  // --- Routing ---

  route(view, params = {}) {
    // Mode is passed explicitly by the router via params.mode
    const mode = params.mode || 'app';
    this.#setMode(mode);

    const { collectionId, slideshowItemId, searchText } = params;

    // Update active collection from route param
    if (collectionId) {
      this.#state.collection_id = collectionId;
      // Sync the picker if visible
      const select = this.shadowRoot.getElementById('collection-select');
      if (select) select.value = String(collectionId);
    }

    if (!searchText) {
      this.shadowRoot.getElementById('nav-search-box').value = '';
    }

    // If a slideshow is open and no new slideshow requested, just close it
    const gallery = this.#mainContent.querySelector('pl-gallery');
    if (gallery?.isSlideshowOpen && !slideshowItemId) {
      gallery.closeSlideshow();
      return;
    }

    switch (view) {
      case 'gallery':
        this.#setActiveMenuItem('/');
        this.#mainContent.innerHTML = '';
        this.#mainContent.style.overflowY = 'hidden';
        this.#mainContent.appendChild(Object.assign(document.createElement('pl-gallery'), {
          mode: 'default',
          query: { collectionId: this.#state.collection_id },
          slideshowItemId
        }));
        break;

      case 'search':
        this.#setActiveMenuItem(null);
        this.shadowRoot.getElementById('nav-search-box').value = searchText;
        this.#mainContent.innerHTML = '';
        this.#mainContent.style.overflowY = 'hidden';
        this.#mainContent.appendChild(Object.assign(document.createElement('pl-gallery'), {
          mode: 'search',
          query: { collectionId: this.#state.collection_id, searchText },
          slideshowItemId
        }));
        break;

      case 'trash':
        this.#setActiveMenuItem('/trash');
        this.#mainContent.innerHTML = '';
        this.#mainContent.style.overflowY = 'hidden';
        this.#mainContent.appendChild(Object.assign(document.createElement('pl-gallery'), {
          mode: 'trash',
          query: { collectionId: this.#state.collection_id },
          slideshowItemId
        }));
        break;

      case 'map':
        this.#setActiveMenuItem('/map');
        this.#mainContent.innerHTML = '';
        this.#mainContent.style.overflowY = 'hidden';
        this.#mainContent.appendChild(Object.assign(document.createElement('pl-map'), {
          collectionId: this.#state.collection_id
        }));
        break;

      case 'frames':
        this.#setActiveMenuItem('/frames');
        this.#mainContent.innerHTML = '';
        this.#mainContent.style.overflowY = 'auto';
        this.#mainContent.appendChild(document.createElement('pl-frame-manager'));
        break;

      case 'settings':
        this.#setActiveMenuItem('/settings');
        this.#mainContent.innerHTML = '';
        this.#mainContent.style.overflowY = 'auto';
        this.#mainContent.appendChild(document.createElement('pl-admin-settings'));
        break;

      case 'indexer':
        this.#setActiveMenuItem('/indexer');
        this.#mainContent.innerHTML = '';
        this.#mainContent.style.overflowY = 'auto';
        this.#mainContent.appendChild(document.createElement('pl-admin-indexer'));
        break;

      case 'dashboard':
        this.#setActiveMenuItem('/dashboard');
        this.#mainContent.innerHTML = '';
        this.#mainContent.style.overflowY = 'auto';
        this.#mainContent.appendChild(document.createElement('pl-admin-dashboard'));
        break;

      case 'collections':
        this.#setActiveMenuItem('/collections');
        this.#mainContent.innerHTML = '';
        this.#mainContent.style.overflowY = 'auto';
        this.#mainContent.appendChild(document.createElement('pl-admin-collections'));
        break;

      case 'jobs':
        this.#setActiveMenuItem('/jobs');
        this.#mainContent.innerHTML = '';
        this.#mainContent.style.overflowY = 'auto';
        this.#mainContent.appendChild(document.createElement('pl-admin-jobs'));
        break;

      case 'users':
        this.#setActiveMenuItem('/users');
        this.#mainContent.innerHTML = '';
        this.#mainContent.style.overflowY = 'auto';
        this.#mainContent.appendChild(document.createElement('pl-admin-users'));
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

  // --- Progress Bar ---

  #handleProgressShow = () => {
    this.#progressCount++;
    if (this.#progressCount === 1) {
      this.#progressBar.toggleAttribute('indeterminate', true);
      this.#progressBar.classList.remove('hide');
    }
  };

  #handleProgressHide = () => {
    this.#progressCount = Math.max(0, this.#progressCount - 1);
    if (this.#progressCount === 0) {
      setTimeout(() => {
        this.#progressBar.classList.add('hide');
        this.#progressBar.toggleAttribute('indeterminate', false);
      }, 500);
    }
  };

  // --- Service Worker Update ---
  //
  // Page-side companion to web/sw.js for the PWA update mechanism.
  // See sw.js header for the full design overview.
  //
  // Responsibilities:
  //   - Register the SW
  //   - Trigger update checks (10-min poll while visible, on visibilitychange)
  //   - Listen for new SWs activating and show the "App update available" banner
  //   - Gate the banner on initial controller state (suppress on first install)
  //   - Ask the active and new SWs for their VERSION via postMessage to
  //     populate the banner (v{old} -> v{new})
  //   - On user tapping Update: blur content, show progress, reload

  async #initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    // Capture controller state BEFORE registration. If there's no controller at
    // page load, this is either a first install or a hard reload (rare in real use).
    // Either way, we shouldn't show the "Update available" banner for that initial
    // install/activation.
    const initiallyControlled = !!navigator.serviceWorker.controller;

    try {
      this.#swRegistration = await navigator.serviceWorker.register('/sw.js');

      // Capture the version of the active SW at page load (the version this page is running)
      if (this.#swRegistration.active) {
        this.#pageVersion = await this.#getSwVersion(this.#swRegistration.active);
      }

      // Listen for new SWs found during the page's lifetime.
      this.#swRegistration.addEventListener('updatefound', () => {
        console.log('[sw] updatefound: new version detected, installing');
        const installing = this.#swRegistration.installing;
        if (installing) {
          installing.addEventListener('statechange', async () => {
            console.log('[sw] new worker state:', installing.state);
            if (installing.state === 'activated' && initiallyControlled) {
              const newVersion = await this.#getSwVersion(installing);
              this.#showUpdateIcon(this.#pageVersion, newVersion);
            }
          });
        }
      });

      // Poll every minute while visible (TODO: change back to 10 min after testing)
      this.#updatePollInterval = setInterval(() => {
        if (document.visibilityState === 'visible') {
          console.log('[sw] polling for update');
          this.#swRegistration.update();
        }
      }, 1 * 60 * 1000);

      // Check on resume from background
      document.addEventListener('visibilitychange', this.#handleVisibilityChange);
    } catch (err) {
      // SW registration failed - not critical, app still works
    }
  }

  #handleVisibilityChange = () => {
    if (document.visibilityState === 'visible' && this.#swRegistration) {
      console.log('[sw] checking for update on resume');
      this.#swRegistration.update();
    }
  };

  #getSwVersion(sw) {
    return new Promise(resolve => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => resolve(null), 2000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout);
        resolve(event.data?.version || null);
      };
      sw.postMessage({ type: 'getVersion' }, [channel.port2]);
    });
  }

  #showUpdateIcon(oldVersion, newVersion) {
    const banner = this.shadowRoot.getElementById('update-banner');
    if (!banner.classList.contains('hide')) return; // already shown

    const label = banner.querySelector('span');
    if (oldVersion && newVersion) {
      label.textContent = `App update available (v${oldVersion} \u2192 v${newVersion})`;
    } else if (newVersion) {
      label.textContent = `App update available (v${newVersion})`;
    } else {
      label.textContent = 'App update available';
    }

    banner.classList.remove('hide');
    const btn = this.shadowRoot.getElementById('update-btn');
    btn.addEventListener('click', () => this.#applyUpdate(), { once: true });
  }

  #applyUpdate() {
    // Show progress bar and blur content
    this.#progressBar.toggleAttribute('indeterminate', true);
    this.#progressBar.classList.remove('hide');

    const contentArea = this.shadowRoot.getElementById('content-area');
    contentArea.classList.add('updating');

    // Show "Updating..." overlay
    const overlay = document.createElement('div');
    overlay.id = 'update-overlay';
    overlay.textContent = 'Updating...';
    this.shadowRoot.getElementById('app-container').appendChild(overlay);

    // Reload after a brief moment so the user sees the feedback
    setTimeout(() => location.reload(), 300);
  }

  #updateThemeToggle() {
    const isDark = getTheme() === 'dark';
    this.shadowRoot.getElementById('theme-icon').name = isDark ? 'sun' : 'moon';
    this.shadowRoot.getElementById('theme-label').textContent = isDark ? 'Light mode' : 'Dark mode';
  }
}

customElements.define('pl-app-shell', PlAppShell);
