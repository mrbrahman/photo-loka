import { notify } from '../utils.mjs';
import {
  getIndexerErrors,
  pauseStage, resumeStage, setStageConcurrency,
  getPipelineConfig, validatePipelineConfig, applyPipelineConfig,
  openPipelineEvents,
} from '../api/admin-api.mjs';

import { PipelineDiagramDagre } from '../pipeline-diagram-dagre.mjs';

import sheet from "./styles/pl-admin-indexer.css" with { type: "css" };

// View of the staged indexing pipeline. Live status is driven by the pipeline
// SSE stream (openPipelineEvents), NOT by polling getIndexerStatus: each queue
// is the emitter and pushes a per-stage snapshot { name, status: { pending,
// active, completed, failed, is_paused, max_concurrency, block_reason } } on
// every transition. The server sends one snapshot per stage on connect (so the
// page renders immediately) and is otherwise silent while idle. Per-stage
// controls (pause/resume, concurrency) call the /pipeline endpoints and return
// an authoritative snapshot that is patched in immediately.
//
// Rendering: stage cards are built ONCE and then patched in place as events
// arrive (fields only), so interactive controls -- a focused concurrency input,
// an in-flight button -- are never torn out from under the user by a
// re-render. Incoming events are coalesced and flushed once per animation frame
// so a burst under load does not thrash layout (the server does no throttling).

// Fixed data-flow order for displaying queue cards (matches the pipeline graph).
const STAGE_ORDER = [
  'bring-to-collection',
  'geo-cache',
  'geo-lookup-addr',
  'geo-city-cache',
  'geo-lookup-city',
  'generate-video-thumbnail',
  'generate-image-thumbnails',
  'face-recognition',
  'image-encoding',
  'video-compression',
];

// Short, friendly labels for the queue cards.
const STAGE_LABELS = {
  'bring-to-collection': 'Bring to Collection',
  'geo-cache': 'Geo Cache',
  'geo-lookup-addr': 'Geo Address Lookup',
  'geo-city-cache': 'Geo City Cache',
  'geo-lookup-city': 'Geo City Lookup',
  'generate-video-thumbnail': 'Video Thumbnail',
  'generate-image-thumbnails': 'Image Thumbnails',
  'face-recognition': 'Face Recognition',
  'image-encoding': 'Image Encoding',
  'video-compression': 'Video Compression',
};

class PlAdminIndexer extends HTMLElement {

  // Live status via SSE (replaces the old 1.5s poll of getIndexerStatus).
  #events = null;
  // Pending per-stage snapshots received since the last animation-frame flush,
  // keyed by stage name (latest wins). Flushed in #flushEvents via rAF so a
  // burst of events coalesces into one DOM update pass.
  #pending = new Map();
  #rafId = null;
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

  // localStorage key for the Resource Gates section expand/collapse state (per
  // device). The key string is unchanged for backward compatibility.
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
          <span slot="summary" class="section-title gates-summary">Resource Gates</span>
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
          <h3 class="section-title">Queues</h3>
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
    // Live status comes from SSE (connect snapshot renders the stages
    // immediately). Errors are a separate endpoint with no live stream, so
    // fetch them once on load and again on manual refresh.
    this.#fetchErrors();
    this.#openEvents();
  }

  disconnectedCallback() {
    this.#closeEvents();
    if (this.#dag) { this.#dag.destroy(); this.#dag = null; }
  }

  // openEvents subscribes to the pipeline SSE stream. Each message is a
  // per-stage snapshot { name, status }; we buffer it and flush on the next
  // animation frame (coalescing bursts). The browser auto-reconnects on a
  // dropped connection; onerror just logs (a reconnect re-sends the per-stage
  // connect snapshot, resyncing the view).
  #openEvents() {
    if (this.#events) return;
    const es = openPipelineEvents();
    es.onmessage = (e) => this.#onEvent(e);
    es.onerror = () => {
      // EventSource reconnects automatically; nothing to do but note it. A
      // persistent auth failure (missing/expired refreshToken cookie) will keep
      // erroring -- the user can hit Refresh, which also re-fetches errors.
      console.warn('Pipeline SSE error; browser will attempt to reconnect');
    };
    this.#events = es;
  }

  #closeEvents() {
    if (this.#events) { this.#events.close(); this.#events = null; }
    if (this.#rafId != null) { cancelAnimationFrame(this.#rafId); this.#rafId = null; }
    this.#pending.clear();
  }

  // onEvent parses one SSE message and buffers the stage snapshot for the next
  // frame flush. Malformed payloads are ignored (defensive; the stream is
  // trusted but we never want a bad frame to throw in the handler).
  #onEvent(e) {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (!msg || !msg.name) return;
    this.#pending.set(msg.name, this.#normalizeStatus(msg.status || {}));
    if (this.#rafId == null) {
      this.#rafId = requestAnimationFrame(() => this.#flushEvents());
    }
  }

  // normalizeStatus maps the queue's native event status (snake_case, with a
  // block_reason gate name) into the per-stage snapshot shape the renderer and
  // diagram expect (the same shape the /pipeline control endpoints return):
  // paused, maxConcurrency, and a derived gatedClosed. gatedClosed is true when
  // the queue is blocked by the resource gate -- the queue only reports a block
  // reason when it actually has pending work, so an idle stage reads as idle
  // (not gated), which is the intended behavior.
  #normalizeStatus(s) {
    return {
      pending: s.pending ?? 0,
      active: s.active ?? 0,
      completed: s.completed ?? 0,
      failed: s.failed ?? 0,
      paused: !!s.is_paused,
      maxConcurrency: s.max_concurrency ?? 0,
      gatedClosed: s.block_reason === 'resource',
      blockReason: s.block_reason ?? '',
    };
  }

  // flushEvents applies all buffered stage snapshots in one pass, then clears
  // the buffer. Merges into #status.stages so the full map stays current for
  // the diagram's runtime-state highlighting.
  #flushEvents() {
    this.#rafId = null;
    if (this.#pending.size === 0) return;
    const stages = this.#status.stages || (this.#status.stages = {});
    for (const [name, st] of this.#pending) {
      stages[name] = st;
    }
    this.#pending.clear();
    this.#renderStages(stages);
    if (this.#dag && this.#dagSeeded) this.#dag.setRuntimeState(stages);
  }

  // refresh (manual button): re-fetch errors (no live stream for those) and
  // force a fresh SSE connect so the server re-sends the per-stage snapshot,
  // resyncing status without a separate status poll.
  #refresh() {
    this.#fetchErrors();
    this.#closeEvents();
    this.#openEvents();
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
      // Reconnect the SSE stream so the server re-sends a fresh per-stage
      // snapshot reflecting the new gating/enable/concurrency (a config change
      // may not itself produce queue events if nothing is pending).
      this.#closeEvents();
      this.#openEvents();
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
      // Reconnect SSE to re-pull the per-stage snapshot (see #applyDiagram).
      this.#closeEvents();
      this.#openEvents();
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
