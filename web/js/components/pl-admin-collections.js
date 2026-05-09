// Admin Collections - list wrapper
// Future actions (pending route migration to /api/admin):
// - Start/Stop All Watchers (POST /api/startAllWatchers, /api/stopAllWatchers)
// - Start/Stop Scheduled Indexing (POST /api/startScheduledIndexing, /api/stopScheduledIndexing)

import { authenticatedFetch } from '../authn.mjs';
import './pl-collection-card.js';

import sheet from "./styles/pl-admin-collections.css" with { type: "css" };

class PlAdminCollections extends HTMLElement {

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <div class="container" id="list-view">
        <div class="header">
          <h2>Collections</h2>
          <sl-button variant="primary" size="medium" id="new-collection-btn">
            <sl-icon slot="prefix" name="plus-lg"></sl-icon> New Collection
          </sl-button>
        </div>

        <div id="collections-list">
          <div class="loading">Loading collections...</div>
        </div>
      </div>

      <div id="form-view" hidden></div>
    `;
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
    this.#setupEventListeners();
    this.#loadCollections();
  }

  #setupEventListeners() {
    this.shadowRoot.getElementById('new-collection-btn').addEventListener('click', () => {
      this.#showForm(null);
    });

    this.shadowRoot.addEventListener('pl-collection-edit', (e) => {
      this.#showForm(e.detail);
    });

    this.shadowRoot.addEventListener('pl-collection-saved', () => {
      this.#showList();
      this.#loadCollections();
    });

    this.shadowRoot.addEventListener('pl-collection-cancelled', () => {
      this.#showList();
    });
  }

  #showForm(collectionData) {
    let listView = this.shadowRoot.getElementById('list-view');
    let formView = this.shadowRoot.getElementById('form-view');

    listView.hidden = true;
    formView.hidden = false;
    formView.innerHTML = '';

    let form = document.createElement('pl-collection-form');
    if (collectionData) {
      form.data = collectionData;
    }
    formView.appendChild(form);
  }

  #showList() {
    let listView = this.shadowRoot.getElementById('list-view');
    let formView = this.shadowRoot.getElementById('form-view');

    formView.hidden = true;
    formView.innerHTML = '';
    listView.hidden = false;
  }

  async #loadCollections() {
    const container = this.shadowRoot.getElementById('collections-list');
    try {
      const res = await authenticatedFetch('/api/getAllCollections');
      if (!res.ok) throw new Error('Failed to load collections');
      const collections = await res.json();

      if (!collections || collections.length === 0) {
        container.innerHTML = '<div class="empty-state">No collections configured</div>';
        return;
      }

      container.innerHTML = '';
      for (const c of collections) {
        const card = document.createElement('pl-collection-card');
        card.data = c;
        container.appendChild(card);
      }
    } catch (err) {
      container.innerHTML = '<div class="error">Failed to load collections</div>';
      console.error(err);
    }
  }
}

customElements.define('pl-admin-collections', PlAdminCollections);
