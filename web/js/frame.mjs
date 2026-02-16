// cherry-pick shoelace components
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/icon/icon.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/icon-button/icon-button.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/rating/rating.js';

import './pl-slide.js';

// request full screen
// document.documentElement.requestFullscreen();

function loop(){
  fetch('/frame/getNext').then(response => response.json()).then(data => {
    // Create new slide, initially hidden
    let slide = Object.assign(document.createElement('pl-slide'), {
      albumname: data.album,
      item: data.item,
      slideshowMode: true
    });
    slide.style.opacity = '0';

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

      // For images, advance after 3 seconds
      if (data.item.data.type.startsWith('image')) {
        setTimeout(loop, 3000);
      }
    }, { once: true });

    // For videos, advance when video ends
    slide.addEventListener('pl-slideshow-video-ended', loop, { once: true });

    document.body.appendChild(slide);
  });
}

loop();

