/**
 * Reusable terrain canvas: renders an equirectangular heightfield (with an
 * optional shaded-relief or full surface-colour preview) and acts as the paint
 * surface for the terrain tools.
 *
 * Two things matter for usability here:
 *   1. painting updates the preview immediately, so you can see each stroke;
 *   2. the surface can be panned/zoomed while a stroke is in progress, via the
 *      Map2DView it is paired with (the editor wires them together).
 */

import { paintTerrain, heightAt, updateWaterMask } from '../world/terrain.js';
import { computeRivers } from '../world/terrain.js';
import { Map2DView } from '../render/map2d.js';
import { LAYERS, rampLut } from '../core/colors.js';

const OCEAN_DEEP = [14, 30, 47];
const OCEAN_MID = [30, 58, 82];
const SHELF = [48, 84, 112];
const LAND_LOW = [104, 122, 92];
const LAND_MID = [138, 132, 108];
const LAND_HIGH = [168, 160, 142];
const PEAK = [216, 218, 214];
const RIVER = [96, 138, 158];
const BRUSH_RING = [210, 226, 242];

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Render the terrain into a canvas at (optionally reduced) resolution.
 * @param {object} grid terrain grid
 * @param {object} o { cols, rows, shading, previewGrid, overlay, brush }
 */
export function renderTerrainToCanvas(grid, canvas, o = {}) {
  const cols = Math.max(2, Math.min(o.cols || grid.GX, 2048));
  const rows = Math.max(2, Math.min(o.rows || grid.GY, 1024));
  if (canvas.width !== cols || canvas.height !== rows) { canvas.width = cols; canvas.height = rows; }
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(cols, rows);
  const d = img.data;
  const H = grid.height;
  const GX = grid.GX, GY = grid.GY;
  const river = grid.river;
  const water = grid.waterMask;
  const shading = o.shading !== false;
  const preview = o.previewGrid || null;    // Float32Array of layer values, same size as terrain
  const previewLut = o.previewLut || null;

  for (let y = 0; y < rows; y++) {
    const j = Math.min(GY - 1, Math.floor((y + 0.5) / rows * GY));
    for (let x = 0; x < cols; x++) {
      const i = Math.min(GX - 1, Math.floor((x + 0.5) / cols * GX));
      const k = i + j * GX;
      const h = H[k];
      const isWater = water ? water[k] : h < 0;
      const out = (y * cols + x) * 4;
      let c;
      if (isWater) {
        const depth = Math.min(1, -h / 6000);
        c = mix(SHELF, OCEAN_DEEP, Math.pow(Math.max(0, depth), 0.55));
        c = mix(OCEAN_MID, c, Math.min(1, Math.max(0, depth) * 2.4));
      } else {
        const land = Math.min(1.3, h / 3800);
        c = land < 0.25 ? mix(LAND_LOW, LAND_MID, Math.max(0, land) / 0.25)
          : land < 0.7 ? mix(LAND_MID, LAND_HIGH, (land - 0.25) / 0.45)
            : mix(LAND_HIGH, PEAK, Math.min(1, Math.max(0, (land - 0.7) / 0.6)));
        if (shading) {
          const iE = i + 1 < GX ? k + 1 : k;
          const jS = j + 1 < GY ? k + GX : k;
          const gx = (H[iE] - H[k]) / 800;
          const gy = (H[jS] - H[k]) / 800;
          const sh = 1 + Math.max(-0.45, Math.min(0.45, -gx * 0.9 - gy * 0.7));
          c = [c[0] * sh, c[1] * sh, c[2] * sh];
        }
      }
      if (river && river[k] > 0.02 && !isWater) c = mix(c, RIVER, Math.min(0.75, river[k] * 1.3));
      if (preview && previewLut) {
        const v = preview[k];
        if (isFinite(v)) {
          const span = Math.max(1e-6, o.previewMax - o.previewMin);
          const t = Math.max(0, Math.min(1, (v - o.previewMin) / span));
          const li = Math.min(255, Math.round(t * 255)) * 3;
          const pc = [previewLut[li], previewLut[li + 1], previewLut[li + 2]];
          c = mix(c, pc, o.previewAlpha === undefined ? 0.7 : o.previewAlpha);
        }
      }
      d[out] = Math.max(0, Math.min(255, c[0]));
      d[out + 1] = Math.max(0, Math.min(255, c[1]));
      d[out + 2] = Math.max(0, Math.min(255, c[2]));
      d[out + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/**
 * Brush ring parameters in canvas pixel space. The ring is deliberately *not*
 * baked into the terrain bitmap any more: the Map2DView that draws that bitmap
 * also draws the ring in screen space, and two rings (one of them resampled with
 * the image) is exactly what made the cursor look offset from the pointer.
 */
export function brushRingFor(grid, cols, rows, brush) {
  if (!brush || !brush.show) return null;
  return {
    x: ((brush.lon + 180) / 360) * cols,
    y: ((90 - brush.lat) / 180) * rows,
    r: Math.max(2, (brush.radiusDeg / 360) * cols),
  };
}

/**
 * Low-resolution preview used while a stroke is in progress (stays responsive).
 *
 * The canvas is normally paired with a Map2DView (`this.view`), which owns the
 * on-screen rendering, the pan/zoom state and the pointer events. In that mode
 * this class only produces the offscreen bitmap — it must never draw to the
 * shared canvas itself, or the two renderers fight and the picture appears to
 * zoom and jump on its own.
 */
export class TerrainCanvas {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { getGrid, onChange, showBrush, canvas2d }
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.getGrid = opts.getGrid;
    this.onChange = opts.onChange || (() => {});
    this.showBrush = opts.showBrush !== false;
    this.tool = 'raise';
    this.radius = 12;
    this.brushHeight = 600;          // metres per stroke for raise/lower
    this.strength = 0.6;             // 0..1 for smooth / flatten
    this.brush = null;
    this.painting = false;
    this.needsRender = true;
    this.limits = opts.limits || null;
    this.previewLayer = null;        // layer key for the live climate overlay
    this.showShading = true;
    this._boundCanvas = canvas;
    this.ctx = canvas.getContext('2d');
    this._off = document.createElement('canvas');
    this._renderBudget = 0;
    // `delegated` means a Map2DView owns the pointer on this canvas
    this.delegated = opts.delegated === true;
    if (!this.delegated) this.bind();
  }

  /** Geo position of a pointer event, in the canvas' own frame. */
  toLatLon(e) {
    const r = this.canvas.getBoundingClientRect();
    const x = (e.clientX - r.left) / Math.max(1, r.width);
    const y = (e.clientY - r.top) / Math.max(1, r.height);
    return { lon: x * 360 - 180, lat: 90 - y * 180 };
  }

  /** Hover feedback for the delegated case (the view calls this). */
  setHover(geo) {
    this.brush = geo ? { ...geo, radiusDeg: this.radius, show: this.showBrush } : null;
    this.needsRender = false;
  }

  /**
   * The flat map view asks for an image to draw. We hand it the freshly rendered
   * offscreen canvas, rebuilding it if it is stale, so the map view shows the
   * same terrain (and brush cursor) as the direct preview.
   */
  previewImage() {
    if (this.view && this.view.dirty) {
      if (this.needsRender || !this._paintedOnce) this.renderOffscreen();
    }
    return this._off;
  }

  renderOffscreen() {
    const grid = this.getGrid();
    if (!grid) return this._off;
    const size = this._targetSize();
    // no `brush`: the cursor ring is drawn by the Map2DView in screen space
    const opts = { cols: size.cols, rows: size.rows, shading: this.showShading };
    if (this.previewLayer) {
      const info = this.previewProvider ? this.previewProvider(this.previewLayer) : null;
      if (info) {
        opts.previewGrid = info.data;
        opts.previewMin = info.min;
        opts.previewMax = info.max;
        opts.previewLut = info.lut;
        opts.previewAlpha = 0.7;
      }
    }
    renderTerrainToCanvas(grid, this._off, opts);
    this._paintedOnce = true;
    this.needsRender = false;
    return this._off;
  }

  /** Reduced resolution keeps a 1440x720 grid editable in real time. */
  _targetSize() {
    const grid = this.getGrid();
    if (!grid) return { cols: 2, rows: 1 };
    return { cols: Math.min(grid.GX, 1280), rows: Math.min(grid.GY, 640) };
  }

  bind() {
    const cv = this.canvas;
    const toLatLon = (e) => {
      const r = cv.getBoundingClientRect();
      const x = (e.clientX - r.left) / Math.max(1, r.width);
      const y = (e.clientY - r.top) / Math.max(1, r.height);
      return { lon: x * 360 - 180, lat: 90 - y * 180 };
    };
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      // Ctrl/Alt/Space-drag pans instead of painting, and wheel zooms; this is
      // what makes it possible to move the map mid-stroke on a big grid.
      if (e.ctrlKey || e.altKey || e.shiftKey) { this.panning = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); return; }
      cv.setPointerCapture(e.pointerId);
      this.painting = true;
      this.stroke(toLatLon(e));
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      const p = toLatLon(e);
      this.brush = { ...p, radiusDeg: this.radius, show: this.showBrush };
      this.needsRender = true;
      if (this.panning && this.view) {
        const dx = e.clientX - this.panning.x;
        const dy = e.clientY - this.panning.y;
        this.panning = { x: e.clientX, y: e.clientY };
        this.view.panBy(dx, dy);
      }
      if (this.painting && this.view) {
        // while painting, the cursor leaving one edge wraps to the other
        const x = ((p.lon + 180) % 360 + 360) % 360 - 180;
        this.stroke({ lat: p.lat, lon: x });
      }
    });
    const stop = (e) => {
      this.painting = false;
      this.panning = null;
      try { cv.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.needsRender = true;
      this.onChange({ committed: true });
    };
    cv.addEventListener('pointerup', stop);
    cv.addEventListener('pointercancel', stop);
    cv.addEventListener('pointerleave', () => { this.brush = null; this.needsRender = true; });
    cv.addEventListener('wheel', (e) => {
      if (!this.view) return;
      e.preventDefault();
      if (e.ctrlKey || e.altKey) {
        this.view.zoomAt(0.5, 0.5, e.deltaY > 0 ? 1 / 1.18 : 1.18);
      } else {
        this.radius = Math.max(1, Math.min(60, this.radius * (e.deltaY > 0 ? 0.9 : 1.1)));
        if (this.brush) this.brush.radiusDeg = this.radius;
        this.onChange({ radius: this.radius });
        this.needsRender = true;
      }
    }, { passive: false });
  }

  stroke(p) {
    const grid = this.getGrid();
    if (!grid) return;
    const tool = this.tool;
    let target = 0;
    let strength = this.strength;
    if (tool === 'flatten') {
      const y = Math.round((90 - p.lat) / 180 * (grid.GY - 1));
      const x = Math.round((p.lon + 180) / 360 * (grid.GX - 1));
      target = grid.height[Math.max(0, Math.min(grid.height.length - 1, y * grid.GX + x))];
      this.flattenTarget = target;
    }
    if (tool === 'smooth') {
      // strength is a blend factor; make the stroke visibly effective
      strength = Math.max(0.15, this.strength);
    }
    this.strokeHeight = this.brushHeight;
    paintTerrain(grid, p.lat, p.lon, this.radius, strength, tool, target, {
      ...(this.limits || {}),
      brushHeight: this.brushHeight,
    });
    updateWaterMask(grid);
    // Repaint immediately: previously the change was invisible until "重算河流"
    // was pressed, which made editing almost impossible.
    this.needsRender = true;
    this.onChange({ painting: true });
  }

  render() {
    const grid = this.getGrid();
    if (!grid) return;
    if (!this.needsRender) return;
    // When a Map2DView drives the canvas it also draws the image (with pan/zoom),
    // so this class only has to say "the bitmap changed".
    if (this.view) {
      this.needsRender = false;
      this.view.invalidate();
      return;
    }
    if (this.canvas !== this._boundCanvas) {
      this.ctx = this.canvas.getContext('2d');
      this._boundCanvas = this.canvas;
    }
    this.needsRender = false;
    const off = this.renderOffscreen();
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(off, 0, 0, this.canvas.width, this.canvas.height);
  }

  invalidate() {
    this.needsRender = true;
    this.render();
    if (this.view) this.view.invalidate();
  }
}

export { paintTerrain, heightAt, updateWaterMask, computeRivers, Map2DView, LAYERS, rampLut };
