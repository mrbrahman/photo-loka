export class SelectionHandler {
  constructor(component) {
    this.component = component;
  }

  handleSelectAll = (isSelected)=>{
    let selectedItems = [];

    // # First select all items in the album
    this.component.data.forEach(item=>{
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

    this.component.dispatchEvent( new CustomEvent('pl-album-item-selected', {
      detail: {
        selectAlbum: this.component.shadowRoot.querySelector('pl-album-name').albumName,
        selected: isSelected,
        selectedItems
      }
    }) );
  }

  updateAlbumSelect(){
    // get distinct values of array found at https://stackoverflow.com/a/14438954/8098748
    let albumItemsDistinctSelected = [... new Set( this.component.data.map(item=>item.elem ? item.elem.selected : item.layout.selected ? item.layout.selected : false) )];

    let plAlbumName = this.component.shadowRoot.querySelector('pl-album-name');
    
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

  handleItemSelected = (evt)=>{
    // #1 First find out and set the value of album select
    this.updateAlbumSelect();

    // #2 create an event and pass it to gallery, which will be used in pl-gallery-controls
    this.component.dispatchEvent( new CustomEvent('pl-album-item-selected', {
      detail: {
        selectAlbum: this.component.shadowRoot.querySelector('pl-album-name').albumName,
        selected: evt.target.selected,
        selectedItems: this.component.data.filter(x=>x.data.id==evt.target.id)
      }
    }) );
  }

  unselectSelectedItems(){
    this.component.data.forEach(item=>{
      if(item.elem && item.elem.selected){
        item.elem.selected = false;
      } else if (item.layout.selected){
        item.layout.selected = false;
      }
    });

    // save a few CPU cycles by directly setting to 'none',
    // rather than calling updateAlbumSelect
    this.component.shadowRoot.querySelector('pl-album-name').albumSelectedValue = 'none';
  }
}