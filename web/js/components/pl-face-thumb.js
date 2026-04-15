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
      <div id="name" contenteditable spellcheck="false"></div>
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

    let label = this.shadowRoot.getElementById('name');
    let dismissBtn = this.shadowRoot.getElementById('dismiss');

    label.addEventListener('focus', () => {
      // Place caret inside the contentEditable div (needed when clicking on ::before placeholder)
      let sel = this.shadowRoot.getSelection?.() || document.getSelection();
      if (sel && label.childNodes.length === 0) {
        let range = document.createRange();
        range.setStart(label, 0);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      this.#onFocus(label);
    });
    label.addEventListener('blur', () => this.#onBlur(label));
    label.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); label.blur(); }
      if (e.key === 'Escape') { label.textContent = this.#personName || ''; label.blur(); }
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
    let label = this.shadowRoot.getElementById('name');
    if (!label) return;

    label.textContent = this.#personName || '';
    label.title = this.#personName || 'Click to name';
    if (!this.#personName) {
      label.dataset.placeholder = 'Name...';
      label.classList.add('face-name-empty');
    } else {
      delete label.dataset.placeholder;
      label.classList.remove('face-name-empty');
    }

    // Show dismiss only for unnamed faces
    this.shadowRoot.getElementById('dismiss').hidden = !!this.#personName;
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

      let popup = Object.assign(document.createElement('sl-popup'), {
        id: 'suggestions',
        anchor: label,
        placement: 'bottom',
        active: true,
        distance: 4,
        // sl-popup defaults to strategy="absolute", which positions relative to the
        // offset parent (the :host with position:relative). This causes the popup to
        // be clipped by sibling face-thumb elements in the next row due to stacking
        // context. strategy="fixed" positions relative to the viewport, avoiding this.
        // Note: sl-popup (v2.15.1) does not have a "hoist" property - that exists on
        // other Shoelace components like sl-select/sl-dropdown.
        strategy: 'fixed',
      });

      let menu = document.createElement('sl-menu');
      menu.style.cssText = 'max-height:150px;overflow-y:auto;min-width:120px;';
      // The name label uses contentEditable, which means any click outside it
      // triggers blur. When the user moves the mouse from the label to this
      // suggestions menu, the label would lose focus, firing #onBlur which
      // removes the popup before the click registers.
      //
      // Alternatives considered:
      //   - Appending popup inside the contentEditable div -> menu text becomes
      //     part of the editable content, corrupting textContent reads
      //   - Wrapping both in a container -> popup is still a sibling, so clicking
      //     it still causes the contentEditable to blur
      //   - Using a flag set on mousedown -> works but fragile and harder to follow
      //
      // preventDefault on mousedown is the cleanest fix: it stops the browser from
      // moving focus away from the label, while still allowing the click event to
      // fire normally on the menu item.
      menu.addEventListener('mousedown', (e) => e.preventDefault());
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

  #removeSuggestionsPopup() {
    let existing = this.shadowRoot.getElementById('suggestions');
    if (existing) existing.remove();
  }
}

window.customElements.define('pl-face-thumb', PlFaceThumb);
