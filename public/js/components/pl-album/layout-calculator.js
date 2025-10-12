export class LayoutCalculator {
  constructor(component) {
    this.component = component;
  }

  getMinAspectRatio() {
    if (this.component.width <= 640) {
      return 1.5;
    } else if (this.component.width <= 1280) {
      return 4;
    } else if (this.component.width <= 1920) {
      return 5;
    }
    return 6;
  }
  
  doLayout() {
    let minAspectRatio = this.getMinAspectRatio(), row = [], rowAspectRatio = 0, 
      trX = 0, trY = this.component.album_name_height;

    this.component.data.forEach((d,i)=>{
      row.push(d);
      rowAspectRatio += d.data.ar;
      
      if (rowAspectRatio >= minAspectRatio || i+1 == this.component.data.length){
        // we've reached the max items possible in this row, or this is the last element
        
        // calculate row height
        // total width of images in this row = width of screen - space between images - space at the 2 ends
        
        // make sure the last image has reasonable height (not too big)
        rowAspectRatio = Math.max(rowAspectRatio, minAspectRatio);
        
        let totalWidthOfImages = this.component.width - (this.component.gutterspace * row.length-1) - this.component.gutterspace * 2;
        let rowHeight = totalWidthOfImages / rowAspectRatio;
        
        // add gutter space to the Y axis
        trY += this.component.gutterspace;
        
        // create layout objects for all entries in this row
        for(let r of row){
          trX += this.component.gutterspace;
          
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

    this.component.album_height = trY;
    this.component.shadowRoot.getElementById('container').style.height = this.component.album_height+'px';
  }
}