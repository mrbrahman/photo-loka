class PlGalleryControls extends HTMLElement {
  #ctr; #rating;

  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
  }

  connectedCallback() {
    this.shadowRoot.appendChild(
      document.getElementById(this.nodeName).content.cloneNode(true)
    );

    this.shadowRoot.getElementById("close")
      .addEventListener('click', this.#handleClose)
    ;

    this.shadowRoot.getElementById("rating")
      .addEventListener('sl-change', this.#handleRatingChanged)
    ;

    this.shadowRoot.getElementById("delete")
      .addEventListener('click', this.#handleDelete)
    ;

    document.addEventListener("keydown", this.#handleEscape);

  }

  #handleEscape = (evt)=>{
    if (evt.key === "Escape"){
      this.#handleClose();
    }
  }

  #handleClose = (evt)=>{
    let closed = new Event('pl-gallery-controls-closed');
    this.dispatchEvent(closed);
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

    document.removeEventListener("keydown", this.#handleEscape);
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

}

window.customElements.define('pl-gallery-controls', PlGalleryControls);