// pl-gallery-index: a scroll position index for pl-gallery.
//
// Design (see also discussion in pl-gallery.js):
//
// 1. Position mapping is scroll-proportional. The rail is a compressed
//    mirror of the gallery's scroll content. A label for a given day-section
//    sits at Y = (section.offsetTop / scrollHeight) * railHeight, so every
//    label aligns with where its content actually lives on the scrollbar.
//    The marker tracks scrollTop the same way.
//
// 2. Adaptive label granularity. We try month-level labels first; if the
//    number of unique year-months would crowd the rail (less than minSpacing
//    px between labels), we fall back to quarter, then year. A final spacing
//    filter drops any remaining crowded labels.
//
// 3. Visibility. The host has two children: a narrow always-on hot zone
//    (for hover detection on desktop) and the visible rail. The rail fades
//    in on hover or while the gallery is scrolling, fades out otherwise.
//    The gallery toggles a .scrolling class on this element with a 1.5s
//    debounce after the last scroll tick.
//
// 4. Click to jump. Clicking a label dispatches pl-gallery-index-jump with
//    { day }; the gallery does the smooth scroll. Scrub-drag is intentionally
//    out of scope for v1.

import sheet from "./styles/pl-gallery-index.css" with { type: "css" };

const MIN_LABEL_SPACING_PX = 66;

class PlGalleryIndex extends HTMLElement {

  // Day groups from the gallery, used to derive labels.
  // Shape: [{day: 'YYYY-MM-DD', items: [...]}]. We only need the day keys
  // here, but accepting the full shape keeps the gallery contract simple.
  #data = [];

  // Per-day-section layout snapshot pushed by the gallery.
  // Shape: [{day, offsetTop, offsetHeight}], ordered as in #data (newest first).
  #dayOffsets = [];
  #scrollHeight = 0;
  #clientHeight = 0;
  #scrollTop = 0;

  // Computed labels for the current layout. Shape:
  // [{day, label, y, kind: 'year'|'quarter'|'month'}]
  #labels = [];

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <div id="hot-zone"></div>
      <aside id="rail">
        <div id="labels"></div>
        <div id="marker">
          <span id="marker-pill"></span>
          <div id="marker-line"></div>
        </div>
      </aside>
    `;
  }

  constructor() {
    super().attachShadow({ mode: 'open' });
    this.shadowRoot.adoptedStyleSheets = [sheet];
  }

  connectedCallback() {
    this.shadowRoot.appendChild(this.constructor.template.content.cloneNode(true));
    this.shadowRoot.getElementById('labels').addEventListener('click', this.#handleLabelClick);
    this.#repaint();
  }

  // --- Public API ---

  set data(_) {
    this.#data = Array.isArray(_) ? _ : [];
    if (this.isConnected) this.#repaint();
  }

  /**
   * Push the latest layout snapshot from the gallery.
   * @param {object} layout
   * @param {Array<{day:string,offsetTop:number,offsetHeight:number}>} layout.dayOffsets
   * @param {number} layout.scrollHeight - gallery scroll content height
   * @param {number} layout.clientHeight - gallery viewport height
   */
  updateLayout({ dayOffsets, scrollHeight, clientHeight }) {
    this.#dayOffsets = Array.isArray(dayOffsets) ? dayOffsets : [];
    this.#scrollHeight = +scrollHeight || 0;
    this.#clientHeight = +clientHeight || 0;
    if (this.isConnected) this.#repaint();
  }

  /**
   * Push the current scroll position. Cheap; called on every throttled scroll
   * tick by the gallery.
   */
  updateScroll(scrollTop) {
    this.#scrollTop = +scrollTop || 0;
    if (this.isConnected) this.#paintMarker();
  }

  // --- Internals ---

  #repaint() {
    // Hide the index entirely when the content fits within the viewport;
    // there's nothing to navigate to.
    let nothingToScroll = this.#scrollHeight <= this.#clientHeight + 1;
    let singleDay = this.#dayOffsets.length <= 1;
    if (nothingToScroll || singleDay || this.#dayOffsets.length === 0) {
      this.hidden = true;
      return;
    }
    this.hidden = false;

    this.#computeLabels();
    this.#paintLabels();
    this.#paintMarker();
  }

  #railHeight() {
    let rail = this.shadowRoot.getElementById('rail');
    return rail ? rail.clientHeight : 0;
  }

  #computeLabels() {
    let railHeight = this.#railHeight();
    if (railHeight === 0 || this.#scrollHeight === 0) {
      this.#labels = [];
      return;
    }

    // Build candidate label sets at three granularities. Always prefer the
    // finest granularity that has at least 2 entries. The spacing filter
    // below handles visual crowding independently.
    let monthMap = new Map();
    let quarterMap = new Map();
    let yearMap = new Map();

    for (let off of this.#dayOffsets) {
      let parts = parseDay(off.day);
      if (!parts) continue;
      let { y, m } = parts;
      let yKey = `${y}`;
      let qKey = `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
      let mKey = `${y}-${String(m).padStart(2, '0')}`;
      if (!monthMap.has(mKey)) monthMap.set(mKey, off);
      if (!quarterMap.has(qKey)) quarterMap.set(qKey, off);
      if (!yearMap.has(yKey)) yearMap.set(yKey, off);
    }

    // Pick finest granularity that has >= 2 entries (otherwise the index
    // is hidden anyway via the single-day check).
    let granularity, source;
    if (monthMap.size >= 2) { granularity = 'month'; source = monthMap; }
    else if (quarterMap.size >= 2) { granularity = 'quarter'; source = quarterMap; }
    else { granularity = 'year'; source = yearMap; }

    let raw = [];
    for (let [, off] of source) {
      raw.push({
        day: off.day,
        label: formatLabel(off.day, granularity),
        y: (off.offsetTop / this.#scrollHeight) * railHeight,
        kind: granularity
      });
    }
    raw.sort((a, b) => a.y - b.y);

    // Spacing filter: keep first; drop any that crowds the previous kept.
    // This is the only mechanism that limits visual density.
    let result = [];
    let lastY = -Infinity;
    for (let lbl of raw) {
      if (lbl.y - lastY >= MIN_LABEL_SPACING_PX) {
        result.push(lbl);
        lastY = lbl.y;
      }
    }

    this.#labels = result;
  }

  #paintLabels() {
    let container = this.shadowRoot.getElementById('labels');
    if (!container) return;
    container.innerHTML = '';
    for (let lbl of this.#labels) {
      let el = document.createElement('span');
      el.className = `label ${lbl.kind}`;
      el.dataset.day = lbl.day;
      el.style.top = `${lbl.y}px`;
      el.textContent = lbl.label;
      container.appendChild(el);
    }
    this.#updateActiveLabel();
  }

  #paintMarker() {
    let marker = this.shadowRoot.getElementById('marker');
    let pill = this.shadowRoot.getElementById('marker-pill');
    if (!marker || !pill) return;

    let railHeight = this.#railHeight();
    if (railHeight === 0 || this.#scrollHeight === 0) return;

    let y = (this.#scrollTop / this.#scrollHeight) * railHeight;
    // Use transform (compositor-only) instead of `top` so per-frame updates
    // don't trigger layout. calc() folds in the -50% vertical centering
    // (anchor is the line's mid-height, not its top edge).
    marker.style.transform = `translateY(calc(${y}px - 50%))`;

    // Pill shows the day-section the user is currently viewing. Choose the
    // last section whose offsetTop is <= scrollTop (largest offset not past us).
    let current = null;
    for (let off of this.#dayOffsets) {
      if (off.offsetTop <= this.#scrollTop) current = off;
      else break;
    }
    if (!current && this.#dayOffsets.length > 0) current = this.#dayOffsets[0];
    pill.textContent = current ? formatPill(current.day) : '';

    this.#updateActiveLabel();
  }

  #updateActiveLabel() {
    if (!this.#labels.length) return;
    let railHeight = this.#railHeight();
    if (railHeight === 0 || this.#scrollHeight === 0) return;

    let markerY = (this.#scrollTop / this.#scrollHeight) * railHeight;

    // Largest-y label that is <= markerY (i.e. the label the user has
    // scrolled past most recently).
    let activeIdx = -1;
    for (let i = 0; i < this.#labels.length; i++) {
      if (this.#labels[i].y <= markerY) activeIdx = i;
      else break;
    }

    let labelEls = this.shadowRoot.querySelectorAll('.label');
    labelEls.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
  }

  #handleLabelClick = (evt) => {
    let target = evt.target.closest('.label');
    if (!target) return;
    let day = target.dataset.day;
    if (!day) return;
    this.dispatchEvent(new CustomEvent('pl-gallery-index-jump', {
      bubbles: true, composed: true,
      detail: { day }
    }));
  }
}

// --- Date helpers (local to this component) ---

function parseDay(dayKey) {
  if (!dayKey) return null;
  let [y, m, d] = dayKey.split('-').map(Number);
  if (!y || !m || !d) return null;
  return { y, m, d };
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatLabel(dayKey, granularity) {
  let parts = parseDay(dayKey);
  if (!parts) return dayKey || '';
  if (granularity === 'year') return `${parts.y}`;
  if (granularity === 'quarter') {
    let q = Math.floor((parts.m - 1) / 3) + 1;
    return `Q${q} ${parts.y}`;
  }
  // month
  return `${MONTH_SHORT[parts.m - 1]} ${parts.y}`;
}

function formatPill(dayKey) {
  // Pill always shows month + year so it's compact and stable across most
  // scroll positions. Day-level detail would change on every thumb scroll.
  let parts = parseDay(dayKey);
  if (!parts) return dayKey || '';
  if (dayKey === '1970-01-01') return 'No date';
  return `${MONTH_SHORT[parts.m - 1]} ${parts.y}`;
}

window.customElements.define('pl-gallery-index', PlGalleryIndex);
