export class EventHandler {
  constructor(component) {
    this.component = component;
  }

  handleSlideshowEscape = (evt) =>{
    if(evt.key == "Escape"){
      this.slideshowClosed();
    // } else if(evt.key == "A" || evt.key == "a"){
    //   // toggle album name
    //   console.log('pl-slieshow a or A pressed')
    } else {
      // ignore all other keys
      // console.log(evt.key)
    }
  }

  slideshowClosed = ()=>{
    this.component.dispatchEvent(new Event('pl-slideshow-closed', {composed: true, bubbles: true}));
  }

  handleRightArrow = (evt)=>{
    if(evt.key == "ArrowRight"){
      this.component.navigationHandler.next();

      // if slideshowmode, reset timer
      if(this.component.slideshowMode){
        this.component.slideshowController.resetTimer();
      }
    } else {
      // ignore
    }
  }

  handleLeftArrow = (evt)=>{
    if(evt.key == "ArrowLeft"){
      this.component.navigationHandler.prev();

      // if slideshowmode, reset timer
      if(this.component.slideshowMode){
        this.component.slideshowController.resetTimer();
      }
    } else {
      // ignore
    }
  }

  setupEventListeners() {
    this.component.shadowRoot.getElementById('close').addEventListener('click', this.slideshowClosed);

    this.component.shadowRoot.getElementById('next').addEventListener('click', ()=>this.component.navigationHandler.next());
    this.component.shadowRoot.getElementById('prev').addEventListener('click', ()=>this.component.navigationHandler.prev());
    
    this.component.addEventListener('fullscreenchange', this.component.slideshowController.slideshowToggle);
    this.component.addEventListener('pl-start-slideshow', ()=>{
      this.component.requestFullscreen();
    });

    this.component.addEventListener('pl-slideshow-video-ended', ()=>{
      if(this.component.slideshowMode && this.component.shadowRoot.getElementById('slides').querySelector('[data-pos="1"]')){
        this.component.slideshowController.startTimer();
        this.component.navigationHandler.next();
      }
    })

    window.addEventListener('keydown', this.handleRightArrow);
    window.addEventListener('keydown', this.handleLeftArrow);
    window.addEventListener('keyup', this.handleSlideshowEscape);
  }

  removeEventListeners() {
    window.removeEventListener('keydown', this.handleRightArrow);
    window.removeEventListener('keydown', this.handleLeftArrow);
    window.removeEventListener('keyup', this.handleSlideshowEscape);
  }
}