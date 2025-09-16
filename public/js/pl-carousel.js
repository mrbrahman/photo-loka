import { notify } from './utils.mjs';

class PlCarousel extends HTMLElement {

  #data = []; #currentIndex = 0; #layout = [];
  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
  }

  connectedCallback() {
    this.shadowRoot.appendChild(
      document.getElementById(this.nodeName).content.cloneNode(true)
    );

    this.setupEventListeners();
    this.positionCarousel();
    this.render();
  }

  positionCarousel() {
    if (this.clickX !== undefined && this.clickY !== undefined) {
      const container = this.shadowRoot.querySelector('#container');
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      // Calculate total width needed for all thumbnails
      const totalContentWidth = this.#layout.length > 0 ? 
        this.#layout[this.#layout.length - 1].x + this.#layout[this.#layout.length - 1].width + 20 : 100;
      
      // Use available width or content width, whichever is smaller
      const maxAvailableWidth = viewportWidth - 20;
      const carouselWidth = Math.min(maxAvailableWidth, totalContentWidth);
      const carouselHeight = 230;
      
      // Position below click point, but ensure it stays within viewport
      let left = this.clickX - carouselWidth / 2;
      let top = this.clickY + 20;
      
      // Adjust if carousel would go off screen
      if (left < 10) left = 10;
      if (left + carouselWidth > viewportWidth - 10) left = viewportWidth - carouselWidth - 10;
      if (top + carouselHeight > viewportHeight - 10) top = this.clickY - carouselHeight - 20;
      if (top < 10) top = 10;
      
      this.style.position = 'fixed';
      this.style.top = '0';
      this.style.left = '0';
      this.style.width = '100vw';
      this.style.height = '100vh';
      this.style.background = 'transparent';
      this.style.pointerEvents = 'none';
      
      container.style.position = 'absolute';
      container.style.left = `${left}px`;
      container.style.top = `${top}px`;
      container.style.width = `${carouselWidth}px`;
      container.style.height = `${carouselHeight}px`;
      container.style.pointerEvents = 'auto';
    }
  }

  setupEventListeners() {
    // Close on escape key
    document.addEventListener('keydown', this.handleKeydown);
    
    // Close on outside click
    this.addEventListener('click', this.handleOutsideClick);
    
    // Handle thumb clicks
    this.shadowRoot.addEventListener('click', this.handleThumbClick);
    
    // Navigation buttons
    this.shadowRoot.getElementById('prev-btn').addEventListener('click', (e) => { e.stopPropagation(); this.navigate(-1); });
    this.shadowRoot.getElementById('next-btn').addEventListener('click', (e) => { e.stopPropagation(); this.navigate(1); });
    this.shadowRoot.getElementById('close-btn').addEventListener('click', (e) => { e.stopPropagation(); this.close(); });
  }

  handleKeydown = (e) => {
    if (e.key === 'Escape') {
      this.close();
    }
  }

  handleOutsideClick = (e) => {
    if (e.target === this) {
      this.close();
    }
  }

  handleThumbClick = (e) => {
    if (e.target.tagName === 'PL-THUMB' || e.target.closest('pl-thumb')) {
      e.stopPropagation();
      notify('Feature not yet implemented');
    }
  }

  navigate(direction) {
    const track = this.shadowRoot.getElementById('carousel-track');
    if (this.#layout.length === 0) return;

    const containerWidth = this.shadowRoot.getElementById('carousel-wrapper').offsetWidth;
    const scrollAmount = containerWidth * 0.8; // Scroll 80% of container width
    const currentTransform = parseFloat(track.style.transform.replace('translateX(', '').replace('px)', '')) || 0;
    
    let newTransform = currentTransform - (direction * scrollAmount);
    const maxTransform = -(this.#layout[this.#layout.length - 1].x + this.#layout[this.#layout.length - 1].width - containerWidth);
    
    // Clamp transform to valid range
    newTransform = Math.max(maxTransform, Math.min(0, newTransform));
    
    track.style.transform = `translateX(${newTransform}px)`;
    
    this.updateNavigationButtons();
    this.loadVisibleThumbs();
  }

  updateNavigationButtons() {
    const track = this.shadowRoot.getElementById('carousel-track');
    const containerWidth = this.shadowRoot.getElementById('carousel-wrapper').offsetWidth;
    const currentTransform = parseFloat(track.style.transform.replace('translateX(', '').replace('px)', '')) || 0;
    const maxTransform = this.#layout.length > 0 ? -(this.#layout[this.#layout.length - 1].x + this.#layout[this.#layout.length - 1].width - containerWidth) : 0;
    
    const prevBtn = this.shadowRoot.getElementById('prev-btn');
    const nextBtn = this.shadowRoot.getElementById('next-btn');
    
    prevBtn.style.display = currentTransform >= 0 ? 'none' : 'flex';
    nextBtn.style.display = currentTransform <= maxTransform ? 'none' : 'flex';
  }

  doLayout() {
    const containerWidth = this.shadowRoot.getElementById('carousel-wrapper').offsetWidth;
    let currentX = 0;
    
    this.#layout = this.data.map((item, index) => {
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

  render() {
    const track = this.shadowRoot.getElementById('carousel-track');
    
    this.doLayout();
    this.positionCarousel(); // Reposition after layout to get correct width
    
    const containerWidth = this.shadowRoot.getElementById('carousel-wrapper').offsetWidth;
    
    // Load initial 3 screen widths
    const initialLoadWidth = containerWidth * 3;
    const initialItems = this.#layout.filter(pos => pos.x < initialLoadWidth);
    
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
    
    this.#currentIndex = 0;
    track.style.transform = 'translateX(0px)';
    setTimeout(() => {
      this.updateNavigationButtons();
      this.loadVisibleThumbs();
    }, 100);
  }

  loadVisibleThumbs() {
    const track = this.shadowRoot.getElementById('carousel-track');
    const containerWidth = this.shadowRoot.getElementById('carousel-wrapper').offsetWidth;
    const currentTransform = parseFloat(track.style.transform.replace('translateX(', '').replace('px)', '')) || 0;
    const viewStart = -currentTransform;
    const viewEnd = viewStart + containerWidth;
    
    // Load items that need to be visible plus buffer
    const bufferWidth = containerWidth;
    const loadStart = Math.max(0, viewStart - bufferWidth);
    const loadEnd = viewEnd + bufferWidth;
    
    this.#layout.forEach(pos => {
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

  close() {
    document.removeEventListener('keydown', this.handleKeydown);
    this.remove();
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this.handleKeydown);
  }

  set data(value) {
    this.#data = value || [];
  }
  
  get data() {
    return this.#data;
  }
  
  set clickX(value) {
    this._clickX = value;
  }
  
  get clickX() {
    return this._clickX;
  }
  
  set clickY(value) {
    this._clickY = value;
  }
  
  get clickY() {
    return this._clickY;
  }

}

customElements.define('pl-carousel', PlCarousel);
