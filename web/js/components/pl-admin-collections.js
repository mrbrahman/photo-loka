// Admin Collections
// Planned content:
// - List of all collections with paths, item counts, and sizes
// - Start/stop indexing per collection (POST /api/indexCollection/:id)
// - Start/stop file watchers per collection (POST /api/startAllWatchers, /api/stopAllWatchers)
// - Intake file indexing controls (POST /api/startIntakeFileIndexing)
// - Refresh metadata for collection (POST /api/refreshMetadataForCollection/:id)
// - Create new collection
// - Scheduled indexing controls (POST /api/startScheduledIndexing, /api/stopScheduledIndexing)

import sheet from "./styles/pl-admin-collections.css" with { type: "css" };

class PlAdminCollections extends HTMLElement {

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <div class="container">
        <h2>Collections</h2>
        <p class="placeholder">Collection management - indexing, file watchers, scheduled jobs - TBD</p>
      </div>
    `;
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
  }
}

customElements.define('pl-admin-collections', PlAdminCollections);
