// Server intake screen (Capacitor app only). Shown on first launch when no
// server URL is stored. Collects the Photo-Loka server base URL, validates it
// by hitting the public /health endpoint, and on success emits
// 'pl-server-configured' with { url } for mobile-boot.mjs to persist and boot.
//
// This screen runs BEFORE the main app loads, so it deliberately uses native
// <input>/<button> rather than Shoelace (sl-*) components: Shoelace is only
// registered by main.mjs, which has not loaded yet, and an unregistered custom
// element renders as nothing (also hidden by :not(:defined) in index.html).
// Native controls always render and need no CDN, which also makes this first
// screen work before any network is available. Kept under mobile/ (never
// imported by the browser build).

class PlServerSetup extends HTMLElement {
  static template = document.createElement('template');
  static {
    this.template.innerHTML = /* html */ `
      <style>
        :host {
          display: grid;
          place-items: center;
          width: 100%;
          height: 100%;
          background: #f4f4f5;
          font-family: Lato, -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
        }
        .card {
          width: min(92vw, 420px);
          padding: 2rem 1.5rem;
          border-radius: 12px;
          background: #fff;
          box-shadow: 0 2px 16px rgba(0,0,0,0.12);
          text-align: center;
          box-sizing: border-box;
        }
        .logo { width: 96px; height: 96px; object-fit: contain; }
        h1 { font-size: 1.4rem; margin: 0.5rem 0 0.25rem; color: #18181b; }
        .tagline { margin: 0 0 1.25rem; color: #52525b; font-size: 0.9rem; }
        form { display: grid; gap: 0.75rem; text-align: left; }
        label { font-size: 0.85rem; color: #3f3f46; font-weight: 600; }
        input {
          width: 100%;
          box-sizing: border-box;
          padding: 0.65rem 0.75rem;
          font-size: 1rem;
          border: 1px solid #d4d4d8;
          border-radius: 8px;
          outline: none;
        }
        input:focus { border-color: #66b3ff; box-shadow: 0 0 0 3px rgba(102,179,255,0.25); }
        .hint { color: #71717a; font-size: 0.8rem; }
        .error { color: #c0392b; font-size: 0.85rem; min-height: 1.1em; }
        button {
          margin-top: 0.25rem;
          padding: 0.75rem 1rem;
          font-size: 1rem;
          font-weight: 600;
          color: #fff;
          background: #66b3ff;
          border: none;
          border-radius: 8px;
          cursor: pointer;
        }
        button:disabled { opacity: 0.6; cursor: default; }
      </style>
      <div class="card">
        <img class="logo" src="assets/icon-454.png" alt="Photo-Loka">
        <h1>Connect to your server</h1>
        <p class="tagline">Enter the address of your Photo-Loka server</p>
        <form id="setup-form" novalidate>
          <label for="server-url">Server URL</label>
          <input
            id="server-url"
            name="serverUrl"
            type="url"
            inputmode="url"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            placeholder="http://192.168.1.50:9000"
          >
          <div class="hint">Example: http://192.168.1.50:9000</div>
          <div id="error-message" class="error"></div>
          <button id="connect-btn" type="submit">Connect</button>
        </form>
      </div>
    `;
  }

  constructor() {
    super().attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
    this.#attach();
    requestAnimationFrame(() => this.shadowRoot.getElementById('server-url').focus());
  }

  #normalize(url) {
    const u = url.trim();
    return u.endsWith('/') ? u.slice(0, -1) : u;
  }

  // Validate by GET {base}/health (public, unauthenticated). A 2xx confirms the
  // URL is reachable and is a Photo-Loka server before we store it.
  async #validate(base) {
    const res = await fetch(`${base}/health`, { method: 'GET' });
    if (!res.ok) throw new Error(`Server responded with ${res.status}`);
  }

  #attach() {
    const form = this.shadowRoot.getElementById('setup-form');
    const btn = this.shadowRoot.getElementById('connect-btn');
    const errorDiv = this.shadowRoot.getElementById('error-message');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = this.shadowRoot.getElementById('server-url').value;
      errorDiv.textContent = '';

      const base = this.#normalize(raw);
      if (!/^https?:\/\/.+/i.test(base)) {
        errorDiv.textContent = 'Enter a full URL starting with http:// or https://';
        return;
      }

      btn.disabled = true;
      const prevLabel = btn.textContent;
      btn.textContent = 'Connecting...';
      try {
        await this.#validate(base);
        this.dispatchEvent(new CustomEvent('pl-server-configured', {
          detail: { url: base },
          bubbles: true,
          composed: true,
        }));
      } catch (err) {
        errorDiv.textContent = `Could not reach server: ${err.message}`;
      } finally {
        btn.disabled = false;
        btn.textContent = prevLabel;
      }
    });
  }
}

customElements.define('pl-server-setup', PlServerSetup);
