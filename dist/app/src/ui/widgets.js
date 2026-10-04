/**
 * Parameter panel widget factory: slider / number / toggle / select / knob,
 * each with an inline numeric editor and a lock button.
 */

import { PARAM_MAP } from '../state/params.js';
import { state, set, toggleLock } from '../state/state.js';

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('data-')) node.setAttribute(k, v);
    else if (k === 'style') node.setAttribute('style', v);
    else node[k] = v;
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function formatValue(def, v) {
  if (def.kind === 'toggle') return v ? '开' : '关';
  if (def.kind === 'select') {
    const opt = (def.options || []).find((o) => o.v === v);
    return opt ? opt.t : String(v);
  }
  if (typeof v === 'number') {
    const d = def.dec ?? 2;
    if (Math.abs(v) >= 1e6) return v.toExponential(2);
    return v.toFixed(d);
  }
  return String(v);
}

/* ================================================================== */
/* sliders                                                            */
/* ================================================================== */

function sliderGeometry(def) {
  const min = def.min, max = def.max;
  const sliderMax = def.sliderMax ?? max;
  const T = (v) => {
    const c = clamp(v, min, Math.min(max, sliderMax));
    return min + (Math.log(c / min) / Math.log(sliderMax / min)) * (max - min);
  };
  const F = (t) => {
    const c = min + (clamp(t, min, max) - min) / (max - min) * (Math.log(sliderMax / min));
    return min * Math.exp(c);
  };
  return { T, F };
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/**
 * Build one parameter row.
 * @param {object} def parameter definition from params.js
 * @param {function} onChange called after a committed change
 */
export function buildRow(def, onChange) {
  const row = el('div', { class: 'prow', 'data-key': def.key });
  const label = el('span', { class: 'prow-label', text: def.label, title: def.help || def.label });
  const unit = def.unit ? el('span', { class: 'prow-unit', text: def.unit }) : null;

  const lock = el('button', {
    class: 'lock-btn' + (state.locks.has(def.key) ? ' on' : ''),
    title: '锁定该参数（切换预设 / 撤销时保持不变）',
    text: state.locks.has(def.key) ? '🔒' : '🔓',
  });
  lock.addEventListener('click', () => {
    toggleLock(def.key);
    lock.classList.toggle('on', state.locks.has(def.key));
    lock.textContent = state.locks.has(def.key) ? '🔒' : '🔓';
    onChange?.();
  });

  const head = el('div', { class: 'prow-top' }, [label, unit, lock]);
  row.append(head);

  if (def.kind === 'slider') {
    const { T, F } = sliderGeometry(def);
    const range = el('input', {
      type: 'range', class: 'rng', min: String(def.min), max: String(def.max),
      step: String((def.max - def.min) / 1000), value: String(T(state.params[def.key])),
    });
    const num = el('input', {
      type: 'number', min: String(def.min), max: String(def.max), step: String(def.step),
      value: String(Number(state.params[def.key].toFixed(def.dec ?? 3))),
    });
    const box = el('div', { class: 'prow-val' }, [num]);
    range.addEventListener('input', () => {
      const v = F(Number(range.value));
      num.value = v.toFixed(def.dec ?? 3);
      set(def.key, v);
      onChange?.();
    });
    const commit = () => {
      const v = Number(num.value);
      if (isFinite(v)) {
        set(def.key, v);
        range.value = String(T(state.params[def.key]));
        num.value = Number(state.params[def.key].toFixed(def.dec ?? 3));
        onChange?.();
      }
    };
    num.addEventListener('change', commit);
    num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); num.blur(); } });
    row.append(el('div', { class: 'prow-ctrl' }, [range, box]));
    row._sync = () => {
      const v = state.params[def.key];
      range.value = String(T(v));
      if (document.activeElement !== num) num.value = Number(v.toFixed(def.dec ?? 3));
      lock.classList.toggle('on', state.locks.has(def.key));
      lock.textContent = state.locks.has(def.key) ? '🔒' : '🔓';
      row.classList.toggle('locked', state.locks.has(def.key));
    };
  } else if (def.kind === 'number') {
    const num = el('input', {
      type: 'number', min: String(def.min), max: String(def.max), step: String(def.step),
      value: String(state.params[def.key]),
    });
    const commit = () => {
      const v = Number(num.value);
      if (isFinite(v)) { set(def.key, v); onChange?.(); }
    };
    num.addEventListener('change', commit);
    num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); num.blur(); } });
    row.append(el('div', { class: 'prow-ctrl', style: 'justify-content:flex-end' }, [
      el('div', { class: 'prow-val' }, [num]),
    ]));
    row._sync = () => { if (document.activeElement !== num) num.value = String(state.params[def.key]); };
  } else if (def.kind === 'toggle') {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!state.params[def.key];
    input.addEventListener('change', () => { set(def.key, input.checked); onChange?.(); });
    row.append(el('div', { class: 'prow-ctrl' }, [
      el('label', { class: 'switch' }, [input, el('span', { text: def.label === 'autoStop' ? '启用' : '' })]),
    ]));
    row._sync = () => { input.checked = !!state.params[def.key]; };
  } else if (def.kind === 'select') {
    const sel = el('select', { class: 'ctl-select', style: 'flex:1 1 auto' });
    for (const o of def.options || []) {
      const opt = el('option', { value: String(o.v), text: o.t });
      sel.append(opt);
    }
    sel.value = String(state.params[def.key]);
    sel.addEventListener('change', () => {
      const raw = sel.value;
      const asNum = Number(raw);
      set(def.key, isFinite(asNum) && !isNaN(asNum) ? asNum : raw);
      onChange?.();
    });
    row.append(el('div', { class: 'prow-ctrl' }, [sel]));
    row._sync = () => { sel.value = String(state.params[def.key]); };
  } else if (def.kind === 'action') {
    const btn = el('button', { class: 'ctl-btn', text: '打开…' });
    btn.addEventListener('click', () => onChange?.({ action: def.key }));
    row.append(el('div', { class: 'prow-ctrl' }, [btn]));
    row._sync = () => {};
  }

  return row;
}

/* ================================================================== */
/* knob (used by the creation wizard)                                 */
/* ================================================================== */

export function buildKnob(value, min, max, size = 34) {
  const canvas = el('canvas', { class: 'knob', width: String(size * 2), height: String(size * 2) });
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  let v = value;
  const draw = () => {
    const ctx = canvas.getContext('2d');
    const s = size * 2;
    ctx.clearRect(0, 0, s, s);
    const c = s / 2;
    const r = c - 3;
    const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#1e2833';
    ctx.beginPath();
    ctx.arc(c, c, r - 3, a0, a1);
    ctx.stroke();
    const t = (v - min) / Math.max(1e-9, max - min);
    ctx.strokeStyle = '#6b9ac4';
    ctx.beginPath();
    ctx.arc(c, c, r - 3, a0, a0 + (a1 - a0) * t);
    ctx.stroke();
    const ang = a0 + (a1 - a0) * t;
    ctx.strokeStyle = '#c9d3de';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(ang) * (r - 9), c + Math.sin(ang) * (r - 9));
    ctx.lineTo(c + Math.cos(ang) * (r - 2), c + Math.sin(ang) * (r - 2));
    ctx.stroke();
  };
  draw();
  let dragging = false, startY = 0, startV = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; startY = e.clientY; startV = v;
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = startY - e.clientY;
    v = clamp(startV + (dy / 120) * (max - min), min, max);
    draw();
    canvas.dispatchEvent(new CustomEvent('knobchange', { detail: v }));
  });
  const end = (e) => { dragging = false; try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ } };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.getValue = () => v;
  canvas.setValue = (nv) => { v = clamp(nv, min, max); draw(); };
  return canvas;
}

export { PARAM_MAP, state, set, toggleLock };
