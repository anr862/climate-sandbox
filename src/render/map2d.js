/**
 * Equirectangular (flat) map view.
 *
 * Shared by the central globe pane and the terrain editor so both get the same
 * pan / zoom / arrow-key behaviour — the editor needs to move the map while the
 * brush is being dragged, so panning is deliberately independent of the pointer
 * being down.
 *
 * The view state is `cx`/`cy` (the map fraction at the viewport centre) and
 * `zoom` (screen pixels per map pixel). Narrow views draw the image two or three
 * times side by side, which makes horizontal wrapping at the antimeridian work
 * without a seam.
 */

const MIN_PAN_FRACTION = 0.0;

export class Map2DView {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.imageProvider = opts.imageProvider || (() => null);
    this.onViewChange = opts.onViewChange || (() => {});
    this.onHover = opts.onHover || (() => {});
    this.onLeave = opts.onLeave || (() => {});
    this.cx = 0.5;
    this.cy = 0.5;
    this.zoom = 1;               // 1 = whole map fits the canvas width
    this.minZoom = 0.5;
    this.maxZoom = 16;
    this.wrapHorizontally = true;
    this.dragging = null;
    this.dirty = true;
    this.hover = null;
    this.brushRadiusDeg = 0;
    this.overlayImage = null;
    this.overlayAlpha = 0.72;
    this.gridLines = false;
    /**
     * Interaction style.
     *  - `panModifierOnly` (paint surfaces): a plain drag is handed to
     *    `onStroke`, and Ctrl/Alt/Shift (or the middle button) pans instead.
     *  - `wheelMode: 'radius'` gives the plain wheel to `onRadiusWheel` and
     *    leaves zoom to Ctrl/Alt+wheel, so changing the brush never yanks the map.
     */
    this.panModifierOnly = opts.panModifierOnly === true;
    this.wheelMode = opts.wheelMode || 'zoom';
    this.onStroke = opts.onStroke || null;          // (phase, geo, event)
    this.onRadiusWheel = opts.onRadiusWheel || null;
    this.modifier = false;
    this.stroke = null;
    this._bind();
    this._watchModifiers();
  }

  /** True while a pan modifier (Ctrl/Alt/Shift) is held. */
  _mods(e) { return !!(e && (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)); }

  _setCursor(grabbing) {
    const cv = this.canvas;
    if (grabbing) cv.style.cursor = 'grabbing';
    else if (this.modifier) cv.style.cursor = 'grab';
    else if (this.panModifierOnly) cv.style.cursor = 'crosshair';
    else cv.style.cursor = 'grab';
  }

  /** Keep the cursor in step with the modifier keys, even without the pointer down. */
  _watchModifiers() {
    const update = (e) => {
      const mod = !!(e.ctrlKey || e.altKey || e.shiftKey || e.metaKey);
      if (mod === this.modifier) return;
      this.modifier = mod;
      this._setCursor(false);
      this.invalidate();          // the brush ring hides while panning is armed
    };
    window.addEventListener('keydown', update);
    window.addEventListener('keyup', update);
    window.addEventListener('blur', () => { if (this.modifier) { this.modifier = false; this._setCursor(false); this.invalidate(); } });
  }

  _bind() {
    const cv = this.canvas;
    const capture = (e) => { try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic events */ } };
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      const pan = e.button === 1 || !this.panModifierOnly || this._mods(e);
      capture(e);
      if (pan) {
        this.dragging = { x: e.clientX, y: e.clientY };
        this._setCursor(true);
      } else {
        this.stroke = this.screenToLatLon(e.clientX, e.clientY);
        if (this.stroke && this.onStroke) this.onStroke('start', this.stroke, e);
      }
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      const geo = this.screenToLatLon(e.clientX, e.clientY);
      this.hover = geo;
      this.onHover(geo, e);
      if (this.dragging) {
        const dx = e.clientX - this.dragging.x;
        const dy = e.clientY - this.dragging.y;
        this.dragging = { x: e.clientX, y: e.clientY };
        this.panBy(dx, dy);
        return;
      }
      if (this.stroke) {
        this.stroke = geo;
        if (geo && this.onStroke) this.onStroke('move', geo, e);
      }
      this.dirty = true;          // the brush ring follows the pointer
    });
    const end = (e) => {
      if (this.stroke && this.onStroke) this.onStroke('end', this.stroke, e);
      this.stroke = null;
      if (!this.dragging) return;
      this.dragging = null;
      this._setCursor(false);
      try { cv.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { this.hover = null; this.onLeave(); this.dirty = true; });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.wheelMode === 'radius' && !this._mods(e) && this.onRadiusWheel) {
        this.onRadiusWheel(e);
        return;
      }
      const rect = cv.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / Math.max(1, rect.width);
      const fy = (e.clientY - rect.top) / Math.max(1, rect.height);
      this.zoomAt(fx, fy, e.deltaY > 0 ? 1 / 1.18 : 1.18);
    }, { passive: false });
    this._setCursor(false);
  }

  /* ---------------- geometry ---------------- */

  /** Horizontal span of the map visible, as a fraction of the map width. */
  get spanX() { return 1 / Math.max(0.001, this.zoom); }

  /** Pixel size of the map image inferred from the provider. */
  canvasSize() {
    const img = this.imageProvider();
    return { w: img ? img.width : 2, h: img ? img.height : 1 };
  }

  /**
   * Vertical fraction visible. Derived from the viewport aspect ratio and the
   * zoom so that a "whole world" view (zoom = 1) shows all 180 degrees of
   * latitude across the canvas height.
   */
  getSpanY(rect) {
    const r = rect || this.canvas.getBoundingClientRect();
    const rectW = Math.max(1, r.width || this.canvas.clientWidth || 1);
    const rectH = Math.max(1, r.height || this.canvas.clientHeight || 1);
    const size = this.canvasSize();
    const mapAspect = size.w / Math.max(1, size.h);      // 2 for equirectangular
    const visH = this.spanX * (rectH / rectW) * mapAspect;
    return Math.min(1.6, visH);
  }

  panBy(dxPx, dyPx) {
    const rect = this.canvas.getBoundingClientRect();
    const rectW = Math.max(1, rect.width);
    const rectH = Math.max(1, rect.height);
    this.cx -= (dxPx / rectW) * this.spanX;
    this.cy -= (dyPx / rectH) * this.getSpanY(rect);
    this._clampView();
    this.invalidate();
  }

  /** Keyboard panning (arrow keys). */
  arrow(dx, dy, big) {
    const step = big ? 0.25 : 0.08;
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(2, rect.width || this.canvas.clientWidth || 640);
    const h = Math.max(2, rect.height || this.canvas.clientHeight || 320);
    this.panBy(dx * step * w, dy * step * h);
  }

  zoomAt(fx, fy, factor) {
    const before = this.screenToLatLonFraction(fx, fy);
    const next = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
    if (next === this.zoom) return;
    this.zoom = next;
    // keep the point under the cursor fixed
    const rect = this.canvas.getBoundingClientRect();
    const after = this.screenToLatLonFraction(fx, fy);
    this.cx += before.fx - after.fx;
    this.cy += before.fy - after.fy;
    this._clampView();
    this.invalidate();
  }

  zoomBy(factor) { this.zoomAt(0.5, 0.5, factor); }

  _clampView() {
    const rect = this.canvas.getBoundingClientRect();
    if (this.wrapHorizontally) {
      this.cx = ((this.cx % 1) + 1) % 1;
    } else {
      const half = Math.min(0.5, this.spanX / 2);
      this.cx = Math.max(half, Math.min(1 - half, this.cx));
    }
    // Vertically the whole map must stay reachable: when the viewport shows more
    // than the map (zoomed out) lock to the centre, otherwise keep the visible
    // span inside [0, 1]. The previous expression collapsed to a constant 0.5,
    // which silently disabled vertical panning entirely.
    // getSpanY is called with an explicit rect: while the canvas is hidden its
    // clientHeight is 0, which would report a degenerate span.
    const spanY = this.getSpanY(rect);
    if (spanY >= 1) this.cy = 0.5;
    else this.cy = Math.max(spanY / 2, Math.min(1 - spanY / 2, this.cy));
  }

  centerOn(fractionX, fractionY) {
    this.cx = fractionX;
    this.cy = Math.max(0, Math.min(1, fractionY));
    this._clampView();
    this.invalidate();
  }

  reset() {
    this.zoom = 1;
    this.cx = 0.5;
    this.cy = 0.5;
    this.invalidate();
  }

  /* ---------------- coordinate conversion ---------------- */

  /** Canvas-relative fractions (0..1) -> map fractions. */
  screenToLatLonFraction(fx, fy) {
    const rect = this.canvas.getBoundingClientRect();
    const spanX = this.spanX;
    const spanY = this.getSpanY(rect);
    return {
      fx: this.cx + (fx - 0.5) * spanX,
      fy: this.cy + (fy - 0.5) * spanY,
    };
  }

  /** Client pixel coordinates -> { lat, lon }. */
  screenToLatLon(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const fx = (clientX - rect.left) / rect.width;
    const fy = (clientY - rect.top) / rect.height;
    const map = this.screenToLatLonFraction(fx, fy);
    let lon = map.fx * 360 - 180;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    const lat = Math.max(-90, Math.min(90, 90 - map.fy * 180));
    return { lat, lon };
  }

  /** { lat, lon } -> client pixel coordinates (may be outside the viewport). */
  latLonToScreen(lat, lon) {
    const rect = this.canvas.getBoundingClientRect();
    const spanX = this.spanX;
    const spanY = this.getSpanY(rect);
    const mapFx = (lon + 180) / 360;
    const mapFy = (90 - lat) / 180;
    let fx = (mapFx - (this.cx - spanX / 2)) / spanX;
    // When the map wraps, several copies are on screen; pick the one whose centre
    // is nearest the viewport centre. When it does not wrap there is only one copy
    // and shifting would move the point to the wrong side of the canvas — which is
    // exactly what made the editor's brush ring trail the pointer.
    if (this.wrapHorizontally) fx += Math.round(0.5 - fx);
    const fy = (mapFy - (this.cy - spanY / 2)) / spanY;
    return {
      x: rect.left + fx * rect.width,
      y: rect.top + fy * rect.height,
      onScreen: fx >= -0.02 && fx <= 1.02 && fy >= -0.02 && fy <= 1.02,
    };
  }

  /* ---------------- rendering ---------------- */

  invalidate() { this.dirty = true; }

  setOverlay(image, alpha) {
    this.overlayImage = image;
    if (alpha !== undefined) this.overlayAlpha = alpha;
    this.invalidate();
  }

  render(force) {
    if (!this.dirty && !force) return;
    const cv = this.canvas;
    const img = this.imageProvider();
    if (!img) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = Math.max(2, cv.clientWidth);
    const cssH = Math.max(2, cv.clientHeight);
    const w = Math.floor(cssW * dpr);
    const h = Math.floor(cssH * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    // background grid so the empty area reads as "outside the map"
    ctx.fillStyle = '#0a0e13';
    ctx.fillRect(0, 0, cssW, cssH);

    const rect = cv.getBoundingClientRect();
    const spanX = this.spanX;
    const spanY = this.getSpanY(rect);
    const destW = cssW / spanX;
    const destH = cssH / spanY;

    // left edge of the map in screen coordinates (may be negative)
    let originX = cssW / 2 - this.cx * destW;
    const originY = cssH / 2 - this.cy * destH;

    const drawOne = (ox) => {
      // Snap to whole pixels and overlap by one: adjacent copies placed at
      // fractional x leave a sub-pixel gap that reads as a bright seam as soon as
      // the map is panned — the "拼接痕迹" this used to show.
      const x0 = Math.round(ox);
      const w0 = Math.round(destW) + 2;
      ctx.imageSmoothingEnabled = this.zoom < 6;
      ctx.drawImage(img, x0, originY, w0, destH);
      if (this.overlayImage) {
        ctx.globalAlpha = this.overlayAlpha;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.overlayImage, x0, originY, w0, destH);
        ctx.globalAlpha = 1;
      }
    };

    // draw enough copies to cover the viewport, wrapping in x
    if (this.wrapHorizontally) {
      const first = Math.floor(-originX / destW) - 1;
      const last = Math.ceil((cssW - originX) / destW) + 1;
      for (let k = first; k <= last; k++) drawOne(originX + k * destW);
    } else {
      drawOne(originX);
    }

    // graticule
    if (this.gridLines) {
      ctx.strokeStyle = 'rgba(120,150,180,0.20)';
      ctx.lineWidth = 1;
      const mapToScreenX = (fx) => originX + fx * destW;
      const mapToScreenY = (fy) => originY + fy * destH;
      for (let lon = -180; lon <= 180; lon += 30) {
        const x = Math.round(mapToScreenX((lon + 180) / 360)) + 0.5;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssH); ctx.stroke();
      }
      for (let lat = -90; lat <= 90; lat += 30) {
        const y = Math.round(mapToScreenY((90 - lat) / 180)) + 0.5;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cssW, y); ctx.stroke();
      }
    }

    // brush cursor — drawn in screen space so the ring always sits exactly under
    // the pointer (the image itself never carries a baked-in ring)
    if (this.brushRadiusDeg && this.hover && !this.modifier) {
      const p = this.latLonToScreen(this.hover.lat, this.hover.lon);
      const pxPerDeg = (destW / 360);
      const r = Math.max(3, this.brushRadiusDeg * pxPerDeg);
      ctx.strokeStyle = 'rgba(205,222,238,0.80)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(p.x - rect.left, p.y - rect.top, r, r * 0.75, 0, 0, Math.PI * 2);
      ctx.stroke();
      // centre dot so the exact paint point is unambiguous
      ctx.fillStyle = 'rgba(205,222,238,0.85)';
      ctx.beginPath();
      ctx.arc(p.x - rect.left, p.y - rect.top, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    this.dirty = false;
    this.onViewChange(this);
  }

  /** Human-readable view state for a HUD readout. */
  describe() {
    const rect = this.canvas.getBoundingClientRect();
    const spanX = this.spanX;
    const spanY = this.getSpanY(rect);
    const lonW = this.cx * 360 - 180;
    const latN = 90 - (this.cy - spanY / 2) * 180;
    const latS = 90 - (this.cy + spanY / 2) * 180;
    return {
      zoom: this.zoom,
      centerLat: 90 - this.cy * 180,
      centerLon: lonW,
      spanLon: spanX * 360,
      latRange: [Math.max(-90, latS), Math.min(90, latN)],
    };
  }
}

export function poleToCenter(lat) {
  return Math.max(MIN_PAN_FRACTION, Math.min(1, (90 - lat) / 180));
}
