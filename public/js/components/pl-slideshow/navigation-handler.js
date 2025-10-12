export class NavigationHandler {
  constructor(component) {
    this.component = component;
  }

  // Adapted from https://stackoverflow.com/a/16102526/8098748
  getIndexOfK(arr, k) {
    for (var i = 0; i < arr.length; i++) {
      var index = arr[i].items.findIndex(e=>e.data.id==k);
      if (index > -1) {
        return [i, index];
      }
    }
  }

  nextIdx(idx) {
    let arr = this.component.data;

    if(arr[idx[0]].items[idx[1]+1]){
      return [idx[0], idx[1]+1];  // next item in the current album
    } else if(arr[idx[0]+1]) {
      return [idx[0]+1, 0]        // first item in the next album
    } else {
      if(this.component.loop){
        return [0,0];             // first item of the first album
      }
      return undefined;
    }
  }

  prevIdx(idx) {
    let arr = this.component.data;
    
    if(arr[idx[0]].items[idx[1]-1]){
      return [idx[0], idx[1]-1];  // previous item in the current album
    } else if (arr[idx[0]-1]) {
      return [idx[0]-1, arr[idx[0]-1].items.length - 1] // last item in the previous album
    } else {
      if(this.component.loop){
        return [this.component.data.length-1, this.component.data[this.component.data.length-1].items.length-1] // last item of the last album
      }
      return undefined;
    }
  }

  next() {
    // first make DOM changes visible to user
    let activeSlide = this.component.shadowRoot.getElementById('slides').querySelector('[data-pos="0"]');
    if(activeSlide.dataset.type.startsWith('video')){
      activeSlide.play = false;
    }
    activeSlide.classList.add('left');
    activeSlide.classList.remove('active');

    let nextSlide = this.component.shadowRoot.getElementById('slides').querySelector('[data-pos="1"]');
    nextSlide.classList.add('active');
    nextSlide.classList.remove('right');
    nextSlide.slideshowMode = this.component.slideshowMode;

    if(nextSlide.dataset.type.startsWith('video')){
      nextSlide.play = true;
      if(this.component.slideshowMode){
        this.component.slideshowController.stopTimer();
      }
    }

    // now make DOM changes that are not visibile to the user
    for(let i=-this.component.buffer; i<=this.component.buffer; i++){
      
      let slide = this.component.shadowRoot.getElementById('slides').querySelector(`[data-pos="${i}"]`);

      if(!slide){
        continue;
      }

      if(i == -this.component.buffer){
        // remove slide at the left
        slide.remove();
      } else {
        // adjust positions for the remaining
        slide.dataset.pos = i-1;

        // add a slide at the end, use the 'idx' from the slide previously at 'buffer' position
        if(i == this.component.buffer){
          let nextIdx = this.nextIdx( slide.dataset.idx.split(',').map(x=>parseInt(x)) );
          
          if(nextIdx){
            let slide = this.component.slideManager.createSlide(nextIdx);
            slide.classList.add('right');
            slide.dataset.pos = this.component.buffer;
            slide.dataset.idx = nextIdx.toString();
            this.component.shadowRoot.getElementById('slides').append(slide);
          } else {
            // we've reached the end of slide show
          }
        }
      }
    } // for loop

    this.updateNavigationButtons();
  }

  prev() {
    // first make DOM changes visible to user
    let activeSlide = this.component.shadowRoot.getElementById('slides').querySelector('[data-pos="0"]');
    if(activeSlide.dataset.type.startsWith('video')){
      activeSlide.play = false;
    }
    activeSlide.classList.add('right');
    activeSlide.classList.remove('active');

    let prevSlide = this.component.shadowRoot.getElementById('slides').querySelector('[data-pos="-1"]');
    prevSlide.classList.add('active');
    prevSlide.classList.remove('left');
    prevSlide.slideshowMode = this.component.slideshowMode;
    if(prevSlide.dataset.type.startsWith('video')){
      prevSlide.play = true;
    }

    // now make DOM changes that are not visibile to the user
    for(let i=this.component.buffer; i>=-this.component.buffer; i--){
      
      let slide = this.component.shadowRoot.getElementById('slides').querySelector(`[data-pos="${i}"]`);

      if(!slide){
        continue;
      }

      if(i == this.component.buffer){
        // remove slide at the right
        slide.remove();
      } else {
        // adjust positions for the remaining
        slide.dataset.pos = i+1;

        // add a slide at the end, use the 'idx' from the slide previously at 'buffer' position
        if(i == -this.component.buffer){
          let prevIdx = this.prevIdx( slide.dataset.idx.split(',').map(x=>parseInt(x)) );
          
          if(prevIdx){
            let slide = this.component.slideManager.createSlide(prevIdx);
            slide.classList.add('left');
            slide.dataset.pos = -this.component.buffer;
            slide.dataset.idx = prevIdx.toString();
            this.component.shadowRoot.getElementById('slides').append(slide);
          } else {
            // we've reached the end of slide show
          }
        }
      }
    } // for loop

    this.updateNavigationButtons();
  }

  updateNavigationButtons() {
    // remove next if there is no slide to show
    if(!this.component.shadowRoot.getElementById('slides').querySelector('[data-pos="1"]')){
      this.component.shadowRoot.getElementById('next').style.display = 'none';
      window.removeEventListener('keydown', this.component.eventHandler.handleRightArrow);
    }

    // enable the prev button if it was removed before
    if(this.component.shadowRoot.getElementById('prev').style.display == 'none'){
      this.component.shadowRoot.getElementById('prev').style.display = 'block';
      window.addEventListener('keydown', this.component.eventHandler.handleLeftArrow);
    }

    // remove prev if there is no slide to show
    if(!this.component.shadowRoot.getElementById('slides').querySelector('[data-pos="-1"]')){
      this.component.shadowRoot.getElementById('prev').style.display = 'none';
      window.removeEventListener('keydown', this.component.eventHandler.handleLeftArrow);
    }

    // enable the next button if it was removed before
    if(this.component.shadowRoot.getElementById('next').style.display == 'none'){
      this.component.shadowRoot.getElementById('next').style.display = 'block';
      window.addEventListener('keydown', this.component.eventHandler.handleRightArrow);
    }
  }
}