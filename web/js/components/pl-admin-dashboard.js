import { notify } from '../utils.mjs';
import { authenticatedFetch } from '../authn.mjs';
import { router } from '../router.mjs';

import sheet from "./styles/pl-admin-dashboard.css" with { type: "css" };

class PlAdminDashboard extends HTMLElement {

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <div class="container">
        <h2>Dashboard</h2>

        <!-- Library Overview -->
        <div class="section">
          <h3 class="section-title">Library Overview</h3>
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-value" id="total-items">--</div>
              <div class="stat-label">Total Items</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" id="total-size">--</div>
              <div class="stat-label">Total Size</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" id="album-count">--</div>
              <div class="stat-label">Albums</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" id="trashed-count">--</div>
              <div class="stat-label">Trashed</div>
            </div>
          </div>
        </div>

        <!-- Media Breakdown -->
        <div class="section">
          <h3 class="section-title">Media Breakdown</h3>
          <div id="media-breakdown">
            <div class="loading">Loading...</div>
          </div>
        </div>

        <!-- Indexer Quick Status -->
        <div class="section">
          <h3 class="section-title">Indexer</h3>
          <div class="indexer-summary" id="indexer-summary">
            <div class="loading">Loading...</div>
          </div>
        </div>

        <!-- Collections -->
        <div class="section">
          <h3 class="section-title">Collections</h3>
          <div id="collections-list">
            <div class="loading">Loading...</div>
          </div>
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
    this.#loadData();
  }

  async #loadData() {
    await Promise.all([this.#loadStats(), this.#loadIndexerStatus()]);
  }

  async #loadStats() {
    try {
      const res = await authenticatedFetch('/api/admin/dashboard/stats');
      if (!res.ok) throw new Error('Failed to load stats');
      const data = await res.json();
      this.#renderOverview(data);
      this.#renderMediaBreakdown(data.byType);
      this.#renderCollections(data.collections);
    } catch (err) {
      this.shadowRoot.getElementById('total-items').textContent = 'Error';
      console.error(err);
    }
  }

  async #loadIndexerStatus() {
    try {
      const res = await authenticatedFetch('/api/admin/getIndexerStatus');
      if (!res.ok) throw new Error('Failed to load indexer status');
      const status = await res.json();
      this.#renderIndexerSummary(status);
    } catch (err) {
      this.shadowRoot.getElementById('indexer-summary').innerHTML =
        '<div class="error">Failed to load indexer status</div>';
      console.error(err);
    }
  }

  #renderOverview(data) {
    this.shadowRoot.getElementById('total-items').textContent = data.totalItems.toLocaleString();
    this.shadowRoot.getElementById('total-size').textContent = this.#formatSize(data.totalSize);
    this.shadowRoot.getElementById('album-count').textContent = data.albums.toLocaleString();
    this.shadowRoot.getElementById('trashed-count').textContent = data.trashedItems.toLocaleString();
  }

  #renderMediaBreakdown(byType) {
    const container = this.shadowRoot.getElementById('media-breakdown');
    const types = Object.entries(byType);

    if (types.length === 0) {
      container.innerHTML = '<div class="empty-state">No items indexed yet</div>';
      return;
    }

    let html = '<table class="media-table"><thead><tr><th>Type</th><th>Count</th><th>Size</th></tr></thead><tbody>';
    for (const [type, stats] of types) {
      html += `<tr>
        <td class="type-name">${type}</td>
        <td>${stats.count.toLocaleString()}</td>
        <td>${this.#formatSize(stats.size)}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  #renderIndexerSummary(status) {
    const container = this.shadowRoot.getElementById('indexer-summary');

    let stateText, stateClass;
    if (status.paused) {
      stateText = 'Paused';
      stateClass = 'state-paused';
    } else if (status.processingCnt > 0) {
      stateText = 'Running';
      stateClass = 'state-running';
    } else {
      stateText = 'Idle';
      stateClass = 'state-idle';
    }

    container.innerHTML = `
      <div class="indexer-row">
        <span class="indexer-state ${stateClass}">${stateText}</span>
        <span class="indexer-detail">Processing: ${status.processingCnt} | Pending: ${status.pendingCnt} | Completed: ${status.completedCnt} | Failed: ${status.failedCnt}</span>
        <a class="indexer-link" id="view-indexer-link">View Indexer</a>
      </div>
    `;

    container.querySelector('#view-indexer-link').addEventListener('click', (e) => {
      e.preventDefault();
      router.navigate('/admin/indexer');
    });
  }

  #renderCollections(collections) {
    const container = this.shadowRoot.getElementById('collections-list');

    if (!collections || collections.length === 0) {
      container.innerHTML = '<div class="empty-state">No collections found</div>';
      return;
    }

    let html = '<table class="collections-table"><thead><tr><th>Name</th><th>Path</th><th>Items</th><th>Size</th><th>Free Space</th></tr></thead><tbody>';
    for (const c of collections) {
      html += `<tr>
        <td>${c.collection_name || 'Unnamed'}</td>
        <td class="path-cell">${c.collection_path || '--'}</td>
        <td>${c.items.toLocaleString()}</td>
        <td>${this.#formatSize(c.totalSize)}</td>
        <td>${c.freeSpace != null ? this.#formatSize(c.freeSpace) : '--'}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  #formatSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
  }
}

customElements.define('pl-admin-dashboard', PlAdminDashboard);
