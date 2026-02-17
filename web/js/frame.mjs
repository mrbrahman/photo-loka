// cherry-pick shoelace components
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/icon/icon.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/icon-button/icon-button.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/rating/rating.js';

import './pl-slide.js';

// request full screen
// document.documentElement.requestFullscreen();

let paused = false;
let itemTimer = null;

function loop(){
  if (paused) return;
  
  fetch('/frame/getNext').then(response => response.json()).then(data => {
    // Create new slide, initially hidden
    let slide = Object.assign(document.createElement('pl-slide'), {
      albumname: data.album,
      item: data.item,
      slideshowMode: true
    });
    slide.style.opacity = '0';

    slide.dataset.type = data.item.data.type;

    slide.addEventListener('pl-slide-ready', () => {
      // Fade out and remove old slide
      let oldSlide = document.querySelector('pl-slide[data-visible]');
      if (oldSlide) {
        oldSlide.style.transition = 'opacity 0.5s';
        oldSlide.style.opacity = '0';
        setTimeout(() => oldSlide.remove(), 500);
      }
      // Fade in new slide
      slide.dataset.visible = 'true';
      slide.style.transition = 'opacity 0.5s';
      slide.style.opacity = '1';

      // For images, advance after 4 seconds
      if (data.item.data.type.startsWith('image')) {
        itemTimer = setTimeout(loop, 4000);
      } else if (data.item.data.type.startsWith('video')) {
        // For videos, advance when video ends
        slide.addEventListener('pl-slideshow-video-ended', loop, { once: true });
      } 
    }, { once: true });


    document.body.appendChild(slide);
    if(data.item.data.type.startsWith('video')){
      slide.play = true;
    }
  });
}

// Pause when window loses focus
window.addEventListener('blur', () => {
  paused = true;
  if (itemTimer) {
    clearTimeout(itemTimer);
    itemTimer = null;
  }
  // // Pause video if playing
  // let currentSlide = document.querySelector('pl-slide[data-visible]');
  // if(currentSlide?.dataset.type.startsWith('video')) {
  //   currentSlide.play = false;
  // }
});

// Resume when window gains focus
window.addEventListener('focus', () => {
  if (paused) {
    paused = false;
    let currentSlide = document.querySelector('pl-slide[data-visible]');
    if (currentSlide) {
      // // Resume video if it was playing
      // if(currentSlide.dataset.type.startsWith('video')) {
      //   currentSlide.play = true;
      // }
      // For images, restart the timer
      if (currentSlide.item?.data?.type?.startsWith('image')) {
        itemTimer = setTimeout(loop, 4000);
      }
    } else {
      // No current slide, start fresh
      loop();
    }
  }
});

loop();

