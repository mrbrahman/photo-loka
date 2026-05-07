import { notify } from '../utils.mjs';
import { authenticatedFetch } from '../authn.mjs';

import sheet from "./styles/pl-admin-indexer.css" with { type: "css" };

// TODO: Replace polling with SSE for live updates
// Implementation plan:
// - Server: GET /api/admin/indexer/events (SSE endpoint, auth via refresh token cookie)
// - Single EventSource connection carrying named event types:
//   event: status  -> { processingCnt, pendingCnt, completedCnt, failedCnt, paused, ... }
//   event: activity -> { action: 'start'|'end'|'error', task: '...', duration?: ... }
// - Server subscribes to indexerEvents emitter (start, end, error, start_batch, all_done)
//   and pushes status snapshot after each event
// - Client: EventSource opened on connectedCallback, closed on disconnectedCallback
//   source.addEventListener('status', ...) replaces polling
//   source.addEventListener('activity', ...) feeds a live scrolling activity log
// - Throttle status pushes to max 1/second if indexer is very active

class PlAdminIndexer extends HTMLElement {

  #pollTimer = null;
  #status = {};

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <div class="container">
        <div class="header">
          <h2>Indexer</h2>
          <sl-icon-button id="refresh-btn" name="arrow-clockwise" label="Refresh"></sl-icon-button>
        </div>

        <!-- Status Panel -->
        <div class="section">
          <h3 class="section-title">Status (since last restart)</h3>
          <div class="status-grid status-row-config">
            <div class="status-card">
              <div class="status-label">State</div>
              <div class="status-value" id="state-value">--</div>
            </div>
            <div class="status-card">
              <div class="status-label">Mode</div>
              <div class="status-value" id="mode-value">--</div>
            </div>
            <div class="status-card" id="target-concurrency-card" style="display:none">
              <div class="status-label">Target Concurrency</div>
              <div class="status-value" id="target-concurrency-value">--</div>
            </div>
          </div>
          <div class="status-grid status-row-counters">
            <div class="status-card">
              <div class="status-label">Processing</div>
              <div class="status-value" id="processing-value">--</div>
            </div>
            <div class="status-card">
              <div class="status-label">Pending</div>
              <div class="status-value" id="pending-value">--</div>
            </div>
            <div class="status-card">
              <div class="status-label">Completed</div>
              <div class="status-value" id="completed-value">--</div>
            </div>
            <div class="status-card">
              <div class="status-label">Failed</div>
              <div class="status-value" id="failed-value">--</div>
            </div>
          </div>

          <div class="queue-breakdown" id="queue-breakdown">>
            <span class="queue-label">Queue:</span>
            <sl-badge variant="danger" pill id="queue-high">high: 0</sl-badge>
            <sl-badge variant="primary" pill id="queue-normal">normal: 0</sl-badge>
            <sl-badge variant="neutral" pill id="queue-low">low: 0</sl-badge>
          </div>
        </div>

        <!-- Controls -->
        <div class="section">
          <h3 class="section-title">Controls</h3>
          <div class="controls-row">
            <sl-button id="pause-resume-btn" variant="primary" size="small">
              <sl-icon slot="prefix" id="pause-resume-icon" name="pause-circle"></sl-icon>
              <span id="pause-resume-label">Pause</span>
            </sl-button>

            <div class="concurrency-control">
              <label for="concurrency-input">Max Concurrency:</label>
              <sl-input id="concurrency-input" type="number" size="small" min="1" max="32" style="width:80px"></sl-input>
              <sl-button id="concurrency-btn" size="small" variant="neutral">Apply</sl-button>
            </div>
          </div>
        </div>

        <!-- Errors -->
        <div class="section">
          <h3 class="section-title">
            Errors
            <sl-badge id="error-count" variant="danger" pill style="display:none">0</sl-badge>
          </h3>
          <div id="errors-container">
            <div class="empty-state">No errors</div>
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
    this.#setupEventListeners();
    this.#refresh();
    this.#startPolling();
  }

  disconnectedCallback() {
    this.#stopPolling();
  }

  #setupEventListeners() {
    this.shadowRoot.getElementById('refresh-btn').addEventListener('click', () => this.#refresh());

    this.shadowRoot.getElementById('pause-resume-btn').addEventListener('click', () => this.#togglePauseResume());

    this.shadowRoot.getElementById('concurrency-btn').addEventListener('click', () => this.#updateConcurrency());

    this.shadowRoot.getElementById('concurrency-input').addEventListener('keyup', (e) => {
      if (e.key === 'Enter') this.#updateConcurrency();
    });
  }

  #startPolling() {
    this.#pollTimer = setInterval(() => this.#fetchStatus(), 1500);
  }

  #stopPolling() {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  async #refresh() {
    await Promise.all([this.#fetchStatus(), this.#fetchErrors()]);
  }

  async #fetchStatus() {
    try {
      const res = await authenticatedFetch('/api/admin/getIndexerStatus');
      if (!res.ok) throw new Error('Failed to fetch status');
      this.#status = await res.json();
      this.#renderStatus();
    } catch (err) {
      console.error('Indexer status fetch failed:', err);
    }
  }

  #renderStatus() {
    const s = this.#status;

    // State
    const stateEl = this.shadowRoot.getElementById('state-value');
    if (s.paused) {
      stateEl.textContent = 'Paused';
      stateEl.className = 'status-value state-paused';
    } else if (s.processingCnt > 0) {
      stateEl.textContent = 'Running';
      stateEl.className = 'status-value state-running';
    } else {
      stateEl.textContent = 'Idle';
      stateEl.className = 'status-value state-idle';
    }

    // Counters
    this.shadowRoot.getElementById('processing-value').textContent = s.processingCnt ?? '--';
    this.shadowRoot.getElementById('pending-value').textContent = s.pendingCnt ?? '--';
    this.shadowRoot.getElementById('completed-value').textContent = s.completedCnt ?? '--';
    this.shadowRoot.getElementById('failed-value').textContent = s.failedCnt ?? '--';
    this.shadowRoot.getElementById('mode-value').textContent = s.isDynamic ? 'Dynamic' : 'Static';

    const targetCard = this.shadowRoot.getElementById('target-concurrency-card');
    if (s.isDynamic) {
      targetCard.style.display = '';
      this.shadowRoot.getElementById('target-concurrency-value').textContent = s.dynamicTargetConcurrency ?? '--';
    } else {
      targetCard.style.display = 'none';
    }

    // Queue breakdown
    if (s.queueSizes) {
      this.shadowRoot.getElementById('queue-high').textContent = `high: ${s.queueSizes.high}`;
      this.shadowRoot.getElementById('queue-normal').textContent = `normal: ${s.queueSizes.normal}`;
      this.shadowRoot.getElementById('queue-low').textContent = `low: ${s.queueSizes.low}`;
    }

    // Concurrency input (shows maxConcurrency, which is the adjustable value)
    const concInput = this.shadowRoot.getElementById('concurrency-input');
    if (document.activeElement !== concInput && this.shadowRoot.activeElement !== concInput) {
      concInput.value = s.maxConcurrency ?? '';
    }

    // Pause/Resume button
    const icon = this.shadowRoot.getElementById('pause-resume-icon');
    const label = this.shadowRoot.getElementById('pause-resume-label');
    if (s.paused) {
      icon.name = 'play-circle';
      label.textContent = 'Resume';
    } else {
      icon.name = 'pause-circle';
      label.textContent = 'Pause';
    }
  }

  async #fetchErrors() {
    try {
      const res = await authenticatedFetch('/api/admin/getIndexerErrors');
      if (!res.ok) throw new Error('Failed to fetch errors');
      const errors = await res.json();
      this.#renderErrors(errors);
    } catch (err) {
      console.error('Indexer errors fetch failed:', err);
    }
  }

  #renderErrors(errors) {
    const container = this.shadowRoot.getElementById('errors-container');
    const badge = this.shadowRoot.getElementById('error-count');

    if (!errors || errors.length === 0) {
      container.innerHTML = '<div class="empty-state">No errors</div>';
      badge.style.display = 'none';
      return;
    }

    badge.textContent = errors.length;
    badge.style.display = 'inline-flex';

    container.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'error-list';

    // Show most recent errors first, cap at 50
    const recent = errors.slice(-50).reverse();
    for (const err of recent) {
      const item = document.createElement('div');
      item.className = 'error-item';
      item.textContent = typeof err === 'string' ? err : JSON.stringify(err);
      list.appendChild(item);
    }

    container.appendChild(list);
  }

  async #togglePauseResume() {
    const endpoint = this.#status.paused ? '/api/admin/resumeIndexer' : '/api/admin/pauseIndexer';
    try {
      const res = await authenticatedFetch(endpoint, { method: 'PUT' });
      if (!res.ok) throw new Error('Failed');
      notify(this.#status.paused ? 'Indexer resumed' : 'Indexer paused', 'success');
      await this.#fetchStatus();
    } catch (err) {
      notify('Failed to toggle indexer state', 'danger');
    }
  }

  async #updateConcurrency() {
    const input = this.shadowRoot.getElementById('concurrency-input');
    const value = parseInt(input.value, 10);
    if (!value || value < 1 || value > 32) {
      notify('Concurrency must be between 1 and 32', 'warning');
      return;
    }
    try {
      const res = await authenticatedFetch(`/api/admin/updateIndexerConcurrency/${value}`, { method: 'PUT' });
      if (!res.ok) throw new Error('Failed');
      notify(`Concurrency updated to ${value}`, 'success');
      await this.#fetchStatus();
    } catch (err) {
      notify('Failed to update concurrency', 'danger');
    }
  }
}

customElements.define('pl-admin-indexer', PlAdminIndexer);
