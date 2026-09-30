import { notify } from '../utils.mjs';
import {
  getIndexerStatus, getIndexerErrors,
  pauseStage, resumeStage, setStageConcurrency,
  getPipelineConfig, validatePipelineConfig, applyPipelineConfig,
} from '../api/admin-api.mjs';

import { PipelineDiagramDagre } from '../pipeline-diagram-dagre.mjs';

import sheet from "./styles/pl-admin-indexer.css" with { type: "css" };

// View of the staged indexing pipeline. The display is driven by
// getIndexerStatus (four cross-stage aggregate counters + a per-stage `stages`
// map: pending, active, completed, failed, paused, gatedClosed, maxConcurrency).
// Per-stage controls (pause/resume, concurrency) call the /pipeline endpoints.
//
// Rendering: stage cards are built ONCE and then patched in place on each poll
// (fields only), so interactive controls -- a focused concurrency input, an
// in-flight button -- are never torn out from under the user by a re-render.
//
// TODO: Replace polling with SSE for live updates (see prior plan).

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
  // stage name -> { card, refs } built once and patched in place.
  #cards = new Map();
  // Interactive gate-graph editor instance (seeded from getPipelineConfig).
  #dag = null;
  // Latest model held by the diagram (updated via its onChange), applied on Apply.
  #dagModel = null;
  // Whether the diagram has been seeded yet. It is lazily seeded on first expand
  // of the collapsible section (a collapsed container has no usable layout).
  #dagSeeded = false;

  // localStorage key for the Pipeline gates expand/collapse state (per device).
  static PIPELINE_OPEN_KEY = 'pl:indexer:pipelineGatesOpen';

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <div class="container">
        <div class="header">
          <h2>Indexer</h2>
          <sl-icon-button id="refresh-btn" name="arrow-clockwise" label="Refresh"></sl-icon-button>
        </div>

        <!-- Gate-graph editor (primary). Edits the resource-gating graph and
             per-stage concurrency; Apply validates + applies live. Collapsible;
             open/closed state persists per-device in localStorage. The diagram
             is lazily seeded on first expand (a collapsed, display:none
             container has no usable layout for the SVG). -->
        <sl-details id="gates-details" class="section gates-details">
          <span slot="summary" class="section-title gates-summary">Pipeline gates</span>
          <p class="section-hint">
            Click one stage then another to add a gate (upstream blocks the
            gated stage). Click an edge or its lock to remove it. Use the power
            icon to enable/disable an optional stage (required stages have none).
            Edit a stage's concurrency inline. Changes apply only when you press Apply.
          </p>
          <div id="dag-container" class="dag-container"></div>
          <div class="config-controls">
            <sl-button id="dag-reset" size="small" variant="neutral">Reset</sl-button>
            <sl-button id="dag-apply" size="small" variant="primary">Apply live</sl-button>
          </div>
        </sl-details>

        <!-- Pipeline config editor (raw) -- TEMPORARILY DISABLED. The diagram
             above is now the primary editor; this raw textarea escape hatch is
             commented out and will be removed in a subsequent iteration once the
             diagram is fully trusted. Re-enable by uncommenting this block and
             the corresponding wiring in connectedCallback + #applyDiagram.
        <div class="section">
          <h3 class="section-title">Pipeline config (raw)</h3>
          <textarea id="config-text" class="config-text" rows="14" spellcheck="false" placeholder="Loading current config..."></textarea>
          <div class="config-controls">
            <sl-button id="config-load" size="small" variant="neutral">Reload</sl-button>
            <sl-button id="config-validate" size="small" variant="neutral">Validate</sl-button>
            <sl-button id="config-apply" size="small" variant="primary">Apply live</sl-button>
          </div>
        </div>
        -->

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

    // Raw config editor (temporary testing tool) -- DISABLED along with its
    // template section; re-enable both together.
    const root = this.shadowRoot;
    // root.getElementById('config-load').addEventListener('click', () => this.#loadConfig());
    // root.getElementById('config-validate').addEventListener('click', () => this.#validateConfig());
    // root.getElementById('config-apply').addEventListener('click', () => this.#applyConfig());

    // Interactive gate-graph editor.
    root.getElementById('dag-reset').addEventListener('click', () => this.#seedDiagram());
    root.getElementById('dag-apply').addEventListener('click', () => this.#applyDiagram());
    this.#initDiagram();

    // Collapsible Pipeline gates section: restore persisted open/closed state,
    // persist on toggle, and lazily seed the diagram on first expand (a
    // collapsed, display:none container has no usable layout for the SVG).
    const details = root.getElementById('gates-details');
    const startOpen = this.#loadGatesOpen();
    details.open = startOpen;
    details.addEventListener('sl-show', (e) => {
      if (e.target !== details) return; // ignore bubbled events from nested sl-* components
      this.#persistGatesOpen(true);
      this.#ensureDiagramSeeded();
    });
    details.addEventListener('sl-hide', (e) => {
      if (e.target !== details) return;
      this.#persistGatesOpen(false);
    });
    // If it starts open, sl-show does not fire on its own, so seed now.
    if (startOpen) this.#ensureDiagramSeeded();

    // this.#loadConfig(); // pre-load the current config into the raw editor (disabled)
    this.#refresh();
    this.#startPolling();
  }

  disconnectedCallback() {
    this.#stopPolling();
    if (this.#dag) { this.#dag.destroy(); this.#dag = null; }
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
    // Only per-stage cards are shown now; the aggregate "Overall" panel was
    // removed (per-stage numbers are what matter).
    const stages = this.#status.stages || {};
    this.#renderStages(stages);
    // Feed live gating/paused/active state into the diagram for highlighting
    // (only once seeded -- while the section is collapsed there is nothing to style).
    if (this.#dag && this.#dagSeeded) this.#dag.setRuntimeState(stages);
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
      this.#cards.clear();
      return;
    }

    // Clear the initial "Loading..." placeholder once, on first real render.
    if (this.#cards.size === 0) grid.innerHTML = '';

    for (const name of names) {
      let entry = this.#cards.get(name);
      if (!entry) {
        entry = this.#buildCard(name);
        this.#cards.set(name, entry);
        grid.appendChild(entry.card);
      }
      this.#patchCard(entry.refs, stages[name]);
    }
  }

  // buildCard creates a stage card ONCE, wiring its controls to `name`. Returns
  // the card element plus refs to the fields patched on each poll.
  #buildCard(name) {
    const card = document.createElement('div');
    card.className = 'stage-card';
    card.innerHTML = // html
      `
      <div class="stage-head">
        <span class="stage-name">${STAGE_LABELS[name] || name}</span>
        <sl-badge class="stage-chip" pill>--</sl-badge>
      </div>
      <div class="stage-counters">
        <span title="Active" class="c-active">▶ 0</span>
        <span title="Pending" class="c-pending">⋯ 0</span>
        <span title="Completed" class="c-completed">✓ 0</span>
        <span title="Failed" class="c-failed">✕ 0</span>
      </div>
      <div class="stage-controls">
        <sl-tooltip content="Pause">
          <sl-icon-button class="pause-btn" name="pause-circle" label="Pause"></sl-icon-button>
        </sl-tooltip>
        <div class="conc-control">
          <label>conc</label>
          <sl-input class="conc-input" type="number" size="small" min="1" max="64" autocomplete="off"></sl-input>
          <sl-icon-button class="conc-apply" name="check-lg" label="Apply concurrency"></sl-icon-button>
        </div>
      </div>
    `;

    const refs = {
      chip: card.querySelector('.stage-chip'),
      active: card.querySelector('.c-active'),
      pending: card.querySelector('.c-pending'),
      completed: card.querySelector('.c-completed'),
      failed: card.querySelector('.c-failed'),
      pauseBtn: card.querySelector('.pause-btn'),
      concInput: card.querySelector('.conc-input'),
      concApply: card.querySelector('.conc-apply'),
    };

    // Pause/resume: the button's current intent is tracked via a data attribute
    // set in patchCard (so we act on the latest known state, not a closure).
    refs.pauseBtn.addEventListener('click', () => this.#togglePause(name, refs));

    const applyConc = () => this.#applyConcurrency(name, refs);
    refs.concApply.addEventListener('click', applyConc);
    refs.concInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyConc(); });
    // Mark the apply button "dirty" (unsaved) whenever the input diverges from
    // the last-saved server value; cleared once the change is saved (patchCard).
    refs.concInput.addEventListener('sl-input', () => this.#updateConcDirty(refs));

    return { card, refs };
  }

  // updateConcDirty toggles the apply button's dirty styling based on whether
  // the input value differs from the saved server value (stored on the input's
  // data-saved attribute by patchCard).
  #updateConcDirty(refs) {
    const saved = refs.concInput.dataset.saved ?? '';
    const dirty = String(refs.concInput.value) !== String(saved);
    refs.concApply.classList.toggle('dirty', dirty);
  }

  // patchCard updates only the mutable fields of an existing card.
  #patchCard(refs, st) {
    const { label, variant } = this.#stageState(st);
    refs.chip.textContent = label;
    refs.chip.setAttribute('variant', variant);

    refs.active.textContent = `▶ ${st.active ?? 0}`;
    refs.pending.textContent = `⋯ ${st.pending ?? 0}`;
    refs.completed.textContent = `✓ ${st.completed ?? 0}`;
    refs.completed.classList.toggle('completed', (st.completed ?? 0) > 0);
    refs.failed.textContent = `✕ ${st.failed ?? 0}`;
    refs.failed.classList.toggle('failed', (st.failed ?? 0) > 0);

    // Pause/resume button reflects current paused state.
    const paused = !!st.paused;
    refs.pauseBtn.name = paused ? 'play-circle' : 'pause-circle';
    refs.pauseBtn.label = paused ? 'Resume' : 'Pause';
    refs.pauseBtn.dataset.paused = paused ? '1' : '0';

    // Record the authoritative server value so the dirty check compares against
    // it. Sync the visible input only when the user is not editing (avoids
    // clobbering what they are typing); then refresh the apply button's dirty
    // styling (clears it once a save makes input == saved).
    const serverVal = st.maxConcurrency ?? '';
    refs.concInput.dataset.saved = String(serverVal);
    if (this.shadowRoot.activeElement !== refs.concInput) {
      refs.concInput.value = serverVal;
    }
    this.#updateConcDirty(refs);
  }

  // stageState maps a stage snapshot to a display chip. Order of precedence:
  // paused (admin) > gated (waiting on an upstream) > running > idle.
  #stageState(st) {
    if (st.paused) return { label: 'Paused', variant: 'warning' };
    if (st.gatedClosed) return { label: 'Gated', variant: 'primary' };
    if ((st.active ?? 0) > 0) return { label: 'Running', variant: 'success' };
    return { label: 'Idle', variant: 'neutral' };
  }

  async #togglePause(name, refs) {
    const paused = refs.pauseBtn.dataset.paused === '1';
    try {
      const st = paused ? await resumeStage(name) : await pauseStage(name);
      this.#patchCard(refs, st); // immediate authoritative update
      notify(`${STAGE_LABELS[name] || name} ${paused ? 'resumed' : 'paused'}`, 'success');
    } catch (err) {
      notify(`Failed to ${paused ? 'resume' : 'pause'} ${name}`, 'danger');
      console.error(err);
    }
  }

  async #applyConcurrency(name, refs) {
    const n = parseInt(refs.concInput.value, 10);
    if (!n || n < 1) {
      notify('Concurrency must be a positive integer', 'warning');
      return;
    }
    try {
      const st = await setStageConcurrency(name, n);
      this.#patchCard(refs, st);
      refs.concInput.blur(); // release focus so future polls can sync
      notify(`${STAGE_LABELS[name] || name} concurrency set to ${n}`, 'success');
    } catch (err) {
      notify(`Failed to set concurrency for ${name}`, 'danger');
      console.error(err);
    }
  }

  // --- Interactive gate-graph editor ---

  // loadGatesOpen reads the persisted expand/collapse state. Defaults to
  // collapsed (false) when nothing is stored. Wrapped in try/catch (private
  // mode / disabled storage), mirroring pl-gallery's layout-mode persistence.
  #loadGatesOpen() {
    try {
      return localStorage.getItem(this.constructor.PIPELINE_OPEN_KEY) === '1';
    } catch (e) { /* ignore */ return false; }
  }

  #persistGatesOpen(open) {
    try {
      localStorage.setItem(this.constructor.PIPELINE_OPEN_KEY, open ? '1' : '0');
    } catch (e) { /* ignore */ }
  }

  // ensureDiagramSeeded seeds the diagram once, on first expand. Subsequent
  // expands are no-ops (the diagram keeps its state); use Reset to reload.
  #ensureDiagramSeeded() {
    if (this.#dagSeeded) return;
    this.#seedDiagram();
  }

  #initDiagram() {
    const container = this.shadowRoot.getElementById('dag-container');
    this.#dag = new PipelineDiagramDagre(container, {
      onChange: ({ model, error }) => {
        if (error) { notify(error, 'warning'); return; }
        if (model) this.#dagModel = model; // hold; apply only on Apply click
      },
    });
  }

  // seedDiagram loads the current config into the diagram. Runs in its own
  // try/catch (independent of the raw config fetch) so a diagram failure never
  // blocks the rest of the indexer view.
  async #seedDiagram() {
    if (!this.#dag) return;
    try {
      const cfg = await getPipelineConfig();
      this.#dag.setModel(cfg);
      this.#dagModel = this.#dag.getModel();
      this.#dagSeeded = true;
    } catch (err) {
      console.error('Diagram seed failed:', err);
      notify(this.#errMsg(err, 'Failed to load pipeline diagram'), 'danger');
    }
  }

  // applyDiagram serializes the diagram's model and applies it live (server
  // re-validates). On success, reseed both the diagram and the raw editor so
  // they reflect the persisted config.
  async #applyDiagram() {
    if (!this.#dag) return;
    const model = this.#dagModel || this.#dag.getModel();
    try {
      await applyPipelineConfig(JSON.stringify(model));
      notify('Pipeline gates applied live', 'success');
      await this.#fetchStatus();     // reflect new gating/enable/concurrency
      // (raw editor sync removed: the raw textarea is temporarily disabled)
    } catch (err) {
      notify(this.#errMsg(err, 'Failed to apply pipeline gates'), 'danger');
    }
  }

  // --- Raw config editor (temporary testing tool) ---

  #configText() {
    return this.shadowRoot.getElementById('config-text');
  }

  async #loadConfig() {
    try {
      const cfg = await getPipelineConfig();
      this.#configText().value = JSON.stringify(cfg, null, 2);
      notify('Loaded current pipeline config', 'success');
    } catch (err) {
      notify(this.#errMsg(err, 'Failed to load config'), 'danger');
    }
  }

  async #validateConfig() {
    const text = this.#configText().value.trim();
    if (!text) { notify('Config is empty', 'warning'); return; }
    try {
      await validatePipelineConfig(text);
      notify('Config is valid', 'success');
    } catch (err) {
      notify(this.#errMsg(err, 'Config is invalid'), 'danger');
    }
  }

  async #applyConfig() {
    const text = this.#configText().value.trim();
    if (!text) { notify('Config is empty', 'warning'); return; }
    try {
      await applyPipelineConfig(text);
      notify('Config applied live', 'success');
      await this.#fetchStatus(); // reflect the new gating/enable/concurrency
    } catch (err) {
      notify(this.#errMsg(err, 'Failed to apply config'), 'danger');
    }
  }

  // errMsg extracts the server's error message (throwError rejects with the
  // parsed JSON body: { error: { message } }), falling back to a default.
  #errMsg(err, fallback) {
    return err?.error?.message ? `${fallback}: ${err.error.message}` : fallback;
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
