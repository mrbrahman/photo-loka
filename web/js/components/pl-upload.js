// pl-upload: UI page for uploading images/videos into the active collection.
//
// Lifecycle (see design): picking files (the native picker's confirm is the
// user's go-ahead) renders per-file rows, creates an upload session, and
// auto-starts sequential uploads. Progress is byte-weighted both per file and
// in a single total bar. Once every transfer reaches a terminal state the
// "Start indexing" button (top) is enabled; clicking it finalizes the session,
// which hands the staging dir to intake. The page's job ends there -- indexing
// progress lives on the Indexer page.
//
// Sequential-now, parallel-later: each row owns its own loaded/total and its
// own upload call, so switching to parallel is just a concurrency limiter over
// the same per-row model. Re-picking replaces the current batch (starts a fresh
// session); per-row retry is deferred.

import { isAdmin } from '../authn.mjs';
import { router } from '../router.mjs';
import { notify } from '../utils.mjs';
import { createUploadSession, uploadFile, finalizeUpload } from '../api/upload-api.mjs';

import sheet from './styles/pl-upload.css' with { type: 'css' };

// Per-file transfer states.
const STATE = {
  QUEUED: 'queued',
  UPLOADING: 'uploading',
  UPLOADED: 'uploaded',
  FAILED: 'failed',
};

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

class PlUpload extends HTMLElement {
  #collectionId = null;
  #sessionId = null;
  // Per-file transfer records: { file, state, loaded, total, error, els:{...} }
  #items = [];
  #finalized = false;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <div class="container">
        <div class="header">
          <h2>Upload files</h2>
          <sl-button id="start-index-btn" variant="primary" disabled>
            <sl-icon slot="prefix" name="play-fill"></sl-icon>
            Start indexing
          </sl-button>
        </div>

        <p class="intro">
          Select images or videos to upload into this collection. Uploading
          starts automatically once you confirm your selection. When all
          transfers finish, click "Start indexing" to import them.
        </p>

        <div class="picker">
          <input id="file-input" type="file" multiple accept="image/*,video/*" />
        </div>

        <div id="total-wrap" class="total-wrap" hidden>
          <div class="total-label">
            <span id="total-text"></span>
            <span id="total-pct"></span>
          </div>
          <sl-progress-bar id="total-bar" value="0"></sl-progress-bar>
        </div>

        <div id="file-list" class="file-list"></div>

        <div id="done-msg" class="done-msg" hidden></div>
      </div>
    `;
  }

  static rowTemplate = document.createElement('template');
  static {
    this.rowTemplate.innerHTML = // html
      `
      <div class="file-row">
        <div class="file-main">
          <span class="file-name"></span>
          <span class="file-status"></span>
        </div>
        <sl-progress-bar class="file-bar" value="0"></sl-progress-bar>
        <div class="file-meta">
          <span class="file-size"></span>
          <span class="file-error"></span>
        </div>
      </div>
    `;
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  set collectionId(value) {
    this.#collectionId = value;
  }
  get collectionId() {
    return this.#collectionId;
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    this.shadowRoot.getElementById('file-input')
      .addEventListener('change', (e) => this.#onFilesPicked(e));
    this.shadowRoot.getElementById('start-index-btn')
      .addEventListener('click', () => this.#startIndexing());
  }

  // --- File selection ---

  async #onFilesPicked(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    // Replace on re-pick: abandon any previous batch/session and start fresh.
    this.#resetForNewBatch();

    this.#items = files.map((file) => ({
      file,
      state: STATE.QUEUED,
      loaded: 0,
      total: file.size,
      error: null,
      els: null,
    }));

    this.#renderRows();
    this.shadowRoot.getElementById('total-wrap').hidden = false;
    this.#updateTotal();

    // Create the session only now that there is something to upload.
    try {
      this.#sessionId = await createUploadSession(this.#collectionId);
    } catch (err) {
      notify(err.error?.message || err.message || 'Failed to start upload session', 'error', 0);
      return;
    }

    this.#uploadAllSequential();
  }

  #resetForNewBatch() {
    this.#sessionId = null;
    this.#finalized = false;
    this.#items = [];
    this.shadowRoot.getElementById('file-list').innerHTML = '';
    this.shadowRoot.getElementById('done-msg').hidden = true;
    this.shadowRoot.getElementById('done-msg').innerHTML = '';
    const btn = this.shadowRoot.getElementById('start-index-btn');
    btn.disabled = true;
    btn.loading = false;
  }

  #renderRows() {
    const list = this.shadowRoot.getElementById('file-list');
    list.innerHTML = '';
    for (const item of this.#items) {
      const row = this.constructor.rowTemplate.content.cloneNode(true).firstElementChild;
      row.querySelector('.file-name').textContent = item.file.name;
      row.querySelector('.file-size').textContent = formatBytes(item.file.size);
      item.els = {
        row,
        status: row.querySelector('.file-status'),
        bar: row.querySelector('.file-bar'),
        error: row.querySelector('.file-error'),
      };
      this.#setRowState(item, STATE.QUEUED);
      list.appendChild(row);
    }
  }

  // --- Uploading ---

  async #uploadAllSequential() {
    for (const item of this.#items) {
      // Skip anything not pending (defensive; all start queued).
      if (item.state !== STATE.QUEUED) continue;
      await this.#uploadOne(item);
    }
    this.#maybeEnableIndexing();
  }

  async #uploadOne(item) {
    this.#setRowState(item, STATE.UPLOADING);
    try {
      await uploadFile(this.#sessionId, item.file, {
        onProgress: (loaded, total) => {
          item.loaded = loaded;
          item.total = total || item.file.size;
          this.#updateRowProgress(item);
          this.#updateTotal();
        },
      });
      item.loaded = item.total;
      this.#updateRowProgress(item);
      this.#setRowState(item, STATE.UPLOADED);
    } catch (err) {
      item.error = err.message || 'Upload failed';
      this.#setRowState(item, STATE.FAILED);
    }
    this.#updateTotal();
  }

  // --- Progress rendering ---

  #updateRowProgress(item) {
    if (!item.els) return;
    const pct = item.total > 0 ? Math.round((item.loaded / item.total) * 100) : 0;
    item.els.bar.value = pct;
  }

  #updateTotal() {
    let loaded = 0;
    let total = 0;
    for (const item of this.#items) {
      total += item.total;
      // Failed rows contribute their transferred bytes only; done rows count full.
      loaded += item.state === STATE.UPLOADED ? item.total : item.loaded;
    }
    const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;

    const uploaded = this.#items.filter((i) => i.state === STATE.UPLOADED).length;
    const failed = this.#items.filter((i) => i.state === STATE.FAILED).length;
    const totalCount = this.#items.length;

    this.shadowRoot.getElementById('total-bar').value = pct;
    this.shadowRoot.getElementById('total-pct').textContent = `${pct}%`;

    let text = `${formatBytes(loaded)} / ${formatBytes(total)} (${uploaded}/${totalCount} files`;
    if (failed > 0) text += `, ${failed} failed`;
    text += ')';
    this.shadowRoot.getElementById('total-text').textContent = text;
  }

  #setRowState(item, state) {
    item.state = state;
    if (!item.els) return;
    const { status, row, error } = item.els;

    row.classList.remove('is-queued', 'is-uploading', 'is-uploaded', 'is-failed');
    row.classList.add(`is-${state}`);

    const labels = {
      [STATE.QUEUED]: 'Queued',
      [STATE.UPLOADING]: 'Uploading...',
      [STATE.UPLOADED]: 'Uploaded',
      [STATE.FAILED]: 'Failed',
    };
    status.textContent = labels[state] || '';
    error.textContent = state === STATE.FAILED ? (item.error || '') : '';
  }

  // --- Finalize / indexing ---

  #allTerminal() {
    return this.#items.length > 0 &&
      this.#items.every((i) => i.state === STATE.UPLOADED || i.state === STATE.FAILED);
  }

  #maybeEnableIndexing() {
    const btn = this.shadowRoot.getElementById('start-index-btn');
    const anyUploaded = this.#items.some((i) => i.state === STATE.UPLOADED);
    // Enable only once every transfer is terminal and at least one succeeded
    // (nothing to index if they all failed).
    btn.disabled = !(this.#allTerminal() && anyUploaded && !this.#finalized);
  }

  async #startIndexing() {
    if (this.#finalized || !this.#sessionId) return;
    const btn = this.shadowRoot.getElementById('start-index-btn');
    btn.loading = true;
    try {
      await finalizeUpload(this.#sessionId);
      this.#finalized = true;
      btn.disabled = true;
      this.#showDoneMessage();
    } catch (err) {
      notify(err.error?.message || err.message || 'Failed to start indexing', 'error', 0);
    } finally {
      btn.loading = false;
    }
  }

  #showDoneMessage() {
    const el = this.shadowRoot.getElementById('done-msg');
    const uploaded = this.#items.filter((i) => i.state === STATE.UPLOADED).length;

    let msg = `Import started for ${uploaded} file${uploaded === 1 ? '' : 's'}. `;
    msg += 'Uploaded files are being brought into the collection in the background.';
    el.innerHTML = `<sl-icon name="check2-circle"></sl-icon> <span>${msg}</span>`;

    // Admins can jump to the Indexer page to watch progress; regular users
    // may not have access, so only show the link for admins.
    if (isAdmin()) {
      const link = document.createElement('a');
      link.href = '#';
      link.className = 'indexer-link';
      link.textContent = 'View indexer';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        router.navigate('/admin/indexer');
      });
      el.appendChild(document.createTextNode(' '));
      el.appendChild(link);
    }

    el.hidden = false;
  }
}

customElements.define('pl-upload', PlUpload);
