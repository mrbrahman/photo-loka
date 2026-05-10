import { notify } from '../utils.mjs';
import { getAllFrames } from '../api/admin-api.mjs';

import sheet from "./styles/pl-frame-manager.css" with { type: "css" };

class PlFrameManager extends HTMLElement {
  #frames = [];

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <div class="container">
        <div class="header">
          <h2>Display Frames</h2>
          <sl-button variant="primary" size="medium" id="new-frame-btn">
            <sl-icon slot="prefix" name="plus-lg"></sl-icon> New Frame
          </sl-button>
        </div>
        <div id="frames-list"></div>
      </div>
    `;
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
    this.#setupEventListeners();
    this.#loadFrames();
  }

  async #loadFrames() {
    try {
      this.#frames = await getAllFrames();
      this.#renderFrames();
    } catch (error) {
      notify('Failed to load frames', 'danger');
      console.error(error);
    }
  }

  #renderFrames() {
    const list = this.shadowRoot.getElementById('frames-list');
    list.innerHTML = '';
    
    this.#frames.forEach((frame, index) => {
      const item = document.createElement('pl-frame-item');
      item.data = frame;
      // Auto-expand new frames
      if (index === 0 && !frame.frame_id) {
        setTimeout(() => {
          const details = item.shadowRoot.querySelector('sl-details');
          if (details) details.open = true;
        }, 0);
      }
      list.appendChild(item);
    });
  }

  #setupEventListeners() {
    this.shadowRoot.getElementById('new-frame-btn').addEventListener('click', () => {
      const newFrame = { 
        frame_ip_addr: '', 
        frame_name: '', 
        collection_id: null,
        search_str: '', 
        display_order: 'RANDOM', 
        daily_pause_range: '', 
        reset_schedule: '' 
      };
      this.#frames.unshift(newFrame);
      this.#renderFrames();
    });

    this.shadowRoot.addEventListener('pl-frame-saved', (e) => {
      const newFrame = e.detail.frame;
      this.#frames.unshift(newFrame);
      this.#renderFrames();
    });

    this.shadowRoot.addEventListener('pl-frame-deleted', () => {
      this.#loadFrames();
    });
  }
}

window.customElements.define('pl-frame-manager', PlFrameManager);
