import {throttle} from '../../utils.mjs';

export class ViewportManager {
  constructor(component) {
    this.component = component;
    this.throttleHandleScroll = throttle(()=>this.selectivelyPaintAlbums(false), 100);
    this.throttleHandleResize = throttle(()=>this.handleResize(), 100);
  }

  selectivelyPaintAlbums(forceRepaint = true) {
    
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
    
    let scrollTop = -this.component.shadowRoot.getElementById('gallery').scrollTop;
    
    // we make the buffers on each side 6 times the size of the screen

    // bufferTop: px above the top of the viewport
    // bufferBottom: px below the bottom of the viewport
    let viewportHeight = this.component.shadowRoot.getElementById('gallery').clientHeight,
      bufferTop = viewportHeight * -6, 
      bufferBottom = viewportHeight * (1+6);
    
    this.component.albums.forEach(album=>{
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
        this.component.albumsInBuffer[album.id] && this.component.albumsInBuffer[album.id] == 'full' && // full album is loaded
        albumBottomInBuffer() && albumTopInBuffer()
      ) {
        // don't need to do anything
        // console.log(`not doing ${album.id}`);
        return;
      }

      if (albumEncompassesBuffer()){
        this.component.albumsInBuffer[album.id] = 'buffer-overflow';
        album.selectivelyPaintLayout(bufferTop, bufferBottom, albumTop);
      }
      // if albumTop is within the buffer or albumBottom is within the buffer, we need to show
      // (at least part of) the album
      else if (albumBottomInBuffer() || albumTopInBuffer()) {
        album.selectivelyPaintLayout(bufferTop, bufferBottom, albumTop);
        
        if (albumBottomInBuffer() && albumTopInBuffer()){
          this.component.albumsInBuffer[album.id] = 'full';

        } else {
          this.component.albumsInBuffer[album.id] = 'partial';
        }
        
      } else {
        // the album is not within the buffered area
        
        if(this.component.albumsInBuffer[album.id]){
          // if the album was in the buffered area before, selectively paint layout once more,
          // so any visible thumbs can be removed
          album.selectivelyPaintLayout(bufferTop, bufferBottom, albumTop);
          delete this.component.albumsInBuffer[album.id];
        }
      }
    });

    console.log(this.component.albumsInBuffer)
  }

  handleResize() {
    // apply the new width to all albums
    this.component.albumManager.reAssignAlbumWidths();
    // re-assign album positions, and selectively paint
    this.component.handleAlbumHeightChange();
  }

  setupEventListeners() {
    this.component.shadowRoot.getElementById('gallery')
      .addEventListener('scroll', this.throttleHandleScroll)
    ;
    
    window.addEventListener('resize', this.throttleHandleResize)
    ;
  }

  removeEventListeners() {
    this.component.shadowRoot.getElementById('gallery')
      .removeEventListener('scroll', this.throttleHandleScroll)
    ;
    
    window
      .removeEventListener('resize', this.throttleHandleResize)
    ;
  }
}