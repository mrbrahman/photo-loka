// <pl-album album_name='Album 1' width=1000 gutterspace=4 paintlayout width=500 data="[{id: 1, ar:1}, {id:2, ar: 1.33}, {id:5, ar:0.82}]"></pl-album>

import { notify } from '../../utils.mjs';
import { LayoutCalculator } from './layout-calculator.js';
import { ItemRenderer } from './item-renderer.js';
import { SelectionHandler } from './selection-handler.js';
import { ItemManager } from './item-manager.js';
import { NameHandler } from './name-handler.js';

class PlAlbum extends HTMLElement {
  
  #width; #paint_layout = false; #gutterspace = 4; #data; #album_name; #album_name_height = 45; #album_height; 
  
  static get observedAttributes() {
    return ['paint_layout','album_name','width','gutterspace','data','data_src'];
  }
  
  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
    
    // Initialize helpers
    this.layoutCalculator = new LayoutCalculator(this);
    this.itemRenderer = new ItemRenderer(this);
    this.selectionHandler = new SelectionHandler(this);
    this.itemManager = new ItemManager(this);
    this.nameHandler = new NameHandler(this);
  }
  
  connectedCallback() {
    this.shadowRoot.appendChild(
      document.getElementById(this.nodeName).content.cloneNode(true)
    );
    
    // paint album name
    this.nameHandler.paintName();
    
    // calculate album layout
    this.layoutCalculator.doLayout();

    // paint album only if paint_layout is set
    if(this.#paint_layout){
      this.itemRenderer.paintLayout();
    } else {
      // painting of layout will selectively happen from the wrapper, so not doing anything here
    }

    this.selectionHandler.updateAlbumSelect();

    this.shadowRoot.querySelector('pl-album-name')
      .addEventListener('r3-select-all-clicked', (evt)=>this.selectionHandler.handleSelectAll(evt.detail.select), true)
    ;

    this.shadowRoot.getElementById('container')
      .addEventListener('r3-item-selected', this.selectionHandler.handleItemSelected, true);

  }
  
  attributeChangedCallback(name, oldValue, newValue) {
    switch(name){
      case 'paint_layout':
        this.paint_layout = newValue == null ? false : true;
        break;
      case 'album_name':
        this.album_name = newValue;
        break;
      case 'data':
        this.data = JSON.parse(newValue)
        break;
      case 'width':
        this.width = newValue;
        break;
      case 'gutterspace':
        this.gutterspace = newValue;
        break;
    }
  }

  disconnectedCallback() {
    // nothing to do
  }

  // Expose methods that are called from outside
  selectivelyPaintLayout(bufferTop, bufferBottom, albumTop) {
    return this.itemRenderer.selectivelyPaintLayout(bufferTop, bufferBottom, albumTop);
  }

  redoLayout = () => this.layoutCalculator.doLayout();

  unselectSelectedItems() {
    return this.selectionHandler.unselectSelectedItems();
  }

  changeRatingSelectedItems(newRating) {
    return this.itemManager.changeRatingSelectedItems(newRating);
  }

  deleteSelectedItems() {
    return this.itemManager.deleteSelectedItems();
  }

  addNewItems = (items) => {
    return this.itemManager.addNewItems(items);
  }

  // boilerplate getters/setters
  get paint_layout(){
    return this.#paint_layout;
  }
  set paint_layout(_){
    this.#paint_layout = _;
  }

  get album_name(){
    return this.#album_name;
  }
  set album_name(_){
    this.#album_name = _;
  }
  
  get width(){
    return this.#width;
  }
  set width(_){
    this.#width = +_;
  }

  get gutterspace(){
    return this.#gutterspace;
  }
  set gutterspace(_){
    this.#gutterspace = +_;
  }

  get data(){
    return this.#data;
  }
  set data(_){
    // create a placeholder for the element
    // this will be further updated with the layout and actual element reference
    this.#data = _;
  }

  get album_name_height(){
    return this.#album_name_height;
  }
  set album_name_height(_){
    this.#album_name_height = +_;
  }

  get album_height(){
    return this.#album_height;
  }
  set album_height(_){
    this.#album_height = +_;
  }
  
}

window.customElements.define('pl-album', PlAlbum);