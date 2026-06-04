import sheet from "./styles/pl-gallery-controls.css" with { type: "css" };

class PlGalleryControls extends HTMLElement {
  #ctr; #rating; #allPrivate = false; #mode = 'default'; #selectedAlbums = {}; #closeWatcher;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <div id="container">
        <div class="col" id="col1">
          <sl-icon-button name="x-lg" id="close"></sl-icon-button>
          <div id="ctr"></div>
        </div>
        
        <div class="col" id="col2">
          <sl-rating id="rating"></sl-rating>
          <sl-icon-button id="add-keywords" name="tags-fill" disabled>Keywords</sl-icon-button>
          <sl-icon-button id="private-btn" class="action-btn normal-action" name="lock-fill"></sl-icon-button>
          <sl-icon-button id="delete-btn" class="action-btn normal-action" name="trash-fill"></sl-icon-button>
          <sl-icon-button id="restore-btn" class="action-btn trash-action" name="arrow-counterclockwise"></sl-icon-button>
          <sl-icon-button id="cleanup-btn" class="action-btn trash-action" name="x-circle-fill"></sl-icon-button>
          <sl-icon-button id="organize" name="folder-plus">Organize</sl-icon-button>
          
          <sl-dropdown>
            <sl-icon-button name="three-dots-vertical" slot="trigger"></sl-icon-button>
            <sl-menu id="actions-menu" style="max-width: 200px;">
              <sl-menu-item id="private-menu" class="menu-action normal-action">
                <span id="private-label">Private</span>
                <sl-icon slot="suffix" id="private-menu-icon" name="lock-fill"></sl-icon>
              </sl-menu-item>
              <sl-menu-item id="delete-menu" class="menu-action normal-action">
                Delete
                <sl-icon slot="suffix" name="trash-fill"></sl-icon>
              </sl-menu-item>
              <sl-menu-item id="restore-menu" class="menu-action trash-action">
                Restore
                <sl-icon slot="suffix" name="arrow-counterclockwise"></sl-icon>
              </sl-menu-item>
              <sl-menu-item id="cleanup-menu" class="menu-action trash-action">
                Permanently Delete
                <sl-icon slot="suffix" name="x-circle-fill"></sl-icon>
              </sl-menu-item>
              <sl-divider class="menu-action"></sl-divider>
              <sl-menu-item disabled>
                Share
                <sl-icon slot="suffix" name="share-fill"></sl-icon>
              </sl-menu-item>            
              <sl-menu-item disabled>
                Update location
                <sl-icon slot="suffix" name="geo-alt-fill"></sl-icon>
              </sl-menu-item>
            </sl-menu>
          </sl-dropdown>
        </div>
      </div>

      <sl-dialog label="Create/Move-to New Album">
        <sl-input></sl-input>
        <sl-button id="save" slot="footer" variant="primary">Save</sl-button>
        <sl-button id="cancel" slot="footer" variant="primary">Cancel</sl-button>
      </sl-dialog>
    `;
  }

  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    this.shadowRoot.getElementById("close")
      .addEventListener('click', this.#handleClose)
    ;

    this.shadowRoot.getElementById("rating")
      .addEventListener('sl-change', this.#handleRatingChanged)
    ;

    this.shadowRoot.getElementById("private-btn")
      .addEventListener('click', this.#handlePrivateToggle)
    ;
    this.shadowRoot.getElementById("delete-btn")
      .addEventListener('click', this.#handleDelete)
    ;
    this.shadowRoot.getElementById("restore-btn")
      .addEventListener('click', this.#handleRestore)
    ;
    this.shadowRoot.getElementById("cleanup-btn")
      .addEventListener('click', this.#handleCleanup)
    ;
    this.shadowRoot.getElementById("actions-menu")
      .addEventListener('sl-select', this.#handleMenuSelect)
    ;

    this.#closeWatcher = new CloseWatcher();
    this.#closeWatcher.onclose = () => this.#handleClose();

    let dialog = this.shadowRoot.querySelector('sl-dialog')
      , cancelButton = dialog.querySelector('#cancel')
      , saveButton = dialog.querySelector('#save')
      , inp = dialog.querySelector('sl-input');

    cancelButton.addEventListener('click', ()=>{
      dialog.hide();
    });
    saveButton.addEventListener('click', (evt)=>{
      this.dispatchEvent(new CustomEvent('pl-gallery-controls-dialog-save', {detail: inp.value}));
      dialog.hide();
    });

    this.shadowRoot.getElementById("organize")
    .addEventListener('click', ()=>{
      let prefix = this.#deriveAlbumPrefix();
      inp.value = prefix;
      inp.helpText = prefix === '' ? 'Multiple dates selected - enter full album name' : '';
      dialog.show();
      // Position cursor at end after dialog opens
      dialog.addEventListener('sl-after-show', ()=>{
        inp.focus();
        let len = inp.value.length;
        inp.input.setSelectionRange(len, len);
      }, {once: true});
    });

    this.#paintTrashedButtons();
  }

  #handleClose = ()=>{
    this.dispatchEvent(new Event('pl-gallery-controls-closed'));
  }

  #handleRatingChanged = (evt)=>{
    let newRating = evt.target.value;
    let ratingChanged = new CustomEvent('pl-gallery-controls-rating-changed', {
      detail: {newRating}
    });
    this.dispatchEvent(ratingChanged);
  }

  #handlePrivateToggle = ()=>{
    this.dispatchEvent(new CustomEvent('pl-gallery-controls-private-toggled', {
      detail: {makePrivate: !this.#allPrivate}
    }));
  }

  #handleDelete = ()=>{
    this.dispatchEvent(new Event('pl-gallery-controls-delete-pressed'));
  }

  #handleRestore = ()=>{
    this.dispatchEvent(new Event('pl-gallery-controls-restore-pressed'));
  }

  #handleCleanup = ()=>{
    this.dispatchEvent(new Event('pl-gallery-controls-cleanup-pressed'));
  }

  #handleMenuSelect = (evt)=>{
    let action = evt.detail.item.id.replace('-menu', '');
    switch(action){
      case 'private': this.#handlePrivateToggle(); break;
      case 'delete':  this.#handleDelete(); break;
      case 'restore': this.#handleRestore(); break;
      case 'cleanup': this.#handleCleanup(); break;
    }
  }

  // TODO: use collection's apply_folder_pattern instead of hardcoded prefix length
  #deriveAlbumPrefix(){
    let entries = Object.entries(this.#selectedAlbums).filter(([_, cnt]) => cnt > 0);
    if (entries.length === 0) return '';

    // Extract date prefixes (first 15 chars) from all source albums
    let prefixes = entries.map(([name]) => name.substring(0, 15));

    // All source albums must share the same date prefix
    let distinct = [...new Set(prefixes)];
    if (distinct.length !== 1) return '';

    return distinct[0] + ' ';
  }

  disconnectedCallback() {
    this.shadowRoot.getElementById("close")
      .removeEventListener('click', this.#handleClose)
    ;

    this.shadowRoot.getElementById("rating")
      .removeEventListener('sl-change', this.#handleRatingChanged)
    ;

    this.shadowRoot.getElementById("private-btn")
      .removeEventListener('click', this.#handlePrivateToggle)
    ;
    this.shadowRoot.getElementById("delete-btn")
      .removeEventListener('click', this.#handleDelete)
    ;
    this.shadowRoot.getElementById("restore-btn")
      .removeEventListener('click', this.#handleRestore)
    ;
    this.shadowRoot.getElementById("cleanup-btn")
      .removeEventListener('click', this.#handleCleanup)
    ;
    this.shadowRoot.getElementById("actions-menu")
      .removeEventListener('sl-select', this.#handleMenuSelect)
    ;

    this.#closeWatcher?.destroy();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    //implementation
  }

  adoptedCallback() {
    //implementation
  }

  #paintCtr(){
    this.shadowRoot.getElementById("ctr").innerHTML = this.ctr;
  }

  #paintRating(){
    this.shadowRoot.querySelector('sl-rating').value = this.rating;
  }

  #paintPrivateIcon(){
    // icon button (desktop)
    this.shadowRoot.getElementById('private-btn').name = this.#allPrivate ? 'unlock-fill' : 'lock-fill';
    // menu item (mobile)
    this.shadowRoot.getElementById('private-menu-icon').name = this.#allPrivate ? 'unlock-fill' : 'lock-fill';
    this.shadowRoot.getElementById('private-label').textContent = this.#allPrivate ? 'Unprivate' : 'Private';
  }

  #paintTrashedButtons(){
    this.classList.toggle('trash-mode', this.#mode === 'trash');
  }

  get ctr(){
    return this.#ctr;
  }
  set ctr(_){
    this.#ctr = +_;
    if(this.isConnected){
      this.#paintCtr();
    }
  }

  get rating(){
    return this.#rating;
  }
  set rating(_){
    this.#rating = _;
    if(this.isConnected){
      this.#paintRating();
    }
  }

  get allPrivate(){
    return this.#allPrivate;
  }
  set allPrivate(_){
    this.#allPrivate = _;
    if(this.isConnected){
      this.#paintPrivateIcon();
    }
  }

  get mode(){
    return this.#mode;
  }
  set mode(_){
    this.#mode = _ || 'default';
    if(this.isConnected){
      this.#paintTrashedButtons();
    }
  }

  get selectedAlbums(){
    return this.#selectedAlbums;
  }
  set selectedAlbums(_){
    this.#selectedAlbums = _
  }

}

window.customElements.define('pl-gallery-controls', PlGalleryControls);