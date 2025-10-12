export class NavigationController {
  constructor(component) {
    this.component = component;
  }

  navigate(direction) {
    const track = this.component.shadowRoot.getElementById('carousel-track');
    if (this.component.layout.length === 0) return;

    const containerWidth = this.component.shadowRoot.getElementById('carousel-wrapper').offsetWidth;
    const scrollAmount = containerWidth * 0.8; // Scroll 80% of container width
    const currentTransform = parseFloat(track.style.transform.replace('translateX(', '').replace('px)', '')) || 0;
    
    let newTransform = currentTransform - (direction * scrollAmount);
    const maxTransform = -(this.component.layout[this.component.layout.length - 1].x + this.component.layout[this.component.layout.length - 1].width - containerWidth);
    
    // Clamp transform to valid range
    newTransform = Math.max(maxTransform, Math.min(0, newTransform));
    
    track.style.transform = `translateX(${newTransform}px)`;
    
    this.updateNavigationButtons();
    this.component.thumbRenderer.loadVisibleThumbs();
  }

  updateNavigationButtons() {
    const track = this.component.shadowRoot.getElementById('carousel-track');
    const containerWidth = this.component.shadowRoot.getElementById('carousel-wrapper').offsetWidth;
    const currentTransform = parseFloat(track.style.transform.replace('translateX(', '').replace('px)', '')) || 0;
    
    if (this.component.layout.length === 0) {
      this.component.shadowRoot.getElementById('prev-btn').style.display = 'none';
      this.component.shadowRoot.getElementById('next-btn').style.display = 'none';
      return;
    }
    
    const totalContentWidth = this.component.layout[this.component.layout.length - 1].x + this.component.layout[this.component.layout.length - 1].width;
    const maxTransform = -(totalContentWidth - containerWidth);
    
    const prevBtn = this.component.shadowRoot.getElementById('prev-btn');
    const nextBtn = this.component.shadowRoot.getElementById('next-btn');
    
    prevBtn.style.display = currentTransform >= 0 ? 'none' : 'flex';
    nextBtn.style.display = (totalContentWidth <= containerWidth || currentTransform <= maxTransform) ? 'none' : 'flex';
  }
}