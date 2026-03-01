
// <pl-album album_name='Album 1' width=1000 gutterspace=4 paintlayout width=500 data="[{id: 1, ar:1}, {id:2, ar: 1.33}, {id:5, ar:0.82}]"></pl-album>

import { notify, showConfirmDialog } from './utils.mjs';

class PlAlbum extends HTMLElement {
  
  #width; #paint_layout = false; #gutterspace = 4; #data; #album_name; #album_name_height = 45; #album_height; 
  
  static get observedAttributes() {
    return ['paint_layout','album_name','width','gutterspace','data','data_src'];
  }
  
  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
  }
  
  connectedCallback() {
    this.shadowRoot.appendChild(
      document.getElementById(this.nodeName).content.cloneNode(true)
    );
    
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
    let albumItemsDistinctSelected = [... new Set( this.data.map(item=>item.elem ? item.elem.selected : item.layout.selected ? item.layout.selected : false) )];

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

    // #2 create an event and pass it to gallery, which will be used in pl-gallery-controls
    this.dispatchEvent( new CustomEvent('pl-album-item-selected', {
      detail: {
        selectAlbum: this.shadowRoot.querySelector('pl-album-name').albumName,
        selected: evt.target.selected,
        selectedItems: this.data.filter(x=>x.data.id==evt.target.id)
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
      item.elem.style.transform += " scale(0)";
      setTimeout(() => {
        item.elem.remove();
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

    // if there is any height change resulting from this delete, fire an event, so 
    // the wrapper pl-gallery can paint as needed
    if(lastAlbumHeight != this.album_height){
      let albumHeightChangeEvent = new Event('pl-album-height-changed');
      this.dispatchEvent(albumHeightChangeEvent);
    }
  }

  unselectSelectedItems(){
    this.data.forEach(item=>{
      if(item.elem && item.elem.selected){
        item.elem.selected = false;
      } else if (item.layout.selected){
        item.layout.selected = false;
      }
    });

    // save a few CPU cycles by directly setting to 'none',
    // rather than calling #updateAlbumSelect
    this.shadowRoot.querySelector('pl-album-name').albumSelectedValue = 'none';
  }

  changeRatingSelectedItems(newRating) {
    this.data.forEach(item=>{
      if(! ((item.elem && item.elem.selected)||item.layout.selected)){
        return;
      }

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
      if((this.data[i].elem && this.data[i].elem.selected) || this.data[i].layout.selected){
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
  
  #doLayout(){
    let minAspectRatio = this.#getMinAspectRatio(), row = [], rowAspectRatio = 0, 
      trX = 0, trY = this.album_name_height;

    this.data.forEach((d,i)=>{
      row.push(d);
      rowAspectRatio += d.data.ar;
      
      if (rowAspectRatio >= minAspectRatio || i+1 == this.data.length){
        // we've reached the max items possible in this row, or this is the last element
        
        // calculate row height
        // total width of images in this row = width of screen - space between images - space at the 2 ends
        
        // make sure the last image has reasonable height (not too big)
        rowAspectRatio = Math.max(rowAspectRatio, minAspectRatio);
        
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
        // reset values
        trX = 0;
        trY += rowHeight;      
        row = []; 
        rowAspectRatio = 0;
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
    a.style.height = this.album_name_height + 'px';
    a.addEventListener('pl-rename-dir-not-empty', this.#handleDirNotEmptyDuringRename)

    this.shadowRoot.getElementById('container').appendChild(a);
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
    // TODO: sort the items (need ts from db)
    this.data.push(...items);

    this.#doLayout();
    if(this.#paint_layout){
      this.#paintLayout()
    }
    this.#updateAlbumSelect();
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
  
}

customElements.define('pl-album', PlAlbum);

