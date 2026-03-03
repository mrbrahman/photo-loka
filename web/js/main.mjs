import 'https://unpkg.com/navigo';

// cherry-pick shoelace components
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/icon/icon.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/icon-button/icon-button.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/rating/rating.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/alert/alert.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/dropdown/dropdown.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/menu-item/menu-item.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/menu/menu.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/progress-bar/progress-bar.js'
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/dialog/dialog.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/input/input.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/button/button.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/select/select.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/option/option.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/details/details.js';
import 'https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.1/cdn/components/badge/badge.js';

import {notify, showProgressBar, hideProgressBar} from './utils.mjs';

import './pl-thumb.js';
import './pl-album.js';
import './pl-album-name.js';
import './pl-gallery.js';
import './pl-gallery-controls.js';
import './pl-slide.js';
import './pl-slideshow.js';
import './pl-map.js';
import './pl-carousel.js';
import './pl-frame-item.js';
import './pl-frame-manager.js';

const router = new Navigo('/', {hash: true});

let state = {};

state.collection_id = 1; // until UI is implemented

// PWA install prompt handling
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

// Optional: Add install button functionality
function showInstallPrompt() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then((choiceResult) => {
      deferredPrompt = null;
    });
  }
}

// found at https://tutorial.eyehunts.com/js/call-javascript-function-on-enter-keypress-in-the-textbox-example-code/
let searchBox = document.getElementById("nav-search-box");
searchBox.addEventListener("keyup", function (e) {
 if (e.key === "Enter") {  
  performSearch()
 }
});

function performSearch(){
  let searchText = document.getElementById("nav-search-box").value;
  if(!searchText){
    alert("Enter search text");
    return;
  }
  router.navigate(`/search/${encodeURIComponent(searchText)}`)
}


function showGallery(data){
  state.galleryData = data;
  // window.galleryData = data;
  let c = document.getElementById('main-content');
  c.style.overflowY = 'hidden';
  
  if(data.length == 0){
    c.innerHTML = "No results found";
    return;
  }
  
  document.getElementById("nav-search-box").blur();

  let g = Object.assign(document.createElement('pl-gallery'), { data });
  
  c.innerHTML = "";
  c.appendChild(g);

  notify(`Found ${data.length.toLocaleString()} albums containing ${data.map(x=>x.items.length).reduce((a,c)=>a+c).toLocaleString()} items`);
}

document.getElementById('app').addEventListener('pl-slideshow-request', (evt)=>{
  state.galleryData = evt.detail.data;
  router.navigate(`/slideshow/${evt.detail.startFrom}`)
});

document.getElementById('app').addEventListener('pl-slideshow-closed', ()=>{
  router.navigate(state.prevLink[0].url);
});

document.getElementById('app').addEventListener('pl-map-item-click', async (evt)=>{
  // Fetch the item data and navigate to slideshow
  try {
    const response = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({collection_id: state.collection_id, searchText: `uuid:${evt.detail.uuid}`})
    });
    const result = await response.json();
    if (result.length > 0 && result[0].items.length > 0) {
      state.galleryData = result;
      router.navigate(`/slideshow/0`);
    }
  } catch (error) {
    console.error('Error loading item for slideshow:', error);
  }
});

// 
// router paths
// 

router.on('/', function(){
  if(document.querySelector('pl-slideshow')){
    document.querySelector('pl-slideshow').remove();

    document.getElementById('nav-header').style.opacity = 1;
    document.getElementById('main-content').style.opacity = 1;
    return;
  }
  
  showProgressBar();

  fetch('/api/getAll')
  .then(res=>{
    if(!res.ok){
      throw `${res.status} ${res.statusText}`
    }
    return res.json();
  })
  .then(result=>{
    showGallery(result);
    hideProgressBar();
  })
  .catch(err=>{
    notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);

  });
});

router.on('/search/:searchText', function(p){
  // TODO: eliminate duplicate code
  if(document.querySelector('pl-slideshow')){
    document.querySelector('pl-slideshow').remove();

    document.getElementById('nav-header').style.opacity = 1;
    document.getElementById('main-content').style.opacity = 1;
    return;
  }

  showProgressBar();

  fetch('/api/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({collection_id: state.collection_id, searchText: p.data.searchText})
  })
  .then(res=>{
    if(!res.ok){
      throw `${res.status} ${res.statusText}`
    }
    return res.json();
  })
  .then(result=>{
    showGallery(result);
    hideProgressBar();
  })
  .catch(err=>{
    notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);

  });
});

router.on('/map', function(){
  
  let c = document.getElementById('main-content');
  let mapComponent = document.createElement('pl-map');
  
  c.innerHTML = "";
  c.style.overflowY = 'hidden';
  c.appendChild(mapComponent);
});

router.on('/frames', function(){
  let c = document.getElementById('main-content');
  let framesManager = document.createElement('pl-frame-manager');
  
  c.innerHTML = "";
  c.style.overflowY = 'auto';
  c.appendChild(framesManager);
});

router.on('/slideshow/:startFrom', function(p){
  state.prevLink = router.lastResolved();
  
  document.getElementById('nav-header').style.opacity = 0;
  document.getElementById('main-content').style.opacity = 0;

  let s = Object.assign(document.createElement('pl-slideshow'), {
    data: state.galleryData,
    startFrom: p.data.startFrom,
    buffer: 1
  });

  // attaching this under app (not under main-content)
  document.getElementById('app').appendChild(s);
})

router.resolve();
