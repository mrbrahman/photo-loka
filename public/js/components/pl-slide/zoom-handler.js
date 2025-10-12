export class ZoomHandler {
  constructor(component) {
    this.component = component;
    this.zoomLevel = 1;
    this.maxZoom = 1;
    this.startX = 0;
    this.startY = 0;
    this.translateX = 0;
    this.translateY = 0;
  }

  setupZoomControls() {
    const zoomIn = this.component.shadowRoot.getElementById('zoom-in');
    const zoomOut = this.component.shadowRoot.getElementById('zoom-out');
    
    zoomIn?.addEventListener('click', () => this.zoomIn());
    zoomOut?.addEventListener('click', () => this.zoomOut());
  }

  setupImageZoom(img) {
    // Touch events for mobile
    let initialDistance = 0;
    let initialZoom = 1;
    let isPinching = false;
    let isDragging = false;
    
    img.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        isPinching = true;
        initialDistance = this.getDistance(e.touches[0], e.touches[1]);
        initialZoom = this.zoomLevel;
      } else if (e.touches.length === 1 && this.zoomLevel > 1) {
        isDragging = true;
        this.startX = e.touches[0].clientX - this.translateX;
        this.startY = e.touches[0].clientY - this.translateY;
      }
    });
    
    img.addEventListener('touchmove', (e) => {
      if (e.touches.length === 2 && isPinching) {
        e.preventDefault();
        const currentDistance = this.getDistance(e.touches[0], e.touches[1]);
        const scale = currentDistance / initialDistance;
        this.setZoom(Math.min(this.maxZoom, Math.max(1, initialZoom * scale)));
      } else if (e.touches.length === 1 && isDragging && this.zoomLevel > 1) {
        e.preventDefault();
        this.translateX = e.touches[0].clientX - this.startX;
        this.translateY = e.touches[0].clientY - this.startY;
        this.constrainPan(img);
        this.updateTransform(img);
      }
    });
    
    img.addEventListener('touchend', (e) => {
      if (e.touches.length === 0) {
        isPinching = false;
        isDragging = false;
      }
    });
    
    // Mouse events for desktop
    img.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      this.setZoom(Math.min(this.maxZoom, Math.max(1, this.zoomLevel + delta)));
    });
    
    img.addEventListener('mousedown', (e) => {
      if (this.zoomLevel > 1) {
        isDragging = true;
        this.startX = e.clientX - this.translateX;
        this.startY = e.clientY - this.translateY;
        img.style.cursor = 'grabbing';
        e.preventDefault();
      }
    });
    
    img.addEventListener('mousemove', (e) => {
      if (isDragging && this.zoomLevel > 1) {
        this.translateX = e.clientX - this.startX;
        this.translateY = e.clientY - this.startY;
        this.constrainPan(img);
        this.updateTransform(img);
        e.preventDefault();
      } else if (this.zoomLevel > 1) {
        img.style.cursor = 'grab';
      } else {
        img.style.cursor = 'default';
      }
    });
    
    img.addEventListener('mouseup', () => {
      isDragging = false;
      if (this.zoomLevel > 1) {
        img.style.cursor = 'grab';
      }
    });
    
    img.addEventListener('mouseleave', () => {
      isDragging = false;
    });
    
    // Double click for desktop
    img.addEventListener('dblclick', (e) => {
      e.preventDefault();
      this.handleDoubleTap();
    });
    
    // Double tap to zoom in/reset
    let lastTap = 0;
    let tapCount = 0;
    img.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        const currentTime = new Date().getTime();
        const tapLength = currentTime - lastTap;
        if (tapLength < 300 && tapLength > 0) {
          tapCount++;
          if (tapCount === 2) {
            e.preventDefault();
            this.handleDoubleTap();
            tapCount = 0;
          }
        } else {
          tapCount = 1;
        }
        lastTap = currentTime;
      }
    });
  }

  getDistance(touch1, touch2) {
    return Math.sqrt(
      Math.pow(touch2.clientX - touch1.clientX, 2) + 
      Math.pow(touch2.clientY - touch1.clientY, 2)
    );
  }

  zoomIn() {
    this.setZoom(Math.min(this.maxZoom, this.zoomLevel + 0.25));
  }

  zoomOut() {
    this.setZoom(Math.max(1, this.zoomLevel - 0.25));
  }

  setZoom(newZoom, smooth = false) {
    this.zoomLevel = newZoom;
    const img = this.component.shadowRoot.querySelector('#media img');
    if (img) {
      if (this.zoomLevel === 1) {
        this.translateX = 0;
        this.translateY = 0;
      }
      this.updateTransform(img, smooth);
      this.updateZoomButtons();
    }
  }

  resetZoom(smooth = false) {
    this.zoomLevel = 1;
    this.translateX = 0;
    this.translateY = 0;
    const img = this.component.shadowRoot.querySelector('#media img');
    if (img) {
      this.updateTransform(img, smooth);
      this.updateZoomButtons();
    }
  }

  updateTransform(img, smooth = false) {
    if (smooth) {
      img.style.transition = 'transform 0.3s ease-out';
      setTimeout(() => img.style.transition = '', 300);
    }
    img.style.transform = `scale(${this.zoomLevel}) translate(${this.translateX / this.zoomLevel}px, ${this.translateY / this.zoomLevel}px)`;
    img.style.transformOrigin = 'center center';
    img.style.cursor = this.zoomLevel > 1 ? 'grab' : 'default';
  }

  updateZoomButtons() {
    const zoomIn = this.component.shadowRoot.getElementById('zoom-in');
    const zoomOut = this.component.shadowRoot.getElementById('zoom-out');
    
    if (zoomIn) zoomIn.disabled = this.zoomLevel >= this.maxZoom;
    if (zoomOut) zoomOut.disabled = this.zoomLevel <= 1;
  }

  constrainPan(img) {
    const scaledWidth = img.offsetWidth * this.zoomLevel;
    const scaledHeight = img.offsetHeight * this.zoomLevel;
    const containerWidth = this.component.screenWidth;
    const containerHeight = this.component.screenHeight;
    
    const maxTranslateX = Math.max(0, (scaledWidth - containerWidth) / 2);
    const maxTranslateY = Math.max(0, (scaledHeight - containerHeight) / 2);
    
    this.translateX = Math.max(-maxTranslateX, Math.min(maxTranslateX, this.translateX));
    this.translateY = Math.max(-maxTranslateY, Math.min(maxTranslateY, this.translateY));
  }

  handleDoubleTap() {
    if (this.zoomLevel >= this.maxZoom) {
      this.resetZoom(true);
    } else {
      const nextZoom = Math.min(this.maxZoom, this.zoomLevel * 2);
      this.setZoom(nextZoom, true);
    }
  }
}