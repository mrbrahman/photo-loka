import { notify } from '../utils.mjs';
import { validatePath, listSubDirs, validateFolderPattern, createCollection, updateCollection, startIndexing as startCollectionIndexing } from '../api/admin-api.mjs';
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

            <sl-switch id="compress-videos">Compress Videos</sl-switch>

          </div>

          <!-- Intake Paths Section -->
          <div class="intake-section">
            <div class="intake-section-header">
              <h4 class="intake-section-title">Intake Paths</h4>
            </div>
            <div id="intake-edit-note" class="intake-note" hidden>
              Saving will restart active watchers and reschedule cron jobs for this collection.
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

  static intakeCardTemplate = document.createElement('template');
  static {
    this.intakeCardTemplate.innerHTML = // html
      `
      <div class="intake-card">
        <div class="intake-card-header">
          <span class="intake-card-title"></span>
          <div class="intake-card-actions">
            <sl-switch class="status-toggle" size="small" checked>Active</sl-switch>
            <sl-icon-button name="trash" label="Remove" class="remove-intake-btn"></sl-icon-button>
          </div>
        </div>
        <div class="intake-fields">
          <div class="path-field intake-full-width">
            <label class="path-label">Path *</label>
            <input class="path-input" type="text" placeholder="/path/to/intake/" autocomplete="off" />
            <datalist class="path-datalist"></datalist>
            <div class="path-status"></div>
          </div>
          <sl-select class="method-select" label="Method" value="scheduled">
            <sl-option value="immediate">Immediate (watcher)</sl-option>
            <sl-option value="scheduled">Scheduled (cron)</sl-option>
            <sl-option value="on-demand">On-demand</sl-option>
          </sl-select>
        </div>
        <div class="config-options" hidden></div>
      </div>
    `;
  }

  static immediateConfigTemplate = document.createElement('template');
  static {
    this.immediateConfigTemplate.innerHTML = // html
      `
      <h5 class="config-options-title">Watcher Options</h5>
      <div class="config-row">
        <sl-switch class="await-write-finish" checked>Await Write Finish</sl-switch>
      </div>
      <div class="config-row">
        <sl-switch class="ignore-initial" checked>Ignore Initial</sl-switch>
      </div>
    `;
  }

  static scheduledConfigTemplate = document.createElement('template');
  static {
    this.scheduledConfigTemplate.innerHTML = // html
      `
      <h5 class="config-options-title">Schedule Options</h5>
      <div class="config-row">
        <sl-input class="schedule-input" placeholder="0 2 * * *" size="small" style="flex:1">
          <span slot="label">Schedule</span>
          <span slot="help-text">Uses <a href="https://crontab.guru/" target="_blank" rel="noopener" class="pattern-link">cron</a> syntax (5 fields)</span>
        </sl-input>
      </div>
      <div class="cron-help"></div>
      <div class="config-row">
        <sl-input class="stale-days-input" label="Stale Days" type="number" value="0" size="small"
                  help-text="Wait this many days before indexing, to allow review. 0 = no wait."></sl-input>
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
      sr.getElementById('intake-edit-note').hidden = false;
    }

    let d = this.#data;
    sr.getElementById('collection-name').value = d.collection_name || '';
    sr.getElementById('collection-path').value = d.collection_path || '';
    sr.getElementById('album-type').value = d.album_type || 'FOLDER_ALBUM';
    sr.getElementById('trash-days').value = d.trash_days ?? 30;
    sr.getElementById('folder-pattern').value = d.apply_folder_pattern || '';
    sr.getElementById('default-collection').checked = !!d.default_collection;
    sr.getElementById('compress-videos').checked = !!d.compress_videos;

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
    let pathDatalist = sr.getElementById('path-suggestions');
    pathInput.addEventListener('input', () => {
      clearTimeout(this.#pathTimers['collection-path']);
      let val = pathInput.value.trim();
      if (val.length < 2) return;
      this.#pathTimers['collection-path'] = setTimeout(() => this.#fetchPathSuggestionsEl(pathInput, pathDatalist), 300);
    });
    pathInput.addEventListener('blur', () => this.#validatePath('collection-path', pathInput.value));

    // Folder pattern validation (debounced on input)
    let patternInput = sr.getElementById('folder-pattern');
    patternInput.addEventListener('sl-input', () => {
      clearTimeout(this.#patternTimer);
      this.#patternTimer = setTimeout(() => this.#validateFolderPattern(), 300);
    });
  }

  // --- Path Autocomplete & Validation ---

  async #validatePath(id, value) {
    if (!value || !value.trim()) return;
    let sr = this.shadowRoot;
    let statusEl = sr.getElementById('path-status');
    let inputEl = sr.getElementById(id);

    try {
      let exists = await validatePath(value.trim());
      if (!exists) {
        this.#setPathStatus(statusEl, 'invalid', 'Path does not exist');
        inputEl.classList.remove('valid');
        inputEl.classList.add('invalid');
      } else {
        this.#setPathStatus(statusEl, 'valid', 'Path exists');
        inputEl.classList.remove('invalid');
        inputEl.classList.add('valid');
      }
    } catch (err) {
      this.#setPathStatus(statusEl, 'invalid', 'Unable to validate path');
    }
  }

  async #validatePathEl(inputEl, statusEl) {
    let value = inputEl.value.trim();
    if (!value) return;

    try {
      let exists = await validatePath(value);
      if (!exists) {
        this.#setPathStatus(statusEl, 'invalid', 'Path does not exist');
        inputEl.classList.remove('valid');
        inputEl.classList.add('invalid');
      } else {
        this.#setPathStatus(statusEl, 'valid', 'Path exists');
        inputEl.classList.remove('invalid');
        inputEl.classList.add('valid');
      }
    } catch (err) {
      this.#setPathStatus(statusEl, 'invalid', 'Unable to validate path');
    }
  }

  async #fetchPathSuggestionsEl(inputEl, datalist) {
    let pathStr = inputEl.value.trim();
    let sep = pathStr.includes('\\') ? '\\' : '/';
    let dirToList = pathStr;
    if (!pathStr.endsWith(sep)) {
      let lastSep = Math.max(pathStr.lastIndexOf('/'), pathStr.lastIndexOf('\\'));
      if (lastSep < 0) return;
      dirToList = pathStr.substring(0, lastSep + 1);
    }

    try {
      let dirs = await listSubDirs(dirToList);
      datalist.innerHTML = '';
      for (let d of dirs) {
        datalist.appendChild(Object.assign(document.createElement('option'), { value: dirToList + d + sep }));
      }
    } catch (err) {
      datalist.innerHTML = '';
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
      let result = await validateFolderPattern(pattern);
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
    let card = this.constructor.intakeCardTemplate.content.cloneNode(true).firstElementChild;

    let method = intake?.method || 'scheduled';
    let status = intake?.status || 'active';

    // Title
    card.querySelector('.intake-card-title').textContent = `Intake Path #${idx + 1}`;

    // Status toggle - hide for on-demand
    let statusToggle = card.querySelector('.status-toggle');
    if (method === 'on-demand') {
      statusToggle.hidden = true;
    } else {
      statusToggle.checked = status === 'active';
    }

    // Path input + datalist association
    let pathInput = card.querySelector('.path-input');
    let datalist = card.querySelector('.path-datalist');
    let datalistId = `intake-dl-${idx}`;
    datalist.id = datalistId;
    pathInput.setAttribute('list', datalistId);
    if (intake?.path) pathInput.value = intake.path;

    // Method select
    let methodSelect = card.querySelector('.method-select');
    methodSelect.value = method;

    // Config options
    this.#applyConfigTemplate(card, method, intake?.config);

    // Append to DOM
    this.shadowRoot.getElementById('intake-cards').appendChild(card);

    // Validate pre-filled path
    if (intake?.path) {
      this.#validatePathEl(pathInput, card.querySelector('.path-status'));
    }

    // Event listeners
    card.querySelector('.remove-intake-btn').addEventListener('click', () => card.remove());

    pathInput.addEventListener('input', () => {
      clearTimeout(this.#pathTimers[datalistId]);
      let val = pathInput.value.trim();
      if (val.length < 2) return;
      this.#pathTimers[datalistId] = setTimeout(() => this.#fetchPathSuggestionsEl(pathInput, datalist), 300);
    });
    pathInput.addEventListener('blur', () => this.#validatePathEl(pathInput, card.querySelector('.path-status')));

    methodSelect.addEventListener('sl-change', () => {
      this.#applyConfigTemplate(card, methodSelect.value, null);

      // Show/hide status toggle
      let toggle = card.querySelector('.status-toggle');
      if (methodSelect.value === 'on-demand') {
        toggle.hidden = true;
      } else {
        toggle.hidden = false;
      }
    });
  }

  #applyConfigTemplate(card, method, config) {
    let configDiv = card.querySelector('.config-options');
    configDiv.innerHTML = '';

    if (method === 'immediate') {
      let frag = this.constructor.immediateConfigTemplate.content.cloneNode(true);
      let awaitSwitch = frag.querySelector('.await-write-finish');
      let ignoreSwitch = frag.querySelector('.ignore-initial');
      awaitSwitch.checked = config?.awaitWriteFinish ?? true;
      ignoreSwitch.checked = config?.ignoreInitial ?? true;
      configDiv.appendChild(frag);
      configDiv.hidden = false;
    } else if (method === 'scheduled') {
      let frag = this.constructor.scheduledConfigTemplate.content.cloneNode(true);
      let scheduleInput = frag.querySelector('.schedule-input');
      let staleDaysInput = frag.querySelector('.stale-days-input');
      scheduleInput.value = config?.schedule || '';
      staleDaysInput.value = config?.staleDays ?? 0;
      configDiv.appendChild(frag);
      configDiv.hidden = false;
      this.#attachCronListener(card);
    } else {
      configDiv.hidden = true;
    }
  }

  #attachCronListener(card) {
    let scheduleInput = card.querySelector('.schedule-input');
    if (!scheduleInput) return;

    let helpEl = card.querySelector('.cron-help');
    let val = scheduleInput.value.trim();
    if (val) this.#updateCronHelp(helpEl, val);

    scheduleInput.addEventListener('sl-input', () => {
      this.#updateCronHelp(helpEl, scheduleInput.value.trim());
    });
    scheduleInput.addEventListener('sl-blur', () => {
      this.#updateCronHelp(helpEl, scheduleInput.value.trim());
    });
  }

  #updateCronHelp(helpEl, value) {
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
    let compressVideos = sr.getElementById('compress-videos').checked ? 1 : null;

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
      let path = card.querySelector('.path-input').value.trim();
      let method = card.querySelector('.method-select').value;

      if (!path) {
        notify('All intake paths must be filled in', 'warning');
        return;
      }

      let config = {};
      if (method === 'immediate') {
        config.awaitWriteFinish = card.querySelector('.await-write-finish')?.checked ?? true;
        config.ignoreInitial = card.querySelector('.ignore-initial')?.checked ?? true;
      } else if (method === 'scheduled') {
        let schedule = card.querySelector('.schedule-input')?.value?.trim() || '';
        let staleDays = parseInt(card.querySelector('.stale-days-input')?.value) || 0;

        if (schedule && !isValidCron(schedule)) {
          notify('Invalid cron expression in intake config', 'warning');
          return;
        }
        config.schedule = schedule;
        config.staleDays = staleDays;
      }

      // Determine status (on-demand has no toggle)
      let status = 'active';
      let statusToggle = card.querySelector('.status-toggle');
      if (statusToggle && !statusToggle.hidden) {
        status = statusToggle.checked ? 'active' : 'stopped';
      }

      intakeConfigs.push({ path, method, config, status });
    }

    let payload = {
      collection_name: collectionName,
      collection_path: collectionPath,
      album_type: albumType,
      intake_configs: intakeConfigs,
      apply_folder_pattern: folderPattern || null,
      default_collection: defaultCollection,
      trash_days: trashDays,
      compress_videos: compressVideos
    };

    let saveBtn = sr.getElementById('save-index-btn').style.display === 'none'
      ? sr.getElementById('save-btn')
      : sr.getElementById('save-index-btn');
    saveBtn.loading = true;

    try {
      let result;
      if (this.#isEdit) {
        result = await updateCollection(this.#data.collection_id, payload);
      } else {
        result = await createCollection(payload);
      }

      // Start indexing if requested (create mode only)
      if (startIndexing && !this.#isEdit && result) {
        let collectionId = result; // createNewCollection returns the new ID
        try {
          await startCollectionIndexing(collectionId);
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
      notify(err.error?.message || 'Failed to save collection', 'danger');
      console.error(err);
    } finally {
      saveBtn.loading = false;
    }
  }
}

customElements.define('pl-collection-form', PlCollectionForm);
