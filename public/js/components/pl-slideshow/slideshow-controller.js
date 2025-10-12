export class SlideshowController {
  constructor(component) {
    this.component = component;
  }

  slideshowToggle = () => {
    if(document.fullscreenElement){
      // start slideshow

      // change the state of this (pl-slideshow) element
      this.component.slideshowMode = true;
      this.component.shadowRoot.getElementById('navigation').style.visibility = 'hidden';
      
      // now initiate changes to the current slide being shown, and start slideshow
      let slide = this.component.shadowRoot.getElementById('slides').querySelector('[data-pos="0"]');
      slide.slideshowMode = true;
      this.startTimer();

    } else {
      this.component.slideshowMode = false;
      this.component.shadowRoot.getElementById('navigation').style.visibility = 'visible';

      let slide = this.component.shadowRoot.getElementById('slides').querySelector('[data-pos="0"]');
      slide.slideshowMode = false;
      this.stopTimer();
    }
  }

  startTimer() {
    this.component.intervalId = setInterval(()=>{
      if(this.component.shadowRoot.getElementById('slides').querySelector('[data-pos="1"]')){
        this.component.navigationHandler.next()
      } else {
        // this.stopTimer();
        document.exitFullscreen();
      }
    }, this.component.slideDuration*1000);
  }

  stopTimer() {
    clearInterval(this.component.intervalId);
  }

  resetTimer() {
    this.stopTimer();
    this.startTimer();
  }
}