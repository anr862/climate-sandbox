/**
 * Custom colourbar editor.
 *
 * The user clicks anywhere on the bar to drop a stop at that position, then picks
 * a colour for it from the palette (or the native colour picker); the ramp is
 * rebuilt by interpolation — linearly for `连续`, as flat bands for `阶梯`. A
 * draft is edited locally and only committed on 应用, so the layer never flickers
 * through half-finished palettes.
 */

import { el } from './widgets.js';
import { rampFromStops, rampChoices, toHex, cssGradient, hx } from '../core/colors.js';

const PALETTE = [
  '#1b1f24', '#2b3440', '#3a4048', '#4d4a44', '#5e5a52',
  '#3f4f78', '#4b6a94', '#5d8aa0', '#3f7286', '#55809b',
  '#4a5a2c', '#5b6b3e', '#7fa87a', '#8a9a70', '#a8bd86',
  '#c0b47e', '#c08a63', '#b26a5f', '#8c4b56', '#a8544f',
  '#8a7346', '#b0a693', '#bfa8c4', '#c3c9cf',
];

export class RampEditor {
  /**
   * @param {object} opts { modal, getLayer, onApply }
   */
  constructor(opts = {}) {
    this.modal = opts.modal;
    this.getLayer = opts.getLayer || (() => 'temperature');
    this.onApply = opts.onApply || (() => {});
    this.key = 'temperature';
    this.draft = { mode: 'continuous', stops: [] };
    this.selected = -1;
    if (this.modal) this.bind();
  }

  bind() {
    const q = (id) => this.modal.querySelector('#' + id);
    this.bar = q('rampBar');
    this.modeSeg = q('rampModeSeg');
    this.stopList = q('rampStopList');
    this.palette = q('rampPalette');
    this.titleEl = q('rampTitle');
    this.preview = q('rampPreview');

    if (this.bar) {
      this.bar.addEventListener('click', (e) => {
        const r = this.bar.getBoundingClientRect();
        const pos = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
        this.addStop(pos);
      });
    }
    if (this.modeSeg) {
      this.modeSeg.addEventListener('click', (e) => {
        const b = e.target.closest('.seg-btn');
        if (!b) return;
        this.draft.mode = b.dataset.mode;
        this.render();
      });
    }
    if (this.palette) {
      for (const c of PALETTE) {
        const b = el('button', { class: 'ramp-swatch', title: c, style: `background:${c}`, 'data-color': c });
        b.addEventListener('click', () => this.paintSelected(c));
        this.palette.append(b);
      }
      const custom = el('input', { type: 'color', class: 'ramp-color', id: 'rampColor', value: '#6b9ac4', title: '自定义颜色' });
      custom.addEventListener('input', () => this.paintSelected(custom.value));
      this.palette.append(custom);
    }
    const actions = {
      rampClear: () => { this.draft.stops = this.defaultStops(); this.selected = -1; this.render(); },
      rampApply: () => {
        this.onApply(this.key, {
          mode: this.draft.mode,
          stops: this.draft.stops.map((s) => ({ pos: +s.pos.toFixed(4), color: s.color })),
        });
        this.close();
      },
      rampCancel: () => this.close(),
      rampClose: () => this.close(),
    };
    for (const [id, fn] of Object.entries(actions)) {
      const b = q(id);
      if (b) b.addEventListener('click', fn);
    }
  }

  /** The layer's registered ramp, sampled into 5 stops, as the starting point. */
  defaultStops() {
    const choices = rampChoices(this.key);
    const fn = choices.length ? choices[0].fn : null;
    const out = [];
    for (let i = 0; i <= 4; i++) {
      const pos = i / 4;
      const c = fn ? fn(pos) : [128, 128, 128];
      out.push({ pos, color: toHex(c) });
    }
    return out;
  }

  open(key) {
    this.key = key;
    const current = this.getLayer(key);
    if (current && current.custom && current.custom.stops && current.custom.stops.length) {
      this.draft = { mode: current.custom.mode || 'continuous', stops: current.custom.stops.map((s) => ({ ...s })) };
    } else {
      this.draft = { mode: 'continuous', stops: this.defaultStops() };
    }
    this.selected = -1;
    const overlay = this.modal.closest('.overlay');
    if (overlay) {
      for (const m of overlay.querySelectorAll('.modal')) if (m !== this.modal) m.classList.add('hidden');
      overlay.classList.remove('hidden');
    }
    this.modal.classList.remove('hidden');
    this.render();
  }

  close() {
    this.modal.classList.add('hidden');
    const overlay = this.modal.closest('.overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  sampleAt(pos) {
    return rampFromStops(this.draft.stops, this.draft.mode)(pos);
  }

  addStop(pos) {
    const color = toHex(this.sampleAt(pos));
    this.draft.stops.push({ pos, color });
    this.draft.stops.sort((a, b) => a.pos - b.pos);
    this.selected = this.draft.stops.findIndex((s) => s.pos === pos);
    this.render();
  }

  removeStop(i) {
    if (this.draft.stops.length <= 2) return;
    this.draft.stops.splice(i, 1);
    this.selected = -1;
    this.render();
  }

  paintSelected(color) {
    if (this.selected < 0 || !this.draft.stops[this.selected]) {
      // nothing selected: paint the nearest stop so the click still does something
      this.selected = 0;
    }
    this.draft.stops[this.selected].color = String(color);
    this.render();
  }

  render() {
    if (!this.modal) return;
    const L = this.getLayer(this.key);
    if (this.titleEl) this.titleEl.textContent = `${L && L.label ? L.label : this.key} · 自定义颜色条`;
    const fn = rampFromStops(this.draft.stops, this.draft.mode);
    if (this.preview) this.preview.style.background = cssGradient(fn, 48);
    if (this.bar) {
      this.bar.textContent = '';
      this.bar.style.background = cssGradient(fn, 48);
      this.draft.stops.forEach((s, i) => {
        const h = el('button', {
          class: 'ramp-stop' + (i === this.selected ? ' on' : ''),
          style: `left:${(s.pos * 100).toFixed(2)}%; background:${s.color}`,
          title: `${(s.pos * 100).toFixed(0)}% · ${s.color}`,
        });
        h.addEventListener('click', (e) => { e.stopPropagation(); this.selected = i; this.render(); });
        h.addEventListener('dblclick', (e) => { e.stopPropagation(); this.removeStop(i); });
        this.bar.append(h);
      });
    }
    if (this.modeSeg) {
      for (const b of this.modeSeg.querySelectorAll('.seg-btn')) {
        b.classList.toggle('active', b.dataset.mode === this.draft.mode);
      }
    }
    if (this.stopList) {
      this.stopList.textContent = '';
      this.draft.stops.forEach((s, i) => {
        const row = el('div', { class: 'ramp-row' + (i === this.selected ? ' on' : '') });
        const sw = el('input', { type: 'color', class: 'ramp-color sm', value: s.color });
        sw.addEventListener('input', () => { s.color = sw.value; this.selected = i; this.render(); });
        const pos = el('span', { class: 'ramp-pos mono', text: `${(s.pos * 100).toFixed(0)} %` });
        const del = el('button', { class: 'ctl-chip', text: '删除', disabled: this.draft.stops.length <= 2 });
        del.addEventListener('click', () => this.removeStop(i));
        row.append(sw, pos, del);
        this.stopList.append(row);
      });
    }
    const colorInput = this.modal.querySelector('#rampColor');
    if (colorInput && this.selected >= 0 && this.draft.stops[this.selected]) {
      colorInput.value = this.draft.stops[this.selected].color;
    }
    void hx;
  }
}
