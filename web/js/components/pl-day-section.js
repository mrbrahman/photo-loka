// pl-day-section: wraps one day's worth of items in the timeline view.
//
// Layout:
//   <header (sticky)> Sun, 20th Apr 2026 </header>
//   <pl-album> ... </pl-album>   (one per consecutive same-album group)
//   <pl-album> ... </pl-album>
//
// Group modes:
//   'time'   (default) - albums form by consecutive same-album walk through
//                        the day's items in time order. Two birthday clusters
//                        at different times of day form two distinct albums.
//   'folder'           - all items with the same album path are merged into
//                        one pl-album, sorted by time within. Useful when the
//                        timeline has many small interleaved clusters.
//
// The toggle is per-day and lives in component state. State is preserved as
// long as the day-section instance lives, which means it survives scroll
// (the gallery doesn't recreate sections, just toggles painting).

import {
  formatDayHeader,
  groupConsecutiveByAlbum,
  groupAllByAlbum
} from '../album-path.mjs';

import sheet from "./styles/pl-day-section.css" with { type: "css" };

class PlDaySection extends HTMLElement {

  #day = '';                  // 'YYYY-MM-DD'
  #items = [];                // raw items for this day from the server
  #albums = [];               // current pl-album elements
  #groupMode = 'time';        // 'time' | 'folder'
  #width = 0;
  #gutterspace = 4;
  #readOnly = false;
  #collectionId = null;
  #placeholderText = '';

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <header id="day-header">
        <span id="day-text"></span>
        <sl-icon
          id="group-toggle"
          name="folder"
          title="Toggle group by album"
          tabindex="0"
        ></sl-icon>
      </header>
      <section id="albums"></section>
    `;
  }

  constructor() {
    super().attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
    this.#paintHeader();
    this.#paintAlbums();

    let toggle = this.shadowRoot.getElementById('group-toggle');
    toggle.addEventListener('click', this.#handleToggleGroupMode);
    toggle.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        this.#handleToggleGroupMode();
      }
    });
  }

  #paintHeader() {
    let textEl = this.shadowRoot.getElementById('day-text');
    if (textEl) textEl.textContent = formatDayHeader(this.#day);
    let toggleEl = this.shadowRoot.getElementById('group-toggle');
    if (toggleEl) {
      toggleEl.classList.toggle('active', this.#groupMode === 'folder');
    }
  }

  #handleToggleGroupMode = () => {
    this.#groupMode = this.#groupMode === 'time' ? 'folder' : 'time';
    this.#paintHeader();
    this.#paintAlbums();
    this.dispatchEvent(new CustomEvent('pl-day-section-mode-changed', {
      bubbles: true, composed: true,
      detail: { day: this.#day, mode: this.#groupMode }
    }));
  }

  // (Re)build the pl-album children for this day based on current group mode.
  // Existing albums are removed; the gallery re-attaches event listeners via
  // the 'pl-day-section-albums-changed' event below.
  #paintAlbums() {
    let container = this.shadowRoot.getElementById('albums');
    if (!container) return;

    container.innerHTML = '';
    this.#albums = [];

    let groups = this.#groupMode === 'folder'
      ? groupAllByAlbum(this.#items)
      : groupConsecutiveByAlbum(this.#items);

    for (let g of groups) {
      // pl-album expects items in the shape { data: {...}, layout: {...} }.
      // Server gives us { albumDate, albumName, data: {...} } per item.
      // We carry albumDate and albumName onto the wrapped item so selection
      // events still know which (date, name) each item belongs to.
      let albumData = g.items.map(item => ({
        data: item.data,
        layout: {},
        albumDate: item.albumDate,
        albumName: item.albumName,
        // legacy 'day' alias used by gallery's per-day move flow; equal to
        // albumDate by definition in the timeline view.
        day: item.albumDate
      }));

      let album = Object.assign(document.createElement('pl-album'), {
        id: this.#albumElementId(g.albumName),
        album_name: g.albumName,
        album_date: this.#day,
        data: albumData,
        width: this.#width,
        gutterspace: this.#gutterspace,
        readOnly: this.#readOnly,
        collectionId: this.#collectionId,
        placeholderText: this.#placeholderText
      });
      this.#albums.push(album);
      container.appendChild(album);
    }

    this.dispatchEvent(new CustomEvent('pl-day-section-albums-changed', {
      bubbles: true, composed: true,
      detail: { day: this.#day, albums: this.#albums }
    }));
  }

  // Each (day, album) pair needs a stable DOM id. Mirror the gallery's
  // sanitization for compatibility with the existing remove-by-id flow.
  #albumElementId(albumPath) {
    return `${this.#day}-${albumPath.replaceAll(/[\s/&]/gi, '_')}`;
  }

  // Called by the gallery when scroll/buffer position changes. Computes the
  // gallery-relative top/bottom for each album and asks the album to paint
  // (or unpaint) thumbs accordingly.
  paintVisibleAlbums(bufferTop, bufferBottom, sectionTop) {
    for (let album of this.#albums) {
      let albumTopInSection = album.offsetTop;
      let albumTop = sectionTop + albumTopInSection;
      let albumBottom = albumTop + album.album_height;

      let albumBottomInBuffer = albumBottom >= bufferTop && albumBottom <= bufferBottom;
      let albumTopInBuffer = albumTop >= bufferTop && albumTop <= bufferBottom;
      let albumEncompassesBuffer = albumTop <= bufferTop && albumBottom >= bufferBottom;

      if (albumEncompassesBuffer || albumBottomInBuffer || albumTopInBuffer) {
        album.selectivelyPaintLayout(bufferTop, bufferBottom, albumTop);
      }
    }
  }

  // Refire layout for every child album (on resize).
  redoLayout() {
    for (let album of this.#albums) {
      album.width = this.#width;
      album.redoLayout();
    }
  }

  // Sum of header height + album heights. Used by gallery to position the
  // next day-section.
  get sectionHeight() {
    let h = this.shadowRoot.getElementById('day-header')?.offsetHeight || 0;
    for (let album of this.#albums) {
      h += album.album_height || 0;
    }
    return h;
  }

  get albums() { return this.#albums; }
  get day() { return this.#day; }
  get groupMode() { return this.#groupMode; }

  set day(_) {
    this.#day = _ || '';
    if (this.isConnected) this.#paintHeader();
  }

  /**
   * Items for this day. Shape: [{ albumDate, albumName, data: { ... } }, ...]
   * Already ordered by the server (timed first by t DESC, then no-time items
   * clustered by albumName+filename). The day-section walks consecutively to
   * form album sub-groups in 'time' mode.
   */
  set items(_) {
    this.#items = Array.isArray(_) ? _ : [];
    if (this.isConnected) this.#paintAlbums();
  }

  set width(_) {
    this.#width = +_ || 0;
    for (let album of this.#albums) album.width = this.#width;
  }
  get width() { return this.#width; }

  set gutterspace(_) { this.#gutterspace = +_ || 4; }
  get gutterspace() { return this.#gutterspace; }

  set readOnly(_) { this.#readOnly = Boolean(_); }
  get readOnly() { return this.#readOnly; }

  set collectionId(_) { this.#collectionId = _ || null; }
  get collectionId() { return this.#collectionId; }

  set placeholderText(_) { this.#placeholderText = _ || ''; }
  get placeholderText() { return this.#placeholderText; }
}

customElements.define('pl-day-section', PlDaySection);
