/**
 * Central application state: parameters, locks, units, undo/redo, save slots,
 * timeline branches ("what if" parallel worlds).
 */

import { PARAMS, PARAM_MAP, defaults, coerce } from './params.js';
import { deriveAuto } from './derive.js';
import { fmtTime } from '../core/units.js';
import { emit, on } from '../core/bus.js';
import { randomSeed } from '../core/rng.js';
import { terrainToObject, terrainFromObject } from '../world/terrain.js';

const SLOT_PREFIX = 'pcs.slot.';
const AUTOSAVE_KEY = 'pcs.autosave.v1';

export const state = {
  params: defaults(),
  locks: new Set(),
  autoDerive: true,
  unitSystem: 'metric',
  planet: null,
  /** the physical world (grids); see world/world.js */
  world: null,
  /** derived, written back by the physics each step (never user-set) */
  derived: {
    oceanFraction: 70.8, tGlobal: 288, iceArea: 8.5, seaLevelDelta: 0,
    co2Eq: 420, biomass: 1, energyNet: 0, albedo: 0.3, month: 0,
  },
  ui: {
    overlay: 'temperature', base: 'surface',
    region: null,           // {lat, lon} of the selected probe
    scrubIndex: -1,
    playing: false,
    speed: 1,               // years per second
    presetId: 'earth',
    planetName: '地球 · Earth',
    lastPreset: 'earth',
    /** colourbar customisation, keyed by layer: { min, max } / ramp choice id */
    layerRange: {},
    layerRamp: {},
    layerCustom: {},
    layerAuto: {},          // layers whose range auto-scales instead of using the default
    legendOpen: false,
  },
  history: { past: [], future: [] },
  branches: [],
  activeBranch: 0,
  /** terrain edits that have not been baked into a new procedural seed */
  terrainEdited: false,
};

/* ------------------------------------------------------------------ */
/* parameter access                                                    */
/* ------------------------------------------------------------------ */

export function get(key) { return state.params[key]; }

const AUTO_KEYS = new Set(PARAMS.filter((p) => p.auto).map((p) => p.key));

/**
 * Apply the "auto derive" constraint rules. `source` is the key the user just
 * changed, so we never echo a write back into it.
 *
 * The rules themselves live in ./derive.js as a pure function so the offline check
 * scripts can call exactly the same code — see the note there about the calibration
 * bug that hand-duplicating them caused.
 */
function applyAutoRules(source) {
  if (!state.autoDerive) return;
  deriveAuto(
    state.params,
    { tGlobal: state.derived.tGlobal, oceanFraction: state.derived.oceanFraction, clamp: coerce },
    (k) => state.locks.has(k) || k === source,
  );
}

function round(v, d) { const f = Math.pow(10, d); return Math.round(v * f) / f; }

export function set(key, value, opts = {}) {
  const def = PARAM_MAP[key];
  if (!def) return;
  const v = coerce(key, value);
  if (state.params[key] === v) return;
  if (!opts.silent) pushUndo(`${def.label}`);
  state.params[key] = v;
  applyAutoRules(key);
  if (state.world && !opts.silent) state.world.params = state.params;
  emit('state:param', { key, value: v });
  if (!opts.noMeta) emit('state:meta');
}

/** Write several parameters at once (single undo entry). */
export function setMany(obj, opts = {}) {
  const keys = Object.keys(obj).filter((k) => PARAM_MAP[k] && !state.locks.has(k));
  if (!keys.length) return;
  if (!opts.noUndo) pushUndo('批量修改');
  for (const k of keys) state.params[k] = coerce(k, obj[k]);
  for (const k of keys) applyAutoRules(k);
  if (state.world) state.world.params = state.params;
  emit('state:param', { key: '*', value: null });
  emit('state:meta');
}

export function toggleLock(key) {
  if (state.locks.has(key)) state.locks.delete(key); else state.locks.add(key);
  emit('state:meta');
}

export function lockCount() { return state.locks.size; }

export function setAutoDerive(on_) {
  state.autoDerive = !!on_;
  if (state.autoDerive) applyAutoRules('__none__');
  emit('state:meta');
}

export function setUnitSystem(sys) {
  state.unitSystem = sys;
  emit('state:meta');
  emit('units:change', sys);
}

/** Force a re-derivation (used after a new planet is built). */
export function refreshDerivedParams() { applyAutoRules('__none__'); emit('state:meta'); }

/* ------------------------------------------------------------------ */
/* undo / redo                                                         */
/* ------------------------------------------------------------------ */

const MAX_HISTORY = 120;

function pushUndo(label) {
  state.history.past.push({ params: { ...state.params }, label });
  if (state.history.past.length > MAX_HISTORY) state.history.past.shift();
  state.history.future.length = 0;
  emit('undo:change', undoStatus());
}

export function undoStatus() {
  return {
    canUndo: state.history.past.length > 0,
    canRedo: state.history.future.length > 0,
    label: state.history.past.length ? state.history.past[state.history.past.length - 1].label : '',
  };
}

export function undo() {
  const prev = state.history.past.pop();
  if (!prev) return;
  state.history.future.push({ params: { ...state.params }, label: prev.label });
  state.params = { ...prev.params };
  if (state.world) state.world.params = state.params;
  emit('state:param', { key: '*', value: null });
  emit('undo:change', undoStatus());
  emit('toast', `已撤销：${prev.label}`);
}

export function redo() {
  const next = state.history.future.pop();
  if (!next) return;
  state.history.past.push({ params: { ...state.params }, label: next.label });
  state.params = { ...next.params };
  if (state.world) state.world.params = state.params;
  emit('state:param', { key: '*', value: null });
  emit('undo:change', undoStatus());
  emit('toast', `已重做：${next.label}`);
}

/* ------------------------------------------------------------------ */
/* serialisation                                                       */
/* ------------------------------------------------------------------ */

export const SCENE_VERSION = 1;

export function serializeScene(opts = {}) {
  const w = state.world;
  return {
    app: 'planetary-climate-sim',
    version: SCENE_VERSION,
    savedAt: new Date().toISOString(),
    name: state.ui.planetName,
    presetId: state.ui.presetId,
    params: { ...state.params },
    locks: Array.from(state.locks),
    unitSystem: state.unitSystem,
    autoDerive: state.autoDerive,
    terrainEdited: state.terrainEdited,
    terrain: w && w.terrain ? terrainToObject(w.terrain) : null,
    terrainEdit: w && w.terrainEdit ? { ...w.terrainEdit } : null,
    seed: w ? w.seed : state.params.seed,
    clock: {
      month: w ? w.time.month : 0,
      stepMonths: state.params.stepMonths,
    },
    series: opts.includeSeries === false || !w || !w.series ? null : w.series.toJSON(),
    checkpoints: opts.includeSeries === false || !w || !w.history ? null : w.history.dump(),
    last: w ? w.snapshot() : null,
    ui: { overlay: state.ui.overlay, base: state.ui.base },
  };
}

/** A compact variant used for localStorage slots (quota is only ~5 MB). */
export function serializeSceneCompact() {
  const scene = serializeScene();
  scene.series = null;
  scene.checkpoints = null;
  if (scene.last) {
    scene.last = {
      month: scene.last.month,
      tGlobal: scene.last.tGlobal,
      seaLevelDelta: scene.last.seaLevelDelta,
      iceVolumeM3: scene.last.iceVolumeM3,
    };
  }
  return scene;
}

export function applyScene(scene, opts = {}) {
  if (!scene || scene.app !== 'planetary-climate-sim') throw new Error('不是有效的场景文件');
  state.params = { ...defaults(), ...(scene.params || {}) };
  for (const k of Object.keys(state.params)) state.params[k] = coerce(k, state.params[k]);
  state.locks = new Set((scene.locks || []).filter((k) => PARAM_MAP[k]));
  state.unitSystem = scene.unitSystem || 'metric';
  state.autoDerive = scene.autoDerive !== false;
  state.terrainEdited = !!scene.terrainEdited;
  state.ui.presetId = scene.presetId || 'custom';
  state.ui.planetName = scene.name || '自定义星球';
  state.history = { past: [], future: [] };
  emit('scene:apply', scene);
  emit('state:param', { key: '*', value: null });
  emit('state:meta');
  emit('undo:change', undoStatus());
  if (!opts.silent) emit('toast', `已载入场景：${state.ui.planetName}`);
}
/* ------------------------------------------------------------------ */
/* legend / colourbar customisation                                     */
/* ------------------------------------------------------------------ */

/**
 * The range a layer's colourbar should use: a manual override if the user typed
 * one, otherwise `null` so the layer's registered default (or auto-scaling) wins.
 */
export function layerRangeFor(key) {
  if (state.ui.layerAuto[key]) return null;
  const r = state.ui.layerRange[key];
  if (r && isFinite(r.min) && isFinite(r.max) && r.max > r.min) return r;
  return null;
}

export function setLayerRange(key, min, max) {
  if (!isFinite(min) || !isFinite(max) || max <= min) return false;
  state.ui.layerRange[key] = { min, max };
  state.ui.layerAuto[key] = false;
  emit('legend:change', { key });
  return true;
}

export function setLayerRamp(key, choiceId) {
  state.ui.layerRamp[key] = choiceId;
  emit('legend:change', { key });
}

/** A user-drawn colourbar: { mode: 'continuous'|'stepped', stops: [{pos,color}] }. */
export function setLayerCustom(key, custom) {
  if (!custom || !custom.stops || !custom.stops.length) {
    delete state.ui.layerCustom[key];
  } else {
    state.ui.layerCustom[key] = {
      mode: custom.mode === 'stepped' ? 'stepped' : 'continuous',
      stops: custom.stops.map((s) => ({ pos: s.pos, color: s.color })),
    };
  }
  emit('legend:change', { key });
}

export function layerCustomFor(key) { return state.ui.layerCustom[key] || null; }

export function setLayerAutoRange(key, on_) {
  state.ui.layerAuto[key] = !!on_;
  emit('legend:change', { key });
}

export function resetLayerStyle(key) {
  delete state.ui.layerRange[key];
  delete state.ui.layerRamp[key];
  delete state.ui.layerAuto[key];
  delete state.ui.layerCustom[key];
  emit('legend:change', { key });
}

/* ------------------------------------------------------------------ */
/* save slots                                                          */
/* ------------------------------------------------------------------ */

function slotKey(id) { return SLOT_PREFIX + id; }

export function listSlots() {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const raw = localStorage.getItem(slotKey(i));
    let meta = null;
    if (raw) {
      try {
        const j = JSON.parse(raw);
        meta = { name: j.name, savedAt: j.savedAt, month: j.clock?.month ?? 0, params: { co2: j.params?.co2, irradiance: j.params?.irradiance } };
      } catch { meta = null; }
    }
    out.push({ id: i, meta });
  }
  return out;
}

export function saveSlot(id, name) {
  const scene = serializeSceneCompact();
  if (name) { scene.name = name; state.ui.planetName = name; }
  const payload = JSON.stringify(scene);
  try {
    localStorage.setItem(slotKey(id), payload);
    emit('toast', `已保存到存档槽 ${id + 1}（${(payload.length / 1024).toFixed(0)} kB）`);
    return true;
  } catch (e) {
    emit('toast', '保存失败：浏览器存储空间不足，请改用“导出场景”');
    return false;
  }
}

/**
 * Load a slot and hand the raw scene back to the caller.
 * Returning the scene lets the app rebuild the world with its terrain, series
 * and checkpoints without this module needing to know about the physics.
 */
export function loadSlotScene(id) {
  const raw = localStorage.getItem(slotKey(id));
  if (!raw) { emit('toast', '该存档槽为空'); return null; }
  try {
    const scene = JSON.parse(raw);
    applyScene(scene);
    return scene;
  } catch (e) {
    emit('toast', '存档损坏：' + e.message);
    return null;
  }
}

export function loadSlot(id) {
  return loadSlotScene(id) !== null;
}

export function deleteSlot(id) {
  localStorage.removeItem(slotKey(id));
  emit('toast', `已清空存档槽 ${id + 1}`);
}

/* ------------------------------------------------------------------ */
/* timeline branches — "what if" parallel worlds                       */
/* ------------------------------------------------------------------ */

export function resetBranches(label = '主时间线') {
  state.branches = [{
    id: 'root', label, parent: null, forkMonth: 0, color: '#6b9ac4',
    world: null, // set by main.js after the root world exists
  }];
  state.activeBranch = 0;
  emit('branch:change', state.branches);
}

export function activeBranch() { return state.branches[state.activeBranch] || null; }

/**
 * Create a parallel branch from the current world & clock.
 * The caller (main.js) supplies a cloned world so this module stays free of
 * physics dependencies.
 */
export function addBranch(worldClone, label) {
  const parent = activeBranch();
  const id = 'b' + (state.branches.length) + '-' + Math.random().toString(36).slice(2, 6);
  const entry = {
    id,
    label: label || `分支 ${state.branches.length}`,
    parent: parent ? parent.id : null,
    forkMonth: worldClone.time.month,
    color: ['#6b9ac4', '#a89a6e', '#7d9c76', '#b8706a', '#8b83b8'][state.branches.length % 5],
    world: worldClone,
  };
  state.branches.push(entry);
  state.activeBranch = state.branches.length - 1;
  emit('branch:change', state.branches);
  emit('toast', `已创建分支：${entry.label}（自 ${fmtTime(entry.forkMonth)} 起分叉）`);
  return entry;
}

export function selectBranch(index) {
  if (index < 0 || index >= state.branches.length) return null;
  state.activeBranch = index;
  emit('branch:change', state.branches);
  return state.branches[index];
}

export function renameBranch(index, label) {
  if (state.branches[index]) {
    state.branches[index].label = label;
    emit('branch:change', state.branches);
  }
}

/* ------------------------------------------------------------------ */
/* misc                                                                */
/* ------------------------------------------------------------------ */

export function newSeed() { return randomSeed(); }

/** Convenience for the UI: format the current simulation clock. */
export function clockLabel(month) {
  return fmtTime(month ?? state.derived.month ?? 0);
}

/** Subscribe helper so modules can persist on change (used for autosave). */
export function touchAutosave() {
  try { localStorage.setItem(AUTOSAVE_KEY, String(Date.now())); } catch { /* ignore */ }
}

on('state:param', () => touchAutosave());
on('state:meta', () => touchAutosave());
