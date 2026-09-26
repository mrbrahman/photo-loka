import { notify } from '../utils.mjs';
import { getIndexerStatus, getIndexerErrors } from '../api/admin-api.mjs';

import sheet from "./styles/pl-admin-indexer.css" with { type: "css" };

// Display-only view of the staged indexing pipeline. Everything is derived from
// getIndexerStatus, which returns the four cross-stage aggregate counters plus a
// per-stage `stages` map (pending, active, completed, failed, paused,
// gatedClosed, maxConcurrency). Per-stage and global controls (pause/resume,
// concurrency) are intentionally not wired here yet -- a later pass adds them.
//
// TODO: Replace polling with SSE for live updates (see prior plan); add per-stage
// controls once the control UX is designed.

// Fixed data-flow order for displaying stage cards (matches the pipeline graph).
const STAGE_ORDER = [
  'bring-to-collection',
  'geo-lookup',
  'generate-video-thumbnail',
  'generate-image-thumbnails',
  'face-recognition',
  'image-encoding',
  'video-compression',
];

// Short, friendly labels for the stage cards.
const STAGE_LABELS = {
  'bring-to-collection': 'Bring to Collection',
  'geo-lookup': 'Geo Lookup',
  'generate-video-thumbnail': 'Video Thumbnail',
  'generate-image-thumbnails': 'Image Thumbnails',
  'face-recognition': 'Face Recognition',
  'image-encoding': 'Image Encoding',
  'video-compression': 'Video Compression',
};

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

        <!-- Aggregate summary -->
        <div class="section">
          <h3 class="section-title">Overall (since last restart)</h3>
          <div class="status-grid status-row-counters">
            <div class="status-card">
              <div class="status-label">State</div>
              <div class="status-value" id="state-value">--</div>
            </div>
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
        </div>

        <!-- Per-stage cards -->
        <div class="section">
          <h3 class="section-title">Stages</h3>
          <div class="stage-grid" id="stage-grid">
            <div class="empty-state">Loading stages...</div>
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
    this.shadowRoot.getElementById('refresh-btn').addEventListener('click', () => this.#refresh());
    this.#refresh();
    this.#startPolling();
  }

  disconnectedCallback() {
    this.#stopPolling();
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
      this.#status = await getIndexerStatus();
      this.#renderStatus();
    } catch (err) {
      console.error('Indexer status fetch failed:', err);
    }
  }

  #renderStatus() {
    const s = this.#status;

    // Overall state derived from the aggregate counters.
    const stateEl = this.shadowRoot.getElementById('state-value');
    if ((s.processingCnt ?? 0) > 0) {
      stateEl.textContent = 'Running';
      stateEl.className = 'status-value state-running';
    } else if ((s.pendingCnt ?? 0) > 0) {
      stateEl.textContent = 'Waiting';
      stateEl.className = 'status-value state-paused';
    } else {
      stateEl.textContent = 'Idle';
      stateEl.className = 'status-value state-idle';
    }

    this.shadowRoot.getElementById('processing-value').textContent = s.processingCnt ?? '--';
    this.shadowRoot.getElementById('pending-value').textContent = s.pendingCnt ?? '--';
    this.shadowRoot.getElementById('completed-value').textContent = s.completedCnt ?? '--';
    this.shadowRoot.getElementById('failed-value').textContent = s.failedCnt ?? '--';

    this.#renderStages(s.stages || {});
  }

  #renderStages(stages) {
    const grid = this.shadowRoot.getElementById('stage-grid');

    // Preserve fixed data-flow order; append any unknown stages at the end.
    const names = [
      ...STAGE_ORDER.filter(n => stages[n]),
      ...Object.keys(stages).filter(n => !STAGE_ORDER.includes(n)),
    ];

    if (names.length === 0) {
      grid.innerHTML = '<div class="empty-state">No stages</div>';
      return;
    }

    grid.innerHTML = '';
    for (const name of names) {
      grid.appendChild(this.#stageCard(name, stages[name]));
    }
  }

  #stageCard(name, st) {
    const card = document.createElement('div');
    card.className = 'stage-card';

    const { label, variant } = this.#stageState(st);

    const label_ = STAGE_LABELS[name] || name;
    card.innerHTML = // html
      `
      <div class="stage-head">
        <span class="stage-name">${label_}</span>
        <sl-badge variant="${variant}" pill>${label}</sl-badge>
      </div>
      <div class="stage-counters">
        <span title="Active">▶ ${st.active ?? 0}</span>
        <span title="Pending">⋯ ${st.pending ?? 0}</span>
        <span title="Completed" class="${(st.completed ?? 0) > 0 ? 'completed' : ''}">✓ ${st.completed ?? 0}</span>
        <span title="Failed" class="${(st.failed ?? 0) > 0 ? 'failed' : ''}">✕ ${st.failed ?? 0}</span>
      </div>
      <div class="stage-meta">concurrency ${st.maxConcurrency ?? '--'}</div>
    `;
    return card;
  }

  // stageState maps a stage snapshot to a display chip. Order of precedence:
  // paused (admin) > gated (waiting on an upstream) > running > idle.
  #stageState(st) {
    if (st.paused) return { label: 'Paused', variant: 'warning' };
    if (st.gatedClosed) return { label: 'Gated', variant: 'primary' };
    if ((st.active ?? 0) > 0) return { label: 'Running', variant: 'success' };
    return { label: 'Idle', variant: 'neutral' };
  }

  async #fetchErrors() {
    try {
      const errors = await getIndexerErrors();
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
}

customElements.define('pl-admin-indexer', PlAdminIndexer);
