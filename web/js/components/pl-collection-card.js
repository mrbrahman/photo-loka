import { notify } from '../utils.mjs';
import { scanForChanges, startIntakeFileIndexing, setAllIntakeStatus, setIntakeStatus, validatePath, listSubDirs } from '../api/admin-api.mjs';
import { cronToHuman } from '../cron-utils.mjs';

import sheet from "./styles/pl-collection-card.css" with { type: "css" };

class PlCollectionCard extends HTMLElement {
  #data = {};

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <sl-details>
        <div slot="summary" class="collection-summary">
          <div class="summary-info">
            <span class="collection-name"></span><sl-badge class="default-badge" variant="primary" pill hidden>Default</sl-badge>
            <span class="collection-path"></span>
          </div>
          <div class="summary-actions" hidden>
            <sl-badge class="status-badge" pill></sl-badge>
            <sl-icon-button class="collection-toggle-btn" label="Toggle intakes"></sl-icon-button>
          </div>
        </div>

        <div class="collection-content">
          <section class="props-section">
            <div class="prop-row"><span class="prop-label">Path</span><span class="prop-value" data-field="path"></span></div>
            <div class="prop-row"><span class="prop-label">Album Type</span><span class="prop-value" data-field="album-type"></span></div>
            <div class="prop-row"><span class="prop-label">Folder Pattern</span><span class="prop-value" data-field="folder-pattern"></span></div>
            <div class="prop-row"><span class="prop-label">Default</span><span class="prop-value" data-field="default"></span></div>
          </section>

          <section class="intake-section" hidden>
            <h4 class="subsection-title">Intake Paths</h4>
            <div class="intake-list"></div>
          </section>

          <footer class="actions-section">
            <div class="actions-left">
              <sl-button size="small" variant="primary" outline class="scan-btn">
                <sl-icon slot="prefix" name="search"></sl-icon>
                Scan for Changes
              </sl-button>
              <!-- Disabled: may overwrite enriched fields (geo_address, faces). Needs revisit.
              <sl-button size="small" variant="neutral" outline disabled title="Disabled: may overwrite enriched fields (geo_address, faces). Needs revisit.">
                <sl-icon slot="prefix" name="arrow-clockwise"></sl-icon>
                Refresh Metadata
              </sl-button>
              -->
              <sl-button size="small" variant="neutral" outline class="adhoc-intake-btn">
                <sl-icon slot="prefix" name="folder-symlink"></sl-icon>
                Ad-hoc Intake
              </sl-button>
            </div>
            <div class="actions-right">
              <sl-button size="small" variant="warning" outline class="edit-btn">
                <sl-icon slot="prefix" name="pencil"></sl-icon>
                Edit
              </sl-button>
            </div>
          </footer>
        </div>
      </sl-details>
    `;
  }

  static intakeTemplate = document.createElement('template');
  static {
    this.intakeTemplate.innerHTML = // html
      `
      <div class="intake-item">
        <div class="intake-header">
          <sl-icon-button class="intake-toggle-btn" label="Toggle intake" hidden></sl-icon-button>
          <sl-badge class="method-badge" pill></sl-badge>
          <span class="intake-path"></span>
        </div>
        <div class="intake-details"></div>
      </div>
    `;
  }

  static immediateDetailsTemplate = document.createElement('template');
  static {
    this.immediateDetailsTemplate.innerHTML = // html
      `
      <div class="prop-row"><span class="prop-label">Await Write Finish</span><span class="prop-value" data-field="awaitWriteFinish"></span></div>
      <div class="prop-row"><span class="prop-label">Ignore Initial</span><span class="prop-value" data-field="ignoreInitial"></span></div>
    `;
  }

  static scheduledDetailsTemplate = document.createElement('template');
  static {
    this.scheduledDetailsTemplate.innerHTML = // html
      `
      <div class="prop-row"><span class="prop-label">Schedule</span><span class="prop-value" data-field="schedule"></span></div>
      <div class="prop-row"><span class="prop-label"></span><span class="prop-value cron-human" data-field="scheduleHuman"></span></div>
      <div class="prop-row"><span class="prop-label">Stale Days</span><span class="prop-value" data-field="staleDays"></span></div>
    `;
  }

  constructor() {
    super().attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
    this.#render();
    this.#setupEventListeners();
  }

  set data(value) {
    this.#data = value;
    if (this.isConnected) this.#render();
  }

  get data() {
    return this.#data;
  }

  #fill(root, map) {
    for (const [sel, val] of Object.entries(map)) {
      root.querySelector(sel).textContent = val;
    }
  }

  #render() {
    const c = this.#data;
    if (!c || !c.collection_id) return;

    this.#fill(this.shadowRoot, {
      '.collection-name': c.collection_name || 'Unnamed',
      '.collection-path': c.collection_path || '--',
      '[data-field="path"]': c.collection_path || '--',
      '[data-field="album-type"]': c.album_type || '--',
      '[data-field="folder-pattern"]': c.apply_folder_pattern || '--',
      '[data-field="default"]': c.default_collection ? 'Yes' : 'No',
    });

    if (c.default_collection) this.shadowRoot.querySelector('.default-badge').hidden = false;

    this.#renderStatusControls(c);
    this.#renderIntakes(c);
  }

  #renderStatusControls(c) {
    const intakeStatus = this.#getIntakeStatus(c);
    if (intakeStatus === 'none') return;

    const controllable = c.intake_configs.filter(i => i.method !== 'on-demand');
    const activeCount = controllable.filter(i => i.status !== 'stopped').length;
    const totalCount = controllable.length;

    const summaryActions = this.shadowRoot.querySelector('.summary-actions');
    summaryActions.hidden = false;

    const badge = summaryActions.querySelector('.status-badge');
    const toggleBtn = summaryActions.querySelector('.collection-toggle-btn');

    if (intakeStatus === 'active') {
      badge.variant = 'success'; badge.textContent = `Active (${activeCount})`;
      toggleBtn.name = 'pause-circle'; toggleBtn.classList.add('status-active');
    } else if (intakeStatus === 'stopped') {
      badge.variant = 'neutral'; badge.textContent = `Stopped (${totalCount})`;
      toggleBtn.name = 'play-circle'; toggleBtn.classList.add('status-stopped');
    } else {
      badge.variant = 'warning'; badge.textContent = `Partial (${activeCount}/${totalCount})`;
      toggleBtn.name = 'pause-circle'; toggleBtn.classList.add('status-mixed');
    }
  }

  #renderIntakes(c) {
    if (!c.intake_configs || c.intake_configs.length === 0) return;

    const intakeSection = this.shadowRoot.querySelector('.intake-section');
    intakeSection.hidden = false;
    const intakeList = intakeSection.querySelector('.intake-list');

    for (let i = 0; i < c.intake_configs.length; i++) {
      const intake = c.intake_configs[i];
      const intakeEl = this.constructor.intakeTemplate.content.cloneNode(true);
      const item = intakeEl.querySelector('.intake-item');
      const isStopped = intake.status === 'stopped';

      if (isStopped) item.classList.add('intake-stopped');

      // Toggle button
      const toggleBtn = item.querySelector('.intake-toggle-btn');
      if (intake.method !== 'on-demand') {
        toggleBtn.hidden = false;
        toggleBtn.name = isStopped ? 'play-circle' : 'pause-circle';
        toggleBtn.classList.add(isStopped ? 'status-stopped' : 'status-active');
        toggleBtn.dataset.intakeIndex = i;
      }

      // Method badge
      const methodBadge = item.querySelector('.method-badge');
      methodBadge.variant = intake.method === 'immediate' ? 'success'
        : intake.method === 'scheduled' ? 'warning' : 'neutral';
      methodBadge.textContent = intake.method;

      item.querySelector('.intake-path').textContent = intake.path;

      this.#renderIntakeDetails(item, intake);
      intakeList.appendChild(intakeEl);
    }
  }

  #renderIntakeDetails(item, intake) {
    const cfg = intake.config;
    if (!cfg || Object.keys(cfg).length === 0) return;

    const detailsEl = item.querySelector('.intake-details');

    if (intake.method === 'immediate') {
      const frag = this.constructor.immediateDetailsTemplate.content.cloneNode(true);
      frag.querySelector('[data-field="awaitWriteFinish"]').textContent = cfg.awaitWriteFinish ? 'Yes' : 'No';
      frag.querySelector('[data-field="ignoreInitial"]').textContent = cfg.ignoreInitial ? 'Yes' : 'No';
      detailsEl.appendChild(frag);
    } else if (intake.method === 'scheduled') {
      const frag = this.constructor.scheduledDetailsTemplate.content.cloneNode(true);
      frag.querySelector('[data-field="schedule"]').textContent = cfg.schedule || '--';
      const humanEl = frag.querySelector('[data-field="scheduleHuman"]');
      const human = cfg.schedule ? cronToHuman(cfg.schedule) : '';
      if (human) {
        humanEl.textContent = human;
      } else {
        humanEl.closest('.prop-row').hidden = true;
      }
      const staleDaysEl = frag.querySelector('[data-field="staleDays"]');
      if (cfg.staleDays !== undefined) {
        staleDaysEl.textContent = cfg.staleDays;
      } else {
        staleDaysEl.closest('.prop-row').hidden = true;
      }
      detailsEl.appendChild(frag);
    }
  }

  #setupEventListeners() {
    this.shadowRoot.querySelector('.scan-btn').addEventListener('click', () => this.#scanForChanges());
    this.shadowRoot.querySelector('.adhoc-intake-btn').addEventListener('click', () => this.#adHocIntake());
    this.shadowRoot.querySelector('.edit-btn').addEventListener('click', () => this.#emitEdit());

    this.shadowRoot.querySelector('.collection-toggle-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.#toggleAllIntakes();
    });

    this.shadowRoot.addEventListener('click', (e) => {
      const btn = e.target.closest('.intake-toggle-btn');
      if (btn) {
        e.stopPropagation();
        this.#toggleIntake(btn);
      }
    });
  }

  #emitEdit() {
    this.dispatchEvent(new CustomEvent('pl-collection-edit', {
      detail: this.#data,
      bubbles: true,
      composed: true,
    }));
  }

  async #scanForChanges() {
    const btn = this.shadowRoot.querySelector('.scan-btn');
    btn.loading = true;
    try {
      await scanForChanges(this.#data.collection_id);
      notify('Scan for changes started', 'success');
    } catch (err) {
      notify('Failed to start scan', 'danger');
      console.error(err);
    } finally {
      btn.loading = false;
    }
  }

  #adHocIntake() {
    const collectionId = this.#data.collection_id;
    let pathTimer = null;

    // Build dialog
    const dialog = document.createElement('sl-dialog');
    dialog.label = 'Ad-hoc Folder Intake';
    dialog.innerHTML = `
      <style>
        .adhoc-path-field { display: flex; flex-direction: column; gap: 4px; }
        .adhoc-path-label { font-size: 0.85rem; font-weight: 600; color: var(--sl-color-neutral-700); }
        .adhoc-path-input {
          width: 100%; box-sizing: border-box;
          padding: 6px 10px; font-size: 0.9rem;
          border: 1px solid var(--sl-color-neutral-300); border-radius: var(--sl-border-radius-medium);
          outline: none; font-family: inherit;
        }
        .adhoc-path-input:focus { border-color: var(--sl-color-primary-500); box-shadow: 0 0 0 2px var(--sl-focus-ring); }
        .adhoc-path-input.valid { border-color: var(--sl-color-success-500); }
        .adhoc-path-input.invalid { border-color: var(--sl-color-danger-500); }
        .adhoc-path-status { font-size: 0.8rem; min-height: 1.1em; }
        .adhoc-path-status.valid { color: var(--sl-color-success-600); }
        .adhoc-path-status.invalid { color: var(--sl-color-danger-600); }
        .adhoc-help { font-size: 0.82rem; color: var(--sl-color-neutral-500); margin-top: 6px; }
      </style>
      <div class="adhoc-path-field">
        <label class="adhoc-path-label">Folder Path</label>
        <input id="adhoc-path-input" class="adhoc-path-input" type="text"
               placeholder="/path/to/folder/" list="adhoc-path-suggestions" autocomplete="off" />
        <datalist id="adhoc-path-suggestions"></datalist>
        <div id="adhoc-path-status" class="adhoc-path-status"></div>
      </div>
      <p class="adhoc-help">All files in this folder will be indexed into this collection (stale days: 0).</p>
      <sl-button slot="footer" variant="primary" id="adhoc-index-btn" disabled>Index</sl-button>
      <sl-button slot="footer" variant="neutral" id="adhoc-cancel-btn">Cancel</sl-button>
    `;

    document.body.appendChild(dialog);
    dialog.show();

    const pathInput = dialog.querySelector('#adhoc-path-input');
    const datalist = dialog.querySelector('#adhoc-path-suggestions');
    const statusEl = dialog.querySelector('#adhoc-path-status');
    const indexBtn = dialog.querySelector('#adhoc-index-btn');

    // Autocomplete: fetch subdirs as user types
    pathInput.addEventListener('input', () => {
      clearTimeout(pathTimer);
      const val = pathInput.value.trim();
      // Reset validation state on new input
      pathInput.classList.remove('valid', 'invalid');
      statusEl.className = 'adhoc-path-status';
      statusEl.textContent = '';
      indexBtn.disabled = true;
      if (val.length < 2) return;
      pathTimer = setTimeout(() => {
        this.#fetchAdHocPathSuggestions(pathInput, datalist);
        this.#validateAdHocPath(pathInput, statusEl, indexBtn);
      }, 400);
    });

    // Also validate on blur in case user pastes and tabs out
    pathInput.addEventListener('blur', () => this.#validateAdHocPath(pathInput, statusEl, indexBtn));

    // Index button
    indexBtn.addEventListener('click', async () => {
      const dir = pathInput.value.trim();
      indexBtn.loading = true;
      try {
        await startIntakeFileIndexing(collectionId, dir, 0);
        dialog.hide();
        notify(`Ad-hoc intake started for: ${dir}`, 'success');
      } catch (err) {
        notify('Failed to start ad-hoc intake', 'danger');
        console.error(err);
        indexBtn.loading = false;
      }
    });

    // Cancel button
    dialog.querySelector('#adhoc-cancel-btn').addEventListener('click', () => dialog.hide());

    // Cleanup
    dialog.addEventListener('sl-after-hide', () => {
      clearTimeout(pathTimer);
      dialog.remove();
    });
  }

  async #fetchAdHocPathSuggestions(inputEl, datalist) {
    const pathStr = inputEl.value.trim();
    const sep = pathStr.includes('\\') ? '\\' : '/';
    let dirToList = pathStr;
    if (!pathStr.endsWith(sep)) {
      const lastSep = Math.max(pathStr.lastIndexOf('/'), pathStr.lastIndexOf('\\'));
      if (lastSep < 0) return;
      dirToList = pathStr.substring(0, lastSep + 1);
    }
    try {
      const dirs = await listSubDirs(dirToList);
      datalist.innerHTML = '';
      for (const d of dirs) {
        datalist.appendChild(Object.assign(document.createElement('option'), { value: dirToList + d + sep }));
      }
    } catch (_) {
      datalist.innerHTML = '';
    }
  }

  async #validateAdHocPath(inputEl, statusEl, indexBtn) {
    const value = inputEl.value.trim();
    if (!value) return;
    try {
      const exists = await validatePath(value);
      if (exists) {
        // Disallow using the collection's own folder as the intake folder
        const normalise = p => (p || '').trim().replace(/\/+$/, '');
        const normValue = normalise(value);
        const normCollPath = normalise(this.#data.collection_path);
        if (normValue === normCollPath) {
          inputEl.classList.remove('valid'); inputEl.classList.add('invalid');
          statusEl.className = 'adhoc-path-status invalid'; statusEl.textContent = 'Cannot use the collection folder itself as intake source';
          indexBtn.disabled = true;
          return;
        }
        inputEl.classList.remove('invalid'); inputEl.classList.add('valid');
        statusEl.className = 'adhoc-path-status valid'; statusEl.textContent = 'Path exists';
        indexBtn.disabled = false;
      } else {
        inputEl.classList.remove('valid'); inputEl.classList.add('invalid');
        statusEl.className = 'adhoc-path-status invalid'; statusEl.textContent = 'Path does not exist';
        indexBtn.disabled = true;
      }
    } catch (_) {
      inputEl.classList.remove('valid'); inputEl.classList.add('invalid');
      statusEl.className = 'adhoc-path-status invalid'; statusEl.textContent = 'Unable to validate path';
      indexBtn.disabled = true;
    }
  }

  async #toggleAllIntakes() {
    const btn = this.shadowRoot.querySelector('.collection-toggle-btn');
    const newStatus = btn.name === 'pause-circle' ? 'stopped' : 'active';
    try {
      await setAllIntakeStatus(this.#data.collection_id, newStatus);
      notify(newStatus === 'active' ? 'Intakes started' : 'Intakes stopped', 'success');

      // Update collection-level button + badge
      const summaryActions = this.shadowRoot.querySelector('.summary-actions');
      const badge = summaryActions.querySelector('.status-badge');
      const totalCount = this.shadowRoot.querySelectorAll('.intake-toggle-btn:not([hidden])').length;

      if (newStatus === 'active') {
        btn.name = 'pause-circle';
        btn.className = 'collection-toggle-btn status-active';
        badge.variant = 'success'; badge.textContent = `Active (${totalCount})`;
      } else {
        btn.name = 'play-circle';
        btn.className = 'collection-toggle-btn status-stopped';
        badge.variant = 'neutral'; badge.textContent = `Stopped (${totalCount})`;
      }

      // Update all per-intake buttons
      this.shadowRoot.querySelectorAll('.intake-toggle-btn:not([hidden])').forEach(iBtn => {
        const item = iBtn.closest('.intake-item');
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
    const intakeIndex = parseInt(btn.dataset.intakeIndex);
    const newStatus = btn.name === 'pause-circle' ? 'stopped' : 'active';
    try {
      await setIntakeStatus(this.#data.collection_id, intakeIndex, newStatus);
      notify(newStatus === 'active' ? 'Intake started' : 'Intake stopped', 'success');

      // Update the clicked button
      const item = btn.closest('.intake-item');
      if (newStatus === 'active') {
        btn.name = 'pause-circle';
        btn.className = 'intake-toggle-btn status-active';
        item.classList.remove('intake-stopped');
      } else {
        btn.name = 'play-circle';
        btn.className = 'intake-toggle-btn status-stopped';
        item.classList.add('intake-stopped');
      }

      // Update collection-level badge + button
      const allBtns = [...this.shadowRoot.querySelectorAll('.intake-toggle-btn:not([hidden])')];
      const activeCount = allBtns.filter(b => b.name === 'pause-circle').length;
      const totalCount = allBtns.length;

      const collBtn = this.shadowRoot.querySelector('.collection-toggle-btn');
      const badge = this.shadowRoot.querySelector('.status-badge');

      if (activeCount === totalCount) {
        collBtn.name = 'pause-circle'; collBtn.className = 'collection-toggle-btn status-active';
        badge.variant = 'success'; badge.textContent = `Active (${activeCount})`;
      } else if (activeCount === 0) {
        collBtn.name = 'play-circle'; collBtn.className = 'collection-toggle-btn status-stopped';
        badge.variant = 'neutral'; badge.textContent = `Stopped (${totalCount})`;
      } else {
        collBtn.name = 'pause-circle'; collBtn.className = 'collection-toggle-btn status-mixed';
        badge.variant = 'warning'; badge.textContent = `Partial (${activeCount}/${totalCount})`;
      }
    } catch (err) {
      notify('Failed to toggle intake', 'danger');
      console.error(err);
    }
  }

  #getIntakeStatus(c) {
    const controllable = (c.intake_configs || []).filter(i => i.method !== 'on-demand');
    if (controllable.length === 0) return 'none';
    const activeCount = controllable.filter(i => i.status !== 'stopped').length;
    if (activeCount === controllable.length) return 'active';
    if (activeCount === 0) return 'stopped';
    return 'mixed';
  }
}

customElements.define('pl-collection-card', PlCollectionCard);
