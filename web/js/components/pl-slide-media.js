import {notify} from '../utils.mjs';

import sheet from "./styles/pl-slide-media.css" with { type: "css" };

class PlSlideMedia extends HTMLElement {
  #albumname; #item; #play; #slideshowMode; #mode = 'default';
  #zoomLevel = 1; #maxZoom = 1; #startX = 0; #startY = 0; #translateX = 0; #translateY = 0;
  #eventHandlers = [];

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <div id="container">
        <div id="media"></div>
        <div id="albumname"></div>
        <div id="zoom-controls">
          <sl-icon-button id="zoom-in" name="plus-lg"></sl-icon-button>
          <sl-icon-button id="zoom-out" name="dash-lg"></sl-icon-button>
        </div>
        <div id="actions">
          <sl-rating id="rating"></sl-rating>
          <sl-icon-button id="info" name="info-circle"></sl-icon-button>
          <sl-dropdown>
            <sl-icon-button slot="trigger" name="three-dots-vertical"></sl-icon-button>
            <sl-menu>
              <sl-menu-item id="start-slideshow">Slideshow</sl-menu-item>
            </sl-menu>
          </sl-dropdown>
        </div>
      </div>
    `;
  }

  constructor() {
    super().attachShadow({mode: 'open'});
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    this.shadowRoot.getElementById('albumname').innerText = this.albumname || '';
    this.shadowRoot.getElementById('rating').setAttribute('value', this.item?.data?.rating || 0);

    this.shadowRoot.getElementById('rating').addEventListener('sl-change', this.#handleRatingChanged);

    this.shadowRoot.getElementById('start-slideshow').addEventListener('click', () => {
      this.dispatchEvent(new Event('pl-start-slideshow', {composed: true, bubbles: true}));
    });

    this.shadowRoot.getElementById('info').addEventListener('click', () => {
      this.dispatchEvent(new Event('pl-info-toggle-requested', {composed: true, bubbles: true}));
    });

    // this.#setupZoomControls();
    this.#setupKeyboardControls();

    let hideActions = this.#slideshowMode || this.#mode === 'trash';
    if (hideActions) {
      this.shadowRoot.getElementById('actions').classList.add('hidden');
    } else {
      this.shadowRoot.getElementById('actions').classList.remove('hidden');
    }

    if (this.item?.data?.type?.startsWith('image')) {
      let img = Object.assign(document.createElement('img'), {
        src: `/api/getImage?uuid=${this.item.data.id}`
      });

      img.onload = () => {
        this.#maxZoom = Math.max(img.naturalWidth / img.offsetWidth, img.naturalHeight / img.offsetHeight) * 1.5;
        this.#updateZoomButtons();
        this.dispatchEvent(new Event('pl-slide-ready', {composed: true, bubbles: true}));
      };

      this.#setupImageZoom(img);
      this.shadowRoot.getElementById('media').appendChild(img);

    } else if (this.item.data.type.startsWith('video')) {
      let video = Object.assign(document.createElement('video'), {
        controls: true,
        muted: false,
        preload: 'metadata'
      });

      let src = Object.assign(document.createElement('source'), {
        src: `/api/getVideo?uuid=${this.item.data.id}&quality=${window.innerWidth >= 1281 ? 'original' : 'compressed'}`
      });

      let txt = 'Cannot play video';
      video.append(src, txt);

      video.addEventListener('canplay', () => {
        this.dispatchEvent(new Event('pl-slide-ready', {once: true}));
      });

      video.addEventListener('ended', () => {
        this.dispatchEvent(new Event('pl-slideshow-video-ended', {once: true}));
      });

      document.addEventListener('visibilitychange', this.#handleVisibilityChange);
      this.#eventHandlers.push({element: document, event: 'visibilitychange', handler: this.#handleVisibilityChange});

      this.shadowRoot.getElementById('media').appendChild(video);

    } else {
      this.shadowRoot.getElementById('media').innerHTML = `<div>${this.item.data.type} TBD</div>`;
    }
  }

  #handleVisibilityChange = () => {
    let video = this.shadowRoot.getElementById('media')?.querySelector('video');
    if (video) {
      if (document.hidden) {
        video.pause();
      } else {
        video.play();
      }
    }
  }

  #handleRatingChanged = (evt) => {
    let item = this.item, newRating = evt.target.value;
    console.log(item);

    if (item.data.rating == newRating) {
      return;
    }

    fetch('/api/updateRating', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        uuid_arr: [item.data.id],
        newRating
      })
    })
    .then(async res => {
      if (!res.ok) {
        throw await res.json().catch(() => ({error: {message: `${res.status} ${res.statusText}`}}));
      }
    })
    .then(() => {
      item.data.rating = newRating;

      if (item.elem) {
        item.elem.rating = newRating;
      }

      notify(`Updated rating for this item`, 'success');
    })
    .catch(err => {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
      this.shadowRoot.getElementById('rating').value = item.data.rating;
    });
  }

  #playPauseMedia() {
    if (this.item?.data?.type?.startsWith("video")) {
      let media = this.shadowRoot.getElementById('media')?.firstElementChild;
      if (media) {
        if (this.play) {
          media.play();
        } else {
          media.pause();
        }
      }
    }
  }

  disconnectedCallback() {
    this.#eventHandlers.forEach(({element, event, handler, options}) => {
      element.removeEventListener(event, handler, options);
    });
    this.#eventHandlers = [];

    let video = this.shadowRoot.querySelector('video');
    if (video) {
      video.pause();
      video.querySelector('source')?.remove();
      video.load();
    }
  }

  set albumname(_) { this.#albumname = _; }
  get albumname() { return this.#albumname; }

  set item(_) { this.#item = _; }
  get item() { return this.#item; }

  set play(_) {
    this.#play = Boolean(_);
    this.#playPauseMedia();
  }
  get play() { return this.#play; }

  set slideshowMode(_) {
    this.#slideshowMode = Boolean(_);
    if (!this.isConnected) return;

    if (this.#slideshowMode || this.#mode === 'trash') {
      this.shadowRoot.getElementById('actions').classList.add('hidden');
    } else {
      this.shadowRoot.getElementById('actions').classList.remove('hidden');
    }
  }
  get slideshowMode() { return this.#slideshowMode; }

  set mode(_) { this.#mode = _ || 'default'; }
  get mode() { return this.#mode; }

  get zoomLevel() { return this.#zoomLevel; }

  get mediaRect() {
    let el = this.shadowRoot.querySelector('#media img, #media video');
    return el?.getBoundingClientRect() ?? null;
  }

  resetZoom() {
    this.#resetZoom();
  }

  #setupZoomControls() {
    const zoomIn = this.shadowRoot.getElementById('zoom-in');
    const zoomOut = this.shadowRoot.getElementById('zoom-out');

    zoomIn?.addEventListener('click', () => this.#zoomIn());
    zoomOut?.addEventListener('click', () => this.#zoomOut());
  }

  #setupKeyboardControls() {
    const handler = (e) => {
      const img = this.shadowRoot.querySelector('#media img');
      if (!img) return;

      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        this.#zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        this.#zoomOut();
      } else if (this.#zoomLevel > 1) {
        const step = 50;
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          this.#translateX += step;
          this.#constrainPan(img);
          this.#updateTransform(img);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          this.#translateX -= step;
          this.#constrainPan(img);
          this.#updateTransform(img);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.#translateY += step;
          this.#constrainPan(img);
          this.#updateTransform(img);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.#translateY -= step;
          this.#constrainPan(img);
          this.#updateTransform(img);
        }
      }
    };
    document.addEventListener('keydown', handler);
    this.#eventHandlers.push({element: document, event: 'keydown', handler});
  }

  #setupImageZoom(img) {
    let initialDistance = 0;
    let initialZoom = 1;
    let isPinching = false;
    let isDragging = false;
    let lastTapX = 0;
    let lastTapY = 0;
    let pinchCenterX = 0;
    let pinchCenterY = 0;
    let lastTap = 0;
    let tapCount = 0;

    const touchStartHandler = (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        isPinching = true;
        isDragging = false;
        initialDistance = this.#getDistance(e.touches[0], e.touches[1]);
        initialZoom = this.#zoomLevel;
        pinchCenterX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        pinchCenterY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      } else if (e.touches.length === 1) {
        if (this.#zoomLevel > 1) {
          isDragging = true;
          this.#startX = e.touches[0].clientX - this.#translateX;
          this.#startY = e.touches[0].clientY - this.#translateY;
        }

        const currentTime = new Date().getTime();
        const tapLength = currentTime - lastTap;
        lastTapX = e.touches[0].clientX;
        lastTapY = e.touches[0].clientY;
        if (tapLength < 300 && tapLength > 0) {
          tapCount++;
          if (tapCount === 2) {
            e.preventDefault();
            this.#handleDoubleTap(lastTapX, lastTapY, img);
            tapCount = 0;
          }
        } else {
          tapCount = 1;
        }
        lastTap = currentTime;
      }
    };

    const touchMoveHandler = (e) => {
      if (e.touches.length === 2 && isPinching) {
        e.preventDefault();
        const currentDistance = this.#getDistance(e.touches[0], e.touches[1]);
        const scale = currentDistance / initialDistance;
        const newZoom = Math.min(this.#maxZoom, Math.max(1, initialZoom * scale));
        this.#setZoomAtPoint(newZoom, pinchCenterX, pinchCenterY, img);
      } else if (e.touches.length === 1 && isDragging && this.#zoomLevel > 1) {
        e.preventDefault();
        this.#translateX = e.touches[0].clientX - this.#startX;
        this.#translateY = e.touches[0].clientY - this.#startY;
        this.#constrainPan(img);
        this.#updateTransform(img);
      }
    };

    const touchEndHandler = (e) => {
      if (e.touches.length === 1 && isPinching) {
        isPinching = false;
        isDragging = true;
        this.#startX = e.touches[0].clientX - this.#translateX;
        this.#startY = e.touches[0].clientY - this.#translateY;
      } else if (e.touches.length === 0) {
        isPinching = false;
        isDragging = false;
      }
    };

    const wheelHandler = (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.2 : 0.2;
      const newZoom = Math.min(this.#maxZoom, Math.max(1, this.#zoomLevel + delta));
      this.#setZoomAtPoint(newZoom, e.clientX, e.clientY, img);
    };

    const mouseDownHandler = (e) => {
      if (this.#zoomLevel > 1) {
        isDragging = true;
        this.#startX = e.clientX - this.#translateX;
        this.#startY = e.clientY - this.#translateY;
        img.style.cursor = 'grabbing';
        e.preventDefault();
      }
    };

    const mouseMoveHandler = (e) => {
      if (isDragging && this.#zoomLevel > 1) {
        this.#translateX = e.clientX - this.#startX;
        this.#translateY = e.clientY - this.#startY;
        this.#constrainPan(img);
        this.#updateTransform(img);
        e.preventDefault();
      } else if (this.#zoomLevel > 1) {
        img.style.cursor = 'grab';
      } else {
        img.style.cursor = 'default';
      }
    };

    const mouseUpHandler = () => {
      isDragging = false;
      if (this.#zoomLevel > 1) {
        img.style.cursor = 'grab';
      } else {
        img.style.cursor = 'default';
      }
    };

    const mouseLeaveHandler = () => {
      isDragging = false;
    };

    const dblClickHandler = (e) => {
      e.preventDefault();
      this.#handleDoubleTap(e.clientX, e.clientY, img);
    };

    img.addEventListener('touchstart', touchStartHandler, {passive: false});
    img.addEventListener('touchmove', touchMoveHandler, {passive: false});
    img.addEventListener('touchend', touchEndHandler, {passive: false});
    img.addEventListener('wheel', wheelHandler, {passive: false});
    img.addEventListener('mousedown', mouseDownHandler);
    img.addEventListener('mousemove', mouseMoveHandler);
    img.addEventListener('mouseup', mouseUpHandler);
    img.addEventListener('mouseleave', mouseLeaveHandler);
    img.addEventListener('dblclick', dblClickHandler);

    this.#eventHandlers.push(
      {element: img, event: 'touchstart', handler: touchStartHandler, options: {passive: false}},
      {element: img, event: 'touchmove', handler: touchMoveHandler, options: {passive: false}},
      {element: img, event: 'touchend', handler: touchEndHandler, options: {passive: false}},
      {element: img, event: 'wheel', handler: wheelHandler, options: {passive: false}},
      {element: img, event: 'mousedown', handler: mouseDownHandler},
      {element: img, event: 'mousemove', handler: mouseMoveHandler},
      {element: img, event: 'mouseup', handler: mouseUpHandler},
      {element: img, event: 'mouseleave', handler: mouseLeaveHandler},
      {element: img, event: 'dblclick', handler: dblClickHandler}
    );
  }

  #getDistance(touch1, touch2) {
    const dx = touch2.clientX - touch1.clientX;
    const dy = touch2.clientY - touch1.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  #zoomIn() {
    const img = this.shadowRoot.querySelector('#media img');
    if (img) {
      const rect = img.getBoundingClientRect();
      this.#setZoomAtPoint(Math.min(this.#maxZoom, this.#zoomLevel + 0.25), rect.left + rect.width / 2, rect.top + rect.height / 2, img, true);
    }
  }

  #zoomOut() {
    const img = this.shadowRoot.querySelector('#media img');
    if (img) {
      const rect = img.getBoundingClientRect();
      this.#setZoomAtPoint(Math.max(1, this.#zoomLevel - 0.25), rect.left + rect.width / 2, rect.top + rect.height / 2, img, true);
    }
  }

  #setZoomAtPoint(newZoom, clientX, clientY, img, smooth = false) {
    const rect = img.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const relX = x / rect.width;
    const relY = y / rect.height;

    const oldZoom = this.#zoomLevel;
    this.#zoomLevel = newZoom;

    if (this.#zoomLevel === 1) {
      this.#translateX = 0;
      this.#translateY = 0;
    } else {
      const zoomRatio = this.#zoomLevel / oldZoom;
      this.#translateX = (this.#translateX - (relX - 0.5) * rect.width) * zoomRatio + (relX - 0.5) * rect.width;
      this.#translateY = (this.#translateY - (relY - 0.5) * rect.height) * zoomRatio + (relY - 0.5) * rect.height;
      this.#constrainPan(img);
    }

    this.#updateTransform(img, smooth);
    this.#updateZoomButtons();
  }

  #setZoom(newZoom, smooth = false) {
    this.#zoomLevel = newZoom;
    const img = this.shadowRoot.querySelector('#media img');
    if (img) {
      if (this.#zoomLevel === 1) {
        this.#translateX = 0;
        this.#translateY = 0;
      } else {
        this.#constrainPan(img);
      }
      this.#updateTransform(img, smooth);
      this.#updateZoomButtons();
    }
  }

  #resetZoom(smooth = false) {
    this.#zoomLevel = 1;
    this.#translateX = 0;
    this.#translateY = 0;
    const img = this.shadowRoot.querySelector('#media img');
    if (img) {
      this.#updateTransform(img, smooth);
      this.#updateZoomButtons();
    }
  }

  #updateTransform(img, smooth = false) {
    if (smooth) {
      img.style.transition = 'transform 0.3s ease-out';
      setTimeout(() => img.style.transition = '', 300);
    }
    img.style.transform = `scale(${this.#zoomLevel}) translate(${this.#translateX / this.#zoomLevel}px, ${this.#translateY / this.#zoomLevel}px)`;
    img.style.transformOrigin = 'center center';
    img.style.cursor = this.#zoomLevel > 1 ? 'grab' : 'default';
  }

  #updateZoomButtons() {
    const zoomIn = this.shadowRoot.getElementById('zoom-in');
    const zoomOut = this.shadowRoot.getElementById('zoom-out');

    if (zoomIn) zoomIn.disabled = this.#zoomLevel >= this.#maxZoom;
    if (zoomOut) zoomOut.disabled = this.#zoomLevel <= 1;
  }

  #constrainPan(img) {
    const scaledWidth = img.offsetWidth * this.#zoomLevel;
    const scaledHeight = img.offsetHeight * this.#zoomLevel;
    const containerWidth = document.documentElement.clientWidth;
    const containerHeight = document.documentElement.clientHeight;

    const maxTranslateX = Math.max(0, (scaledWidth - containerWidth) / 2);
    const maxTranslateY = Math.max(0, (scaledHeight - containerHeight) / 2);

    this.#translateX = Math.max(-maxTranslateX, Math.min(maxTranslateX, this.#translateX));
    this.#translateY = Math.max(-maxTranslateY, Math.min(maxTranslateY, this.#translateY));
  }

  #handleDoubleTap(clientX, clientY, img) {
    if (this.#zoomLevel >= this.#maxZoom) {
      this.#resetZoom(true);
    } else {
      const nextZoom = Math.min(this.#maxZoom, this.#zoomLevel * 2);
      this.#setZoomAtPoint(nextZoom, clientX, clientY, img, true);
    }
  }
}

window.customElements.define('pl-slide-media', PlSlideMedia);
