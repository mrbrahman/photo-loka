import sheet from "./styles/pl-thumb.css" with { type: "css" };

class PlThumb extends HTMLElement {
  // instance variables
  #width; #height; #rating=0; #selected=false; #type; #dur; #hasGps; #hasDesc; #hasTags;
  
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
    setTimeout(this.#paintRest(), 250);
    
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
    this.#paintRating();
    this.#paintSelected();
    this.#paintVideoBadge();
    this.#paintInfoIcons();
    
    // setup event listeners
    this.shadowRoot.querySelector('input[type="checkbox"]')
      .addEventListener('click', this.#handleSelection)
    ;

    this.shadowRoot.querySelector('img').addEventListener('click', ()=>{
      console.log('item clicked');
      let clickEvent = new CustomEvent('pl-gallery-item-clicked', {
        composed: true, 
        bubbles: true, 
        detail: {id: this.id}
      });

      this.dispatchEvent(clickEvent);
    })

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
        this.shadowRoot.querySelector('img').style.width = this.width+'px';
      }
    }
  }
  #paintHeight(){
    if(this.isConnected){
      this.shadowRoot.getElementById('container').style.height = this.height+'px';
      // img element is not present during initial paint
      if(this.shadowRoot.querySelector('img')){
        this.shadowRoot.querySelector('img').style.height = this.height+'px';
      }
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
      img.src = `/api/getThumbnail?uuid=${this.id}&height=${Math.round(this.height)}`
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

}

customElements.define('pl-thumb', PlThumb);
