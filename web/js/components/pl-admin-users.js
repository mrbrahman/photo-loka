import { notify } from '../utils.mjs';
import { authenticatedFetch } from '../authn.mjs';

import sheet from "./styles/pl-admin-users.css" with { type: "css" };

class PlAdminUsers extends HTMLElement {

  #users = [];
  #pendingTokenUserId = null;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
      `
      <div class="container">
        <div class="header">
          <h2>Users</h2>
          <div class="header-actions">
            <sl-icon-button id="add-btn" name="person-plus" label="Add user"></sl-icon-button>
            <sl-icon-button id="refresh-btn" name="arrow-clockwise" label="Refresh"></sl-icon-button>
          </div>
        </div>

        <div id="content">
          <div class="loading">Loading users...</div>
        </div>

        <!-- Create User Dialog -->
        <sl-dialog id="create-dialog" label="Create User">
          <div class="create-form">
            <sl-input id="new-username" label="Username" required></sl-input>
            <sl-select id="new-role" label="Role" value="user">
              <sl-option value="user">User</sl-option>
              <sl-option value="admin">Admin</sl-option>
            </sl-select>
            <sl-input id="new-password" label="Password" type="password"
              minlength="8" required help-text="Minimum 8 characters"
              class="full-width"></sl-input>
          </div>
          <sl-button slot="footer" id="create-cancel-btn" variant="default">Cancel</sl-button>
          <sl-button slot="footer" id="create-submit-btn" variant="primary">Create</sl-button>
        </sl-dialog>

        <!-- Token Dialog -->
        <sl-dialog id="token-dialog" label="API Token Generated">
          <p>Copy this token now. It will not be shown again.</p>
          <div class="token-display">
            <div class="token-value" id="token-value"></div>
            <div class="token-actions">
              <sl-button id="copy-token-btn" variant="primary" size="small">
                <sl-icon slot="prefix" name="clipboard"></sl-icon>
                Copy
              </sl-button>
            </div>
          </div>
          <sl-button slot="footer" id="token-close-btn" variant="default">Close</sl-button>
        </sl-dialog>

        <!-- Token Expiry Dialog -->
        <sl-dialog id="token-expiry-dialog" label="Generate API Token">
          <sl-input id="token-days" label="Expires in (days)" type="number"
            value="365" min="1" max="3650"></sl-input>
          <sl-button slot="footer" id="token-expiry-cancel-btn" variant="default">Cancel</sl-button>
          <sl-button slot="footer" id="token-expiry-submit-btn" variant="primary">Generate</sl-button>
        </sl-dialog>
      </div>
    `;
  }

  constructor() {
    super().attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
    this.#setupEventListeners();
    this.#loadUsers();
  }

  #setupEventListeners() {
    this.shadowRoot.getElementById('refresh-btn').addEventListener('click', () => this.#loadUsers());
    this.shadowRoot.getElementById('add-btn').addEventListener('click', () => this.#showCreateDialog());
    this.shadowRoot.getElementById('create-cancel-btn').addEventListener('click', () => this.#hideCreateDialog());
    this.shadowRoot.getElementById('create-submit-btn').addEventListener('click', () => this.#createUser());
    this.shadowRoot.getElementById('copy-token-btn').addEventListener('click', () => this.#copyToken());
    this.shadowRoot.getElementById('token-close-btn').addEventListener('click', () => {
      this.shadowRoot.getElementById('token-dialog').hide();
    });
    this.shadowRoot.getElementById('token-expiry-cancel-btn').addEventListener('click', () => {
      this.shadowRoot.getElementById('token-expiry-dialog').hide();
    });
    this.shadowRoot.getElementById('token-expiry-submit-btn').addEventListener('click', () => this.#generateToken());
  }

  async #loadUsers() {
    try {
      const res = await authenticatedFetch('/api/admin/users');
      if (!res.ok) throw new Error('Failed to load users');
      const data = await res.json();
      this.#users = data.users;
      this.#render();
    } catch (err) {
      this.shadowRoot.getElementById('content').innerHTML =
        '<div class="error">Failed to load users</div>';
      console.error(err);
    }
  }

  #render() {
    const content = this.shadowRoot.getElementById('content');

    if (this.#users.length === 0) {
      content.innerHTML = '<div class="empty-state">No users found</div>';
      return;
    }

    let html = `
      <table class="user-table">
        <thead>
          <tr>
            <th>Username</th>
            <th class="col-role">Role</th>
            <th class="col-status">Status</th>
            <th>Created</th>
            <th class="col-actions"></th>
          </tr>
        </thead>
        <tbody>
    `;

    for (const user of this.#users) {
      const isLocked = !!user.locked_at;
      const statusBadge = isLocked
        ? '<sl-badge variant="danger" pill>locked</sl-badge>'
        : '<sl-badge variant="success" pill>active</sl-badge>';

      const created = user.created_at
        ? new Date(user.created_at).toLocaleString()
        : '-';

      html += `
        <tr>
          <td>${user.username}</td>
          <td class="col-role"><sl-badge variant="${user.role === 'admin' ? 'primary' : 'neutral'}" pill>${user.role}</sl-badge></td>
          <td class="col-status">${statusBadge}</td>
          <td class="created-cell">${created}</td>
          <td class="col-actions">
            ${isLocked ? `<sl-icon-button name="unlock" title="Unlock account" label="Unlock" class="unlock-btn" data-user-id="${user.user_id}"></sl-icon-button>` : ''}
            <sl-icon-button name="person-gear" title="Toggle role (${user.role === 'admin' ? 'admin -> user' : 'user -> admin'})" label="Change role" class="role-btn" data-user-id="${user.user_id}" data-current-role="${user.role}"></sl-icon-button>
            <sl-icon-button name="key" title="Generate API token" label="Generate token" class="token-btn" data-user-id="${user.user_id}"></sl-icon-button>
          </td>
        </tr>
      `;
    }

    html += '</tbody></table>';
    content.innerHTML = html;

    this.#attachTableListeners();
  }

  #attachTableListeners() {
    this.shadowRoot.querySelectorAll('.unlock-btn').forEach(btn => {
      btn.addEventListener('click', () => this.#unlockUser(parseInt(btn.dataset.userId, 10)));
    });

    this.shadowRoot.querySelectorAll('.role-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const userId = parseInt(btn.dataset.userId, 10);
        const currentRole = btn.dataset.currentRole;
        this.#changeRole(userId, currentRole);
      });
    });

    this.shadowRoot.querySelectorAll('.token-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.#pendingTokenUserId = parseInt(btn.dataset.userId, 10);
        this.shadowRoot.getElementById('token-days').value = '365';
        this.shadowRoot.getElementById('token-expiry-dialog').show();
      });
    });
  }

  // --- Actions ---

  #showCreateDialog() {
    const dialog = this.shadowRoot.getElementById('create-dialog');
    this.shadowRoot.getElementById('new-username').value = '';
    this.shadowRoot.getElementById('new-password').value = '';
    this.shadowRoot.getElementById('new-role').value = 'user';
    dialog.show();
  }

  #hideCreateDialog() {
    this.shadowRoot.getElementById('create-dialog').hide();
  }

  async #createUser() {
    const username = this.shadowRoot.getElementById('new-username').value.trim();
    const password = this.shadowRoot.getElementById('new-password').value;
    const role = this.shadowRoot.getElementById('new-role').value;

    if (!username || !password) {
      notify('Username and password are required', 'warning');
      return;
    }

    if (password.length < 8) {
      notify('Password must be at least 8 characters', 'warning');
      return;
    }

    const btn = this.shadowRoot.getElementById('create-submit-btn');
    btn.loading = true;

    try {
      const res = await authenticatedFetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Failed to create user');
      }

      notify(`User "${username}" created`, 'success');
      this.#hideCreateDialog();
      await this.#loadUsers();
    } catch (err) {
      notify(err.message, 'danger');
    } finally {
      btn.loading = false;
    }
  }

  async #unlockUser(userId) {
    try {
      const res = await authenticatedFetch(`/api/admin/users/${userId}/unlock`, {
        method: 'POST'
      });
      if (!res.ok) throw new Error('Failed to unlock user');
      notify('User unlocked', 'success');
      await this.#loadUsers();
    } catch (err) {
      notify('Failed to unlock user', 'danger');
      console.error(err);
    }
  }

  async #changeRole(userId, currentRole) {
    const newRole = currentRole === 'admin' ? 'user' : 'admin';

    try {
      const res = await authenticatedFetch(`/api/admin/users/${userId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || 'Failed to change role');
      }

      notify(`Role changed to ${newRole}`, 'success');
      await this.#loadUsers();
    } catch (err) {
      notify(err.message, 'danger');
      console.error(err);
    }
  }

  async #generateToken() {
    const days = parseInt(this.shadowRoot.getElementById('token-days').value, 10);
    if (isNaN(days) || days <= 0) {
      notify('Enter a valid number of days', 'warning');
      return;
    }

    const btn = this.shadowRoot.getElementById('token-expiry-submit-btn');
    btn.loading = true;

    try {
      const res = await authenticatedFetch(`/api/admin/users/${this.#pendingTokenUserId}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresInDays: days })
      });

      if (!res.ok) throw new Error('Failed to generate token');

      const data = await res.json();
      this.shadowRoot.getElementById('token-expiry-dialog').hide();
      this.shadowRoot.getElementById('token-value').textContent = data.token;
      this.shadowRoot.getElementById('token-dialog').show();
    } catch (err) {
      notify('Failed to generate token', 'danger');
      console.error(err);
    } finally {
      btn.loading = false;
    }
  }

  async #copyToken() {
    const token = this.shadowRoot.getElementById('token-value').textContent;
    try {
      await navigator.clipboard.writeText(token);
      notify('Token copied to clipboard', 'success');
    } catch (err) {
      notify('Failed to copy token', 'danger');
    }
  }
}

customElements.define('pl-admin-users', PlAdminUsers);
