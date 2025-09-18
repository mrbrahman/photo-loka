import {notify} from './utils.mjs';

class PlSlide extends HTMLElement {
  #albumname; #item; #screenWidth; #screenHeight; #play; #slideshowMode;
  #zoomLevel = 1; #maxZoom = 1; #isDragging = false; #startX = 0; #startY = 0; #translateX = 0; #translateY = 0;

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

    this.#setupZoomControls();

    if(this.item.data.type.startsWith('image')){
      let img = Object.assign(document.createElement('img'), {
        src: `/api/getImage?uuid=${this.item.data.id}&width=${this.#screenWidth}&height=${this.#screenHeight}`
      });
      img.classList.add(this.item.data.ar < this.#screenWidth/this.#screenHeight ? 'full-height' : 'full-width');
      
      img.onload = () => {
        this.#maxZoom = Math.max(img.naturalWidth / img.offsetWidth, img.naturalHeight / img.offsetHeight);
        this.#updateZoomButtons();
      };
      
      this.#setupImageZoom(img);
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
        src: `/api/getVideo?uuid=${this.item.data.id}`
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

    fetch('/api/updateRating', {
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

  #setupZoomControls() {
    const zoomIn = this.shadowRoot.getElementById('zoom-in');
    const zoomOut = this.shadowRoot.getElementById('zoom-out');
    
    zoomIn?.addEventListener('click', () => this.#zoomIn());
    zoomOut?.addEventListener('click', () => this.#zoomOut());
  }

  #setupImageZoom(img) {
    // Touch events for mobile
    let initialDistance = 0;
    let initialZoom = 1;
    
    img.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        initialDistance = this.#getDistance(e.touches[0], e.touches[1]);
        initialZoom = this.#zoomLevel;
      } else if (e.touches.length === 1 && this.#zoomLevel > 1) {
        this.#isDragging = true;
        this.#startX = e.touches[0].clientX - this.#translateX;
        this.#startY = e.touches[0].clientY - this.#translateY;
      }
    });
    
    img.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const currentDistance = this.#getDistance(e.touches[0], e.touches[1]);
        const scale = currentDistance / initialDistance;
        this.#setZoom(Math.min(this.#maxZoom, Math.max(1, initialZoom * scale)));
      } else if (e.touches.length === 1 && this.#isDragging && this.#zoomLevel > 1) {
        e.preventDefault();
        this.#translateX = e.touches[0].clientX - this.#startX;
        this.#translateY = e.touches[0].clientY - this.#startY;
        this.#constrainPan(img);
        this.#updateTransform(img);
      }
    });
    
    img.addEventListener('touchend', () => {
      this.#isDragging = false;
    });
    
    // Mouse events for desktop
    img.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      this.#setZoom(Math.min(this.#maxZoom, Math.max(1, this.#zoomLevel + delta)));
    });
    
    img.addEventListener('mousedown', (e) => {
      if (this.#zoomLevel > 1) {
        this.#isDragging = true;
        this.#startX = e.clientX - this.#translateX;
        this.#startY = e.clientY - this.#translateY;
        img.style.cursor = 'grabbing';
        e.preventDefault();
      }
    });
    
    img.addEventListener('mousemove', (e) => {
      if (this.#isDragging && this.#zoomLevel > 1) {
        this.#translateX = e.clientX - this.#startX;
        this.#translateY = e.clientY - this.#startY;
        this.#constrainPan(img);
        this.#updateTransform(img);
        e.preventDefault();
      } else if (this.#zoomLevel > 1) {
        img.style.cursor = 'grab';
      } else {
        img.style.cursor = 'default';
      }
    });
    
    img.addEventListener('mouseup', () => {
      this.#isDragging = false;
      if (this.#zoomLevel > 1) {
        img.style.cursor = 'grab';
      }
    });
    
    img.addEventListener('mouseleave', () => {
      this.#isDragging = false;
    });
    
    // Double click for desktop
    img.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.#handleDoubleTap();
    });
    
    // Double tap to zoom in/reset
    let lastTap = 0;
    img.addEventListener('touchend', (e) => {
      const currentTime = new Date().getTime();
      const tapLength = currentTime - lastTap;
      if (tapLength < 500 && tapLength > 0) {
        this.#handleDoubleTap();
      }
      lastTap = currentTime;
    });
  }

  #getDistance(touch1, touch2) {
    return Math.sqrt(
      Math.pow(touch2.clientX - touch1.clientX, 2) + 
      Math.pow(touch2.clientY - touch1.clientY, 2)
    );
  }

  #zoomIn() {
    this.#setZoom(Math.min(this.#maxZoom, this.#zoomLevel + 0.25));
  }

  #zoomOut() {
    this.#setZoom(Math.max(1, this.#zoomLevel - 0.25));
  }

  #setZoom(newZoom) {
    this.#zoomLevel = newZoom;
    const img = this.shadowRoot.querySelector('#media img');
    if (img) {
      if (this.#zoomLevel === 1) {
        this.#translateX = 0;
        this.#translateY = 0;
      }
      this.#updateTransform(img);
      this.#updateZoomButtons();
    }
  }

  #resetZoom() {
    this.#zoomLevel = 1;
    this.#translateX = 0;
    this.#translateY = 0;
    const img = this.shadowRoot.querySelector('#media img');
    if (img) {
      this.#updateTransform(img);
      this.#updateZoomButtons();
    }
  }

  #updateTransform(img) {
    img.style.transform = `scale(${this.#zoomLevel}) translate(${this.#translateX / this.#zoomLevel}px, ${this.#translateY / this.#zoomLevel}px)`;
    img.style.transformOrigin = 'center center';
    img.style.cursor = this.#zoomLevel > 1 ? 'grab' : 'default';
  }

  #updateZoomButtons() {
    const zoomIn = this.shadowRoot.getElementById('zoom-in');
    const zoomOut = this.shadowRoot.getElementById('zoom-out');
    
    if (zoomIn) zoomIn.disabled = this.#zoomLevel >= this.#maxZoom;
    if (zoomOut) zoomOut.disabled = this.#zoomLevel <= 1;
  }

  #constrainPan(img) {
    const scaledWidth = img.offsetWidth * this.#zoomLevel;
    const scaledHeight = img.offsetHeight * this.#zoomLevel;
    const containerWidth = this.#screenWidth;
    const containerHeight = this.#screenHeight;
    
    const maxTranslateX = Math.max(0, (scaledWidth - containerWidth) / 2);
    const maxTranslateY = Math.max(0, (scaledHeight - containerHeight) / 2);
    
    this.#translateX = Math.max(-maxTranslateX, Math.min(maxTranslateX, this.#translateX));
    this.#translateY = Math.max(-maxTranslateY, Math.min(maxTranslateY, this.#translateY));
  }

  #handleDoubleTap() {
    if (this.#zoomLevel >= this.#maxZoom) {
      this.#resetZoom();
    } else {
      const nextZoom = Math.min(this.#maxZoom, this.#zoomLevel * 2);
      this.#setZoom(nextZoom);
    }
  }

}

window.customElements.define('pl-slide', PlSlide);
