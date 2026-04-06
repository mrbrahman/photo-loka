import sheet from "./styles/pl-slide.css" with { type: "css" };

class PlSlide extends HTMLElement {
  #albumname; #item; #play; #slideshowMode; #infoPanelOpen = false;
  #hasNext = false; #hasPrev = false; #handleEscape;
  #touchStartX = 0; #touchStartY = 0; #swipeThreshold = 50;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <div id="container">
        <div id="media-slot">
          <div id="navigation">
            <sl-icon-button id="prev" name="chevron-left"></sl-icon-button>
            <sl-icon-button id="next" name="chevron-right"></sl-icon-button>
            <sl-icon-button id="close" name="x"></sl-icon-button>
          </div>
        </div>
        <div id="info-slot"></div>
      </div>
    `;
  }

  constructor() {
    super().attachShadow({mode: 'open'});
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  static get observedAttributes() {
    return ['data-pos'];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    let media = Object.assign(document.createElement('pl-slide-media'), {
      albumname: this.#albumname,
      item: this.#item,
      slideshowMode: this.#slideshowMode
    });

    this.shadowRoot.getElementById('media-slot').prepend(media);

    // Nav button clicks
    this.shadowRoot.getElementById('prev').addEventListener('click', () => {
      this.dispatchEvent(new Event('pl-nav-prev', {composed: true, bubbles: true}));
    });
    this.shadowRoot.getElementById('next').addEventListener('click', () => {
      this.dispatchEvent(new Event('pl-nav-next', {composed: true, bubbles: true}));
    });
    this.shadowRoot.getElementById('close').addEventListener('click', () => {
      this.dispatchEvent(new Event('pl-slideshow-close-requested', {composed: true, bubbles: true}));
    });

    // Update nav button visibility
    this.#updateNavVisibility();

    // Swipe gestures for navigation are handled here (in pl-slide) rather than in
    // pl-slideshow, because pl-slide-media has its own touch handlers for image
    // zoom/pan. When an image is zoomed in, single-finger touch is used for panning,
    // and we need to avoid interpreting that as a swipe. Since pl-slide has access
    // to pl-slide-media's zoom state, it can make that distinction.
    this.addEventListener('touchstart', this.#handleTouchStart, {passive: true});
    this.addEventListener('touchend', this.#handleTouchEnd);

    // Listen for info toggle from media's "i" button
    this.addEventListener('pl-info-toggle-requested', () => {
      this.infoPanelOpen = !this.#infoPanelOpen;
      this.dispatchEvent(new CustomEvent('pl-info-panel-toggled', {
        composed: true, bubbles: true,
        detail: { open: this.#infoPanelOpen }
      }));
    });

    // Escape closes info panel
    this.#handleEscape = (e) => {
      if (e.key === 'Escape' && this.#infoPanelOpen) {
        e.stopImmediatePropagation();
        this.infoPanelOpen = false;
        this.dispatchEvent(new CustomEvent('pl-info-panel-toggled', {
          composed: true, bubbles: true,
          detail: { open: false }
        }));
      }
    };
    window.addEventListener('keyup', this.#handleEscape);

    // Listen for description updates
    this.addEventListener('pl-item-desc-updated', (evt) => {
      let {uuid, hasDesc} = evt.detail;
      if (this.item?.data?.id === uuid) {
        this.item.data.hasDesc = hasDesc;
        if (this.item.elem) this.item.elem.hasDesc = hasDesc;
      }
    });
  }

  disconnectedCallback() {
    if (this.#handleEscape) window.removeEventListener('keyup', this.#handleEscape);
    this.removeEventListener('touchstart', this.#handleTouchStart);
    this.removeEventListener('touchend', this.#handleTouchEnd);
  }

  #handleTouchStart = (evt) => {
    if (evt.touches.length !== 1) return;
    this.#touchStartX = evt.touches[0].screenX;
    this.#touchStartY = evt.touches[0].screenY;
  }

  #handleTouchEnd = (evt) => {
    // Skip swipe nav if image is zoomed in (touch is used for panning)
    let media = this.shadowRoot.querySelector('pl-slide-media');
    if (media?.zoomLevel > 1) return;

    let dx = evt.changedTouches[0].screenX - this.#touchStartX;
    let dy = evt.changedTouches[0].screenY - this.#touchStartY;

    if (Math.abs(dy) > Math.abs(dx)) return;
    if (Math.abs(dx) < this.#swipeThreshold) return;

    if (dx < 0 && this.#hasNext) {
      this.dispatchEvent(new Event('pl-nav-next', {composed: true, bubbles: true}));
    } else if (dx > 0 && this.#hasPrev) {
      this.dispatchEvent(new Event('pl-nav-prev', {composed: true, bubbles: true}));
    }
  }

  attributeChangedCallback(name, oldVal, newVal) {
    if (name === 'data-pos') {
      if (oldVal == "0" && newVal != "0") {
        this.shadowRoot.querySelector('pl-slide-media')?.resetZoom();
      }
    }
  }

  #updateNavVisibility() {
    let nav = this.shadowRoot.getElementById('navigation');
    if (!nav) return;

    nav.style.visibility = this.#slideshowMode ? 'hidden' : 'visible';

    let prev = this.shadowRoot.getElementById('prev');
    let next = this.shadowRoot.getElementById('next');
    if (prev) prev.style.display = this.#hasPrev ? '' : 'none';
    if (next) next.style.display = this.#hasNext ? '' : 'none';
  }

  set infoPanelOpen(val) {
    this.#infoPanelOpen = Boolean(val);
    if (!this.isConnected) return;

    let container = this.shadowRoot.getElementById('container');
    let infoSlot = this.shadowRoot.getElementById('info-slot');

    if (this.#infoPanelOpen) {
      container.classList.add('info-open');
      if (!infoSlot.querySelector('pl-item-info')) {
        let info = Object.assign(document.createElement('pl-item-info'), {
          uuid: this.item?.data?.id
        });
        info.addEventListener('pl-info-panel-closed', () => {
          this.infoPanelOpen = false;
          this.dispatchEvent(new CustomEvent('pl-info-panel-toggled', {
            composed: true, bubbles: true,
            detail: { open: false }
          }));
        });
        infoSlot.appendChild(info);
      }
    } else {
      container.classList.remove('info-open');
      setTimeout(() => infoSlot.querySelector('pl-item-info')?.remove(), 300);
    }
  }
  get infoPanelOpen() { return this.#infoPanelOpen; }

  set hasNext(val) {
    this.#hasNext = Boolean(val);
    this.#updateNavVisibility();
  }
  get hasNext() { return this.#hasNext; }

  set hasPrev(val) {
    this.#hasPrev = Boolean(val);
    this.#updateNavVisibility();
  }
  get hasPrev() { return this.#hasPrev; }

  get mediaRect() {
    return this.shadowRoot.querySelector('pl-slide-media')?.mediaRect ?? null;
  }

  hideChrome() {
    let nav = this.shadowRoot.getElementById('navigation');
    if (nav) nav.style.visibility = 'hidden';
    let media = this.shadowRoot.querySelector('pl-slide-media');
    if (media) {
      let albumname = media.shadowRoot.getElementById('albumname');
      let actions = media.shadowRoot.getElementById('actions');
      if (albumname) albumname.style.visibility = 'hidden';
      if (actions) actions.style.visibility = 'hidden';
    }
  }

  set albumname(_) { this.#albumname = _; }
  get albumname() { return this.#albumname; }

  set item(_) { this.#item = _; }
  get item() { return this.#item; }

  set play(_) {
    this.#play = Boolean(_);
    let media = this.shadowRoot?.querySelector('pl-slide-media');
    if (media) media.play = this.#play;
  }
  get play() { return this.#play; }

  set slideshowMode(_) {
    this.#slideshowMode = Boolean(_);
    if (!this.isConnected) return;
    let media = this.shadowRoot?.querySelector('pl-slide-media');
    if (media) media.slideshowMode = this.#slideshowMode;
    this.#updateNavVisibility();
  }
  get slideshowMode() { return this.#slideshowMode; }
}

window.customElements.define('pl-slide', PlSlide);
