import { login } from '../authn.mjs';

import sheet from "./styles/pl-login-page.css" with { type: "css" };


class PlLoginPage extends HTMLElement {

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <div class="login-container">
        <div class="login-card">
          <img src="assets/R3-resized.png" alt="Rewind Replay" class="logo">
          <h1>Rewind, Replay</h1>
          <p class="tagline">Relive your captured moments</p>
          
          <form id="login-form">
            <sl-input 
              id="username" 
              name="username" 
              label="Username" 
              placeholder="Enter username"
              required
            ></sl-input>
            
            <sl-input 
              id="password" 
              name="password" 
              type="password" 
              label="Password" 
              placeholder="Enter password"
              password-toggle
              required
            ></sl-input>
            
            <div id="error-message" class="error"></div>
            
            <sl-button id="login-btn" type="submit" variant="primary" size="large">
              Login
            </sl-button>
          </form>
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
    this.attachEventListeners();
  }

  attachEventListeners() {
    const form = this.shadowRoot.getElementById('login-form');
    const loginBtn = this.shadowRoot.getElementById('login-btn');
    const errorDiv = this.shadowRoot.getElementById('error-message');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const username = this.shadowRoot.getElementById('username').value;
      const password = this.shadowRoot.getElementById('password').value;

      errorDiv.textContent = '';
      loginBtn.loading = true;

      try {
        await login(username, password);
        
        // Check for redirect parameter
        const params = new URLSearchParams(window.location.hash.split('?')[1]);
        const goto = params.get('goto') || '/app';
        
        // Use window.location.hash instead of router.navigate to force a clean navigation
        window.location.hash = goto;
      } catch (error) {
        errorDiv.textContent = error.message;
      } finally {
        loginBtn.loading = false;
      }
    });
  }
}

customElements.define('pl-login-page', PlLoginPage);
