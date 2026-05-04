import { notify, showConfirmDialog } from '../utils.mjs';
import { authenticatedFetch } from '../authn.mjs';
import { serialize } from 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/utilities/form.js';

import sheet from "./styles/pl-frame-item.css" with { type: "css" };

class PlFrameItem extends HTMLElement {
  #data = {};

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <sl-details class="frame-row">
        <div slot="summary" class="row-summary">
          <div class="info-group">
            <div class="title" id="title-display"></div>
            <div class="subtitle" id="ip-display"></div>
          </div>
          <div class="status-group">
            <sl-badge id="status-badge" pill></sl-badge>
            <sl-icon-button id="pause-btn" name="pause-circle" label="Pause" style="display: none;"></sl-icon-button>
            <sl-icon-button id="resume-btn" name="play-circle" label="Resume" style="display: none;"></sl-icon-button>
          </div>
        </div>

        <form class="edit-form" id="form">
          <sl-input id="name" name="frame_name" label="Frame Name" size="small" required></sl-input>
          <sl-input id="ip" name="frame_ip_addr" label="IP Address" size="small" required></sl-input>
          
          <sl-select id="collection" name="collection_id" label="Collection" size="small">
            <sl-option value="">All Collections</sl-option>
            <sl-option value="1">Family Pics</sl-option>
          </sl-select>
          
          <sl-select id="order" name="display_order" label="Display Order" size="small">
            <sl-option value="ASC">Date (Oldest First)</sl-option>
            <sl-option value="DESC">Date (Newest First)</sl-option>
            <sl-option value="RANDOM">Random</sl-option>
          </sl-select>
          
          <sl-input id="search" name="search_str" label="Search Query" size="small" class="full-width" required></sl-input>
          
          <sl-input id="pause" name="daily_pause_range" label="Daily Pause (HH:mm-HH:mm)" size="small" placeholder="22:00-06:00"></sl-input>
          <sl-input id="cron" name="reset_schedule" label="Reset Schedule (Cron)" size="small" placeholder="0 0 * * *"></sl-input>

          <div class="preview-section full-width">
            <div class="preview-header">
              <h4 style="margin: 0;">Preview</h4>
              <sl-button size="small" type="button" id="load-preview-btn">
                Load Preview
              </sl-button>
            </div>
            <div id="preview-grid" style="display: none;"></div>
          </div>

          <div class="full-width" style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.5rem;">
            <sl-button size="small" variant="danger" outline type="button" id="delete-btn">Delete</sl-button>
            <sl-button size="small" variant="primary" type="submit" id="save-btn">Save Changes</sl-button>
          </div>
        </form>
      </sl-details>
    `;
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  set data(value) {
    this.#data = value;
    if (this.shadowRoot.firstChild) {
      this.#updateDisplay();
    }
  }

  get data() {
    return this.#data;
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
    this.#updateDisplay();
    this.#setupEventListeners();
  }

  #updateDisplay() {
    const { frame_name, frame_ip_addr, collection_id, search_str, display_order, daily_pause_range, reset_schedule, autoPause, manualPause } = this.#data;
    
    this.shadowRoot.getElementById('title-display').textContent = frame_name || 'Unnamed Frame';
    this.shadowRoot.getElementById('ip-display').textContent = frame_ip_addr || '0.0.0.0';
    
    const statusBadge = this.shadowRoot.getElementById('status-badge');
    const pauseBtn = this.shadowRoot.getElementById('pause-btn');
    const resumeBtn = this.shadowRoot.getElementById('resume-btn');
    
    if (!frame_ip_addr) {
      statusBadge.variant = 'neutral';
      statusBadge.textContent = 'Pending';
      pauseBtn.style.display = 'none';
      resumeBtn.style.display = 'none';
    } else if (manualPause.paused) {
      statusBadge.variant = 'warning';
      statusBadge.textContent = `Paused (${manualPause.resumeAtSchedule ? "auto-resume" : "manual-resume"})`;
      pauseBtn.style.display = 'none';
      resumeBtn.style.display = 'inline-block';
    } else if (autoPause.paused) {
      statusBadge.variant = 'warning';
      statusBadge.textContent = 'Paused (auto)';
      pauseBtn.style.display = 'none';
      resumeBtn.style.display = 'inline-block';
    } else {
      statusBadge.variant = 'success';
      statusBadge.textContent = 'Active';
      pauseBtn.style.display = 'inline-block';
      resumeBtn.style.display = 'none';
    }
    
    this.shadowRoot.getElementById('name').value = frame_name || '';
    this.shadowRoot.getElementById('ip').value = frame_ip_addr || '';
    this.shadowRoot.getElementById('collection').value = collection_id || '';
    this.shadowRoot.getElementById('search').value = search_str || '';
    this.shadowRoot.getElementById('order').value = display_order || 'RANDOM';
    this.shadowRoot.getElementById('pause').value = daily_pause_range || '';
    this.shadowRoot.getElementById('cron').value = reset_schedule || '';
  }

  #setupEventListeners() {
    const form = this.shadowRoot.getElementById('form');
    const loadBtn = this.shadowRoot.getElementById('load-preview-btn');
    const previewGrid = this.shadowRoot.getElementById('preview-grid');
    
    // Update header when form fields change
    const nameInput = this.shadowRoot.getElementById('name');
    const ipInput = this.shadowRoot.getElementById('ip');
    
    nameInput.addEventListener('input', () => {
      this.shadowRoot.getElementById('title-display').textContent = nameInput.value || 'Unnamed Frame';
    });
    
    ipInput.addEventListener('input', () => {
      this.shadowRoot.getElementById('ip-display').textContent = ipInput.value || '0.0.0.0';
    });
    
    loadBtn.addEventListener('click', async () => {
      const searchStr = this.shadowRoot.getElementById('search').value;
      if (!searchStr) {
        notify('Enter a search query first', 'warning');
        return;
      }

      loadBtn.loading = true;
      try {
        const response = await authenticatedFetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            collection_id: this.shadowRoot.getElementById('collection').value || null,
            searchText: searchStr
          })
        });
        
        if (!response.ok) throw new Error('Search failed');
        
        const results = await response.json();
        const items = results.flatMap(album => album.items).slice(0, 6);
        
        previewGrid.innerHTML = items.map(item => `
          <div class="preview-item">
            <img src="/api/getThumbnail?uuid=${item.uuid}&height=100" alt="">
          </div>
        `).join('');
        
        previewGrid.style.display = 'grid';
        loadBtn.style.display = 'none';
      } catch (error) {
        notify('Failed to load preview', 'danger');
      } finally {
        loadBtn.loading = false;
      }
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const saveBtn = this.shadowRoot.getElementById('save-btn');
      saveBtn.loading = true;
      
      try {
        const data = serialize(form);
        console.log(data)
        data.collection_id = data.collection_id === 'null' ? null : parseInt(data.collection_id);
        
        if (this.#data.frame_id) {
          // Update existing frame
          const response = await authenticatedFetch(`/api/admin/updateFrame/${this.#data.frame_id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          
          if (!response.ok) throw new Error('Save failed');
          
          Object.assign(this.#data, data);
          notify('Frame saved successfully!', 'success');
        } else {
          // Create new frame
          const response = await authenticatedFetch('/api/admin/createNewFrame', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          
          if (!response.ok) throw new Error('Save failed');
          
          const { frame_id } = await response.json();
          const newFrame = { ...data, frame_id };
          
          notify('Frame saved successfully!', 'success');
          this.dispatchEvent(new CustomEvent('pl-frame-saved', { 
            bubbles: true, 
            composed: true,
            detail: { frame: newFrame }
          }));
        }
      } catch (error) {
        notify('Failed to save frame', 'danger');
        console.error(error);
      } finally {
        saveBtn.loading = false;
      }
    });

    this.shadowRoot.getElementById('delete-btn').addEventListener('click', async () => {
      if (!confirm(`Delete ${this.#data.frame_name}?`)) return;
      
      try {
        const response = await authenticatedFetch(`/api/admin/deleteFrame/${this.#data.frame_id}`, {
          method: 'DELETE'
        });
        
        if (!response.ok) throw new Error('Delete failed');
        
        notify('Frame deleted', 'warning');
        this.dispatchEvent(new CustomEvent('pl-frame-deleted', { bubbles: true, composed: true }));
      } catch (error) {
        notify('Failed to delete frame', 'danger');
        console.error(error);
      }
    });

    this.shadowRoot.getElementById('pause-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      
      if (this.#data.daily_pause_range) {
        showConfirmDialog(
          'Pause Frame', 
          `Should the pause end at the scheduled time (${this.#data.daily_pause_range})?`,
          'Yes (auto-resume)',
          'No (manual-resume)'
        )
        .then(resumeAtSchedule => {
          if(resumeAtSchedule) this.#pauseFrame(resumeAtSchedule === 1 ? true : false);
        })
        .catch((err) => {
          notify('Dialog error', 'danger');
        });

      } else {
        this.#pauseFrame(false);
      }
    });

    this.shadowRoot.getElementById('resume-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      
      try {
        const response = await authenticatedFetch(`/api/admin/resumeFrame/${this.#data.frame_id}`, {
          method: 'POST'
        });
        
        if (!response.ok) throw new Error('Resume failed');
        
        this.#data.manualPause.paused = false;
        this.#data.manualPause.resumeAtSchedule = null;
        this.#updateDisplay();
        notify('Frame resumed', 'success');
      } catch (error) {
        notify('Failed to resume frame', 'danger');
        console.error(error);
      }
    });
  }

  async #pauseFrame(resumeAtSchedule) {
    try {
      const response = await authenticatedFetch(`/api/admin/pauseFrame/${this.#data.frame_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeAtSchedule })
      });
      
      if (!response.ok) throw new Error('Pause failed');
      
      this.#data.manualPause.paused = true;
      this.#data.manualPause.resumeAtSchedule = resumeAtSchedule;
      this.#updateDisplay();  // TODO: just update the relevant parts instead of re-rendering everything
      notify('Frame paused', 'success');
    } catch (error) {
      notify('Failed to pause frame', 'danger');
      console.error(error);
    }
  }
}

window.customElements.define('pl-frame-item', PlFrameItem);
