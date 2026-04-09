import {notify, showConfirmDialog} from '../utils.mjs';
import {authenticatedFetch} from '../authn.mjs';

import sheet from "./styles/pl-face-thumb.css" with { type: "css" };

class PlFaceThumb extends HTMLElement {
  #personName; #clusterId; #uuid; #faceIdx; #legacy;

  static get observedAttributes() { return ['uuid', 'cluster-id', 'person-name', 'face-idx', 'legacy']; }

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <sl-icon-button id="dismiss" name="x-lg"></sl-icon-button>
      <img id="thumb" />
      <div id="placeholder" hidden>&#128100;</div>
      <div id="name"></div>
    `;
  }

  constructor() {
    super().attachShadow({mode: 'open'});
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    let img = this.shadowRoot.getElementById('thumb');
    img.onerror = () => {
      img.hidden = true;
      this.shadowRoot.getElementById('placeholder').hidden = false;
    };

    let label = this.shadowRoot.getElementById('name');
    let dismissBtn = this.shadowRoot.getElementById('dismiss');

    if (!this.#legacy) {
      label.contentEditable = 'true';
      label.spellcheck = false;
      label.addEventListener('focus', () => this.#onFocus(label));
      label.addEventListener('blur', () => this.#onBlur(label));
      label.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); label.blur(); }
        if (e.key === 'Escape') { label.textContent = this.#personName || ''; label.blur(); }
      });
      dismissBtn.addEventListener('click', (e) => { e.stopPropagation(); this.#onDismiss(); });
    }

    this.#update();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal) return;
    switch (name) {
      case 'uuid': this.#uuid = newVal; break;
      case 'cluster-id': this.#clusterId = newVal; break;
      case 'person-name': this.#personName = newVal; break;
      case 'face-idx': this.#faceIdx = newVal; break;
      case 'legacy': this.#legacy = this.hasAttribute('legacy'); break;
    }
    if (this.isConnected) this.#update();
  }

  #update() {
    let img = this.shadowRoot.getElementById('thumb');
    if (!img) return;

    img.src = this.#personName
      ? `/api/getFaceThumbnail?uuid=${this.#uuid}&name=${encodeURIComponent(this.#personName)}`
      : `/api/getFaceThumbnail?uuid=${this.#uuid}&cluster_id=${encodeURIComponent(this.#clusterId)}`;
    img.hidden = false;
    this.shadowRoot.getElementById('placeholder').hidden = true;

    let label = this.shadowRoot.getElementById('name');
    label.textContent = this.#personName || '';
    label.title = this.#personName || 'Click to name';
    if (!this.#personName && !this.#legacy) {
      label.dataset.placeholder = 'Name...';
      label.classList.add('face-name-empty');
    } else {
      delete label.dataset.placeholder;
      label.classList.remove('face-name-empty');
    }

    // Show dismiss only for unnamed, non-legacy faces
    this.shadowRoot.getElementById('dismiss').hidden = !!(this.#personName || this.#legacy);
  }

  async #onFocus(label) {
    if (!this.#clusterId) return;
    try {
      let res = await authenticatedFetch(`/api/faceSuggestions/${encodeURIComponent(this.#clusterId)}`);
      if (!res.ok) return;
      let data = await res.json();
      let suggestions = data.suggestions || [];
      if (suggestions.length === 0) return;

      this.#removeSuggestionsPopup();

      let popup = document.createElement('sl-popup');
      popup.id = 'suggestions';
      popup.anchor = label;
      popup.placement = 'bottom';
      popup.active = true;
      popup.hoist = true;
      popup.distance = 4;

      let menu = document.createElement('sl-menu');
      menu.style.cssText = 'max-height:150px;overflow-y:auto;min-width:120px;';
      for (let s of suggestions) {
        let menuItem = document.createElement('sl-menu-item');
        menuItem.textContent = s.suggested_name;
        menuItem.addEventListener('click', () => {
          label.textContent = menuItem.textContent;
          this.#removeSuggestionsPopup();
          label.blur();
        });
        menu.appendChild(menuItem);
      }

      popup.appendChild(menu);
      this.shadowRoot.appendChild(popup);
    } catch (err) {
      // Suggestions are best-effort
    }
  }

  async #onBlur(label) {
    await new Promise(r => setTimeout(r, 150));
    this.#removeSuggestionsPopup();

    let newName = label.textContent.trim();
    let oldName = this.#personName || '';

    if (!newName || newName === oldName) {
      label.textContent = oldName;
      if (!oldName) label.classList.add('face-name-empty');
      return;
    }

    try {
      let res;
      if (!oldName) {
        res = await authenticatedFetch(`/api/nameFaceCluster/${encodeURIComponent(this.#clusterId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        });
      } else {
        res = await authenticatedFetch('/api/updatePersonName', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldName, newName }),
        });
      }

      if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status}` } }));
      let result = await res.json();

      this.#personName = newName;
      this.setAttribute('person-name', newName);

      let msg = !oldName
        ? `Named ${result.count} photo(s) as ${newName}`
        : `Renamed to ${newName} (${result.count} photo(s))`;
      notify(msg, 'success', 3000);

      if (!oldName) {
        this.dispatchEvent(new CustomEvent('pl-face-named', {
          composed: true, bubbles: true,
          detail: { clusterId: this.#clusterId, name: newName, count: result.count },
        }));
      }

    } catch (err) {
      label.textContent = oldName;
      if (!oldName) label.classList.add('face-name-empty');
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  async #onDismiss() {
    let confirmed = await showConfirmDialog(
      'Dismiss face',
      'Dismiss this face from all photos?',
      'Dismiss', 'Cancel'
    );
    if (confirmed !== 1) return;

    try {
      let res = await authenticatedFetch(`/api/dismissFaceCluster/${encodeURIComonent(this.#clusterId)}`, {
        method: 'PUT',
      });
      if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status}` } }));

      notify('Face dismissed', 'success', 2000);
      this.dispatchEvent(new CustomEvent('pl-face-dismissed', {
        composed: true, bubbles: true,
        detail: { clusterId: this.#clusterId },
      }));
    } catch (err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #removeSuggestionsPopup() {
    let existing = this.shadowRoot.getElementById('suggestions');
    if (existing) existing.remove();
  }
}

window.customElements.define('pl-face-thumb', PlFaceThumb);
