export class MediaRenderer {
  constructor(component) {
    this.component = component;
  }

  renderMedia() {
    if(this.component.item.data.type.startsWith('image')){
      this.renderImage();
    } else if (this.component.item.data.type.startsWith('video')){
      this.renderVideo();
    } else {
      this.component.shadowRoot.getElementById('media').innerHTML = `<div>${this.component.item.data.type} TBD</div>`
    }
  }

  renderImage() {
    let img = Object.assign(document.createElement('img'), {
      src: `/api/getImage?uuid=${this.component.item.data.id}&width=${this.component.screenWidth}&height=${this.component.screenHeight}`
    });
    img.classList.add(this.component.item.data.ar < this.component.screenWidth/this.component.screenHeight ? 'full-height' : 'full-width');
    
    img.onload = () => {
      this.component.zoomHandler.maxZoom = Math.max(img.naturalWidth / img.offsetWidth, img.naturalHeight / img.offsetHeight);
      this.component.zoomHandler.updateZoomButtons();
    };
    
    this.component.zoomHandler.setupImageZoom(img);
    this.component.shadowRoot.getElementById('media').appendChild(img);
  }

  renderVideo() {
    let video = Object.assign(document.createElement('video'), {
      width: this.component.screenWidth,
      height: this.component.screenHeight,
      controls: true,
      muted: false,
      preload: 'metadata'
    });

    let src = Object.assign(document.createElement('source'), {
      src: `/api/getVideo?uuid=${this.component.item.data.id}`
      // type: this.item.data.type
    });

    let txt = 'Cannot play video';
    video.append(src, txt);

    this.component.shadowRoot.getElementById('media').appendChild(video);
    video.addEventListener('ended', ()=>{
      this.component.dispatchEvent(new Event('pl-slideshow-video-ended', {composed: true, bubbles: true}));
    })
  }

  playPauseMedia(){
    if(this.component.item.data.type.startsWith("video")){
      let media = this.component.shadowRoot.getElementById('media').firstElementChild;
      if(this.component.play){
        media.play();
      } else {
        media.pause();
      }
    } else {
      // ignore
    }
  }
}