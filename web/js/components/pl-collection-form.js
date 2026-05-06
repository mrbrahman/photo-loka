import { notify } from '../utils.mjs';
import { authenticatedFetch } from '../authn.mjs';
import { cronToHuman, isValidCron } from '../cron-utils.mjs';

import sheet from "./styles/pl-collection-form.css" with { type: "css" };

class PlCollectionForm extends HTMLElement {
  #data = {};
  #isEdit = false;
  #pathTimers = {};
  #patternTimer = null;
  #originalPattern = '';

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <div class="container">
        <div class="form-header">
          <sl-icon-button id="back-btn" name="arrow-left" label="Back"></sl-icon-button>
          <h2 id="form-title">New Collection</h2>
        </div>

        <form id="collection-form" novalidate>
          <div class="form-grid">

            <sl-input id="collection-name" label="Collection Name" required class="full-width"></sl-input>

            <!-- Using native <input> + <datalist> for path fields because
                 sl-input uses Shadow DOM which prevents datalist association -->
            <div class="path-field full-width">
              <label class="path-label">Collection Path *</label>
              <input id="collection-path" class="path-input" type="text"
                     placeholder="/path/to/collection/" list="path-suggestions" autocomplete="off" />
              <datalist id="path-suggestions"></datalist>
              <div id="path-status" class="path-status"></div>
            </div>

            <sl-select id="album-type" label="Album Type" value="FOLDER_ALBUM">
              <sl-option value="FOLDER_ALBUM">Folder Album</sl-option>
              <sl-option value="VIRTUAL_ALBUM">Virtual Album</sl-option>
            </sl-select>

            <sl-input id="trash-days" label="Trash Days" type="number" value="30"></sl-input>

            <div class="full-width">
              <sl-input id="folder-pattern" label="Folder Pattern" placeholder="yyyy/yyyy-mm-dd">
                <span slot="help-text">Uses <a href="https://github.com/felixge/node-dateformat#mask-options" target="_blank" rel="noopener" class="pattern-link">dateformat</a> tokens. E.g.: yyyy (year), mm (month), dd (day)</span>
              </sl-input>
              <div id="pattern-status" class="pattern-help"></div>
            </div>

            <sl-switch id="default-collection">Default Collection</sl-switch>

          </div>

          <!-- Intake Paths Section -->
          <div class="intake-section">
            <div class="intake-section-header">
              <h4 class="intake-section-title">Intake Paths</h4>
            </div>
            <div id="intake-cards" class="intake-cards"></div>
            <sl-button id="add-intake-btn" size="small" variant="default">
              <sl-icon slot="prefix" name="plus-lg"></sl-icon>
              Add Intake Path
            </sl-button>
          </div>

          <!-- Form Actions -->
          <div class="form-actions">
            <sl-button id="save-index-btn" variant="primary">
              <sl-icon slot="prefix" name="play-fill"></sl-icon>
              Save and Start Indexing
            </sl-button>
            <sl-button id="save-btn" variant="default">
              Save Only
            </sl-button>
            <sl-button id="cancel-btn" variant="default">Cancel</sl-button>
          </div>
        </form>
      </div>
    `;
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  set data(value) {
    this.#data = value || {};
    this.#isEdit = !!value?.collection_id;
  }

  get data() {
    return this.#data;
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
    this.#populateForm();
    this.#setupEventListeners();
  }

  #populateForm() {
    let sr = this.shadowRoot;

    if (this.#isEdit) {
      sr.getElementById('form-title').textContent = 'Edit Collection';
      sr.getElementById('save-index-btn').style.display = 'none';
      sr.getElementById('save-btn').variant = 'primary';
      sr.getElementById('save-btn').textContent = 'Save';
      sr.getElementById('collection-path').disabled = true;
    }

    let d = this.#data;
    sr.getElementById('collection-name').value = d.collection_name || '';
    sr.getElementById('collection-path').value = d.collection_path || '';
    sr.getElementById('album-type').value = d.album_type || 'FOLDER_ALBUM';
    sr.getElementById('trash-days').value = d.trash_days ?? 30;
    sr.getElementById('folder-pattern').value = d.apply_folder_pattern || '';
    sr.getElementById('default-collection').checked = !!d.default_collection;

    // Store original pattern for change detection in edit mode
    this.#originalPattern = d.apply_folder_pattern || '';

    // Show example if pattern has a value
    if (d.apply_folder_pattern) {
      this.#validateFolderPattern();
    }

    // Validate pre-filled path (only in create mode)
    if (!this.#isEdit && d.collection_path) {
      this.#validatePath('collection-path', d.collection_path);
    }

    // Render existing intake configs
    if (d.intake_configs && d.intake_configs.length > 0) {
      for (let intake of d.intake_configs) {
        this.#addIntakeCard(intake);
      }
    }
  }

  #setupEventListeners() {
    let sr = this.shadowRoot;

    sr.getElementById('back-btn').addEventListener('click', () => this.#cancel());
    sr.getElementById('cancel-btn').addEventListener('click', () => this.#cancel());
    sr.getElementById('save-btn').addEventListener('click', () => this.#save(false));
    sr.getElementById('save-index-btn').addEventListener('click', () => this.#save(true));
    sr.getElementById('add-intake-btn').addEventListener('click', () => this.#addIntakeCard());

    // Collection path autocomplete + validation
    let pathInput = sr.getElementById('collection-path');
    pathInput.addEventListener('input', () => this.#onPathInput('collection-path', pathInput));
    pathInput.addEventListener('blur', () => this.#validatePath('collection-path', pathInput.value));

    // Folder pattern validation (debounced on input)
    let patternInput = sr.getElementById('folder-pattern');
    patternInput.addEventListener('sl-input', () => {
      clearTimeout(this.#patternTimer);
      this.#patternTimer = setTimeout(() => this.#validateFolderPattern(), 300);
    });
  }

  // --- Path Autocomplete & Validation ---

  #onPathInput(id, input) {
    clearTimeout(this.#pathTimers[id]);
    let val = input.value.trim();
    if (val.length < 2) return;
    this.#pathTimers[id] = setTimeout(() => this.#fetchPathSuggestions(id, val), 300);
  }

  async #fetchPathSuggestions(id, pathStr) {
    let sr = this.shadowRoot;
    let datalistId = id === 'collection-path' ? 'path-suggestions' : `${id}-suggestions`;
    let datalist = sr.getElementById(datalistId);

    // Determine the directory to list:
    // If path ends with a separator, use it directly.
    // Otherwise, use the parent directory (user is typing a partial name).
    let sep = pathStr.includes('\\') ? '\\' : '/';
    let dirToList = pathStr;
    if (!pathStr.endsWith(sep)) {
      let lastSep = Math.max(pathStr.lastIndexOf('/'), pathStr.lastIndexOf('\\'));
      if (lastSep < 0) return;
      dirToList = pathStr.substring(0, lastSep + 1);
    }

    try {
      let res = await authenticatedFetch(`/api/admin/listSubDirs?path=${encodeURIComponent(dirToList)}`);
      if (!res.ok) {
        if (datalist) datalist.innerHTML = '';
        return;
      }
      let dirs = await res.json();

      if (datalist) {
        datalist.innerHTML = '';
        for (let d of dirs) {
          datalist.appendChild(Object.assign(document.createElement('option'), { value: dirToList + d + sep }));
        }
      }
    } catch (err) {
      if (datalist) datalist.innerHTML = '';
    }
  }

  async #validatePath(id, value) {
    if (!value || !value.trim()) return;
    let sr = this.shadowRoot;
    let statusEl = id === 'collection-path'
      ? sr.getElementById('path-status')
      : sr.querySelector(`[data-path-status="${id}"]`);

    try {
      let res = await authenticatedFetch(`/api/admin/listSubDirs?path=${encodeURIComponent(value.trim())}`);
      if (!res.ok) {
        this.#setPathStatus(statusEl, 'invalid', 'Path does not exist');
        sr.getElementById(id).classList.remove('valid');
        sr.getElementById(id).classList.add('invalid');
      } else {
        this.#setPathStatus(statusEl, 'valid', 'Path exists');
        sr.getElementById(id).classList.remove('invalid');
        sr.getElementById(id).classList.add('valid');
      }
    } catch (err) {
      this.#setPathStatus(statusEl, 'invalid', 'Unable to validate path');
    }
  }

  #setPathStatus(el, state, message) {
    if (!el) return;
    el.className = `path-status ${state}`;
    el.textContent = message;
  }

  // --- Folder Pattern Validation ---

  async #validateFolderPattern() {
    let sr = this.shadowRoot;
    let pattern = sr.getElementById('folder-pattern').value.trim();
    let statusEl = sr.getElementById('pattern-status');

    if (!pattern) {
      statusEl.className = 'pattern-help';
      statusEl.innerHTML = '';
      return;
    }

    try {
      let res = await authenticatedFetch('/api/admin/validateFolderPattern', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern })
      });
      let result = await res.json();
      if (result.valid) {
        let msg = `Example: "${pattern}" -> "${result.example}"`;
        if (this.#isEdit && pattern !== this.#originalPattern) {
          msg += `<br><span class="pattern-warning">Changes will only affect files indexed going forward, not existing data.</span>`;
        }
        statusEl.className = 'pattern-help valid';
        statusEl.innerHTML = msg;
      } else {
        statusEl.className = 'pattern-help invalid';
        statusEl.innerHTML = result.error || 'Invalid pattern';
      }
    } catch (err) {
      statusEl.className = 'pattern-help invalid';
      statusEl.innerHTML = 'Unable to validate pattern';
    }
  }

  // --- Intake Cards ---

  #intakeCounter = 0;

  #addIntakeCard(intake = null) {
    let idx = this.#intakeCounter++;
    let cardId = `intake-${idx}`;
    let card = document.createElement('div');
    card.className = 'intake-card';
    card.id = cardId;

    let method = intake?.method || 'scheduled';

    card.innerHTML = `
      <div class="intake-card-header">
        <span class="intake-card-title">Intake Path #${idx + 1}</span>
        <sl-icon-button name="trash" label="Remove" class="remove-intake-btn"></sl-icon-button>
      </div>
      <div class="intake-fields">
        <div class="path-field intake-full-width">
          <label class="path-label">Path *</label>
          <input id="${cardId}-path" class="path-input" type="text"
                 placeholder="/path/to/intake/" list="${cardId}-path-suggestions" autocomplete="off" />
          <datalist id="${cardId}-path-suggestions"></datalist>
          <div class="path-status" data-path-status="${cardId}-path"></div>
        </div>
        <sl-select id="${cardId}-method" label="Method" value="${method}" class="method-select">
          <sl-option value="immediate">Immediate (watcher)</sl-option>
          <sl-option value="scheduled">Scheduled (cron)</sl-option>
          <sl-option value="on-demand">On-demand</sl-option>
        </sl-select>
      </div>
      <div id="${cardId}-config" class="config-options" ${method === 'on-demand' ? 'hidden' : ''}>
        ${this.#buildConfigOptions(cardId, method, intake?.config)}
      </div>
    `;

    this.shadowRoot.getElementById('intake-cards').appendChild(card);

    // Populate path value after DOM insertion
    if (intake?.path) {
      this.shadowRoot.getElementById(`${cardId}-path`).value = intake.path;
      this.#validatePath(`${cardId}-path`, intake.path);
    }

    // Event listeners
    card.querySelector('.remove-intake-btn').addEventListener('click', () => card.remove());

    let pathInput = this.shadowRoot.getElementById(`${cardId}-path`);
    pathInput.addEventListener('input', () => this.#onPathInput(`${cardId}-path`, pathInput));
    pathInput.addEventListener('blur', () => this.#validatePath(`${cardId}-path`, pathInput.value));

    let methodSelect = this.shadowRoot.getElementById(`${cardId}-method`);
    methodSelect.addEventListener('sl-change', () => {
      let configDiv = this.shadowRoot.getElementById(`${cardId}-config`);
      let content = this.#buildConfigOptions(cardId, methodSelect.value, null);
      configDiv.innerHTML = content;
      configDiv.hidden = !content;
      this.#attachCronListener(cardId);
    });

    this.#attachCronListener(cardId);
  }

  #buildConfigOptions(cardId, method, config) {
    if (method === 'immediate') {
      let awaitWrite = config?.awaitWriteFinish ?? true;
      let ignoreInitial = config?.ignoreInitial ?? true;
      return `
        <h5 class="config-options-title">Watcher Options</h5>
        <div class="config-row">
          <sl-switch id="${cardId}-awaitWriteFinish" ${awaitWrite ? 'checked' : ''}>Await Write Finish</sl-switch>
        </div>
        <div class="config-row">
          <sl-switch id="${cardId}-ignoreInitial" ${ignoreInitial ? 'checked' : ''}>Ignore Initial</sl-switch>
        </div>
      `;
    } else if (method === 'scheduled') {
      let schedule = config?.schedule || '';
      let staleDays = config?.staleDays ?? 0;
      return `
        <h5 class="config-options-title">Schedule Options</h5>
        <div class="config-row">
          <sl-input id="${cardId}-schedule" placeholder="0 2 * * *"
                    value="${schedule}" size="small" style="flex:1">
            <span slot="label">Schedule</span>
            <span slot="help-text">Uses <a href="https://crontab.guru/" target="_blank" rel="noopener" class="pattern-link">cron</a> syntax (5 fields)</span>
          </sl-input>
        </div>
        <div id="${cardId}-cron-help" class="cron-help"></div>
        <div class="config-row">
          <sl-input id="${cardId}-staleDays" label="Stale Days" type="number"
                    value="${staleDays}" size="small"
                    help-text="Wait this many days before indexing, to allow review. 0 = no wait."></sl-input>
        </div>
      `;
    }
    // on-demand: no config
    return '';
  }

  #attachCronListener(cardId) {
    let scheduleInput = this.shadowRoot.getElementById(`${cardId}-schedule`);
    if (!scheduleInput) return;

    // Show initial cron help if value exists
    let val = scheduleInput.value.trim();
    if (val) this.#updateCronHelp(cardId, val);

    scheduleInput.addEventListener('sl-input', () => {
      this.#updateCronHelp(cardId, scheduleInput.value.trim());
    });
    scheduleInput.addEventListener('sl-blur', () => {
      this.#updateCronHelp(cardId, scheduleInput.value.trim());
    });
  }

  #updateCronHelp(cardId, value) {
    let helpEl = this.shadowRoot.getElementById(`${cardId}-cron-help`);
    if (!helpEl) return;

    if (!value) {
      helpEl.className = 'cron-help';
      helpEl.textContent = '';
      return;
    }

    let human = cronToHuman(value);
    if (human) {
      helpEl.className = 'cron-help valid';
      helpEl.textContent = human;
    } else {
      helpEl.className = 'cron-help invalid';
      helpEl.textContent = 'Invalid cron expression';
    }
  }

  // --- Save & Cancel ---

  #cancel() {
    this.dispatchEvent(new CustomEvent('pl-collection-cancelled', {
      bubbles: true, composed: true
    }));
  }

  async #save(startIndexing = false) {
    let sr = this.shadowRoot;

    // Gather form data
    let collectionName = sr.getElementById('collection-name').value.trim();
    let collectionPath = sr.getElementById('collection-path').value.trim();
    let albumType = sr.getElementById('album-type').value;
    let trashDays = parseInt(sr.getElementById('trash-days').value) || 30;
    let folderPattern = sr.getElementById('folder-pattern').value.trim();
    let defaultCollection = sr.getElementById('default-collection').checked ? 1 : 0;

    // Basic client-side validation
    if (!collectionName) {
      notify('Collection name is required', 'warning');
      sr.getElementById('collection-name').focus();
      return;
    }
    if (!collectionPath) {
      notify('Collection path is required', 'warning');
      sr.getElementById('collection-path').focus();
      return;
    }

    // Gather intake configs
    let intakeConfigs = [];
    let intakeCards = sr.querySelectorAll('.intake-card');
    for (let card of intakeCards) {
      let cardId = card.id;
      let path = sr.getElementById(`${cardId}-path`).value.trim();
      let method = sr.getElementById(`${cardId}-method`).value;

      if (!path) {
        notify('All intake paths must be filled in', 'warning');
        return;
      }

      let config = {};
      if (method === 'immediate') {
        config.awaitWriteFinish = sr.getElementById(`${cardId}-awaitWriteFinish`)?.checked ?? true;
        config.ignoreInitial = sr.getElementById(`${cardId}-ignoreInitial`)?.checked ?? true;
      } else if (method === 'scheduled') {
        let schedule = sr.getElementById(`${cardId}-schedule`)?.value?.trim() || '';
        let staleDays = parseInt(sr.getElementById(`${cardId}-staleDays`)?.value) || 0;

        if (schedule && !isValidCron(schedule)) {
          notify('Invalid cron expression in intake config', 'warning');
          return;
        }
        config.schedule = schedule;
        config.staleDays = staleDays;
      }

      intakeConfigs.push({ path, method, config });
    }

    let payload = {
      collection_name: collectionName,
      collection_path: collectionPath,
      album_type: albumType,
      intake_configs: intakeConfigs,
      apply_folder_pattern: folderPattern || null,
      default_collection: defaultCollection,
      trash_days: trashDays
    };

    let saveBtn = sr.getElementById('save-index-btn').style.display === 'none'
      ? sr.getElementById('save-btn')
      : sr.getElementById('save-index-btn');
    saveBtn.loading = true;

    try {
      let url, method;
      if (this.#isEdit) {
        url = `/api/admin/updateCollection/${this.#data.collection_id}`;
        method = 'PUT';
      } else {
        url = '/api/admin/createNewCollection';
        method = 'POST';
      }

      let res = await authenticatedFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        let err = await res.json().catch(() => ({ error: { message: `Server error: ${res.status}` } }));
        throw new Error(err.error?.message || `Request failed: ${res.status}`);
      }

      let result = await res.json();

      // Start indexing if requested (create mode only)
      if (startIndexing && !this.#isEdit && result) {
        let collectionId = result; // createNewCollection returns the new ID
        try {
          await authenticatedFetch(`/api/admin/startIndexingFirstTime?collection_id=${collectionId}`, { method: 'POST' });
          notify('Collection created and indexing started', 'success');
        } catch (indexErr) {
          notify('Collection created but failed to start indexing', 'warning');
          console.error(indexErr);
        }
      } else {
        notify(this.#isEdit ? 'Collection updated' : 'Collection created', 'success');
      }

      this.dispatchEvent(new CustomEvent('pl-collection-saved', {
        bubbles: true, composed: true
      }));
    } catch (err) {
      notify(err.message || 'Failed to save collection', 'danger');
      console.error(err);
    } finally {
      saveBtn.loading = false;
    }
  }
}

customElements.define('pl-collection-form', PlCollectionForm);
