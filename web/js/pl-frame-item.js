import { notify, showConfirmDialog } from './utils.mjs';
import { serialize } from 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/utilities/form.js';

class PlFrameItem extends HTMLElement {
  #data = {};

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
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
    this.shadowRoot.appendChild(
      document.getElementById(this.nodeName).content.cloneNode(true)
    );
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
        const response = await fetch('/api/search', {
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
          const response = await fetch(`/api/updateFrame/${this.#data.frame_id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
          });
          
          if (!response.ok) throw new Error('Save failed');
          
          Object.assign(this.#data, data);
          notify('Frame saved successfully!', 'success');
        } else {
          // Create new frame
          const response = await fetch('/api/createNewFrame', {
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
        const response = await fetch(`/api/deleteFrame/${this.#data.frame_id}`, {
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
        const response = await fetch(`/api/resumeFrame/${this.#data.frame_id}`, {
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
      const response = await fetch(`/api/pauseFrame/${this.#data.frame_id}`, {
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
