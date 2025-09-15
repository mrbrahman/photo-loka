class PlCarousel extends HTMLElement {

  #data = []; #currentIndex = 0;
  constructor() {
    super().attachShadow({mode: 'open'}); // sets "this" and "this.shadowRoot"
  }

  connectedCallback() {
    this.shadowRoot.appendChild(
      document.getElementById(this.nodeName).content.cloneNode(true)
    );

    this.setupEventListeners();
    this.render();
  }

  setupEventListeners() {
    // Close on escape key
    document.addEventListener('keydown', this.handleKeydown);
    
    // Close on outside click
    this.addEventListener('click', this.handleOutsideClick);
    
    // Navigation buttons
    this.shadowRoot.getElementById('prev-btn').addEventListener('click', () => this.navigate(-1));
    this.shadowRoot.getElementById('next-btn').addEventListener('click', () => this.navigate(1));
    this.shadowRoot.getElementById('close-btn').addEventListener('click', () => this.close());
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

  navigate(direction) {
    const track = this.shadowRoot.getElementById('carousel-track');
    const thumbs = track.querySelectorAll('pl-thumb');
    
    if (thumbs.length === 0) return;

    this.#currentIndex += direction;
    
    // Calculate visible width and thumb width for smooth scrolling
    const containerWidth = this.shadowRoot.getElementById('carousel-wrapper').offsetWidth;
    const thumbWidth = thumbs[0].offsetWidth + 10; // including margin
    const visibleThumbs = Math.floor(containerWidth / thumbWidth);
    
    // Clamp index to valid range
    const maxIndex = Math.max(0, thumbs.length - visibleThumbs);
    this.#currentIndex = Math.max(0, Math.min(this.#currentIndex, maxIndex));
    
    // Apply transform
    const translateX = -this.#currentIndex * thumbWidth;
    track.style.transform = `translateX(${translateX}px)`;
    
    // Update button states and load visible thumbs
    this.updateNavigationButtons();
    this.loadVisibleThumbs();
  }

  updateNavigationButtons() {
    const track = this.shadowRoot.getElementById('carousel-track');
    const thumbs = track.querySelectorAll('pl-thumb');
    const containerWidth = this.shadowRoot.getElementById('carousel-wrapper').offsetWidth;
    const thumbWidth = thumbs.length > 0 ? thumbs[0].offsetWidth + 10 : 0;
    const visibleThumbs = Math.floor(containerWidth / thumbWidth);
    const maxIndex = Math.max(0, thumbs.length - visibleThumbs);
    
    this.shadowRoot.getElementById('prev-btn').disabled = this.#currentIndex <= 0;
    this.shadowRoot.getElementById('next-btn').disabled = this.#currentIndex >= maxIndex;
  }

  render() {
    const track = this.shadowRoot.getElementById('carousel-track');
    // track.innerHTML = '';
    
    this.data.forEach((item, index) => {
      const thumb = Object.assign(document.createElement('pl-thumb'), {
        id: item.data.id,
        width: item.data.ar > 1 ? 150 : 150 / item.data.ar,
        height: item.data.ar > 1 ? 150 / item.data.ar : 150,
        rating: item.data.rating || 0
        // dataset.index: index
      })
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
    const thumbs = track.querySelectorAll('pl-thumb');
    const containerWidth = this.shadowRoot.getElementById('carousel-wrapper').offsetWidth;
    const thumbWidth = thumbs.length > 0 ? thumbs[0].offsetWidth + 10 : 0;
    const visibleCount = Math.ceil(containerWidth / thumbWidth) + 2; // +2 for buffer
    
    thumbs.forEach((thumb, index) => {
      if (index >= this.#currentIndex && index < this.#currentIndex + visibleCount) {
        if (!thumb.querySelector('img')) {
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
    // if (this.shadowRoot) {
    //   this.render();
    // }
  }

  get data() {
    return this.#data;
  }
}

customElements.define('pl-carousel', PlCarousel);
