/**
 * Central view: owns the 3D globe and the flat (equirectangular) map, the data
 * layer strip, the legend and the probe interaction. Talks to the simulation
 * only through the event bus and the `world` object it is handed.
 */

import { GlobeView } from '../render/globe.js';
import { Map2DView } from '../render/map2d.js';
import { VectorOverlay, flowOffset } from '../render/overlay2d.js';
import { oceanFractionAt } from '../physics/derived.js';
import { LAYERS, LAYER_ORDER, cssGradient, rampLut, rampChoices, rampFor, toHex, hx } from '../core/colors.js';
import { state, setLayerRange, setLayerRamp, setLayerAutoRange, resetLayerStyle, layerRangeFor, layerCustomFor } from '../state/state.js';
import { emit, on } from '../core/bus.js';
import { el } from './widgets.js';
import { tempFromK, tempUnit, fmtTime, lengthFromM, lengthUnit } from '../core/units.js';

export const VIEW_PRESETS = [
  { key: 'globe', label: '3D 星球', title: '标准三维视角' },
  { key: 'flat', label: '平面投影', title: '等经纬度平面投影（← → 移动地图）' },
  { key: 'northPole', label: '北极点', title: '俯视北极' },
  { key: 'equator', label: '赤道', title: '正对赤道' },
  { key: 'southPole', label: '南极点', title: '俯视南极' },
];

export class GlobePane {
  constructor(opts) {
    this.canvas3d = opts.canvas;
    this.canvas2d = opts.canvas2d;
    this.layerStrip = opts.layerStrip;
    this.legendBar = opts.legendBar;
    this.legendTicks = opts.legendTicks;
    this.legendTitle = opts.legendTitle;
    this.probeTip = opts.probeTip;
    this.hud = opts.hud;
    this.getWorld = opts.getWorld;
    this.getProbes = opts.getProbes || (() => []);
    this.globe = new GlobeView(this.canvas3d);
    this.vectors = new VectorOverlay(opts.vectorCanvas);
    this.legendEditor = opts.legendEditor || null;
    this.legendRamps = opts.legendRamps || null;
    this.legendMin = opts.legendMin || null;
    this.legendMax = opts.legendMax || null;
    this.legendUnitEl = opts.legendUnit || null;
    this.legendEditTitle = opts.legendEditTitle || null;
    this.vectorCount = 0;
    this.map2d = new Map2DView(this.canvas2d, {
      imageProvider: () => this.baseImage,
      onHover: (geo, e) => this.onFlatHover(geo, e),
      onLeave: () => this.hideTip(),
    });
    this.viewMode = 'globe';                 // globe | flat
    this.viewPreset = 'globe';
    this.baseDirty = true;
    this.overlayDirty = true;
    this.baseImage = null;
    this.overlayCanvas = null;
    this.overlayKey = null;
    this.dragging = null;
    this.probes = [];
    this.probeEls = new Map();
    this.hoverCell = null;
    this.region = null;
    this.spin = false;
    this.showProbes = true;

    if (!this.globe.ok) this._showGlError();
    this.buildLayerStrip();
    this.buildLegendEditor();
    this.bindPointer();
    this.bindHud(opts);
    this.applyViewMode();

    on('layer:change', () => { this.overlayDirty = true; this.updateLegend(); });
    // A colourbar change has to reach the GPU as well as the legend: the overlay data
    // texture carries raw values and the shader colours them through a 256px LUT, so
    // without re-uploading that LUT here the globe kept showing the previous colourbar
    // while only the legend swatch changed.
    on('legend:change', () => {
      this.overlayDirty = true;
      this.uploadOverlayLut();
      this.updateLegend();
    });
    on('sim:step', () => { this.overlayDirty = true; });
    on('planet:terrain', () => { this.baseDirty = true; this.overlayDirty = true; });
    on('state:param', ({ key }) => {
      if (['tempTint', 'oceanColor', 'cloudVisual', 'seaLevel', 'terrainScale'].includes(key) || key === '*') {
        this.baseDirty = true;
      }
      this.overlayDirty = true;
    });
    on('region:change', () => this.refreshProbeMarkers());
    on('impact', (imp) => this.playImpact(imp));
  }

  /* ---------------- meteor impact animation ---------------- */

  /**
   * Remember the impact's wall-clock start so the flash/ring can play out in real
   * time even at 25× simulation speed, and make sure the overlay canvas is on.
   */
  playImpact(impact) {
    if (!impact || !impact.site) return;
    // A shower lands at many sites; draw all of them. `lat`/`lon`/`radiusDeg` stay as
    // the most recent site so anything reading a single footprint keeps working.
    const sites = Array.isArray(impact.sites) && impact.sites.length
      ? impact.sites.map((s) => ({ lat: s.lat, lon: s.lon, radiusDeg: s.radiusDeg ?? impact.radiusDeg ?? 3, blastKm: s.blastKm ?? impact.blastKm ?? 300, mass: s.mass }))
      : [{ lat: impact.site.lat, lon: impact.site.lon, radiusDeg: impact.radiusDeg ?? 3, blastKm: impact.blastKm ?? 300 }];
    this.impactAnim = {
      lat: impact.site.lat,
      lon: impact.site.lon,
      radiusDeg: impact.radiusDeg ?? 3,
      blastKm: impact.blastKm ?? 300,
      sites,
      start: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      count: impact.count,
      load: impact.load,
    };
    this.vectors.setVisible(true);
  }

  drawImpact(world) {
    const anim = this.impactAnim;
    if (!anim || !this.vectors) return;
    const age = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - anim.start) / 1000;
    const dust = (world && world.impactDust) || 0;
    // the animation itself lasts a few seconds; the footprint lingers with the dust
    if (age > 12 && dust < 0.02) { this.impactAnim = null; return; }
    const flat = this.viewMode === 'flat';
    const canvas = flat ? this.canvas2d : this.canvas3d;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 8) return;
    this.vectors.setVisible(true);
    let project;
    let sizeFor;
    if (flat) {
      project = (lat, lon) => {
        const p = this.map2d.latLonToScreen(lat, lon);
        return { x: p.x - rect.left, y: p.y - rect.top, facing: p.onScreen };
      };
      sizeFor = (lat, lon, r) => Math.abs(this.map2d.latLonToScreen(lat + r, lon).y
        - this.map2d.latLonToScreen(lat, lon).y);
    } else {
      project = (lat, lon) => this.globe.project(lat, lon);
      sizeFor = (lat, lon, r) => {
        const a = this.globe.project(lat, lon);
        const b = this.globe.project(Math.min(89.5, lat + r), lon);
        if (!a || !b) return 6;
        return Math.hypot(b.x - a.x, b.y - a.y);
      };
    }
    const label = age < 12
      ? `陨石撞击 ×${anim.count} · 最大影响范围 ≈ ${Math.round(anim.blastKm).toLocaleString('en-US')} km`
      : null;
    // one mark per impact site, so a shower reads as a shower
    const sites = anim.sites || [{ lat: anim.lat, lon: anim.lon, radiusDeg: anim.radiusDeg }];
    for (let n = 0; n < sites.length; n++) {
      const s = sites[n];
      this.vectors.drawImpactAnimation({
        project, sizeFor, lat: s.lat, lon: s.lon,
        radiusDeg: s.radiusDeg ?? anim.radiusDeg, t: Math.max(0, age), dust,
        label: n === 0 ? label : null,
      });
    }
  }

  _showGlError() {
    const host = this.canvas3d.parentElement;
    host.append(el('div', {
      class: 'hud',
      style: 'left:50%;top:50%;transform:translate(-50%,-50%);max-width:420px;text-align:center',
      html: `<div class="hud-title">3D 视图不可用</div>
             <div class="tiny muted">${this.globe.error || 'WebGL 初始化失败'}。
             请使用支持 WebGL 的现代浏览器（Chrome / Edge / Firefox / Safari），
             并确认未禁用硬件加速。可切换到「平面投影」视图继续使用。</div>`,
    }));
  }

  /* ---------------- layer strip ---------------- */

  buildLayerStrip() {
    this.layerStrip.textContent = '';
    const noneBtn = el('button', { class: 'layer-btn none', text: '无叠加', 'data-layer': 'none' });
    noneBtn.addEventListener('click', () => this.setOverlay('none'));
    this.layerStrip.append(noneBtn);
    LAYER_ORDER.forEach((key, idx) => {
      const def = LAYERS[key];
      if (!def) return;
      const btn = el('button', {
        class: 'layer-btn', text: def.label, 'data-layer': key,
        title: `${def.label}${idx < 9 ? ` · 快捷键 ${idx + 1}` : ''}${def.legend ? ` — ${def.legend}` : ''}`,
      });
      btn.addEventListener('click', () => this.setOverlay(key));
      this.layerStrip.append(btn);
    });
    this.updateLegend();
  }

  /** Colourbar the layer is currently drawn with (custom > choice > default). */
  rampForLayer(key) {
    return rampFor(key, state.ui.layerRamp[key], layerCustomFor(key))
      || (LAYERS[key] && LAYERS[key].ramp);
  }

  /**
   * Current normalisation range for the overlay.
   *
   * A manual range wins over the cached upload range: the cache is only refreshed
   * on the next rendered frame, so reading it first would let the legend (and the
   * editor's own fields) snap back to the old value in between — typing a minimum
   * and then a maximum used to discard the minimum.
   */
  currentRange(key) {
    const L = LAYERS[key];
    const override = layerRangeFor(key);
    if (override) return override;
    if (this.globe.overlayRange && this.globe.overlayKey === key) return this.globe.overlayRange;
    return L ? { min: L.min, max: L.max } : { min: 0, max: 1 };
  }

  /**
   * Build the colourbar editor that opens when the legend bar is clicked: pick a
   * colourbar, then type the numeric range the bar should span.
   */
  buildLegendEditor() {
    if (!this.legendEditor || this.builtLegendEditor) return;
    this.builtLegendEditor = true;
    this.legendBar.classList.add('clickable');
    this.legendBar.addEventListener('click', () => this.toggleLegendEditor());
    if (this.legendTitle) {
      this.legendTitle.style.cursor = 'pointer';
      this.legendTitle.addEventListener('click', () => this.toggleLegendEditor());
    }
    const closeBtn = this.legendEditor.querySelector('#legendClose');
    if (closeBtn) closeBtn.addEventListener('click', () => this.toggleLegendEditor(false));
    const autoBtn = this.legendEditor.querySelector('#legendAuto');
    if (autoBtn) autoBtn.addEventListener('click', () => {
      setLayerAutoRange(state.ui.overlay, true);
      this.syncLegendEditor();
    });
    const resetBtn = this.legendEditor.querySelector('#legendReset');
    if (resetBtn) resetBtn.addEventListener('click', () => {
      resetLayerStyle(state.ui.overlay);
      this.syncLegendEditor();
    });
    const customBtn = this.legendEditor.querySelector('#legendCustom');
    if (customBtn) customBtn.addEventListener('click', () => emit('ramp:edit', { key: state.ui.overlay }));
    // `Number('')` is 0, so an input the user has cleared must be rejected
    // explicitly — otherwise a transiently empty field silently rewrites the
    // range to 0.
    const readNum = (el2) => {
      const raw = el2 ? String(el2.value).trim() : '';
      if (!raw) return NaN;
      const v = Number(raw);
      return isFinite(v) ? v : NaN;
    };
    const commitRange = () => {
      const key = state.ui.overlay;
      const min = readNum(this.legendMin);
      const max = readNum(this.legendMax);
      if (!isFinite(min) || !isFinite(max) || max <= min) {
        emit('toast', '数值范围无效：请填入数字，且最大值必须大于最小值');
        this.syncLegendEditor();
        return;
      }
      setLayerRange(key, min, max);
    };
    if (this.legendMin) {
      this.legendMin.addEventListener('change', commitRange);
      this.legendMin.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commitRange(); this.legendMin.blur(); } });
    }
    if (this.legendMax) {
      this.legendMax.addEventListener('change', commitRange);
      this.legendMax.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commitRange(); this.legendMax.blur(); } });
    }
  }

  toggleLegendEditor(force) {
    if (!this.legendEditor) return;
    const open = force === undefined ? this.legendEditor.classList.contains('hidden') : !!force;
    state.ui.legendOpen = open;
    this.legendEditor.classList.toggle('hidden', !open);
    if (open) this.syncLegendEditor();
  }

  syncLegendEditor() {
    const key = state.ui.overlay;
    const L = LAYERS[key];
    if (!this.legendEditor || this.legendEditor.classList.contains('hidden')) return;
    if (!L || key === 'none') {
      this.legendEditor.classList.add('hidden');
      return;
    }
    if (this.legendEditTitle) this.legendEditTitle.textContent = `${L.label} · 颜色条`;
    if (this.legendRamps) {
      this.legendRamps.textContent = '';
      const chosen = state.ui.layerRamp[key] || 'default';
      const hasCustom = !!layerCustomFor(key);
      for (const c of rampChoices(key)) {
        const btn = el('button', {
          class: 'le-ramp' + (!hasCustom && c.id === chosen ? ' on' : ''),
          title: c.label, 'data-ramp': c.id,
        });
        btn.style.background = cssGradient(c.fn, 16);
        btn.append(el('span', { text: c.label }));
        btn.addEventListener('click', () => {
          setLayerRamp(key, c.id);
          this.syncLegendEditor();
        });
        this.legendRamps.append(btn);
      }
      if (hasCustom) {
        const btn = el('button', { class: 'le-ramp on', title: '自定义颜色条' });
        btn.style.background = cssGradient(this.rampForLayer(key), 16);
        btn.append(el('span', { text: '自定义' }));
        btn.addEventListener('click', () => emit('ramp:edit', { key }));
        this.legendRamps.append(btn);
      }
    }
    const range = this.currentRange(key);
    const dec = L.dec ?? 1;
    const fmt = (v) => {
      const n = Number(v);
      return isFinite(n) ? String(Number(n.toFixed(Math.max(dec, 2)))) : '';
    };
    if (this.legendMin && document.activeElement !== this.legendMin) {
      this.legendMin.value = fmt(range.min);
    }
    if (this.legendMax && document.activeElement !== this.legendMax) {
      this.legendMax.value = fmt(range.max);
    }
    if (this.legendUnitEl) {
      const auto = !!state.ui.layerAuto[key];
      this.legendUnitEl.textContent = (L.unit ? L.unit + ' ' : '') + (auto ? '· 自适应' : '');
    }
  }

  updateLegend() {
    const key = state.ui.overlay;
    const def = LAYERS[key] || LAYERS.none;
    for (const btn of this.layerStrip.querySelectorAll('.layer-btn')) {
      btn.classList.toggle('on', btn.dataset.layer === key);
    }
    if (key === 'none' || !def.ramp) {
      this.legendTitle.textContent = '未叠加数据图层';
      this.legendBar.style.background = 'linear-gradient(90deg,#1a222b,#242e39)';
      this.legendTicks.textContent = '—';
      if (this.legendEditor) this.legendEditor.classList.add('hidden');
      return;
    }
    const range = this.currentRange(key);
    this.legendTitle.textContent = def.label;
    this.legendBar.style.background = cssGradient(this.rampForLayer(key), 32);
    const unit = def.unit ? ` ${def.unit}` : '';
    const dec = def.dec ?? 1;
    const hint = def.vector ? '（箭头方向 = 流向 / 风向）' : '';
    this.legendTicks.textContent =
      `${range.min.toFixed(dec)}${unit}  ←  →  ${range.max.toFixed(dec)}${unit}${hint}`;
    this.syncLegendEditor();
  }

  setOverlay(key, silent) {
    if (!LAYERS[key]) return;
    state.ui.overlay = key;
    this.globe.setState({ overlay: key });
    this.globe.overlayKey = key;
    this.uploadOverlayLut();
    this.overlayDirty = true;
    this.updateLegend();
    if (this.legendEditor && !this.legendEditor.classList.contains('hidden')) this.syncLegendEditor();
    if (!silent) emit('layer:change', { overlay: key, base: state.ui.base });
  }

  /** Push the current overlay's colourbar to the globe's LUT texture. */
  uploadOverlayLut() {
    const key = state.ui.overlay;
    if (!key || key === 'none' || !LAYERS[key]) return;
    this.globe.uploadLut(key, this.rampForLayer(key));
  }

  setBase(mode, silent) {
    state.ui.base = mode;
    this.globe.setState({ base: mode });
    this.baseDirty = true;
    if (!silent) emit('layer:change', { overlay: state.ui.overlay, base: mode });
  }

  /* ---------------- view mode ---------------- */

  setViewPreset(key) {
    if (!VIEW_PRESETS.some((p) => p.key === key)) return;
    const wasFlat = this.viewMode === 'flat';
    this.viewPreset = key;
    const flat = key === 'flat';
    this.viewMode = flat ? 'flat' : 'globe';
    if (!flat) {
      // Plain "3D" only re-frames when coming back from the flat map; it must not
      // yank a globe the user has just rotated into place.
      if (key !== 'globe' || wasFlat) {
        this.globe.setViewPreset(key === 'globe' ? 'equator' : key, this.map2d.cx * 360 - 180);
      }
    }
    this.applyViewMode();
    if (flat) {
      // centre the flat map on the latitude band the preset implies
      if (state.ui.region) this.map2d.centerOn((state.ui.region.lon + 180) / 360, (90 - state.ui.region.lat) / 180);
    }
    this.refreshProbeMarkers();
    emit('view:change', { mode: this.viewMode, preset: this.viewPreset });
  }

  /** Flat-map shortcut that also sets the visible latitude band. */
  focusLatitude(lat) {
    if (this.viewMode === 'flat') {
      this.map2d.cy = (90 - lat) / 180;
      this.map2d.invalidate();
    } else {
      this.globe.setViewPreset(lat > 60 ? 'northPole' : lat < -60 ? 'southPole' : 'equator', this.map2d.cx * 360 - 180);
      this.viewPreset = lat > 60 ? 'northPole' : lat < -60 ? 'southPole' : 'equator';
    }
    this.refreshProbeMarkers();
  }

  applyViewMode() {
    const flat = this.viewMode === 'flat';
    this.canvas3d.classList.toggle('hidden', flat);
    this.canvas2d.classList.toggle('hidden', !flat);
    if (flat) {
      this.map2d.invalidate();
      this.map2d.render(true);
    } else {
      // the WebGL canvas may have been resized while hidden
      this.globe.resize();
    }
  }

  /* ---------------- HUD + interaction ---------------- */

  bindHud(opts) {
    const c = opts.controls || {};
    if (c.spin) c.spin.addEventListener('change', () => { this.spin = c.spin.checked; this.globe.setState({ spin: this.spin }); });
    if (c.atmo) c.atmo.addEventListener('change', () => this.globe.setState({ atmosphere: c.atmo.checked }));
    if (c.grid) c.grid.addEventListener('change', () => {
      this.globe.setState({ graticule: c.grid.checked });
      this.map2d.gridLines = c.grid.checked;
      this.map2d.invalidate();
    });
    if (c.shadow) {
      c.shadow.checked = this.globe.sun.shadow !== false;
      c.shadow.addEventListener('change', () => {
        this.globe.sun.shadow = c.shadow.checked;
        this.globe.render(0);
      });
    }
    if (c.probes) c.probes.addEventListener('change', () => {
      this.showProbes = c.probes.checked;
      this.refreshProbeMarkers();
    });
    if (c.reset) c.reset.addEventListener('click', () => {
      if (this.viewMode === 'flat') this.map2d.reset();
      else this.globe.resetView();
      this.placeProbeMarkers();
    });
    if (opts.viewSeg || opts.viewPresetSeg) {
      // Both segmented controls carry `data-view`; main.js owns the active styling.
      for (const seg of [opts.viewSeg, opts.viewPresetSeg]) {
        if (!seg) continue;
        seg.addEventListener('click', (e) => {
          const btn = e.target.closest('.seg-btn');
          if (!btn) return;
          this.setViewPreset(btn.dataset.view);
        });
      }
    }
    if (opts.baseSeg) {
      opts.baseSeg.addEventListener('click', (e) => {
        const btn = e.target.closest('.seg-btn');
        if (!btn) return;
        for (const b of opts.baseSeg.querySelectorAll('.seg-btn')) b.classList.toggle('active', b === btn);
        this.setBase(btn.dataset.base);
      });
    }
    this.showProbes = c.probes ? c.probes.checked : true;
  }

  bindPointer() {
    const cv = this.canvas3d;
    let last = null;
    let moved = 0;
    let downAt = 0;

    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      last = { x: e.clientX, y: e.clientY };
      moved = 0;
      downAt = performance.now();
      cv.classList.add('dragging');
    });

    cv.addEventListener('pointermove', (e) => {
      if (last) {
        const dx = e.clientX - last.x;
        const dy = e.clientY - last.y;
        moved += Math.abs(dx) + Math.abs(dy);
        this.globe.rot.yaw += dx * 0.0075;
        // ±π so the pole-on views (pitch 0 and π) stay reachable while dragging
        this.globe.rot.pitch = Math.max(-Math.PI, Math.min(Math.PI, this.globe.rot.pitch + dy * 0.0075));
        last = { x: e.clientX, y: e.clientY };
      } else {
        this.onHover(e);
      }
    });

    const finish = (e) => {
      cv.classList.remove('dragging');
      const wasDrag = moved > 6;
      last = null;
      if (!wasDrag && performance.now() - downAt < 700) {
        const hit = this.globe.pick(e.clientX, e.clientY);
        if (hit) this.placeProbe(hit.lat, hit.lon);
        else emit('toast', '请在星球上点击');
      }
    };
    cv.addEventListener('pointerup', finish);
    cv.addEventListener('pointercancel', () => { last = null; cv.classList.remove('dragging'); });

    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.globe.zoomBy(e.deltaY > 0 ? 1.08 : 0.925);
    }, { passive: false });

    cv.addEventListener('dblclick', () => { this.globe.resetView(); this.placeProbeMarkers(); });
    cv.addEventListener('pointerleave', () => { this.hoverCell = null; this.hideTip(); });

    // flat map: click (without dragging) drops a probe
    let flatDown = null;
    let flatMoved = 0;
    this.canvas2d.addEventListener('pointerdown', (e) => { flatDown = { x: e.clientX, y: e.clientY }; flatMoved = 0; });
    this.canvas2d.addEventListener('pointermove', (e) => {
      if (flatDown) flatMoved += Math.abs(e.clientX - flatDown.x) + Math.abs(e.clientY - flatDown.y);
    });
    this.canvas2d.addEventListener('pointerup', (e) => {
      if (flatDown && flatMoved < 6) {
        const hit = this.map2d.screenToLatLon(e.clientX, e.clientY);
        if (hit) this.placeProbe(hit.lat, hit.lon);
      }
      flatDown = null;
    });
    this.canvas2d.addEventListener('dblclick', () => { this.map2d.reset(); this.placeProbeMarkers(); });
  }

  onHover(e) {
    const hit = this.globe.pick(e.clientX, e.clientY);
    if (!hit) { this.hideTip(); this.hoverCell = null; return; }
    this.hoverCell = hit;
    const world = this.getWorld();
    if (!world) return;
    this.showTip(e.clientX, e.clientY, hit, world.probe(hit.lat, hit.lon, 3));
  }

  onFlatHover(geo, e) {
    if (!geo) return;
    this.hoverCell = geo;
    const world = this.getWorld();
    if (!world) return;
    this.showTip(e.clientX, e.clientY, geo, world.probe(geo.lat, geo.lon, 3));
  }

  showTip(cx, cy, hit, probe) {
    const rect = this.canvas3d.parentElement.getBoundingClientRect();
    const tip = this.probeTip;
    const sys = state.unitSystem;
    const t = tempFromK(probe.tempK, sys);
    tip.innerHTML = `
      <div class="pt-h">${fmtLatLon(hit.lat, hit.lon)}</div>
      <div class="pt-r"><span class="k">温度</span><span class="v">${t.toFixed(1)} ${tempUnit(sys)}</span></div>
      <div class="pt-r"><span class="k">降水</span><span class="v">${probe.precip.toFixed(1)} mm/月</span></div>
      <div class="pt-r"><span class="k">相对湿度</span><span class="v">${probe.humidity.toFixed(0)} %</span></div>
      <div class="pt-r"><span class="k">植被</span><span class="v">${(probe.vegetation * 100).toFixed(0)} %</span></div>
      <div class="pt-r"><span class="k">高程</span><span class="v">${fmtElev(probe.elevation, sys)}</span></div>
      <div class="pt-r"><span class="k">地貌</span><span class="v">${probe.biome.label}</span></div>`;
    tip.classList.remove('hidden');
    const hostRect = this.canvas3d.parentElement.getBoundingClientRect();
    const x = Math.min(hostRect.width - tip.offsetWidth - 8, Math.max(8, cx - hostRect.left + 14));
    const y = Math.min(hostRect.height - tip.offsetHeight - 8, Math.max(8, cy - hostRect.top + 12));
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }

  hideTip() { this.probeTip.classList.add('hidden'); }

  /* ---------------- probes ---------------- */

  placeProbe(lat, lon) {
    const probe = { lat, lon, radiusDeg: 6, id: 'p' + Date.now().toString(36) };
    this.getProbes().push(probe);
    emit('probe:add', probe);
    emit('region:change', probe);
    this.refreshProbeMarkers();
  }

  refreshProbeMarkers() {
    const list = this.getProbes();
    const keep = new Set();
    for (const p of list) {
      keep.add(p.id);
      if (!this.probeEls.has(p.id)) {
        const node = el('div', {
          class: 'probe-marker',
          style: `position:absolute;width:11px;height:11px;margin:-6px 0 0 -6px;border-radius:50%;
                  border:1.5px solid #a9bccd;background:rgba(107,154,196,0.35);pointer-events:none;z-index:15;
                  transition:opacity .15s ease`,
          title: fmtLatLon(p.lat, p.lon),
        });
        this.canvas3d.parentElement.append(node);
        this.probeEls.set(p.id, node);
      }
    }
    for (const [id, node] of this.probeEls) {
      if (!keep.has(id)) { node.remove(); this.probeEls.delete(id); }
    }
  }

  placeProbeMarkers() {
    const hostRect = this.canvas3d.parentElement.getBoundingClientRect();
    for (const [id, node] of this.probeEls) {
      const probe = this.getProbes().find((p) => p.id === id);
      if (!probe) continue;
      const active = this.region && this.region.id === id;
      let pos = null;
      let facing = true;
      if (this.viewMode === 'flat') {
        const p = this.map2d.latLonToScreen(probe.lat, probe.lon);
        if (p) {
          pos = { x: p.x - hostRect.left, y: p.y - hostRect.top };
          facing = p.onScreen;
        }
      } else {
        const p = this.globe.project(probe.lat, probe.lon);
        if (p) { pos = p; facing = p.facing; }
      }
      if (!pos || !this.showProbes) { node.style.opacity = '0'; continue; }
      node.style.opacity = facing ? '1' : '0.25';
      node.style.left = pos.x + 'px';
      node.style.top = pos.y + 'px';
      node.style.borderColor = active ? '#c9d3de' : '#a9bccd';
      node.style.background = active ? 'rgba(107,154,196,0.75)' : 'rgba(107,154,196,0.30)';
      node.style.width = active ? '14px' : '11px';
      node.style.height = active ? '14px' : '11px';
      node.style.margin = active ? '-8px 0 0 -8px' : '-6px 0 0 -6px';
    }
  }

  setRegion(region) {
    this.region = region;
    this.refreshProbeMarkers();
  }

  /* ---------------- image building (flat map) ---------------- */

  buildBaseImage(world) {
    const t = world.terrain;
    const rgba = world.baseTexture();
    const cv = this._baseCanvas || (this._baseCanvas = document.createElement('canvas'));
    if (cv.width !== t.GX || cv.height !== t.GY) { cv.width = t.GX; cv.height = t.GY; }
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(t.GX, t.GY);
    img.data.set(rgba.subarray ? rgba.subarray(0, t.GX * t.GY * 4) : rgba);
    ctx.putImageData(img, 0, 0);
    this.baseImage = cv;
    this.baseDirty = false;
  }

  buildOverlayImage(world) {
    const key = state.ui.overlay;
    const t = world.terrain;
    if (key === 'none' || !LAYERS[key] || !LAYERS[key].ramp) {
      this.overlayCanvas = null;
      this.overlayKey = null;
      this.map2d.setOverlay(null);
      return;
    }
    const data = world.layerData(key);
    const range = world.layerRange(key);
    this.globe.overlayRange = range;
    const cv = this._overlayCanvas || (this._overlayCanvas = document.createElement('canvas'));
    if (cv.width !== t.GX || cv.height !== t.GY) { cv.width = t.GX; cv.height = t.GY; }
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(t.GX, t.GY);
    const out = img.data;
    // The user's chosen / hand-drawn colourbar, not the layer's registered default.
    // Using LAYERS[key].ramp here meant the flat map (and the terrain-editor preview,
    // which shares this canvas) always painted the default colours no matter what the
    // legend editor was set to — the "changing the colourbar does not change the map"
    // report. The globe was wrong for a different reason; see the legend:change handler.
    const lut = rampLut(this.rampForLayer(key), 256);
    const span = Math.max(1e-6, range.max - range.min);
    for (let i = 0; i < t.GX * t.GY; i++) {
      const v = data[i];
      const o = i * 4;
      if (!isFinite(v)) { out[o + 3] = 0; continue; }
      const tt = Math.max(0, Math.min(1, (v - range.min) / span));
      const li = Math.min(255, Math.round(tt * 255)) * 3;
      out[o] = lut[li];
      out[o + 1] = lut[li + 1];
      out[o + 2] = lut[li + 2];
      out[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    this.overlayCanvas = cv;
    this.overlayKey = key;
    this.map2d.setOverlay(cv, 0.68);
  }

  /* ---------------- keyboard ---------------- */

  /** Arrow-key handling; returns true when the event was consumed. */
  handleArrow(dx, dy, big) {
    if (this.viewMode === 'flat') {
      // pan by a fixed fraction of the viewport so the step does not depend on
      // the canvas having been laid out yet
      const rect = this.map2d.canvas.getBoundingClientRect();
      const w = Math.max(2, rect.width || this.map2d.canvas.clientWidth || 640);
      const h = Math.max(2, rect.height || this.map2d.canvas.clientHeight || 320);
      const step = big ? 0.25 : 0.08;
      this.map2d.panBy(dx * step * w, dy * step * h);
      this.placeProbeMarkers();
      return true;
    }
    this.globe.rot.yaw += dx * (big ? 0.25 : 0.06);
    this.globe.rot.pitch = Math.max(-Math.PI, Math.min(Math.PI, this.globe.rot.pitch + dy * (big ? 0.25 : 0.06) * 0.6));
    this.placeProbeMarkers();
    return true;
  }

  /* ---------------- per-frame ---------------- */

  markBaseDirty() { this.baseDirty = true; this.overlayDirty = true; }

  render(dt, world) {
    if (!world) return;
    if (this.baseDirty) {
      const t = world.terrain;
      if (this.globe.ok) this.globe.uploadBase(world.baseTexture(), t.GX, t.GY);
      this.buildBaseImage(world);
    }
    if (this.overlayDirty) {
      const key = state.ui.overlay;
      if (key && key !== 'none') {
        const data = world.layerData(key);
        const range = world.layerRange(key);
        if (this.globe.ok) this.globe.uploadOverlay(data, world.terrain.GX, world.terrain.GY, range);
        this.globe.overlayRange = range;
        this.globe.overlayKey = key;
        this.updateLegend();
      } else {
        this.globe.overlayRange = null;
        this.globe.overlayKey = null;
      }
      this.buildOverlayImage(world);
      this.overlayDirty = false;
    }
    if (this.viewMode === 'flat') {
      this.map2d.render(false);
    } else if (this.globe.ok) {
      this.globe.setState({ nightLights: state.params.nightLights, tempTint: state.params.tempTint });
      this.globe.render(dt);
    }
    this.drawVectors(world);
    this.drawImpact(world);
    this.placeProbeMarkers();
    this.updateHud(world);
  }

  /**
   * Arrow overlay for the flow layers. Arrows carry speed (length + colour, from
   * the same colourbar as the scalar layer) and direction (heading), which is the
   * part a shaded scalar map cannot show.
   */
  drawVectors(world) {
    const key = state.ui.overlay;
    const L = LAYERS[key];
    if (!this.vectors || !L || !L.vector || !world) {
      // record *why* the overlay is off: these are silent failures otherwise
      this.vectorSkip = !this.vectors ? 'no-canvas' : !L ? 'no-layer' : !L.vector ? 'not-a-vector-layer' : 'no-world';
      if (this.vectors) this.vectors.setVisible(false);
      this.vectorCount = 0;
      return;
    }
    this.vectorSkip = null;
    const range = this.currentRange(key);
    const ramp = this.rampForLayer(key);
    const flat = this.viewMode === 'flat';
    const canvas = flat ? this.canvas2d : this.canvas3d;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) { this.vectors.setVisible(false); return; }
    this.vectors.setVisible(true);

    // A small downstream step is enough to get the on-screen heading, because
    // only the direction is taken from it — the length comes from the speed.
    const offset = (lat, lon, u, v) => flowOffset(lat, lon, u, v, 0.35);
    const sample = (lat, lon) => world.layerVector(key, lat, lon);
    // Ocean layers get a footprint mask, so an arrow may not run over a coast —
    // and it must sit in water that is *mostly* water, otherwise a coastal cell
    // that is 60 % land still gets an arrow that visually lies on the continent.
    const weight = L.vector === 'current'
      ? (lat, lon) => {
        const oc = oceanFractionAt(world, lat, lon);
        return oc < 0.5 ? 0 : Math.min(1, (oc - 0.5) / 0.3);
      }
      : null;

    let screenToGeo;
    let project;
    if (flat) {
      screenToGeo = (x, y) => this.map2d.screenToLatLon(rect.left + x, rect.top + y);
      project = (lat, lon) => {
        const p = this.map2d.latLonToScreen(lat, lon);
        return { x: p.x - rect.left, y: p.y - rect.top, facing: p.onScreen };
      };
    } else {
      screenToGeo = (x, y) => this.globe.pick(rect.left + x, rect.top + y);
      project = (lat, lon) => this.globe.project(lat, lon);
    }
    this.vectorCount = this.vectors.draw({
      sample, project, screenToGeo, geoToOffset: offset, ramp, range, weight,
      step: flat ? 46 : 44, alpha: 0.92,
    });
  }

  updateHud(world) {
    const sys = state.unitSystem;
    if (this.hud.name) this.hud.name.textContent = world.name;
    if (this.hud.radius) this.hud.radius.textContent = `${Math.round(state.params.planeRadiusKm).toLocaleString('en-US')} km`;
    if (this.hud.gravity) this.hud.gravity.textContent = `${state.params.gravity.toFixed(2)} m/s²`;
    if (this.hud.star) this.hud.star.textContent = `${state.params.irradiance.toFixed(0)} W/m²`;
    if (this.hud.cursor) {
      this.hud.cursor.textContent = this.hoverCell ? fmtLatLon(this.hoverCell.lat, this.hoverCell.lon) : '—';
    }
    if (this.hud.clock) this.hud.clock.textContent = fmtTime(world.time.month);
    if (this.hud.gridSize) {
      this.hud.gridSize.textContent = `气候 ${world.grid.NB}×${world.grid.NL} · 地形 ${world.terrain.GX}×${world.terrain.GY}`;
    }
    if (this.hud.view) {
      if (this.viewMode === 'flat') {
        const d = this.map2d.describe();
        this.hud.view.textContent = `平面 ${Math.round(d.spanLon)}° × ${Math.round(d.latRange[1] - d.latRange[0])}°`;
      } else {
        // pitch = 90° − centred latitude, so 0 = north pole, π/2 = equator, π = south pole
        const p = ((this.globe.rot.pitch % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const near = (a, b) => Math.abs(a - b) < 0.3;
        const label = near(p, 0) || near(p, 2 * Math.PI) ? '北极点'
          : near(p, Math.PI) ? '南极点'
            : near(p, Math.PI / 2) ? '赤道'
              : '三维';
        this.hud.view.textContent = `${label} · ${(this.globe.rot.dist).toFixed(2)} R`;
      }
    }
  }
}

export function fmtLatLon(lat, lon) {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(1)}°${ns} ${Math.abs(lon).toFixed(1)}°${ew}`;
}

export function fmtElev(m, sys) {
  if (sys === 'imperial') return `${Math.round(lengthFromM(m, sys)).toLocaleString('en-US')} ft`;
  return `${Math.round(m).toLocaleString('en-US')} m`;
}
