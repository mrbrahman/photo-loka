import sheet from "./styles/pl-gallery-controls.css" with { type: "css" };

class PlGalleryControls extends HTMLElement {
  #ctr; #rating; #selectedAlbums = {}; #closeWatcher;

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
          <sl-icon-button id="delete" name="trash-fill">Delete</sl-icon-button>
          <sl-icon-button id="organize" name="folder-plus">Organize</sl-icon-button>
          
          <!-- rest actions from the dropdown -->
          <sl-dropdown>
            <sl-icon-button name="three-dots-vertical" slot="trigger"></sl-icon-button>
            <sl-menu style="max-width: 200px;">
              <sl-menu-item>
                Share
                <sl-icon slot="suffix" name="share-fill"></sl-icon>
              </sl-menu-item>            
              <sl-menu-item>
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

    this.shadowRoot.getElementById("delete")
      .addEventListener('click', this.#handleDelete)
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
    .addEventListener('click', ()=>dialog.show());
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

  #handleDelete = (evt)=>{
    let deleted = new Event('pl-gallery-controls-delete-pressed');
    this.dispatchEvent(deleted);
  }

  disconnectedCallback() {
    this.shadowRoot.getElementById("close")
      .removeEventListener('click', this.#handleClose)
    ;

    this.shadowRoot.getElementById("rating")
      .removeEventListener('sl-change', this.#handleRatingChanged)
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

  get selectedAlbums(){
    return this.#selectedAlbums;
  }
  set selectedAlbums(_){
    this.#selectedAlbums = _
  }

}

window.customElements.define('pl-gallery-controls', PlGalleryControls);