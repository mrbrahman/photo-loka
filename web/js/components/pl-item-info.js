import {notify} from '../utils.mjs';
import { getItemInfo, renameFile, updateDescription } from '../api/media-api.mjs';

import sheet from "./styles/pl-item-info.css" with { type: "css" };
import leafletSheet from "leaflet-css" with { type: "css" };

class PlItemInfo extends HTMLElement {
  #uuid; #data; #map; #originalDesc; #originalStem; #ext;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <div id="panel">
        <div id="header">
          <span>Info</span>
          <sl-icon-button id="close" name="x-lg"></sl-icon-button>
        </div>
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
                <div id="also-detected" hidden>
                  <div class="sub-header">Also detected</div>
                  <div id="unnamed-faces-list" class="faces-list"></div>
                </div>
              </div>
            </div>

            <!-- File -->
            <div class="info-row" id="file-row">
              <sl-icon id="file-icon" name="image-fill" class="row-icon"></sl-icon>
              <div class="row-content">
                <div class="filename-wrap row-header">
                  <span id="file-dir"></span><span id="filename" contenteditable spellcheck="false"></span><span id="file-ext"></span>
                </div>
                <div id="filename-status" class="field-status"></div>
                <div id="file-meta" class="row-detail"></div>
              </div>
            </div>

            <!-- Camera -->
            <div class="info-row" id="camera-row" hidden>
              <sl-icon name="camera-fill" class="row-icon"></sl-icon>
              <div class="row-content">
                <div id="camera-name" class="row-header"></div>
              </div>
            </div>

            <!-- Keywords -->
            <div class="info-row" id="keywords-row" hidden>
              <sl-icon name="tags-fill" class="row-icon"></sl-icon>
              <div class="row-content">
                <div id="keywords-list" class="keywords-list"></div>
              </div>
            </div>

            <!-- Location -->
            <div class="info-row" id="location-row" hidden>
              <sl-icon name="geo-alt-fill" class="row-icon"></sl-icon>
              <div class="row-content">
                <div id="geo-address" class="row-header"></div>
                <div id="map-container"></div>
              </div>
            </div>

            <!-- Dates -->
            <div class="info-row" id="dates-row">
              <sl-icon name="calendar3" class="row-icon"></sl-icon>
              <div class="row-content">
                <div id="date-header" class="row-header"></div>
                <div id="dates-list" class="dates-list row-detail"></div>
              </div>
            </div>

          </div>
        </div>
      </div>
    `;
  }

  constructor() {
    super().attachShadow({mode: 'open'});
    this.shadowRoot.adoptedStyleSheets = [sheet, leafletSheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    this.shadowRoot.getElementById('close').addEventListener('click', () => {
      this.dispatchEvent(new Event('pl-info-panel-closed', {composed: true, bubbles: true}));
    });

    // Stop keyboard events from reaching slideshow (e.g. arrow keys while
    // typing in description/filename). With CloseWatcher handling Escape,
    // we can stop all keys including Escape here.
    this.addEventListener('keydown', (e) => e.stopPropagation());

    // Filename save on blur / enter
    let fnInput = this.shadowRoot.getElementById('filename');
    // Since the element is always contenteditable, clicking it causes the browser to
    // both fire focus and place cursor at click position. rAF defers our cursor placement
    // to after the browser finishes processing the click
    fnInput.addEventListener('focus', () => {
      requestAnimationFrame(() => {
        let sel = window.getSelection();
        sel.selectAllChildren(fnInput);
        sel.collapseToEnd();
      });
    });
    fnInput.addEventListener('blur', () => this.#saveFilename());
    fnInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); fnInput.blur(); } });

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
      this.#data = await getItemInfo(this.#uuid);
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
    this.shadowRoot.getElementById('filename').innerText = this.#originalStem;
    this.shadowRoot.getElementById('file-ext').textContent = this.#ext;

    // Description
    this.#originalDesc = (d.description?.trim() && d.description.trim() !== 'null') ? d.description.trim() : '';
    this.shadowRoot.getElementById('description').value = this.#originalDesc;

    // Camera
    let cameraRow = this.shadowRoot.getElementById('camera-row');
    if (d.make || d.model) {
      cameraRow.hidden = false;
      this.shadowRoot.getElementById('camera-name').textContent = [d.make, d.model].filter(Boolean).join(' ');
    } else {
      cameraRow.hidden = true;
    }

    // File info
    let fileParts = [];
    if (d.mediatype) fileParts.push(d.mediatype);
    if (d.ext) fileParts.push(d.ext.toUpperCase());
    if (d.filesize) fileParts.push(this.#formatFileSize(d.filesize));
    if (d.image_width && d.image_height) fileParts.push(`${d.image_width} x ${d.image_height}`);
    if (d.duration) fileParts.push(this.#formatDuration(d.duration));
    this.shadowRoot.getElementById('file-meta').textContent = fileParts.join('  •  ');

    // File icon based on media type
    let fileIcon = this.shadowRoot.getElementById('file-icon');
    if (d.mediatype?.startsWith('video')) fileIcon.name = 'film';
    else if (d.mediatype?.startsWith('audio')) fileIcon.name = 'music-note-beamed';
    else fileIcon.name = 'image-fill';

    // Dates
    this.shadowRoot.getElementById('date-header').textContent = d.captured_at ? this.#formatDate(d.captured_at) : '';

    let datesList = this.shadowRoot.getElementById('dates-list');
    datesList.innerHTML = '';
    let allDates = [
      ['Indexed', d.indexed_at],
      ['File Modified', d.file_modified_at],
      ['Trashed', d.trashed_at],
    ].filter(([, v]) => v);

    for (let i = 0; i < allDates.length; i++) {
      if (i === 1 && allDates[0][0] === 'Indexed') {
        let spacer = document.createElement('div');
        spacer.style.height = '6px';
        datesList.appendChild(spacer);
      }
      let row = document.createElement('div');
      row.className = allDates[i][0] === 'Indexed' ? 'date-row' : 'date-row date-row-minor';
      row.innerHTML = `<span class="date-label">${allDates[i][0]}</span><span class="date-value">${this.#formatDate(allDates[i][1])}</span>`;
      datesList.appendChild(row);
    }

    // Location
    let locSection = this.shadowRoot.getElementById('location-row');
    if (d.gps_lat && d.gps_lng) {
      locSection.hidden = false;
      let addrEl = this.shadowRoot.getElementById('geo-address');
      addrEl.textContent = d.geo_address || `${d.gps_lat.toFixed(4)}, ${d.gps_lng.toFixed(4)}`;

      let mapDiv = this.shadowRoot.getElementById('map-container');
      requestAnimationFrame(() => {
        if (!mapDiv.isConnected) return;
        this.#map = L.map(mapDiv, { zoomControl: false, attributionControl: false })
          .setView([d.gps_lat, d.gps_lng], 16);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(this.#map);
        L.marker([d.gps_lat, d.gps_lng]).addTo(this.#map);
        setTimeout(() => this.#map?.invalidateSize(), 100);
      });
    } else {
      locSection.hidden = true;
    }

    // People
    let peopleSection = this.shadowRoot.getElementById('people-row');
    let facesList = this.shadowRoot.getElementById('faces-list');
    let unnamedList = this.shadowRoot.getElementById('unnamed-faces-list');
    let alsoDetected = this.shadowRoot.getElementById('also-detected');
    facesList.innerHTML = '';
    unnamedList.innerHTML = '';

    let faceDetails = this.#parseFaceDetails(d.face_details);
    let namedFaces = faceDetails.filter(f => f.person_name);
    let unnamedFaces = faceDetails.filter(f => !f.person_name);

    if (faceDetails.length > 0) {
      peopleSection.hidden = false;
      for (let face of namedFaces) {
        facesList.appendChild(this.#createFaceThumb(face));
      }
      if (unnamedFaces.length > 0) {
        alsoDetected.hidden = false;
        for (let face of unnamedFaces) {
          unnamedList.appendChild(this.#createFaceThumb(face));
        }
      } else {
        alsoDetected.hidden = true;
      }
    } else {
      peopleSection.hidden = true;
      alsoDetected.hidden = true;
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
    let newStem = input.innerText.trim();
    if (!newStem || newStem === this.#originalStem) {
      input.innerText = this.#originalStem;
      return;
    }

    let newBasename = newStem + this.#ext;
    status.textContent = 'Saving...';
    status.className = 'field-status saving';

    try {
      await renameFile(1, this.#uuid, newBasename);

      this.#originalStem = newStem;
      status.textContent = 'Saved';
      status.className = 'field-status saved';
      setTimeout(() => { if (status.isConnected) { status.textContent = ''; status.className = 'field-status'; } }, 2000);

    } catch (err) {
      input.innerText = this.#originalStem;
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
      await updateDescription(this.#uuid, newDesc);

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

  #parseFaceDetails(faceDetails) {
    try {
      let parsed = typeof faceDetails === 'string' ? JSON.parse(faceDetails) : faceDetails;
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].cluster_id) return parsed;
    } catch {}
    return [];
  }

  #createFaceThumb(face) {
    let el = document.createElement('pl-face-thumb');
    el.setAttribute('uuid', this.#uuid);
    el.setAttribute('cluster-id', face.cluster_id);
    el.setAttribute('face-idx', face.face_idx);
    if (face.person_name) el.setAttribute('person-name', face.person_name);
    el.addEventListener('pl-face-named', () => {
      // Move from unnamed to named list
      this.shadowRoot.getElementById('faces-list').appendChild(el);
      let unnamedList = this.shadowRoot.getElementById('unnamed-faces-list');
      if (unnamedList.children.length === 0) {
        this.shadowRoot.getElementById('also-detected').hidden = true;
      }
    });
    el.addEventListener('pl-face-dismissed', () => {
      el.remove();
      let unnamedList = this.shadowRoot.getElementById('unnamed-faces-list');
      if (unnamedList.children.length === 0) {
        this.shadowRoot.getElementById('also-detected').hidden = true;
      }
      // Hide entire people section if no faces left
      let facesList = this.shadowRoot.getElementById('faces-list');
      if (facesList.children.length === 0 && unnamedList.children.length === 0) {
        this.shadowRoot.getElementById('people-row').hidden = true;
      }
    });
    return el;
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
      let m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})([+-]\d{2}:\d{2})?/);
      if (!m) return dateStr;

      let d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
      if (isNaN(d)) return dateStr;

      let formatted = d.toLocaleString(undefined, {
        timeZone: 'UTC',
        weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit'
      });

      if (m[7]) formatted += ` (GMT${m[7]})`;
      return formatted;
    } catch { return dateStr; }
  }
}

window.customElements.define('pl-item-info', PlItemInfo);
