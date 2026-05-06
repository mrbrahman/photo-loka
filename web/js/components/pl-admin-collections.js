// Admin Collections
// Future actions (pending route migration to /api/admin):
// - Start/Stop All Watchers (POST /api/startAllWatchers, /api/stopAllWatchers)
// - Start/Stop Scheduled Indexing (POST /api/startScheduledIndexing, /api/stopScheduledIndexing)
// - Re-index Collection (POST /api/indexCollection/:id)
// - Refresh Metadata (POST /api/refreshMetadataForCollection/:id)
// - Index Now per intake path (POST /api/startIntakeFileIndexing)

import { notify } from '../utils.mjs';
import { authenticatedFetch } from '../authn.mjs';
import { cronToHuman } from '../cron-utils.mjs';

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

        <!-- Page-level controls (disabled placeholders)
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
        -->

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

      let intakeStatus = this.#getCollectionIntakeStatus(c);
      let statusControls = '';
      if (intakeStatus !== 'none') {
        let controllable = c.intake_configs.filter(i => i.method !== 'on-demand');
        let activeCount = controllable.filter(i => i.status !== 'stopped').length;
        let totalCount = controllable.length;
        let badgeVariant, badgeText, icon;
        if (intakeStatus === 'active') {
          badgeVariant = 'success'; badgeText = `Active (${activeCount})`; icon = 'pause-circle';
        } else if (intakeStatus === 'stopped') {
          badgeVariant = 'neutral'; badgeText = `Stopped (${totalCount})`; icon = 'play-circle';
        } else {
          badgeVariant = 'warning'; badgeText = `Partial (${activeCount}/${totalCount})`; icon = 'pause-circle';
        }
        statusControls = `
          <sl-badge variant="${badgeVariant}" pill>${badgeText}</sl-badge>
          <sl-icon-button name="${icon}" class="collection-toggle-btn status-${intakeStatus}" data-collection-id="${c.collection_id}" label="Toggle intakes"></sl-icon-button>
        `;
      }

      summary.innerHTML = `
        <div class="summary-info">
          <span class="collection-name">${c.collection_name || 'Unnamed'} ${c.default_collection ? '<sl-badge variant="primary" pill>Default</sl-badge>' : ''}</span>
          <span class="collection-path">${c.collection_path || '--'}</span>
        </div>
        <div class="summary-actions">
          ${statusControls}
        </div>
      `;
      details.appendChild(summary);

      // Expanded content
      const content = document.createElement('div');
      content.className = 'collection-content';
      content.innerHTML = this.#buildExpandedContent(c);
      details.appendChild(content);

      container.appendChild(details);
    }

    this.#attachActionListeners(collections);
  }

  #attachActionListeners(collections) {
    this.shadowRoot.querySelectorAll('.scan-btn').forEach(btn => {
      btn.addEventListener('click', () => this.#scanForChanges(btn));
    });

    this.shadowRoot.querySelectorAll('.edit-btn').forEach(btn => {
      let collectionId = parseInt(btn.dataset.collectionId);
      let collection = collections.find(c => c.collection_id === collectionId);
      btn.addEventListener('click', () => this.#showForm(collection));
    });

    this.shadowRoot.querySelectorAll('.collection-toggle-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // prevent sl-details from toggling
        this.#toggleAllIntakes(btn);
      });
    });

    this.shadowRoot.querySelectorAll('.intake-toggle-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.#toggleIntake(btn);
      });
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

  async #toggleAllIntakes(btn) {
    let collectionId = parseInt(btn.dataset.collectionId);
    let newStatus = btn.name === 'pause-circle' ? 'stopped' : 'active';
    try {
      let res = await authenticatedFetch(`/api/admin/setAllIntakeStatus/${collectionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      if (!res.ok) throw new Error('Failed');
      notify(newStatus === 'active' ? 'Intakes started' : 'Intakes stopped', 'success');

      // Update collection-level button + badge
      let summaryActions = btn.closest('.summary-actions');
      let badge = summaryActions.querySelector('sl-badge[variant="success"], sl-badge[variant="neutral"], sl-badge[variant="warning"]');
      let card = btn.closest('sl-details');
      let totalCount = card.querySelectorAll('.intake-toggle-btn').length;

      if (newStatus === 'active') {
        btn.name = 'pause-circle';
        btn.className = 'collection-toggle-btn status-active';
        if (badge) { badge.variant = 'success'; badge.textContent = `Active (${totalCount})`; }
      } else {
        btn.name = 'play-circle';
        btn.className = 'collection-toggle-btn status-stopped';
        if (badge) { badge.variant = 'neutral'; badge.textContent = `Stopped (${totalCount})`; }
      }

      // Update all per-intake buttons in this collection's card
      card.querySelectorAll('.intake-toggle-btn').forEach(iBtn => {
        let item = iBtn.closest('.intake-item');
        if (newStatus === 'active') {
          iBtn.name = 'pause-circle';
          iBtn.className = 'intake-toggle-btn status-active';
          item.classList.remove('intake-stopped');
        } else {
          iBtn.name = 'play-circle';
          iBtn.className = 'intake-toggle-btn status-stopped';
          item.classList.add('intake-stopped');
        }
      });
    } catch (err) {
      notify('Failed to toggle intakes', 'danger');
      console.error(err);
    }
  }

  async #toggleIntake(btn) {
    let collectionId = parseInt(btn.dataset.collectionId);
    let intakeIndex = parseInt(btn.dataset.intakeIndex);
    let newStatus = btn.name === 'pause-circle' ? 'stopped' : 'active';
    try {
      let res = await authenticatedFetch(`/api/admin/setIntakeStatus/${collectionId}/${intakeIndex}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus })
      });
      if (!res.ok) throw new Error('Failed');
      notify(newStatus === 'active' ? 'Intake started' : 'Intake stopped', 'success');

      // Update the clicked button + item opacity
      let item = btn.closest('.intake-item');
      if (newStatus === 'active') {
        btn.name = 'pause-circle';
        btn.className = 'intake-toggle-btn status-active';
        item.classList.remove('intake-stopped');
      } else {
        btn.name = 'play-circle';
        btn.className = 'intake-toggle-btn status-stopped';
        item.classList.add('intake-stopped');
      }

      // Update collection-level badge + button based on new aggregate state
      let card = btn.closest('sl-details');
      let allBtns = [...card.querySelectorAll('.intake-toggle-btn')];
      let activeCount = allBtns.filter(b => b.name === 'pause-circle').length;
      let totalCount = allBtns.length;

      let summaryActions = card.querySelector('.summary-actions');
      let collBtn = summaryActions.querySelector('.collection-toggle-btn');
      let badge = summaryActions.querySelector('sl-badge[variant="success"], sl-badge[variant="neutral"], sl-badge[variant="warning"]');

      if (activeCount === totalCount) {
        if (collBtn) { collBtn.name = 'pause-circle'; collBtn.className = 'collection-toggle-btn status-active'; }
        if (badge) { badge.variant = 'success'; badge.textContent = `Active (${activeCount})`; }
      } else if (activeCount === 0) {
        if (collBtn) { collBtn.name = 'play-circle'; collBtn.className = 'collection-toggle-btn status-stopped'; }
        if (badge) { badge.variant = 'neutral'; badge.textContent = `Stopped (${totalCount})`; }
      } else {
        if (collBtn) { collBtn.name = 'pause-circle'; collBtn.className = 'collection-toggle-btn status-mixed'; }
        if (badge) { badge.variant = 'warning'; badge.textContent = `Partial (${activeCount}/${totalCount})`; }
      }
    } catch (err) {
      notify('Failed to toggle intake', 'danger');
      console.error(err);
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
      for (let i = 0; i < c.intake_configs.length; i++) {
        const intake = c.intake_configs[i];
        const methodBadge = this.#getMethodBadge(intake.method);
        const configDetails = this.#formatIntakeConfig(intake);
        const isOnDemand = intake.method === 'on-demand';
        const isStopped = intake.status === 'stopped';

        let toggleBtn = '';
        if (!isOnDemand) {
          let icon = isStopped ? 'play-circle' : 'pause-circle';
          let cls = isStopped ? 'status-stopped' : 'status-active';
          toggleBtn = `<sl-icon-button name="${icon}" class="intake-toggle-btn ${cls}" data-collection-id="${c.collection_id}" data-intake-index="${i}" label="Toggle intake"></sl-icon-button>`;
        }

        html += `
          <div class="intake-item ${isStopped ? 'intake-stopped' : ''}">
            <div class="intake-header">
              ${toggleBtn}
              ${methodBadge}
              <span class="intake-path">${intake.path}</span>
            </div>
            ${configDetails}
          </div>
        `;
      }
      html += '</div>';
    }

    // Actions section
    html += `
      <div class="actions-section">
        <div class="actions-left">
          <sl-button size="small" variant="primary" outline class="scan-btn" data-collection-id="${c.collection_id}">
            <sl-icon slot="prefix" name="search"></sl-icon>
            Scan for Changes
          </sl-button>
          <sl-button size="small" variant="neutral" outline disabled title="Disabled: may overwrite enriched fields (geo_address, faces). Needs revisit.">
            <sl-icon slot="prefix" name="arrow-clockwise"></sl-icon>
            Refresh Metadata
          </sl-button>
        </div>
        <div class="actions-right">
          <sl-button size="small" variant="warning" outline class="edit-btn" data-collection-id="${c.collection_id}">
            <sl-icon slot="prefix" name="pencil"></sl-icon>
            Edit
          </sl-button>
        </div>
      </div>
    `;

    return html;
  }

  #getCollectionIntakeStatus(c) {
    // Returns 'active', 'stopped', 'mixed', or 'none' (all on-demand)
    let controllable = (c.intake_configs || []).filter(i => i.method !== 'on-demand');
    if (controllable.length === 0) return 'none';
    let activeCount = controllable.filter(i => i.status !== 'stopped').length;
    if (activeCount === controllable.length) return 'active';
    if (activeCount === 0) return 'stopped';
    return 'mixed';
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

    let rows = '';
    if (intake.method === 'immediate') {
      if (intake.config.awaitWriteFinish !== undefined) {
        rows += `<div class="prop-row"><span class="prop-label">Await Write Finish</span><span class="prop-value">${intake.config.awaitWriteFinish ? 'Yes' : 'No'}</span></div>`;
      }
      if (intake.config.ignoreInitial !== undefined) {
        rows += `<div class="prop-row"><span class="prop-label">Ignore Initial</span><span class="prop-value">${intake.config.ignoreInitial ? 'Yes' : 'No'}</span></div>`;
      }
    } else if (intake.method === 'scheduled') {
      if (intake.config.schedule) {
        let human = cronToHuman(intake.config.schedule);
        rows += `<div class="prop-row"><span class="prop-label">Schedule</span><span class="prop-value">${intake.config.schedule}</span></div>`;
        if (human) {
          rows += `<div class="prop-row"><span class="prop-label"></span><span class="prop-value cron-human">${human}</span></div>`;
        }
      }
      if (intake.config.staleDays !== undefined) {
        rows += `<div class="prop-row"><span class="prop-label">Stale Days</span><span class="prop-value">${intake.config.staleDays}</span></div>`;
      }
    }

    return rows ? `<div class="intake-details">${rows}</div>` : '';
  }
}

customElements.define('pl-admin-collections', PlAdminCollections);
