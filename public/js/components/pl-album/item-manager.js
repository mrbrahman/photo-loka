export class ItemManager {
  constructor(component) {
    this.component = component;
  }

  deleteItem(itemIdx){
    // if an item from this album is deleted, 
    // 1. remove references to the item,
    // 2. recompute album layout, 
    // 3. and if height has changed, dispatch an event
    let item = this.component.data[itemIdx];

    if(item.elem && item.elem.isConnected){
      item.elem.style.transform += " scale(0)";
      setTimeout(() => {
        item.elem.remove();
      }, 100);
    }

    // remove element from the list
    this.component.data.splice(itemIdx, 1);
  }

  performLayoutChangesIfNeeded(){
    // check if album is empty
    if (this.component.data.length == 0){
      let albumEmptyEvent = new Event('pl-album-empty');
      this.component.dispatchEvent(albumEmptyEvent);

      return; // nothing else to do here
    }

    // album is not empty, see if height changes are needed

    let lastAlbumHeight = this.component.album_height;
    // re-calc layout
    this.component.layoutCalculator.doLayout();

    // paint album only if paint_layout is set
    if(this.component.paint_layout){
      this.component.itemRenderer.paintLayout();
    } else {
      // painting of layout will selectively happen from the wrapper, so not doing anything here
    }

    // if there is any height change resulting from this delete, fire an event, so 
    // the wrapper pl-gallery can paint as needed
    if(lastAlbumHeight != this.component.album_height){
      let albumHeightChangeEvent = new Event('pl-album-height-changed');
      this.component.dispatchEvent(albumHeightChangeEvent);
    }
  }

  changeRatingSelectedItems(newRating) {
    this.component.data.forEach(item=>{
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

    let i = this.component.data.length;
    while(i--){
      if((this.component.data[i].elem && this.component.data[i].elem.selected) || this.component.data[i].layout.selected){
        // remove from album
        this.deleteItem(i);
        deletedCnt++;
      }
    };

    if(deletedCnt > 0){
      this.component.selectionHandler.updateAlbumSelect();
    }

    this.performLayoutChangesIfNeeded();
  }

  addNewItems = (items)=>{
    // TODO: sort the items (need ts from db)
    this.component.data.push(...items);

    this.component.layoutCalculator.doLayout();
    if(this.component.paint_layout){
      this.component.itemRenderer.paintLayout()
    }
    this.component.selectionHandler.updateAlbumSelect();
  }
}