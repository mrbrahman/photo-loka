// many web component practices adapted from: https://dev.to/dannyengelman/web-component-102-the-5-lessons-after-learning-web-components-101-h9p

// some functional (logic) concepts adapted from https://github.com/schlosser/pig.js/ and further expanded for multiple albums

// e.g. TBD
// <pl-gallery ></pl-gallery>

// The basic design is:
//
// 1. Gallery is responsibile for creating albums
// 2. When any item is selected/de-selected, gallery is also responsible for 
//    the creation and removal of gallery controls
// 3. Gallery controls is a dummy component which is mainly used for user interaction only
// 4. Since item selection can happen from multiple albums, gallery will own all backend changes
//    related to selected items
// 5. Album will only be responsible for paiting of UI
// 6. The only exception is 'album name' component, which can also update the backend. But
//    that is fine, since the album name update does not span multiple albums

import {debounce, throttle, notify} from './utils.mjs';

class PlGallery extends HTMLElement {

  // internal variables
  #albums = []; #albumsInBuffer = {}; #albumsSelectedCnt = {}; #itemsSelected = [];
  // variables that can be get/set
  #data;

  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
  }

  connectedCallback() {

    this.shadowRoot.appendChild(
      document.getElementById(this.nodeName).content.cloneNode(true)
    );
    // console.log("logging data... ")
    // console.log(this.data);

    this.#albums = this.data.map(d=>{

      let album = Object.assign(document.createElement('pl-album'), {
        id: d.id,
        album_name: d.album,
        data: d.items,
        width: this.shadowRoot.getElementById('gallery').clientWidth
      });

      // TODO: Can we have gallery listen to these events rather than individual albums?
      this.#addAlbumEventListeners(album);
    
      return album;
    });

    this.shadowRoot.getElementById('gallery').append(...this.#albums);
    this.#reAssignAlbumPositions();
    this.#selectivelyPaintAlbums();

    this.addEventListener('pl-gallery-item-clicked', (evt)=>{
      evt.stopPropagation();

      this.dispatchEvent(new CustomEvent('pl-slideshow-request', {
        composed: true,
        bubbles: true,
        detail: {
          data: this.#albums.map(x=>{
            return {
              album: x.album_name, 
              items: x.data
            }
          }),
          startFrom: evt.detail.id
        }
      }))
    })

    this.shadowRoot.getElementById('gallery')
      .addEventListener('scroll', this.#throttleHandleScroll)
    ;
    
    window.addEventListener('resize', this.#throttleHandleResize)
    ;
  }

  // TODO: can we add only one set of listeners to all albums?
  #addAlbumEventListeners = (album)=>{
    album.addEventListener('pl-album-height-changed', this.#handleAlbumHeightChange);
    album.addEventListener('pl-album-empty', this.#removeAlbum);
    album.addEventListener('pl-album-item-selected', this.#handleItemsSelected);
    album.addEventListener('pl-album-move-selected-items', (evt)=>{
      this.#createOrMoveSelectedItems(evt.detail.newAlbumName.trim())
    });
  }

  #handleItemsSelected = (evt)=>{
    let {selectAlbum, selected, selectedItems} = evt.detail;

    // update the list with the ones selected/de-selected
    if(selected){
      // TODO: edge case - if the album is first selected, then the album name is changed, that changed 
      // album name is not going to be reflected in here. Need to think of a different design
      
      this.#albumsSelectedCnt[selectAlbum] =  this.#albumsSelectedCnt[selectAlbum] || 0 + selectedItems.length;
      this.#itemsSelected.push(...selectedItems);
    } else {
      this.#albumsSelectedCnt[selectAlbum] -= selectedItems.length;
      // remove selectedItems from this.#itemsSelected
      // https://stackoverflow.com/a/47017949/8098748
      this.#itemsSelected = this.#itemsSelected.filter(function(a) {
        return !selectedItems.find(function(b) {
          return a.data.id === b.data.id
        })
      })
    }

    if(this.#itemsSelected.length > 0){
      
      if(!document.body.querySelector('pl-gallery-controls')){
        let c = document.createElement('pl-gallery-controls');
        document.body.append(c);

        c.addEventListener('pl-gallery-controls-closed', this.#handleGalleryControlsClosed);
        c.addEventListener('pl-gallery-controls-rating-changed', this.#handleGalleryControlsRatingChanged);
        c.addEventListener('pl-gallery-controls-delete-pressed', this.#handleGalleryControlsDeletePressed);
        c.addEventListener('pl-gallery-controls-dialog-save', (evt)=>{
          this.#createOrMoveSelectedItems(evt.detail.trim())
        });
      }

      let c = document.body.querySelector('pl-gallery-controls');
      c.ctr = this.#itemsSelected.length;
      c.selectedAlbums = this.#albumsSelectedCnt;

      let distinctRatings = [... new Set(this.#itemsSelected.map(x=>x.data.rating))]

      // if all selected items have the same rating, then set the value to that rating.
      // otherwise don't set the rating
      if (distinctRatings.length == 1){
        c.rating = distinctRatings[0]
      } else {
        c.rating = 0
      }

      
    } else if(this.#itemsSelected.length == 0){
      this.#removeGalleryControls();
    }
  }

  #createOrMoveSelectedItems = async (targetAlbumName)=>{
    let allAlbumNames = this.#albums.map(x=>x.album_name);
  
    try {
      // first save in backend
      await fetch('/moveItems', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          collection_id: 1,   // TODO: remove hardcoding
          uuid_arr: this.#itemsSelected.map(x=>x.data.id),
          new_album_name: targetAlbumName
        })
      })
      .then(res=>{
        if(!res.ok){
          throw `${res.status} ${res.statusText}`
        }
      });

      // now update UI
      // TODO: Find if the item is already in the targetAlbum, and if yes, ignore

      // first delete selected items from current album(s)
      // this only deletes the references to the selected items from the source albums
      // the selected items are also in the selectedItems list
      this.#albums.forEach(album=>album.deleteSelectedItems());

      // now add them to the target album
      if(allAlbumNames.includes(targetAlbumName)){
        // album exists, just move the items there
        let targetAlbum = this.#albums.find(x=>x.album_name == targetAlbumName);
        targetAlbum.addNewItems(this.#itemsSelected);

      } else {
        // create new album
        let newAlbum = Object.assign(document.createElement('pl-album'), {
          id: targetAlbumName.replaceAll(/[\s/]/gi, '_'),
          album_name: targetAlbumName,
          data: this.#itemsSelected,
          width: this.shadowRoot.getElementById('gallery').clientWidth
        });

        this.#addAlbumEventListeners(newAlbum);

        // find where to insert the new album element
        allAlbumNames.push(targetAlbumName);
        allAlbumNames.sort().reverse();
        // before ['a', 'b', 'c', 'd']   now insert in position 2
        // after ['a', 'b', 'b-new', 'c', 'd']
        let i = allAlbumNames.indexOf(targetAlbumName);
        if(i==this.#albums.length){
          // insert at the end of the current album list, and make DOM changes
          this.#albums.push(newAlbum);
          this.shadowRoot.getElementById('gallery').appendChild(newAlbum);
        } else {
          // need to insert in the middle
          this.#albums.splice(i, 0, newAlbum);
          let el = this.shadowRoot.getElementById('gallery').querySelector(`:nth-child(${i+1})`); // css index starts with 1
          el.insertAdjacentElement('beforebegin', newAlbum);

        }
      }

      this.#reAssignAlbumPositions();
      this.#selectivelyPaintAlbums();

      notify(`${this.#itemsSelected.length} item${this.#itemsSelected.length > 1 ? 's' : ''} moved`, 'success');

      // We don't want to keep the items selected, hence force gallery controls close
      this.#handleGalleryControlsClosed();



    } catch (err) {
      notify(`<strong>Error</strong>:</br>${err}`, 'error', -1);
    }

  }

  #handleGalleryControlsClosed = ()=>{
    this.#albums.forEach(album=>{
      album.unselectSelectedItems();
    });
    
    this.#removeGalleryControls();
  }
  
  #removeGalleryControls = ()=>{
    this.#itemsSelected = []; this.#albumsSelectedCnt = {};

    let c = document.body.querySelector('pl-gallery-controls');
    c.remove();
  }

  #handleGalleryControlsRatingChanged = (evt)=>{
    // update db here
    fetch('/updateRating', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        uuid_arr: this.#itemsSelected.map(x=>x.data.id),
        newRating: evt.detail.newRating
      })
    })
    .then(res=>{
      if(!res.ok){
        throw `${res.status} ${res.statusText}`
      }
    })
    .then(()=>{
      // and then, just update UI
      this.#albums.forEach(album=>{
        album.changeRatingSelectedItems(evt.detail.newRating);
      });

      notify(`Updated rating for ${this.#itemsSelected.length} item${this.#itemsSelected.length > 1 ? 's' : ''}`, 'success');
    })
    .catch(err=>{
      notify(`<strong>Error</strong>:</br>${err}`, 'error', -1);
    });

  }

  #handleGalleryControlsDeletePressed = (evt)=>{
    // update db here
    fetch(`/trashItems`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        uuid_arr: this.#itemsSelected.map(x=>x.data.id)
      })
    })
    .then(res=>{
      if(!res.ok){
        throw `${res.status} ${res.statusText}`
      }
    })
    .then(()=>{
      this.#albums.forEach(album=>album.deleteSelectedItems());
      let trashedCnt = this.#itemsSelected.length;
      // all items selected are deleted. No need to keep gallery controls anymore
      this.#removeGalleryControls();
      notify(`${trashedCnt} item${trashedCnt > 1 ? 's' : ''} moved to trash`, 'success');
    })
    .catch(err=>{
      notify(`<strong>Error</strong>:</br>${err}`, 'error', -1);
    });
  }

  #reAssignAlbumPositions(){
    let cumHeight = 0;
    this.#albums.forEach(album=>{
      album.style.top = cumHeight+'px';
      album.style.left = '0px';

      cumHeight += album.album_height; //+ 40; // px between albums
    });
  }
  
  #handleAlbumHeightChange = () => {
    // apply "style: top" changes to all albums
    this.#reAssignAlbumPositions();

    // paint albums twice for better user experience
    // painting only once after timeout causes an unnecessary delay 
    // in resizing last row when items are deleted at the bottom of the album
    this.#selectivelyPaintAlbums();
    
    // bring more items to the buffer, or remove items from buffer as necessary
    // need to wait for the album height animation to complete, before doing this
    // so that 'offsetTop' value is properly obtained
    setTimeout(() => {
      this.#selectivelyPaintAlbums();
    }, 300);
  }

  #removeAlbum = (evt) => {
    let deletedAlbumId = evt.composedPath()[0].id;

    let idx = this.#albums.findIndex(x=>x.id == deletedAlbumId);

    // remove the album from DOM as well as reference in array
    this.shadowRoot.getElementById(deletedAlbumId).remove();
    this.#albums.splice(idx, 1);
    delete(this.#albumsInBuffer[deletedAlbumId]);

    this.#handleAlbumHeightChange();

  }

  #selectivelyPaintAlbums(forceRepaint = true) {
    
    //   --------------------------------------- bufferTop (-ve value)
    //
    //
    //
    //   --------------------------------------- 0px
    //                    ^
    //                    |
    //                    |
    //                 Viewport
    //                    |
    //                    |
    //                    v
    //   ---------------------------------------
    //
    //
    //
    //   --------------------------------------- bufferBottom
    
    // to be able to do math, we convert scroll to a -ve number
    
    let scrollTop = -this.shadowRoot.getElementById('gallery').scrollTop;
    
    // we make the buffers on each side 6 times the size of the screen

    // bufferTop: px above the top of the viewport
    // bufferBottom: px below the bottom of the viewport
    let viewportHeight = this.shadowRoot.getElementById('gallery').clientHeight,
      bufferTop = viewportHeight * -6, 
      bufferBottom = viewportHeight * (1+6);
    
    this.#albums.forEach(album=>{
      let albumTop = album.offsetTop + scrollTop, albumBottom = albumTop + album.album_height;

      let albumBottomInBuffer = () => (albumBottom >= bufferTop && albumBottom <= bufferBottom);
      let albumTopInBuffer    = () => (albumTop    >= bufferTop && albumTop    <= bufferBottom);
      let albumEncompassesBuffer = () => (albumTop <= bufferTop && albumBottom >= bufferBottom);

      // in case the full album was already loaded in the buffer, and the entire album continues to exist,
      // take a shortcut and no need to adjust anything, unless explicitly set during the function call.
      
      // for e.g. scroll doesn't need to repaint everything, however, a delete or album height change will
      // need to repaint even though the entire album may have already been loaded and contines to exist in the buffer
      if (
        !forceRepaint &&
        this.#albumsInBuffer[album.id] && this.#albumsInBuffer[album.id] == 'full' && // full album is loaded
        albumBottomInBuffer() && albumTopInBuffer()
      ) {
        // don't need to do anything
        // console.log(`not doing ${album.id}`);
        return;
      }

      if (albumEncompassesBuffer()){
        this.#albumsInBuffer[album.id] = 'buffer-overflow';
        album.selectivelyPaintLayout(bufferTop, bufferBottom, albumTop);
      }
      // if albumTop is within the buffer or albumBottom is within the buffer, we need to show
      // (at least part of) the album
      else if (albumBottomInBuffer() || albumTopInBuffer()) {
        album.selectivelyPaintLayout(bufferTop, bufferBottom, albumTop);
        
        if (albumBottomInBuffer() && albumTopInBuffer()){
          this.#albumsInBuffer[album.id] = 'full';

        } else {
          this.#albumsInBuffer[album.id] = 'partial';
        }
        
      } else {
        // the album is not within the buffered area
        
        if(this.#albumsInBuffer[album.id]){
          // if the album was in the buffered area before, selectively paint layout once more,
          // so any visible thumbs can be removed
          album.selectivelyPaintLayout(bufferTop, bufferBottom, albumTop);
          delete this.#albumsInBuffer[album.id];
        }
      }
    });

    console.log(this.#albumsInBuffer)
  }

  #throttleHandleScroll = throttle(()=>this.#selectivelyPaintAlbums(false), 100);

  #handleResize() {
    // apply the new width to all albums
    this.#reAssignAlbumWidths();
    // re-assign album positions, and selectively paint
    this.#handleAlbumHeightChange();
  }
  
  #reAssignAlbumWidths(){
    this.#albums.forEach(album=>{
      album.width = this.shadowRoot.getElementById('gallery').clientWidth;
      album.redoLayout();
    });
  }

  //debounceHandleResize = debounce(()=>this.#handleResize(), 300);
  #throttleHandleResize = throttle(()=>this.#handleResize(), 100);

  disconnectedCallback() {
    this.shadowRoot.getElementById('gallery')
      .removeEventListener('scroll', this.#throttleHandleScroll)
    ;
    
    window
      .removeEventListener('resize', this.#throttleHandleResize)
    ;
  }

  attributeChangedCallback(name, oldVal, newVal) {
    //implementation
  }

  adoptedCallback() {
    console.log('in adoptedCallback')
  }

  get data(){
    return this.#data;
  }
  set data(_){
    this.#data = _;
  }

  get data_src(){
    return this._data_src;
  }
  set data_src(_){
    this._data_src = _;
    // TODO: do a fetch and set this.#data
  }

}

window.customElements.define('pl-gallery', PlGallery);
