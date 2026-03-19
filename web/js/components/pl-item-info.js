import {notify} from '../utils.mjs';

import sheet from "./styles/pl-item-info.css" with { type: "css" };

class PlItemInfo extends HTMLElement {
  #uuid; #data; #map; #originalDesc; #originalStem; #ext;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <sl-drawer label="Info" placement="end" open>
        <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
        <div id="content">
          <div class="loading">Loading...</div>

          <div id="info-body" hidden>

            <!-- Description -->
            <div id="desc-section">
              <textarea id="description" placeholder="Add a description..." rows="2"></textarea>
              <div id="desc-status" class="field-status"></div>
            </div>

            <!-- People -->
            <div class="info-row" id="people-row" hidden>
              <sl-icon name="people" class="row-icon"></sl-icon>
              <div class="row-content">
                <div id="faces-list" class="faces-list"></div>
              </div>
            </div>

            <!-- Camera -->
            <div class="info-row" id="camera-row" hidden>
              <sl-icon name="camera-fill" class="row-icon"></sl-icon>
              <div class="row-content">
                <div id="camera-name"></div>
                <div id="camera-meta" class="meta-sub"></div>
              </div>
            </div>

            <!-- File -->
            <div class="info-row" id="file-row">
              <sl-icon id="file-icon" name="image-fill" class="row-icon"></sl-icon>
              <div class="row-content">
                <div id="file-meta"></div>
                <div class="filename-wrap">
                  <span id="file-dir"></span><input id="filename" type="text" spellcheck="false"><span id="file-ext"></span>
                </div>
                <div id="filename-status" class="field-status"></div>
              </div>
            </div>

            <!-- Keywords -->
            <div class="info-row" id="keywords-row" hidden>
              <sl-icon name="tags" class="row-icon"></sl-icon>
              <div class="row-content">
                <div id="keywords-list" class="keywords-list"></div>
              </div>
            </div>

            <!-- Location -->
            <div class="info-row" id="location-row" hidden>
              <sl-icon name="geo-alt" class="row-icon"></sl-icon>
              <div class="row-content">
                <div id="geo-address"></div>
                <div id="map-container"></div>
              </div>
            </div>

            <!-- Dates -->
            <div class="info-row" id="dates-row">
              <sl-icon name="calendar3" class="row-icon"></sl-icon>
              <div class="row-content">
                <div id="dates-list" class="dates-list"></div>
              </div>
            </div>

          </div>
        </div>
      </sl-drawer>
    `;
  }

  constructor() {
    super().attachShadow({mode: 'open'});
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    this.shadowRoot.querySelector('sl-drawer').addEventListener('sl-after-hide', () => {
      this.dispatchEvent(new Event('pl-info-panel-closed', {composed: true, bubbles: true}));
      this.remove();
    });

    // Stop keyboard events from reaching slideshow when info panel is open
    this.addEventListener('keydown', (e) => e.stopPropagation());
    this.addEventListener('keyup', (e) => e.stopPropagation());

    // Filename save on blur / enter, auto-size on input
    let fnInput = this.shadowRoot.getElementById('filename');
    fnInput.addEventListener('blur', () => this.#saveFilename());
    fnInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') fnInput.blur(); });
    fnInput.addEventListener('input', () => { fnInput.size = Math.max(1, fnInput.value.length + 1); });

    // Description save on blur
    let descEl = this.shadowRoot.getElementById('description');
    let descStatus = this.shadowRoot.getElementById('desc-status');
    descEl.addEventListener('blur', () => this.#saveDescription(descEl, descStatus));

    if (this.#uuid) this.#fetchAndRender();
  }

  disconnectedCallback() {
    if (this.#map) {
      this.#map.remove();
      this.#map = null;
    }
  }

  set uuid(val) {
    let changed = this.#uuid !== val;
    this.#uuid = val;
    if (changed && this.isConnected) this.#fetchAndRender();
  }
  get uuid() { return this.#uuid; }

  async #fetchAndRender() {
    let loading = this.shadowRoot.querySelector('.loading');
    let body = this.shadowRoot.getElementById('info-body');
    loading.hidden = false;
    body.hidden = true;

    if (this.#map) {
      this.#map.remove();
      this.#map = null;
    }

    try {
      let res = await fetch(`/api/getItemInfo?uuid=${this.#uuid}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      this.#data = await res.json();
      this.#populate();
      loading.hidden = true;
      body.hidden = false;
    } catch (err) {
      loading.textContent = 'Failed to load info';
    }
  }

  #populate() {
    let d = this.#data;

    // Filename - split into dir, stem, extension
    let fullPath = d.filename || '';
    let lastSlash = Math.max(fullPath.lastIndexOf('/'), fullPath.lastIndexOf('\\'));
    let dir = lastSlash >= 0 ? fullPath.substring(0, lastSlash + 1) : '';
    let basename = lastSlash >= 0 ? fullPath.substring(lastSlash + 1) : fullPath;
    let dotIdx = basename.lastIndexOf('.');
    if (dotIdx > 0) {
      this.#originalStem = basename.substring(0, dotIdx);
      this.#ext = basename.substring(dotIdx);
    } else {
      this.#originalStem = basename;
      this.#ext = '';
    }
    this.shadowRoot.getElementById('file-dir').textContent = dir;
    this.shadowRoot.getElementById('filename').value = this.#originalStem;
    this.shadowRoot.getElementById('filename').size = Math.max(1, this.#originalStem.length + 1);
    this.shadowRoot.getElementById('file-ext').textContent = this.#ext;

    // Description
    this.#originalDesc = (d.description?.trim() && d.description.trim() !== 'null') ? d.description.trim() : '';
    this.shadowRoot.getElementById('description').value = this.#originalDesc;

    // Camera
    let cameraRow = this.shadowRoot.getElementById('camera-row');
    if (d.make || d.model) {
      cameraRow.hidden = false;
      this.shadowRoot.getElementById('camera-name').textContent = [d.make, d.model].filter(Boolean).join(' ');
      let cameraMeta = [];
      if (d.image_width && d.image_height) cameraMeta.push(`${d.image_width} x ${d.image_height}`);
      if (d.duration) cameraMeta.push(this.#formatDuration(d.duration));
      this.shadowRoot.getElementById('camera-meta').textContent = cameraMeta.join('  •  ');
    } else {
      cameraRow.hidden = true;
    }

    // File info
    let fileParts = [];
    if (d.mediatype) fileParts.push(d.mediatype);
    if (d.ext) fileParts.push(d.ext.toUpperCase());
    if (d.filesize) fileParts.push(this.#formatFileSize(d.filesize));
    if (!d.make && !d.model) {
      // Show dimensions here if no camera row
      if (d.image_width && d.image_height) fileParts.push(`${d.image_width} x ${d.image_height}`);
      if (d.duration) fileParts.push(this.#formatDuration(d.duration));
    }
    this.shadowRoot.getElementById('file-meta').textContent = fileParts.join('  •  ');

    // File icon based on media type
    let fileIcon = this.shadowRoot.getElementById('file-icon');
    if (d.mediatype?.startsWith('video')) fileIcon.name = 'film';
    else if (d.mediatype?.startsWith('audio')) fileIcon.name = 'music-note-beamed';
    else fileIcon.name = 'image-fill';

    // Dates
    let datesList = this.shadowRoot.getElementById('dates-list');
    datesList.innerHTML = '';
    let dates = [
      ['Taken', d.datetime_original],
      ['Created', d.create_date],
      ['File date', d.file_date],
      ['Modified', d.file_modify_date],
      ['Indexed', d.indexed_dt],
      ['Trashed', d.trashed_dt],
    ].filter(([, v]) => v);

    for (let [label, val] of dates) {
      let row = document.createElement('div');
      row.className = 'date-row';
      row.innerHTML = `<span class="date-label">${label}</span><span class="date-value">${this.#formatDate(val)}</span>`;
      datesList.appendChild(row);
    }

    // Location
    let locSection = this.shadowRoot.getElementById('location-row');
    if (d.gps_lat && d.gps_long) {
      locSection.hidden = false;
      let addrEl = this.shadowRoot.getElementById('geo-address');
      addrEl.textContent = d.geo_address || `${d.gps_lat.toFixed(4)}, ${d.gps_long.toFixed(4)}`;

      let mapDiv = this.shadowRoot.getElementById('map-container');
      requestAnimationFrame(() => {
        if (!mapDiv.isConnected) return;
        this.#map = L.map(mapDiv, { zoomControl: false, attributionControl: false })
          .setView([d.gps_lat, d.gps_long], 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(this.#map);
        L.marker([d.gps_lat, d.gps_long]).addTo(this.#map);
        setTimeout(() => this.#map?.invalidateSize(), 100);
      });
    } else {
      locSection.hidden = true;
    }

    // People
    let peopleSection = this.shadowRoot.getElementById('people-row');
    let facesList = this.shadowRoot.getElementById('faces-list');
    facesList.innerHTML = '';
    let faces = this.#parseFaces(d.faces);
    if (faces.length > 0) {
      peopleSection.hidden = false;
      for (let name of faces) {
        let item = document.createElement('div');
        item.className = 'face-item';

        let img = Object.assign(document.createElement('img'), {
          className: 'face-thumb',
          src: `/api/getFaceThumbnail?uuid=${this.#uuid}&name=${encodeURIComponent(name)}`,
        });
        img.onerror = () => {
          let placeholder = Object.assign(document.createElement('div'), { className: 'face-placeholder' });
          placeholder.innerHTML = '&#128100;';
          item.replaceChild(placeholder, img);
        };

        let label = Object.assign(document.createElement('div'), { className: 'face-name', textContent: name, title: name });
        item.append(img, label);
        facesList.appendChild(item);
      }
    } else {
      peopleSection.hidden = true;
    }

    // Keywords
    let kwSection = this.shadowRoot.getElementById('keywords-row');
    let kwList = this.shadowRoot.getElementById('keywords-list');
    kwList.innerHTML = '';
    let keywords = this.#parseKeywords(d.keywords);
    if (keywords.length > 0) {
      kwSection.hidden = false;
      for (let kw of keywords) {
        kwList.appendChild(Object.assign(document.createElement('span'), { className: 'keyword-tag', textContent: kw }));
      }
    } else {
      kwSection.hidden = true;
    }
  }

  async #saveFilename() {
    let input = this.shadowRoot.getElementById('filename');
    let status = this.shadowRoot.getElementById('filename-status');
    let newStem = input.value.trim();
    if (!newStem || newStem === this.#originalStem) {
      input.value = this.#originalStem;
      return;
    }

    let newBasename = newStem + this.#ext;
    status.textContent = 'Saving...';
    status.className = 'field-status saving';

    try {
      let res = await fetch('/api/renameFile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection_id: 1, uuid: this.#uuid, newBasename })
      });

      if (!res.ok) throw await res.json().catch(() => ({error: {message: `${res.status} ${res.statusText}`}}));

      this.#originalStem = newStem;
      status.textContent = 'Saved';
      status.className = 'field-status saved';
      setTimeout(() => { if (status.isConnected) { status.textContent = ''; status.className = 'field-status'; } }, 2000);

    } catch (err) {
      input.value = this.#originalStem;
      status.textContent = 'Error saving';
      status.className = 'field-status error';
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  async #saveDescription(textarea, status) {
    let newDesc = textarea.value.trim();
    if (newDesc === this.#originalDesc) return;

    status.textContent = 'Saving...';
    status.className = 'field-status saving';

    try {
      let res = await fetch('/api/updateDescription', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: this.#uuid, description: newDesc })
      });

      if (!res.ok) throw await res.json().catch(() => ({error: {message: `${res.status} ${res.statusText}`}}));

      this.#originalDesc = newDesc;
      status.textContent = 'Saved';
      status.className = 'field-status saved';
      setTimeout(() => { if (status.isConnected) { status.textContent = ''; status.className = 'field-status'; } }, 2000);

      this.dispatchEvent(new CustomEvent('pl-item-desc-updated', {
        composed: true, bubbles: true,
        detail: { uuid: this.#uuid, hasDesc: newDesc.length > 0 ? 1 : 0 }
      }));

    } catch (err) {
      status.textContent = 'Error saving';
      status.className = 'field-status error';
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #parseFaces(faces) {
    try {
      let parsed = typeof faces === 'string' ? JSON.parse(faces) : faces;
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch {}
    return [];
  }

  #parseKeywords(keywords) {
    try {
      let parsed = typeof keywords === 'string' ? JSON.parse(keywords) : keywords;
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch {}
    if (typeof keywords === 'string' && keywords.trim()) return [keywords];
    return [];
  }

  #formatFileSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  #formatDuration(seconds) {
    if (!seconds) return '';
    let s = Math.floor(seconds);
    if (s >= 3600) {
      return `${Math.floor(s/3600)}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
    }
    return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  }

  #formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      let d = new Date(dateStr);
      if (isNaN(d)) return dateStr;
      return d.toLocaleString(undefined, {
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit'
      });
    } catch { return dateStr; }
  }
}

window.customElements.define('pl-item-info', PlItemInfo);
