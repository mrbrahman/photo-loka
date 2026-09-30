// PipelineDiagramDagre -- an interactive SVG editor for the pipeline GATE graph.
//
// Scope: this draws ONLY the resource-gating graph (edges "A blocks B", where
// stage B's `gatedBy` lists A). The fixed data-flow between stages is not drawn
// here (it is hardcoded in the server and not user-editable). See
// go-server/docs/pipeline-dag-design.md for the gate-vs-dataflow distinction.
//
// It is a plain class (NOT a custom element, no shadow DOM): construct with a
// container element and an { onChange } callback. The model is the pipeline
// config JSON:
//   { stages: [{ name, concurrency, enabled, gatedBy: [] }] }
//
// Editing:
//   - click one stage node then another to create a gate (upstream -> gated);
//   - click an edge (or its lock glyph) to remove that gate;
//   - Escape or a click on empty space cancels a pending selection.
//   - edit a node's concurrency inline (contenteditable badge).
// Cycles, self-gates, and duplicate edges are rejected client-side (mirroring
// the server's validation) before an edit is committed; the server re-validates
// on Apply regardless.
//
// Layout is done by dagre (rankdir LR). Edges animate on add/remove/relayout
// via d3-selection + d3-transition. A no-transition fallback renders the final
// state immediately when transitions are unavailable.

import dagre from '@dagrejs/dagre';
import { select } from 'd3-selection';
import 'd3-transition'; // extends the d3 selection prototype with .transition()
import { showConfirmDialog } from '../utils.mjs';

// ---- constants ------------------------------------------------------------

const NODE_W = 150;
const NODE_H = 54;
const PATH_SAMPLES = 24;  // fixed sample count for edge morph interpolation
const ANIM_MS = 320;

// SVG namespace for elements we create by hand.
const SVGNS = 'http://www.w3.org/2000/svg';

// Friendly labels for the fixed stage set (kept in sync with pl-admin-indexer).
const STAGE_LABELS = {
  'bring-to-collection': 'Bring to Collection',
  'geo-lookup': 'Geo Lookup',
  'generate-video-thumbnail': 'Video Thumbnail',
  'generate-image-thumbnails': 'Image Thumbnails',
  'face-recognition': 'Face Recognition',
  'image-encoding': 'Image Encoding',
  'video-compression': 'Video Compression',
};

// Structural stages cannot be disabled (mirrors the server's structuralStages in
// go-server/internal/pipeline/config.go): the pipeline cannot function without
// the entry stage and the thumbnail stages the ML stages depend on. These nodes
// render without an enable/disable toggle.
const STRUCTURAL_STAGES = new Set([
  'bring-to-collection',
  'generate-image-thumbnails',
  'generate-video-thumbnail',
]);

export class PipelineDiagramDagre {
  #container;
  #onChange;
  #svg = null;       // d3 selection of the root <svg>
  #edgeLayer = null; // d3 selection of the <g> holding edges
  #nodeLayer = null; // d3 selection of the <g> holding nodes
  #defs = null;

  // Model: name -> stage object. Order is preserved via #order for getModel.
  #stages = new Map();
  #order = [];

  // Runtime highlighting: name -> { gatedClosed, paused, active }.
  #runtime = new Map();

  // Interaction state: the first-clicked node awaiting a target, or null.
  #pendingSource = null;

  // Cached layout result: nodes {name -> {x,y}} and edges {key -> points[]}.
  #layout = { nodes: new Map(), edges: new Map() };

  constructor(container, { onChange } = {}) {
    this.#container = container;
    this.#onChange = typeof onChange === 'function' ? onChange : () => {};
    this.#buildScaffold();
    this.#bindGlobalHandlers();
  }

  // ---- public API ---------------------------------------------------------

  // setModel replaces the whole model and re-renders (no animation on the very
  // first paint, animated on subsequent replacements).
  setModel(model) {
    const animate = this.#stages.size > 0;
    this.#stages.clear();
    this.#order = [];
    const stages = (model && Array.isArray(model.stages)) ? model.stages : [];
    for (const s of stages) {
      const stage = {
        name: s.name,
        concurrency: (typeof s.concurrency === 'number' && s.concurrency >= 1) ? s.concurrency : 1,
        enabled: s.enabled !== false,
        gatedBy: Array.isArray(s.gatedBy) ? [...s.gatedBy] : [],
      };
      this.#stages.set(stage.name, stage);
      this.#order.push(stage.name);
    }
    this.#pendingSource = null;
    this.#relayout();
    this.#render(animate);
  }

  // getModel serializes the current model back to the config JSON shape.
  getModel() {
    return {
      stages: this.#order.map((name) => {
        const s = this.#stages.get(name);
        const out = { name: s.name, concurrency: s.concurrency, enabled: s.enabled };
        if (s.gatedBy.length > 0) out.gatedBy = [...s.gatedBy];
        return out;
      }),
    };
  }

  // setRuntimeState updates per-stage highlighting from the status poll. Expects
  // a map/object of name -> { gatedClosed, paused, active }. Only repaints node
  // styling; does not re-layout.
  setRuntimeState(state) {
    this.#runtime.clear();
    if (state) {
      for (const [name, st] of Object.entries(state)) {
        this.#runtime.set(name, {
          gatedClosed: !!st.gatedClosed,
          paused: !!st.paused,
          active: (st.active ?? 0) > 0,
        });
      }
    }
    this.#applyRuntimeStyling();
  }

  destroy() {
    document.removeEventListener('keydown', this.#onKeydown);
    if (this.#svg) this.#svg.remove();
    this.#svg = this.#edgeLayer = this.#nodeLayer = this.#defs = null;
    this.#stages.clear();
    this.#order = [];
    this.#runtime.clear();
    this.#pendingSource = null;
  }

  // ---- scaffold -----------------------------------------------------------

  #buildScaffold() {
    const svg = select(this.#container)
      .append('svg')
      .attr('class', 'pl-dag')
      .attr('xmlns', SVGNS)
      // viewBox is set on layout; keep the graphic responsive but font-stable.
      .style('max-width', '100%')
      .style('height', 'auto');

    // Arrowhead marker, reused by every edge (points at the gated end).
    const defs = svg.append('defs');
    const marker = defs.append('marker')
      .attr('id', 'pl-dag-arrow')
      .attr('viewBox', '0 0 10 10')
      .attr('refX', 9).attr('refY', 5)
      .attr('markerWidth', 7).attr('markerHeight', 7)
      .attr('orient', 'auto-start-reverse');
    marker.append('path')
      .attr('d', 'M 0 0 L 10 5 L 0 10 z')
      .attr('class', 'pl-dag-arrowhead');

    this.#edgeLayer = svg.append('g').attr('class', 'pl-dag-edges');
    this.#nodeLayer = svg.append('g').attr('class', 'pl-dag-nodes');
    this.#svg = svg;
    this.#defs = defs;

    // Clicking empty SVG space cancels a pending source selection.
    svg.on('click', (event) => {
      if (event.target === svg.node()) this.#cancelPending();
    });
  }

  #bindGlobalHandlers() {
    // Bound reference so removeEventListener works in destroy().
    this.#onKeydown = (e) => {
      if (e.key === 'Escape') this.#cancelPending();
    };
    document.addEventListener('keydown', this.#onKeydown);
  }
  #onKeydown = null;

  // ---- layout -------------------------------------------------------------

  #relayout() {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 70, marginx: 16, marginy: 16 });
    g.setDefaultEdgeLabel(() => ({}));

    for (const name of this.#order) {
      g.setNode(name, { width: NODE_W, height: NODE_H });
    }
    // Edge direction: upstream (gating) -> gated stage. stage.gatedBy lists the
    // upstream names, so the edge is (up -> stage).
    for (const name of this.#order) {
      const s = this.#stages.get(name);
      for (const up of s.gatedBy) {
        if (this.#stages.has(up)) g.setEdge(up, name);
      }
    }

    dagre.layout(g);

    const nodes = new Map();
    for (const name of this.#order) {
      const n = g.node(name);
      nodes.set(name, { x: n.x, y: n.y });
    }
    const edges = new Map();
    g.edges().forEach((e) => {
      const pts = g.edge(e).points.map((p) => ({ x: p.x, y: p.y }));
      edges.set(this.#edgeKey(e.v, e.w), pts);
    });

    this.#layout = { nodes, edges };

    const gg = g.graph();
    const w = Math.max(gg.width || NODE_W, NODE_W);
    const h = Math.max(gg.height || NODE_H, NODE_H);
    if (this.#svg) {
      this.#svg.attr('viewBox', `0 0 ${w} ${h}`).attr('width', w).attr('height', h);
    }
  }

  #edgeKey(from, to) { return `${from}\u0000${to}`; }
  #parseKey(key) { const [from, to] = key.split('\u0000'); return { from, to }; }

  // ---- render -------------------------------------------------------------

  #render(animate) {
    this.#renderNodes(animate);
    this.#renderEdges(animate);
    this.#applyRuntimeStyling();
  }

  #renderNodes(animate) {
    const self = this;
    const data = this.#order.map((name) => ({
      name,
      pos: this.#layout.nodes.get(name) || { x: 0, y: 0 },
      stage: this.#stages.get(name),
    }));

    const sel = this.#nodeLayer.selectAll('g.pl-dag-node')
      .data(data, (d) => d.name);

    // ENTER
    const enter = sel.enter().append('g')
      .attr('class', 'pl-dag-node')
      .attr('transform', (d) => `translate(${d.pos.x},${d.pos.y})`)
      .style('opacity', 0)
      .on('click', function (event, d) {
        event.stopPropagation();
        self.#onNodeClick(d.name);
      });

    enter.append('rect')
      .attr('class', 'pl-dag-node-rect')
      .attr('x', -NODE_W / 2).attr('y', -NODE_H / 2)
      .attr('width', NODE_W).attr('height', NODE_H)
      .attr('rx', 8).attr('ry', 8);

    enter.append('text')
      .attr('class', 'pl-dag-node-label')
      .attr('text-anchor', 'middle')
      .attr('dy', -4)
      .text((d) => STAGE_LABELS[d.name] || d.name);

    // Enable/disable toggle glyph, top-right. Only optional (non-structural)
    // stages get one; structural stages render without it (cannot be disabled).
    enter.filter((d) => !STRUCTURAL_STAGES.has(d.name))
      .append('text')
      .attr('class', 'pl-dag-power')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('x', NODE_W / 2 - 12)
      .attr('y', -NODE_H / 2 + 12)
      .text('\u23FB') // power symbol
      .on('click', function (event, d) {
        event.stopPropagation();
        self.#toggleEnabled(d.name);
      });

    // Concurrency badge, contenteditable. We use a foreignObject so the browser
    // gives us native inline text editing.
    const badge = enter.append('foreignObject')
      .attr('class', 'pl-dag-conc-fo')
      .attr('x', -NODE_W / 2 + 8).attr('y', 6)
      .attr('width', NODE_W - 16).attr('height', 22);
    badge.append('xhtml:div')
      .attr('class', 'pl-dag-conc')
      .html((d) => self.#concInner(d.stage.concurrency));
    this.#wireConcurrencyEditing(badge.select('.pl-dag-conc-value'));

    // UPDATE + ENTER merge
    const merged = enter.merge(sel);

    // Refresh label + concurrency text (concurrency may have changed).
    merged.select('.pl-dag-node-label').text((d) => STAGE_LABELS[d.name] || d.name);
    merged.each(function (d) {
      const valEl = this.querySelector('.pl-dag-conc-value');
      if (valEl && document.activeElement !== valEl) {
        valEl.textContent = String(d.stage.concurrency);
      }
      // (re)wire in case this node just entered; harmless if already wired.
      self.#wireConcurrencyEditing(select(this).select('.pl-dag-conc-value'));
    });
    merged.classed('pl-dag-disabled', (d) => !d.stage.enabled);
    // Reflect enabled state on the power glyph (dimmed when disabled) + tooltip.
    merged.select('.pl-dag-power')
      .classed('off', (d) => !d.stage.enabled)
      .each(function (d) {
        this.setAttribute('title', d.stage.enabled ? 'Disable stage' : 'Enable stage');
      });

    if (animate && this.#canAnimate()) {
      merged.transition().duration(ANIM_MS)
        .style('opacity', 1)
        .attr('transform', (d) => `translate(${d.pos.x},${d.pos.y})`);
    } else {
      merged.style('opacity', 1)
        .attr('transform', (d) => `translate(${d.pos.x},${d.pos.y})`);
    }

    // EXIT (a stage vanishing would be unusual -- fixed stage set -- but handle it)
    sel.exit().remove();
  }

  #concInner(value) {
    return `<span class="pl-dag-conc-label">conc</span>` +
      `<span class="pl-dag-conc-value" contenteditable="true" ` +
      `inputmode="numeric" spellcheck="false" title="Editable concurrency">${value}</span>`;
  }

  // Attach edit handlers to a contenteditable concurrency value span. Idempotent
  // via a data flag so repeated renders do not stack listeners.
  #wireConcurrencyEditing(d3span) {
    const el = d3span.node && d3span.node();
    if (!el || el.dataset.wired === '1') return;
    el.dataset.wired = '1';
    const self = this;

    // Do not let a click on the editable text start a node-gate selection.
    el.addEventListener('click', (e) => e.stopPropagation());
    el.addEventListener('mousedown', (e) => e.stopPropagation());

    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); self.#revertConc(el); el.blur(); }
      // Allow digits, navigation, editing keys; block the rest.
      else if (e.key.length === 1 && !/[0-9]/.test(e.key)) e.preventDefault();
    });
    el.addEventListener('blur', () => self.#commitConc(el));
  }

  #nodeNameOf(el) {
    const g = el.closest('g.pl-dag-node');
    return g ? select(g).datum().name : null;
  }

  #revertConc(el) {
    const name = this.#nodeNameOf(el);
    if (name) el.textContent = String(this.#stages.get(name).concurrency);
  }

  #commitConc(el) {
    const name = this.#nodeNameOf(el);
    if (!name) return;
    const stage = this.#stages.get(name);
    const n = parseInt(el.textContent.trim(), 10);
    if (!Number.isFinite(n) || n < 1) {
      // Invalid: revert and report.
      el.textContent = String(stage.concurrency);
      this.#onChange({ error: `Concurrency for ${STAGE_LABELS[name] || name} must be an integer >= 1` });
      return;
    }
    if (n === stage.concurrency) { el.textContent = String(n); return; }
    stage.concurrency = n;
    el.textContent = String(n);
    this.#onChange({ model: this.getModel() });
  }

  #renderEdges(animate) {
    const self = this;
    const data = [...this.#layout.edges.entries()].map(([key, points]) => {
      const { from, to } = this.#parseKey(key);
      return { key, from, to, points };
    });

    const sel = this.#edgeLayer.selectAll('g.pl-dag-edge')
      .data(data, (d) => d.key);

    // ENTER
    const enter = sel.enter().append('g').attr('class', 'pl-dag-edge');

    // Wide invisible hit path (easy click target for removal).
    enter.append('path')
      .attr('class', 'pl-dag-edge-hit')
      .attr('fill', 'none')
      .on('click', function (event, d) {
        event.stopPropagation();
        self.#removeGate(d.from, d.to);
      });

    // Visible dotted curve with arrowhead at the gated end.
    enter.append('path')
      .attr('class', 'pl-dag-edge-line')
      .attr('fill', 'none')
      .attr('marker-end', 'url(#pl-dag-arrow)');

    // Lock glyph at the midpoint (also clickable to remove).
    enter.append('text')
      .attr('class', 'pl-dag-edge-lock')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .text('\uD83D\uDD12') // lock emoji
      .on('click', function (event, d) {
        event.stopPropagation();
        self.#removeGate(d.from, d.to);
      });

    const merged = enter.merge(sel);
    const canAnim = animate && this.#canAnimate();

    merged.each(function (d) {
      const g = select(this);
      const hit = g.select('.pl-dag-edge-hit');
      const line = g.select('.pl-dag-edge-line');
      const lock = g.select('.pl-dag-edge-lock');
      const newD = self.#pathD(d.points);
      const mid = self.#midpoint(d.points);

      hit.attr('d', newD);

      if (canAnim && line.attr('d')) {
        // Morph: resample old and new to a fixed point count and interpolate.
        const oldPts = self.#samplePath(line.node(), PATH_SAMPLES);
        const newPts = self.#resample(d.points, PATH_SAMPLES);
        line.transition().duration(ANIM_MS)
          .attrTween('d', () => (t) => self.#pathD(self.#lerpPoints(oldPts, newPts, t)))
          .on('end', () => line.attr('d', newD));
        lock.transition().duration(ANIM_MS)
          .attr('x', mid.x).attr('y', mid.y);
      } else {
        line.attr('d', newD);
        lock.attr('x', mid.x).attr('y', mid.y);
      }
    });

    // Fade-in on enter.
    if (canAnim) {
      enter.style('opacity', 0).transition().duration(ANIM_MS).style('opacity', 1);
    } else {
      enter.style('opacity', 1);
    }

    // EXIT -- fade out then remove.
    const exit = sel.exit();
    if (canAnim) {
      exit.transition().duration(ANIM_MS).style('opacity', 0).remove();
    } else {
      exit.remove();
    }
  }

  // ---- path helpers -------------------------------------------------------

  // Smooth curve through the routed waypoints (Catmull-Rom -> cubic bezier).
  #pathD(points) {
    if (!points || points.length === 0) return '';
    if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
    if (points.length === 2) {
      return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
    }
    let d = `M ${points[0].x} ${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
    }
    return d;
  }

  #midpoint(points) {
    if (!points || points.length === 0) return { x: 0, y: 0 };
    const i = Math.floor(points.length / 2);
    if (points.length % 2 === 1) return { ...points[i] };
    const a = points[i - 1], b = points[i];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  // Sample a live <path> element's geometry into n evenly-spaced points.
  #samplePath(pathEl, n) {
    const total = pathEl.getTotalLength();
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = pathEl.getPointAtLength((total * i) / (n - 1));
      out.push({ x: p.x, y: p.y });
    }
    return out;
  }

  // Resample a polyline (waypoints) into n evenly-spaced points by arc length.
  #resample(points, n) {
    if (points.length === 1) return Array.from({ length: n }, () => ({ ...points[0] }));
    const segLen = [];
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const dx = points[i + 1].x - points[i].x;
      const dy = points[i + 1].y - points[i].y;
      const l = Math.hypot(dx, dy);
      segLen.push(l);
      total += l;
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      const target = (total * i) / (n - 1);
      let acc = 0, seg = 0;
      while (seg < segLen.length - 1 && acc + segLen[seg] < target) { acc += segLen[seg]; seg++; }
      const segFrac = segLen[seg] > 0 ? (target - acc) / segLen[seg] : 0;
      out.push({
        x: points[seg].x + (points[seg + 1].x - points[seg].x) * segFrac,
        y: points[seg].y + (points[seg + 1].y - points[seg].y) * segFrac,
      });
    }
    return out;
  }

  #lerpPoints(a, b, t) {
    return a.map((p, i) => ({ x: p.x + (b[i].x - p.x) * t, y: p.y + (b[i].y - p.y) * t }));
  }

  #canAnimate() {
    // d3-transition attaches .transition to selection prototype; guard anyway,
    // and respect the user's reduced-motion preference.
    if (typeof this.#nodeLayer.transition !== 'function') return false;
    return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }

  // ---- interaction --------------------------------------------------------

  #onNodeClick(name) {
    if (this.#pendingSource === null) {
      this.#pendingSource = name;
      this.#markPending();
      return;
    }
    if (this.#pendingSource === name) {
      // clicking the same node again cancels.
      this.#cancelPending();
      return;
    }
    const source = this.#pendingSource; // upstream (gating) stage
    const target = name;                // gated stage
    this.#cancelPending();
    this.#addGate(source, target);
  }

  #markPending() {
    this.#nodeLayer.selectAll('g.pl-dag-node')
      .classed('pl-dag-pending', (d) => d.name === this.#pendingSource);
  }

  #cancelPending() {
    this.#pendingSource = null;
    this.#nodeLayer.selectAll('g.pl-dag-node').classed('pl-dag-pending', false);
  }

  // addGate: target.gatedBy gains source. Guards: self, duplicate, cycle.
  #addGate(source, target) {
    const tStage = this.#stages.get(target);
    if (!tStage || !this.#stages.has(source)) return;

    if (source === target) {
      this.#onChange({ error: 'A stage cannot gate itself' });
      return;
    }
    if (tStage.gatedBy.includes(source)) {
      this.#onChange({ error: `${STAGE_LABELS[target] || target} is already gated by ${STAGE_LABELS[source] || source}` });
      return;
    }
    if (this.#wouldCycle(source, target)) {
      this.#onChange({ error: 'That gate would create a cycle (deadlock) and was rejected' });
      return;
    }

    tStage.gatedBy.push(source);
    this.#relayout();
    this.#render(true);
    this.#onChange({ model: this.getModel() });
  }

  #removeGate(source, target) {
    const tStage = this.#stages.get(target);
    if (!tStage) return;
    const i = tStage.gatedBy.indexOf(source);
    if (i === -1) return;
    tStage.gatedBy.splice(i, 1);
    this.#relayout();
    this.#render(true);
    this.#onChange({ model: this.getModel() });
  }

  // toggleEnabled flips a stage's enabled flag (staged into the model; applied
  // live only on the host's Apply). Structural stages are not togglable and are
  // ignored. When DISABLING a stage that currently gates others (it appears in
  // other stages' gatedBy), those outgoing gates become no-ops -- a disabled
  // stage never has active/pending work, so it never holds a gate closed. We
  // ask the user to confirm, and on yes remove those outgoing gates. Incoming
  // gates (others gating this stage) are harmless and left intact.
  async #toggleEnabled(name) {
    const stage = this.#stages.get(name);
    if (!stage || STRUCTURAL_STAGES.has(name)) return;

    // Enabling is always safe and unconditional.
    if (!stage.enabled) {
      stage.enabled = true;
      this.#render(false);
      this.#onChange({ model: this.getModel() });
      return;
    }

    // Disabling: find gates where this stage is the upstream (gater).
    const gatedStages = this.#order.filter((n) => this.#stages.get(n).gatedBy.includes(name));

    if (gatedStages.length > 0) {
      const list = gatedStages.map((n) => STAGE_LABELS[n] || n).join(', ');
      const label = STAGE_LABELS[name] || name;
      const choice = await showConfirmDialog(
        'Disable stage?',
        `Disabling "${label}" will remove the gate(s) where it blocks: ${list}. ` +
        `A disabled stage never runs, so those gates would do nothing. Remove them and disable?`,
        'Disable',
        'Cancel',
      );
      if (choice !== 1) return; // Cancel/close: leave enabled, no change
      // Remove the outgoing gates.
      for (const n of gatedStages) {
        const gb = this.#stages.get(n).gatedBy;
        const i = gb.indexOf(name);
        if (i !== -1) gb.splice(i, 1);
      }
    }

    stage.enabled = false;
    this.#relayout();
    this.#render(true);
    this.#onChange({ model: this.getModel() });
  }

  // wouldCycle: adding edge (source -> target) means target.gatedBy gains
  // source. The gate graph edge is up -> gated. A cycle exists if `target` is
  // already reachable from `source` following existing (up -> gated) edges,
  // i.e. target can already reach source. Detect via DFS from source over the
  // reverse of gatedBy (from a stage to the stages it gates).
  #wouldCycle(source, target) {
    // Build adjacency: gater -> [gated stages].
    const gates = new Map();
    for (const name of this.#order) gates.set(name, []);
    for (const name of this.#order) {
      for (const up of this.#stages.get(name).gatedBy) {
        if (gates.has(up)) gates.get(up).push(name);
      }
    }
    // Adding source -> target; a cycle forms if we can already reach `source`
    // starting from `target`.
    const seen = new Set();
    const stack = [target];
    while (stack.length) {
      const cur = stack.pop();
      if (cur === source) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nxt of (gates.get(cur) || [])) stack.push(nxt);
    }
    return false;
  }

  // ---- runtime styling ----------------------------------------------------

  #applyRuntimeStyling() {
    if (!this.#nodeLayer) return;
    const self = this;
    this.#nodeLayer.selectAll('g.pl-dag-node').each(function (d) {
      const rt = self.#runtime.get(d.name) || {};
      const g = select(this);
      g.classed('pl-dag-gated', !!rt.gatedClosed);
      g.classed('pl-dag-paused', !!rt.paused);
      g.classed('pl-dag-active', !!rt.active);
    });
  }
}

export default PipelineDiagramDagre;
