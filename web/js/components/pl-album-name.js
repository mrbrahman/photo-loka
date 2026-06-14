import { notify, throttle } from '../utils.mjs';
import { updateAlbumName, searchForExistingAlbums } from '../api/albums-api.mjs';
import { isPlaceholder } from '../album-path.mjs';

import sheet from "./styles/pl-album-name.css" with { type: "css" };

// Design notes:
// - Save is always explicit (save button or Enter key), never on blur. Renaming
//   an album moves physical files on disk, so accidental renames from stray
//   blur events (especially on mobile) must be avoided.
// - The descriptive name is what the user sees and edits. Date is in the day
//   header. The component carries the album_date too because the rename API
//   needs it as part of the (date, name) identity.
// - When albumName matches the collection's placeholder text (e.g. 'TBD'),
//   the label renders in a distinct color as a visual cue that the album
//   needs review. Clearing the name on save shrinks the folder back to just
//   the date prefix, which is allowed.

class PlAlbumName extends HTMLElement {

  #albumName = '';        // descriptive name only (e.g. 'New Year' or 'New Year/WhatsApp Images')
  #albumDate = '';        // 'YYYY-MM-DD' - identifies which day's bucket this is
  #albumSelectedValue = 'none';
  #readOnly = false;
  #collectionId = null;
  #timeWindow = '';
  #placeholderText = '';
  #closeWatcher = null;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <!-- tooltip is sticking badly on mobile -->
      <!-- <sl-tooltip content="Toggle Select All" hoist> -->
        <sl-icon id="select-all" class="select-none" name="check-circle"></sl-icon>
      <!-- </sl-tooltip> -->

      <span id="time-window"></span>
      <span id="album-label"></span>

      <input id="album-input" list="album-suggestions" autocomplete="off" spellcheck="false" hidden />
      <datalist id="album-suggestions"></datalist>

      <div id="edit-controls">
        <sl-icon id="save" name="check-circle-fill" tabindex="0"></sl-icon>
        <sl-icon id="cancel" name="x-circle" tabindex="0"></sl-icon>
      </div>
    `;
  }

  constructor() {
    super().attachShadow({mode: 'open'});
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    this.#paintTimeWindow();
    this.#paintAlbumName();

    this.shadowRoot.getElementById("select-all").addEventListener('click', this.#handleSelectAll);
    this.shadowRoot.getElementById("album-label").addEventListener('click', this.#handleLabelClick);
    this.shadowRoot.getElementById("time-window").addEventListener('click', this.#handleLabelClick);
    this.shadowRoot.getElementById("album-input").addEventListener('keydown', this.#handleKey);
    this.shadowRoot.getElementById("album-input").addEventListener('input', this.#handleInput);
    this.shadowRoot.getElementById("save").addEventListener('click', this.#handleSave);
    this.shadowRoot.getElementById("save").addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') { evt.preventDefault(); this.#handleSave(); }
    });
    this.shadowRoot.getElementById("cancel").addEventListener('click', this.#handleCancel);
    this.shadowRoot.getElementById("cancel").addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') { evt.preventDefault(); this.#handleCancel(); }
    });
  }

  #handleLabelClick = () => {
    if (this.#readOnly) return;
    this.#enterEditMode();
  }

  #enterEditMode() {
    let label = this.shadowRoot.getElementById('album-label');
    let input = this.shadowRoot.getElementById('album-input');

    label.hidden = true;
    input.hidden = false;
    input.value = this.#albumName || '';
    input.focus();
    input.select();

    this.shadowRoot.getElementById('edit-controls').style.visibility = 'visible';

    this.#closeWatcher = new CloseWatcher();
    this.#closeWatcher.onclose = () => this.#handleCancel();

    this.#suggestForCurrentInput();
  }

  #exitEditMode() {
    let label = this.shadowRoot.getElementById('album-label');
    let input = this.shadowRoot.getElementById('album-input');

    input.hidden = true;
    label.hidden = false;

    this.shadowRoot.getElementById('edit-controls').style.visibility = 'hidden';
    this.#clearSuggestions();

    this.#closeWatcher?.destroy();
    this.#closeWatcher = null;
  }

  #handleSelectAll = () => {
    this.#albumSelectedValue = this.#albumSelectedValue == 'all' ? 'none' : 'all';
    this.#paintSelectAllCheckbox();

    this.dispatchEvent(new CustomEvent('r3-select-all-clicked', {
      detail: { select: this.#albumSelectedValue == 'all' }
    }));
  }

  #handleSave = async () => {
    let input = this.shadowRoot.getElementById('album-input');
    let newAlbumName = input.value.trim();

    if (newAlbumName === this.#albumName) {
      this.#exitEditMode();
      return;
    }

    try {
      await updateAlbumName(this.#collectionId, this.#albumDate, this.#albumName, newAlbumName);
      this.albumName = newAlbumName;
      this.#exitEditMode();
      notify('Album name updated successfully', 'success');
    } catch(err) {
      if (err.error?.code === "FOLDER_EXISTS") {
        // Bubble up the descriptive name only. Gallery's move flow takes
        // a descriptive name and reconstructs the per-day target itself.
        this.dispatchEvent(new CustomEvent('pl-rename-dir-not-empty', {
          detail: { newAlbumName }
        }));
      } else {
        notify(`<strong>Error</strong>:</br>${err.error?.code || err.code}`, 'error', -1);
      }
    }
  }

  #handleCancel = () => {
    this.#exitEditMode();
  }

  // When opening edit mode for a placeholder album, run a suggestion lookup
  // to surface similar albums in the datalist.
  #suggestForCurrentInput = async () => {
    if (isPlaceholder(this.#albumName, this.#placeholderText)) {
      try {
        let output = await searchForExistingAlbums(this.#albumName, true, this.#collectionId);
        if (output.length > 0) {
          this.#populateSuggestions(output);
        }
      } catch(err) {
        notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
      }
    }
  }

  #throttledLookup = throttle(() => {
    let input = this.shadowRoot.getElementById('album-input');
    let txt = input.value.trim();
    if (txt.length < 2) return;
    if (this.#placeholderText && txt === this.#placeholderText) return;
    this.#suggestAlbumNames(txt);
  }, 1000)

  #suggestAlbumNames = async (txt) => {
    try {
      let output = await searchForExistingAlbums(txt, false, this.#collectionId);
      if (output.length > 0) {
        this.#populateSuggestions(output);
      } else {
        this.#clearSuggestions();
      }
    } catch(err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #handleInput = () => {
    let input = this.shadowRoot.getElementById('album-input');
    let datalist = this.shadowRoot.getElementById('album-suggestions');
    for (let opt of datalist.querySelectorAll('option')) {
      if (opt.value === input.value) {
        this.#clearSuggestions();
        return;
      }
    }
    this.#throttledLookup();
  }

  #handleKey = (evt) => {
    if (evt.key === "Enter") {
      evt.preventDefault();
      this.#handleSave();
    }
  }

  #populateSuggestions(output) {
    let datalist = this.shadowRoot.getElementById('album-suggestions');
    datalist.innerHTML = '';
    for (let d of output) {
      let opt = document.createElement('option');
      opt.value = d.similar;
      datalist.appendChild(opt);
    }
  }

  #clearSuggestions() {
    this.shadowRoot.getElementById('album-suggestions').innerHTML = '';
  }

  #paintTimeWindow() {
    let el = this.shadowRoot.getElementById('time-window');
    if (!el) return;
    el.textContent = this.#timeWindow || '';
  }

  #paintAlbumName() {
    let label = this.shadowRoot.getElementById('album-label');
    if (!label) return;
    label.textContent = this.#albumName;
    label.classList.toggle('placeholder', isPlaceholder(this.#albumName, this.#placeholderText));
    label.hidden = !this.#albumName;
  }

  #paintSelectAllCheckbox() {
    let classes = ['select-none','select-some','select-all'];
    let checkbox = this.shadowRoot.getElementById('select-all');

    switch(this.#albumSelectedValue) {
      case 'none':
        checkbox.name = "check-circle";
        checkbox.classList.remove(...classes);
        checkbox.classList.add('select-none');
        break;
      case 'some':
        checkbox.name = "check-circle-fill";
        checkbox.classList.remove(...classes);
        checkbox.classList.add('select-some');
        break;
      case 'all':
        checkbox.name = "check-circle-fill";
        checkbox.classList.remove(...classes);
        checkbox.classList.add('select-all');
        break;
    }
  }

  get albumName() { return this.#albumName; }
  set albumName(_) {
    this.#albumName = _ || '';
    if (this.isConnected) this.#paintAlbumName();
  }

  get albumDate() { return this.#albumDate; }
  set albumDate(_) { this.#albumDate = _ || ''; }

  get albumSelectedValue() { return this.#albumSelectedValue; }
  set albumSelectedValue(_) {
    this.#albumSelectedValue = _;
    if (this.isConnected) this.#paintSelectAllCheckbox();
  }

  get readOnly() { return this.#readOnly; }
  set readOnly(_) { this.#readOnly = Boolean(_); }

  get collectionId() { return this.#collectionId; }
  set collectionId(_) { this.#collectionId = _ || null; }

  get timeWindow() { return this.#timeWindow; }
  set timeWindow(_) {
    this.#timeWindow = _ || '';
    if (this.isConnected) this.#paintTimeWindow();
  }

  get placeholderText() { return this.#placeholderText; }
  set placeholderText(_) {
    this.#placeholderText = _ || '';
    if (this.isConnected) this.#paintAlbumName();
  }
}

window.customElements.define('pl-album-name', PlAlbumName);
