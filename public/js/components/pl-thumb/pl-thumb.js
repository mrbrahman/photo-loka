import {notify} from '#utils';
import { ImageLoader } from './image-loader.js';
import { SelectionHandler } from './selection-handler.js';
import { RatingHandler } from './rating-handler.js';

class PlThumb extends HTMLElement {
  // instance variables
  #width; #height; #rating=0; #selected=false;
  
  static get observedAttributes() {
    return ['rating','width','height','selected'];
  }
  
  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
    
    // Initialize helpers
    this.imageLoader = new ImageLoader(this);
    this.selectionHandler = new SelectionHandler(this);
    this.ratingHandler = new RatingHandler(this);
  }

  connectedCallback() {
    
    // TODO: handle this properly. rating can have 0 value
    // if(!(this.#rating && this.#width && this.#height) ){
    //   return;
    // }
    
    this.shadowRoot.appendChild(
      document.getElementById(this.nodeName).content.cloneNode(true)
    );

    
    // create a placeholder regardless of whether the element is still in DOM
    this.imageLoader.paintWidth();
    this.imageLoader.paintHeight();
    
    // wait for an arbitrary 250ms and create & paint the rest of the shadow DOM
    // this is so that in case the user is scrolling too fast, we don't download the image unnessarily or call the other sl (shoelace) web components or setup the listeners
    setTimeout(this.paintRest(), 250);
    
  }
  
  attributeChangedCallback(name, oldValue, newValue) {

    // use the "setters" to set the new values, so that any logic can be done in one place
    switch(name){
      case 'width':
        this.width = newValue;
        break;
      case 'height':
        this.height = newValue;
        break;
      case 'rating':
        this.rating = newValue;
        break;
      case 'selected':
        this.selected = newValue == null ? false : true;
        break;
    }
  }
  
  disconnectedCallback() {
    // We're not adding listeners outside of this component
    // Hence no need to remove anything
    // After the component is removed, there is nothing to select on to remove listeners
    // They will just be garbage collected
  }
  
  paintRest(){
    // if the user is scrolling too fast, and the element is already removed, do not paint anything further
    if(!this.isConnected){
      return;
    }
    
    // create the rest of the elements
    this.shadowRoot.getElementById('container').innerHTML = `
      <img />
      <input type="checkbox" id="chk">
      <label for="chk"></label>

      <sl-rating label="Rating" readonly></sl-rating>
    `
    
    // now paint them
    this.imageLoader.paintSrc();
    this.ratingHandler.paintRating();
    this.selectionHandler.paintSelected();
    
    // setup event listeners
    this.selectionHandler.setupSelectionListener();
    this.selectionHandler.setupClickListener();
  }
  
  // boilerplate getters/setters
  get width(){
    return this.#width;
  }
  set width(_){
    this.#width = +_;
    this.imageLoader.paintWidth();
  }
  
  get height(){
    return this.#height;
  }
  set height(_){
    this.#height = +_;
    this.imageLoader.paintHeight();
  }
  
  get rating(){
    return this.#rating;
  }
  set rating(_){
    this.#rating = _;
    this.ratingHandler.paintRating();
  }
  
  get selected(){
    return this.#selected;
  }
  // Note: setting selected through Javascript will not trigger an event
  // it is assumed that the parent that is setting it already knows it is set, and 
  // doesn't need an event
  set selected(_){
    this.#selected = _;
    this.selectionHandler.paintSelected();
  }

}

window.customElements.define('pl-thumb', PlThumb);