import {notify, throttle} from '../utils.mjs';
import { updateAlbumName, searchForExistingAlbums } from '../api/albums-api.mjs';

import sheet from "./styles/pl-album-name.css" with { type: "css" };

// Design note: Save is always explicit (save button or Enter key), never on blur.
// Renaming an album moves physical files on disk, so accidental renames from
// stray blur events (especially on mobile) must be avoided.

class PlAlbumName extends HTMLElement {

  #albumName; #albumSelectedValue='none'; #readOnly = false; #collectionId = null;
  #closeWatcher = null;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <!-- tooltip is sticking badly on mobile -->
      <!-- <sl-tooltip content="Toggle Select All" hoist> -->
        <sl-icon id="select-all" class="select-none" name="check-circle"></sl-icon>
      <!-- </sl-tooltip> -->

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

    this.#paintAlbumName();

    this.shadowRoot.getElementById("select-all").addEventListener('click', this.#handleSelectAll);
    this.shadowRoot.getElementById("album-label").addEventListener('click', this.#handleLabelClick);
    this.shadowRoot.getElementById("album-input").addEventListener('focus', this.#handleFocus);
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

    this.shadowRoot.getElementById('edit-controls').style.visibility = 'visible';

    this.#closeWatcher = new CloseWatcher();
    this.#closeWatcher.onclose = () => this.#handleCancel();
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
    if (input.value === this.albumName) {
      this.#exitEditMode();
      return;
    }

    try {
      await updateAlbumName(this.#collectionId, this.#albumName, input.value);
      this.albumName = input.value;
      this.#exitEditMode();
      notify('Album name updated successfully', 'success');
    } catch(err) {
      if (err.error?.code === "FOLDER_EXISTS") {
        this.dispatchEvent(new CustomEvent('pl-rename-dir-not-empty', {
          detail: { newAlbumName: input.value }
        }));
      } else {
        notify(`<strong>Error</strong>:</br>${err.error?.code || err.code}`, 'error', -1);
      }
    }
  }

  #handleCancel = () => {
    this.#exitEditMode();
  }

  #handleFocus = async () => {
    // position cursor to enable easy editing
    let input = this.shadowRoot.getElementById('album-input');
    let tbd = this.albumName.search(/(Sush Phone |Shreyas Phone )?TBD/g);

    if (tbd > 0) {
      // Select from TBD onwards for easy replacement
      input.setSelectionRange(tbd, this.albumName.length);

      let searchStr = this.albumName.substring(0, 15);
      try {
        let output = await searchForExistingAlbums(searchStr, true, this.#collectionId);
        if (output.length > 0) {
          this.#populateSuggestions(output, searchStr);
        }
      } catch(err) {
        notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
      }
    }
  }

  #throttledLookup = throttle(() => {
    let input = this.shadowRoot.getElementById('album-input');
    let txt = input.value;
    // Need at least some characters beyond the date prefix to perform lookup
    // TODO: remove hardcoding
    if (!txt.includes('TBD') && txt.trim().length > 16) {
      this.#suggestAlbumNames(txt);
    }
  }, 1000)

  #suggestAlbumNames = async (txt) => {
    let prefix = txt.substring(0, 15);
    let searchPart = txt.substring(15).trim();
    try {
      let output = await searchForExistingAlbums(searchPart, false, this.#collectionId);
      if (output.length > 0) {
        this.#populateSuggestions(output, prefix);
      } else {
        this.#clearSuggestions();
      }
    } catch(err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #handleInput = () => {
    // When user selects a suggestion from the datalist, the browser sets the input
    // value and fires an 'input' event. Detect this by checking if the new value
    // matches a datalist option. If so, clear suggestions (closes the dropdown)
    // and skip further lookups - the user has made their choice.
    let input = this.shadowRoot.getElementById('album-input');
    let datalist = this.shadowRoot.getElementById('album-suggestions');
    let options = datalist.querySelectorAll('option');
    for (let opt of options) {
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

  #populateSuggestions(output, prefix) {
    let datalist = this.shadowRoot.getElementById('album-suggestions');
    datalist.innerHTML = '';
    for (let d of output) {
      let opt = document.createElement('option');
      opt.value = `${prefix} ${d.similar}`;
      datalist.appendChild(opt);
    }
  }

  #clearSuggestions() {
    this.shadowRoot.getElementById('album-suggestions').innerHTML = '';
  }

  disconnectedCallback() {
    //implementation
  }

  attributeChangedCallback() {
    //implementation
  }

  adoptedCallback() {
    //implementation
  }

  #paintAlbumName() {
    let label = this.shadowRoot.getElementById('album-label');
    if (!label) return;
    label.textContent = this.#albumName || '';
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

  get albumName() {
    return this.#albumName;
  }
  set albumName(_) {
    this.#albumName = _;
    if (this.isConnected) {
      this.#paintAlbumName();
    }
  }

  get albumSelectedValue() {
    return this.#albumSelectedValue;
  }
  set albumSelectedValue(_) {
    this.#albumSelectedValue = _;
    if (this.isConnected) {
      this.#paintSelectAllCheckbox();
    }
  }

  get readOnly() { return this.#readOnly; }
  set readOnly(_) { this.#readOnly = Boolean(_); }

  get collectionId() { return this.#collectionId; }
  set collectionId(_) { this.#collectionId = _ || null; }

}

window.customElements.define('pl-album-name', PlAlbumName);
