import {notify, showConfirmDialog} from '../utils.mjs';
import {authenticatedFetch} from '../authn.mjs';

import sheet from "./styles/pl-face-thumb.css" with { type: "css" };

class PlFaceThumb extends HTMLElement {
  #personName; #clusterId; #uuid; #faceIdx;

  static get observedAttributes() { return ['uuid', 'cluster-id', 'person-name', 'face-idx']; }

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <sl-icon-button id="dismiss" name="x-lg"></sl-icon-button>
      <img id="thumb" />
      <div id="placeholder" hidden>&#128100;</div>
      <input id="name" list="suggestions" placeholder="Name..." autocomplete="off" />
      <datalist id="suggestions"></datalist>
    `;
  }

  constructor() {
    super().attachShadow({mode: 'open'});
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    // Guard against re-running setup when the element is moved in the DOM.
    // Moving a custom element (e.g. appendChild to a different parent) triggers
    // disconnectedCallback followed by connectedCallback. Without this guard,
    // the template would be cloned again (duplicating DOM nodes like img#thumb)
    // and event listeners would be attached a second time.
    if (this.shadowRoot.getElementById('thumb')) return;

    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    let img = this.shadowRoot.getElementById('thumb');
    img.onerror = () => {
      img.hidden = true;
      this.shadowRoot.getElementById('placeholder').hidden = false;
    };
    img.src = `/api/getFaceThumbnail?uuid=${this.#uuid}&cluster_id=${encodeURIComponent(this.#clusterId)}`;

    let input = this.shadowRoot.getElementById('name');
    let datalist = this.shadowRoot.getElementById('suggestions');
    let dismissBtn = this.shadowRoot.getElementById('dismiss');

    input.addEventListener('focus', () => this.#fetchSuggestion(datalist));
    input.addEventListener('blur', () => this.#onBlur(input));
    // Convention: use keydown (not keyup) for action keys (Escape, Enter, arrows).
    // keydown fires immediately and stopPropagation works reliably - with keyup,
    // if a keydown handler blurs the element, keyup fires from a different target,
    // bypassing any stopPropagation on the original element.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.stopPropagation(); input.value = this.#personName || ''; input.blur(); }
    });
    dismissBtn.addEventListener('click', (e) => { e.stopPropagation(); this.#onDismiss(); });

    this.#updateName();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal) return;
    switch (name) {
      case 'uuid': this.#uuid = newVal; break;
      case 'cluster-id': this.#clusterId = newVal; break;
      case 'person-name': this.#personName = newVal; break;
      case 'face-idx': this.#faceIdx = newVal; break;
    }
    if (name === 'person-name' && this.isConnected) this.#updateName();
  }

  #updateName() {
    let input = this.shadowRoot.getElementById('name');
    if (!input) return;

    input.value = this.#personName || '';
    input.title = this.#personName || 'Click to name';

    // Show dismiss only for unnamed faces
    this.shadowRoot.getElementById('dismiss').hidden = !!this.#personName;
  }

  async #fetchSuggestion(datalist) {
    if (!this.#clusterId) return;
    try {
      let res = await authenticatedFetch(`/api/faceSuggestions/${encodeURIComponent(this.#clusterId)}`);
      if (!res.ok) return;
      let data = await res.json();
      let suggestions = data.suggestions || [];
      datalist.innerHTML = '';
      for (let s of suggestions) {
        datalist.appendChild(Object.assign(document.createElement('option'), { value: s.suggested_name }));
      }
    } catch (err) {
      // Suggestions are best-effort
    }
  }

  async #onBlur(input) {
    let newName = input.value.trim();
    let oldName = this.#personName || '';

    if (!newName || newName === oldName) {
      input.value = oldName;
      return;
    }

    try {
      let res, msg;

      if (!oldName) {
        // Naming an unnamed cluster ??? no choice needed
        res = await authenticatedFetch(`/api/nameFaceCluster/${encodeURIComponent(this.#clusterId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        });
        if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status}` } }));
        let result = await res.json();
        msg = `Named ${result.count} photo(s) as ${newName}`;

        this.dispatchEvent(new CustomEvent('pl-face-named', {
          composed: true, bubbles: true,
          detail: { clusterId: this.#clusterId, name: newName, count: result.count },
        }));

      } else {
        // Renaming a known face ??? ask user for scope
        let choice = await showConfirmDialog(
          `Rename "${oldName}"`,
          `Rename to "<strong>${newName}</strong>". Rename this person everywhere, or only this face cluster?`,
          'Rename everywhere',
          'This cluster only'
        );

        if (!choice) {
          // Dialog closed without choosing ??? revert
          input.value = oldName;
          return;
        }

        if (choice === 1) {
          // Rename person globally
          res = await authenticatedFetch('/api/updatePersonName', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldName, newName }),
          });
        } else {
          // Rename this cluster only
          res = await authenticatedFetch(`/api/nameFaceCluster/${encodeURIComponent(this.#clusterId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName }),
          });
        }

        if (!res.ok) throw await res.json().catch(() => ({ error: { message: `${res.status}` } }));
        let result = await res.json();

        msg = choice === 1
          ? `Renamed "${oldName}" to "${newName}" (${result.count} photo(s))`
          : `Renamed cluster to "${newName}" (${result.count} photo(s))`;
      }

      this.#personName = newName;
      this.setAttribute('person-name', newName);
      notify(msg, 'success', 3000);

    } catch (err) {
      input.value = oldName;
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
      let res = await authenticatedFetch(`/api/dismissFaceCluster/${encodeURIComponent(this.#clusterId)}`, {
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

}

window.customElements.define('pl-face-thumb', PlFaceThumb);
