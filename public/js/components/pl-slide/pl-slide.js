import { MediaRenderer } from './media-renderer.js';
import { ZoomHandler } from './zoom-handler.js';
import { RatingManager } from './rating-manager.js';

class PlSlide extends HTMLElement {
  #albumname; #item; #screenWidth; #screenHeight; #play; #slideshowMode;

  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
    
    // Initialize helpers
    this.mediaRenderer = new MediaRenderer(this);
    this.zoomHandler = new ZoomHandler(this);
    this.ratingManager = new RatingManager(this);
  }
  
  connectedCallback() {
    this.shadowRoot.appendChild(
      document.getElementById(this.nodeName).content.cloneNode(true)
    );
    
    this.shadowRoot.getElementById('albumname').innerText = this.albumname || '';
    this.shadowRoot.getElementById('rating').setAttribute('value', this.item.data.rating || 0);
    
    this.ratingManager.setupRatingListener();

    this.shadowRoot.getElementById('start-slideshow').addEventListener('click', ()=>{
      this.dispatchEvent(new Event('pl-start-slideshow', {composed: true, bubbles: true}));
    });

    this.zoomHandler.setupZoomControls();
    this.mediaRenderer.renderMedia();
  }

  disconnectedCallback() {
    //implementation
  }

  attributeChangedCallback(name, oldVal, newVal) {
    //implementation
  }

  adoptedCallback() {
    //implementation
  }

  set albumname(_){
    this.#albumname = _;
  }
  get albumname(){
    return this.#albumname;
  }

  set item(_){
    this.#item = _;
  }
  get item(){
    return this.#item;
  }

  set screenDimensions([w,h]){
    this.#screenWidth = w;
    this.#screenHeight = h;

    if(this.isConnected){
      let m = this.shadowRoot.getElementById('media').firstElementChild
      // TODO: update img URL (to fetch new image with updated dimensions)
      // m.width = w;
      // m.height = h;
    }
  }
  get screenDimensions(){
    return [this.#screenWidth, this.#screenHeight]
  }

  get screenWidth() {
    return this.#screenWidth;
  }

  get screenHeight() {
    return this.#screenHeight;
  }

  set play(_){
    this.#play = Boolean(_);  // TODO: fix this
    this.mediaRenderer.playPauseMedia();
  }
  get play(){
    return this.#play;
  }

  set slideshowMode(_){
    this.#slideshowMode = Boolean(_);

    if(!this.isConnected){
      return;
    }
    
    if(this.#slideshowMode){
      this.shadowRoot.getElementById('albumname').classList.add('hidden');
      this.shadowRoot.getElementById('actions').classList.add('hidden');

    } else {
      this.shadowRoot.getElementById('albumname').classList.remove('hidden');
      this.shadowRoot.getElementById('actions').classList.remove('hidden');
    }
  }
  get slideshowMode(){
    return this.#slideshowMode;
  }

}

window.customElements.define('pl-slide', PlSlide);