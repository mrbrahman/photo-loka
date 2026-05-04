import sheet from "./styles/pl-admin-settings.css" with { type: "css" };

class PlAdminSettings extends HTMLElement {

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <div class="container">
        <h2>Settings</h2>
        <p class="placeholder">Administration settings - TBD</p>
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
  }
}

customElements.define('pl-admin-settings', PlAdminSettings);
