export class ThumbRenderer {
  constructor(component) {
    this.component = component;
  }

  render() {
    const track = this.component.shadowRoot.getElementById('carousel-track');
    
    this.component.layoutManager.doLayout();
    this.component.layoutManager.positionCarousel(); // Reposition after layout to get correct width
    
    const containerWidth = this.component.shadowRoot.getElementById('carousel-wrapper').offsetWidth;
    
    // Load initial 3 screen widths
    const initialLoadWidth = containerWidth * 3;
    const initialItems = this.component.layout.filter(pos => pos.x < initialLoadWidth);
    
    initialItems.forEach(pos => {
      const thumb = Object.assign(document.createElement('pl-thumb'), {
        id: pos.item.data.id,
        width: pos.width,
        height: pos.height,
        rating: pos.item.data.rating || 0
      });
      thumb.style.transform = `translateX(${pos.x}px)`;
      track.appendChild(thumb);
    });
    
    this.component.currentIndex = 0;
    track.style.transform = 'translateX(0px)';
    setTimeout(() => {
      this.component.navigationController.updateNavigationButtons();
      this.loadVisibleThumbs();
    }, 100);
  }

  loadVisibleThumbs() {
    const track = this.component.shadowRoot.getElementById('carousel-track');
    const containerWidth = this.component.shadowRoot.getElementById('carousel-wrapper').offsetWidth;
    const currentTransform = parseFloat(track.style.transform.replace('translateX(', '').replace('px)', '')) || 0;
    const viewStart = -currentTransform;
    const viewEnd = viewStart + containerWidth;
    
    // Load items that need to be visible plus buffer
    const bufferWidth = containerWidth;
    const loadStart = Math.max(0, viewStart - bufferWidth);
    const loadEnd = viewEnd + bufferWidth;
    
    this.component.layout.forEach(pos => {
      if (pos.x >= loadStart && pos.x <= loadEnd) {
        const existingThumb = track.querySelector(`pl-thumb[id="${pos.item.data.id}"]`);
        if (!existingThumb) {
          const thumb = Object.assign(document.createElement('pl-thumb'), {
            id: pos.item.data.id,
            width: pos.width,
            height: pos.height,
            rating: pos.item.data.rating || 0
          });
          thumb.style.transform = `translateX(${pos.x}px)`;
          track.appendChild(thumb);
        }
        
        const thumb = track.querySelector(`pl-thumb[id="${pos.item.data.id}"]`);
        if (thumb && !thumb.querySelector('img')) {
          thumb.connectedCallback();
        }
      }
    });
  }
}