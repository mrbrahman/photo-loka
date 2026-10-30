import sheet from "./styles/pl-thumb.css" with { type: "css" };
import { apiUrl } from '../api-base.mjs';

class PlThumb extends HTMLElement {
  // instance variables
  #width; #height; #rating=0; #selected=false; #type; #dur; #hasGps; #hasDesc; #hasTags;
  // When true, the img fills its (square) cell via object-fit:cover instead of
  // being sized to the exact layout width/height. Set by pl-album per layout
  // mode. The container is always sized to width/height; only the img styling
  // differs.
  #squareMode = false;

  // Long-press-to-select state. #longPressTimer is the pending hold timer,
  // #longPressStart is the pointerdown coordinate (for the move-cancel check),
  // and #suppressNextClick swallows the click that follows a completed press
  // so it does not also open the slideshow.
  #longPressTimer = null; #longPressStart = null; #suppressNextClick = false;

  // Drag-select sweep state on this thumb. #activePointerId is the pointer to
  // capture/release; #sweeping is true from the moment the long-press arms
  // until pointerup/cancel, during which we preventDefault moves so the
  // browser does not abort the gesture with pointercancel.
  #activePointerId = null; #sweeping = false;
  
  #dppx = parseFloat(window.devicePixelRatio.toFixed(2));
  
  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <div id="container">
        <!--  rest of the template is updated in the connectedCallback method -->
      </div>
    `;
  }

  static get observedAttributes() {
    return ['rating','width','height','selected'];
  }
  
  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    
    // TODO: handle this properly. rating can have 0 value
    // if(!(this.#rating && this.#width && this.#height) ){
    //   return;
    // }
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
    
    // create a placeholder regardless of whether the element is still in DOM
    this.#paintWidth();
    this.#paintHeight();
    
    // wait for an arbitrary 250ms and create & paint the rest of the shadow DOM
    // this is so that in case the user is scrolling too fast, we don't download the image unnessarily or call the other sl (shoelace) web components or setup the listeners
    setTimeout(() => this.#paintRest(), 250);
    
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
  
  #paintRest(){
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
      <span class="video-badge" hidden></span>
      <span class="info-icons"></span>
    `
    
    // now paint them
    this.#paintSrc();
    this.#paintImgFit();
    this.#paintRating();
    this.#paintSelected();
    this.#paintVideoBadge();
    this.#paintInfoIcons();
    
    // setup event listeners
    this.shadowRoot.querySelector('input[type="checkbox"]')
      .addEventListener('click', this.#handleSelection)
    ;

    let img = this.shadowRoot.querySelector('img');

    // Disable the browser's native image drag-and-drop. Without this, a
    // press-and-drag with a mouse starts an image drag, which fires
    // pointercancel and kills the drag-select sweep before it can follow the
    // pointer.
    img.draggable = false;
    img.addEventListener('dragstart', (evt)=> evt.preventDefault());

    img.addEventListener('click', ()=>{
      // A long-press toggles selection and sets this flag so the click that
      // the browser fires on pointerup does not also open the slideshow.
      if(this.#suppressNextClick){
        this.#suppressNextClick = false;
        return;
      }
      let clickEvent = new CustomEvent('pl-gallery-item-clicked', {
        composed: true, 
        bubbles: true, 
        detail: {id: this.id}
      });

      this.dispatchEvent(clickEvent);
    })

    // Long-press to toggle selection (all pointer types). A normal tap still
    // opens the slideshow; only a 500ms hold that stays within 10px selects.
    // This gives a large, easy-to-hit selection gesture in addition to the
    // corner checkbox, without hijacking the tap-to-open-slideshow behavior.
    img.addEventListener('pointerdown', this.#handlePointerDown);
    img.addEventListener('pointermove', this.#handlePointerMove);
    img.addEventListener('pointerup', this.#cancelLongPress);
    img.addEventListener('pointercancel', this.#cancelLongPress);
    // Belt-and-braces scroll suppression for touch: unlike pointermove (which
    // Chrome ignores preventDefault on for scrolling), a non-passive touchmove
    // preventDefault DOES stop scroll on Chrome Android. Only active while a
    // sweep is armed so normal swipe-to-scroll on a thumb is unaffected.
    img.addEventListener('touchmove', this.#handleTouchMove, { passive: false });
    // Suppress the native long-press context menu / image "save" popup on the
    // thumb so it does not fight the long-press-to-select gesture.
    img.addEventListener('contextmenu', (evt)=> evt.preventDefault());

  }

  #handlePointerDown = (evt)=>{
    // Start each interaction fresh: if a prior long-press set the suppress
    // flag but no click ever arrived to clear it, don't let it swallow this
    // new tap.
    this.#suppressNextClick = false;
    this.#longPressStart = { x: evt.clientX, y: evt.clientY };
    this.#activePointerId = evt.pointerId;
    this.#longPressTimer = setTimeout(()=>{
      this.#longPressTimer = null;
      this.#toggleSelectionViaLongPress();
    }, 500);
  }

  #handleTouchMove = (evt)=>{
    // Only suppress scroll once a sweep is armed. cancelable is false if the
    // browser already committed to scrolling; guard to avoid the console warn.
    if(this.#sweeping && evt.cancelable){
      evt.preventDefault();
    }
  }

  #handlePointerMove = (evt)=>{
    // Once a sweep is armed, this img holds the (implicit) pointer capture, so
    // it keeps receiving moves. We must preventDefault them, otherwise the
    // browser reinterprets the button-held drag as a pan/scroll and fires
    // pointercancel, killing the gallery's drag-select sweep. The events still
    // bubble to the gallery for cross-thumb hit-testing.
    if(this.#sweeping){
      evt.preventDefault();
      return;
    }
    if(this.#longPressTimer == null || this.#longPressStart == null) return;
    let dx = evt.clientX - this.#longPressStart.x;
    let dy = evt.clientY - this.#longPressStart.y;
    // Cancel if the pointer moves more than 10px (i.e. the user is scrolling
    // or dragging, not holding).
    if(dx*dx + dy*dy > 100){
      this.#cancelLongPress();
    }
  }

  #cancelLongPress = ()=>{
    if(this.#longPressTimer != null){
      clearTimeout(this.#longPressTimer);
      this.#longPressTimer = null;
    }
    this.#longPressStart = null;
    // End sweep bookkeeping on this thumb and release capture.
    if(this.#sweeping){
      this.#sweeping = false;
      let img = this.shadowRoot.querySelector('img');
      if(img){
        img.style.touchAction = '';
        if(this.#activePointerId != null){
          try { img.releasePointerCapture(this.#activePointerId); } catch(e){ /* already released */ }
        }
      }
    }
    this.#activePointerId = null;
  }

  // Fired when the hold timer completes. Flip the checkbox state and reuse
  // the exact same selection path as a checkbox click so pl-album / pl-gallery
  // see an identical r3-item-selected event.
  #toggleSelectionViaLongPress = ()=>{
    this.#longPressStart = null;
    let chk = this.shadowRoot.querySelector('input[type="checkbox"]');
    if(!chk) return;
    chk.checked = !chk.checked;
    // Swallow the click the browser dispatches on pointerup so it does not
    // also open the slideshow.
    this.#suppressNextClick = true;
    this.selected = chk.checked; // calls the setter
    this.dispatchEvent(new CustomEvent('r3-item-selected', {composed: true, bubbles: true}));

    // Arm drag-select. Capture the pointer on the img so subsequent moves stay
    // targeted here (they still bubble to the gallery for hit-testing). Set
    // touch-action:none on the IMG itself (not an ancestor): for touch, Chrome
    // governs scroll-takeover by the captured element's own touch-action and
    // ignores preventDefault on pointermove. Because the long-press required
    // the finger to stay within 10px for 500ms, no scroll has started yet, so
    // flipping to none now takes effect for this gesture and stops the
    // pointercancel that was aborting the sweep.
    this.#sweeping = true;
    let img = this.shadowRoot.querySelector('img');
    if(img){
      img.style.touchAction = 'none';
      if(this.#activePointerId != null){
        try { img.setPointerCapture(this.#activePointerId); } catch(e){ /* ignore */ }
      }
    }

    // Tell the gallery a long-press just completed so it can begin a sweep.
    // anchorSelected is the resulting state of this item; the sweep paints
    // that same state onto items the finger passes over (apply-anchor-state,
    // not per-item toggle).
    this.dispatchEvent(new CustomEvent('pl-thumb-longpress-armed', {
      composed: true, bubbles: true,
      detail: { id: this.id, anchorSelected: this.selected }
    }));
  }

  #handleSelection = (evt)=>{
    this.selected = evt.target.checked; // calls the setter
    let checkEvent = new CustomEvent('r3-item-selected', {composed: true, bubbles: true});
    this.dispatchEvent(checkEvent);
  }
  
  // individual paint functions
  // checking for this.isConnected (i.e in DOM) in each, as these also get triggered for static elements
  // that use attributeChangedCallback to set the values before connectedComponents is called
  #paintWidth(){
    if(this.isConnected){
      this.shadowRoot.getElementById('container').style.width = this.width+'px';
      // img element is not present during initial paint
      if (this.shadowRoot.querySelector('img')){
        this.#paintImgFit();
      }
    }
  }
  #paintHeight(){
    if(this.isConnected){
      this.shadowRoot.getElementById('container').style.height = this.height+'px';
      // img element is not present during initial paint
      if(this.shadowRoot.querySelector('img')){
        this.#paintImgFit();
      }
    }
  }
  // Size the img element per layout mode. In aspect mode the img matches the
  // container's exact width/height (the served thumbnail's aspect ratio equals
  // the cell's, so no cropping). In square mode the cell is square but the
  // served thumbnail is not, so the img fills the cell and object-fit:cover
  // crops it to a centered square.
  #paintImgFit(){
    let img = this.shadowRoot.querySelector('img');
    if(!img) return;
    if(this.#squareMode){
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'cover';
    } else {
      img.style.width = this.width+'px';
      img.style.height = this.height+'px';
      img.style.objectFit = '';
    }
  }
  #paintSrc(){
    if(this.isConnected){
      let img = this.shadowRoot.querySelector('img');
      img.onload = function(){
        this.classList.add('ready');
      };
      // console.log(`need ${this.height * this.#dppx} px`)
      // img.src = `https://picsum.photos/id/${this.id}/${Math.round(this.width)}/${Math.round(this.height)}`;
      img.src = apiUrl(`/api/getThumbnail?uuid=${this.id}&height=${Math.round(this.height)}`)
    } 
  }
  #paintRating(){
    if(this.isConnected){
      this.shadowRoot.querySelector('sl-rating').value = this.rating;
      
      if(this.rating > 0){
        this.shadowRoot.querySelector('sl-rating').style.visibility = "visible";
      } else {
        this.shadowRoot.querySelector('sl-rating').style.visibility = "hidden";
      }
    }
    
  }
  #paintSelected(){
    if(!this.isConnected){
      return;
    }

    this.shadowRoot.querySelector('input[type="checkbox"]').checked = this.selected;

  }
  
  #paintVideoBadge(){
    if(!this.isConnected) return;
    let badge = this.shadowRoot.querySelector('.video-badge');
    if(this.#type?.startsWith('video')){
      badge.textContent = this.#dur ? `▶ ${this.#dur}` : '▶';
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }
  #paintInfoIcons(){
    if(!this.isConnected) return;
    let container = this.shadowRoot.querySelector('.info-icons');
    let icons = [];
    if(!this.#hasGps) icons.push('icon-no-gps');
    if(this.#hasDesc) icons.push('icon-desc');
    if(this.#hasTags) icons.push('icon-tags');
    container.innerHTML = icons.map(c => `<span class="info-icon ${c}"></span>`).join('');
  }

  // boilerplate stuff
  get width(){
    return this.#width;
  }
  set width(_){
    this.#width = +_;
    this.#paintWidth();
  }
  
  get height(){
    return this.#height;
  }
  set height(_){
    this.#height = +_;
    this.#paintHeight();
  }
  
  get rating(){
    return this.#rating;
  }
  set rating(_){
    this.#rating = _;
    this.#paintRating();
  }
  
  get type(){
    return this.#type;
  }
  set type(_){
    this.#type = _;
  }

  get dur(){
    return this.#dur;
  }
  set dur(_){
    this.#dur = _;
  }

  get hasGps(){
    return this.#hasGps;
  }
  set hasGps(_){
    this.#hasGps = +_;
  }

  get hasDesc(){
    return this.#hasDesc;
  }
  set hasDesc(_){
    this.#hasDesc = +_;
    this.#paintInfoIcons();
  }

  get hasTags(){
    return this.#hasTags;
  }
  set hasTags(_){
    this.#hasTags = +_;
  }

  get selected(){
    return this.#selected;
  }
  // Note: setting selected through Javascript will not trigger an event
  // it is assumed that the parent that is setting it already knows it is set, and 
  // doesn't need an event
  set selected(_){
    this.#selected = _;
    this.#paintSelected();
  }

  get squareMode(){
    return this.#squareMode;
  }
  set squareMode(_){
    this.#squareMode = Boolean(_);
    this.#paintImgFit();
  }

}

customElements.define('pl-thumb', PlThumb);
