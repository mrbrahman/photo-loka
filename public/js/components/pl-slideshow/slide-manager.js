export class SlideManager {
  constructor(component) {
    this.component = component;
  }

  createSlide(idx) {
    let slide = Object.assign(document.createElement('pl-slide'), {
      albumname: this.component.data[idx[0]].album,
      item: this.component.data[idx[0]].items[idx[1]],
      screenDimensions: [this.component.screenWidth, this.component.screenHeight]
    });

    slide.dataset.type = this.component.data[idx[0]].items[idx[1]].data.type;
    return slide;
  }

  initializeSlides() {
    let slide = this.createSlide(this.component.startIdx);
    slide.classList.add('active');
    slide.dataset.pos = 0;
    slide.dataset.idx = this.component.startIdx.toString();
    slide.slideshowMode = this.component.slideshowMode;
    this.component.shadowRoot.getElementById('slides').append(slide);
    if(slide.dataset.type.startsWith('video')){
      slide.play = true;
    }

    // paint subsequent slides first (assume the default direction is ltr)
    let currIdx = this.component.startIdx;
    for(let i=1; i<=this.component.buffer; i++){
      let nextIdx = this.component.navigationHandler.nextIdx(currIdx);
      if(nextIdx){
        let nextSlide = this.createSlide(nextIdx);
        nextSlide.classList.add('right');
        nextSlide.dataset.pos = i;
        nextSlide.dataset.idx = nextIdx.toString();
        this.component.shadowRoot.getElementById('slides').append(nextSlide);
        
        currIdx = nextIdx;
      } else {
        break;
      }
    }

    // now paint previous slides
    currIdx = this.component.startIdx;
    for(let i=-1; i>=-this.component.buffer; i--){
      let prevIdx = this.component.navigationHandler.prevIdx(currIdx);
      if(prevIdx){
        let prevSlide = this.createSlide(prevIdx);
        prevSlide.classList.add('left');
        prevSlide.dataset.pos = i;
        prevSlide.dataset.idx = prevIdx.toString();
        this.component.shadowRoot.getElementById('slides').append(prevSlide);

        currIdx = prevIdx;
      } else {
        break;
      }
    }
  }
}