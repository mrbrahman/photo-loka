// Admin Collections
// Future actions (disabled for now, pending route migration to /api/admin):
// - Start/Stop All Watchers (POST /api/startAllWatchers, /api/stopAllWatchers)
// - Start/Stop Scheduled Indexing (POST /api/startScheduledIndexing, /api/stopScheduledIndexing)
// - Re-index Collection (POST /api/indexCollection/:id)
// - Refresh Metadata (POST /api/refreshMetadataForCollection/:id)
// - Index Now per intake path (POST /api/startIntakeFileIndexing)

import { notify } from '../utils.mjs';
import { authenticatedFetch } from '../authn.mjs';

import sheet from "./styles/pl-admin-collections.css" with { type: "css" };

class PlAdminCollections extends HTMLElement {

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <div class="container">
        <h2>Collections</h2>

        <!-- Page-level controls (disabled placeholders) -->
        <div class="page-controls">
          <sl-button size="small" variant="neutral" disabled>
            <sl-icon slot="prefix" name="eye"></sl-icon>
            Start All Watchers
          </sl-button>
          <sl-button size="small" variant="neutral" disabled>
            <sl-icon slot="prefix" name="eye-slash"></sl-icon>
            Stop All Watchers
          </sl-button>
          <sl-button size="small" variant="neutral" disabled>
            <sl-icon slot="prefix" name="calendar-check"></sl-icon>
            Start Scheduled Indexing
          </sl-button>
          <sl-button size="small" variant="neutral" disabled>
            <sl-icon slot="prefix" name="calendar-x"></sl-icon>
            Stop Scheduled Indexing
          </sl-button>
        </div>

        <div id="collections-list">
          <div class="loading">Loading collections...</div>
        </div>
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
    this.#loadCollections();
  }

  async #loadCollections() {
    try {
      const res = await authenticatedFetch('/api/getAllCollections');
      if (!res.ok) throw new Error('Failed to load collections');
      const collections = await res.json();
      this.#renderCollections(collections);
    } catch (err) {
      this.shadowRoot.getElementById('collections-list').innerHTML =
        '<div class="error">Failed to load collections</div>';
      console.error(err);
    }
  }

  #renderCollections(collections) {
    const container = this.shadowRoot.getElementById('collections-list');

    if (!collections || collections.length === 0) {
      container.innerHTML = '<div class="empty-state">No collections configured</div>';
      return;
    }

    container.innerHTML = '';

    for (const c of collections) {
      const details = document.createElement('sl-details');
      details.className = 'collection-card';

      // Summary
      const summary = document.createElement('div');
      summary.slot = 'summary';
      summary.className = 'collection-summary';
      summary.innerHTML = `
        <div class="summary-info">
          <span class="collection-name">${c.collection_name || 'Unnamed'}</span>
          <span class="collection-path">${c.collection_path || '--'}</span>
        </div>
        ${c.default_collection ? '<sl-badge variant="primary" pill>Default</sl-badge>' : ''}
      `;
      details.appendChild(summary);

      // Expanded content
      const content = document.createElement('div');
      content.className = 'collection-content';
      content.innerHTML = this.#buildExpandedContent(c);
      details.appendChild(content);

      container.appendChild(details);
    }

    this.#attachActionListeners();
  }

  #attachActionListeners() {
    this.shadowRoot.querySelectorAll('.scan-btn').forEach(btn => {
      btn.addEventListener('click', () => this.#scanForChanges(btn));
    });
  }

  async #scanForChanges(btn) {
    const collectionId = btn.dataset.collectionId;
    btn.loading = true;
    try {
      const res = await authenticatedFetch(`/api/admin/scanForChanges/${collectionId}`, { method: 'POST' });
      if (!res.ok) throw new Error('Failed');
      notify('Scan for changes started', 'success');
    } catch (err) {
      notify('Failed to start scan', 'danger');
      console.error(err);
    } finally {
      btn.loading = false;
    }
  }

  #buildExpandedContent(c) {
    // Properties section
    let html = `
      <div class="props-section">
        <div class="prop-row"><span class="prop-label">Path</span><span class="prop-value">${c.collection_path || '--'}</span></div>
        <div class="prop-row"><span class="prop-label">Album Type</span><span class="prop-value">${c.album_type || '--'}</span></div>
        <div class="prop-row"><span class="prop-label">Folder Pattern</span><span class="prop-value">${c.apply_folder_pattern || '--'}</span></div>
        <div class="prop-row"><span class="prop-label">Default</span><span class="prop-value">${c.default_collection ? 'Yes' : 'No'}</span></div>
      </div>
    `;

    // Intake configs section
    if (c.intake_configs && c.intake_configs.length > 0) {
      html += `<h4 class="subsection-title">Intake Paths</h4>`;
      html += '<div class="intake-list">';
      for (const intake of c.intake_configs) {
        const methodBadge = this.#getMethodBadge(intake.method);
        const configDetails = this.#formatIntakeConfig(intake);
        html += `
          <div class="intake-item">
            <div class="intake-header">
              ${methodBadge}
              <span class="intake-path">${intake.path}</span>
            </div>
            ${configDetails ? `<pre class="intake-config">${configDetails}</pre>` : ''}
          </div>
        `;
      }
      html += '</div>';
    }

    // Actions section
    html += `
      <div class="actions-section">
        <sl-button size="small" variant="primary" outline class="scan-btn" data-collection-id="${c.collection_id}">
          <sl-icon slot="prefix" name="search"></sl-icon>
          Scan for Changes
        </sl-button>
        <sl-button size="small" variant="neutral" outline disabled title="Disabled: may overwrite enriched fields (geo_address, faces). Needs revisit.">
          <sl-icon slot="prefix" name="arrow-clockwise"></sl-icon>
          Refresh Metadata
        </sl-button>
      </div>
    `;

    return html;
  }

  #getMethodBadge(method) {
    switch (method) {
      case 'immediate':
        return '<sl-badge variant="success" pill>immediate</sl-badge>';
      case 'scheduled':
        return '<sl-badge variant="warning" pill>scheduled</sl-badge>';
      case 'on-demand':
        return '<sl-badge variant="neutral" pill>on-demand</sl-badge>';
      default:
        return `<sl-badge variant="neutral" pill>${method}</sl-badge>`;
    }
  }

  #formatIntakeConfig(intake) {
    if (!intake.config || Object.keys(intake.config).length === 0) return '';
    return JSON.stringify(intake.config, null, 2);
  }
}

customElements.define('pl-admin-collections', PlAdminCollections);
