import {notify} from '../../utils.mjs';
import {userState} from '../../user-state.mjs';

export class SelectionManager {
  constructor(component) {
    this.component = component;
  }

  handleItemsSelected = (evt)=>{
    let {selectAlbum, selected, selectedItems} = evt.detail;

    // update the list with the ones selected/de-selected
    if(selected){
      // TODO: edge case - if the album is first selected, then the album name is changed, that changed 
      // album name is not going to be reflected in here. Need to think of a different design
      
      this.component.albumsSelectedCnt[selectAlbum] =  this.component.albumsSelectedCnt[selectAlbum] || 0 + selectedItems.length;
      this.component.itemsSelected.push(...selectedItems);
    } else {
      this.component.albumsSelectedCnt[selectAlbum] -= selectedItems.length;
      // remove selectedItems from this.component.itemsSelected
      // https://stackoverflow.com/a/47017949/8098748
      this.component.itemsSelected = this.component.itemsSelected.filter(function(a) {
        return !selectedItems.find(function(b) {
          return a.data.id === b.data.id
        })
      })
    }

    if(this.component.itemsSelected.length > 0){
      
      if(!document.body.querySelector('pl-gallery-controls')){
        let c = document.createElement('pl-gallery-controls');
        document.body.append(c);

        c.addEventListener('pl-gallery-controls-closed', this.handleGalleryControlsClosed);
        c.addEventListener('pl-gallery-controls-rating-changed', this.handleGalleryControlsRatingChanged);
        c.addEventListener('pl-gallery-controls-delete-pressed', this.handleGalleryControlsDeletePressed);
        c.addEventListener('pl-gallery-controls-dialog-save', (evt)=>{
          this.component.createOrMoveSelectedItems(evt.detail.trim())
        });
      }

      let c = document.body.querySelector('pl-gallery-controls');
      c.ctr = this.component.itemsSelected.length;
      c.selectedAlbums = this.component.albumsSelectedCnt;

      let distinctRatings = [... new Set(this.component.itemsSelected.map(x=>x.data.rating))]

      // if all selected items have the same rating, then set the value to that rating.
      // otherwise don't set the rating
      if (distinctRatings.length == 1){
        c.rating = distinctRatings[0]
      } else {
        c.rating = 0
      }

      
    } else if(this.component.itemsSelected.length == 0){
      this.removeGalleryControls();
    }
  }

  handleGalleryControlsClosed = ()=>{
    this.component.albums.forEach(album=>{
      album.unselectSelectedItems();
    });
    
    this.removeGalleryControls();
  }
  
  removeGalleryControls = ()=>{
    this.component.itemsSelected = []; 
    this.component.albumsSelectedCnt = {};

    let c = document.body.querySelector('pl-gallery-controls');
    c.remove();
  }

  handleGalleryControlsRatingChanged = (evt)=>{
    // update db here
    fetch('/api/updateRating', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        uuid_arr: this.component.itemsSelected.map(x=>x.data.id),
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
      this.component.albums.forEach(album=>{
        album.changeRatingSelectedItems(evt.detail.newRating);
      });

      notify(`Updated rating for ${this.component.itemsSelected.length} item${this.component.itemsSelected.length > 1 ? 's' : ''}`, 'success');
    })
    .catch(err=>{
      notify(`<strong>Error</strong>:</br>${err}`, 'error', -1);
    });
  }

  handleGalleryControlsDeletePressed = (evt)=>{
    // update db here
    fetch(`/api/trashItems`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        collection_id: userState.getCollectionId(),
        uuid_arr: this.component.itemsSelected.map(x=>x.data.id)
      })
    })
    .then(res=>{
      if(!res.ok){
        throw `${res.status} ${res.statusText}`
      }
    })
    .then(()=>{
      this.component.albums.forEach(album=>album.deleteSelectedItems());
      let trashedCnt = this.component.itemsSelected.length;
      // all items selected are deleted. No need to keep gallery controls anymore
      this.removeGalleryControls();
      notify(`${trashedCnt} item${trashedCnt > 1 ? 's' : ''} moved to trash`, 'success');
    })
    .catch(err=>{
      notify(`<strong>Error</strong>:</br>${err}`, 'error', -1);
    });
  }
}