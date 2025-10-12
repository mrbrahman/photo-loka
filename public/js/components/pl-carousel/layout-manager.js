export class LayoutManager {
  constructor(component) {
    this.component = component;
  }

  doLayout() {
    const containerWidth = this.component.shadowRoot.getElementById('carousel-wrapper').offsetWidth;
    let currentX = 0;
    
    this.component.layout = this.component.data.map((item, index) => {
      const height = 200;
      const width = height * item.data.ar;
      
      const position = {
        index,
        x: currentX,
        width,
        height,
        item
      };
      
      currentX += width + 5; // 5px margin
      return position;
    });
  }

  positionCarousel() {
    if (this.component.clickX !== undefined && this.component.clickY !== undefined) {
      const container = this.component.shadowRoot.getElementById('container');
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      // Calculate total width needed for all thumbnails
      const totalContentWidth = this.component.layout.length > 0 ? 
        this.component.layout[this.component.layout.length - 1].x + this.component.layout[this.component.layout.length - 1].width + 20 : 100;
      
      // Use available width or content width, whichever is smaller
      const maxAvailableWidth = viewportWidth - 20;
      const carouselWidth = Math.min(maxAvailableWidth, totalContentWidth);
      const carouselHeight = 230;
      
      // Position below click point, but ensure it stays within viewport
      let left = this.component.clickX - carouselWidth / 2;
      let top = this.component.clickY + 20;
      
      // Adjust if carousel would go off screen
      if (left < 10) left = 10;
      if (left + carouselWidth > viewportWidth - 10) left = viewportWidth - carouselWidth - 10;
      if (top + carouselHeight > viewportHeight - 10) top = this.component.clickY - carouselHeight - 20;
      if (top < 10) top = 10;
      
      container.style.left = `${left}px`;
      container.style.top = `${top}px`;
      container.style.width = `${carouselWidth}px`;
      container.style.height = `${carouselHeight}px`;
    }
  }
}