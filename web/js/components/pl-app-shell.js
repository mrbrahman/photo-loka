import { logout } from '../authn.mjs';
import { router, state } from '../router.mjs';
import { authenticatedFetch } from '../authn.mjs';

import sheet from "./styles/pl-app-shell.css" with { type: "css" };


class PlAppShell extends HTMLElement {

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
        
        <main>
          <slot></slot>
        </main>
      </div>
    `;
  }

  constructor() {
    super().attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
    this.attachEventListeners();
  }

  attachEventListeners() {
    // Manual navigation for shadow DOM links
    this.shadowRoot.querySelectorAll('[data-navigo]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const href = link.getAttribute('href');
        if (href) router.navigate(href);
      });
    });

    const searchBox = this.shadowRoot.getElementById('nav-search-box');
    searchBox.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') {
        const searchText = searchBox.value.trim();
        if (searchText) {
          router.navigate(`/search/${encodeURIComponent(searchText)}`);
          searchBox.blur();
        }
      }
    });

    const logoutBtn = this.shadowRoot.getElementById('logout-btn');
    logoutBtn.addEventListener('click', async () => {
      await logout();
      router.navigate('/login');
    });

    this.handleSlideshowRequest = (evt) => {
      state.galleryData = evt.detail.data;
      router.navigate(`/slideshow/${evt.detail.startFrom}`);
    };

    this.handleSlideshowClosed = () => {
      router.navigate(state.prevLink[0].url);
    };

    this.handleMapItemClick = async (evt) => {
      try {
        const response = await authenticatedFetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            collection_id: state.collection_id, 
            searchText: `uuid:${evt.detail.uuid}` 
          })
        });
        
        const result = await response.json();
        if (result.length > 0 && result[0].items.length > 0) {
          state.galleryData = result;
          router.navigate(`/slideshow/0`);
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
  }

  getProgressBar() {
    return this.shadowRoot.getElementById('progress-bar');
  }
}

customElements.define('pl-app-shell', PlAppShell);
