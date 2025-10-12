export class NameHandler {
  constructor(component) {
    this.component = component;
  }

  paintName(){
    let a = document.createElement('pl-album-name');
    a.albumName = this.component.album_name;
    a.style.height = this.component.album_name_height + 'px';
    a.addEventListener('pl-rename-dir-not-empty', this.handleDirNotEmptyDuringRename)

    this.component.shadowRoot.getElementById('container').appendChild(a);
  }

  handleDirNotEmptyDuringRename = (evt)=>{ 
    // show dialog
    let dialog = this.component.shadowRoot.querySelector('sl-dialog');

    // TODO: is there a better house for the listeners?
    
    // Ideally, I would add these event listeners during connectedCallBack
    // But then need to find a way to pass the newAlbumName
    // Hence, instead I add the listeners here, as the listeners are only used
    // one time. Because after the move, the album will be deleted, and with
    // it these listeners will also be gone

    dialog.querySelector('#yes').addEventListener('click', ()=>{
      // select all items of this album
      this.component.selectionHandler.handleSelectAll(true);
      
      // send an event to gallery to request move to the new album
      this.component.dispatchEvent(new CustomEvent('pl-album-move-selected-items', {detail: {newAlbumName: evt.detail.newAlbumName}}));
      dialog.hide();
    });

    dialog.querySelector('#no').addEventListener('click', ()=>dialog.hide());

    dialog.show();
  }
}