import {notify} from '../../utils.mjs';
import {userState} from '../../user-state.mjs';

export class ItemMover {
  constructor(component) {
    this.component = component;
  }

  async createOrMoveSelectedItems(targetAlbumName) {
    let allAlbumNames = this.component.albums.map(x=>x.album_name);
  
    try {
      // first save in backend
      await fetch('/api/moveItems', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          collection_id: userState.getCollectionId(),
          uuid_arr: this.component.itemsSelected.map(x=>x.data.id),
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
      this.component.albums.forEach(album=>album.deleteSelectedItems());

      // now add them to the target album
      if(allAlbumNames.includes(targetAlbumName)){
        // album exists, just move the items there
        let targetAlbum = this.component.albums.find(x=>x.album_name == targetAlbumName);
        targetAlbum.addNewItems(this.component.itemsSelected);

      } else {
        // create new album
        let newAlbum = Object.assign(document.createElement('pl-album'), {
          id: targetAlbumName.replaceAll(/[\s/]/gi, '_'),
          album_name: targetAlbumName,
          data: this.component.itemsSelected,
          width: this.component.shadowRoot.getElementById('gallery').clientWidth
        });

        this.component.albumManager.addAlbumEventListeners(newAlbum);

        // find where to insert the new album element
        allAlbumNames.push(targetAlbumName);
        allAlbumNames.sort().reverse();
        // before ['a', 'b', 'c', 'd']   now insert in position 2
        // after ['a', 'b', 'b-new', 'c', 'd']
        let i = allAlbumNames.indexOf(targetAlbumName);
        if(i==this.component.albums.length){
          // insert at the end of the current album list, and make DOM changes
          this.component.albums.push(newAlbum);
          this.component.shadowRoot.getElementById('gallery').appendChild(newAlbum);
        } else {
          // need to insert in the middle
          this.component.albums.splice(i, 0, newAlbum);
          let el = this.component.shadowRoot.getElementById('gallery').querySelector(`:nth-child(${i+1})`); // css index starts with 1
          el.insertAdjacentElement('beforebegin', newAlbum);

        }
      }

      this.component.albumManager.reAssignAlbumPositions();
      this.component.viewportManager.selectivelyPaintAlbums();

      notify(`${this.component.itemsSelected.length} item${this.component.itemsSelected.length > 1 ? 's' : ''} moved`, 'success');

      // We don't want to keep the items selected, hence force gallery controls close
      this.component.selectionManager.handleGalleryControlsClosed();

    } catch (err) {
      notify(`<strong>Error</strong>:</br>${err}`, 'error', -1);
    }
  }
}