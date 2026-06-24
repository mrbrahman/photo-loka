// pl-gallery-index: a scroll position index for pl-gallery.
//
// Design:
//
// 1. Position mapping is scroll-proportional. The rail is a compressed
//    mirror of the gallery's scroll content. A label for a given day-section
//    sits at Y = (section.offsetTop / scrollHeight) * railHeight.
//    The marker tracks scrollTop the same way.
//
// 2. Major ticks: max 5 labeled pills. Topmost and bottommost always shown.
//    Year transitions get priority for middle slots. Remaining slots are
//    distributed by rail Y spacing. Labels show "Mon YYYY" except year
//    transitions which show "YYYY" in bolder style.
//    If total unique months <= 5, all are shown as major ticks.
//
// 3. Minor ticks: one per unique month not already a major tick. Shown as
//    small dots, only visible on desktop hover (not during scroll). Clickable.
//
// 4. Visibility. The rail fades in on hover or while the gallery is
//    scrolling (.scrolling class toggled by the gallery). Minor ticks only
//    appear on hover, not during scroll-only visibility.
//
// 5. Click to jump. Clicking a major or minor tick dispatches
//    pl-gallery-index-jump with { day }; the gallery does smooth scroll.

import sheet from "./styles/pl-gallery-index.css" with { type: "css" };

const MAX_MAJOR_TICKS = 5;

class PlGalleryIndex extends HTMLElement {

  // Day groups from the gallery.
  #data = [];

  // Per-day-section layout snapshot pushed by the gallery.
  // Shape: [{day, offsetTop, offsetHeight}], ordered as in #data (newest first).
  #dayOffsets = [];
  #scrollHeight = 0;
  #clientHeight = 0;
  #scrollTop = 0;

  // Computed ticks for the current layout.
  // Major: [{day, label, y, isYear: bool}]
  // Minor: [{day, y}]
  #majorTicks = [];
  #minorTicks = [];

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
    // Single click handler on the rail, using event delegation for all ticks.
    this.shadowRoot.getElementById('rail').addEventListener('click', this.#handleTickClick);
    // Scrub: pointer events on the marker pill for drag-to-scroll.
    let pill = this.shadowRoot.getElementById('marker-pill');
    pill.addEventListener('pointerdown', this.#handleScrubStart);
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
   * @param {number} layout.scrollHeight
   * @param {number} layout.clientHeight
   */
  updateLayout({ dayOffsets, scrollHeight, clientHeight }) {
    this.#dayOffsets = Array.isArray(dayOffsets) ? dayOffsets : [];
    this.#scrollHeight = +scrollHeight || 0;
    this.#clientHeight = +clientHeight || 0;
    if (this.isConnected) this.#repaint();
  }

  /**
   * Push the current scroll position. Called at frame rate by the gallery.
   */
  updateScroll(scrollTop) {
    this.#scrollTop = +scrollTop || 0;
    if (this.isConnected) this.#paintMarker();
  }

  // --- Internals ---

  #repaint() {
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

    // Build one entry per unique month, anchored to the first (topmost)
    // day-section in that month.
    let monthMap = new Map();  // 'YYYY-MM' -> dayOffset
    let yearFirstMonth = new Map();  // year -> first monthKey encountered

    for (let off of this.#dayOffsets) {
      let parts = parseDay(off.day);
      if (!parts) continue;
      let mKey = `${parts.y}-${String(parts.m).padStart(2, '0')}`;
      if (!monthMap.has(mKey)) {
        monthMap.set(mKey, off);
        if (!yearFirstMonth.has(parts.y)) yearFirstMonth.set(parts.y, mKey);
      }
    }

    // Convert to array sorted by rail Y (topmost first).
    let allMonths = [];
    for (let [mKey, off] of monthMap) {
      let parts = parseDay(off.day);
      let y = (off.offsetTop / this.#scrollHeight) * railHeight;
      let isYearStart = yearFirstMonth.get(parts.y) === mKey;
      allMonths.push({ day: off.day, mKey, y, parts, isYearStart });
    }
    allMonths.sort((a, b) => a.y - b.y);

    // Clamp top and bottom so ticks don't extend beyond the rail edges.
    // ~12px inset accounts for the tick's padding + half its line height
    // so the pill stays fully visible.
    let minY = 12;
    let maxY = railHeight - 12;
    for (let m of allMonths) {
      if (m.y < minY) m.y = minY;
      if (m.y > maxY) m.y = maxY;
    }

    // Determine if we span multiple years.
    let spansMultipleYears = yearFirstMonth.size > 1;

    // --- Major tick selection ---
    let majorSet;

    if (allMonths.length <= MAX_MAJOR_TICKS) {
      // Show all as major ticks.
      majorSet = new Set(allMonths.map(m => m.mKey));
    } else {
      // Pick up to 5. Always include first (topmost) and last (bottommost).
      majorSet = new Set();
      majorSet.add(allMonths[0].mKey);
      majorSet.add(allMonths[allMonths.length - 1].mKey);

      // Year transitions get priority for remaining slots.
      if (spansMultipleYears) {
        for (let m of allMonths) {
          if (majorSet.size >= MAX_MAJOR_TICKS) break;
          if (m.isYearStart) majorSet.add(m.mKey);
        }
      }

      // Fill remaining slots by distributing evenly across the rail.
      if (majorSet.size < MAX_MAJOR_TICKS) {
        let remaining = allMonths.filter(m => !majorSet.has(m.mKey));
        let slotsLeft = MAX_MAJOR_TICKS - majorSet.size;
        // Pick from remaining that maximizes minimum distance to already-picked.
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

    // Build major and minor tick arrays.
    this.#majorTicks = [];
    this.#minorTicks = [];

    for (let m of allMonths) {
      if (majorSet.has(m.mKey)) {
        // Year-start labels show just the year (bold) when spanning multiple
        // years. Otherwise show "Mon YYYY".
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

    // Pill shows the day-section the user is currently viewing.
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

    // Largest-y major tick that is <= markerY.
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
    this.dispatchEvent(new CustomEvent('pl-gallery-index-jump', {
      bubbles: true, composed: true,
      detail: { day }
    }));
  }

  // --- Scrub (drag the marker pill to scroll) ---

  #handleScrubStart = (evt) => {
    evt.preventDefault();
    let pill = this.shadowRoot.getElementById('marker-pill');
    let rail = this.shadowRoot.getElementById('rail');
    if (!pill || !rail) return;

    pill.setPointerCapture(evt.pointerId);
    pill.classList.add('scrubbing');

    // Keep the index visible for the entire scrub duration.
    // The 'scrubbing' attribute on the host tells CSS to force visibility
    // regardless of the .scrolling class state.
    this.setAttribute('scrubbing', '');

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
      this.removeAttribute('scrubbing');
      pill.removeEventListener('pointermove', onMove);
      pill.removeEventListener('pointerup', onUp);
      pill.removeEventListener('pointercancel', onUp);
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
