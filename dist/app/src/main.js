/**
 * Application entry point: builds the world, wires every panel together and
 * runs the render/step loop.
 */

import { PRESETS, PRESET_MAP } from './state/presets.js';
import {
  state, set, setMany, applyScene, serializeScene, saveSlot, loadSlot, listSlots,
  deleteSlot, undo, redo, undoStatus, setUnitSystem, setAutoDerive, resetBranches,
  addBranch, selectBranch, refreshDerivedParams, SCENE_VERSION, loadSlotScene,
  layerRangeFor, setLayerCustom,
} from './state/state.js';
import { PARAMS, PARAM_MAP, defaults } from './state/params.js';
import { World, TERRAIN_GX, TERRAIN_GY, refreshRivers, updateWaterMask, applyTerrainScale, smoothTerrainVisual, gridDimsFor, climateSizeFor, nearestPreset, gridCostHint, GRID_PRESETS } from './world/world.js';
import { effectiveTau } from './physics/climate.js';
import { ParamPanel } from './ui/paramPanel.js';
import { DataPanel, scopeIdFor } from './ui/dataPanel.js';
import { GlobePane } from './ui/globeView.js';
import { CreationWizard, TerrainEditor } from './ui/creation.js';
import { RampEditor } from './ui/rampEditor.js';
import { Clock, SPEEDS } from './sim/clock.js';
import { emit, on } from './core/bus.js';
import { LAYERS } from './core/colors.js';
import { el, buildKnob } from './ui/widgets.js';
import { fmtTime, fmtDuration, fmtInt } from './core/units.js';
import { terrainToObject, terrainFromObject } from './world/terrain.js';
import { Series, GLOBAL_SCOPE } from './sim/series.js';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

const dom = {
  presetSel: $('presetSel'),
  btnNewPlanet: $('btnNewPlanet'),
  btnSave: $('btnSave'), btnLoad: $('btnLoad'),
  btnFileSave: $('btnFileSave'), btnFileLoad: $('btnFileLoad'),
  btnPlay: $('btnPlay'), btnBranch: $('btnBranch'),
  branchSel: $('branchSel'), btnTerrain: $('btnTerrain'),
  simClock: $('simClock'),
  timeScrub: $('timeScrub'), scrubLabel: $('scrubLabel'), btnScrubLive: $('btnScrubLive'),
  unitSel: $('unitSel'),
  btnExport: $('btnExport'), btnUndo: $('btnUndo'), btnRedo: $('btnRedo'), btnHelp: $('btnHelp'),
  paramSections: $('paramSections'), paramSearch: $('paramSearch'), lockSummary: $('lockSummary'),
  chkAutoDerive: $('chkAutoDerive'),
  globe: $('globe'), flatmap: $('flatmap'), globeWrap: $('globeWrap'),
  layerStrip: $('layerStrip'), legendBar: $('legendBar'), legendTicks: $('legendTicks'), legendTitle: $('legendTitle'),
  legendEditor: $('legendEditor'), legendRamps: $('legendRamps'), legendMin: $('legendMin'),
  legendMax: $('legendMax'), legendUnit: $('legendUnit'), legendEditTitle: $('legendEditTitle'),
  vectorLayer: $('vectorLayer'),
  probeTip: $('probeTip'), toast: $('toast'),
  baseLayerSeg: $('baseLayerSeg'), viewSeg: $('viewSeg'),
  chkSpin: $('chkSpin'), chkAtmo: $('chkAtmo'), chkGrid: $('chkGrid'), chkProbes: $('chkProbes'), chkLinks: $('chkLinks'),
  chkShadow: $('chkShadow'), navHint: $('navHint'),
  btnResetView: $('btnResetView'), viewPresetRow: $('viewPresetRow'), viewPresetSeg: $('viewPresetSeg'),
  hudName: $('hudName'), hudRadius: $('hudRadius'), hudGravity: $('hudGravity'),
  hudStar: $('hudStar'), hudCursor: $('hudCursor'), hudGridSize: $('hudGridSize'), hudView: $('hudView'),
  metricGrid: $('metricGrid'), charts: $('charts'), probeBody: $('probeBody'), probeCard: $('probeCard'),
  condList: $('condList'), scopeLabel: $('scopeLabel'), dataScope: $('dataScope'), btnClearRegion: $('btnClearRegion'),
  overlay: $('overlay'), wizard: $('wizard'), terrainEditor: $('terrainEditor'), gridModal: $('gridModal'),
  slots: $('slots'), slotList: $('slotList'), exportModal: $('exportModal'), help: $('help'),
  wizSteps: $('wizSteps'), wizModes: $('wizModes'), wizPanes: $('wizPanes'),
  wizBack: $('wizBack'), wizNext: $('wizNext'), wizCreate: $('wizCreate'),
  gridCount: $('gridCount'), gridCountNum: $('gridCountNum'), gridKnob: $('gridKnob'),
  gridDims: $('gridDims'), gridCost: $('gridCost'), gridPresetSeg: $('gridPresetSeg'),
  gridConfirm: $('gridConfirm'), gridPresetInfo: $('gridPresetInfo'),
  rampModal: $('rampModal'),
  filePick: $('filePick'),
};

const probes = [];

/* ------------------------------------------------------------------ */
/* custom colourbar editor                                             */
/* ------------------------------------------------------------------ */

const rampEditor = new RampEditor({
  modal: dom.rampModal,
  getLayer: (key) => (LAYERS[key] ? { ...LAYERS[key], custom: state.ui.layerCustom[key] || null } : null),
  onApply: (key, custom) => {
    setLayerCustom(key, custom);
    emit('toast', '已应用自定义颜色条');
  },
});
on('ramp:edit', ({ key }) => rampEditor.open(key || state.ui.overlay));

/* ------------------------------------------------------------------ */
/* panel construction                                                 */
/* ------------------------------------------------------------------ */

const globePane = new GlobePane({
  canvas: dom.globe,
  canvas2d: dom.flatmap,
  vectorCanvas: dom.vectorLayer,
  layerStrip: dom.layerStrip,
  legendBar: dom.legendBar, legendTicks: dom.legendTicks, legendTitle: dom.legendTitle,
  legendEditor: dom.legendEditor, legendRamps: dom.legendRamps,
  legendMin: dom.legendMin, legendMax: dom.legendMax,
  legendUnit: dom.legendUnit, legendEditTitle: dom.legendEditTitle,
  probeTip: dom.probeTip,
  baseSeg: dom.baseLayerSeg,
  viewSeg: dom.viewSeg,
  viewPresetSeg: dom.viewPresetSeg,
  controls: {
    spin: dom.chkSpin, atmo: dom.chkAtmo, grid: dom.chkGrid, shadow: dom.chkShadow,
    probes: dom.chkProbes, reset: dom.btnResetView,
  },
  hud: {
    name: dom.hudName, radius: dom.hudRadius, gravity: dom.hudGravity,
    star: dom.hudStar, cursor: dom.hudCursor, gridSize: dom.hudGridSize, view: dom.hudView, clock: dom.simClock,
  },
  getWorld: () => state.world,
  getProbes: () => probes,
});

const paramPanel = new ParamPanel(dom.paramSections, {
  onChange: (extra) => {
    if (extra && extra.action === 'oceanColor') { openColorPicker(); return; }
    if (extra && extra.action === 'seed') return;
    afterParamChange();
  },
});
paramPanel.attachFoot(dom.lockSummary);

const dataPanel = new DataPanel({
  metricGrid: dom.metricGrid, charts: dom.charts,
  probeBody: dom.probeBody, probeCard: dom.probeCard,
  condList: dom.condList, scopeLabel: dom.scopeLabel,
  getWorld: () => state.world,
});

const clock = new Clock({
  getWorld: () => state.world,
  onStep: () => { dataPanel.dirty = true; },
});

const wizard = new CreationWizard({
  modal: dom.wizard, panes: dom.wizPanes, steps: dom.wizSteps, modes: dom.wizModes,
  onDone: (spec) => createPlanet(spec),
});

const terrainEditor = new TerrainEditor({
  modal: dom.terrainEditor,
  getWorld: () => state.world,
  onApply: (grid) => {
    const world = state.world;
    if (!world) return;
    world.terrain = grid;
    updateWaterMask(grid);
    smoothTerrainVisual(grid, 1);
    refreshRivers(world);
    world.syncTerrainToGrid();
    world.baseDirty = true;
    world.layerCache.clear();
    world.refreshFields();
    state.terrainEdited = true;
    globePane.markBaseDirty();
    emit('planet:terrain', world);
    emit('toast', '地形已应用，气候将重新平衡');
    dataPanel.dirty = true;
  },
});

/* ------------------------------------------------------------------ */
/* world lifecycle                                                    */
/* ------------------------------------------------------------------ */

/**
 * Every world must be able to answer "what colourbar range should this layer
 * use?", because the legend editor's manual range is app state while the
 * layering lives in the physics module. Attaching the hook here (rather than
 * importing app state into world.js) keeps that direction of dependency clean.
 */
function attachRangeOverride(world) {
  if (!world) return world;
  world.rangeOverride = (key) => layerRangeFor(key);
  return world;
}

function buildWorld(spec) {
  const bag = { ...defaults(), ...(spec.params || {}) };
  state.params = bag;
  const world = new World(bag, {
    name: spec.name, seed: spec.seed ?? bag.seed, terrain: spec.terrain,
    gridX: spec.gridX, gridY: spec.gridY,
  });
  world.name = spec.name || world.name;
  world.seriesStart = 0;
  attachRangeOverride(world);
  state.world = world;
  state.ui.planetName = world.name;
  state.ui.presetId = spec.presetId || 'custom';
  state.terrainEdited = !!spec.terrainEdited;
  refreshDerivedParams();
  world.setAnomalyBaseline();
  return world;
}

function createPlanet(spec) {
  buildWorld(spec);
  probes.length = 0;
  globePane.probes = probes;
  globePane.refreshProbeMarkers();
  globePane.setRegion(null);
  dataPanel.clearProbe();
  resetBranches('主时间线');
  state.branches[0].world = state.world;
  clock.clearScrub();
  clock.setPlaying(false);
  clock.setSpeed(1);
  applyUiFromState();
  globePane.markBaseDirty();
  globePane.globe.uploadLut(state.ui.overlay);
  globePane.setOverlay(state.ui.overlay, true);
  globePane.setBase(state.ui.base, true);
  syncTimeline();
  dataPanel.dirty = true;
  emit('planet:new', state.world);
  emit('toast', `已创建星球：${state.world.name}`);
  renderBranchOptions();
  updatePlayButton();
}

function applyPreset(id) {
  const preset = PRESET_MAP[id];
  if (!preset) return;
  const bag = { ...defaults() };
  for (const [k, v] of Object.entries(preset.params || {})) {
    if (state.locks.has(k)) continue;
    bag[k] = v;
  }
  for (const [k, v] of Object.entries(preset.terrain || {})) {
    if (k === 'oceanTarget') { if (!state.locks.has('oceanFraction')) bag.oceanFraction = v * 100; continue; }
    if (!state.locks.has(k)) bag[k] = v;
  }
  bag.seed = preset.seed;
  createPlanet({
    name: preset.label.split(' · ')[0],
    params: bag,
    seed: preset.seed,
    presetId: preset.id,
    terrainEdited: false,
    gridX: state.ui.gridX,
    gridY: state.ui.gridY,
  });
  dom.presetSel.value = preset.id;
  emit('toast', `已载入预设：${preset.label}（网格 ${state.ui.gridX}×${state.ui.gridY}）`);
}

/* ------------------------------------------------------------------ */
/* grid-size chooser (shown after picking a preset)                    */
/* ------------------------------------------------------------------ */

let pendingPresetId = null;
let gridCtl = null;

function openGridModal(presetId) {
  pendingPresetId = presetId || 'earth';
  const preset = PRESET_MAP[pendingPresetId] || PRESETS[0];
  dom.gridPresetInfo.innerHTML =
    `已选择 <span class="strong">${preset.label}</span> — ${preset.blurb || ''}`;
  const current = state.ui.gridCount || 64800;
  gridCtl.setValue(current, true);
  renderGridPresetButtons();
  openModal(dom.gridModal);
}

function renderGridPresetButtons() {
  dom.gridPresetSeg.textContent = '';
  for (const p of GRID_PRESETS) {
    const btn = el('button', { class: 'seg-btn', text: `${p.gx}×${p.gy}` });
    btn.title = p.label;
    btn.addEventListener('click', () => gridCtl.setValue(p.gx * p.gy));
    dom.gridPresetSeg.append(btn);
  }
}

function bootGridControls() {
  const slider = dom.gridCount;
  const num = dom.gridCountNum;
  const knob = buildKnob(state.ui.gridCount || 64800, 16200, 1036800, 56);
  knob.classList.add('knob-lg');
  dom.gridKnob.textContent = '';
  dom.gridKnob.append(knob);

  let value = state.ui.gridCount || 64800;
  const apply = (v, silent) => {
    const d = gridDimsFor(Math.max(16200, Math.min(1036800, Number(v) || 64800)));
    value = d.count;
    state.ui.gridCount = d.count;
    state.ui.gridX = d.gx;
    state.ui.gridY = d.gy;
    if (document.activeElement !== slider) slider.value = String(d.count);
    if (document.activeElement !== num) num.value = String(d.count);
    knob.setValue(d.count);
    const cl = climateSizeFor(d.gx, d.gy);
    dom.gridDims.textContent = `${d.gx} × ${d.gy}　（${d.count.toLocaleString('en-US')} 格，气候求解 ${cl.NB} × ${cl.NL}）`;
    dom.gridCost.textContent = gridCostHint(d.count);
    if (!silent) renderGridPresetButtons();
    return d.count;
  };
  gridCtl = { setValue: (v, silent) => apply(v, silent), get value() { return value; } };
  slider.addEventListener('input', () => apply(Number(slider.value)));
  num.addEventListener('change', () => apply(Number(num.value)));
  knob.addEventListener('knobchange', (e) => apply(e.detail));
  apply(value, true);
}

dom.gridConfirm.addEventListener('click', () => {
  dom.gridModal.classList.add('hidden');
  dom.overlay.classList.add('hidden');
  const id = pendingPresetId;
  pendingPresetId = null;
  if (id) applyPreset(id);
});

function afterParamChange() {
  const world = state.world;
  if (!world) return;
  world.params = state.params;
  world.stars.primary.apply({ irradiance: state.params.irradiance, tempK: state.params.starTemp });
  // the vertical scale is baked into the heightfield rather than applied at
  // render time, so that saved scenes reload identically
  if (world.terrainScaleApplied !== state.params.terrainScale) {
    world.setTerrainScale(state.params.terrainScale);
    globePane.markBaseDirty();
  }
  globePane.overlayDirty = true;
  dataPanel.dirty = true;
  syncHud();
}

function applyUiFromState() {
  dom.chkAutoDerive.checked = state.autoDerive;
  dom.unitSel.value = state.unitSystem;
  dom.presetSel.value = state.ui.presetId || '';
  for (const chip of document.querySelectorAll('.speedwrap .ctl-chip')) {
    chip.classList.toggle('active', Number(chip.dataset.speed) === clock.speed);
  }
}

/* ------------------------------------------------------------------ */
/* timeline / scrubbing                                               */
/* ------------------------------------------------------------------ */

function syncTimeline() {
  const world = state.world;
  if (!world) return;
  const n = world.series.length();
  dom.timeScrub.max = String(Math.max(0, n - 1));
  if (clock.scrubIndex < 0) {
    dom.timeScrub.value = String(Math.max(0, n - 1));
    dom.scrubLabel.textContent = '实时';
  } else {
    dom.timeScrub.value = String(clock.scrubIndex);
    const m = world.series.months[clock.scrubIndex] ?? 0;
    dom.scrubLabel.textContent = fmtTime(m);
  }
  dom.simClock.textContent = clock.scrubIndex >= 0
    ? `${fmtTime(world.series.months[clock.scrubIndex] || 0)} · 回看中`
    : clock.statusLabel(world);
  dom.btnScrubLive.classList.toggle('active', clock.scrubIndex < 0);
  dom.dataScope.textContent = state.ui.region ? '区域平均' : '全球平均';
}

on('sim:step', () => { syncTimeline(); });
on('sim:playing', () => { updatePlayButton(); syncTimeline(); });
on('sim:complete', () => updatePlayButton());
on('time:scrub', () => { syncTimeline(); dataPanel.dirty = true; });
on('planet:new', () => syncTimeline());

function updatePlayButton() {
  dom.btnPlay.textContent = clock.playing ? '❚❚ 暂停' : '▶ 开始';
  dom.btnPlay.classList.toggle('primary', !clock.playing);
  const world = state.world;
  if (world) dom.simClock.textContent = clock.scrubIndex >= 0
    ? `${fmtTime(world.series.months[clock.scrubIndex] || 0)} · 回看中`
    : clock.statusLabel(world);
}

/* ------------------------------------------------------------------ */
/* region / probe linkage                                             */
/* ------------------------------------------------------------------ */

function setRegion(region) {
  state.ui.region = region ? { lat: region.lat, lon: region.lon, radiusDeg: region.radiusDeg } : null;
  const world = state.world;
  if (world && region) {
    const scope = world.regionScopeFor(region.lat, region.lon, region.radiusDeg);
    state.ui.regionScope = scope;
    // Back-fill the regional history from the existing record so the charts are
    // immediately usable instead of starting from an empty series.
    const scopeId = scope.scope;
    const months = world.series.months;
    const reg = scope.region;
    const avg = (field) => {
      let acc = 0;
      for (let i = 0; i < reg.idx.length; i++) acc += field[reg.idx[i]] * reg.weights[i];
      return acc;
    };
    const g = world.grid;
    const p = state.params;
    const sample = {
      tGlobal: avg(g.T), co2: p.co2,
      seaLevel: (world.seaLevelDelta || 0) + (p.seaLevel || 0),
      iceArea: avg(g.seaIce) * 100, energy: avg(g.net),
      biomass: avg(g.biomass), precip: avg(g.precip),
      albedo: avg(g.albedo), olr: avg(g.olr),
    };
    for (let i = 0; i < months.length; i++) {
      world.series.pushRegion(scopeId, { lat: region.lat, lon: region.lon, radiusDeg: region.radiusDeg }, sample);
    }
  } else {
    state.ui.regionScope = null;
  }
  globePane.setRegion(region ? { ...region, id: region.id } : null);
  dataPanel.dirty = true;
  emit('region:change', state.ui.region);
}

/** Live regional sample appended alongside every global sample. */
function regionalSample(world) {
  const region = state.ui.regionScope;
  if (!region) return null;
  const g = world.grid;
  const p = state.params;
  const reg = region.region;
  const avg = (field) => {
    let acc = 0;
    for (let i = 0; i < reg.idx.length; i++) acc += field[reg.idx[i]] * reg.weights[i];
    return acc;
  };
  return {
    tGlobal: avg(g.T), co2: p.co2,
    seaLevel: (world.seaLevelDelta || 0) + (p.seaLevel || 0),
    iceArea: avg(g.seaIce) * 100, energy: avg(g.net),
    biomass: avg(g.biomass), precip: avg(g.precip),
    albedo: avg(g.albedo), olr: avg(g.olr),
  };
}

on('probe:add', (probe) => {
  globePane.probeEls.get(probe.id)?.setAttribute('data-probe', '1');
  setRegion(probe);
});

dom.btnClearRegion.addEventListener('click', () => {
  probes.length = 0;
  globePane.refreshProbeMarkers();
  setRegion(null);
  dataPanel.clearProbe();
});

/* ------------------------------------------------------------------ */
/* top bar wires                                                      */
/* ------------------------------------------------------------------ */

function bootPresets() {
  dom.presetSel.textContent = '';
  dom.presetSel.append(el('option', { value: '', text: '预设星球…' }));
  for (const p of PRESETS) {
    dom.presetSel.append(el('option', { value: p.id, text: p.label }));
  }
  dom.presetSel.addEventListener('change', () => {
    const id = dom.presetSel.value;
    if (!id) return;
    // picking a preset asks for the grid resolution first
    openGridModal(id);
  });
}

dom.btnNewPlanet.addEventListener('click', () => {
  dom.overlay.classList.remove('hidden');
  wizard.open(
    state.ui.presetId && PRESET_MAP[state.ui.presetId] ? state.ui.presetId : 'earth',
    state.ui.gridCount || 64800,
  );
});

dom.wizNext.addEventListener('click', () => wizard.setStep(wizard.step + 1));
dom.wizBack.addEventListener('click', () => wizard.setStep(wizard.step - 1));
dom.wizCreate.addEventListener('click', () => wizard.commit());

dom.btnPlay.addEventListener('click', () => clock.toggle());

for (const chip of document.querySelectorAll('.speedwrap .ctl-chip')) {
  chip.addEventListener('click', () => {
    clock.setSpeed(Number(chip.dataset.speed));
    for (const c of document.querySelectorAll('.speedwrap .ctl-chip')) c.classList.toggle('active', c === chip);
    updatePlayButton();
  });
}

dom.timeScrub.addEventListener('input', () => {
  const idx = Number(dom.timeScrub.value);
  const world = state.world;
  if (!world) return;
  clock.setPlaying(false);
  clock.setScrub(idx);
  const month = world.series.months[idx];
  if (month !== undefined) clock.seek(world, month);
});

dom.btnScrubLive.addEventListener('click', () => {
  const world = state.world;
  clock.clearScrub();
  if (world) clock.seek(world, world.series.lastMonth());
  syncTimeline();
});

dom.unitSel.addEventListener('change', () => { setUnitSystem(dom.unitSel.value); dataPanel.dirty = true; });
dom.chkAutoDerive.addEventListener('change', () => setAutoDerive(dom.chkAutoDerive.checked));
dom.paramSearch.addEventListener('input', () => paramPanel.setFilter(dom.paramSearch.value));

dom.btnUndo.addEventListener('click', () => { undo(); afterParamChange(); });
dom.btnRedo.addEventListener('click', () => { redo(); afterParamChange(); });
on('undo:change', (st) => {
  dom.btnUndo.disabled = !st.canUndo;
  dom.btnRedo.disabled = !st.canRedo;
});
on('state:param', () => dataPanel.dirty = true);

dom.btnBranch.addEventListener('click', () => {
  const world = state.world;
  if (!world) return;
  const clone = world.clone({ name: `${world.name} · 分支` });
  attachRangeOverride(clone);
  state.branches[state.activeBranch].world = world;
  addBranch(clone, `分支 ${state.branches.length}（自 ${fmtTime(world.time.month)}）`);
  state.world = clone;
  renderBranchOptions();
  globePane.markBaseDirty();
  dataPanel.dirty = true;
  syncTimeline();
});

dom.branchSel.addEventListener('change', () => {
  const index = Number(dom.branchSel.value);
  const entry = selectBranch(index);
  if (!entry || !entry.world) return;
  // stash the outgoing branch's current world so switching back is lossless
  state.branches.forEach((b, i) => { if (i !== index && state.world && !b.world) b.world = state.world; });
  attachRangeOverride(entry.world);
  state.world = entry.world;
  state.params = entry.world.params;
  globePane.markBaseDirty();
  globePane.setOverlay(state.ui.overlay, true);
  applyUiFromState();
  dataPanel.dirty = true;
  syncTimeline();
  emit('state:param', { key: '*', value: null });
  emit('toast', `已切换到 ${entry.label}`);
});

dom.btnTerrain.addEventListener('click', () => terrainEditor.open());

/* ------------------------------------------------------------------ */
/* saving / loading                                                   */
/* ------------------------------------------------------------------ */

function openModal(node) {
  dom.overlay.classList.remove('hidden');
  node.classList.remove('hidden');
}

dom.overlay.addEventListener('click', (e) => {
  if (e.target === dom.overlay) {
    for (const m of dom.overlay.querySelectorAll('.modal')) m.classList.add('hidden');
    dom.overlay.classList.add('hidden');
  }
});
dom.help.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => {
  dom.help.classList.add('hidden');
  dom.overlay.classList.add('hidden');
}));
dom.exportModal.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => {
  dom.exportModal.classList.add('hidden');
  dom.overlay.classList.add('hidden');
}));
dom.slots.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => {
  dom.slots.classList.add('hidden');
  dom.overlay.classList.add('hidden');
}));

dom.btnHelp.addEventListener('click', () => openModal(dom.help));
dom.btnExport.addEventListener('click', () => openModal(dom.exportModal));

dom.btnSave.addEventListener('click', () => { renderSlots('save'); openModal(dom.slots); });
dom.btnLoad.addEventListener('click', () => { renderSlots('load'); openModal(dom.slots); });

function renderSlots(mode) {
  dom.slotList.textContent = '';
  const slots = listSlots();
  for (const s of slots) {
    const name = s.meta ? `${s.meta.name || '未命名'}` : '（空）';
    const meta = s.meta
      ? `${new Date(s.meta.savedAt).toLocaleString()} · ${fmtTime(s.meta.month || 0)} · CO₂ ${Math.round(s.meta.params?.co2 ?? 0)} ppm`
      : '点击保存写入当前场景';
    const actions = el('div', { class: 'slot-actions' });
    if (mode === 'save') {
      const b = el('button', { class: 'ctl-btn primary', text: '保存到此槽' });
      b.addEventListener('click', () => { saveSlot(s.id); renderSlots(mode); });
      actions.append(b);
    }
    if (s.meta) {
      const b = el('button', { class: 'ctl-btn', text: '载入' });
      b.addEventListener('click', () => {
        const scene = loadSlotScene(s.id);
        if (scene) restoreFromScene(scene);
        dom.slots.classList.add('hidden');
        dom.overlay.classList.add('hidden');
      });
      actions.append(b);
      const d = el('button', { class: 'ctl-btn', text: '清空' });
      d.addEventListener('click', () => { deleteSlot(s.id); renderSlots(mode); });
      actions.append(d);
    }
    dom.slotList.append(el('div', { class: 'slot' }, [
      el('div', { class: 'slot-name', text: `存档槽 ${s.id + 1} · ${name}` }),
      el('div', { class: 'slot-meta', text: meta }),
      actions,
    ]));
  }
}

dom.btnFileSave.addEventListener('click', () => {
  const scene = serializeScene();
  download(`${sanitize(state.world?.name || 'planet')}-scene.json`, JSON.stringify(scene), 'application/json');
  emit('toast', '场景已导出为 JSON');
});

dom.btnFileLoad.addEventListener('click', () => {
  const input = el('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const scene = JSON.parse(text);
      applyScene(scene);
      restoreFromScene(scene);    } catch (e) {
      emit('toast', '导入失败：' + e.message);
    }
  });
  input.click();
});

/** Rebuild the live world from an applied scene. */
function restoreFromScene(scene) {
  const terrain = scene.terrain ? terrainFromObject(scene.terrain) : null;
  const world = new World(state.params, {
    name: scene.name, seed: scene.seed, terrain,
  });
  world.name = scene.name || world.name;
  if (scene.last) world.restore(scene.last);
  if (scene.clock) world.time.month = scene.clock.month || 0;
  if (scene.series) {
    world.series = Series.fromJSON(scene.series);
  }
  if (scene.checkpoints && scene.checkpoints.length) {
    world.history.loadDump(scene.checkpoints, world);
  }
  attachRangeOverride(world);
  state.world = world;
  state.ui.planetName = world.name;
  state.ui.presetId = scene.presetId || 'custom';
  state.terrainEdited = !!scene.terrainEdited;
  refreshDerivedParams();
  resetBranches('主时间线');
  state.branches[0].world = world;
  probes.length = 0;
  globePane.refreshProbeMarkers();
  globePane.setRegion(null);
  setRegion(null);
  dataPanel.clearProbe();
  globePane.markBaseDirty();
  globePane.setOverlay(state.ui.overlay, true);
  globePane.setBase(state.ui.base, true);
  clock.clearScrub();
  applyUiFromState();
  syncHud();
  syncTimeline();
  renderBranchOptions();
  emit('state:param', { key: '*', value: null });
  emit('planet:new', world);
  emit('toast', `已载入场景：${world.name}`);
}

/* ------------------------------------------------------------------ */
/* export                                                             */
/* ------------------------------------------------------------------ */

function download(filename, content, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function sanitize(s) { return String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60); }

dom.exportModal.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-export]');
  if (!btn) return;
  const kind = btn.dataset.export;
  const world = state.world;
  if (!world) return;
  if (kind === 'series') exportSeries(world);
  else if (kind === 'grid') exportGrid(world);
  else if (kind === 'params') exportParams(world);
  else if (kind === 'scene') {
    download(`${sanitize(world.name)}-scene.json`, JSON.stringify(serializeScene()), 'application/json');
  } else if (kind === 'png') {
    const url = globePane.globe.snapshot();
    if (!url) { emit('toast', '截图失败（浏览器不支持）'); return; }
    const a = el('a', { href: url, download: `${sanitize(world.name)}-globe.png` });
    document.body.append(a); a.click(); a.remove();
  }
  dom.exportModal.classList.add('hidden');
  dom.overlay.classList.add('hidden');
});

function exportSeries(world) {
  const s = world.series;
  const scopeIds = Array.from(s.scopes.keys());
  const header = ['scope', 'month'].concat(Array.from(new Set(scopeIds.flatMap((id) => Object.keys(s.scopes.get(id)).filter((k) => Array.isArray(s.scopes.get(id)[k]))))));
  const lines = [header.join(',')];
  for (const id of scopeIds) {
    const sc = s.scopes.get(id);
    const keys = header.slice(2);
    for (let i = 0; i < s.months.length; i++) {
      const row = [id, s.months[i].toFixed(2)];
      for (const k of keys) row.push(isFinite(sc[k][i]) ? sc[k][i] : '');
      lines.push(row.join(','));
    }
  }
  download(`${sanitize(world.name)}-series.csv`, lines.join('\n'), 'text/csv');
}

function exportGrid(world) {
  const keys = ['temperature', 'precipitation', 'precipSeason', 'humidity', 'vegetation',
    'oxygen', 'habitability', 'toxicity', 'aerosol', 'diurnal', 'seasonal', 'rivers', 'seaIce', 'anomaly'];
  const t = world.terrain;
  const cols = ['lat', 'lon', 'elevation_m', 'is_ocean'].concat(keys);
  const lines = [cols.join(',')];
  const data = {};
  for (const k of keys) data[k] = world.layerData(k);
  for (let j = 0; j < t.GY; j++) {
    const lat = 90 - (j + 0.5) / t.GY * 180;
    for (let i = 0; i < t.GX; i++) {
      const lon = (i + 0.5) / t.GX * 360 - 180;
      const kk = i + j * t.GX;
      const row = [lat.toFixed(3), lon.toFixed(3), Math.round(t.height[kk]), t.waterMask[kk]];
      for (const k of keys) row.push(isFinite(data[k][kk]) ? data[k][kk].toFixed(4) : '');
      lines.push(row.join(','));
    }
  }
  download(`${sanitize(world.name)}-grid.csv`, lines.join('\n'), 'text/csv');
}

function exportParams(world) {
  const lines = ['key,label,value,unit'];
  for (const p of PARAMS) {
    lines.push([p.key, `"${p.label}"`, state.params[p.key], p.unit || ''].join(','));
  }
  const m = world.metrics();
  lines.push('');
  lines.push('# derived');
  for (const [k, v] of Object.entries(m)) lines.push(`${k},,${typeof v === 'number' ? v.toFixed(4) : v},`);
  download(`${sanitize(world.name)}-params.csv`, lines.join('\n'), 'text/csv');
}

/* ------------------------------------------------------------------ */
/* branches                                                           */
/* ------------------------------------------------------------------ */

function renderBranchOptions() {
  const sel = $('branchSel');
  if (!sel) return;
  sel.textContent = '';
  state.branches.forEach((b, i) => {
    sel.append(el('option', { value: String(i), text: `${b.label}` }));
  });
  sel.value = String(state.activeBranch);
}

/* ------------------------------------------------------------------ */
/* keyboard                                                           */
/* ------------------------------------------------------------------ */

window.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (!typing && (e.key === ' ' || e.code === 'Space')) { e.preventDefault(); clock.toggle(); return; }
  if (!typing && arrows[e.key]) {
    // ← → pan the flat map (or rotate the globe); ↑ ↓ shift the latitude band
    const [dx, dy] = arrows[e.key];
    globePane.handleArrow(dx, dy, e.shiftKey);
    e.preventDefault();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); afterParamChange(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); afterParamChange(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); dom.btnNewPlanet.click(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); dom.btnSave.click(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); dom.btnLoad.click(); return; }
  if (typing) return;
  if (e.key === 'r' || e.key === 'R') { globePane.globe.resetView(); return; }
  if (e.key === 'f' || e.key === 'F') {
    globePane.setViewPreset(globePane.viewMode === 'flat' ? 'globe' : 'flat');
    syncViewButtons();
    return;
  }
  const n = Number(e.key);
  if (n >= 1 && n <= 9) {
    const key = ['temperature', 'precipitation', 'precipSeason', 'humidity', 'vegetation', 'oxygen', 'habitability', 'toxicity', 'aerosol'][n - 1];
    if (key) globePane.setOverlay(key);
  }
  if (e.key === '0') globePane.setOverlay('none');
});

on('view:change', () => syncViewButtons());

function syncViewButtons() {
  const flat = globePane.viewMode === 'flat';
  if (dom.viewSeg) {
    for (const b of dom.viewSeg.querySelectorAll('.seg-btn')) {
      b.classList.toggle('active', b.dataset.view === globePane.viewPreset);
    }
  }
  // the reset-to-equator/pole row only makes sense on the sphere
  if (dom.viewPresetRow) dom.viewPresetRow.classList.toggle('hidden', flat);
  if (dom.viewPresetSeg) {
    for (const b of dom.viewPresetSeg.querySelectorAll('.seg-btn')) {
      b.classList.toggle('active', !flat && b.dataset.view === globePane.viewPreset);
    }
  }
  if (dom.navHint) {
    dom.navHint.textContent = flat
      ? '滚轮缩放 · Ctrl/Alt 或中键拖动平移 · ← → ↑ ↓ 移动地图'
      : '拖动旋转 · 滚轮缩放 · ← → ↑ ↓ 转动';
  }
}

/* ------------------------------------------------------------------ */
/* toast                                                              */
/* ------------------------------------------------------------------ */

let toastTimer = null;
on('toast', (msg) => {
  dom.toast.textContent = String(msg);
  dom.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.add('hidden'), 3200);
});
on('branch:change', () => renderBranchOptions());

window.addEventListener('error', (e) => {
  console.error(e.error || e.message);
  emit('toast', '运行时错误：' + (e.message || '未知'));
});

/* ------------------------------------------------------------------ */
/* render loop                                                        */
/* ------------------------------------------------------------------ */

let lastFrame = performance.now();
let acc = 0;
const loopStats = { frames: 0, steps: 0 };

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(120, now - lastFrame);
  lastFrame = now;
  loopStats.frames++;

  const world = state.world;
  if (!world) return;

  if (clock.playing && clock.scrubIndex < 0) {
    acc += clock.monthsForFrame(dt);
    const whole = Math.floor(acc);
    if (whole >= Math.max(1, state.params.stepMonths || 1)) {
      acc = 0;
      loopStats.steps += whole;
      clock.advance(world, whole);
    }
  }

  try {
    globePane.render(dt / 1000, world);
  } catch (err) {
    console.error('[globe]', err);
  }
  try {
    terrainEditor.render(dt / 1000);
  } catch (err) {
    console.error('[terrain editor]', err);
  }
  dataPanel.draw(false);

  /* update the sun position so the terminator tracks the simulation clock */
  const monthFrac = (world.time.month % 12) / 12;
  globePane.globe.sun.hour = 12 + Math.sin(monthFrac * Math.PI * 2) * 0;
  paramPanel.refreshLocks();
}

/* ------------------------------------------------------------------ */
/* start                                                              */
/* ------------------------------------------------------------------ */

function syncHud() {
  const world = state.world;
  if (!world) return;
  dom.hudName.textContent = world.name;
  dom.hudRadius.textContent = `${Math.round(state.params.planeRadiusKm).toLocaleString('en-US')} km`;
  dom.hudGravity.textContent = `${state.params.gravity.toFixed(2)} m/s²`;
  dom.hudStar.textContent = `${state.params.irradiance.toFixed(0)} W/m²`;
}

function openColorPicker() {
  const input = el('input', { type: 'color', value: state.params.oceanColor || '#2c4a66' });
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.addEventListener('input', () => {
    state.params.oceanColor = input.value;
    globePane.markBaseDirty();
  });
  input.addEventListener('change', () => { input.remove(); });
  input.click();
}

bootPresets();
bootGridControls();
createPlanet({
  name: '地球 · Earth',
  params: { ...defaults() },
  seed: PRESET_MAP.earth.seed,
  presetId: 'earth',
});
applyUiFromState();
syncViewButtons();
requestAnimationFrame(frame);

/* expose a small debug surface */
window.__pcs = {
  state, clock, globePane, dataPanel, paramPanel, wizard, terrainEditor, rampEditor,
  applyPreset, createPlanet, serializeScene, applyScene, loopStats,
  setOverlay: (k) => globePane.setOverlay(k),
  world: () => state.world,
};
