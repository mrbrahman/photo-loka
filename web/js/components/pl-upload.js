// pl-upload: global page for uploading images/videos into a chosen collection.
//
// Flow (decoupled select + upload):
//   1. Pick a target collection from the dropdown (preselected to the
//      last-viewed collection, or the only one if there is a single collection).
//   2. Choose files with the OS picker (or arrive via the PWA share target).
//      This only LISTS the files -- it does not start uploading -- so the user
//      can verify the target collection first.
//   3. Click "Upload" (top): creates a session for the selected collection,
//      uploads files sequentially with byte-weighted progress, then
//      automatically finalizes to kick off indexing.
//
// Only collections with an upload staging folder configured (uploads_enabled)
// can be targets. Uploading from a browser on mobile may strip EXIF/GPS, so a
// dismissible notice (mobile viewports only) steers users to share from a file
// manager app instead.
//
// Sequential-now, parallel-later: each row owns its own loaded/total and its
// own upload call, so switching to parallel is just a concurrency limiter over
// the same per-row model. Re-picking replaces the current batch; per-row retry
// is deferred.

import { isAdmin } from '../authn.mjs';
import { router } from '../router.mjs';
import { notify } from '../utils.mjs';
import { createUploadSession, uploadFile, finalizeUpload } from '../api/upload-api.mjs';
import { takeSharedFiles } from '../share-inbox.mjs';

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
  // All collections (summaries) passed from the shell; filtered to uploads-enabled.
  #collections = [];
  #preferredCollectionId = null;
  #fromShare = false;

  #selectedCollectionId = null;
  #sessionId = null;
  // Per-file transfer records: { file, state, loaded, total, error, els:{...} }
  #items = [];
  #uploading = false;
  #done = false;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <div class="container">
        <div class="header">
          <h2>Upload files</h2>
          <sl-button id="upload-btn" variant="primary" disabled>
            <sl-icon slot="prefix" name="cloud-upload"></sl-icon>
            Upload
          </sl-button>
        </div>

        <!-- Mobile-only metadata notice (dismissible per visit) -->
        <div id="mobile-notice" class="mobile-notice">
          <sl-icon class="notice-icon" name="info-circle"></sl-icon>
          <div class="notice-body">
            <strong>Uploading from your phone?</strong>
            <p>
              To preserve photo details like location (GPS) and the original
              filename, share your files to Photo-Loka from a file manager app
              rather than from a photos/gallery app or by choosing the files on
              this page. Gallery apps and the OS file picker on mobile devices
              often re-encode images and strip location before sharing.
            </p>
          </div>
          <sl-icon-button id="notice-close" name="x-lg" label="Dismiss"></sl-icon-button>
        </div>

        <div id="setup" class="setup">
          <div class="field">
            <label for="collection-select">Collection</label>
            <sl-select id="collection-select" placeholder="Select a collection" hoist></sl-select>
          </div>

          <div class="field">
            <label for="file-input">Files</label>
            <input id="file-input" type="file" multiple accept="*/*" />
            <div class="field-help">
              Selecting files only lists them below. Click "Upload" when you have
              verified the target collection.
            </div>
          </div>
        </div>

        <div id="no-uploads" class="no-uploads" hidden>
          No collection is set up for uploads. Ask an admin to set a
          "UI Upload Folder" on a collection (Admin &gt; Collections).
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

  set collections(value) {
    this.#collections = Array.isArray(value) ? value : [];
  }
  get collections() {
    return this.#collections;
  }

  set preferredCollectionId(value) {
    this.#preferredCollectionId = value;
  }
  get preferredCollectionId() {
    return this.#preferredCollectionId;
  }

  set fromShare(value) {
    this.#fromShare = !!value;
  }
  get fromShare() {
    return this.#fromShare;
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    this.shadowRoot.getElementById('notice-close')
      .addEventListener('click', () => {
        this.shadowRoot.getElementById('mobile-notice').remove();
      });

    this.shadowRoot.getElementById('file-input')
      .addEventListener('change', (e) => this.#onFilesPicked(e));
    this.shadowRoot.getElementById('upload-btn')
      .addEventListener('click', () => this.#upload());

    const select = this.shadowRoot.getElementById('collection-select');
    select.addEventListener('sl-change', () => {
      this.#selectedCollectionId = select.value ? parseInt(select.value) : null;
      this.#updateUploadButton();
    });

    this.#populateCollections();

    // If we arrived via the PWA share target, pick up the shared files that the
    // service worker stashed and list them (the user still clicks Upload).
    if (this.#fromShare) {
      this.#consumeSharedFiles();
    }
  }

  // --- Collection selection ---

  #uploadableCollections() {
    return this.#collections.filter((c) => c.uploads_enabled);
  }

  #populateCollections() {
    const select = this.shadowRoot.getElementById('collection-select');
    const options = this.#uploadableCollections();

    if (options.length === 0) {
      // Nothing to upload into: disable the whole page and explain.
      this.shadowRoot.getElementById('no-uploads').hidden = false;
      this.shadowRoot.getElementById('setup').hidden = true;
      this.shadowRoot.getElementById('upload-btn').disabled = true;
      return;
    }

    select.innerHTML = '';
    for (const c of options) {
      const opt = document.createElement('sl-option');
      opt.value = String(c.collection_id);
      opt.textContent = c.collection_name;
      select.appendChild(opt);
    }

    // Preselect: the only option, else the preferred (last-viewed) collection
    // when it is uploadable.
    let preselect = null;
    if (options.length === 1) {
      preselect = options[0].collection_id;
    } else if (
      this.#preferredCollectionId != null &&
      options.some((c) => c.collection_id === this.#preferredCollectionId)
    ) {
      preselect = this.#preferredCollectionId;
    }

    if (preselect != null) {
      this.#selectedCollectionId = preselect;
      // Set value after options are in the DOM so sl-select picks it up.
      select.value = String(preselect);
    }

    this.#updateUploadButton();
  }

  // --- File selection (lists only; does not upload) ---

  #onFilesPicked(e) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    this.#listFiles(files);
  }

  async #consumeSharedFiles() {
    const files = await takeSharedFiles();
    if (files.length === 0) {
      notify('No shared files were found to upload', 'warning');
      return;
    }
    this.#listFiles(files);
  }

  // Render the chosen/shared files as rows without starting the upload.
  #listFiles(files) {
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
    this.#updateUploadButton();
  }

  #resetForNewBatch() {
    this.#sessionId = null;
    this.#done = false;
    this.#uploading = false;
    this.#items = [];
    this.shadowRoot.getElementById('file-list').innerHTML = '';
    this.shadowRoot.getElementById('done-msg').hidden = true;
    this.shadowRoot.getElementById('done-msg').innerHTML = '';
    this.shadowRoot.getElementById('total-wrap').hidden = true;
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

  // --- Upload button state ---

  #updateUploadButton() {
    const btn = this.shadowRoot.getElementById('upload-btn');
    const ready =
      this.#selectedCollectionId != null &&
      this.#items.length > 0 &&
      !this.#uploading &&
      !this.#done;
    btn.disabled = !ready;
  }

  // --- Upload + auto-finalize ---

  async #upload() {
    if (this.#uploading || this.#done) return;
    if (this.#selectedCollectionId == null || this.#items.length === 0) return;

    this.#uploading = true;
    const btn = this.shadowRoot.getElementById('upload-btn');
    btn.loading = true;
    btn.disabled = true;
    // Lock collection + file choice during the upload.
    this.shadowRoot.getElementById('collection-select').disabled = true;
    this.shadowRoot.getElementById('file-input').disabled = true;

    // Create the session for the chosen collection.
    try {
      this.#sessionId = await createUploadSession(this.#selectedCollectionId);
    } catch (err) {
      notify(err.error?.message || err.message || 'Failed to start upload session', 'error', 0);
      this.#uploading = false;
      btn.loading = false;
      this.shadowRoot.getElementById('collection-select').disabled = false;
      this.shadowRoot.getElementById('file-input').disabled = false;
      this.#updateUploadButton();
      return;
    }

    await this.#uploadAllSequential();

    // Auto-finalize (kick off indexing) if anything uploaded successfully.
    const anyUploaded = this.#items.some((i) => i.state === STATE.UPLOADED);
    if (anyUploaded) {
      try {
        await finalizeUpload(this.#sessionId);
        this.#done = true;
        this.#showDoneMessage();
      } catch (err) {
        notify(err.error?.message || err.message || 'Failed to start indexing', 'error', 0);
      }
    } else {
      notify('No files were uploaded successfully', 'warning');
    }

    this.#uploading = false;
    btn.loading = false;
    // Allow a fresh batch after a failed/finished run (unless done).
    if (!this.#done) {
      this.shadowRoot.getElementById('collection-select').disabled = false;
      this.shadowRoot.getElementById('file-input').disabled = false;
    }
    this.#updateUploadButton();
  }

  async #uploadAllSequential() {
    for (const item of this.#items) {
      if (item.state !== STATE.QUEUED) continue;
      await this.#uploadOne(item);
    }
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

  // --- Done message ---

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
