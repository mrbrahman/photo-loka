import {notify} from './utils.mjs';

class PlSlide extends HTMLElement {
  #albumname; #item; #screenWidth; #screenHeight; #play; #slideshowMode;

  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
  }
  
  connectedCallback() {
    this.shadowRoot.appendChild(
      document.getElementById(this.nodeName).content.cloneNode(true)
    );
    
    this.shadowRoot.getElementById('albumname').innerText = this.albumname || '';
    this.shadowRoot.getElementById('rating').setAttribute('value', this.item.data.rating || 0);
    
    this.shadowRoot.getElementById('rating').addEventListener('sl-change', this.#handleRatingChanged);

    this.shadowRoot.getElementById('start-slideshow').addEventListener('click', ()=>{
      this.dispatchEvent(new Event('pl-start-slideshow', {composed: true, bubbles: true}));
    });

    if(this.item.data.type.startsWith('image')){
      let img = Object.assign(document.createElement('img'), {
        src: `/getImage?uuid=${this.item.data.id}&width=${this.#screenWidth}&height=${this.#screenHeight}`
      });

      // let img = document.createElement('img')
      // img.src = `/getImage?uuid=${this.item.data.id}&width=${this.#screenWidth}&height=${this.#screenHeight}`

      this.shadowRoot.getElementById('media').appendChild(img);

    } else if (this.item.data.type.startsWith('video')){
      let video = Object.assign(document.createElement('video'), {
        width: this.#screenWidth,
        height: this.#screenHeight,
        controls: true,
        muted: false,
        preload: 'metadata'
      });

      let src = Object.assign(document.createElement('source'), {
        src: `/getVideo?uuid=${this.item.data.id}`
        // type: this.item.data.type
      });

      let txt = 'Cannot play video';
      video.append(src, txt);

      this.shadowRoot.getElementById('media').appendChild(video);
      video.addEventListener('ended', ()=>{
        this.dispatchEvent(new Event('pl-slideshow-video-ended', {composed: true, bubbles: true}));
      })

    } else {
      this.shadowRoot.getElementById('media').innerHTML = `<div>${this.item.data.type} TBD</div>`
    }
  }

  #handleRatingChanged = (evt) => {
    let item = this.item, newRating = evt.target.value;
    console.log(item);

    if(item.data.rating == newRating){
      return;
    }

    fetch('/updateRating', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        uuid_arr: [item.data.id],
        newRating: evt.detail.newRating
      })
    })
    .then(res=>{
      if(!res.ok){
        throw `${res.status} ${res.statusText}`
      }
    })
    // Update in backend successful, now update the UI
    .then(()=>{
      // update data
      item.data.rating = newRating;

      // update element if one was created
      if(item.elem){
        // there is no listener on the rating element, so we can 
        // safely update here
        item.elem.rating = newRating;
      }

      notify(`Updated rating for this item`, 'success');
    })
    .catch(err=>{
      notify(`<strong>Error</strong>:</br>${err}`, 'error', -1);

      // revert rating on screen (extra for this flow)
      this.shadowRoot.getElementById('rating').value = item.data.rating;
    });

  }

  #playPauseMedia(){
    if(this.item.data.type.startsWith("video")){
      let media = this.shadowRoot.getElementById('media').firstElementChild;
      if(this.play){
        media.play();
      } else {
        media.pause();
      }
    } else {
      // ignore
    }
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

  set play(_){
    this.#play = Boolean(_);  // TODO: fix this
    this.#playPauseMedia();
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
