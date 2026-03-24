import { notify } from '../utils.mjs';
import { authenticatedFetch } from '../authn.mjs';

import sheet from "./styles/pl-app-shell.css" with { type: "css" };


class PlAppShell extends HTMLElement {

  #state = {
    collection_id: 1,
    galleryData: null,
    prevLink: null
  };

  #router = null;
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
    this.#router = new Navigo('/app', { hash: true });
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
    this.#mainContent = this.shadowRoot.getElementById('main-content');
    this.#progressBar = this.shadowRoot.getElementById('progress-bar');
    this.#sidebar = this.shadowRoot.getElementById('sidebar');
    this.#backdrop = this.shadowRoot.getElementById('sidebar-backdrop');

    this.#initAppRouter();
    this.#attachEventListeners();
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

    // Sidebar navigation
    this.#sidebar.querySelectorAll('.sidebar-item[data-route]:not([disabled])').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        this.#router.navigate(item.dataset.route);
        this.#closeSidebar();
      });
    });

    // Logo and title navigation
    this.shadowRoot.getElementById('nav-logo').addEventListener('click', (e) => {
      e.preventDefault();
      this.#router.navigate('/');
    });
    this.shadowRoot.getElementById('nav-title').addEventListener('click', (e) => {
      e.preventDefault();
      this.#router.navigate('/');
    });

    // Search
    const searchBox = this.shadowRoot.getElementById('nav-search-box');
    searchBox.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') {
        const searchText = searchBox.value.trim();
        if (searchText) {
          this.#router.navigate(`/search/${encodeURIComponent(searchText)}`);
          searchBox.blur();
        }
      }
    });

    // Logout
    this.shadowRoot.getElementById('logout-btn')
      .addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('pl-logout-request', { bubbles: true }));
      });

    // Global events
    this.handleSlideshowRequest = (evt) => {
      this.#state.galleryData = evt.detail.data;
      this.#router.navigate(`/slideshow/${evt.detail.startFrom}`);
    };

    this.handleSlideshowClosed = () => {
      this.#router.navigate(this.#state.prevLink[0].url);
    };

    this.handleMapItemClick = async (evt) => {
      try {
        const response = await authenticatedFetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            collection_id: this.#state.collection_id,
            searchText: `uuid:${evt.detail.uuid}`
          })
        });

        const result = await response.json();
        if (result.length > 0 && result[0].items.length > 0) {
          this.#state.galleryData = result;
          this.#router.navigate(`/slideshow/0`);
        }
      } catch (error) {
        console.error('Error loading item for slideshow:', error);
      }
    };

    document.addEventListener('pl-slideshow-request', this.handleSlideshowRequest);
    document.addEventListener('pl-slideshow-closed', this.handleSlideshowClosed);
    document.addEventListener('pl-map-item-click', this.handleMapItemClick);
  }

  disconnectedCallback() {
    document.removeEventListener('pl-slideshow-request', this.handleSlideshowRequest);
    document.removeEventListener('pl-slideshow-closed', this.handleSlideshowClosed);
    document.removeEventListener('pl-map-item-click', this.handleMapItemClick);
    this.#router.destroy();
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

  #showGallery(data) {
    this.#state.galleryData = data;
    this.#mainContent.style.overflowY = 'hidden';

    if (data.length === 0) {
      this.#mainContent.innerHTML = '<div style="padding: 2rem; text-align: center;">No results found</div>';
      return;
    }

    const gallery = Object.assign(document.createElement('pl-gallery'), { data });
    this.#mainContent.innerHTML = '';
    this.#mainContent.appendChild(gallery);

    const totalItems = data.map(x => x.items.length).reduce((a, c) => a + c, 0);
    notify(`Found ${data.length.toLocaleString()} albums containing ${totalItems.toLocaleString()} items`);
  }

  // --- Router ---

  #initAppRouter() {
    this.#router.hooks({
      before: (done) => {
        this.shadowRoot.getElementById('nav-search-box').value = '';
        done();
      }
    });

    this.#router.on('/', async () => {
      if (document.querySelector('pl-slideshow')) {
        document.querySelector('pl-slideshow').remove();
        this.shadowRoot.getElementById('nav-header').style.opacity = 1;
        this.style.opacity = 1;
        return;
      }

      this.#setActiveMenuItem('/');
      this.#showProgressBar();

      try {
        const res = await authenticatedFetch('/api/getAll');
        if (!res.ok) throw await res.json().catch(() => ({error: {message: `${res.status} ${res.statusText}`}}));
        const result = await res.json();
        this.#showGallery(result);
      } catch (err) {
        notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
      } finally {
        this.#hideProgressBar();
      }
    });

    this.#router.on('/search/:searchText', async (params) => {
      if (document.querySelector('pl-slideshow')) {
        document.querySelector('pl-slideshow').remove();
        this.shadowRoot.getElementById('nav-header').style.opacity = 1;
        this.style.opacity = 1;
        return;
      }

      this.#setActiveMenuItem(null);
      this.shadowRoot.getElementById('nav-search-box').value = params.data.searchText;
      this.#showProgressBar();

      try {
        const res = await authenticatedFetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            collection_id: this.#state.collection_id,
            searchText: params.data.searchText
          })
        });

        if (!res.ok) throw await res.json().catch(() => ({error: {message: `${res.status} ${res.statusText}`}}));
        const result = await res.json();
        this.#showGallery(result);
      } catch (err) {
        notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
      } finally {
        this.#hideProgressBar();
      }
    });

    this.#router.on('/map', () => {
      this.#setActiveMenuItem('/map');
      const mapComponent = document.createElement('pl-map');

      this.#mainContent.innerHTML = '';
      this.#mainContent.style.overflowY = 'hidden';
      this.#mainContent.appendChild(mapComponent);
    });

    this.#router.on('/frames', () => {
      this.#setActiveMenuItem('/frames');
      const framesManager = document.createElement('pl-frame-manager');

      this.#mainContent.innerHTML = '';
      this.#mainContent.style.overflowY = 'auto';
      this.#mainContent.appendChild(framesManager);
    });

    this.#router.on('/slideshow/:startFrom', (params) => {
      this.#state.prevLink = this.#router.lastResolved();

      this.shadowRoot.getElementById('nav-header').style.opacity = 0;
      this.style.opacity = 0;

      const slideshow = Object.assign(document.createElement('pl-slideshow'), {
        data: this.#state.galleryData,
        startFrom: params.data.startFrom,
        buffer: 1
      });

      document.getElementById('app-root').appendChild(slideshow);
    });

    // IMPORTANT: Deferred resolve to handle the redirect scenario.
    //
    // When an already-authenticated user visits without a hash (e.g. just "http://host:9000"),
    // the global router's "/" route calls router.navigate('/app'). Navigo fires the matching
    // "/app*" handler *synchronously* within that navigate() call - before the URL hash has
    // actually updated from "#/" to "#/app". That handler creates this <pl-app-shell> element
    // and appends it to the DOM, which triggers connectedCallback → #initAppRouter.
    //
    // If we call this.#router.resolve() synchronously here, the inner router (base: '/app')
    // reads the hash which is still "#/" (the old value), can't match it, and logs:
    //   'Navigo: "/" didn't match any of the registered routes'
    //
    // queueMicrotask defers resolve() to run after the current call stack completes, by which
    // time the hash has updated to "#/app" and the inner router correctly resolves "/".
    //
    // This does NOT affect direct visits (e.g. refreshing on "#/app") - the hash is already
    // correct in those cases, so the deferred resolve simply works as before.
    queueMicrotask(() => this.#router.resolve());
  }

  #showProgressBar(){
    this.#progressBar.toggleAttribute("indeterminate");
    this.#progressBar.classList.remove("hide");
  }

  #hideProgressBar(timeout=500){
    setTimeout(()=>{
      this.#progressBar.classList.add("hide");
      this.#progressBar.toggleAttribute("indeterminate");
    }, timeout)
  }
}

customElements.define('pl-app-shell', PlAppShell);
