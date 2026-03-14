
import { authenticatedFetch } from '../authn.mjs';

import sheet from "./styles/pl-app-shell.css" with { type: "css" };


class PlAppShell extends HTMLElement {

  #state = {
    collection_id: 1,
    galleryData: null,
    prevLink: null
  };

  #router = null;
  #mainContent = null; #progressBar = null;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <div id="app-container">
        <sl-progress-bar id="progress-bar" class="hide"></sl-progress-bar>

        <nav id="nav-header">
          <a class="nav-item" id="nav-logo" href="/" data-navigo>
            <img id="logo" src="assets/R3-resized.png" alt="Relive!">
          </a>

          <a class="nav-item" id="nav-title" href="/" data-navigo>
            Rewind, Replay & Relive!
          </a>

          <input class="nav-item" id="nav-search-box" type="search" placeholder="Search your memories..."/>

          <a class="nav-item" href="/map" data-navigo>
            <sl-icon-button name="geo-alt-fill" label="Map View"></sl-icon-button>
          </a>
          
          <a class="nav-item" href="/frames" data-navigo>
            <sl-icon-button name="display" label="Frames"></sl-icon-button>
          </a>
          
          <sl-dropdown class="nav-item">
            <sl-icon-button slot="trigger" name="gear" label="Settings"></sl-icon-button>
            <sl-menu>
              <sl-menu-item id="logout-btn">
                <sl-icon slot="prefix" name="box-arrow-right"></sl-icon>
                Logout
              </sl-menu-item>
            </sl-menu>
          </sl-dropdown>
        </nav>
        
        <main id="main-content"></main>
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

    this.#initAppRouter();
    this.#attachEventListeners();
  }

  #attachEventListeners() {
    // Manual navigation for shadow DOM links
    this.shadowRoot.querySelectorAll('[data-navigo]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const href = link.getAttribute('href');
        if (href) this.#router.navigate(href);
      });
    });

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

    const logoutBtn = this.shadowRoot.getElementById('logout-btn');
    logoutBtn.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('pl-logout-request', { bubbles: true }));
    });

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

  #initAppRouter() {
    this.#router.on('/', async () => {
      if (document.querySelector('pl-slideshow')) {
        document.querySelector('pl-slideshow').remove();
        this.shadowRoot.getElementById('nav-header').style.opacity = 1;
        this.style.opacity = 1;
        return;
      }

      this.#showProgressBar();

      try {
        const res = await authenticatedFetch('/api/getAll');
        if (!res.ok) throw `${res.status} ${res.statusText}`;
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

        if (!res.ok) throw `${res.status} ${res.statusText}`;
        const result = await res.json();
        this.#showGallery(result);
      } catch (err) {
        notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
      } finally {
        this.#hideProgressBar();
      }
    });

    this.#router.on('/map', () => {
      const mapComponent = document.createElement('pl-map');

      this.#mainContent.innerHTML = '';
      this.#mainContent.style.overflowY = 'hidden';
      this.#mainContent.appendChild(mapComponent);
    });

    this.#router.on('/frames', () => {
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

    this.#router.resolve();
  }

  #showProgressBar(){
    this.#progressBar.toggleAttribute("indeterminate");
    this.#progressBar.classList.remove("hide");
  }

  // hide the progress bar after a specific timeout
  #hideProgressBar(timeout=500){
    setTimeout(()=>{
      this.#progressBar.classList.add("hide");
      this.#progressBar.toggleAttribute("indeterminate");
    }, timeout)
  }
}

customElements.define('pl-app-shell', PlAppShell);

