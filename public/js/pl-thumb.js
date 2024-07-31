import {notify} from './utils.mjs';

class PlThumb extends HTMLElement {
  // instance variables
  #width; #height; #rating=0; #selected=false;
  
  #dppx = parseFloat(window.devicePixelRatio.toFixed(2));
  
  static get observedAttributes() {
    return ['rating','width','height','selected'];
  }
  
  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
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
      <sl-icon-button name="trash"></sl-icon-button>
    `
    
    // now paint them
    this.#paintSrc();
    this.#paintRating();
    this.#paintSelected();
    
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

    // event listeners for rating ang trash will be added during paintSelect
    
  }

  #handleSelection = (evt)=>{
    this.selected = evt.target.checked; // calls the setter
    let checkEvent = new CustomEvent('r3-item-selected', {composed: true, bubbles: true});
    this.dispatchEvent(checkEvent);
  }
/*
  #slRatingChanged = (evt)=>{
    let oldRating = this.#rating;
    let newRating = evt.target.value;

    // https://jasonwatmore.com/post/2021/10/09/fetch-error-handling-for-failed-http-responses-and-network-errors
    fetch(`updateRating?uuid=${this.id}&newRating=${newRating}`, {method: "PUT"})
      .then(async (res)=>{
        let isJson = res.headers.get('content-type')?.includes('application/json');
        let output = isJson ? await res.json() : null;

        if(!res.ok){
          return Promise.reject(output.error || res.status+':'+res.statusText)
        }
        // no need to use setter; we don't want to paint
        this.#rating = newRating;
        console.log('updated rating in backend');
      })
      .catch(err=>{
        // using the setter here, since we need to paint the rating back to original value
        // but we don't want that change to fire an event, hence disable event listener first
        // and re-enable after the change is made
        this.#removeRatingListener();
        this.rating = oldRating;
        // for some reason, if event listener is added without a delay, it is firing again on Chrome
        // due to the rating change to oldRating
        setTimeout(() => {
          this.#addRatingListener();
        }, 1000);
        
        notify(`<strong>Error</strong>:</br>${err}`, 'error', -1);
        
      })
  }
*/
  // #addRatingListener = ()=> this.shadowRoot.querySelector('sl-rating')
  //   .addEventListener('sl-change', this.#slRatingChanged)
  // ;

  // #removeRatingListener = ()=> this.shadowRoot.querySelector('sl-rating')
  //   .removeEventListener('sl-change', this.#slRatingChanged)
  // ;  
  
  #itemDeleted = (evt)=>{
    fetch(`/deleteFromCollection/${this.id}`, {
      method: 'DELETE',
    });
    
    const deleteEvent = new CustomEvent('r3-item-deleted');
    this.dispatchEvent(deleteEvent);
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
      img.src = `/getThumbnail?uuid=${this.id}&height=${Math.round(this.height)}`
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

    // enable/disable rating and delete button
    this.shadowRoot.querySelector('sl-rating').disabled = this.selected;
    this.shadowRoot.querySelector('sl-icon-button[name="trash"]').disabled = this.selected;
    
    // enable/disable listeners to update individually
    if(this.selected){
      // disable
      // this.#removeRatingListener();
    
      this.shadowRoot.querySelector('sl-icon-button[name="trash"]')
        .removeEventListener('click', this.#itemDeleted)
      ;
    } else {
      // enable
      // this.#addRatingListener();
    
      this.shadowRoot.querySelector('sl-icon-button[name="trash"]')
        .addEventListener('click', this.#itemDeleted)
      ;
    }
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
