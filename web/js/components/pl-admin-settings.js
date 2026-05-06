import { notify } from '../utils.mjs';
import { authenticatedFetch } from '../authn.mjs';

import sheet from "./styles/pl-admin-settings.css" with { type: "css" };

// Config field metadata: grouped sections with labels, types, and help text.
// Descriptions are taken from the server's runtime-config.mjs comments.
const CONFIG_SECTIONS = [
  {
    title: 'Startup Behavior',
    fields: [
      {
        key: 'startFileWatcherAtStartup',
        label: 'Start File Watcher at Startup',
        type: 'boolean',
        help: 'Start file watcher (immediate indexing) at startup.'
      },
      {
        key: 'scanFilesForChangesAndIndexAtStartup',
        label: 'Scan Files for Changes at Startup',
        type: 'boolean',
        help: 'Scan for file changes and index at startup.'
      }
    ]
  },
  {
    title: 'Indexing',
    fields: [
      {
        key: 'startScheduledIndexingAtStartup',
        label: 'Start Scheduled Indexing at Startup',
        type: 'boolean',
        help: 'Start scheduled (cron) indexing at startup.'
      },
      {
        key: 'staleDays',
        label: 'Stale Days',
        type: 'number',
        help: 'Number of days a file must be stale before intake indexing.'
      },
      {
        key: 'maxConcurrency',
        label: 'Max Concurrency',
        type: 'number',
        help: 'Max parallel indexing tasks. Changes via this page only persist the value -- takes effect on next restart. Use the indexer control to change concurrency immediately at runtime.'
      },
      {
        key: 'filesDeletedThreshold',
        label: 'Files Deleted Threshold',
        type: 'number',
        help: 'Threshold for number of deleted files before alerting.'
      }
    ]
  },
  {
    title: 'Media Processing',
    fields: [
      {
        key: 'performFaceRecognition',
        label: 'Perform Face Recognition',
        type: 'boolean',
        help: 'Run face recognition during indexing.'
      },
      {
        key: 'performVideoCompression',
        label: 'Perform Video Compression',
        type: 'boolean',
        help: 'Compress videos during indexing.'
      },
      {
        key: 'videoEncoder',
        label: 'Video Encoder',
        type: 'select',
        help: 'Video encoder for compression. Container is auto-determined: webm for VP8/VP9, mp4 for H.264/H.265/AV1.',
        options: [
          { value: 'libvpx', label: 'VP8 (libvpx) - Software' },
          { value: 'libvpx-vp9', label: 'VP9 (libvpx-vp9) - Software' },
          { value: 'h264_nvenc', label: 'H.264 (h264_nvenc) - NVIDIA' },
          { value: 'h264_qsv', label: 'H.264 (h264_qsv) - Intel' },
          { value: 'h264_amf', label: 'H.264 (h264_amf) - AMD' },
          { value: 'hevc_nvenc', label: 'H.265/HEVC (hevc_nvenc) - NVIDIA' },
          { value: 'hevc_qsv', label: 'H.265/HEVC (hevc_qsv) - Intel' },
          { value: 'hevc_amf', label: 'H.265/HEVC (hevc_amf) - AMD' },
          { value: 'libaom-av1', label: 'AV1 (libaom-av1) - Software' },
          { value: 'av1_nvenc', label: 'AV1 (av1_nvenc) - NVIDIA RTX40+' },
          { value: 'av1_qsv', label: 'AV1 (av1_qsv) - Intel Arc' }
        ]
      }
    ]
  },
  {
    title: 'Geonames API',
    fields: [
      {
        key: 'geonamesHourlyLimit',
        label: 'Hourly Limit',
        type: 'number',
        help: 'Geonames API hourly request limit.'
      },
      {
        key: 'geonamesDailyLimit',
        label: 'Daily Limit',
        type: 'number',
        help: 'Geonames API daily request limit.'
      }
    ]
  },
  {
    title: 'File Operations',
    fields: [
      {
        key: 'auditFiles',
        label: 'Audit File Operations',
        type: 'boolean',
        help: 'Audit file operations for backup sync. Helps if changes (e.g. rename folders, move files) need to be synced to multiple hard drives.'
      }
    ]
  }
];


class PlAdminSettings extends HTMLElement {

  #config = {};

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <div class="container">
        <h2>Settings</h2>
        <div id="settings-content">
          <div class="loading">Loading configuration...</div>
        </div>
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
    this.#loadConfig();
  }

  async #loadConfig() {
    try {
      const res = await authenticatedFetch('/api/admin/getConfig');
      if (!res.ok) throw new Error('Failed to load config');
      this.#config = await res.json();
      this.#render();
    } catch (err) {
      const content = this.shadowRoot.getElementById('settings-content');
      content.innerHTML = '<div class="error">Failed to load configuration.</div>';
      notify('Failed to load settings', 'danger');
      console.error(err);
    }
  }

  #render() {
    const content = this.shadowRoot.getElementById('settings-content');
    content.innerHTML = '';

    for (const section of CONFIG_SECTIONS) {
      const sectionEl = document.createElement('div');
      sectionEl.className = 'section';
      sectionEl.innerHTML = `<h3 class="section-title">${section.title}</h3>`;

      for (const field of section.fields) {
        const value = this.#config[field.key];
        const fieldEl = this.#createField(field, value);
        sectionEl.appendChild(fieldEl);
      }

      content.appendChild(sectionEl);
    }
  }

  #createField(field, value) {
    const wrapper = document.createElement('div');
    wrapper.className = 'field';

    if (field.type === 'boolean') {
      const sw = document.createElement('sl-switch');
      sw.checked = !!value;
      sw.textContent = field.label;
      sw.helpText = field.help;
      sw.addEventListener('sl-change', () => this.#saveField(field.key, sw.checked));
      wrapper.appendChild(sw);

    } else if (field.type === 'select') {
      const select = document.createElement('sl-select');
      select.label = field.label;
      select.helpText = field.help;
      select.size = 'small';
      select.value = value || '';
      for (const opt of field.options) {
        const option = document.createElement('sl-option');
        option.value = opt.value;
        option.textContent = opt.label;
        select.appendChild(option);
      }
      select.addEventListener('sl-change', () => this.#saveField(field.key, select.value));
      wrapper.appendChild(select);

    } else {
      // number
      const input = document.createElement('sl-input');
      input.type = 'number';
      input.label = field.label;
      input.helpText = field.help;
      input.size = 'small';
      input.value = value ?? '';
      input.addEventListener('sl-change', () => {
        const num = Number(input.value);
        if (!isNaN(num)) this.#saveField(field.key, num);
      });
      wrapper.appendChild(input);
    }

    return wrapper;
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
