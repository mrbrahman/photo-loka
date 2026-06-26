
// <pl-album album_name='Album 1' width=1000 gutterspace=4 paintlayout width=500 data="[{id: 1, ar:1}, {id:2, ar: 1.33}, {id:5, ar:0.82}]"></pl-album>

import { notify, showConfirmDialog } from '../utils.mjs';
import { formatTimeWindow } from '../album-path.mjs';

import sheet from "./styles/pl-album.css" with { type: "css" };

class PlAlbum extends HTMLElement {
  
  #width; #paint_layout = false; #gutterspace = 4; #data; #album_name;
  #album_date = '';
  // Fixed in CSS (pl-album-name.css :host { height: 36px }). Keep this in
  // sync with that value - it's used in layout math to leave room for the
  // sticky header above the thumbs.
  #album_name_height = 36; #album_height; #readOnly = false; #collectionId = null;
  #placeholderText = '';

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <div id="container">
      </div>
    `;
  }
  
  static get observedAttributes() {
    return ['paint_layout','album_name','width','gutterspace','data','data_src'];
  }
  
  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }
  
  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
    
    // paint album name
    this.#paintName();
    
    // calculate album layout
    this.#doLayout();

    // paint album only if paint_layout is set
    if(this.#paint_layout){
      this.#paintLayout();
    } else {
      // painting of layout will selectively happen from the wrapper, so not doing anything here
    }

    this.#updateAlbumSelect();

    this.shadowRoot.querySelector('pl-album-name')
      .addEventListener('r3-select-all-clicked', (evt)=>this.#handleSelectAll(evt.detail.select), true)
    ;

    this.shadowRoot.getElementById('container')
      .addEventListener('r3-item-selected', this.#handleItemSelected, true);

  }
  
  attributeChangedCallback(name, oldValue, newValue) {
    switch(name){
      case 'paint_layout':
        this.paint_layout = newValue == null ? false : true;
        break;
      case 'album_name':
        this.album_name = newValue;
        break;
      case 'data':
        this.data = JSON.parse(newValue)
        break;
      case 'width':
        this.width = newValue;
        break;
      case 'gutterspace':
        this.gutterspace = newValue;
        break;
    }
  }

  disconnectedCallback() {
    // nothing to do
  }

  #handleSelectAll = (isSelected)=>{
    let selectedItems = [];

    // # First select all items in the album
    this.data.forEach(item=>{
      if(item.elem){
        if(item.elem.selected == isSelected){
          // item is already in the target state, nothing to do
        } else {
          item.elem.selected = isSelected;
          item.layout.selected = isSelected;
          selectedItems.push(item);
        }
      } else {
        // the item is not in DOM yet, save the state in layout
        if(item.layout.selected == isSelected){
          // item is already in the target state, nothing to do
        } else {
          item.layout.selected = isSelected;
          selectedItems.push(item);
        }
      }
    });

    this.dispatchEvent( new CustomEvent('pl-album-item-selected', {
      detail: {
        selectAlbum: this.shadowRoot.querySelector('pl-album-name').albumName,
        selected: isSelected,
        selectedItems
      }
    }) );

  }

  #updateAlbumSelect(){
    // get distinct values of array found at https://stackoverflow.com/a/14438954/8098748
    let albumItemsDistinctSelected = [... new Set( this.data.map(item=> !!item.layout.selected) )];

    let plAlbumName = this.shadowRoot.querySelector('pl-album-name');
    
    if(albumItemsDistinctSelected.length > 1){
      plAlbumName.albumSelectedValue = 'some';
    } else {
      if (albumItemsDistinctSelected[0] == true){
        plAlbumName.albumSelectedValue = 'all';
      } else {
        plAlbumName.albumSelectedValue = 'none';
      }
    }
  }

  #handleItemSelected = (evt)=>{
    // #1 First find out and set the value of album select
    this.#updateAlbumSelect();

    // #2 Sync layout.selected so it stays the single source of truth
    let matchingItems = this.data.filter(x=>x.data.id==evt.target.id);
    for (let item of matchingItems) item.layout.selected = evt.target.selected;

    // #3 create an event and pass it to gallery, which will be used in pl-gallery-controls
    this.dispatchEvent( new CustomEvent('pl-album-item-selected', {
      detail: {
        selectAlbum: this.shadowRoot.querySelector('pl-album-name').albumName,
        selected: evt.target.selected,
        selectedItems: matchingItems
      }
    }) );
  }
  
  #deleteItem(itemIdx){
    // if an item from this album is deleted, 
    // 1. remove references to the item,
    // 2. recompute album layout, 
    // 3. and if height has changed, dispatch an event
    let item = this.data[itemIdx];

    if(item.elem && item.elem.isConnected){
      // Capture elem in a local before the setTimeout fires. The move flow
      // in pl-gallery clears item.elem to undefined synchronously after
      // deleteSelectedItems returns (so target-album rendering creates a
      // fresh element), which would otherwise leave the timeout reading
      // 'remove' on undefined.
      let elemToRemove = item.elem;
      elemToRemove.style.transform += " scale(0)";
      setTimeout(() => {
        elemToRemove.remove();
      }, 100);
    }

    // remove element from the list
    this.data.splice(itemIdx, 1);
  }

  #performLayoutChangesIfNeeded(){
    // check if album is empty
    if (this.data.length == 0){
      let albumEmptyEvent = new Event('pl-album-empty');
      this.dispatchEvent(albumEmptyEvent);

      return; // nothing else to do here
    }

    // album is not empty, see if height changes are needed

    let lastAlbumHeight = this.album_height;
    // re-calc layout
    this.#doLayout();

    // paint album only if paint_layout is set
    if(this.#paint_layout){
      this.#paintLayout();
    } else {
      // painting of layout will selectively happen from the wrapper, so not doing anything here
    }

    // recompute time window since min/max items may have changed
    this.#refreshTimeWindow();

    // if there is any height change resulting from this delete, fire an event, so 
    // the wrapper pl-gallery can paint as needed
    if(lastAlbumHeight != this.album_height){
      let albumHeightChangeEvent = new Event('pl-album-height-changed');
      this.dispatchEvent(albumHeightChangeEvent);
    }
  }

  unselectSelectedItems(){
    this.data.forEach(item=>{
      item.layout.selected = false;
      if(item.elem && item.elem.selected) item.elem.selected = false;
    });

    // save a few CPU cycles by directly setting to 'none',
    // rather than calling #updateAlbumSelect
    this.shadowRoot.querySelector('pl-album-name').albumSelectedValue = 'none';
  }

  changeRatingSelectedItems(newRating) {
    this.data.forEach(item=>{
      if(!item.layout.selected) return;

      // update data
      item.data.rating = newRating;

      // update element if one was created
      if(item.elem){
        // there is no listener on the rating element, so we can 
        // safely update here
        item.elem.rating = newRating;
      }
    })
  }

  deleteSelectedItems(){
    // since we remove the items of the array as we're reading the array, 
    // the index of the array changes
    // hence read the array backwards :-)
    // https://stackoverflow.com/a/9882349/8098748
    let deletedCnt = 0;

    let i = this.data.length;
    while(i--){
      if(this.data[i].layout.selected){
        // remove from album
        this.#deleteItem(i);
        deletedCnt++;
      }
    };

    if(deletedCnt > 0){
      this.#updateAlbumSelect();
    }

    this.#performLayoutChangesIfNeeded();
  }

  // Delete items whose data.id is in the given Set, regardless of selection
  // state. Used by the gallery's per-day move flow where some items moved
  // successfully and others failed - we only remove the successful ones.
  deleteItemsByIds(idSet){
    if (!idSet || idSet.size === 0) return;
    let deletedCnt = 0;

    let i = this.data.length;
    while(i--){
      if (idSet.has(this.data[i].data.id)){
        this.#deleteItem(i);
        deletedCnt++;
      }
    }

    if (deletedCnt > 0){
      this.#updateAlbumSelect();
    }
    this.#performLayoutChangesIfNeeded();
  }

  
  #getMinAspectRatio(){
    if (this.width <= 640) {
      return 1.5;
    } else if (this.width <= 1280) {
      return 4;
    } else if (this.width <= 1920) {
      return 5;
    }
    return 6;
  }

  #getMinThumbWidth(){
    if (this.width <= 640) {
      return 120;
    } else if (this.width <= 1280) {
      return 120;
    } else if (this.width <= 1920) {
      return 130;
    }
    return 140;
  }
  
  #flushRow(row, rowAspectRatio, minAspectRatio, trX, trY, isLastRow){
    // clamp only the last row to prevent it from being absurdly tall
    if (isLastRow) rowAspectRatio = Math.max(rowAspectRatio, minAspectRatio);

    let totalWidthOfImages = this.width - (this.gutterspace * row.length-1) - this.gutterspace * 2;
    let rowHeight = totalWidthOfImages / rowAspectRatio;

    // add gutter space to the Y axis
    trY += this.gutterspace;

    // create layout objects for all entries in this row
    for(let r of row){
      trX += this.gutterspace;

      let o = {
        id: r.data.id,
        width: r.data.ar * rowHeight,
        height: rowHeight,
        offsetHeight: trY, // will be useful when painting
        trX: trX + 'px',
        trY: trY + 'px'
      };

      // update layout
      r.layout = o;

      trX += r.data.ar * rowHeight; // add the current element width
    }

    trY += rowHeight;
    return trY;
  }

  #doLayout(){
    let minAspectRatio = this.#getMinAspectRatio(), minThumbWidth = this.#getMinThumbWidth(),
      row = [], rowAspectRatio = 0, minAR = Infinity,
      trX = 0, trY = this.album_name_height;

    this.data.forEach((d,i)=>{
      row.push(d);
      rowAspectRatio += d.data.ar;
      minAR = Math.min(minAR, d.data.ar);

      // check if adding this item would cramp the row
      let isCramped = false;
      if (row.length > 1) {
        let tentativeTotalWidth = this.width - (this.gutterspace * row.length-1) - this.gutterspace * 2;
        let tentativeRowHeight = tentativeTotalWidth / rowAspectRatio;
        isCramped = minAR * tentativeRowHeight < minThumbWidth;
      }

      if (rowAspectRatio >= minAspectRatio || i+1 == this.data.length || isCramped){
        if (isCramped) {
          // flush row WITHOUT the current item
          row.pop();
          rowAspectRatio -= d.data.ar;

          trY = this.#flushRow(row, rowAspectRatio, minAspectRatio, 0, trY, false);

          // start new row with the current item
          row = [d];
          rowAspectRatio = d.data.ar;
          minAR = d.data.ar;

          // check if this item alone fills a row
          if (rowAspectRatio >= minAspectRatio || i+1 == this.data.length) {
            trY = this.#flushRow(row, rowAspectRatio, minAspectRatio, 0, trY, i+1 == this.data.length);
            row = [];
            rowAspectRatio = 0;
            minAR = Infinity;
          }
        } else {
          trY = this.#flushRow(row, rowAspectRatio, minAspectRatio, 0, trY, i+1 == this.data.length);
          row = [];
          rowAspectRatio = 0;
          minAR = Infinity;
        }
      }
    });

    this.album_height = trY;
    this.shadowRoot.getElementById('container').style.height = this.album_height+'px';
  }

  redoLayout = ()=>this.#doLayout();
  
  selectivelyPaintLayout(bufferTop, bufferBottom, albumTop){

    this.data.forEach(x=>{

      let thumbTop = albumTop + x.layout.offsetHeight, thumbBottom = thumbTop + x.height;
      
      // add/remove/leave as is from DOM as appropriate
      if ((thumbTop    >= bufferTop && thumbTop    <= bufferBottom) ||
          (thumbBottom >= bufferTop && thumbBottom <= bufferBottom))
      {
        // album is within the boundaries
        this.#paintItem(x);
      } else {
        // item is not within boundaries

        // remove the item from DOM if present
        if(x.elem !== undefined){
          // Preserve selection state before removing -- the gallery tracks
          // selected items independently, and when the element is recreated
          // on scroll-back it must reflect the same state.
          x.layout.selected = x.elem.selected;
          // remove element in shadow dom
          x.elem.remove();
          x.elem = undefined;
        }
      }
      
    })
  }

  #paintLayout(){
    this.data.forEach(x=>{
      this.#paintItem(x);
    });
  }

  #paintItem(x){
    if(x.elem == undefined){
      // create element in dom
      let elem = Object.assign(document.createElement('pl-thumb'), {
        id: x.data.id,
        width: x.layout.width,
        height: x.layout.height,
        rating: x.data.rating,
        type: x.data.type,
        dur: x.data.dur,
        hasGps: x.data.hasGps,
        hasDesc: x.data.hasDesc,
        hasTags: x.data.hasTags,
        selected: x.layout.selected ? x.layout.selected : false
      });
      elem.style.transform = `translate(${x.layout.trX},${x.layout.trY})`
      
      // keep reference in this.data
      x.elem = elem;
      
      this.shadowRoot.getElementById('container').appendChild(elem);

    } else if (!x.elem.isConnected){
      // the thumb was removed, but element (class) was found - just append the element back into the DOM
      this.shadowRoot.getElementById('container').appendChild(x.elem);

    } else {
      // just update the new position (for resize / delete events)
      x.elem.width = x.layout.width;
      x.elem.height = x.layout.height;
      x.elem.style.transform = `translate(${x.layout.trX},${x.layout.trY})`;
    }
  }

  #paintName(){
    let a = document.createElement('pl-album-name');
    a.albumName = this.album_name;
    a.albumDate = this.#album_date;
    a.readOnly = this.readOnly;
    a.collectionId = this.#collectionId;
    a.placeholderText = this.#placeholderText;
    a.timeWindow = formatTimeWindow(this.data || []);
    a.style.height = this.album_name_height + 'px';
    a.addEventListener('pl-rename-dir-not-empty', this.#handleDirNotEmptyDuringRename)

    this.shadowRoot.getElementById('container').appendChild(a);
  }

  // Recompute and repaint the time window after items are added/removed.
  #refreshTimeWindow() {
    let nameEl = this.shadowRoot.querySelector('pl-album-name');
    if (nameEl) nameEl.timeWindow = formatTimeWindow(this.data || []);
  }

  #handleDirNotEmptyDuringRename = async (evt)=>{ 
    const result = await showConfirmDialog(
      'Move items?',
      'The new album name already exists. Do you want to move all items to that album?',
      'Yes',
      'No'
    );

    if(result === 1){
      this.#handleSelectAll(true);
      this.dispatchEvent(new CustomEvent('pl-album-move-selected-items', {detail: {newAlbumName: evt.detail.newAlbumName}}));
    }
  }

  // boilerplate
  get paint_layout(){
    return this.#paint_layout;
  }
  set paint_layout(_){
    this.#paint_layout = _;
  }

  get album_name(){
    return this.#album_name;
  }
  set album_name(_){
    this.#album_name = _;
  }
  
  get width(){
    return this.#width;
  }
  set width(_){
    this.#width = +_;
  }

  get gutterspace(){
    return this.#gutterspace;
  }
  set gutterspace(_){
    this.#gutterspace = +_;
  }

  get data(){
    return this.#data;
  }
  set data(_){
    // create a placeholder for the element
    // this will be further updated with the layout and actual element reference
    this.#data = _;
  }

  // this method is exposed
  addNewItems = (items)=>{
    this.data.push(...items);

    // Re-sort to keep the album in time-DESC order. Items with a real
    // capture time come first (newest first); no-time items go at the end
    // sorted alphabetically by id (stable fallback when t is identical).
    this.data.sort((a, b) => {
      let ah = a.data?.hasTime ? 1 : 0;
      let bh = b.data?.hasTime ? 1 : 0;
      if (ah !== bh) return bh - ah;          // hasTime first
      if (ah === 1) return (b.data.t || 0) - (a.data.t || 0); // newest first
      return String(a.data?.id || '').localeCompare(String(b.data?.id || ''));
    });

    this.#doLayout();
    if(this.#paint_layout){
      this.#paintLayout()
    }
    this.#updateAlbumSelect();
    this.#refreshTimeWindow();
  }

  get album_name_height(){
    return this.#album_name_height;
  }
  set album_name_height(_){
    this.#album_name_height = +_;
  }

  get album_height(){
    return this.#album_height;
  }
  set album_height(_){
    this.#album_height = +_;
  }

  get readOnly() { return this.#readOnly; }
  set readOnly(_) { this.#readOnly = Boolean(_); }

  get collectionId() { return this.#collectionId; }
  set collectionId(_) { this.#collectionId = _ || null; }

  get placeholderText() { return this.#placeholderText; }
  set placeholderText(_) { this.#placeholderText = _ || ''; }

  get album_date() { return this.#album_date; }
  set album_date(_) { this.#album_date = _ || ''; }
  
}

customElements.define('pl-album', PlAlbum);

