// pl-gallery-index: a scroll position index for pl-gallery.
//
// === Terminology ===
//
// - Marker: the moving element that tracks scroll position. Composed of the
//   marker line (horizontal bar) + marker pill (blue rounded label showing
//   current month/year). The pill also acts as a scrub handle.
// - Ticks: the static reference points. Split into major ticks (labeled
//   pills, max 5) and minor ticks (dots, one per unlabeled month).
// - Rail: the invisible positioning container that holds ticks + marker.
//   Controls top/bottom insets.
//
// === Visibility States ===
//
// - Hidden: everything invisible. Default idle state.
// - Full: ticks + marker visible. Shown at start of scroll and during scrub.
// - Marker-only: ticks hidden, marker visible. Shown after prolonged scroll.
//
// === State Transitions ===
//
// - hidden -> full:         on first scroll event
// - full -> marker-only:    2.5s of continuous scrolling without pause
// - full -> hidden:         1.5s after scroll stops (if scroll < 2.5s total)
// - marker-only -> hidden:  1.5s after scroll stops
// - full/marker-only -> full: on scrub start (pointerdown on pill)
// - marker-only -> full (CSS): on hover of pill or any tick element
// - On scrub end (pointerup): state stays full, normal 2.5s timer resumes
// - On tick click: timer resets, stays full for another 2.5s
//
// === Position Mapping ===
//
// Scroll-proportional. A tick for a given day-section sits at
// Y = (section.offsetTop / scrollHeight) * railHeight. The marker tracks
// scrollTop the same way.
//
// === Major Tick Selection (max 5) ===
//
// - If unique months <= 5: show all as major ticks.
// - Otherwise: topmost and bottommost always pinned, year transitions get
//   priority for middle slots, remaining slots distributed by maximizing
//   spacing.
// - Year-start labels show just "YYYY" in bolder style; others show
//   "Mon YYYY".
//
// === Minor Ticks ===
//
// One dot per unique month not already a major tick. Clickable (jump).
//
// === Scrub ===
//
// Dragging the marker pill sets gallery scrollTop proportionally via the
// pl-gallery-index-scrub event. Works on desktop (mouse) and mobile (touch).

import sheet from "./styles/pl-gallery-index.css" with { type: "css" };

const MAX_MAJOR_TICKS = 5;
const TICK_HIDE_DELAY = 2500;   // ms before ticks fade in full -> marker-only
const MARKER_HIDE_DELAY = 1500; // ms after scroll stops before marker hides

class PlGalleryIndex extends HTMLElement {

  // Day groups from the gallery.
  #data = [];

  // Per-day-section layout snapshot pushed by the gallery.
  // Shape: [{day, offsetTop, offsetHeight}], ordered as in #data (newest first).
  #dayOffsets = [];
  #scrollHeight = 0;
  #clientHeight = 0;
  #scrollTop = 0;

  // Computed ticks.
  #majorTicks = [];
  #minorTicks = [];

  // Visibility state: 'hidden' | 'full' | 'marker-only'
  #visState = 'hidden';
  #tickHideTimer = null;   // full -> marker-only after TICK_HIDE_DELAY
  #markerHideTimer = null; // marker-only/full -> hidden after MARKER_HIDE_DELAY
  #isScrubbing = false;
  #isHovering = false;

  static template = document.createElement('template');
  static {
    this.template.innerHTML = // html
    `
      <aside id="rail">
        <div id="ticks"></div>
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
    this.shadowRoot.getElementById('rail').addEventListener('click', this.#handleTickClick);
    let pill = this.shadowRoot.getElementById('marker-pill');
    pill.addEventListener('pointerdown', this.#handleScrubStart);
    // Hover-to-reveal only on devices with a real pointer (mouse).
    // Touch devices get simulated mouseenter on tap which never gets a
    // corresponding mouseleave, causing ticks to stay visible forever.
    if (window.matchMedia?.('(hover: hover)').matches) {
      pill.addEventListener('mouseenter', this.#handleHoverIn);
      pill.addEventListener('mouseleave', this.#handleHoverOut);
      let ticks = this.shadowRoot.getElementById('ticks');
      ticks.addEventListener('mouseenter', this.#handleHoverIn);
      ticks.addEventListener('mouseleave', this.#handleHoverOut);
    }
    this.#repaint();
  }

  // --- Public API ---

  set data(_) {
    this.#data = Array.isArray(_) ? _ : [];
    if (this.isConnected) this.#repaint();
  }

  updateLayout({ dayOffsets, scrollHeight, clientHeight }) {
    this.#dayOffsets = Array.isArray(dayOffsets) ? dayOffsets : [];
    this.#scrollHeight = +scrollHeight || 0;
    this.#clientHeight = +clientHeight || 0;
    if (this.isConnected) this.#repaint();
  }

  /**
   * Called at frame rate by the gallery on every scroll tick.
   * Drives both the marker position and the visibility state machine.
   */
  updateScroll(scrollTop) {
    this.#scrollTop = +scrollTop || 0;
    if (!this.isConnected) return;
    this.#paintMarker();
    this.#onScrollTick();
  }

  /**
   * Called by the gallery when scroll has stopped (scrollend or debounce).
   */
  notifyScrollStop() {
    if (!this.isConnected) return;
    this.#onScrollStop();
  }

  // --- Visibility state machine ---

  #onScrollTick() {
    if (this.#isScrubbing) return; // scrub forces full, ignore scroll ticks

    if (this.#visState === 'hidden') {
      // hidden -> full
      this.#setVisState('full');
      // Start the tick-hide timer (full -> marker-only after 1.5s)
      this.#startTickHideTimer();
    }

    // Reset the marker-hide timer on every scroll tick (marker stays as
    // long as scrolling continues).
    this.#resetMarkerHideTimer();
  }

  #onScrollStop() {
    if (this.#isScrubbing || this.#isHovering) return;

    // When scroll stops, start the countdown to hide the marker.
    this.#startMarkerHideTimer();
  }

  #startTickHideTimer() {
    this.#clearTickHideTimer();
    this.#tickHideTimer = setTimeout(() => {
      this.#tickHideTimer = null;
      if (this.#visState === 'full' && !this.#isScrubbing && !this.#isHovering) {
        this.#setVisState('marker-only');
      }
    }, TICK_HIDE_DELAY);
  }

  #clearTickHideTimer() {
    if (this.#tickHideTimer) {
      clearTimeout(this.#tickHideTimer);
      this.#tickHideTimer = null;
    }
  }

  #startMarkerHideTimer() {
    this.#clearMarkerHideTimer();
    this.#markerHideTimer = setTimeout(() => {
      this.#markerHideTimer = null;
      if (!this.#isScrubbing) {
        this.#setVisState('hidden');
      }
    }, MARKER_HIDE_DELAY);
  }

  #resetMarkerHideTimer() {
    // Clear any pending hide - scroll is still active.
    this.#clearMarkerHideTimer();
  }

  #clearMarkerHideTimer() {
    if (this.#markerHideTimer) {
      clearTimeout(this.#markerHideTimer);
      this.#markerHideTimer = null;
    }
  }

  #setVisState(state) {
    this.#visState = state;
    // Reflect state as a data attribute for CSS to drive transitions.
    this.dataset.vis = state;
  }

  // --- Internals ---

  #repaint() {
    // Hide the index entirely when the content fits within the viewport
    // or there's only a single day (nothing to navigate to).
    let nothingToScroll = this.#scrollHeight <= this.#clientHeight + 1;
    let singleDay = this.#dayOffsets.length <= 1;
    if (nothingToScroll || singleDay || this.#dayOffsets.length === 0) {
      this.hidden = true;
      return;
    }
    this.hidden = false;

    this.#computeTicks();
    this.#paintTicks();
    this.#paintMarker();
  }

  #railHeight() {
    let rail = this.shadowRoot.getElementById('rail');
    return rail ? rail.clientHeight : 0;
  }

  #computeTicks() {
    let railHeight = this.#railHeight();
    if (railHeight === 0 || this.#scrollHeight === 0) {
      this.#majorTicks = [];
      this.#minorTicks = [];
      return;
    }

    let monthMap = new Map();
    let yearFirstMonth = new Map();

    for (let off of this.#dayOffsets) {
      let parts = parseDay(off.day);
      if (!parts) continue;
      let mKey = `${parts.y}-${String(parts.m).padStart(2, '0')}`;
      if (!monthMap.has(mKey)) {
        monthMap.set(mKey, off);
        if (!yearFirstMonth.has(parts.y)) yearFirstMonth.set(parts.y, mKey);
      }
    }

    let allMonths = [];
    for (let [mKey, off] of monthMap) {
      let parts = parseDay(off.day);
      let y = (off.offsetTop / this.#scrollHeight) * railHeight;
      let isYearStart = yearFirstMonth.get(parts.y) === mKey;
      allMonths.push({ day: off.day, mKey, y, parts, isYearStart });
    }
    allMonths.sort((a, b) => a.y - b.y);

    let minY = 12;
    let maxY = railHeight - 12;
    for (let m of allMonths) {
      if (m.y < minY) m.y = minY;
      if (m.y > maxY) m.y = maxY;
    }

    let spansMultipleYears = yearFirstMonth.size > 1;

    let majorSet;
    if (allMonths.length <= MAX_MAJOR_TICKS) {
      majorSet = new Set(allMonths.map(m => m.mKey));
    } else {
      majorSet = new Set();
      majorSet.add(allMonths[0].mKey);
      majorSet.add(allMonths[allMonths.length - 1].mKey);

      if (spansMultipleYears) {
        for (let m of allMonths) {
          if (majorSet.size >= MAX_MAJOR_TICKS) break;
          if (m.isYearStart) majorSet.add(m.mKey);
        }
      }

      if (majorSet.size < MAX_MAJOR_TICKS) {
        let remaining = allMonths.filter(m => !majorSet.has(m.mKey));
        let slotsLeft = MAX_MAJOR_TICKS - majorSet.size;
        for (let i = 0; i < slotsLeft && remaining.length > 0; i++) {
          let majorYs = allMonths.filter(m => majorSet.has(m.mKey)).map(m => m.y);
          let best = null;
          let bestMinDist = -1;
          for (let candidate of remaining) {
            let minDist = Math.min(...majorYs.map(my => Math.abs(candidate.y - my)));
            if (minDist > bestMinDist) {
              bestMinDist = minDist;
              best = candidate;
            }
          }
          if (best) {
            majorSet.add(best.mKey);
            remaining = remaining.filter(m => m.mKey !== best.mKey);
          }
        }
      }
    }

    this.#majorTicks = [];
    this.#minorTicks = [];

    for (let m of allMonths) {
      if (majorSet.has(m.mKey)) {
        let isYear = spansMultipleYears && m.isYearStart;
        let label = isYear
          ? `${m.parts.y}`
          : `${MONTH_SHORT[m.parts.m - 1]} ${m.parts.y}`;
        this.#majorTicks.push({ day: m.day, label, y: m.y, isYear });
      } else {
        this.#minorTicks.push({ day: m.day, y: m.y });
      }
    }
  }

  #paintTicks() {
    let container = this.shadowRoot.getElementById('ticks');
    if (!container) return;
    container.innerHTML = '';

    for (let tick of this.#majorTicks) {
      let el = document.createElement('span');
      el.className = 'major-tick' + (tick.isYear ? ' year' : '');
      el.dataset.day = tick.day;
      el.style.top = `${tick.y}px`;
      el.textContent = tick.label;
      container.appendChild(el);
    }

    for (let tick of this.#minorTicks) {
      let el = document.createElement('span');
      el.className = 'minor-tick';
      el.dataset.day = tick.day;
      el.style.top = `${tick.y}px`;
      container.appendChild(el);
    }

    this.#updateActiveTick();
  }

  #paintMarker() {
    let marker = this.shadowRoot.getElementById('marker');
    let pill = this.shadowRoot.getElementById('marker-pill');
    if (!marker || !pill) return;

    let railHeight = this.#railHeight();
    if (railHeight === 0 || this.#scrollHeight === 0) return;

    let y = (this.#scrollTop / this.#scrollHeight) * railHeight;
    marker.style.transform = `translateY(calc(${y}px - 50%))`;

    let current = null;
    for (let off of this.#dayOffsets) {
      if (off.offsetTop <= this.#scrollTop) current = off;
      else break;
    }
    if (!current && this.#dayOffsets.length > 0) current = this.#dayOffsets[0];
    pill.textContent = current ? formatPill(current.day) : '';

    this.#updateActiveTick();
  }

  #updateActiveTick() {
    if (!this.#majorTicks.length) return;
    let railHeight = this.#railHeight();
    if (railHeight === 0 || this.#scrollHeight === 0) return;

    let markerY = (this.#scrollTop / this.#scrollHeight) * railHeight;

    let activeIdx = -1;
    for (let i = 0; i < this.#majorTicks.length; i++) {
      if (this.#majorTicks[i].y <= markerY) activeIdx = i;
      else break;
    }

    let majorEls = this.shadowRoot.querySelectorAll('.major-tick');
    majorEls.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
  }

  #handleTickClick = (evt) => {
    let target = evt.target.closest('[data-day]');
    if (!target) return;
    let day = target.dataset.day;
    if (!day) return;
    // Reset the tick-hide timer so ticks stay visible after a click.
    this.#setVisState('full');
    this.#startTickHideTimer();
    this.dispatchEvent(new CustomEvent('pl-gallery-index-jump', {
      bubbles: true, composed: true,
      detail: { day }
    }));
  }

  // --- Hover (pill or ticks) ---

  #handleHoverIn = () => {
    this.#isHovering = true;
    if (this.#visState === 'full' || this.#visState === 'marker-only') {
      this.#clearTickHideTimer();
      this.#clearMarkerHideTimer();
      this.#setVisState('full');
    }
  }

  #handleHoverOut = () => {
    this.#isHovering = false;
    if (this.#visState === 'full' && !this.#isScrubbing) {
      this.#startTickHideTimer();
      // If scrolling already stopped while we were hovering, the
      // notifyScrollStop call was a no-op (scrub/hover was active).
      // Start the marker-hide timer now so the marker eventually hides.
      this.#startMarkerHideTimer();
    }
  }

  // --- Scrub ---

  #handleScrubStart = (evt) => {
    evt.preventDefault();
    let pill = this.shadowRoot.getElementById('marker-pill');
    let rail = this.shadowRoot.getElementById('rail');
    if (!pill || !rail) return;

    pill.setPointerCapture(evt.pointerId);
    pill.classList.add('scrubbing');
    this.#isScrubbing = true;

    // Force full visibility during scrub.
    this.#clearTickHideTimer();
    this.#clearMarkerHideTimer();
    this.#setVisState('full');

    let railRect = rail.getBoundingClientRect();

    let onMove = (e) => {
      let y = e.clientY - railRect.top;
      let ratio = Math.max(0, Math.min(1, y / railRect.height));
      let targetScrollTop = ratio * this.#scrollHeight;
      this.dispatchEvent(new CustomEvent('pl-gallery-index-scrub', {
        bubbles: true, composed: true,
        detail: { scrollTop: targetScrollTop }
      }));
    };

    let onUp = (e) => {
      pill.releasePointerCapture(e.pointerId);
      pill.classList.remove('scrubbing');
      this.#isScrubbing = false;
      pill.removeEventListener('pointermove', onMove);
      pill.removeEventListener('pointerup', onUp);
      pill.removeEventListener('pointercancel', onUp);
      // On release: stay in full, start the tick-hide timer so ticks fade
      // after the normal delay. The marker-hide timer starts when scroll
      // actually stops (via notifyScrollStop).
      this.#startTickHideTimer();
    };

    pill.addEventListener('pointermove', onMove);
    pill.addEventListener('pointerup', onUp);
    pill.addEventListener('pointercancel', onUp);
  }
}

// --- Date helpers ---

function parseDay(dayKey) {
  if (!dayKey) return null;
  let [y, m, d] = dayKey.split('-').map(Number);
  if (!y || !m || !d) return null;
  return { y, m, d };
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatPill(dayKey) {
  let parts = parseDay(dayKey);
  if (!parts) return dayKey || '';
  if (dayKey === '1970-01-01') return 'No date';
  return `${MONTH_SHORT[parts.m - 1]} ${parts.y}`;
}

window.customElements.define('pl-gallery-index', PlGalleryIndex);
