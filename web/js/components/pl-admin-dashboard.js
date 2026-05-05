// Admin Dashboard
// Planned content:
// - Total items by media type (image/video/audio/other) with counts
// - Collection sizes and storage usage
// - Last indexing run timestamp
// - Quick health indicators (error count, indexer state, watcher state)
// - Media type breakdown chart (doughnut/pie)
// - Recent activity summary

import sheet from "./styles/pl-admin-dashboard.css" with { type: "css" };

class PlAdminDashboard extends HTMLElement {

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <div class="container">
        <h2>Dashboard</h2>
        <p class="placeholder">Admin dashboard with collection stats, media type breakdown, and system health overview - TBD</p>
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

customElements.define('pl-admin-dashboard', PlAdminDashboard);
