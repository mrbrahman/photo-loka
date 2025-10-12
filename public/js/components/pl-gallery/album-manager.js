export class AlbumManager {
  constructor(component) {
    this.component = component;
  }

  createAlbums() {
    return this.component.data.map(d=>{
      let album = Object.assign(document.createElement('pl-album'), {
        id: d.id,
        album_name: d.album,
        data: d.items,
        width: this.component.shadowRoot.getElementById('gallery').clientWidth
      });

      this.addAlbumEventListeners(album);
      return album;
    });
  }

  addAlbumEventListeners = (album)=>{
    album.addEventListener('pl-album-height-changed', this.component.handleAlbumHeightChange);
    album.addEventListener('pl-album-empty', this.component.removeAlbum);
    album.addEventListener('pl-album-item-selected', this.component.handleItemsSelected);
    album.addEventListener('pl-album-move-selected-items', (evt)=>{
      this.component.createOrMoveSelectedItems(evt.detail.newAlbumName.trim())
    });
  }

  reAssignAlbumPositions(){
    let cumHeight = 0;
    this.component.albums.forEach(album=>{
      album.style.top = cumHeight+'px';
      album.style.left = '0px';

      cumHeight += album.album_height; //+ 40; // px between albums
    });
  }

  reAssignAlbumWidths(){
    this.component.albums.forEach(album=>{
      album.width = this.component.shadowRoot.getElementById('gallery').clientWidth;
      album.redoLayout();
    });
  }

  removeAlbum = (evt) => {
    let deletedAlbumId = evt.composedPath()[0].id;

    let idx = this.component.albums.findIndex(x=>x.id == deletedAlbumId);

    // remove the album from DOM as well as reference in array
    this.component.shadowRoot.getElementById(deletedAlbumId).remove();
    this.component.albums.splice(idx, 1);
    delete(this.component.albumsInBuffer[deletedAlbumId]);

    this.component.handleAlbumHeightChange();
  }
}