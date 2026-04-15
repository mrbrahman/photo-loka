import sheet from "./styles/pl-slideshow.css" with { type: "css" };

class PlSlideshow extends HTMLElement {
  #data=[]; #src; #startFrom; #buffer=1; #loop=false;
  #startIdx=[0,0]; #slideshowMode=false; #infoPanelOpen=false; #intervalId; #slideDuration=3;

  // TODO
  // slideshow pause button, exit button
  // ability to change slide duration in slideshow mode
  // mouseover features (TBD what to show?)
  // lock feature (need a new component for keypad)
  // general cleanup of code, naming of functions, route params etc

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <div id="container">
        <div id="slides" >
        </div>
      </div>
    `;
  }

  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    if(this.data.length == 0){
      return;
    }

    // console.log(this.data)

    if(this.startFrom){
      this.#startIdx = this.#getIndexOfK(this.data, this.startFrom);
    }

    console.log(`startIdx: ${this.#startIdx}`);

    let slide = this.#createSlide(this.#startIdx);
    slide.classList.add('active');
    slide.dataset.pos = 0;
    slide.dataset.idx = this.#startIdx.toString();
    slide.slideshowMode = this.#slideshowMode;
    this.shadowRoot.getElementById('slides').append(slide);
    if(slide.dataset.type.startsWith('video')){
      slide.play = true;
    }


    // paint subsequent slides first (assume the default direction is ltr)
    let currIdx = this.#startIdx;
    for(let i=1; i<=this.buffer; i++){

      let nextIdx = this.#nextIdx(currIdx);
      if(nextIdx){
        let nextSlide = this.#createSlide(nextIdx);
        nextSlide.classList.add('right');
        nextSlide.dataset.pos = i;
        nextSlide.dataset.idx = nextIdx.toString();
        this.shadowRoot.getElementById('slides').append(nextSlide);
        
        currIdx = nextIdx;
      } else {
        break;
      }
    }

    // now paint previous slides
    currIdx = this.#startIdx;
    for(let i=-1; i>=-this.buffer; i--){
      let prevIdx = this.#prevIdx(currIdx);
      if(prevIdx){
        let prevSlide = this.#createSlide(prevIdx);
        prevSlide.classList.add('left');
        prevSlide.dataset.pos = i;
        prevSlide.dataset.idx = prevIdx.toString();
        this.shadowRoot.getElementById('slides').append(prevSlide);

        currIdx = prevIdx;
      } else {
        break;
      }
    }

    // Set hasNext/hasPrev on the initial active slide
    this.#updateActiveSlideNav();

    // Listen for nav events from pl-slide
    this.addEventListener('pl-nav-prev', () => this.#prev());
    this.addEventListener('pl-nav-next', () => this.#next());
    this.addEventListener('pl-slideshow-close-requested', this.#slideshowClosed);

    this.addEventListener('fullscreenchange', this.#slideshowToggle);
    this.addEventListener('pl-start-slideshow', ()=>{
      // if (document.fullscreenElement){
      //   document.exitFullscreen();
      // } else {
        this.requestFullscreen();
      // }
    });

    this.addEventListener('pl-info-panel-toggled', (evt) => {
      this.#infoPanelOpen = evt.detail.open;
    });

    this.addEventListener('pl-slideshow-video-ended', ()=>{
      if(this.#slideshowMode && this.shadowRoot.getElementById('slides').querySelector('[data-pos="1"')){
        this.#startTimer();
        this.#next();
      }
    })

    window.addEventListener('keydown', this.#handleRightArrow);
    window.addEventListener('keydown', this.#handleLeftArrow);
    // Convention: use keydown (not keyup) for action keys (Escape, Enter, arrows).
    // keydown fires immediately and stopPropagation works reliably - with keyup,
    // if a keydown handler blurs the element, keyup fires from a different target,
    // bypassing any stopPropagation on the original element.
    window.addEventListener('keydown', this.#handleSlideshowEscape);

    // conditionally enable keyboard nav
    if(!this.shadowRoot.getElementById('slides').querySelector('[data-pos="-1"]')){
      window.removeEventListener('keydown', this.#handleLeftArrow);
    }
    if(!this.shadowRoot.getElementById('slides').querySelector('[data-pos="1"]')){
      window.removeEventListener('keydown', this.#handleRightArrow);
    }
  }

  #updateActiveSlideNav() {
    let slide = this.shadowRoot.getElementById('slides').querySelector('[data-pos="0"]');
    if (!slide) return;
    slide.hasNext = !!this.shadowRoot.getElementById('slides').querySelector('[data-pos="1"]');
    slide.hasPrev = !!this.shadowRoot.getElementById('slides').querySelector('[data-pos="-1"]');
  }

  #slideshowToggle = () => {
    if(document.fullscreenElement){
      this.#slideshowMode = true;

      let slide = this.shadowRoot.getElementById('slides').querySelector('[data-pos="0"]');
      slide.slideshowMode = true;
      this.#startTimer();

    } else {
      this.#slideshowMode = false;

      let slide = this.shadowRoot.getElementById('slides').querySelector('[data-pos="0"]');
      slide.slideshowMode = false;
      this.#stopTimer();
    }
  }

  #startTimer() {
    this.#intervalId = setInterval(()=>{
      if(this.shadowRoot.getElementById('slides').querySelector('[data-pos="1"]')){
        this.#next()
      } else {
        document.exitFullscreen();
      }
    }, this.#slideDuration*1000);
  }

  #stopTimer() {
    clearInterval(this.#intervalId);
  }

  #resetTimer() {
    this.#stopTimer();
    this.#startTimer();
  }

  #handleSlideshowEscape = (evt) =>{
    if(evt.key == "Escape"){
      if (this.#infoPanelOpen) return; // let pl-slide close the info panel first
      this.#slideshowClosed();
    // } else if(evt.key == "A" || evt.key == "a"){
    //   // toggle album name
    //   console.log('pl-slieshow a or A pressed')
    } else {
      // ignore all other keys
      // console.log(evt.key)
    }
  }


  #getCurrentItemId() {
    let active = this.shadowRoot.getElementById('slides').querySelector('[data-pos="0"]');
    if (!active) return null;
    let idx = active.dataset.idx.split(',').map(Number);
    return this.data[idx[0]].items[idx[1]].data.id;
  }

  // DESIGN: Emits the current item's id so the parent (pl-gallery) can sync its
  // scroll position and update the URL. This is dispatched at the end of every
  // #next() and #prev() call. Uses composed:true to cross shadow DOM boundaries.
  #emitItemChanged() {
    this.dispatchEvent(new CustomEvent('pl-slideshow-item-changed', {
      composed: true, bubbles: true,
      detail: { currentItemId: this.#getCurrentItemId() }
    }));
  }

  // DESIGN: Includes currentItemId in the close event so the parent knows which
  // item was last viewed. Uses composed:true to cross shadow DOM boundaries.
  #slideshowClosed = ()=>{
    let emitClose = () => {
      this.dispatchEvent(new CustomEvent('pl-slideshow-closed', {
        composed: true, bubbles: true,
        detail: { currentItemId: this.#getCurrentItemId() }
      }));
    };

    // Close info panel first if open, wait for its transition (300ms), then close slideshow
    if (this.#infoPanelOpen) {
      let active = this.shadowRoot.querySelector('#slides [data-pos="0"]');
      if (active) active.infoPanelOpen = false;
      this.#infoPanelOpen = false;
      setTimeout(emitClose, 300);
    } else {
      emitClose();
    }
  }

  #handleRightArrow = (evt)=>{
    if(evt.key == "ArrowRight"){
      this.#next();

      if(this.#slideshowMode){
        this.#resetTimer();
      }
    }
  }

  #handleLeftArrow = (evt)=>{
    if(evt.key == "ArrowLeft"){
      this.#prev();

      if(this.#slideshowMode){
        this.#resetTimer();
      }
    }
  }



  // Adapted from https://stackoverflow.com/a/16102526/8098748
  #getIndexOfK(arr, k) {
    for (var i = 0; i < arr.length; i++) {
      var index = arr[i].items.findIndex(e=>e.data.id==k);
      if (index > -1) {
        return [i, index];
      }
    }
  }

  #nextIdx(idx){
    let arr = this.data;

    if(arr[idx[0]].items[idx[1]+1]){
      return [idx[0], idx[1]+1];  // next item in the current album
    } else if(arr[idx[0]+1]) {
      return [idx[0]+1, 0]        // first item in the next album
    } else {
      if(this.#loop){
        return [0,0];             // first item of the first album
      }
      return undefined;
    }
  }

  #prevIdx(idx){
    let arr = this.data;
    
    if(arr[idx[0]].items[idx[1]-1]){
      return [idx[0], idx[1]-1];  // previous item in the current album
    } else if (arr[idx[0]-1]) {
      return [idx[0]-1, arr[idx[0]-1].items.length - 1] // last item in the previous album
    } else {
      if(this.#loop){
        return [this.data.length-1, this.data[this.data.length-1].items.length-1] // last item of the last album
      }
      return undefined;
    }
  }

  #createSlide(idx){
    let slide = Object.assign(document.createElement('pl-slide'), {
      albumname: this.data[idx[0]].album,
      item: this.data[idx[0]].items[idx[1]]
    });

    slide.dataset.type = this.data[idx[0]].items[idx[1]].data.type;

    return slide;
  }

  #next(){
    // first make DOM changes visible to user
    let activeSlide = this.shadowRoot.getElementById('slides').querySelector('[data-pos="0"]');
    if(activeSlide.dataset.type.startsWith('video')){
      activeSlide.play = false;
    }
    activeSlide.classList.add('left');
    activeSlide.classList.remove('active');

    let nextSlide = this.shadowRoot.getElementById('slides').querySelector('[data-pos="1"]');
    nextSlide.classList.add('active');
    nextSlide.classList.remove('right');
    nextSlide.slideshowMode = this.#slideshowMode;
    nextSlide.infoPanelOpen = this.#infoPanelOpen;

    if(nextSlide.dataset.type.startsWith('video')){
      nextSlide.play = true;
      if(this.#slideshowMode){
        this.#stopTimer();
      }
    }

    // now make DOM changes that are not visibile to the user
    for(let i=-this.buffer; i<=this.buffer; i++){
      
      let slide = this.shadowRoot.getElementById('slides').querySelector(`[data-pos="${i}"]`);

      if(!slide){
        continue;
      }

      if(i == -this.buffer){
        // remove slide at the left
        slide.infoPanelOpen = false;
        slide.remove();
      } else {
        // adjust positions for the remaining
        slide.dataset.pos = i-1;

        // add a slide at the end, use the 'idx' from the slide previously at 'buffer' position
        if(i == this.buffer){
          let nextIdx = this.#nextIdx( slide.dataset.idx.split(',').map(x=>parseInt(x)) );
          
          if(nextIdx){
            let slide = this.#createSlide(nextIdx);
            slide.classList.add('right');
            slide.dataset.pos = this.buffer;
            slide.dataset.idx = nextIdx.toString();
            this.shadowRoot.getElementById('slides').append(slide);
          } else {
            // we've reached the end of slide show
          }
        }
      }
    } // for loop

    // update nav buttons on new active slide
    this.#updateActiveSlideNav();

    // update keyboard nav
    if(!this.shadowRoot.getElementById('slides').querySelector('[data-pos="1"]')){
      window.removeEventListener('keydown', this.#handleRightArrow);
    }
    if(this.shadowRoot.getElementById('slides').querySelector('[data-pos="-1"]')){
      window.addEventListener('keydown', this.#handleLeftArrow);
    }

    this.#emitItemChanged();
  }

  #prev(){
    // first make DOM changes visible to user
    let activeSlide = this.shadowRoot.getElementById('slides').querySelector('[data-pos="0"]');
    if(activeSlide.dataset.type.startsWith('video')){
      activeSlide.play = false;
    }
    activeSlide.classList.add('right');
    activeSlide.classList.remove('active');

    let prevSlide = this.shadowRoot.getElementById('slides').querySelector('[data-pos="-1"]');
    prevSlide.classList.add('active');
    prevSlide.classList.remove('left');
    prevSlide.slideshowMode = this.#slideshowMode;
    prevSlide.infoPanelOpen = this.#infoPanelOpen;
    if(prevSlide.dataset.type.startsWith('video')){
      prevSlide.play = true;
    }

    // now make DOM changes that are not visibile to the user
    for(let i=this.buffer; i>=-this.buffer; i--){
      
      let slide = this.shadowRoot.getElementById('slides').querySelector(`[data-pos="${i}"]`);

      if(!slide){
        continue;
      }

      if(i == this.buffer){
        // remove slide at the right
        slide.infoPanelOpen = false;
        slide.remove();
      } else {
        // adjust positions for the remaining
        slide.dataset.pos = i+1;

        // add a slide at the end, use the 'idx' from the slide previously at 'buffer' position
        if(i == -this.buffer){
          let prevIdx = this.#prevIdx( slide.dataset.idx.split(',').map(x=>parseInt(x)) );
          
          if(prevIdx){
            let slide = this.#createSlide(prevIdx);
            slide.classList.add('left');
            slide.dataset.pos = -this.buffer;
            slide.dataset.idx = prevIdx.toString();
            this.shadowRoot.getElementById('slides').append(slide);
          } else {
            // we've reached the end of slide show
          }
        }
      }
    } // for loop

    // update nav buttons on new active slide
    this.#updateActiveSlideNav();

    // update keyboard nav
    if(!this.shadowRoot.getElementById('slides').querySelector('[data-pos="-1"]')){
      window.removeEventListener('keydown', this.#handleLeftArrow);
    }
    if(this.shadowRoot.getElementById('slides').querySelector('[data-pos="1"]')){
      window.addEventListener('keydown', this.#handleRightArrow);
    }

    this.#emitItemChanged();
  }

  disconnectedCallback() {
    window.removeEventListener('keydown', this.#handleRightArrow);
    window.removeEventListener('keydown', this.#handleLeftArrow);
    window.removeEventListener('keydown', this.#handleSlideshowEscape);
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

  get activeMediaRect() {
    let active = this.shadowRoot.querySelector('#slides [data-pos="0"]');
    return active?.mediaRect ?? null;
  }

  prepareForDismiss() {
    let active = this.shadowRoot.querySelector('#slides [data-pos="0"]');
    if (!active) return null;
    // Pause video
    if (active.dataset.type?.startsWith('video')) active.play = false;
    // Hide chrome
    active.hideChrome();
    // Remove black background
    let container = this.shadowRoot.getElementById('container');
    if (container) container.style.backgroundColor = 'transparent';
    return active.mediaRect;
  }

}

window.customElements.define('pl-slideshow', PlSlideshow);
