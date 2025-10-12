// many web component practices adapted from: https://dev.to/dannyengelman/web-component-102-the-5-lessons-after-learning-web-components-101-h9p

// some functional (logic) concepts adapted from https://github.com/schlosser/pig.js/ and further expanded for multiple albums

// e.g. TBD
// <pl-gallery ></pl-gallery>

// The basic design is:
//
// 1. Gallery is responsibile for creating albums
// 2. When any item is selected/de-selected, gallery is also responsible for 
//    the creation and removal of gallery controls
// 3. Gallery controls is a dummy component which is mainly used for user interaction only
// 4. Since item selection can happen from multiple albums, gallery will own all backend changes
//    related to selected items
// 5. Album will only be responsible for paiting of UI
// 6. The only exception is 'album name' component, which can also update the backend. But
//    that is fine, since the album name update does not span multiple albums

import { AlbumManager } from './album-manager.js';
import { SelectionManager } from './selection-manager.js';
import { ViewportManager } from './viewport-manager.js';
import { ItemMover } from './item-mover.js';

class PlGallery extends HTMLElement {

  // internal variables
  albums = []; albumsInBuffer = {}; albumsSelectedCnt = {}; itemsSelected = [];
  // variables that can be get/set
  #data;

  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
    
    // Initialize helpers
    this.albumManager = new AlbumManager(this);
    this.selectionManager = new SelectionManager(this);
    this.viewportManager = new ViewportManager(this);
    this.itemMover = new ItemMover(this);
  }

  connectedCallback() {

    this.shadowRoot.appendChild(
      document.getElementById(this.nodeName).content.cloneNode(true)
    );
    // console.log("logging data... ")
    // console.log(this.data);

    this.albums = this.albumManager.createAlbums();

    this.shadowRoot.getElementById('gallery').append(...this.albums);
    this.albumManager.reAssignAlbumPositions();
    this.viewportManager.selectivelyPaintAlbums();

    this.addEventListener('pl-gallery-item-clicked', (evt)=>{
      evt.stopPropagation();

      this.dispatchEvent(new CustomEvent('pl-slideshow-request', {
        composed: true,
        bubbles: true,
        detail: {
          data: this.albums.map(x=>{
            return {
              album: x.album_name, 
              items: x.data
            }
          }),
          startFrom: evt.detail.id
        }
      }))
    })

    this.viewportManager.setupEventListeners();
  }

  // Expose methods that are called from helpers
  handleItemsSelected = (evt) => {
    return this.selectionManager.handleItemsSelected(evt);
  }

  handleAlbumHeightChange = () => {
    // apply "style: top" changes to all albums
    this.albumManager.reAssignAlbumPositions();

    // paint albums twice for better user experience
    // painting only once after timeout causes an unnecessary delay 
    // in resizing last row when items are deleted at the bottom of the album
    this.viewportManager.selectivelyPaintAlbums();
    
    // bring more items to the buffer, or remove items from buffer as necessary
    // need to wait for the album height animation to complete, before doing this
    // so that 'offsetTop' value is properly obtained
    setTimeout(() => {
      this.viewportManager.selectivelyPaintAlbums();
    }, 300);
  }

  removeAlbum = (evt) => {
    return this.albumManager.removeAlbum(evt);
  }

  createOrMoveSelectedItems = (targetAlbumName) => {
    return this.itemMover.createOrMoveSelectedItems(targetAlbumName);
  }

  disconnectedCallback() {
    this.viewportManager.removeEventListeners();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    //implementation
  }

  adoptedCallback() {
    console.log('in adoptedCallback')
  }

  get data(){
    return this.#data;
  }
  set data(_){
    this.#data = _;
  }

  get data_src(){
    return this._data_src;
  }
  set data_src(_){
    this._data_src = _;
    // TODO: do a fetch and set this.#data
  }

}

window.customElements.define('pl-gallery', PlGallery);