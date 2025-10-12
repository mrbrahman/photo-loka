import { SlideManager } from './slide-manager.js';
import { NavigationHandler } from './navigation-handler.js';
import { SlideshowController } from './slideshow-controller.js';
import { EventHandler } from './event-handler.js';

class PlSlideshow extends HTMLElement {
  #data=[]; #src; #startFrom; #buffer=1; #loop=false;
  startIdx=[0,0]; screenWidth; screenHeight; slideshowMode=false; intervalId; slideDuration=3;

  // TODO
  // slideshow pause button, exit button
  // ability to change slide duration in slideshow mode
  // mouseover features (TBD what to show?)
  // lock feature (need a new component for keypad)
  // general cleanup of code, naming of functions, route params etc
  // change URL when item is shown (/item/<uuid>) without putting in history

  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
    
    // Initialize helpers
    this.slideManager = new SlideManager(this);
    this.navigationHandler = new NavigationHandler(this);
    this.slideshowController = new SlideshowController(this);
    this.eventHandler = new EventHandler(this);
  }

  connectedCallback() {
    this.shadowRoot.appendChild(
      document.getElementById(this.nodeName).content.cloneNode(true)
    );

    if(this.data.length == 0){
      return;
    }

    // console.log(this.data)

    if(this.startFrom){
      this.startIdx = this.navigationHandler.getIndexOfK(this.data, this.startFrom);
    }

    this.screenHeight = document.documentElement.clientHeight;
    this.screenWidth  = document.documentElement.clientWidth;

    console.log(`startIdx: ${this.startIdx}`);
    // console.log(`height: ${this.screenHeight} width: ${this.screenWidth}`);

    this.slideManager.initializeSlides();

    this.eventHandler.setupEventListeners();

    // conditionally enable prev and next

    // remove prev if there is no slide to show
    if(!this.shadowRoot.getElementById('slides').querySelector('[data-pos="-1"]')){
      this.shadowRoot.getElementById('prev').style.display = 'none';
      window.removeEventListener('keydown', this.eventHandler.handleLeftArrow);
    }

    // remove next if there is no slide to show
    if(!this.shadowRoot.getElementById('slides').querySelector('[data-pos="1"]')){
      this.shadowRoot.getElementById('next').style.display = 'none';
      window.removeEventListener('keydown', this.eventHandler.handleRightArrow);
    }
  }

  disconnectedCallback() {
    this.eventHandler.removeEventListeners();
  }

  attributeChangedCallback(name, oldVal, newVal) {
    //implementation
  }

  adoptedCallback() {
    //implementation
  }

  // setters and getters
  set data(_){
    // data needs to be an array of arrays. Expecting [[album items], [album items]...]
    // TODO: validate? use Array.isArray
    this.#data = _;
  }
  get data(){
    return this.#data;
  }

  set src(_){
    this.#src = _;
    fetch('/api/search/_')  // TODO call backend.js when ready
      .then(res=>res.json())
      .then(res=>{this.data = res})
    ;
  }
  get src(){
    return this.#src;
  }

  set startFrom(_){
    this.#startFrom = _;
  }
  get startFrom(){
    return this.#startFrom;
  }

  set buffer(_){
    this.#buffer = +_;
  }
  get buffer(){
    return this.#buffer;
  }

  set loop(_){
    this.#loop = Boolean(_)
  }
  get loop(){
    return this.#loop;
  }

}

window.customElements.define('pl-slideshow', PlSlideshow);