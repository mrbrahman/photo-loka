export class ItemRenderer {
  constructor(component) {
    this.component = component;
  }

  selectivelyPaintLayout(bufferTop, bufferBottom, albumTop) {
    this.component.data.forEach(x=>{
      let thumbTop = albumTop + x.layout.offsetHeight, thumbBottom = thumbTop + x.height;
      
      // add/remove/leave as is from DOM as appropriate
      if ((thumbTop    >= bufferTop && thumbTop    <= bufferBottom) ||
          (thumbBottom >= bufferTop && thumbBottom <= bufferBottom))
      {
        // album is within the boundaries
        this.paintItem(x);
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

  paintLayout() {
    this.component.data.forEach(x=>{
      this.paintItem(x);
    });
  }

  paintItem(x) {
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
      
      this.component.shadowRoot.getElementById('container').appendChild(elem);

    } else if (!x.elem.isConnected){
      // the thumb was removed, but element (class) was found - just append the element back into the DOM
      this.component.shadowRoot.getElementById('container').appendChild(x.elem);

    } else {
      // just update the new position (for resize / delete events)
      x.elem.width = x.layout.width;
      x.elem.height = x.layout.height;
      x.elem.style.transform = `translate(${x.layout.trX},${x.layout.trY})`;
    }
  }
}