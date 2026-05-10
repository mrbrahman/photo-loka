import { notify } from '../utils.mjs';
import { getJobs, setIntakeStatus } from '../api/admin-api.mjs';
import { cronToHuman } from '../cron-utils.mjs';

import sheet from "./styles/pl-admin-jobs.css" with { type: "css" };

class PlAdminJobs extends HTMLElement {

  #data = null;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <div class="container">
        <div class="header">
          <h2>Jobs</h2>
          <sl-icon-button id="refresh-btn" name="arrow-clockwise" label="Refresh"></sl-icon-button>
        </div>

        <div id="content">
          <div class="loading">Loading jobs...</div>
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
    this.shadowRoot.getElementById('refresh-btn').addEventListener('click', () => this.#loadJobs());
    this.#loadJobs();
  }

  async #loadJobs() {
    try {
      this.#data = await getJobs();
      this.#render();
    } catch (err) {
      this.shadowRoot.getElementById('content').innerHTML =
        '<div class="error">Failed to load jobs</div>';
      console.error(err);
    }
  }

  #render() {
    const content = this.shadowRoot.getElementById('content');
    content.innerHTML = '';

    content.innerHTML += this.#renderWatchers();
    content.innerHTML += this.#renderScheduled();
    content.innerHTML += this.#renderFrame();
    content.innerHTML += this.#renderSystem();

    this.#attachListeners();
  }

  #renderWatchers() {
    const watchers = this.#data.watchers;
    let html = `
      <div class="section">
        <h3 class="section-title">
          Watchers
          <sl-badge variant="neutral" pill>${watchers.length}</sl-badge>
        </h3>
    `;

    if (watchers.length === 0) {
      html += '<div class="empty-state">No watchers configured</div>';
    } else {
      html += `
        <table class="job-table">
          <thead>
            <tr>
              <th>Collection</th>
              <th>Path</th>
              <th class="col-status">Status</th>
              <th class="col-action"></th>
            </tr>
          </thead>
          <tbody>
      `;
      for (const w of watchers) {
        const isActive = w.status === 'active';
        const icon = isActive ? 'pause-circle' : 'play-circle';
        const badgeVariant = isActive ? 'success' : 'neutral';
        html += `
          <tr>
            <td>${w.collection_name}</td>
            <td class="path-cell">${w.intake_path}</td>
            <td class="col-status"><sl-badge variant="${badgeVariant}" pill>${w.status}</sl-badge></td>
            <td class="col-action">
              <sl-icon-button
                name="${icon}"
                class="watcher-toggle-btn"
                data-collection-id="${w.collection_id}"
                data-intake-index="${w.intake_index}"
                data-status="${w.status}"
                label="${isActive ? 'Stop' : 'Start'} watcher"
              ></sl-icon-button>
            </td>
          </tr>
        `;
      }
      html += '</tbody></table>';
    }

    html += '</div>';
    return html;
  }

  #renderScheduled() {
    const scheduled = this.#data.scheduled;
    let html = `
      <div class="section">
        <h3 class="section-title">
          Scheduled Indexing
          <sl-badge variant="neutral" pill>${scheduled.length}</sl-badge>
        </h3>
    `;

    if (scheduled.length === 0) {
      html += '<div class="empty-state">No scheduled indexing jobs configured</div>';
    } else {
      html += `
        <table class="job-table">
          <thead>
            <tr>
              <th>Collection</th>
              <th>Path</th>
              <th>Schedule</th>
              <th class="col-status">Status</th>
              <th class="col-action"></th>
            </tr>
          </thead>
          <tbody>
      `;
      for (const j of scheduled) {
        const human = cronToHuman(j.pattern);
        const isActive = j.status === 'active';
        const icon = isActive ? 'pause-circle' : 'play-circle';
        const badgeVariant = isActive ? 'success' : 'neutral';
        html += `
          <tr>
            <td>${j.collection_name}</td>
            <td class="path-cell">${j.intake_path}</td>
            <td class="schedule-cell">
              ${j.pattern}
              ${human ? `<span class="cron-human">${human}</span>` : ''}
            </td>
            <td class="col-status"><sl-badge variant="${badgeVariant}" pill>${j.status}</sl-badge></td>
            <td class="col-action">
              <sl-icon-button
                name="${icon}"
                class="scheduled-toggle-btn"
                data-collection-id="${j.collection_id}"
                data-intake-index="${j.intake_index}"
                data-status="${j.status}"
                label="${isActive ? 'Stop' : 'Start'} scheduled job"
              ></sl-icon-button>
            </td>
          </tr>
        `;
      }
      html += '</tbody></table>';
    }

    html += '</div>';
    return html;
  }

  #renderFrame() {
    const frameJobs = this.#data.frame;
    let html = `
      <div class="section">
        <h3 class="section-title">
          Frames
          <sl-badge variant="neutral" pill>${frameJobs.length}</sl-badge>
        </h3>
    `;

    if (frameJobs.length === 0) {
      html += '<div class="empty-state">No frame jobs</div>';
    } else {
      html += `
        <table class="job-table">
          <thead>
            <tr>
              <th>Frame</th>
              <th>Type</th>
              <th>Schedule</th>
            </tr>
          </thead>
          <tbody>
      `;
      for (const j of frameJobs) {
        const human = cronToHuman(j.pattern);
        html += `
          <tr>
            <td>${j.frame_name}</td>
            <td>${j.type}</td>
            <td class="schedule-cell">
              ${j.pattern}
              ${human ? `<span class="cron-human">${human}</span>` : ''}
            </td>
          </tr>
        `;
      }
      html += '</tbody></table>';
    }

    html += '</div>';
    return html;
  }

  #renderSystem() {
    const systemJobs = this.#data.system;
    let html = `
      <div class="section">
        <h3 class="section-title">
          System
          <sl-badge variant="neutral" pill>${systemJobs.length}</sl-badge>
        </h3>
    `;

    if (systemJobs.length === 0) {
      html += '<div class="empty-state">No system jobs</div>';
    } else {
      html += `
        <table class="job-table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Schedule</th>
            </tr>
          </thead>
          <tbody>
      `;
      for (const j of systemJobs) {
        const human = cronToHuman(j.pattern);
        html += `
          <tr>
            <td>${j.name}</td>
            <td class="schedule-cell">
              ${j.pattern}
              ${human ? `<span class="cron-human">${human}</span>` : ''}
            </td>
          </tr>
        `;
      }
      html += '</tbody></table>';
    }

    html += '</div>';
    return html;
  }

  #attachListeners() {
    this.shadowRoot.querySelectorAll('.watcher-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => this.#toggleIntake(btn, 'Watcher'));
    });

    this.shadowRoot.querySelectorAll('.scheduled-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => this.#toggleIntake(btn, 'Scheduled job'));
    });
  }

  async #toggleIntake(btn, label) {
    const collectionId = parseInt(btn.dataset.collectionId);
    const intakeIndex = parseInt(btn.dataset.intakeIndex);
    const currentStatus = btn.dataset.status;
    const newStatus = currentStatus === 'active' ? 'stopped' : 'active';

    try {
      await this.#setIntakeStatus(collectionId, intakeIndex, newStatus);
      notify(`${label} ${newStatus === 'active' ? 'started' : 'stopped'}`, 'success');
      await this.#loadJobs();
    } catch (err) {
      notify(`Failed to update ${label.toLowerCase()}`, 'danger');
      console.error(err);
    }
  }

  async #setIntakeStatus(collectionId, intakeIndex, status) {
    await setIntakeStatus(collectionId, intakeIndex, status);
  }
}

customElements.define('pl-admin-jobs', PlAdminJobs);
