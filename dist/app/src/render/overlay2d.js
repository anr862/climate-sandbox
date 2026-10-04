/**
 * 2D arrow overlay for flow layers (wind field, ocean currents).
 *
 * The globe is a WebGL canvas and the flat map is a 2D canvas; neither can draw
 * arrows, so this module paints them on a transparent canvas that sits on top of
 * both and never receives pointer events.
 *
 * Arrows carry *both* quantities the user needs: direction (the arrow's heading,
 * computed by projecting a point a little way downstream, so it is correct under
 * any projection including near the poles) and speed (length and colour, mapped
 * through the same colourbar as the scalar layer so the legend stays meaningful).
 */

import { clamp } from '../core/noise.js';

/**
 * A point a little way downstream of (lat, lon) along the flow (u east, v north).
 *
 * Only the *direction* of the resulting screen vector is used — the arrow length
 * comes from the speed — so the step can be small and every projection (including
 * the polar views and the flat map) gets the heading right for free.
 */
export function flowOffset(lat, lon, u, v, stepDeg = 0.35) {
  const dLat = v * stepDeg;
  const dLon = (u * stepDeg) / Math.max(0.2, Math.cos(lat * Math.PI / 180));
  let lon2 = lon + dLon;
  while (lon2 > 180) lon2 -= 360;
  while (lon2 < -180) lon2 += 360;
  return { lat: Math.max(-89.5, Math.min(89.5, lat + dLat)), lon: lon2 };
}

/**
 * Draw one arrow from (x0,y0) along (dx,dy) with a head at the tip.
 *
 * A dark rim of uniform thickness (~0.8 px, `OUTLINE_RIM`) is laid down first so
 * the arrow stays legible over ice, deserts and pale colourbar ends. The rim is
 * produced by stroking *both* the shaft and the head with the same line width in
 * the outline pass — the previous version only grew the shaft (making the body
 * 2.2 px fatter than its own 1.2 px width) and merely scaled the head triangle,
 * which left the head rim invisible.
 */
export const OUTLINE_RIM = 0.85;

export function drawArrow(ctx, x0, y0, dx, dy, color, width = 1.5, head = 3.6, outline = 'rgba(6,10,14,0.9)') {
  const len = Math.hypot(dx, dy);
  if (!(len > 0.5)) return;
  const ux = dx / len, uy = dy / len;
  const tipX = x0 + dx, tipY = y0 + dy;
  const bx = tipX - ux * head, by = tipY - uy * head;         // head base centre
  const px = -uy * head * 0.45, py = ux * head * 0.45;        // half-width of the base
  const shaftEndX = tipX - ux * head * 0.75;
  const shaftEndY = tipY - uy * head * 0.75;

  for (const pass of [outline, null]) {
    const stroke = pass || color;
    const lw = width + (pass ? OUTLINE_RIM * 2 : 0);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // shaft
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(shaftEndX, shaftEndY);
    ctx.stroke();
    // head: fill + stroke so the rim follows the triangle exactly
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(bx + px, by + py);
    ctx.lineTo(bx - px, by - py);
    ctx.closePath();
    ctx.fillStyle = stroke;
    ctx.fill();
    if (pass) ctx.stroke();
  }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} o
 *   width/height  canvas size in CSS px
 *   step          sample spacing in CSS px
 *   sample(lat, lon) -> {u,v,speed} | null      u eastward, v northward (m/s)
 *   project(lat, lon) -> {x,y,facing} | null    canvas-relative position
 *   screenToGeo(x, y) -> {lat, lon} | null      used to place flat-map anchors
 *   geoToOffset(lat, lon, u, v) -> {lat, lon}   a point a little downstream
 *   ramp(t) -> [r,g,b]
 *   range {min,max}
 *   alpha
 */
export function drawFlowField(ctx, o) {
  const { width, height, step, sample, project, screenToGeo, geoToOffset, ramp, range } = o;
  const maxSpeed = Math.max(1e-6, (range && range.max) || 1);
  const minSpeed = Math.max(0, (range && range.min) || 0);
  const span = Math.max(1e-6, maxSpeed - minSpeed);
  const maxLen = step * 0.92;
  const alpha = o.alpha ?? 0.9;
  const weight = o.weight || null;          // footprint mask, e.g. "is this water?"
  let drawn = 0;

  for (let y = step * 0.5; y < height; y += step) {
    for (let x = step * 0.5; x < width; x += step) {
      const geo = screenToGeo(x, y);
      if (!geo || geo.lat === null) continue;
      const vec = sample(geo.lat, geo.lon);
      if (!vec || !isFinite(vec.speed) || !isFinite(vec.u) || !isFinite(vec.v)) continue;
      const speed = Math.abs(vec.speed) > 0 ? Math.abs(vec.speed) : Math.hypot(vec.u, vec.v);
      if (speed <= minSpeed + span * 0.02) continue;
      const p0 = project(geo.lat, geo.lon);
      if (!p0 || (p0.facing === false)) continue;
      const target = geoToOffset(geo.lat, geo.lon, vec.u, vec.v);
      const p1 = project(target.lat, target.lon);
      if (!p1 || (p1.facing === false)) continue;
      let dx = p1.x - p0.x, dy = p1.y - p0.y;
      const d = Math.hypot(dx, dy);
      if (!(d > 0.05)) continue;
      const t = clamp((speed - minSpeed) / span, 0, 1);
      let len = Math.max(4, maxLen * (0.28 + 0.72 * t));
      let a = alpha;
      // Shrink or drop the arrow so it cannot run over a coastline: an arrow that
      // starts in water but whose shaft crosses onto land is what made ocean
      // currents look like they were painted on the continents.
      if (weight) {
        const w0 = weight(geo.lat, geo.lon);
        if (w0 <= 0.02) continue;
        const wm = weight((geo.lat + target.lat) / 2, wrapLon((geo.lon + target.lon) / 2));
        const w1 = weight(target.lat, target.lon);
        const worst = Math.min(w0, wm, w1);
        if (worst <= 0.02) continue;
        if (worst < 0.55) { len *= 0.35 + 0.65 * (worst / 0.55); a *= 0.6; }
      }
      dx = (dx / d) * len;
      dy = (dy / d) * len;
      const c = ramp(t);
      drawArrow(ctx, p0.x, p0.y, dx, dy, `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`, 1.2, Math.max(3, len * 0.32));
      drawn++;
    }
  }
  return drawn;
}

/** Longitude into (−180, 180]. */
function wrapLon(lon) {
  let l = lon;
  while (l > 180) l -= 360;
  while (l < -180) l += 360;
  return l;
}

/**
 * Meteor-impact animation: a flash, an expanding shock ring and the blast
 * footprint, drawn where the impactor came down.
 *
 * `t` is seconds since the impact; the flash and ring are transient, while the
 * footprint stays as long as the dust does so the affected area remains visible
 * afterwards.
 */
export function drawImpact(ctx, o) {
  const { project, sizeFor, lat, lon, radiusDeg, t, dust, label } = o;
  const p = project(lat, lon);
  if (!p || p.facing === false) return false;
  const rMax = Math.max(6, sizeFor(lat, lon, radiusDeg));
  const flash = clamp(1 - t / 0.9, 0, 1);
  const ringT = clamp(t / 2.4, 0, 1);
  const ctx2 = ctx;

  // footprint of the affected area (persistent while dust remains)
  const foot = 0.18 + 0.5 * clamp(dust, 0, 1);
  if (foot > 0.02) {
    ctx2.beginPath();
    ctx2.arc(p.x, p.y, rMax, 0, Math.PI * 2);
    ctx2.fillStyle = `rgba(196,140,86,${(foot * 0.22).toFixed(3)})`;
    ctx2.fill();
    ctx2.strokeStyle = `rgba(214,164,108,${(foot * 0.75).toFixed(3)})`;
    ctx2.lineWidth = 1.3;
    ctx2.setLineDash([5, 4]);
    ctx2.stroke();
    ctx2.setLineDash([]);
  }

  // expanding shock ring
  if (ringT < 1) {
    const rr = rMax * (0.15 + 1.25 * ringT);
    const fade = (1 - ringT) * 0.85;
    ctx2.strokeStyle = `rgba(236,206,168,${fade.toFixed(3)})`;
    ctx2.lineWidth = 2.2 * (1 - ringT) + 0.6;
    ctx2.beginPath();
    ctx2.ellipse(p.x, p.y, rr, rr, 0, 0, Math.PI * 2);
    ctx2.stroke();
  }

  // fireball flash
  if (flash > 0) {
    const rad = Math.max(2, rMax * (0.25 + 0.5 * (1 - flash)));
    const grd = ctx2.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
    grd.addColorStop(0, `rgba(255,236,206,${(0.95 * flash).toFixed(3)})`);
    grd.addColorStop(0.45, `rgba(224,150,86,${(0.6 * flash).toFixed(3)})`);
    grd.addColorStop(1, 'rgba(150,80,40,0)');
    ctx2.fillStyle = grd;
    ctx2.beginPath();
    ctx2.arc(p.x, p.y, rad, 0, Math.PI * 2);
    ctx2.fill();
  }

  // impact point marker + label
  ctx2.strokeStyle = 'rgba(240,214,178,0.9)';
  ctx2.lineWidth = 1.4;
  ctx2.beginPath();
  ctx2.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
  ctx2.stroke();
  ctx2.beginPath();
  ctx2.moveTo(p.x - 7, p.y); ctx2.lineTo(p.x + 7, p.y);
  ctx2.moveTo(p.x, p.y - 7); ctx2.lineTo(p.x, p.y + 7);
  ctx2.stroke();
  if (label) {
    ctx2.font = '11px ui-monospace, Consolas, monospace';
    ctx2.fillStyle = 'rgba(240,220,196,0.92)';
    ctx2.fillText(label, p.x + 9, p.y - 7);
  }
  return true;
}

/**
 * Arrow overlay bound to one canvas. The owner supplies the projection each
 * frame, so the same class serves the globe and the flat map.
 */
export class VectorOverlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas ? canvas.getContext('2d') : null;
    this.visible = false;
  }

  resize(cssW, cssH) {
    if (!this.canvas) return null;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.floor(cssW * dpr));
    const h = Math.max(2, Math.floor(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w: cssW, h: cssH };
  }

  clear() {
    if (!this.canvas || !this.ctx) return;
    const cssW = this.canvas.clientWidth || this.canvas.width;
    const cssH = this.canvas.clientHeight || this.canvas.height;
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    void cssW; void cssH;
  }

  setVisible(on) {
    if (!this.canvas) return;
    this.visible = !!on;
    this.canvas.classList.toggle('hidden', !on);
    if (!on) this.clear();
  }

  /** Draw a flow field; returns the number of arrows drawn. */
  draw(opts) {
    if (!this.canvas || !this.ctx || !this.visible) return 0;
    const size = this.resize(this.canvas.clientWidth || 2, this.canvas.clientHeight || 2);
    this.clear();
    if (!size || size.w < 8 || size.h < 8) return 0;
    return drawFlowField(this.ctx, { ...opts, width: size.w, height: size.h, step: opts.step || 42 });
  }

  /** Meteor impact animation on top of whatever else is drawn. */
  drawImpactAnimation(opts) {
    if (!this.canvas || !this.ctx) return false;
    this.resize(this.canvas.clientWidth || 2, this.canvas.clientHeight || 2);
    return drawImpact(this.ctx, opts);
  }

  /** Brush ring used by the terrain editor's 3D preview. */
  drawRing(project, sizeFor, lat, lon, radiusDeg, color = 'rgba(205,222,238,0.85)') {
    if (!this.canvas || !this.ctx || !this.visible) return false;
    const size = this.resize(this.canvas.clientWidth || 2, this.canvas.clientHeight || 2);
    this.clear();
    if (!size) return false;
    const p = project(lat, lon);
    if (!p || p.facing === false) return false;
    const r = Math.max(3, sizeFor(lat, lon, radiusDeg));
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r, r, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
    ctx.fill();
    return true;
  }
}
