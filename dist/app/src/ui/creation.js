/**
 * Planet creation wizard + terrain editor modal.
 *
 * Two creation paths, exactly as specified:
 *   系统生成 — the system fills in an Earth-like planet, the user may then edit
 *   完全手动 — everything, including the heightfield, is authored by hand
 *
 * The terrain step always offers three routes: procedural generation driven only
 * by "板块破碎程度", fully manual painting (raise / lower / smooth / flatten), or
 * generate-then-edit — which is just the two combined.
 */

import { PARAMS, PARAM_MAP, defaults, coerce } from '../state/params.js';
import { PRESETS, PRESET_MAP } from '../state/presets.js';
import { state, newSeed } from '../state/state.js';
import { emit } from '../core/bus.js';
import { el, buildKnob } from './widgets.js';
import {
  generateTerrain, computeRivers, updateWaterMask, applyOceanTarget,
  invertLandSea, fillAll, blurWrap, oceanFractionBelow, terrainFromObject, terrainToObject,
  heightAt,
} from '../world/terrain.js';
import { GRID_PRESETS, GRID_MIN, GRID_MAX, gridDimsFor, climateSizeFor, nearestPreset, gridCostHint } from '../world/gridSizes.js';
import { TerrainCanvas } from './terrainCanvas.js';
import { Map2DView } from '../render/map2d.js';
import { VectorOverlay } from '../render/overlay2d.js';
import { GlobeView } from '../render/globe.js';
import { LAYERS, LAYER_ORDER, rampLut } from '../core/colors.js';
import { clamp } from '../core/noise.js';

/* ================================================================== */
/* grid size helpers                                                  */
/* ================================================================== */

/* gridDimsFor / nearestPreset / climateSizeFor are imported from
   world/gridSizes.js so the wizard and the terrain editor share them. */

/** Build the base-colour RGBA buffer for a terrain grid (used by the 3D preview). */
export function terrainBaseTexture(grid, opts = {}) {
  const { GX, GY, height: H, waterMask, river } = grid;
  const out = new Uint8Array(GX * GY * 4);
  const oceanColor = opts.oceanColor || [44, 74, 102];
  const deep = [14, 30, 47];
  const shelf = [48, 84, 112];
  const lower = [104, 122, 92];
  const mid = [138, 132, 108];
  const high = [168, 160, 142];
  const peak = [216, 218, 214];
  const riverC = [96, 138, 158];
  const mixv = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  for (let j = 0; j < GY; j++) {
    for (let i = 0; i < GX; i++) {
      const k = i + j * GX;
      const h = H[k];
      const isWater = waterMask ? waterMask[k] : h < 0;
      let c;
      if (isWater) {
        const depth = clamp(-h / 5500, 0, 1);
        c = mixv(shelf, deep, Math.pow(depth, 0.6));
        c = mixv(oceanColor, c, clamp(depth * 3, 0, 1));
      } else {
        const land = clamp(h / 3800, 0, 1.4);
        c = land < 0.22 ? mixv(lower, mid, land / 0.22)
          : land < 0.6 ? mixv(mid, high, (land - 0.22) / 0.38)
            : mixv(high, peak, clamp((land - 0.6) / 0.7, 0, 1));
        const iE = i + 1 < GX ? k + 1 : k;
        const jS = j + 1 < GY ? k + GX : k;
        const sh = 1 + clamp(-((H[iE] - H[k]) / 800) * 0.9 - ((H[jS] - H[k]) / 800) * 0.7, -0.45, 0.45);
        c = [c[0] * sh, c[1] * sh, c[2] * sh];
      }
      if (river && river[k] > 0.02 && !isWater) c = mixv(c, riverC, Math.min(0.7, river[k] * 1.3));
      const o = k * 4;
      out[o] = clamp(c[0], 0, 255);
      out[o + 1] = clamp(c[1], 0, 255);
      out[o + 2] = clamp(c[2], 0, 255);
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Build a colormapped RGBA overlay for the 3D preview from a scalar field. */
export function scalarOverlayTexture(data, lut, min, max) {
  const out = new Uint8Array(data.length * 4);
  const span = Math.max(1e-6, max - min);
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    const o = i * 4;
    if (!isFinite(v)) { out[o + 3] = 0; continue; }
    const t = clamp((v - min) / span, 0, 1);
    const li = Math.min(255, Math.round(t * 255)) * 3;
    out[o] = lut[li];
    out[o + 1] = lut[li + 1];
    out[o + 2] = lut[li + 2];
    out[o + 3] = 255;
  }
  return out;
}

/* ================================================================== */
/* shared terrain tool state                                          */
/* ================================================================== */

class TerrainToolkit {
  constructor(opts) {
    this.canvasEl = opts.canvas;
    this.globeCanvas = opts.globeCanvas || null;
    this.onChange = opts.onChange || (() => {});
    this.grid = opts.grid || generateTerrain({ seed: 20240, plateCount: 14, fragmentation: 45 });
    if (!this.grid.river) this.grid.river = new Float32Array(this.grid.GX * this.grid.GY);
    updateWaterMask(this.grid);
    this.globe = null;
    this.view = new Map2DView(this.canvasEl, {
      imageProvider: () => this.tview.previewImage(),
      onViewChange: () => this.updateViewInfo(),
      onHover: (geo, e) => {
        if (this.tview) this.tview.setHover(geo);
        this.setHover(geo, e && typeof e.clientX === 'number' ? { x: e.clientX, y: e.clientY } : null);
      },
      onLeave: () => { if (this.tview) this.tview.setHover(null); this.setHover(null); },
      // plain drag paints, Ctrl/Alt/Shift (or the middle button) pans, the plain
      // wheel changes the brush radius and only Ctrl/Alt+wheel zooms
      panModifierOnly: true,
      wheelMode: 'radius',
      onStroke: (phase, geo) => this._onStroke(phase, geo),
      onRadiusWheel: (e) => this.adjustRadius(e.deltaY > 0 ? 0.9 : 1.1),
    });
    this.view.wrapHorizontally = false;
    this.view.brushRadiusDeg = 12;
    this.tview = new TerrainCanvas(this.canvasEl, {
      delegated: true,                     // the Map2DView owns the pointer here
      getGrid: () => this.grid,
      onChange: (info) => {
        if (info && info.radius !== undefined) this.onChange({ radius: info.radius });
        this.updateStats();
        if (info && info.painting) this.refreshPreview(true);
        if (info && info.committed) this.refreshPreview(true);
        this.onChange(this.grid);
      },
    });
    this.tview.view = this.view;
    this.tview.radius = 12;
    this.tview.brushHeight = 600;
    this.tview.strength = 0.6;
    this.tview.previewProvider = (layerKey) => this._layerPreview(layerKey);
    // the ring the map draws must start out matching the brush
    this.view.brushRadiusDeg = this.tview.radius;
    this.hoverEl = opts.hoverEl || null;
    this._hoverGeo = null;
    this._hoverClient = null;
    this._modifier = false;
    this.bindHoverKeys();
  }

  /* ---------------- painting (driven by the map view) ---------------- */

  /**
   * Stroke events come from the Map2DView, which owns the pointer on the shared
   * canvas. Keeping painting here (rather than in TerrainCanvas) means the flat
   * map, the brush ring and the pan/zoom state can never disagree about where the
   * pointer is.
   */
  _onStroke(phase, geo) {
    if (!geo) return;
    const lon = ((geo.lon + 180) % 360 + 360) % 360 - 180;
    if (phase === 'end') {
      this.tview.painting = false;
      this.tview.brush = null;
      this.refreshPreview(true);
      this.onChange({ committed: true });
      return;
    }
    this.tview.painting = true;
    this.tview.stroke({ lat: geo.lat, lon });
  }

  /** Wheel over the map: resize the brush and keep any bound slider in step. */
  adjustRadius(factor) {
    this.setRadius(clamp(this.tview.radius * factor, 1, 60));
  }

  /** One place that owns the brush radius, so the ring can never lag the brush. */
  setRadius(r) {
    const v = clamp(Number(r) || 1, 1, 60);
    this.tview.radius = v;
    this.view.brushRadiusDeg = v;
    if (this.tview.brush) this.tview.brush.radiusDeg = v;
    this.view.invalidate();
    this.onChange({ radius: v });
    return v;
  }

  /* ---------------- preview pipeline ---------------- */

  /** Rebuild the flat preview bitmap from the current grid (and layer). */
  refreshPreview(immediate) {
    void immediate;
    this.tview.needsRender = true;
    if (this.view) this.view.invalidate();
  }

  _layerPreview(layerKey) {
    const world = this.world;
    if (!world || !LAYERS[layerKey] || !LAYERS[layerKey].ramp) return null;
    const data = world.layerData(layerKey);
    const range = world.layerRange(layerKey);
    if (!this._lut || this._lutKey !== layerKey) {
      this._lut = rampLut(LAYERS[layerKey].ramp, 256);
      this._lutKey = layerKey;
    }
    return { data, min: range.min, max: range.max, lut: this._lut };
  }

  /* ---------------- 3D preview ---------------- */

  ensureGlobe() {
    if (this.globe) return this.globe;
    if (!this.globeCanvas) return null;
    this.globe = new GlobeView(this.globeCanvas);
    if (!this.globe.ok) return null;
    this.globe.setState({ overlay: 'none', base: 'surface', atmosphere: true, graticule: false });
    // The editor's preview is a *shape* reference, not a planet portrait: a day /
    // night terminator would just hide half of the terrain being sculpted.
    this.globe.sun.shadow = false;
    return this.globe;
  }

  refreshGlobe() {
    const g = this.ensureGlobe();
    if (!g || !g.ok) return;
    const rgba = terrainBaseTexture(this.grid, { oceanColor: [44, 74, 102] });
    g.uploadBase(rgba, this.grid.GX, this.grid.GY);
  }

  renderGlobe(dt) {
    const g = this.ensureGlobe();
    if (!g || !g.ok) return;
    g.resize();
    g.render(dt || 0);
  }

  /* ---------------- grid ---------------- */

  setGrid(grid) {
    this.grid = grid;
    if (!this.grid.river) this.grid.river = new Float32Array(this.grid.GX * this.grid.GY);
    updateWaterMask(this.grid);
    this.updateStats();
    this.tview.brush = null;
    this.refreshPreview(true);
    this.refreshGlobe();
  }

  regenerate(preset) {
    const p = { ...defaults(), ...(preset || {}) };
    const dims = preset && preset.gridCount ? gridDimsFor(preset.gridCount) : { gx: preset?.gridX, gy: preset?.gridY };
    const grid = generateTerrain({
      GX: dims.gx || 360,
      GY: dims.gy || 180,
      seed: p.seed,
      plateCount: p.plateCount,
      fragmentation: p.fragmentation,
      relief: p.relief,
      seaFloorRelief: p.seaFloorRelief,
      oceanTarget: clamp((p.oceanFraction ?? 70.8) / 100, 0.001, 0.999),
    });
    this.setGrid(grid);
    this.recomputeRivers();
  }

  recomputeRivers() {
    const r = computeRivers(this.grid);
    this.grid.river = r.intensity;
    this.refreshPreview(true);
    this.refreshGlobe();
    this.updateStats();
  }

  measureOcean() { return oceanFractionBelow(this.grid.height, 0); }
  updateStats() {
    if (!this.statsEl) return;
    const H = this.grid.height;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < H.length; i++) { if (H[i] < lo) lo = H[i]; if (H[i] > hi) hi = H[i]; }
    const ocean = this.measureOcean() * 100;
    this.statsEl.innerHTML =
      `海洋 ${ocean.toFixed(1)}% · 陆地 ${(100 - ocean).toFixed(1)}%<br>` +
      `最低 ${Math.round(lo)} m · 最高 ${Math.round(hi)} m<br>` +
      `网格 ${this.grid.GX}×${this.grid.GY}（${(this.grid.GX * this.grid.GY).toLocaleString('en-US')} 格）`;
  }

  updateViewInfo() {
    if (!this.viewInfoEl) return;
    const d = this.view.describe();
    this.viewInfoEl.textContent =
      `${d.spanLon.toFixed(0)}° × ${Math.max(0, d.latRange[1] - d.latRange[0]).toFixed(0)}° · ` +
      `中心 ${d.centerLat.toFixed(0)}°, ${d.centerLon.toFixed(0)}°`;
  }

  /* ---------------- hover height read-out ---------------- */

  /**
   * Show the terrain height under the pointer while a modifier key is held.
   *
   * The spec for the editor is that Ctrl turns the cursor into a "glove" that pans
   * instead of painting; while it is down there is nothing to paint, so the same
   * gesture doubles as a probe and reports the height at that exact point. Alt and
   * Shift behave the same way because they are the other pan modifiers.
   *
   * It works in both view modes: the flat map reports hover through Map2DView's
   * onHover, the 3D preview through `globe.pick`, and both funnel into setHover.
   */
  setHover(geo, client) {
    this._hoverGeo = geo || null;
    if (client) this._hoverClient = client;
    this.renderHover();
  }

  setModifier(down) {
    const next = !!down;
    if (this._modifier === next) return;
    this._modifier = next;
    this.renderHover();
  }

  /** Height at the hovered point, in metres relative to sea level. */
  hoverHeight() {
    const geo = this._hoverGeo;
    if (!geo || !this.grid) return null;
    const lon = ((geo.lon + 180) % 360 + 360) % 360 - 180;
    const abs = heightAt(this.grid, geo.lat, lon);
    // `height` is measured against 0 = sea level; `waterLevel` is where the sea
    // surface currently sits, so the read-out matches what the user sees painted.
    const sea = this.grid.waterLevel || 0;
    return { lat: geo.lat, lon, abs, sea, rel: abs - sea };
  }

  renderHover() {
    const el2 = this.hoverEl;
    const info = this._modifier ? this.hoverHeight() : null;
    if (el2) {
      if (!info) {
        el2.classList.add('hidden');
      } else {
        const rel = Math.round(info.rel);
        const kind = rel >= 0 ? '陆上高度' : '水深';
        el2.innerHTML =
          `<span class="thh-val">${rel >= 0 ? '+' : ''}${rel.toLocaleString('en-US')} m</span>` +
          `<span class="thh-kind">${kind}</span>` +
          `<span class="thh-geo">${info.lat.toFixed(1)}°, ${info.lon.toFixed(1)}°</span>`;
        el2.classList.remove('hidden');
        const host = el2.parentElement;
        const box = host.getBoundingClientRect();
        const c = this._hoverClient;
        if (c) {
          const x = clamp(c.x - box.left + 16, 6, Math.max(6, box.width - 150));
          const y = clamp(c.y - box.top + 14, 6, Math.max(6, box.height - 46));
          el2.style.left = `${Math.round(x)}px`;
          el2.style.top = `${Math.round(y)}px`;
        }
      }
    }
    if (this.viewInfoEl) {
      if (info) {
        this.viewInfoEl.dataset.hover = '1';
        this.viewInfoEl.textContent =
          `${info.lat.toFixed(1)}°, ${info.lon.toFixed(1)}° · ` +
          `高度 ${info.rel >= 0 ? '+' : ''}${Math.round(info.rel).toLocaleString('en-US')} m`;
      } else if (this.viewInfoEl.dataset.hover) {
        delete this.viewInfoEl.dataset.hover;
        this.updateViewInfo();
      }
    }
  }

  /** Only listen while the editor is on screen (offsetParent is null when hidden). */
  editorVisible() {
    const cv = this.canvasEl;
    return !!(cv && (cv.offsetParent !== null || cv.getClientRects().length));
  }

  bindHoverKeys() {
    if (this._hoverKeysBound) return;
    this._hoverKeysBound = true;
    const sync = (e) => {
      if (!this.editorVisible()) return;
      this.setModifier(e.ctrlKey || e.altKey || e.shiftKey);
    };
    window.addEventListener('keydown', sync, true);
    window.addEventListener('keyup', sync, true);
    window.addEventListener('blur', () => this.setModifier(false));
  }

  setGridInfo(el2) { this.gridInfoEl = el2; }
}

/* ================================================================== */
/* reusable control group: slider + knob + numeric input              */
/* ================================================================== */

/**
 * Wire the draggable splitter that sets `--te-tools-w` on a `.te-body` grid, so
 * the left configuration column width is user-adjustable (double-click resets,
 * the width is remembered). Shared by the wizard and the terrain editor because
 * both use the same two-column layout.
 */
function bindColumnSplitter(body, split, onChange) {
  if (!body || !split) return;
  const MIN = 220, DEFAULT = 300;
  let width = DEFAULT;
  try { width = Number(localStorage.getItem('pcs.teToolsWidth')) || DEFAULT; } catch { /* ignore */ }
  const apply = (w) => {
    width = clamp(w, MIN, Math.max(MIN, window.innerWidth - 460));
    body.style.setProperty('--te-tools-w', `${width}px`);
    if (onChange) onChange();
  };
  apply(width);
  let dragging = false;
  split.addEventListener('pointerdown', (e) => {
    dragging = true;
    split.classList.add('dragging');
    try { split.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    e.preventDefault();
  });
  split.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    apply(e.clientX - body.getBoundingClientRect().left);
  });
  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    split.classList.remove('dragging');
    try { split.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    try { localStorage.setItem('pcs.teToolsWidth', String(Math.round(width))); } catch { /* ignore */ }
  };
  split.addEventListener('pointerup', stop);
  split.addEventListener('pointercancel', stop);
  split.addEventListener('dblclick', () => {
    apply(DEFAULT);
    try { localStorage.setItem('pcs.teToolsWidth', String(DEFAULT)); } catch { /* ignore */ }
  });
}

/**
 * Wire a slider, an optional knob and a number input to one value.
 * @returns {function} setValue(value, silent)
 */
function bindTriple(opts) {
  const { slider, knobHost, num, min, max, step, decimals, onChange, initial } = opts;
  let value = initial;
  const fmt = (v) => Number(v).toFixed(decimals);

  const knob = knobHost ? buildKnob(initial, min, max, 40) : null;
  if (knob && knobHost) {
    knobHost.textContent = '';
    knobHost.append(knob);
  }
  const setValue = (v, silent) => {
    value = Math.max(min, Math.min(max, Number(v) || 0));
    if (slider && document.activeElement !== slider) slider.value = String(value);
    if (num && document.activeElement !== num) num.value = fmt(value);
    if (knob) knob.setValue(value);
    if (!silent) onChange(value);
    return value;
  };
  if (slider) slider.addEventListener('input', () => setValue(Number(slider.value)));
  if (num) {
    num.addEventListener('change', () => setValue(Number(num.value)));
    num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { setValue(Number(num.value)); num.blur(); } });
  }
  if (knob) knob.addEventListener('knobchange', (e) => setValue(e.detail));
  setValue(initial, true);
  return { setValue, get value() { return value; } };
}

/* ================================================================== */
/* wizard                                                             */
/* ================================================================== */

const WIZ_STEPS = [
  { id: 1, title: '基本参数' },
  { id: 2, title: '大气与恒星' },
  { id: 3, title: '地形' },
  { id: 4, title: '模拟设定' },
];

const STEP1_KEYS = ['planeRadiusKm', 'gravity', 'axialTilt', 'rotationSpeed', 'orbitalSpeed', 'eccentricity'];
const STEP4_KEYS = ['stepMonths', 'totalMonths', 'autoStop', 'waterInventory', 'precipFactor', 'landHeatCapacity', 'oceanHeatCapacity', 'transport', 'iceFlow'];

export class CreationWizard {
  constructor(opts = {}) {
    this.modal = opts.modal;
    this.panesHost = opts.panes;
    this.stepBar = opts.steps;
    this.modeHost = opts.modes;
    this.onDone = opts.onDone || (() => {});
    this.mode = 'auto';
    this.step = 1;
    this.presetId = 'earth';
    this.values = { ...defaults() };
    this.gridCount = 64800;
    this.terrainTouched = false;
    this.toolkit = null;
    this.bind();
  }

  bind() {
    this.modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => this.close()));
    this.modeHost.addEventListener('click', (e) => {
      const modeBtn = e.target.closest('.wiz-mode');
      if (modeBtn) {
        this.mode = modeBtn.dataset.mode;
        for (const b of this.modeHost.querySelectorAll('.wiz-mode')) b.classList.toggle('active', b === modeBtn);
        this.refresh();
      }
    });
  }

  open(presetId, gridCount) {
    this.presetId = presetId || 'earth';
    const preset = PRESET_MAP[this.presetId] || PRESETS[0];
    this.values = { ...defaults(), ...(preset.params || {}) };
    if (preset.terrain) {
      for (const [k, v] of Object.entries(preset.terrain)) {
        if (k === 'oceanTarget') this.values.oceanFraction = v * 100;
        else if (PARAM_MAP[k]) this.values[k] = v;
      }
    }
    this.values.seed = preset.seed;
    this.gridCount = gridCount || 64800;
    this.step = 1;
    this.mode = 'auto';
    this.terrainTouched = false;
    this.toolkit = null;
    this._renderedStep = -1;
    // the overlay is shared by several modals, so open both it and this dialog
    this.modal.classList.remove('hidden');
    const overlay = this.modal.closest('.overlay');
    if (overlay) {
      for (const m of overlay.querySelectorAll('.modal')) {
        if (m !== this.modal) m.classList.add('hidden');
      }
      overlay.classList.remove('hidden');
    }
    for (const b of this.modeHost.querySelectorAll('.wiz-mode')) {
      b.classList.toggle('active', b.dataset.mode === 'auto');
    }
    this.render();
  }

  close() {
    this.modal.classList.add('hidden');
    this.modal.closest('.overlay')?.classList.add('hidden');
  }

  setStep(n) {
    this.step = clamp(n, 1, WIZ_STEPS.length);
    this.render();
  }

  renderBar() {
    this.stepBar.textContent = '';
    for (const s of WIZ_STEPS) {
      const node = el('span', {
        class: 'wstep' + (s.id === this.step ? ' active' : s.id < this.step ? ' done' : ''),
        text: `${s.id} ${s.title}`,
      });
      node.addEventListener('click', () => this.setStep(s.id));
      this.stepBar.append(node);
    }
    const back = this.modal.querySelector('#wizBack');
    const next = this.modal.querySelector('#wizNext');
    const create = this.modal.querySelector('#wizCreate');
    if (back) back.disabled = this.step === 1;
    if (next) next.classList.toggle('hidden', this.step === WIZ_STEPS.length);
    if (create) create.classList.toggle('hidden', this.step !== WIZ_STEPS.length);
  }

  render() {
    this.renderBar();
    const pane = this.panesHost.querySelector('.wiz-pane');
    const stepChanged = this._renderedStep !== this.step;
    const paneGone = !pane || !pane.isConnected;
    const canvasGone = this.step === 3 && !this.panesHost.querySelector('#wizTerrain');
    if (!stepChanged && !paneGone && !canvasGone) return;

    this.panesHost.textContent = '';
    if (this.step === 3) this.toolkit = null;   // bound to the old canvas
    this._renderedStep = this.step;
    const host = el('div', { class: 'wiz-pane active' });
    this.panesHost.append(host);
    if (this.step === 1) this.renderStep1(host);
    else if (this.step === 2) this.renderStep2(host);
    else if (this.step === 3) this.renderStep3(host);
    else this.renderStep4(host);
  }

  refresh() {
    this._renderedStep = -1;
    this.toolkit = null;
    this.render();
  }

  field(host, key, opts = {}) {
    const def = PARAM_MAP[key];
    if (!def) return;
    const out = el('output', { class: 'mono' });
    const input = el('input', {
      type: 'range', min: String(def.min), max: String(def.max),
      step: String(opts.step ?? def.step), value: String(this.values[key]),
    });
    const fmt = () => {
      const dec = def.dec ?? 2;
      out.textContent = `${Number(this.values[key]).toFixed(dec)}${def.unit ? ' ' + def.unit : ''}`;
    };
    fmt();
    input.addEventListener('input', () => {
      this.values[key] = Number(input.value);
      fmt();
      if (opts.onChange) opts.onChange(this.values[key]);
    });
    const num = el('input', {
      type: 'number', class: 'num', min: String(def.min), max: String(def.max),
      step: String(def.step), value: String(this.values[key]),
    });
    num.addEventListener('change', () => {
      this.values[key] = coerce(key, Number(num.value));
      input.value = String(this.values[key]);
      fmt();
      if (opts.onChange) opts.onChange(this.values[key]);
    });
    const wrap = el('div', { class: 'field', style: 'grid-template-columns:150px 1fr 92px' }, [
      el('span', { text: def.label + (def.unit ? ` (${def.unit})` : '') }),
      input,
      out,
    ]);
    host.append(wrap);
    if (def.help) {
      host.append(el('div', { class: 'field', style: 'grid-template-columns:150px 1fr 92px' }, [
        el('span', { class: 'muted tiny', text: def.help }),
        num,
        el('span'),
      ]));
    } else {
      wrap.append(num);
    }
  }

  renderStep1(pane) {
    pane.append(el('p', { class: 'tiny muted', text: '行星的物理本体。半径与重力互相推导（等密度近似），也可手动锁定其中一个。' }));
    const grid = el('div', { class: 'wiz-grid' });
    pane.append(grid);
    const left = el('div');
    const right = el('div');
    grid.append(left, right);
    for (const k of STEP1_KEYS.slice(0, 3)) this.field(left, k);
    for (const k of STEP1_KEYS.slice(3)) this.field(right, k);
    const nameInput = el('input', { class: 'txt', value: this.values.name || '新世界', id: 'wizName' });
    pane.append(el('div', { class: 'full field', style: 'grid-template-columns:150px 1fr' }, [
      el('span', { text: '星球名称' }), nameInput,
    ]));
    const seedInput = el('input', { class: 'num', type: 'number', value: String(this.values.seed), id: 'wizSeed' });
    const reseed = el('button', { class: 'ctl-btn', text: '换一个' });
    reseed.addEventListener('click', () => {
      this.values.seed = newSeed();
      seedInput.value = String(this.values.seed);
      if (this.toolkit) { this.toolkit.regenerate(this.values); this.toolkit.recomputeRivers(); }
    });
    pane.append(el('div', { class: 'full field', style: 'grid-template-columns:150px 1fr 92px' }, [
      el('span', { text: '行星随机种子' }), seedInput, reseed,
    ]));

    // grid resolution preview (the authoritative chooser is shown when a preset
    // is picked from the preset list; here you can still override it)
    const dims = gridDimsFor(this.gridCount);
    const cl = climateSizeFor(dims.gx, dims.gy);
    pane.append(el('div', { class: 'full tiny muted', html:
      `网格精度：<span class="mono strong">${dims.gx} × ${dims.gy}</span>（${dims.count.toLocaleString('en-US')} 格）· ` +
      `气候求解 <span class="mono">${cl.NB} × ${cl.NL}</span>　—　在第 3 步或地形编辑器中可调整` }));
    pane.append(el('p', {
      class: 'tiny muted',
      text: this.mode === 'auto'
        ? '系统生成模式：其余参数已按地球基准自动填好，可直接下一步。'
        : '完全手动模式：请逐项设定，第三步可自行绘制地形。',
    }));
  }

  renderStep2(pane) {
    const grid = el('div', { class: 'wiz-grid' });
    const left = el('div');
    const right = el('div');
    grid.append(left, right);
    pane.append(grid);
    left.append(el('h3', { class: 'card-title', text: '恒星' }));
    this.field(left, 'irradiance');
    this.field(left, 'starTemp');
    right.append(el('h3', { class: 'card-title', text: '大气成分' }));
    for (const k of ['pressure', 'o2', 'n2', 'co2', 'ch4', 'n2o', 'otherGas', 'humidity', 'cloud', 'aerosolLoad']) {
      this.field(right, k);
    }
    pane.append(el('p', { class: 'tiny muted', text: '干空气四组分（O₂ / N₂ / CO₂ / 其它）之和应接近 100%，创建时会自动配平氮气。' }));
  }

  renderStep3(pane) {
    const wrap = el('div', { class: 'te-body' });
    const tools = el('div', { class: 'te-tools' });

    /* generation group */
    const gen = el('div', { class: 'te-group' });
    gen.append(el('div', { class: 'te-label', text: '系统生成（仅需设定破碎程度）' }));
    const fragOut = el('output', { class: 'mono', text: String(this.values.fragmentation) });
    const frag = el('input', { type: 'range', class: 'rng long', min: '0', max: '100', step: '1', value: String(this.values.fragmentation) });
    frag.addEventListener('input', () => { this.values.fragmentation = Number(frag.value); fragOut.textContent = frag.value; });
    gen.append(el('div', { class: 'field' }, [el('span', { text: '板块破碎程度' }), frag, fragOut]));
    const plateOut = el('output', { class: 'mono', text: String(this.values.plateCount) });
    const plate = el('input', { type: 'range', class: 'rng long', min: '3', max: '40', step: '1', value: String(this.values.plateCount) });
    plate.addEventListener('input', () => { this.values.plateCount = Number(plate.value); plateOut.textContent = plate.value; });
    gen.append(el('div', { class: 'field' }, [el('span', { text: '板块数量' }), plate, plateOut]));
    const reliefOut = el('output', { class: 'mono', text: String(this.values.relief) });
    const relief = el('input', { type: 'range', class: 'rng long', min: '0', max: '100', step: '1', value: String(this.values.relief) });
    relief.addEventListener('input', () => { this.values.relief = Number(relief.value); reliefOut.textContent = relief.value; });
    gen.append(el('div', { class: 'field' }, [el('span', { text: '大陆起伏' }), relief, reliefOut]));
    const oceanOut = el('output', { class: 'mono', text: `${this.values.oceanFraction.toFixed(0)}%` });
    const ocean = el('input', { type: 'range', class: 'rng long', min: '1', max: '99', step: '1', value: String(this.values.oceanFraction) });
    ocean.addEventListener('input', () => { this.values.oceanFraction = Number(ocean.value); oceanOut.textContent = ocean.value + '%'; });
    gen.append(el('div', { class: 'field' }, [el('span', { text: '目标海洋占比' }), ocean, oceanOut]));
    const genBtn = el('button', { class: 'ctl-btn primary', text: '生成地形' });
    const reseed = el('button', { class: 'ctl-btn', text: '换种子' });
    gen.append(el('div', { class: 'te-row' }, [genBtn, reseed]));
    tools.append(gen);

    /* painting group */
    const paint = el('div', { class: 'te-group' });
    paint.append(el('div', { class: 'te-label', text: '手动绘制' }));
    const seg = el('div', { class: 'seg te-tool-seg' });
    for (const [tool, label] of [['raise', '增高'], ['lower', '降低'], ['smooth', '平滑'], ['flatten', '压平']]) {
      seg.append(el('button', { class: 'seg-btn' + (tool === 'raise' ? ' active' : ''), text: label, 'data-tool': tool }));
    }
    paint.append(seg);
    const brush = el('input', { type: 'range', class: 'rng long', min: '1', max: '60', step: '0.5', value: '12' });
    const brushNum = el('input', { type: 'number', class: 'num', min: '1', max: '60', step: '0.5', value: '12' });
    paint.append(el('div', { class: 'ctl-line' }, [
      el('span', { class: 'ctl-line-label', text: '笔刷半径' }), brush, brushNum, el('span', { class: 'ctl-unit', text: '°' }),
    ]));
    const amount = el('input', { type: 'range', class: 'rng long', min: '-4000', max: '4000', step: '10', value: '600' });
    const amountNum = el('input', { type: 'number', class: 'num', min: '-4000', max: '4000', step: '10', value: '600' });
    const amountLabel = el('span', { class: 'ctl-line-label', text: '改变高度' });
    paint.append(el('div', { class: 'ctl-line' }, [amountLabel, amount, amountNum, el('span', { class: 'ctl-unit', text: 'm' })]));
    const btnOcean = el('button', { class: 'ctl-btn', text: '全海洋' });
    const btnLand = el('button', { class: 'ctl-btn', text: '全陆地' });
    const btnInv = el('button', { class: 'ctl-btn', text: '海陆反转' });
    paint.append(el('div', { class: 'te-row' }, [btnOcean, btnLand, btnInv]));
    const btnSmooth = el('button', { class: 'ctl-btn', text: '整体平滑' });
    const btnRivers = el('button', { class: 'ctl-btn', text: '重算河流' });
    paint.append(el('div', { class: 'te-row' }, [btnSmooth, btnRivers]));
    tools.append(paint);

    /* grid group */
    const gridGroup = el('div', { class: 'te-group' });
    gridGroup.append(el('div', { class: 'te-label', text: '网格精度' }));
    const presetSel = el('select', { class: 'ctl-select wide' });
    for (const p of GRID_PRESETS) presetSel.append(el('option', { value: `${p.gx}x${p.gy}`, text: p.label }));
    gridGroup.append(el('label', { class: 'field', style: 'grid-template-columns:70px 1fr' }, [
      el('span', { text: '预设' }), presetSel,
    ]));
    const gridCountSlider = el('input', { type: 'range', class: 'rng long', min: '16200', max: '1036800', step: '900', value: String(this.gridCount) });
    const gridCountNum = el('input', { type: 'number', class: 'num', min: '16200', max: '1036800', step: '900', value: String(this.gridCount) });
    gridGroup.append(el('div', { class: 'ctl-line' }, [
      el('span', { class: 'ctl-line-label', text: '总网格数' }), gridCountSlider, el('span', { class: 'spacer' }), gridCountNum,
    ]));
    const regrid = el('button', { class: 'ctl-btn', text: '按此精度重新生成地形' });
    gridGroup.append(el('div', { class: 'te-row' }, [regrid]));
    const gridInfo = el('div', { class: 'tiny muted', text: '' });
    gridGroup.append(gridInfo);
    tools.append(gridGroup);

    /* stats group */
    const stats = el('div', { class: 'te-group' });
    stats.append(el('div', { class: 'te-label', text: '地形统计' }));
    const statsEl = el('div', { class: 'te-stats tiny mono', text: '—' });
    stats.append(statsEl);
    tools.append(stats);

    wrap.append(tools);
    const splitEl = el('div', { class: 'te-split', title: '拖动调整左侧配置栏宽度（双击复位）' });
    wrap.append(splitEl);
    bindColumnSplitter(wrap, splitEl, () => { if (this.toolkit) this.toolkit.view.invalidate(); });
    const canvasEl = el('canvas', { id: 'wizTerrain', width: '960', height: '480' });
    const viewInfo = el('div', { class: 'tiny mono muted', text: '—' });
    const canvasWrap = el('div', { class: 'te-canvas-wrap' }, [
      el('div', { class: 'te-view-bar' }, [
        el('span', { class: 'tiny muted', text: '左键涂抹绘制 · Ctrl/Alt/Shift+拖动平移 · 滚轮改笔刷半径 · Ctrl+滚轮缩放' }),
        el('span', { class: 'spacer' }),
        viewInfo,
      ]),
      el('div', { class: 'te-view-host' }, [canvasEl]),
    ]);
    wrap.append(canvasWrap);
    pane.append(wrap);

    // ---- bind the toolkit now that the canvas is in the document ----
    const dims = gridDimsFor(this.gridCount);
    this.toolkit = new TerrainToolkit({ canvas: canvasEl });
    this.toolkit.tview.limits = {
      radius: this.values.planeRadiusKm,
      gravity: this.values.gravity,
      minElevation: -13000,
      maxElevation: 13000,
    };
    this.toolkit.grid = generateTerrain({
      GX: dims.gx, GY: dims.gy,
      seed: this.values.seed,
      plateCount: this.values.plateCount,
      fragmentation: this.values.fragmentation,
      relief: this.values.relief,
      seaFloorRelief: this.values.seaFloorRelief,
      oceanTarget: clamp(this.values.oceanFraction / 100, 0.001, 0.999),
    });
    this.toolkit.statsEl = statsEl;
    this.toolkit.viewInfoEl = viewInfo;
    this.toolkit.recomputeRivers();
    this.toolkit.updateStats();
    this.toolkit.view.centerOn(0.5, 0.5);
    this.toolkit.refreshPreview(true);

    const syncGridCount = (count) => {
      const d = gridDimsFor(count);
      this.gridCount = d.count;
      gridCountSlider.value = String(d.count);
      if (document.activeElement !== gridCountNum) gridCountNum.value = String(d.count);
      const cl = climateSizeFor(d.gx, d.gy);
      gridInfo.innerHTML = `地形 <span class="mono strong">${d.gx} × ${d.gy}</span> = ${d.count.toLocaleString('en-US')} 格 · ` +
        `气候求解 <span class="mono">${cl.NB} × ${cl.NL}</span>`;
      const preset = nearestPreset(d.count);
      presetSel.value = `${preset.gx}x${preset.gy}`;
    };
    gridCountSlider.addEventListener('input', () => syncGridCount(Number(gridCountSlider.value)));
    gridCountNum.addEventListener('change', () => syncGridCount(Number(gridCountNum.value)));
    presetSel.addEventListener('change', () => {
      const [gx, gy] = presetSel.value.split('x').map(Number);
      syncGridCount(gx * gy);
    });
    regrid.addEventListener('click', () => {
      regrid.disabled = true;
      const label = regrid.textContent;
      regrid.textContent = '生成中…';
      setTimeout(() => {
        this.toolkit.regenerate({ ...this.values, gridCount: this.gridCount });
        this.toolkit.updateStats();
        regrid.disabled = false;
        regrid.textContent = label;
        this.terrainTouched = true;
      }, 16);
    });
    syncGridCount(this.gridCount);

    const brushCtl = bindTriple({
      slider: brush, num: brushNum,
      min: 1, max: 60, step: 0.5, decimals: 1, initial: 12,
      onChange: (v) => { this.toolkit.setRadius(v); },
    });
    const amountCtl = bindTriple({
      slider: amount, num: amountNum,
      min: -4000, max: 4000, step: 10, decimals: 0, initial: 600,
      onChange: (v) => { this.toolkit.tview.brushHeight = v; },
    });
    void brushCtl; void amountCtl;

    genBtn.addEventListener('click', () => {
      this.toolkit.regenerate({ ...this.values, gridCount: this.gridCount });
      this.terrainTouched = true;
    });
    reseed.addEventListener('click', () => {
      this.values.seed = newSeed();
      this.toolkit.regenerate({ ...this.values, gridCount: this.gridCount });
      this.terrainTouched = true;
    });
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (!b) return;
      for (const o of seg.querySelectorAll('.seg-btn')) o.classList.toggle('active', o === b);
      this.toolkit.tview.tool = b.dataset.tool;
      const absolute = b.dataset.tool === 'raise' || b.dataset.tool === 'lower';
      amountLabel.textContent = absolute ? '改变高度' : '强度参数';
      amount.disabled = !absolute;
      amountNum.disabled = !absolute;
    });
    btnOcean.addEventListener('click', () => this._fill(-4000));
    btnLand.addEventListener('click', () => this._fill(800));
    btnInv.addEventListener('click', () => {
      invertLandSea(this.toolkit.grid);
      updateWaterMask(this.toolkit.grid);
      this.toolkit.refreshPreview(true);
      this.toolkit.updateStats();
      this.terrainTouched = true;
    });
    btnSmooth.addEventListener('click', () => {
      blurWrap(this.toolkit.grid.height, this.toolkit.grid.GX, this.toolkit.grid.GY, 1);
      this.toolkit.refreshPreview(true);
      this.toolkit.updateStats();
      this.terrainTouched = true;
    });
    btnRivers.addEventListener('click', () => this.toolkit.recomputeRivers());
  }

  _fill(value) {
    if (!this.toolkit) return;
    fillAll(this.toolkit.grid, value);
    updateWaterMask(this.toolkit.grid);
    this.toolkit.refreshPreview(true);
    this.toolkit.updateStats();
    this.terrainTouched = true;
  }

  renderStep4(pane) {
    const grid = el('div', { class: 'wiz-grid' });
    const left = el('div');
    const right = el('div');
    grid.append(left, right);
    pane.append(grid);
    left.append(el('h3', { class: 'card-title', text: '时间' }));
    for (const k of ['stepMonths', 'totalMonths', 'autoStop']) this.field(left, k);
    left.append(el('p', { class: 'tiny muted', text: '步长最小为 1 个月；总时长填 -1 表示不限时长，持续推演。' }));
    right.append(el('h3', { class: 'card-title', text: '水与热力' }));
    for (const k of ['waterInventory', 'precipFactor', 'landHeatCapacity', 'oceanHeatCapacity', 'transport', 'iceFlow']) {
      this.field(right, k);
    }
    pane.append(el('p', { class: 'tiny muted', text: '确认后立即生成星球并开始推演。' }));
  }

  /** Build the final parameter bag + terrain and hand it to the caller. */
  commit() {
    const nameInput = this.modal.querySelector('#wizName');
    const name = nameInput && nameInput.value.trim() ? nameInput.value.trim() : '新世界';
    const bag = { ...defaults(), ...this.values };
    for (const k of Object.keys(bag)) if (PARAM_MAP[k]) bag[k] = coerce(k, bag[k]);
    if (this.toolkit) bag.seed = this.values.seed;
    let terrain = null;
    if (this.toolkit) {
      applyOceanTarget(this.toolkit.grid, clamp((bag.oceanFraction ?? 70.8) / 100, 0.001, 0.999));
      updateWaterMask(this.toolkit.grid);
      terrain = terrainFromObject(terrainToObject(this.toolkit.grid));
    }
    this.onDone({ name, params: bag, terrain, seed: bag.seed, presetId: this.presetId, terrainEdited: this.terrainTouched });
    this.close();
  }
}

/* ================================================================== */
/* terrain editor modal (for an already-loaded planet)                */
/* ================================================================== */

export class TerrainEditor {
  constructor(opts = {}) {
    this.modal = opts.modal;
    this.onApply = opts.onApply || (() => {});
    this.getWorld = opts.getWorld;
    this.backup = null;
    this.toolkit = null;
    this.viewMode = 'flat';
    this.globePaint = false;
    this._lastGlobeRefresh = 0;
    this.bind();
  }

  /* ---------------- resizable configuration column ---------------- */

  /** Restore / persist the left column width, and wire the splitter drag. */
  bindSplitter() {
    const body = this.modal.querySelector('.te-body');
    const split = this.modal.querySelector('#teSplit');
    bindColumnSplitter(body, split, () => {
      if (this.toolkit) this.toolkit.view.invalidate();
    });
  }

  /**
   * Arrow keys move the flat map (Shift = bigger steps). Only plain arrows are
   * taken, so the numeric inputs and the undo shortcuts keep working.
   */
  bindKeyboardPan() {
    window.addEventListener('keydown', (e) => {
      if (this.modal.classList.contains('hidden')) return;
      if (this.viewMode !== 'flat') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return;
      const v = this.toolkit && this.toolkit.view;
      if (!v) return;
      const step = e.shiftKey ? 0.25 : 0.08;
      const w = Math.max(2, v.canvas.clientWidth);
      const h = Math.max(2, v.canvas.clientHeight);
      // same direction convention as the main flat map
      const map = {
        ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
      }[e.key];
      if (!map) return;
      v.panBy(map[0] * step * w, map[1] * step * h);
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  /**
   * The 3D preview takes the same gestures as the flat map: plain drag paints,
   * Ctrl/Alt/Shift drags rotate, the wheel zooms and Ctrl+wheel resizes the brush.
   */
  bindGlobeInteraction() {
    const cv = this.modal.querySelector('#teGlobe');
    if (!cv || cv.dataset.bound === '1') return;
    cv.dataset.bound = '1';
    const ringCanvas = this.modal.querySelector('#teVectors');
    if (ringCanvas && !this.globeOverlay) this.globeOverlay = new VectorOverlay(ringCanvas);
    let last = null;
    /** Show the brush circle on the sphere under the pointer. */
    const showRing = () => {
      if (!this.globeOverlay || this.viewMode !== 'globe') return;
      const g = this.toolkit && this.toolkit.ensureGlobe();
      if (!g || !g.ok || !this.brushGeo) { this.globeOverlay.setVisible(false); return; }
      this.globeOverlay.setVisible(true);
      const rect = cv.getBoundingClientRect();
      const r = this.toolkit.tview.radius;
      const project = (lat, lon) => {
        const p = g.project(lat, lon);
        return p && { x: p.x, y: p.y, facing: p.facing };
      };
      const sizeFor = (lat, lon) => {
        // measure the circle in pixels by projecting a point one radius north
        const p0 = g.project(lat, lon);
        const p1 = g.project(Math.min(89, lat + r), lon);
        if (!p0 || !p1) return 6;
        return Math.hypot(p1.x - p0.x, p1.y - p0.y);
      };
      void rect;
      this.globeOverlay.drawRing(project, sizeFor, this.brushGeo.lat, this.brushGeo.lon, r);
    };
    const paintAt = (e) => {
      const g = this.toolkit && this.toolkit.ensureGlobe();
      if (!g || !g.ok) return;
      const hit = g.pick(e.clientX, e.clientY);
      if (!hit || hit.lat === undefined) return;
      this.toolkit.tview.painting = true;
      this.toolkit.tview.stroke({ lat: hit.lat, lon: hit.lon });
      const now = performance.now();
      if (now - this._lastGlobeRefresh > 130) {
        this._lastGlobeRefresh = now;
        this.toolkit.refreshGlobe();
      }
    };
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      last = { x: e.clientX, y: e.clientY };
      this.globePaint = e.button === 0 && !(e.ctrlKey || e.altKey || e.shiftKey);
      cv.style.cursor = this.globePaint ? 'crosshair' : 'grabbing';
      if (this.globePaint) paintAt(e);
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      const g0 = this.toolkit && this.toolkit.ensureGlobe();
      if (g0 && g0.ok) {
        const hit = g0.pick(e.clientX, e.clientY);
        this.brushGeo = hit && hit.lat !== undefined ? { lat: hit.lat, lon: hit.lon } : null;
      }
      // the 3D preview reports its hover here rather than through Map2DView
      if (this.toolkit) this.toolkit.setHover(this.brushGeo, { x: e.clientX, y: e.clientY });
      if (!last) {
        cv.style.cursor = (e.ctrlKey || e.altKey || e.shiftKey) ? 'grab' : 'crosshair';
        showRing();
        return;
      }
      if (this.globePaint) { paintAt(e); last = { x: e.clientX, y: e.clientY }; showRing(); return; }
      const g = this.toolkit && this.toolkit.ensureGlobe();
      if (!g) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      g.rot.yaw += dx * 0.0075;
      g.rot.pitch = clamp(g.rot.pitch + dy * 0.0075, -Math.PI, Math.PI);
      last = { x: e.clientX, y: e.clientY };
      showRing();
    });
    cv.addEventListener('pointerleave', () => {
      this.brushGeo = null;
      if (this.globeOverlay) this.globeOverlay.setVisible(false);
    });
    const stop = (e) => {
      const wasPainting = this.globePaint;
      last = null;
      this.globePaint = false;
      cv.style.cursor = 'crosshair';
      try { cv.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (wasPainting && this.toolkit) {
        this.toolkit.tview.painting = false;
        this.toolkit.refreshGlobe();
        this.toolkit.updateStats();
      }
      showRing();
    };
    cv.addEventListener('pointerup', stop);
    cv.addEventListener('pointercancel', stop);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const g = this.toolkit && this.toolkit.ensureGlobe();
      if (!g) return;
      if (e.ctrlKey || e.altKey) this.toolkit.adjustRadius(e.deltaY > 0 ? 0.9 : 1.1);
      else g.zoomBy(e.deltaY > 0 ? 1.08 : 0.925);
      showRing();
    }, { passive: false });
    cv.style.cursor = 'crosshair';
    cv.style.touchAction = 'none';
    this._showGlobeRing = showRing;
  }

  /** One-time wiring of the modal chrome; the control groups follow in bindControls(). */
  bind() {
    const q = (id) => this.modal.querySelector('#' + id);
    this.q = q;
    this.modal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => this.close()));
    this.bindSplitter();
    this.bindKeyboardPan();
    this.bindGlobeInteraction();

    q('teGen').addEventListener('click', () => {
      this.toolkit.regenerate({
        seed: Number(q('teSeed').value) || 1234,
        fragmentation: Number(q('teFrag').value),
        relief: Number(q('teRelief').value),
        seaFloorRelief: 50,
        plateCount: 14,
        oceanFraction: Number(q('teSea').value),
      });
    });
    q('teRandomSeed').addEventListener('click', () => { q('teSeed').value = String(newSeed()); });
    this.bindControls();
  }

  /** Wire the range/number pairs declared in the modal markup. */
  bindControls() {
    const q = this.q;
    q('teToolSeg').addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (!b) return;
      for (const o of q('teToolSeg').querySelectorAll('.seg-btn')) o.classList.toggle('active', o === b);
      this.setTool(b.dataset.tool);
    });

    // --- generation sliders (each also has a precise number input) ---
    this.setFrag = this.bindField('teFrag', null, 0, 100, 1, () => { /* applied on generate */ }, (v) => String(v));
    this.setSea = this.bindField('teSea', null, 5, 95, 1, () => {}, (v) => v + '%');
    this.setRelief = this.bindField('teRelief', null, 0, 100, 1, () => {}, (v) => String(v));
    this.setSeaLevelH = this.bindField('teSeaLevelH', null, -800, 800, 5, (v) => this.shiftSeaLevel(v), (v) => v + ' m');

    // --- brush radius: slider + numeric input (no knob: it needs precision, not
    //     a dial that hides the exact number) ---
    this.brushCtl = bindTriple({
      slider: q('teBrush'), num: q('teBrushNum'),
      min: 1, max: 60, step: 0.5, decimals: 1, initial: 12,
      onChange: (v) => { if (this.toolkit) this.toolkit.setRadius(v); },
    });
    // --- change height (metres) : raise / lower ---
    this.heightCtl = bindTriple({
      slider: q('teHeight'), num: q('teHeightNum'),
      min: -4000, max: 4000, step: 10, decimals: 0, initial: 600,
      onChange: (v) => { if (this.toolkit) this.toolkit.tview.brushHeight = v; },
    });
    // --- brush strength (smooth / flatten): slider + number ---
    this.strengthCtl = bindTriple({
      slider: q('teStrength'), num: q('teStrengthNum'),
      min: 1, max: 100, step: 1, decimals: 0, initial: 60,
      onChange: (v) => { if (this.toolkit) this.toolkit.tview.strength = v / 100; },
    });

    q('teFillOcean').addEventListener('click', () => this._fill(-4000));
    q('teFillLand').addEventListener('click', () => this._fill(800));
    q('teInv').addEventListener('click', () => {
      invertLandSea(this.toolkit.grid);
      updateWaterMask(this.toolkit.grid);
      this.toolkit.refreshPreview(true);
      this.toolkit.updateStats();
    });
    q('teSmoothAll').addEventListener('click', () => {
      blurWrap(this.toolkit.grid.height, this.toolkit.grid.GX, this.toolkit.grid.GY, 1);
      this.toolkit.refreshPreview(true);
      this.toolkit.updateStats();
    });
    q('teRivers').addEventListener('click', () => this.toolkit.recomputeRivers());
    q('teApplyTarget').addEventListener('click', () => {
      const target = clamp(Number(q('teTargetOcean').value) / 100, 0.001, 0.999);
      applyOceanTarget(this.toolkit.grid, target);
      updateWaterMask(this.toolkit.grid);
      this.toolkit.refreshPreview(true);
      this.toolkit.updateStats();
    });

    // --- display options ---
    q('teShading').addEventListener('change', () => {
      this.toolkit.tview.showShading = q('teShading').checked;
      this.toolkit.refreshPreview(true);
    });
    const overlaySel = q('teOverlaySel');
    for (const key of LAYER_ORDER) {
      if (LAYERS[key]) overlaySel.append(el('option', { value: key, text: LAYERS[key].label }));
    }
    overlaySel.value = 'temperature';
    q('teOverlay').addEventListener('change', () => {
      const on = q('teOverlay').checked;
      overlaySel.classList.toggle('hidden', !on);
      this.toolkit.tview.previewLayer = on ? overlaySel.value : null;
      this.toolkit.refreshPreview(true);
    });
    overlaySel.addEventListener('change', () => {
      this.toolkit.tview.previewLayer = overlaySel.value;
      this.toolkit.refreshPreview(true);
    });

    // --- view mode ---
    q('teViewSeg').addEventListener('click', (e) => {
      const b = e.target.closest('.seg-btn');
      if (!b) return;
      for (const o of q('teViewSeg').querySelectorAll('.seg-btn')) o.classList.toggle('active', o === b);
      this.setViewMode(b.dataset.view);
    });
    q('teResetView').addEventListener('click', () => {
      if (this.viewMode === 'globe' && this.toolkit.globe) this.toolkit.globe.resetView();
      else this.toolkit.view.reset();
    });

    // --- grid resolution ---
    const gridPreset = q('teGridPreset');
    for (const p of GRID_PRESETS) gridPreset.append(el('option', { value: `${p.gx}x${p.gy}`, text: p.label }));
    const syncGrid = (count) => {
      const d = gridDimsFor(count);
      q('teGridCount').value = String(d.count);
      if (document.activeElement !== q('teGridCountNum')) q('teGridCountNum').value = String(d.count);
      const cl = climateSizeFor(d.gx, d.gy);
      q('teGridInfo').innerHTML = `将生成 <span class="mono strong">${d.gx} × ${d.gy}</span>（${d.count.toLocaleString('en-US')} 格）· ` +
        `气候求解 <span class="mono">${cl.NB} × ${cl.NL}</span>`;
      const preset = nearestPreset(d.count);
      gridPreset.value = `${preset.gx}x${preset.gy}`;
      this.pendingGridCount = d.count;
    };
    q('teGridCount').addEventListener('input', () => syncGrid(Number(q('teGridCount').value)));
    q('teGridCountNum').addEventListener('change', () => syncGrid(Number(q('teGridCountNum').value)));
    gridPreset.addEventListener('change', () => {
      const [gx, gy] = gridPreset.value.split('x').map(Number);
      syncGrid(gx * gy);
    });
    q('teRegrid').addEventListener('click', () => {
      const btn = q('teRegrid');
      btn.disabled = true;
      const label = btn.textContent;
      btn.textContent = '生成中…';
      setTimeout(() => {
        this.toolkit.regenerate({
          seed: Number(q('teSeed').value) || 1234,
          fragmentation: Number(q('teFrag').value),
          relief: Number(q('teRelief').value),
          plateCount: 14,
          oceanFraction: Number(q('teSea').value),
          gridCount: this.pendingGridCount,
        });
        btn.disabled = false;
        btn.textContent = label;
      }, 16);
    });
    syncGrid(64800);

    // --- modal actions ---
    q('teApply').addEventListener('click', () => this.apply());
    q('teCancel').addEventListener('click', () => this.close());
    q('teRevert').addEventListener('click', () => {
      if (this.backup) {
        this.toolkit.setGrid(terrainFromObject(this.backup));
        this.toolkit.recomputeRivers();
      }
    });
  }

  /**
   * Wire a range to an optional `<output>` and/or an optional `#<id>Num` numeric
   * input. The numeric box is the precise entry point: typing into it drives the
   * slider, and dragging the slider keeps the box in sync (unless it is focused).
   */
  bindField(rangeId, outId, min, max, step, onChange, fmt) {
    const q = this.q;
    const input = q(rangeId);
    if (!input) return null;
    const out = outId ? q(outId) : null;
    const num = q(rangeId + 'Num');
    const sync = (fromNum) => {
      const v = Number(input.value);
      if (out) out.textContent = fmt(v);
      if (num && !fromNum && document.activeElement !== num) num.value = String(v);
      onChange(v);
      return v;
    };
    input.addEventListener('input', () => sync(false));
    if (num) {
      num.min = String(min); num.max = String(max); num.step = String(step || 1);
      num.addEventListener('change', () => {
        const v = clamp(Number(num.value), min, max);
        num.value = String(v);
        input.value = String(v);
        sync(true);
      });
    }
    sync(false);
    return (v) => { input.value = String(v); sync(false); };
  }

  setTool(tool) {
    if (!this.toolkit) return;
    this.toolkit.tview.tool = tool;
    const absolute = tool === 'raise' || tool === 'lower';
    this.modal.querySelector('#teAmountLabel').textContent = absolute ? '改变高度' : '强度参数';
    this.modal.querySelector('#teHeightRow').style.display = absolute ? '' : 'none';
    this.modal.querySelector('#teStrengthRow').style.display = absolute ? 'none' : '';
  }

  shiftSeaLevel(v) {
    if (!this.toolkit) return;
    const delta = v - (this._lastSeaLevel || 0);
    const H = this.toolkit.grid.height;
    for (let i = 0; i < H.length; i++) H[i] -= delta;
    this._lastSeaLevel = v;
    updateWaterMask(this.toolkit.grid);
    this.toolkit.refreshPreview(true);
    this.toolkit.updateStats();
  }

  _fill(value) {
    fillAll(this.toolkit.grid, value);
    updateWaterMask(this.toolkit.grid);
    this.toolkit.refreshPreview(true);
    this.toolkit.updateStats();
  }

  setViewMode(mode) {
    this.viewMode = mode;
    const flat = mode === 'flat';
    const flatCanvas = this.modal.querySelector('#teCanvas');
    const globeCanvas = this.modal.querySelector('#teGlobe');
    flatCanvas.classList.toggle('hidden', !flat);
    globeCanvas.classList.toggle('hidden', flat);
    if (this.globeOverlay) this.globeOverlay.setVisible(!flat);
    this.modal.querySelector('#teViewHint').textContent = flat
      ? '左键涂抹绘制 · Ctrl/Alt/Shift+拖动或方向键移动地图 · 滚轮改笔刷半径 · Ctrl+滚轮缩放'
      : '左键涂抹绘制 · Ctrl/Alt/Shift+拖动旋转 · 滚轮缩放 · Ctrl+滚轮改笔刷半径（无昼夜明暗）';
    if (flat) {
      this.toolkit.refreshPreview(true);
    } else {
      this.toolkit.refreshGlobe();
      this.toolkit.renderGlobe(0);
      if (this._showGlobeRing) this._showGlobeRing();
    }
  }

  open() {
    const world = this.getWorld();
    if (!world) { emit('toast', '请先创建或载入一个星球'); return; }
    this.backup = terrainToObject(world.terrain);
    const overlay = this.modal.closest('.overlay');
    if (overlay) {
      for (const m of overlay.querySelectorAll('.modal')) {
        if (m !== this.modal) m.classList.add('hidden');
      }
      overlay.classList.remove('hidden');
    }
    this.modal.classList.remove('hidden');
    const canvas = this.modal.querySelector('#teCanvas');
    const globeCanvas = this.modal.querySelector('#teGlobe');
    this.toolkit = new TerrainToolkit({
      canvas,
      globeCanvas,
      grid: terrainFromObject(this.backup),
      // the wheel changes the brush radius: keep the slider and number in step
      onChange: (info) => {
        if (info && info.radius !== undefined && this.brushCtl) this.brushCtl.setValue(info.radius, true);
      },
    });
    this.toolkit.world = world;
    this.toolkit.statsEl = this.modal.querySelector('#teStats');
    this.toolkit.viewInfoEl = this.modal.querySelector('#teViewInfo');
    this.toolkit.hoverEl = this.modal.querySelector('#teHoverInfo');
    this._lastSeaLevel = 0;      // must be reset before the control is re-seeded,
                                 // otherwise the first sync shifts the whole grid
    // seed the controls from the loaded planet
    if (this.setSea) this.setSea(Math.round(world.oceanFraction * 100));
    if (this.setSeaLevelH) this.setSeaLevelH(0);
    this._lastSeaLevel = 0;
    this.modal.querySelector('#teSeed').value = String(world.seed);
    const gc = world.terrain.GX * world.terrain.GY;
    this.pendingGridCount = gc;
    this.modal.querySelector('#teGridCount').value = String(clamp(gc, 16200, 1036800));
    this.modal.querySelector('#teGridCountNum').value = String(gc);
    this.modal.querySelector('#teGridPreset').value = `${nearestPreset(gc).gx}x${nearestPreset(gc).gy}`;
    const cl = climateSizeFor(world.terrain.GX, world.terrain.GY);
    this.modal.querySelector('#teGridInfo').innerHTML =
      `当前 <span class="mono strong">${world.terrain.GX} × ${world.terrain.GY}</span>（${gc.toLocaleString('en-US')} 格）· ` +
      `气候求解 <span class="mono">${cl.NB} × ${cl.NL}</span>`;

    this.modal.querySelector('#teShading').checked = true;
    this.toolkit.tview.showShading = true;
    this.toolkit.tview.previewLayer = null;
    this.modal.querySelector('#teOverlay').checked = false;
    this.modal.querySelector('#teOverlaySel').classList.add('hidden');
    this.setTool('raise');
    this.setViewMode('flat');
    this.toolkit.recomputeRivers();
    this.toolkit.view.reset();
    this.toolkit.view.brushRadiusDeg = this.toolkit.tview.radius;
    this.toolkit.refreshPreview(true);
    this.toolkit.updateStats();
    this.toolkit.updateViewInfo();
    this.bindGlobeInteraction();
  }

  /** Called from the render loop while the modal is open. */
  render(dt) {
    if (!this.toolkit) return;
    if (this.modal.classList.contains('hidden')) return;
    if (this.viewMode === 'flat') {
      // The Map2DView is the only renderer of the shared canvas in flat mode; the
      // TerrainCanvas just supplies the bitmap. Drawing both made the picture
      // appear to zoom and jump on its own.
      this.toolkit.view.render(false);
    } else {
      this.toolkit.renderGlobe(dt);
    }
  }

  close() { this.modal.classList.add('hidden'); this.modal.closest('.overlay')?.classList.add('hidden'); }

  apply() {
    if (!this.toolkit) return;
    this.onApply(this.toolkit.grid);
    this.close();
  }
}

export { generateTerrain, terrainToObject, terrainFromObject, GRID_PRESETS, climateSizeFor };
