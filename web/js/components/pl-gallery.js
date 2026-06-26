// many web component practices adapted from: https://dev.to/dannyengelman/web-component-102-the-5-lessons-after-learning-web-components-101-h9p

// some functional (logic) concepts adapted from https://github.com/schlosser/pig.js/ and further expanded for multiple albums and a timeline view

// e.g. TBD
// <pl-gallery ></pl-gallery>

// Timeline-view design:
//
// 1. Server returns [{day: 'YYYY-MM-DD', items: [...]}], items already
//    ordered by datetime DESC within day, with no-time items clustered at
//    the end (by album + filename).
// 2. Gallery creates one pl-day-section per day. Each day-section internally
//    creates pl-album children by walking its items and grouping consecutive
//    same-album entries (or all same-album entries in 'folder' mode).
// 3. Selection state is tracked at the gallery level (across all days/albums).
//    Gallery owns the controls bar, move/delete orchestration, and slideshow.
// 4. Per-album event listeners are attached every time the day-section
//    rebuilds its album children (mode toggle changes the list).
// 5. Slideshow continues to receive a flat [{album, items[]}] shape; we
//    flatten the day-sections' albums when opening it.

import { throttle, notify, showConfirmDialog, showProgress, hideProgress } from '../utils.mjs';
import { searchItems, getTrashedItems, searchByGpsCoordinates, getAllItems } from '../api/search-api.mjs';
import { updateRating, trashItems, togglePrivate, restoreFromTrash, cleanupTrash, emptyTrash, moveItems } from '../api/media-api.mjs';

import './pl-gallery-index.js';

import sheet from "./styles/pl-gallery.css" with { type: "css" };

class PlGallery extends HTMLElement {

  // internal state
  #data = [];                  // [{day, items: [{album, data:{...}, day}]}]
  #daySections = [];           // pl-day-section elements (one per day)
  #albumsInBuffer = {};        // album.id -> 'full' | 'partial' | 'buffer-overflow'
  #albumsSelectedCnt = {};     // album_name -> count
  #itemsSelected = [];         // selected items across all albums

  // public properties
  #mode = 'default';
  #query = {};
  #slideshowItemId = null;
  #placeholderText = '';

  // Scroll-stop debounce for the gallery index (.scrolling class on the
  // index toggles its visibility). Cleared in disconnectedCallback.
  #indexScrollTimer = null;

  // Dedup flag for the per-frame marker update. Set when an rAF is pending
  // so multiple scroll events within the same frame coalesce into one
  // update.
  #markerRafPending = false;

  // When true, #selectivelyPaintAlbums is skipped during the throttled
  // scroll handler. Set during programmatic jumps (tick click, scrub) to
  // avoid fetching thumbnails for content that flies past during the
  // animation. Cleared on scrollend.
  #isJumping = false;

  // Set during scrub (pill drag). Prevents album painting while the user
  // is dragging fast. Cleared on scrub end, which triggers a final paint.
  #isScrubbing = false;

  // Number of viewport-heights above and below to pre-paint thumbnails.
  // Higher = smoother normal scroll (more pre-fetched), lower = fewer
  // wasted fetches during fast scroll.
  #paintBuffer = 3;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <div id="trash-bar" style="display:none">
        <span id="trash-info"></span>
        <sl-button id="empty-trash-btn" variant="danger" size="small">
          <sl-icon slot="prefix" name="x-circle-fill"></sl-icon>
          Empty Trash
        </sl-button>
      </div>
      <div id="gallery"></div>
      <pl-gallery-index id="gallery-index"></pl-gallery-index>
      <div id="nav-btns">
        <sl-icon-button id="prev-album-btn" name="chevron-up" label="Previous album"></sl-icon-button>
        <sl-icon-button id="next-album-btn" name="chevron-down" label="Next album"></sl-icon-button>
      </div>
    `;
  }

  constructor() {
    super().attachShadow({mode: 'open'});
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  async connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));

    const data = await this.#fetchData();
    if (!data) return;
    if (!this.isConnected) return;

    this.#data = this.#decorateItemsWithDay(data);
    this.#renderGallery();
  }

  // Tag each item with its day key so move/add operations can locate the
  // right day-section without re-deriving from the server's payload. With
  // the phase-3 model, day === albumDate, so we mirror that field.
  #decorateItemsWithDay(data) {
    for (let dayGroup of data) {
      for (let item of dayGroup.items) {
        item.day = dayGroup.day;
        // Server already sends albumDate per item, but be defensive in case
        // a row had a NULL album_date (e.g. before the SQL migration).
        if (!item.albumDate) item.albumDate = dayGroup.day;
      }
    }
    return data;
  }

  async #fetchData() {
    showProgress();
    try {
      const { collectionId = 1, searchText, bounds } = this.#query;
      switch (this.#mode) {
        case 'search':  return await searchItems(collectionId, searchText);
        case 'trash':   return await getTrashedItems(collectionId);
        case 'geo':     return await searchByGpsCoordinates(collectionId, bounds);
        default:        return await getAllItems(collectionId);
      }
    } catch (err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
      return null;
    } finally {
      hideProgress();
    }
  }

  #renderGallery() {
    if (this.#data.length === 0) {
      this.shadowRoot.getElementById('gallery').innerHTML =
        '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">No results found</div>';
      return;
    }

    const totalItems = this.#data.reduce((sum, d) => sum + d.items.length, 0);
    const albumSet = new Set(this.#data.flatMap(d => d.items.map(i => i.albumName)));
    const verb = this.#mode === 'search' || this.#mode === 'trash' ? 'Found' : 'Showing';
    notify(`${verb} ${totalItems.toLocaleString()} items in ${albumSet.size.toLocaleString()} albums`);

    let galleryEl = this.shadowRoot.getElementById('gallery');

    this.#daySections = this.#data.map(d => {
      let section = Object.assign(document.createElement('pl-day-section'), {
        day: d.day,
        width: galleryEl.clientWidth,
        readOnly: this.#mode === 'trash',
        collectionId: this.#query.collectionId,
        placeholderText: this.#placeholderText,
        items: d.items
      });
      return section;
    });

    galleryEl.append(...this.#daySections);

    // Attach listeners to existing album children, and re-attach when a
    // day-section rebuilds its albums (mode toggle).
    this.#attachAllAlbumListeners();
    galleryEl.addEventListener('pl-day-section-albums-changed', this.#handleSectionAlbumsChanged);

    // Hand the index its data and listen for jump-to-day clicks and scrub.
    let indexEl = this.shadowRoot.getElementById('gallery-index');
    indexEl.data = this.#data;
    indexEl.addEventListener('pl-gallery-index-jump', this.#handleIndexJump);
    indexEl.addEventListener('pl-gallery-index-scrub', this.#handleIndexScrub);
    indexEl.addEventListener('pl-gallery-index-scrub-end', this.#handleIndexScrubEnd);

    // Reset scroll
    galleryEl.scrollTop = 0;

    // Wait for next frame so flex/flow layout settles before measuring
    // offsetTop and painting thumbs.
    requestAnimationFrame(() => {
      this.#selectivelyPaintAlbums();
      this.#updateNavBtnState();
      this.#pushIndexLayout();
    });

    if (this.#mode === 'trash') {
      let trashBar = this.shadowRoot.getElementById('trash-bar');
      trashBar.style.display = '';
      this.#updateTrashCount();
      this.shadowRoot.getElementById('empty-trash-btn').addEventListener('click', this.#handleEmptyTrash);
    }

    // Slideshow plumbing - same design as before, just flattened source data.
    this.addEventListener('pl-gallery-item-clicked', (evt) => {
      evt.stopPropagation();
      this.openSlideshow(evt.detail.id);
    });

    this.addEventListener('pl-slideshow-item-changed', (evt) => {
      evt.stopPropagation();
      this.#scrollToItem(evt.detail.currentItemId);
      this.dispatchEvent(new CustomEvent('pl-gallery-slideshow-changed', {
        composed: true, bubbles: true,
        detail: { currentItemId: evt.detail.currentItemId }
      }));
    });

    this.addEventListener('pl-slideshow-closed', (evt) => {
      evt.stopPropagation();
      this.closeSlideshow(evt.detail.currentItemId);
    });

    galleryEl.addEventListener('scroll', this.#handleScroll);
    galleryEl.addEventListener('scrollend', this.#handleScrollEnd);
    this.shadowRoot.getElementById('next-album-btn').addEventListener('click', this.#scrollToNextAlbum);
    this.shadowRoot.getElementById('prev-album-btn').addEventListener('click', this.#scrollToPrevAlbum);
    window.addEventListener('resize', this.#throttleHandleResize);

    if (this.#slideshowItemId) {
      requestAnimationFrame(() => this.openSlideshow(this.#slideshowItemId));
    }
  }

  // Greatest item.data.t in the album (0 if none have hasTime). Used to
  // position newly created albums within their day-section so the order
  // tracks time DESC, matching how items are ordered everywhere else.
  #albumMaxT(album) {
    if (!album.data?.length) return 0;
    let max = 0;
    for (let item of album.data) {
      if (item.data?.hasTime && (item.data.t || 0) > max) max = item.data.t;
    }
    return max;
  }

  // Walk all day-sections to get the flat album list. Used for selective
  // painting and any cross-album operation.
  #allAlbums() {
    return this.#daySections.flatMap(s => s.albums);
  }

  #attachAllAlbumListeners() {
    for (let album of this.#allAlbums()) this.#attachAlbumListeners(album);
  }

  #attachAlbumListeners(album) {
    if (album.dataset.listenersAttached) return;
    album.dataset.listenersAttached = '1';
    album.addEventListener('pl-album-height-changed', this.#handleAlbumHeightChange);
    album.addEventListener('pl-album-empty', this.#removeAlbum);
    album.addEventListener('pl-album-item-selected', this.#handleItemsSelected);
    album.addEventListener('pl-album-move-selected-items', (evt) => {
      this.#createOrMoveSelectedItems(evt.detail.newAlbumName.trim());
    });
  }

  #handleSectionAlbumsChanged = () => {
    // Day-section toggled mode and rebuilt its albums. Selection state from
    // before is no longer valid (item element references are stale); clear
    // selection and re-attach listeners.
    if (this.#itemsSelected.length > 0) {
      this.#removeGalleryControls();
    }
    this.#attachAllAlbumListeners();
    requestAnimationFrame(() => {
      this.#selectivelyPaintAlbums();
      this.#updateNavBtnState();
      this.#pushIndexLayout();
    });
  }

  // Snapshot each day-section's geometry and push it (plus gallery scroll
  // metrics) to the index. Called after layout changes (initial render,
  // album height change, resize, day-section mode toggle). Cheap enough to
  // run on every layout event.
  #pushIndexLayout = () => {
    let indexEl = this.shadowRoot.getElementById('gallery-index');
    if (!indexEl) return;
    let galleryEl = this.shadowRoot.getElementById('gallery');
    if (!galleryEl) return;

    let dayOffsets = this.#daySections.map(s => ({
      day: s.day,
      offsetTop: s.offsetTop,
      offsetHeight: s.offsetHeight
    }));

    indexEl.updateLayout({
      dayOffsets,
      scrollHeight: galleryEl.scrollHeight,
      clientHeight: galleryEl.clientHeight
    });
    indexEl.updateScroll(galleryEl.scrollTop);
  }

  #handleIndexJump = (evt) => {
    let day = evt.detail?.day;
    if (!day) return;
    let section = this.#daySections.find(s => s.day === day);
    if (!section) return;
    let galleryEl = this.shadowRoot.getElementById('gallery');
    this.#isJumping = true;
    galleryEl.scrollTo({ top: section.offsetTop, behavior: 'smooth' });
  }

  #handleIndexScrub = (evt) => {
    let galleryEl = this.shadowRoot.getElementById('gallery');
    if (!galleryEl) return;
    this.#isScrubbing = true;
    galleryEl.scrollTop = evt.detail.scrollTop;
  }

  #handleIndexScrubEnd = () => {
    this.#isScrubbing = false;
    this.#selectivelyPaintAlbums();
  }

  #handleItemsSelected = (evt) => {
    let { selectAlbum, selected, selectedItems } = evt.detail;

    if (selected) {
      this.#albumsSelectedCnt[selectAlbum] = (this.#albumsSelectedCnt[selectAlbum] || 0) + selectedItems.length;
      this.#itemsSelected.push(...selectedItems);
    } else {
      this.#albumsSelectedCnt[selectAlbum] -= selectedItems.length;
      this.#itemsSelected = this.#itemsSelected.filter(a =>
        !selectedItems.find(b => a.data.id === b.data.id)
      );
    }

    if (this.#itemsSelected.length > 0) {
      if (!this.shadowRoot.querySelector('pl-gallery-controls')) {
        let c = document.createElement('pl-gallery-controls');
        c.mode = this.#mode;
        c.collectionId = this.#query.collectionId;
        c.placeholderText = this.#placeholderText;
        this.shadowRoot.append(c);

        c.addEventListener('pl-gallery-controls-closed', this.#handleGalleryControlsClosed);
        c.addEventListener('pl-gallery-controls-rating-changed', this.#handleGalleryControlsRatingChanged);
        c.addEventListener('pl-gallery-controls-private-toggled', this.#handleGalleryControlsPrivateToggled);
        c.addEventListener('pl-gallery-controls-delete-pressed', this.#handleGalleryControlsDeletePressed);
        c.addEventListener('pl-gallery-controls-restore-pressed', this.#handleGalleryControlsRestorePressed);
        c.addEventListener('pl-gallery-controls-cleanup-pressed', this.#handleGalleryControlsCleanupPressed);
        c.addEventListener('pl-gallery-controls-dialog-save', (evt) => {
          this.#createOrMoveSelectedItems(evt.detail.trim());
        });
      }

      let c = this.shadowRoot.querySelector('pl-gallery-controls');
      c.ctr = this.#itemsSelected.length;
      c.selectedAlbums = this.#albumsSelectedCnt;

      let distinctRatings = [...new Set(this.#itemsSelected.map(x => x.data.rating))];
      c.rating = distinctRatings.length === 1 ? distinctRatings[0] : 0;
      c.allPrivate = this.#itemsSelected.every(x => x.data.private);

    } else {
      this.#removeGalleryControls();
    }
  }

  // Move selected items to a target album (descriptive name only - the
  // server constructs the per-day folder path itself). When the selection
  // spans multiple days, each day gets its own folder so items stay
  // aligned with their own day in the timeline.
  //
  // Per-day moves run in parallel. Failures are reported per day; only the
  // items in successfully moved days are removed from their source albums
  // (Option A: partial success preserves the rest of the UI state).
  #createOrMoveSelectedItems = async (descName) => {
    descName = (descName || '').trim();
    let collectionId = this.#query.collectionId;

    let movedItems = this.#itemsSelected.slice();

    // Group items by their original day. day === albumDate for the timeline.
    let byDay = new Map();
    for (let item of movedItems) {
      const day = item.day || item.albumDate;
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(item);
    }

    // Build per-day plan: target (date, name) + items + uuid list for the API.
    let plan = [...byDay.entries()].map(([day, items]) => ({
      day,
      items,
      targetAlbumDate: day,
      targetAlbumName: descName,
      uuids: items.map(i => i.data.id)
    }));

    let results = await Promise.allSettled(
      plan.map(p => moveItems(collectionId, p.uuids, p.targetAlbumDate, p.targetAlbumName))
    );

    let okPlan = [];
    let failures = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') okPlan.push(plan[i]);
      else failures.push({ day: plan[i].day, count: plan[i].items.length, err: r.reason });
    });

    if (failures.length) {
      let total = failures.reduce((s, f) => s + f.count, 0);
      let msg = failures.map(f => `${f.day}: ${f.err?.error?.message || f.err?.message || 'failed'}`).join('<br>');
      notify(`<strong>${total} item${total > 1 ? 's' : ''} failed to move</strong><br>${msg}`, 'error', -1);
    }

    if (okPlan.length === 0) {
      this.#handleGalleryControlsClosed();
      return;
    }

    let successIds = new Set();
    for (let p of okPlan) {
      for (let item of p.items) successIds.add(item.data.id);
    }

    for (let album of this.#allAlbums()) album.deleteItemsByIds(successIds);

    for (let p of okPlan) {
      for (let item of p.items) {
        item.elem = undefined;
        if (item.layout) item.layout.selected = false;
      }
    }

    for (let p of okPlan) {
      let section = this.#daySections.find(s => s.day === p.day);
      if (!section) continue;

      // Update each item's albumName to the new value so future operations
      // see it correctly.
      for (let item of p.items) item.albumName = p.targetAlbumName;

      let existingAlbum = section.albums.find(a => a.album_name === p.targetAlbumName);
      if (existingAlbum) {
        existingAlbum.addNewItems(p.items.map(i => ({
          data: i.data, layout: {}, day: p.day,
          albumDate: p.day, albumName: p.targetAlbumName
        })));
      } else {
        let newAlbumMaxT = Math.max(0, ...p.items
          .filter(i => i.data?.hasTime)
          .map(i => i.data.t || 0));

        let insertBefore = section.albums.find(a => this.#albumMaxT(a) < newAlbumMaxT);

        let newAlbum = Object.assign(document.createElement('pl-album'), {
          id: `${p.day}-${(p.targetAlbumName || '').replaceAll(/[\s/&]/gi, '_') || 'unnamed'}`,
          album_name: p.targetAlbumName,
          album_date: p.day,
          data: p.items.map(i => ({
            data: i.data, layout: {}, day: p.day,
            albumDate: p.day, albumName: p.targetAlbumName
          })),
          width: this.shadowRoot.getElementById('gallery').clientWidth,
          collectionId,
          placeholderText: this.#placeholderText
        });
        this.#attachAlbumListeners(newAlbum);

        let albumsContainer = section.shadowRoot.getElementById('albums');
        if (insertBefore) {
          albumsContainer.insertBefore(newAlbum, insertBefore);
          let idx = section.albums.indexOf(insertBefore);
          section.albums.splice(idx, 0, newAlbum);
        } else {
          albumsContainer.appendChild(newAlbum);
          section.albums.push(newAlbum);
        }
      }
    }

    requestAnimationFrame(() => {
      this.#selectivelyPaintAlbums();
      this.#pushIndexLayout();
    });

    let movedCnt = okPlan.reduce((s, p) => s + p.items.length, 0);
    notify(`${movedCnt} item${movedCnt > 1 ? 's' : ''} moved`, 'success');

    if (failures.length === 0) {
      this.#handleGalleryControlsClosed();
    }
  }

  #handleGalleryControlsClosed = () => {
    for (let album of this.#allAlbums()) album.unselectSelectedItems();
    this.#removeGalleryControls();
  }
  
  #removeGalleryControls = () => {
    this.#itemsSelected = [];
    this.#albumsSelectedCnt = {};
    let c = this.shadowRoot.querySelector('pl-gallery-controls');
    if (c) c.remove();
  }

  #handleGalleryControlsRatingChanged = async (evt) => {
    try {
      await updateRating(this.#itemsSelected.map(x => x.data.id), evt.detail.newRating);
      for (let album of this.#allAlbums()) album.changeRatingSelectedItems(evt.detail.newRating);
      let n = this.#itemsSelected.length;
      notify(`Updated rating for ${n} item${n > 1 ? 's' : ''}`, 'success');
    } catch(err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #handleGalleryControlsDeletePressed = async () => {
    try {
      await trashItems(1, this.#itemsSelected.map(x => x.data.id));
      for (let album of this.#allAlbums()) album.deleteSelectedItems();
      let n = this.#itemsSelected.length;
      this.#removeGalleryControls();
      notify(`${n} item${n > 1 ? 's' : ''} moved to trash`, 'success');
    } catch(err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #handleGalleryControlsPrivateToggled = async (evt) => {
    let { makePrivate } = evt.detail;
    try {
      await togglePrivate(1, this.#itemsSelected.map(x => x.data.id), makePrivate);
      let n = this.#itemsSelected.length;
      for (let album of this.#allAlbums()) album.deleteSelectedItems();
      this.#removeGalleryControls();
      notify(`${n} item${n > 1 ? 's' : ''} ${makePrivate ? 'marked private' : 'unmarked private'}`, 'success');
    } catch(err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #handleGalleryControlsRestorePressed = async () => {
    try {
      await restoreFromTrash(1, this.#itemsSelected.map(x => x.data.id));
      let n = this.#itemsSelected.length;
      for (let album of this.#allAlbums()) album.deleteSelectedItems();
      this.#removeGalleryControls();
      notify(`${n} item${n > 1 ? 's' : ''} restored from trash`, 'success');
      if (this.#mode === 'trash') this.#updateTrashCount();
    } catch(err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #handleGalleryControlsCleanupPressed = async () => {
    try {
      await cleanupTrash(1, this.#itemsSelected.map(x => x.data.id));
      let n = this.#itemsSelected.length;
      for (let album of this.#allAlbums()) album.deleteSelectedItems();
      this.#removeGalleryControls();
      notify(`${n} item${n > 1 ? 's' : ''} permanently deleted`, 'success');
      if (this.#mode === 'trash') this.#updateTrashCount();
    } catch(err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #handleEmptyTrash = async () => {
    let result = await showConfirmDialog(
      'Empty Trash',
      'This will permanently delete all items in trash. This cannot be undone.',
      'Empty Trash',
      'Cancel'
    );
    if (result !== 1) return;

    try {
      let allUuids = this.#data.flatMap(d => d.items.map(i => i.data.id));
      await emptyTrash(1, allUuids);
      // remove all day sections
      for (let s of this.#daySections) s.remove();
      this.#daySections = [];
      this.#albumsInBuffer = {};
      this.#updateTrashCount();
      this.#pushIndexLayout();
      notify('Trash emptied', 'success');
    } catch(err) {
      notify(`<strong>Error</strong>:</br>${err.error?.message || err}`, 'error', -1);
    }
  }

  #updateTrashCount = () => {
    let totalItems = this.#allAlbums().reduce((sum, a) => sum + a.data.length, 0);
    this.shadowRoot.getElementById('trash-info').textContent = `${totalItems} item${totalItems !== 1 ? 's' : ''} in trash`;
    this.shadowRoot.getElementById('empty-trash-btn').disabled = totalItems === 0;
  }

  #handleAlbumHeightChange = () => {
    // With normal flow (flex column) for day-sections + albums, the browser
    // recomputes layout after a child height change. We just need to repaint
    // visible thumbs.
    this.#selectivelyPaintAlbums();
    this.#pushIndexLayout();
    setTimeout(() => {
      this.#selectivelyPaintAlbums();
      this.#pushIndexLayout();
    }, 300);
  }

  #removeAlbum = (evt) => {
    let albumEl = evt.composedPath().find(el => el.tagName?.toLowerCase() === 'pl-album');
    if (!albumEl) return;

    // Find which day-section owns this album and remove it from there
    for (let section of this.#daySections) {
      let idx = section.albums.indexOf(albumEl);
      if (idx !== -1) {
        albumEl.remove();
        section.albums.splice(idx, 1);
        delete this.#albumsInBuffer[albumEl.id];

        // If the day-section is now empty, remove it too
        if (section.albums.length === 0) {
          let sIdx = this.#daySections.indexOf(section);
          if (sIdx !== -1) {
            section.remove();
            this.#daySections.splice(sIdx, 1);
          }
        }
        break;
      }
    }

    this.#handleAlbumHeightChange();
  }

  #selectivelyPaintAlbums(forceRepaint = true) {
    let galleryEl = this.shadowRoot.getElementById('gallery');
    let scrollTop = -galleryEl.scrollTop;
    let viewportHeight = galleryEl.clientHeight;
    let bufferTop = viewportHeight * -this.#paintBuffer;
    let bufferBottom = viewportHeight * (1 + this.#paintBuffer);

    for (let section of this.#daySections) {
      let sectionTop = section.offsetTop + scrollTop;
      let sectionBottom = sectionTop + section.offsetHeight;

      let intersectsBuffer =
        (sectionBottom >= bufferTop && sectionBottom <= bufferBottom) ||
        (sectionTop >= bufferTop && sectionTop <= bufferBottom) ||
        (sectionTop <= bufferTop && sectionBottom >= bufferBottom);

      if (intersectsBuffer) {
        // Day-section partially or fully visible. Drill into albums.
        for (let album of section.albums) {
          let albumTop = section.offsetTop + album.offsetTop + scrollTop;
          let albumBottom = albumTop + album.album_height;

          let albumBottomInBuffer = albumBottom >= bufferTop && albumBottom <= bufferBottom;
          let albumTopInBuffer = albumTop >= bufferTop && albumTop <= bufferBottom;
          let albumEncompassesBuffer = albumTop <= bufferTop && albumBottom >= bufferBottom;

          // Shortcut: don't repaint if already fully loaded and unchanged
          // (only matters during scroll, not for forced repaints).
          if (
            !forceRepaint &&
            this.#albumsInBuffer[album.id] === 'full' &&
            albumBottomInBuffer && albumTopInBuffer
          ) {
            continue;
          }

          if (albumEncompassesBuffer) {
            this.#albumsInBuffer[album.id] = 'buffer-overflow';
            album.selectivelyPaintLayout(bufferTop, bufferBottom, albumTop);
          } else if (albumBottomInBuffer || albumTopInBuffer) {
            album.selectivelyPaintLayout(bufferTop, bufferBottom, albumTop);
            this.#albumsInBuffer[album.id] =
              (albumBottomInBuffer && albumTopInBuffer) ? 'full' : 'partial';
          } else {
            if (this.#albumsInBuffer[album.id]) {
              album.selectivelyPaintLayout(bufferTop, bufferBottom, albumTop);
              delete this.#albumsInBuffer[album.id];
            }
          }
        }
      } else {
        // Day-section out of buffer entirely. Unpaint any of its albums
        // that were previously painted.
        for (let album of section.albums) {
          if (this.#albumsInBuffer[album.id]) {
            let albumTop = section.offsetTop + album.offsetTop + scrollTop;
            album.selectivelyPaintLayout(bufferTop, bufferBottom, albumTop);
            delete this.#albumsInBuffer[album.id];
          }
        }
      }
    }
  }

  #scrollToNextAlbum = () => {
    let gallery = this.shadowRoot.getElementById('gallery');
    let scrollTop = gallery.scrollTop;
    for (let section of this.#daySections) {
      for (let album of section.albums) {
        let albumTop = section.offsetTop + album.offsetTop;
        if (albumTop > scrollTop + 1) {
          gallery.scrollTo({ top: albumTop, behavior: 'smooth' });
          return;
        }
      }
    }
  }

  #scrollToPrevAlbum = () => {
    let gallery = this.shadowRoot.getElementById('gallery');
    let scrollTop = gallery.scrollTop;
    let target = null;
    for (let section of this.#daySections) {
      for (let album of section.albums) {
        let albumTop = section.offsetTop + album.offsetTop;
        if (albumTop < scrollTop - 1) target = albumTop;
        else break;
      }
    }
    if (target !== null) gallery.scrollTo({ top: target, behavior: 'smooth' });
  }

  #updateNavBtnState = () => {
    let gallery = this.shadowRoot.getElementById('gallery');
    let scrollTop = gallery.scrollTop;
    let maxScroll = gallery.scrollHeight - gallery.clientHeight;
    let albums = this.#allAlbums();
    let firstAlbumTop = albums.length > 0
      ? this.#daySections[0].offsetTop + albums[0].offsetTop
      : 0;
    let lastSection = this.#daySections[this.#daySections.length - 1];
    let lastAlbum = albums[albums.length - 1];
    let lastAlbumTop = (lastSection && lastAlbum)
      ? lastSection.offsetTop + lastAlbum.offsetTop
      : 0;
    this.shadowRoot.getElementById('prev-album-btn').disabled =
      scrollTop <= firstAlbumTop + 1;
    this.shadowRoot.getElementById('next-album-btn').disabled =
      scrollTop >= lastAlbumTop - 1 || scrollTop >= maxScroll - 1;
  }

  // Scroll handler with two cadences:
  //  - Per-frame (rAF-deduped): cheap update of the index marker so it
  //    tracks scroll smoothly without throttle-induced step lag. The index
  //    component internally manages its visibility state machine based on
  //    updateScroll / notifyScrollStop calls.
  //  - Throttled (100ms): heavier work that doesn't need frame-rate
  //    cadence -- selective album painting and nav-button state.
  #handleScroll = () => {
    if (!this.#markerRafPending) {
      this.#markerRafPending = true;
      requestAnimationFrame(() => {
        this.#markerRafPending = false;
        if (!this.isConnected) return;
        let indexEl = this.shadowRoot.getElementById('gallery-index');
        let galleryEl = this.shadowRoot.getElementById('gallery');
        if (!indexEl || !galleryEl) return;
        indexEl.updateScroll(galleryEl.scrollTop);
      });
    }
    // Reset the scroll-stop detection timer. When it fires, it tells the
    // index that scrolling has ceased so it can start its hide countdown.
    if (this.#indexScrollTimer) clearTimeout(this.#indexScrollTimer);
    this.#indexScrollTimer = setTimeout(() => {
      this.#indexScrollTimer = null;
      let indexEl = this.shadowRoot.getElementById('gallery-index');
      if (indexEl) indexEl.notifyScrollStop();
    }, 150); // short debounce to detect "scroll stopped"
    this.#throttledHeavyScroll();
  }

  #throttledHeavyScroll = throttle(() => {
    if (!this.#isJumping && !this.#isScrubbing) this.#selectivelyPaintAlbums(false);
    this.#updateNavBtnState();
  }, 100);

  #handleScrollEnd = () => {
    if (this.#isJumping) {
      this.#isJumping = false;
      this.#selectivelyPaintAlbums();
    }
    this.#updateNavBtnState();
  }

  #handleResize() {
    for (let section of this.#daySections) {
      section.width = this.shadowRoot.getElementById('gallery').clientWidth;
      section.redoLayout();
    }
    this.#selectivelyPaintAlbums();
    this.#pushIndexLayout();
  }
  #throttleHandleResize = throttle(() => this.#handleResize(), 100);

  disconnectedCallback() {
    let galleryEl = this.shadowRoot.getElementById('gallery');
    galleryEl?.removeEventListener('scroll', this.#handleScroll);
    galleryEl?.removeEventListener('scrollend', this.#handleScrollEnd);
    this.shadowRoot.getElementById('next-album-btn')?.removeEventListener('click', this.#scrollToNextAlbum);
    this.shadowRoot.getElementById('prev-album-btn')?.removeEventListener('click', this.#scrollToPrevAlbum);
    window.removeEventListener('resize', this.#throttleHandleResize);
    if (this.#indexScrollTimer) {
      clearTimeout(this.#indexScrollTimer);
      this.#indexScrollTimer = null;
    }
  }

  attributeChangedCallback() { /* unused */ }
  adoptedCallback() { /* unused */ }

  get mode() { return this.#mode; }
  set mode(_) { this.#mode = _ || 'default'; }

  get query() { return this.#query; }
  /**
   * Mode-specific parameters for data fetching.
   * @param {object} _ - Query object, shape depends on mode:
   *   mode 'default': { collectionId: number }
   *   mode 'search':  { collectionId: number, searchText: string }
   *   mode 'trash':   { collectionId: number }
   *   mode 'geo':     { collectionId: number, bounds: { sw: {lat, lng}, ne: {lat, lng} } }
   */
  set query(_) { this.#query = _ || {}; }

  get slideshowItemId() { return this.#slideshowItemId; }
  set slideshowItemId(_) { this.#slideshowItemId = _ || null; }

  get placeholderText() { return this.#placeholderText; }
  set placeholderText(_) { this.#placeholderText = _ || ''; }

  get isSlideshowOpen() {
    return !!this.shadowRoot.querySelector('pl-slideshow');
  }

  // DESIGN: openSlideshow is public so app-shell can call it for direct URL
  // visits. Slideshow data is a flat [{album, items[]}], so we flatten across
  // all day-sections and their albums.
  openSlideshow(startFromId) {
    if (this.isSlideshowOpen) return;

    let slideshowData = [];
    for (let section of this.#daySections) {
      for (let album of section.albums) {
        slideshowData.push({ album: album.album_name, items: album.data });
      }
    }

    let slideshow = Object.assign(document.createElement('pl-slideshow'), {
      data: slideshowData,
      startFrom: startFromId,
      buffer: 1,
      mode: this.#mode
    });

    this.shadowRoot.getElementById('nav-btns').style.display = 'none';
    this.shadowRoot.appendChild(slideshow);

    this.dispatchEvent(new CustomEvent('pl-gallery-slideshow-opened', {
      composed: true, bubbles: true,
      detail: { currentItemId: startFromId }
    }));
  }

  closeSlideshow(currentItemId) {
    let slideshow = this.shadowRoot.querySelector('pl-slideshow');
    if (!slideshow) return;

    if (!currentItemId) {
      let active = slideshow.shadowRoot?.querySelector('#slides [data-pos="0"]');
      if (active) {
        let idx = active.dataset.idx.split(',').map(Number);
        currentItemId = slideshow.data[idx[0]]?.items[idx[1]]?.data?.id;
      }
    }

    this.shadowRoot.getElementById('nav-btns').style.display = '';

    let thumbRect = currentItemId ? this.#getThumbRect(currentItemId) : null;
    let mediaRect = slideshow.prepareForDismiss();

    if (!thumbRect || !mediaRect) {
      slideshow.remove();
      this.dispatchEvent(new Event('pl-gallery-slideshow-closed', { composed: true, bubbles: true }));
      return;
    }

    let mediaCenterX = mediaRect.left + mediaRect.width / 2;
    let mediaCenterY = mediaRect.top + mediaRect.height / 2;
    let thumbCenterX = thumbRect.x + thumbRect.w / 2;
    let thumbCenterY = thumbRect.y + thumbRect.h / 2;
    let scale = thumbRect.w / mediaRect.width;
    let tx = thumbCenterX - mediaCenterX;
    let ty = thumbCenterY - mediaCenterY;

    slideshow.style.transformOrigin = `${mediaCenterX}px ${mediaCenterY}px`;

    let anim = slideshow.animate([
      { transform: 'translate(0px, 0px) scale(1)' },
      { transform: `translate(${tx}px, ${ty}px) scale(${scale})` }
    ], {
      duration: 200,
      easing: 'ease-in',
      fill: 'forwards'
    });

    anim.finished.then(() => {
      slideshow.remove();
      this.dispatchEvent(new Event('pl-gallery-slideshow-closed', { composed: true, bubbles: true }));
    });
  }

  #getThumbRect(id) {
    let gallery = this.shadowRoot.getElementById('gallery');
    let galleryRect = gallery.getBoundingClientRect();

    for (let section of this.#daySections) {
      for (let album of section.albums) {
        let item = album.data.find(x => x.data.id === id);
        if (item) {
          return {
            x: galleryRect.left + parseFloat(item.layout.trX),
            y: galleryRect.top + section.offsetTop + album.offsetTop + item.layout.offsetHeight - gallery.scrollTop,
            w: item.layout.width,
            h: item.layout.height
          };
        }
      }
    }
    return null;
  }

  #scrollToItem(id) {
    for (let section of this.#daySections) {
      for (let album of section.albums) {
        let item = album.data.find(x => x.data.id === id);
        if (item) {
          let gallery = this.shadowRoot.getElementById('gallery');
          let targetTop = section.offsetTop + album.offsetTop + item.layout.offsetHeight;
          let centered = targetTop - (gallery.clientHeight - item.layout.height) / 2;
          gallery.scrollTo({ top: centered });
          return;
        }
      }
    }
  }

}

window.customElements.define('pl-gallery', PlGallery);
