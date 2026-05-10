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

import {debounce, throttle, notify, showConfirmDialog, showProgress, hideProgress} from '../utils.mjs';
import { searchItems, getTrashedItems, searchByGpsCoordinates, getAllItems } from '../api/search-api.mjs';
import { updateRating, trashItems, togglePrivate, restoreFromTrash, cleanupTrash, emptyTrash, moveItems } from '../api/media-api.mjs';

import sheet from "./styles/pl-gallery.css" with { type: "css" };

class PlGallery extends HTMLElement {

  // internal variables
  #albums = []; #albumsInBuffer = {}; #albumsSelectedCnt = {}; #itemsSelected = [];
  // variables that can be get/set
  #data; #mode = 'default'; #query = {}; #slideshowItemId = null;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <div id="trash-bar" style="display:none">
        <span id="trash-info"></span>
        <sl-button id="empty-trash-btn" variant="danger" size="small">
          <sl-icon slot="prefix" name="x-circle-fill"></sl-icon>
          Empty Trash
        </sl-button>
      </div>
      <div id="gallery"></div>
      <div id="album-nav-btns">
        <sl-icon-button id="prev-album-btn" name="chevron-up" label="Previous album"></sl-icon-button>
        <sl-icon-button id="next-album-btn" name="chevron-down" label="Next album"></sl-icon-button>
      </div>
    `;
  }

  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  async connectedCallback() {

    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    // Fetch data based on mode
    const data = await this.#fetchData();
    if (!data) return; // error already notified
    if (!this.isConnected) return; // component removed during fetch

    this.#data = data;
    this.#renderGallery();
  }

  async #fetchData() {
    showProgress();
    try {
      const { collectionId = 1, searchText, bounds } = this.#query;
      switch (this.#mode) {
        case 'search':  return await searchItems(collectionId, searchText);
        case 'trash':   return await getTrashedItems(collectionId);
        case 'geo':     return await searchByGpsCoordinates(collectionId, bounds);
        default:        return await getAllItems();
      }
    } catch (err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
      return null;
    } finally {
      hideProgress();
    }
  }

  #renderGallery() {
    if (this.#data.length === 0) {
      this.shadowRoot.getElementById('gallery').innerHTML =
        '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">No results found</div>';
      return;
    }

    const totalItems = this.#data.map(x => x.items.length).reduce((a, c) => a + c, 0);
    notify(`Found ${this.#data.length.toLocaleString()} albums containing ${totalItems.toLocaleString()} items`);

    this.#albums = this.#data.map(d=>{

      let album = Object.assign(document.createElement('pl-album'), {
        id: d.id,
        album_name: d.album,
        data: d.items,
        width: this.shadowRoot.getElementById('gallery').clientWidth,
        readOnly: this.#mode === 'trash'
      });

      // TODO: Can we have gallery listen to these events rather than individual albums?
      this.#addAlbumEventListeners(album);
    
      return album;
    });

    this.shadowRoot.getElementById('gallery').append(...this.#albums);
    this.#reAssignAlbumPositions();
    
    // Reset scroll position
    this.shadowRoot.getElementById('gallery').scrollTop = 0;
    
    // Wait for next frame to ensure dimensions are calculated.
    // When gallery is nested inside other web components (e.g. pl-app-shell),
    // the browser hasn't finished calculating layout for the nested shadow DOM structure
    // when connectedCallback runs. clientWidth/clientHeight might return 0 or incorrect values.
    // requestAnimationFrame defers painting until after the browser completes the layout pass,
    // ensuring all dimensions are properly calculated before we paint thumbnails.
    requestAnimationFrame(() => {
      this.#selectivelyPaintAlbums();
      this.#updateNavBtnState();
    });

    // Trash bar
    if(this.#mode === 'trash'){
      let trashBar = this.shadowRoot.getElementById('trash-bar');
      trashBar.style.display = '';
      this.#updateTrashCount();
      this.shadowRoot.getElementById('empty-trash-btn').addEventListener('click', this.#handleEmptyTrash);
    }

  // DESIGN: The slideshow is a "view mode" of the gallery, not a separate page.
  // pl-gallery owns the slideshow lifecycle: creates it as a child in its shadow DOM,
  // listens to its events, and removes it on close. This keeps the gallery's scroll
  // position and DOM intact while the slideshow is open, enabling incremental scroll
  // sync as the user navigates slides.

  // DESIGN: pl-slideshow-item-changed bubbles up from the child slideshow on every
  // next/prev navigation. Gallery intercepts it to:
  //   1. Scroll the gallery to the current item (invisible to user, since slideshow
  //      covers the viewport via position:fixed). This ensures the gallery is already
  //      scrolled to the right place when the slideshow closes.
  //   2. Re-dispatch as pl-gallery-slideshow-changed for app-shell to update the URL.

  // DESIGN: pl-slideshow-closed bubbles up when user presses Escape or the close button.
  // Gallery intercepts it to remove the slideshow and restore nav buttons.
  // The pl-gallery-slideshow-closed event then bubbles to app-shell for URL cleanup.

    this.addEventListener('pl-gallery-item-clicked', (evt)=>{
      evt.stopPropagation();
      this.openSlideshow(evt.detail.id);
    })

    this.addEventListener('pl-slideshow-item-changed', (evt)=>{
      evt.stopPropagation();
      this.#scrollToItem(evt.detail.currentItemId);
      this.dispatchEvent(new CustomEvent('pl-gallery-slideshow-changed', {
        composed: true, bubbles: true,
        detail: { currentItemId: evt.detail.currentItemId }
      }));
    })

    this.addEventListener('pl-slideshow-closed', (evt)=>{
      evt.stopPropagation();
      this.closeSlideshow(evt.detail.currentItemId);
    })

    this.shadowRoot.getElementById('gallery')
      .addEventListener('scroll', this.#throttleHandleScroll)
    ;
    this.shadowRoot.getElementById('gallery')
      .addEventListener('scrollend', this.#updateNavBtnState)
    ;
    
    this.shadowRoot.getElementById('next-album-btn')
      .addEventListener('click', this.#scrollToNextAlbum)
    ;
    this.shadowRoot.getElementById('prev-album-btn')
      .addEventListener('click', this.#scrollToPrevAlbum)
    ;

    window.addEventListener('resize', this.#throttleHandleResize)
    ;

    // Open slideshow if requested via property (e.g. direct URL visit)
    if (this.#slideshowItemId) {
      requestAnimationFrame(() => this.openSlideshow(this.#slideshowItemId));
    }
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
      
      if(!this.shadowRoot.querySelector('pl-gallery-controls')){
        let c = document.createElement('pl-gallery-controls');
        c.mode = this.#mode;
        this.shadowRoot.append(c);

        c.addEventListener('pl-gallery-controls-closed', this.#handleGalleryControlsClosed);
        c.addEventListener('pl-gallery-controls-rating-changed', this.#handleGalleryControlsRatingChanged);
        c.addEventListener('pl-gallery-controls-private-toggled', this.#handleGalleryControlsPrivateToggled);
        c.addEventListener('pl-gallery-controls-delete-pressed', this.#handleGalleryControlsDeletePressed);
        c.addEventListener('pl-gallery-controls-restore-pressed', this.#handleGalleryControlsRestorePressed);
        c.addEventListener('pl-gallery-controls-cleanup-pressed', this.#handleGalleryControlsCleanupPressed);
        c.addEventListener('pl-gallery-controls-dialog-save', (evt)=>{
          this.#createOrMoveSelectedItems(evt.detail.trim())
        });
      }

      let c = this.shadowRoot.querySelector('pl-gallery-controls');
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

      let allPrivate = this.#itemsSelected.every(x => x.data.private);
      c.allPrivate = allPrivate;

      
    } else if(this.#itemsSelected.length == 0){
      this.#removeGalleryControls();
    }
  }

  #createOrMoveSelectedItems = async (targetAlbumName)=>{
    let allAlbumNames = this.#albums.map(x=>x.album_name);
  
    try {
      await moveItems(1, this.#itemsSelected.map(x=>x.data.id), targetAlbumName);

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
      notify(`<strong>Error</strong>:</br>${err.error?.message || err.message || err}`, 'error', -1);
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

    let c = this.shadowRoot.querySelector('pl-gallery-controls');
    c.remove();
  }

  #handleGalleryControlsRatingChanged = async (evt)=>{
    try {
      await updateRating(this.#itemsSelected.map(x=>x.data.id), evt.detail.newRating);
      this.#albums.forEach(album=>{
        album.changeRatingSelectedItems(evt.detail.newRating);
      });
      notify(`Updated rating for ${this.#itemsSelected.length} item${this.#itemsSelected.length > 1 ? 's' : ''}`, 'success');
    } catch(err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #handleGalleryControlsDeletePressed = async ()=>{
    try {
      await trashItems(1, this.#itemsSelected.map(x=>x.data.id));
      this.#albums.forEach(album=>album.deleteSelectedItems());
      let trashedCnt = this.#itemsSelected.length;
      this.#removeGalleryControls();
      notify(`${trashedCnt} item${trashedCnt > 1 ? 's' : ''} moved to trash`, 'success');
    } catch(err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #handleGalleryControlsPrivateToggled = async (evt)=>{
    let {makePrivate} = evt.detail;
    try {
      await togglePrivate(1, this.#itemsSelected.map(x=>x.data.id), makePrivate);
      let cnt = this.#itemsSelected.length;
      this.#albums.forEach(album=>album.deleteSelectedItems());
      this.#removeGalleryControls();
      notify(`${cnt} item${cnt > 1 ? 's' : ''} ${makePrivate ? 'marked private' : 'unmarked private'}`, 'success');
    } catch(err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #handleGalleryControlsRestorePressed = async ()=>{
    try {
      await restoreFromTrash(1, this.#itemsSelected.map(x=>x.data.id));
      let cnt = this.#itemsSelected.length;
      this.#albums.forEach(album=>album.deleteSelectedItems());
      this.#removeGalleryControls();
      notify(`${cnt} item${cnt > 1 ? 's' : ''} restored from trash`, 'success');
      if(this.#mode === 'trash') this.#updateTrashCount();
    } catch(err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #handleGalleryControlsCleanupPressed = async ()=>{
    try {
      await cleanupTrash(1, this.#itemsSelected.map(x=>x.data.id));
      let cnt = this.#itemsSelected.length;
      this.#albums.forEach(album=>album.deleteSelectedItems());
      this.#removeGalleryControls();
      notify(`${cnt} item${cnt > 1 ? 's' : ''} permanently deleted`, 'success');
      if(this.#mode === 'trash') this.#updateTrashCount();
    } catch(err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #handleEmptyTrash = async ()=>{
    let result = await showConfirmDialog(
      'Empty Trash',
      'This will permanently delete all items in trash. This cannot be undone.',
      'Empty Trash',
      'Cancel'
    );
    if(result !== 1) return;

    try {
      let allUuids = this.#data.flatMap(d => d.items.map(i => i.data.id));
      await emptyTrash(1, allUuids);
      // remove all albums from gallery
      this.#albums.forEach(a => a.remove());
      this.#albums = [];
      this.#albumsInBuffer = {};
      this.#updateTrashCount();
      notify('Trash emptied', 'success');
    } catch(err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #updateTrashCount = ()=>{
    let totalItems = this.#albums.reduce((sum, a) => sum + a.data.length, 0);
    this.shadowRoot.getElementById('trash-info').textContent = `${totalItems} item${totalItems !== 1 ? 's' : ''} in trash`;
    this.shadowRoot.getElementById('empty-trash-btn').disabled = totalItems === 0;
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

  #scrollToNextAlbum = () => {
    let gallery = this.shadowRoot.getElementById('gallery');
    let scrollTop = gallery.scrollTop;
    let nextAlbum = this.#albums.find(a => a.offsetTop > scrollTop + 1);
    if (nextAlbum) {
      gallery.scrollTo({ top: nextAlbum.offsetTop, behavior: 'smooth' });
    }
  }

  #scrollToPrevAlbum = () => {
    let gallery = this.shadowRoot.getElementById('gallery');
    let scrollTop = gallery.scrollTop;
    let prevAlbum = this.#albums.findLast(a => a.offsetTop < scrollTop - 1);
    if (prevAlbum) {
      gallery.scrollTo({ top: prevAlbum.offsetTop, behavior: 'smooth' });
    }
  }

  #updateNavBtnState = () => {
    let gallery = this.shadowRoot.getElementById('gallery');
    let scrollTop = gallery.scrollTop;
    let maxScroll = gallery.scrollHeight - gallery.clientHeight;
    let currentIdx = this.#albums.findLastIndex(a => a.offsetTop <= scrollTop + 1);
    this.shadowRoot.getElementById('prev-album-btn').disabled = currentIdx <= 0;
    this.shadowRoot.getElementById('next-album-btn').disabled = currentIdx >= this.#albums.length - 1 || scrollTop >= maxScroll - 1;
  }

  #throttleHandleScroll = throttle(()=>{ this.#selectivelyPaintAlbums(false); this.#updateNavBtnState(); }, 100);

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
    this.shadowRoot.getElementById('gallery')
      .removeEventListener('scrollend', this.#updateNavBtnState)
    ;
    this.shadowRoot.getElementById('next-album-btn')
      .removeEventListener('click', this.#scrollToNextAlbum)
    ;
    this.shadowRoot.getElementById('prev-album-btn')
      .removeEventListener('click', this.#scrollToPrevAlbum)
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

  get mode(){
    return this.#mode;
  }
  set mode(_){
    this.#mode = _ || 'default';
  }

  get query(){
    return this.#query;
  }
  /**
   * Mode-specific parameters for data fetching.
   * @param {object} _ - Query object, shape depends on mode:
   *   mode 'default': { collectionId: number }
   *   mode 'search':  { collectionId: number, searchText: string }
   *   mode 'trash':   { collectionId: number }
   *   mode 'geo':     { collectionId: number, bounds: { sw: {lat, lng}, ne: {lat, lng} } }
   */
  set query(_){
    this.#query = _ || {};
  }

  get slideshowItemId(){
    return this.#slideshowItemId;
  }
  set slideshowItemId(_){
    this.#slideshowItemId = _ || null;
  }

  get isSlideshowOpen() {
    return !!this.shadowRoot.querySelector('pl-slideshow');
  }

  // DESIGN: openSlideshow is public so app-shell can call it for direct URL visits
  // (e.g. user pastes #/app/slideshow/<uuid> into browser).
  openSlideshow(startFromId) {
    if (this.isSlideshowOpen) return;

    let slideshowData = this.#albums.map(x => ({
      album: x.album_name,
      items: x.data
    }));

    let slideshow = Object.assign(document.createElement('pl-slideshow'), {
      data: slideshowData,
      startFrom: startFromId,
      buffer: 1,
      mode: this.#mode
    });

    this.shadowRoot.getElementById('album-nav-btns').style.display = 'none';
    this.shadowRoot.appendChild(slideshow);

    this.dispatchEvent(new CustomEvent('pl-gallery-slideshow-opened', {
      composed: true, bubbles: true,
      detail: { currentItemId: startFromId }
    }));
  }

  // DESIGN: closeSlideshow is public so app-shell can call it when the browser back
  // button triggers a route change (e.g. from /slideshow/<uuid> back to /).
  // The #showGallery method in app-shell detects the existing gallery and calls this
  // instead of rebuilding the gallery from scratch, preserving scroll position.
  //
  // DESIGN: Animates the slideshow shrinking into the thumbnail's position in the gallery,
  // giving the visual impression that the photo "goes back" to where it came from.
  // Uses transform scale + translate (GPU composited) rather than animating dimensions.
  closeSlideshow(currentItemId) {
    let slideshow = this.shadowRoot.querySelector('pl-slideshow');
    if (!slideshow) return;

    // Resolve current item id if not provided (e.g. called from app-shell back button)
    if (!currentItemId) {
      let active = slideshow.shadowRoot?.querySelector('#slides [data-pos="0"]');
      if (active) {
        let idx = active.dataset.idx.split(',').map(Number);
        currentItemId = slideshow.data[idx[0]]?.items[idx[1]]?.data?.id;
      }
    }

    // Restore nav buttons so they are visible as gallery appears
    this.shadowRoot.getElementById('album-nav-btns').style.display = '';

    let thumbRect = currentItemId ? this.#getThumbRect(currentItemId) : null;

    // prepareForDismiss pauses video, hides chrome, removes black background,
    // and returns the actual rendered media rect
    let mediaRect = slideshow.prepareForDismiss();

    if (!thumbRect || !mediaRect) {
      slideshow.remove();
      this.dispatchEvent(new Event('pl-gallery-slideshow-closed', { composed: true, bubbles: true }));
      return;
    }

    // Animate: shrink from media's rendered position to thumbnail position.
    // Both are the same photo so aspect ratio matches -> uniform scale.
    let mediaCenterX = mediaRect.left + mediaRect.width / 2;
    let mediaCenterY = mediaRect.top + mediaRect.height / 2;
    let thumbCenterX = thumbRect.x + thumbRect.w / 2;
    let thumbCenterY = thumbRect.y + thumbRect.h / 2;
    let scale = thumbRect.w / mediaRect.width;
    let tx = thumbCenterX - mediaCenterX;
    let ty = thumbCenterY - mediaCenterY;

    slideshow.style.transformOrigin = `${mediaCenterX}px ${mediaCenterY}px`;

    let anim = slideshow.animate([
      { transform: 'translate(0px, 0px) scale(1)' },
      { transform: `translate(${tx}px, ${ty}px) scale(${scale})` }
    ], {
      duration: 200,
      easing: 'ease-in',
      fill: 'forwards'
    });

    anim.finished.then(() => {
      slideshow.remove();
      this.dispatchEvent(new Event('pl-gallery-slideshow-closed', { composed: true, bubbles: true }));
    });
  }

  // Returns the thumbnail's screen-space rect {x, y, w, h} for the given item id,
  // or null if not found.
  #getThumbRect(id) {
    let gallery = this.shadowRoot.getElementById('gallery');
    let galleryRect = gallery.getBoundingClientRect();

    for (let album of this.#albums) {
      let item = album.data.find(x => x.data.id === id);
      if (item) {
        return {
          x: galleryRect.left + parseFloat(item.layout.trX),
          y: galleryRect.top + album.offsetTop + item.layout.offsetHeight - gallery.scrollTop,
          w: item.layout.width,
          h: item.layout.height
        };
      }
    }
    return null;
  }

  // DESIGN: Scrolls the gallery to the item's position using album.offsetTop (the album's
  // absolute position in the gallery) + item.layout.offsetHeight (the item's Y offset within
  // the album, computed during layout). Since the gallery is underneath the slideshow
  // (covered by position:fixed), this scroll is invisible to the user. The existing
  // throttled scroll handler takes care of selectively painting thumbnails around the
  // new scroll position.
  #scrollToItem(id) {
    for (let album of this.#albums) {
      let item = album.data.find(x => x.data.id === id);
      if (item) {
        let gallery = this.shadowRoot.getElementById('gallery');
        let targetTop = album.offsetTop + item.layout.offsetHeight;
        // Center the item's row in the viewport. scrollTo automatically
        // clamps to valid scroll range, so no manual bounds checking needed.
        let centered = targetTop - (gallery.clientHeight - item.layout.height) / 2;
        gallery.scrollTo({ top: centered });
        break;
      }
    }
  }

}

window.customElements.define('pl-gallery', PlGallery);
