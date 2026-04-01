// cherry-pick shoelace components
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/icon/icon.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/icon-button/icon-button.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/rating/rating.js';

import './components/pl-slide.js';
import './components/pl-slide-media.js';
import './components/pl-item-info.js';

const IMAGE_DISPLAY_DURATION = 7000;

// request full screen
// document.documentElement.requestFullscreen();

let paused = false;
let itemTimer = null;
let errorDiv = null;
let eventSource = null;
let wakeLock = null;

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { /* silently ignore */ }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}

async function fetchNextItem() {
  const res = await fetch('/frame/getNext');
  const output = await res.json();
  
  if (!res.ok) {
    if (res.status === 423) {
      const error = { message: output.error?.message || 'Frame is paused'};
      throw error;
    }
    throw new Error(output.error?.message || `Server error: ${res.status}`);
  }
  
  return output;
}

function showError(message) {
  clearError();
  errorDiv = document.createElement('div');
  errorDiv.textContent = message;
  errorDiv.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,0.8); color: white; padding: 20px; border-radius: 8px; z-index: 9999;';
  document.body.appendChild(errorDiv);
}

function clearError() {
  if (errorDiv) {
    errorDiv.remove();
    errorDiv = null;
  }
}

function setupSSE() {
  eventSource = new EventSource('/frame/events');
  
  eventSource.onopen = () => {
    console.log('SSE connection opened');
    // If we were paused due to server being down, resume
    if (paused) {
      console.log('Server reconnected, resuming slideshow');
      paused = false;
      clearError();
      requestWakeLock();
      let currentSlide = document.querySelector('pl-slide[data-visible]');
      if (currentSlide?.item?.data?.type?.startsWith('image')) {
        itemTimer = setTimeout(loop, IMAGE_DISPLAY_DURATION);
      } else {
        loop();
      }
    }
  };
  
  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    if (data.type === 'resume') {
      console.log('Resume signal received from server');
      if (paused) {
        paused = false;
        clearError();
        requestWakeLock();
        let currentSlide = document.querySelector('pl-slide[data-visible]');
        if (currentSlide?.item?.data?.type?.startsWith('image')) {
          itemTimer = setTimeout(loop, IMAGE_DISPLAY_DURATION);
        } else {
          loop();
        }
      }
    } else if (data.type === 'pause') {
      console.log('Pause signal received from server');
      if (!paused) {
        paused = true;
        releaseWakeLock();
        if (itemTimer) {
          clearTimeout(itemTimer);
          itemTimer = null;
        }
        showError('Frame paused');
      }
    }
  };
  
  eventSource.onerror = (err) => {
    // Browser automatically reconnects, just log once
    if (eventSource.readyState === EventSource.CONNECTING) {
      console.log('SSE reconnecting...');
    } else if (eventSource.readyState === EventSource.CLOSED) {
      console.error('SSE connection closed, will retry...');
      eventSource.close();
      setTimeout(setupSSE, 3000);
    }
  };
}

function loop(){
  if (paused) return;
  
  clearError();
  
  fetchNextItem()
  .then(data => {
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
        itemTimer = setTimeout(loop, IMAGE_DISPLAY_DURATION);
      } else if (data.item.data.type.startsWith('video')) {
        // For videos, advance when video ends
        slide.addEventListener('pl-slideshow-video-ended', loop, { once: true });
      } 
    }, { once: true });


    document.body.appendChild(slide);
    if(data.item.data.type.startsWith('video')){
      slide.play = true;
    }
  })
  .catch(err => {
    console.error('Failed to fetch next item:', err);
    paused = true;
    showError(err.message || 'Something went wrong while fetching the next item.');
  });
}

// Pause when page becomes hidden
document.addEventListener('visibilitychange', () => {
  // console.log(`${(new Date()).toTimeString()} Visibility changed: ${document.hidden ? 'hidden' : 'visible'}`);
  if (document.hidden) {
    paused = true;
    releaseWakeLock();
    if (itemTimer) {
      clearTimeout(itemTimer);
      itemTimer = null;
    }

  } else if (paused) {
    paused = false;
    requestWakeLock();
    let currentSlide = document.querySelector('pl-slide[data-visible]');
    if (currentSlide) {
      // For images, restart the timer
      if (currentSlide.item?.data?.type?.startsWith('image')) {
        itemTimer = setTimeout(loop, IMAGE_DISPLAY_DURATION);
      }
    } else {
      // No current slide, start fresh
      // Would the flow ever come here?
      loop();
    }
  }
});

setupSSE();
requestWakeLock();
loop();

