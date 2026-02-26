import { notify } from './utils.mjs';

class PlFrameManager extends HTMLElement {
  #frames = [];

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.shadowRoot.appendChild(
      document.getElementById(this.nodeName).content.cloneNode(true)
    );
    this.#setupEventListeners();
    this.#loadFrames();
  }

  async #loadFrames() {
    try {
      const response = await fetch('/api/getAllFrames');
      if (!response.ok) {
        let errorResponse = await response.json();
        throw new Error('Failed to load frame');
      }
      this.#frames = await response.json();
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
