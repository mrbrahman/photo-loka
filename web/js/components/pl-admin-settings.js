import { notify } from '../utils.mjs';
import { authenticatedFetch } from '../authn.mjs';

import sheet from "./styles/pl-admin-settings.css" with { type: "css" };

class PlAdminSettings extends HTMLElement {

  #config = {};

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <div class="container">
        <h2>Settings</h2>
        <div id="settings-content">

          <section>
            <h3 class="section-title">Startup Behavior</h3>
            <div class="field">
              <sl-switch data-key="startFileWatcherAtStartup" help-text="Start file watcher (immediate indexing) at startup.">Start File Watcher at Startup</sl-switch>
            </div>
            <div class="field">
              <sl-switch data-key="scanFilesForChangesAndIndexAtStartup" help-text="Scan for file changes and index at startup.">Scan Files for Changes at Startup</sl-switch>
            </div>
          </section>

          <section>
            <h3 class="section-title">Indexing</h3>
            <div class="field">
              <sl-switch data-key="startScheduledIndexingAtStartup" help-text="Start scheduled (cron) indexing at startup.">Start Scheduled Indexing at Startup</sl-switch>
            </div>
            <div class="field">
              <sl-input data-key="staleDays" type="number" label="Stale Days" help-text="Number of days a file must be stale before intake indexing." size="small"></sl-input>
            </div>
            <div class="field">
              <sl-input data-key="maxConcurrency" type="number" label="Max Concurrency" help-text="Max parallel indexing tasks. Changes via this page only persist the value -- takes effect on next restart." size="small"></sl-input>
            </div>
            <div class="field">
              <sl-input data-key="filesDeletedThreshold" type="number" label="Files Deleted Threshold" help-text="Threshold for number of deleted files before alerting." size="small"></sl-input>
            </div>
          </section>

          <section>
            <h3 class="section-title">Media Processing</h3>
            <div class="field">
              <sl-switch data-key="performFaceRecognition" help-text="Run face recognition during indexing.">Perform Face Recognition</sl-switch>
            </div>
            <div class="field">
              <sl-switch data-key="performVideoCompression" help-text="Compress videos during indexing.">Perform Video Compression</sl-switch>
            </div>
            <div class="field">
              <sl-select data-key="videoEncoder" label="Video Encoder" help-text="Video encoder for compression. Container is auto-determined: webm for VP8/VP9, mp4 for H.264/H.265/AV1." size="small">
                <sl-option value="libvpx">VP8 (libvpx) - Software</sl-option>
                <sl-option value="libvpx-vp9">VP9 (libvpx-vp9) - Software</sl-option>
                <sl-option value="h264_nvenc">H.264 (h264_nvenc) - NVIDIA</sl-option>
                <sl-option value="h264_qsv">H.264 (h264_qsv) - Intel</sl-option>
                <sl-option value="h264_amf">H.264 (h264_amf) - AMD</sl-option>
                <sl-option value="hevc_nvenc">H.265/HEVC (hevc_nvenc) - NVIDIA</sl-option>
                <sl-option value="hevc_qsv">H.265/HEVC (hevc_qsv) - Intel</sl-option>
                <sl-option value="hevc_amf">H.265/HEVC (hevc_amf) - AMD</sl-option>
                <sl-option value="libaom-av1">AV1 (libaom-av1) - Software</sl-option>
                <sl-option value="av1_nvenc">AV1 (av1_nvenc) - NVIDIA RTX40+</sl-option>
                <sl-option value="av1_qsv">AV1 (av1_qsv) - Intel Arc</sl-option>
              </sl-select>
            </div>
          </section>

          <section>
            <h3 class="section-title">Geonames API</h3>
            <div class="field">
              <sl-input data-key="geonamesHourlyLimit" type="number" label="Hourly Limit" help-text="Geonames API hourly request limit." size="small"></sl-input>
            </div>
            <div class="field">
              <sl-input data-key="geonamesDailyLimit" type="number" label="Daily Limit" help-text="Geonames API daily request limit." size="small"></sl-input>
            </div>
          </section>

          <section>
            <h3 class="section-title">File Operations</h3>
            <div class="field">
              <sl-switch data-key="auditFiles" help-text="Audit file operations for backup sync. Helps if changes need to be synced to multiple hard drives.">Audit File Operations</sl-switch>
            </div>
          </section>

        </div>
      </div>
    `;
  }

  constructor() {
    super().attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
    this.#loadConfig();
  }

  async #loadConfig() {
    try {
      const res = await authenticatedFetch('/api/admin/getConfig');
      if (!res.ok) throw new Error('Failed to load config');
      this.#config = await res.json();
      this.#populateAndBind();
    } catch (err) {
      const content = this.shadowRoot.getElementById('settings-content');
      content.innerHTML = '<div class="error">Failed to load configuration.</div>';
      notify('Failed to load settings', 'danger');
      console.error(err);
    }
  }

  #populateAndBind() {
    const root = this.shadowRoot;

    for (const el of root.querySelectorAll('[data-key]')) {
      const key = el.dataset.key;
      const tag = el.tagName.toLowerCase();

      // Set initial value
      if (tag === 'sl-switch') {
        el.checked = !!this.#config[key];
      } else if (tag === 'sl-select') {
        el.value = this.#config[key] || '';
      } else if (tag === 'sl-input') {
        el.value = this.#config[key] ?? '';
      }

      // Attach save listener
      el.addEventListener('sl-change', () => {
        let value;
        if (tag === 'sl-switch') {
          value = el.checked;
        } else if (tag === 'sl-input' && el.type === 'number') {
          value = Number(el.value);
          if (isNaN(value)) return;
        } else {
          value = el.value;
        }
        this.#saveField(key, value);
      });
    }
  }

  async #saveField(key, value) {
    try {
      const res = await authenticatedFetch('/api/admin/updateConfig', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value })
      });
      if (!res.ok) throw new Error('Save failed');
      this.#config[key] = value;
      notify(`Updated ${key}`, 'success');
    } catch (err) {
      notify(`Failed to update ${key}`, 'danger');
      console.error(err);
    }
  }
}

customElements.define('pl-admin-settings', PlAdminSettings);
